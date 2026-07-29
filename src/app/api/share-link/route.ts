/**
 * Shareable walkthrough link (revamp plan, "Security" + flow step 11/13).
 *
 * Generates a stable, long-lived, unguessable token distinct from the raw
 * `/api/render?key=...` storage URL — meant to be reshared by the builder
 * with their client over time, not treated as a signed/expiring URL.
 *
 *   POST /api/share-link  { projectId, existingToken?: string }
 *     → { token: string | null, persisted: boolean }
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
import { assertAllowed } from "@/lib/api-guard";

interface Body {
  projectId?: string;
  /** Client's locally-cached token, if it already generated one before. */
  existingToken?: string;
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

  const { projectId, existingToken } = body;
  if (!projectId) {
    return Response.json({ error: "projectId is required" }, { status: 400 });
  }

  const db = supabaseAdmin();
  if (!db) {
    // Supabase isn't configured at all — nothing to persist against. Hand
    // back the client's cached token (or mint one) so the feature still
    // works locally.
    const token = existingToken || generateToken();
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

    const token = existingToken || generateToken();

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
    const token = existingToken || generateToken();
    return Response.json({ token, persisted: false });
  }
}
