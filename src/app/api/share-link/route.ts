/**
 * Shareable walkthrough link (revamp plan, "Security" + flow step 11/13).
 *
 * Generates a stable, long-lived, unguessable token distinct from the raw
 * `/api/render?key=...` storage URL — meant to be reshared by the builder
 * with their client over time, not treated as a signed/expiring URL.
 *
 *   POST   /api/share-link  { projectId }
 *     → { token: string | null, persisted: boolean }
 *   DELETE /api/share-link  { projectId, regenerate?: boolean }
 *     → { token: string | null, revoked: boolean }
 *
 * REVOCATION (DELETE) exists because a share token is otherwise permanent.
 * Before it, `POST` reused any existing token forever and nothing anywhere
 * could clear one, so a link forwarded to the wrong person — or handed to a
 * client whose engagement has ended — stayed live for good and could only be
 * killed by editing the database by hand. `regenerate: true` mints a fresh
 * token in the same call, which is what "the old link is compromised but I
 * still want to share this project" needs; without it the project simply
 * stops being shared until the owner mints a new link.
 *
 * `projectId` must be owned by the caller (`requireOwnedProject`, checked
 * before any `project_snapshots` read or write below) — without that, any
 * authenticated caller could pass another user's project id and either read
 * back its existing share token or mint/persist a new one onto it, exposing
 * that project unauthenticated via `/s/<token>`. The token itself is always
 * minted server-side (`generateToken`, `randomBytes(24)`); this route does
 * not accept a client-supplied token, since that would let a caller set a
 * low-entropy, guessable token directly onto a project row.
 *
 * Writes `share_token` onto `project_snapshots` (keyed by `app_id`), NOT the
 * mostly-empty `projects` table — this app is still entirely local-first
 * (see CLAUDE.md's "Project lifecycle state machine": nothing calls
 * `transitionProject` yet, so most project ids have no live row in the real
 * `projects` table). `project_snapshots` rows DO reliably exist though: every
 * local project change gets mirrored there (debounced) via `/api/projects`
 * (see `src/lib/project-sync.tsx`), so this is the row that actually holds
 * this project's data — including the walkthrough video key and approved
 * room image keys `/s/[token]` needs to resolve the link.
 *
 * `persisted: false` means the token was minted but NOT saved to
 * `project_snapshots` (e.g. the project hasn't synced up yet, or Supabase is
 * unconfigured/offline) — the caller must keep it in local (Zustand) state,
 * and it will not resolve from a different browser/device until it is.
 * Rather than failing the whole feature when the update affects zero rows,
 * we log a warning and hand the token back anyway, same best-effort contract
 * as `src/lib/ai/usage-log.ts`.
 */

import { randomBytes } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/server";
import { requireOwnedProject } from "@/lib/supabase/projects";
import { assertAllowed } from "@/lib/api-guard";

interface Body {
  projectId?: string;
}

interface RevokeBody {
  projectId?: string;
  /** Mint a replacement in the same call, so a compromised link can be rotated rather than merely killed. */
  regenerate?: boolean;
}

function generateToken(): string {
  return randomBytes(24).toString("base64url");
}

export async function POST(request: Request) {
  const guard = await assertAllowed(request, { rateLimit: { key: "share-link", limit: 20, windowMs: 60_000 } });
  if (guard instanceof Response) return guard;

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { projectId } = body;
  if (!projectId) {
    return Response.json({ error: "projectId is required" }, { status: 400 });
  }

  // Without this check, any authenticated caller could pass ANY other
  // project's id and either read back its existing share token (exposing
  // that project unauthenticated via /s/<token>) or mint and persist a new
  // one onto it, making a private project public at a URL the attacker
  // chose — a cross-tenant data leak. `requireOwnedProject` returns `null`
  // when Supabase isn't configured (no persistence layer, nothing to check).
  const owned = await requireOwnedProject(guard.id, projectId);
  if (owned instanceof Response) return owned;

  const db = supabaseAdmin();
  if (!db) {
    // Supabase isn't configured at all — nothing to persist against. Mint a
    // token so the feature still works locally.
    const token = generateToken();
    return Response.json({ token, persisted: false });
  }

  try {
    // Prefer whatever's already on the row, if a row exists — reusing it
    // keeps previously-shared links valid instead of rotating on every click.
    const { data: existingRow, error: selectError } = await db
      .from("project_snapshots")
      .select("share_token")
      .eq("app_id", projectId)
      .maybeSingle();

    if (selectError) {
      console.warn("[share-link] select failed (non-fatal):", selectError.message);
    }

    if (existingRow?.share_token) {
      return Response.json({ token: existingRow.share_token, persisted: true });
    }

    const token = generateToken();

    // Not an `upsert`: if no `project_snapshots` row exists yet for this id
    // (e.g. the project hasn't synced up via /api/projects yet), we can't
    // safely construct one here (no `anon_owner`/`data` to write). This
    // `update` affecting zero rows is an expected, not-fatal case below.
    //
    // `.is("share_token", null)` guards against a race: two concurrent
    // requests for the same never-before-shared project could otherwise both
    // read no existing token, both mint a DIFFERENT random one, and both
    // issue an unconditional update — the loser's response would claim
    // "persisted: true" for a token the DB no longer holds, silently
    // breaking a link someone already copied. With this guard, only the
    // first writer's update actually affects the row; the loser gets back
    // zero affected rows and re-selects to hand back whichever token
    // actually won, rather than trusting its own.
    const { data: updated, error: updateError } = await db
      .from("project_snapshots")
      .update({ share_token: token })
      .eq("app_id", projectId)
      .is("share_token", null)
      .select("share_token")
      .maybeSingle();

    if (updateError) {
      console.warn("[share-link] update failed (non-fatal):", updateError.message);
      return Response.json({ token, persisted: false });
    }

    if (updated) {
      return Response.json({ token: updated.share_token, persisted: true });
    }

    // Zero rows affected: either no `project_snapshots` row exists yet for
    // this id, or a concurrent request already won the race above and set a
    // different token first. Re-select to tell the two cases apart instead
    // of assuming the former.
    const { data: raced } = await db
      .from("project_snapshots")
      .select("share_token")
      .eq("app_id", projectId)
      .maybeSingle();
    if (raced?.share_token) {
      return Response.json({ token: raced.share_token, persisted: true });
    }

    console.warn(
      `[share-link] no project_snapshots row for app_id=${projectId} yet (not synced up, or ` +
        "Supabase offline) — returning token for local-only caching, not persisted.",
    );
    return Response.json({ token, persisted: false });
  } catch (e) {
    // Never fail the whole feature just because persistence didn't work.
    console.warn("[share-link] unexpected failure (non-fatal):", (e as Error).message);
    const token = generateToken();
    return Response.json({ token, persisted: false });
  }
}

/**
 * Revoke this project's share link, optionally replacing it.
 *
 * Deliberately NOT best-effort, unlike POST above. POST can hand back an
 * unpersisted token and degrade gracefully because the worst case is a link
 * that doesn't resolve elsewhere. Revocation is the opposite: reporting
 * success when the token is still in the database would tell the owner a
 * leaked link is dead while it keeps working, which is worse than an honest
 * error. So every failure path here returns a non-2xx and `revoked: false`.
 *
 * Same ownership gate as POST, for the same reason and then some — without
 * it any authenticated caller could revoke or rotate a stranger's share
 * link, which is a denial-of-service on someone else's client presentation.
 */
export async function DELETE(request: Request) {
  const guard = await assertAllowed(request, { rateLimit: { key: "share-link-revoke", limit: 20, windowMs: 60_000 } });
  if (guard instanceof Response) return guard;

  let body: RevokeBody;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { projectId, regenerate } = body;
  if (!projectId) {
    return Response.json({ error: "projectId is required" }, { status: 400 });
  }

  const owned = await requireOwnedProject(guard.id, projectId);
  if (owned instanceof Response) return owned;

  const db = supabaseAdmin();
  if (!db) {
    // Nothing is persisted, so there is nothing to revoke — and we must not
    // claim otherwise. A token minted while Supabase was unconfigured only
    // ever lived in the caller's own local state; clearing that is the
    // client's job, and it can treat this 503 as "drop your cached token".
    return Response.json(
      { error: "Sharing is not configured on this deployment; nothing to revoke.", revoked: false },
      { status: 503 },
    );
  }

  const replacement = regenerate ? generateToken() : null;

  try {
    // Unconditional write, unlike POST's `.is("share_token", null)` guard:
    // there is no race to lose here. Two concurrent revocations both want
    // the old token gone, and whichever lands last decides the replacement —
    // both outcomes are correct, because neither leaves the revoked token
    // live. `.select()` tells us whether a row actually existed.
    const { data: updated, error } = await db
      .from("project_snapshots")
      .update({ share_token: replacement })
      .eq("app_id", projectId)
      .select("share_token")
      .maybeSingle();

    if (error) {
      console.warn("[share-link] revoke failed:", error.message);
      return Response.json({ error: "Could not revoke the share link.", revoked: false }, { status: 502 });
    }

    if (!updated) {
      // No snapshot row for this project — so no token was ever persisted
      // against it. Nothing is live, which is the state the caller asked
      // for, so this is a success rather than an error.
      return Response.json({ token: null, revoked: true, note: "no persisted share link for this project" });
    }

    return Response.json({ token: updated.share_token ?? null, revoked: true });
  } catch (e) {
    console.warn("[share-link] revoke threw:", (e as Error).message);
    return Response.json({ error: "Could not revoke the share link.", revoked: false }, { status: 502 });
  }
}
