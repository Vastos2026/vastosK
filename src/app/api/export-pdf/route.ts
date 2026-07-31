/**
 * Project export to PDF (revamp plan, flow step 14 "Export") — available once
 * a project has a completed walkthrough. This app is local-first (see
 * CLAUDE.md's "Data layer" section): the full `Project` lives in the
 * browser's Zustand store, not in a reliable server-side `projects` row for
 * most projects, so this route never looks a project up by id. The client
 * resolves which rooms are approved + included (that logic already lives in
 * `approve/page.tsx`/the store) and sends the resolved data; this route only
 * lays it out as a PDF.
 *
 *   POST /api/export-pdf  ExportRequest  → application/pdf (binary body)
 *
 * Images are pulled server-side straight from storage (`pipeline/storage.ts`'s
 * `getObject`) by the `imageKey` the client resolved from each room's approved
 * generation — no HTTP round-trip through /api/render needed.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  PDFDocument,
  PDFArray,
  PDFName,
  PDFString,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from "pdf-lib";
import { getObject } from "@/lib/pipeline/storage";
import { assertAllowed } from "@/lib/api-guard";
import { supabaseAdmin } from "@/lib/supabase/server";
import { getOwnedProjectSnapshot } from "@/lib/supabase/projects";
import { allowedProjectStorageKeys } from "@/lib/projects/approved-rooms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface ExportRoom {
  name: string;
  imageKey: string;
}

interface ExportRequest {
  /**
   * The project this export belongs to — required so the route can verify
   * ownership and that every `imageKey`/`floorPlanImageKey` below actually
   * belongs to THIS project (see the ownership check in POST below). Not
   * used for anything else; this route still never looks up a project's
   * cover-page metadata by id, only its storage keys for validation.
   */
  projectId: string;
  projectName: string;
  propertyTypeLabel: string;
  subcategory?: string;
  styleLabel?: string;
  luxuryLevel?: string;
  colourPaletteLabel?: string;
  /** hex colors, e.g. from COLOUR_PALETTES */
  colourSwatch?: string[];
  /** one entry per approved + included room, resolved client-side */
  rooms: ExportRoom[];
  /** shown as a plain/linked URL, not embedded (per the plan: "not a QR code") */
  walkthroughVideoUrl?: string;
  /**
   * Storage key of the original uploaded floor-plan image, when the client
   * has one (see `FloorPlan.meta.storageKey`) — additive/optional so the
   * parallel `profile-project-card.tsx` workstream calling this same route
   * doesn't need to change. Not every project has one (e.g. a project built
   * with the Sketch tool never uploaded a raster plan) — that's not an
   * error, the floor-plan page below is simply skipped.
   */
  floorPlanImageKey?: string;
}

const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const MARGIN = 56;

function hexToRgb(hex: string) {
  const clean = hex.replace("#", "").trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null;
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return rgb(r, g, b);
}

/** Sniffs actual image bytes rather than trusting a storage key's file extension — the upload pipeline sometimes re-encodes a plan to PNG regardless of what it was originally uploaded as (see parse-plan/route.ts's normalizePlanImage). */
function sniffImageFormat(bytes: Buffer): "png" | "jpg" | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpg";
  }
  return null;
}

// Cached across warm invocations — the logo is a small, static asset, no
// reason to re-read it from disk on every export.
let logoBytesPromise: Promise<Buffer | null> | null = null;
function loadLogoBytes(): Promise<Buffer | null> {
  if (!logoBytesPromise) {
    logoBytesPromise = readFile(path.join(process.cwd(), "public", "vastos-logo.png")).catch(() => null);
  }
  return logoBytesPromise;
}

/**
 * Adds a full page titled `title` with `image` scaled to fit and centered —
 * used for the floor-plan page, which (unlike room pages) always gets a
 * whole page to itself.
 */
function addImagePage(pdfDoc: PDFDocument, fontBold: PDFFont, title: string, image: PDFImage) {
  const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  page.drawText(title, {
    x: MARGIN,
    y: PAGE_HEIGHT - 60,
    size: 18,
    font: fontBold,
    color: rgb(0.1, 0.1, 0.1),
  });
  const maxWidth = PAGE_WIDTH - MARGIN * 2;
  const maxHeight = PAGE_HEIGHT - 150;
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1);
  const w = image.width * scale;
  const h = image.height * scale;
  page.drawImage(image, { x: (PAGE_WIDTH - w) / 2, y: 70, width: w, height: h });
}

/**
 * Adds one page holding 1-2 room slots, stacked, each with its own title
 * directly above its image (tight gap, not the old whole-page-per-room
 * layout's large title-to-image whitespace). Two rooms share the page height
 * evenly; a lone trailing room (odd room count) gets a slot the same height
 * as if it had a partner, rather than stretching to fill the whole page —
 * keeps every room's image a consistent size across the export.
 */
function addRoomImagesPage(
  pdfDoc: PDFDocument,
  fontBold: PDFFont,
  slots: { title: string; image: PDFImage }[],
) {
  const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const titleSize = 14;
  const titleToImageGap = 14;
  const slotGap = 18;
  const slotHeight = (PAGE_HEIGHT - MARGIN * 2 - slotGap) / 2;

  slots.forEach((slot, i) => {
    const slotTop = PAGE_HEIGHT - MARGIN - i * (slotHeight + slotGap);
    page.drawText(slot.title.toUpperCase(), {
      x: MARGIN,
      y: slotTop - titleSize,
      size: titleSize,
      font: fontBold,
      color: rgb(0.1, 0.1, 0.1),
    });
    const imageTop = slotTop - titleSize - titleToImageGap;
    const imageAreaHeight = imageTop - (slotTop - slotHeight);
    const maxWidth = PAGE_WIDTH - MARGIN * 2;
    const scale = Math.min(maxWidth / slot.image.width, imageAreaHeight / slot.image.height, 1);
    const w = slot.image.width * scale;
    const h = slot.image.height * scale;
    page.drawImage(slot.image, { x: (PAGE_WIDTH - w) / 2, y: imageTop - h, width: w, height: h });
  });
}

/** Draws `text` horizontally centered on the page, shrinking the font size until it fits within the margins if needed. */
function drawCentered(
  page: PDFPage,
  text: string,
  y: number,
  size: number,
  font: PDFFont,
  color: ReturnType<typeof rgb>,
): number {
  const maxWidth = PAGE_WIDTH - MARGIN * 2;
  let fitSize = size;
  while (fitSize > 9 && font.widthOfTextAtSize(text, fitSize) > maxWidth) {
    fitSize -= 1;
  }
  const width = font.widthOfTextAtSize(text, fitSize);
  page.drawText(text, { x: (PAGE_WIDTH - width) / 2, y, size: fitSize, font, color });
  return fitSize;
}

/** Adds a clickable URI link annotation covering the given rect on the page. */
function addLinkAnnotation(page: PDFPage, url: string, rect: [number, number, number, number]) {
  const context = page.doc.context;
  const linkRef = context.register(
    context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: rect,
      Border: [0, 0, 0],
      A: {
        Type: "Action",
        S: "URI",
        URI: PDFString.of(url),
      },
    }),
  );
  const existing = page.node.lookup(PDFName.of("Annots"));
  if (existing instanceof PDFArray) {
    existing.push(linkRef);
  } else {
    page.node.set(PDFName.of("Annots"), context.obj([linkRef]));
  }
}

export async function POST(request: Request) {
  // PDF assembly is CPU + storage-read heavy (one getObject + embed per room).
  const guard = await assertAllowed(request, { rateLimit: { key: "export-pdf", limit: 5, windowMs: 60_000 } });
  if (guard instanceof Response) return guard;

  let body: ExportRequest;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const {
    projectId,
    projectName,
    propertyTypeLabel,
    subcategory,
    styleLabel,
    luxuryLevel,
    colourPaletteLabel,
    colourSwatch,
    rooms,
    walkthroughVideoUrl,
    floorPlanImageKey,
  } = body;

  if (!projectId || !projectName || !propertyTypeLabel || !Array.isArray(rooms)) {
    return Response.json(
      { error: "projectId, projectName, propertyTypeLabel and rooms are required" },
      { status: 400 },
    );
  }

  // Every imageKey/floorPlanImageKey below is client-resolved (this route
  // never looks a project up by id for its own data, see the file header) —
  // without this check, an authenticated caller could submit ANY other
  // project's storage key and have it embedded into their own PDF (a real
  // cross-tenant data leak found in review). When Supabase is configured,
  // require the caller to actually own `projectId` AND every key requested
  // to actually belong to that project's own data. When Supabase isn't
  // configured, there's no persistence layer at all (single local install,
  // no other users' data to leak) — degrade to allowing it, matching this
  // app's existing "best-effort, works without Supabase" contract.
  if (supabaseAdmin()) {
    const project = await getOwnedProjectSnapshot(projectId, guard.id);
    if (!project) {
      return Response.json({ error: "Project not found or not owned by you" }, { status: 403 });
    }
    const allowedKeys = allowedProjectStorageKeys(project);
    for (const room of rooms) {
      if (!room?.imageKey || !allowedKeys.has(room.imageKey)) {
        return Response.json({ error: "One or more room images don't belong to this project" }, { status: 403 });
      }
    }
    if (floorPlanImageKey && !allowedKeys.has(floorPlanImageKey)) {
      return Response.json({ error: "Floor plan image doesn't belong to this project" }, { status: 403 });
    }
  }

  try {
    const pdfDoc = await PDFDocument.create();
    const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // --- Cover page — everything centered and bold, not a left-aligned
    // corner block, per explicit feedback that the left-corner layout read
    // as an afterthought rather than a cover.
    const cover = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    let y = PAGE_HEIGHT - MARGIN - 60;

    y = await drawLogoHeader(pdfDoc, cover, fontRegular, y, await loadLogoBytes());
    y -= 46;

    drawCentered(cover, projectName, y, 32, fontBold, rgb(0.1, 0.1, 0.1));
    y -= 46;

    const subtitle = [propertyTypeLabel, subcategory].filter(Boolean).join(" · ");
    if (subtitle) {
      drawCentered(cover, subtitle, y, 14, fontBold, rgb(0.35, 0.35, 0.35));
      y -= 44;
    }

    if (styleLabel) {
      drawCentered(cover, `Style: ${styleLabel}`, y, 13, fontBold, rgb(0.15, 0.15, 0.15));
      y -= 24;
    }
    if (luxuryLevel) {
      drawCentered(cover, `Luxury level: ${luxuryLevel}`, y, 13, fontBold, rgb(0.15, 0.15, 0.15));
      y -= 24;
    }
    // Room count — sensible extra context beyond what the cover already
    // showed, cheap to compute (just the resolved rooms list's length).
    drawCentered(cover, `Rooms: ${rooms.length}`, y, 13, fontBold, rgb(0.15, 0.15, 0.15));
    y -= 24;
    if (colourPaletteLabel) {
      drawCentered(cover, `Colour palette: ${colourPaletteLabel}`, y, 13, fontBold, rgb(0.15, 0.15, 0.15));
      y -= 30;

      if (colourSwatch?.length) {
        const swatchSize = 22;
        const swatchGap = 8;
        const totalWidth = colourSwatch.length * swatchSize + (colourSwatch.length - 1) * swatchGap;
        let swatchX = (PAGE_WIDTH - totalWidth) / 2;
        for (const hex of colourSwatch) {
          const color = hexToRgb(hex);
          if (!color) continue;
          cover.drawRectangle({
            x: swatchX,
            y: y - swatchSize + 6,
            width: swatchSize,
            height: swatchSize,
            color,
          });
          swatchX += swatchSize + swatchGap;
        }
        y -= swatchSize + 16;
      }
    }

    const exportedDate = new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    drawCentered(cover, `Exported ${exportedDate}`, MARGIN, 10, fontRegular, rgb(0.55, 0.55, 0.55));

    // --- Fetch the floor plan (if any) and every room's image concurrently ---
    // These are independent storage reads with no data dependency on each
    // other, so they run together instead of the floor plan blocking in
    // front of the room batch — cuts total wall-clock latency from
    // sum-of-(1+N)-fetches to roughly max-of-(1+N)-fetches.
    const [floorPlanBytes, roomBytes] = await Promise.all([
      floorPlanImageKey
        ? getObject(floorPlanImageKey).catch(() => null)
        : Promise.resolve(null),
      Promise.all(
        rooms.map(async (room) => {
          if (!room?.imageKey) return null;
          try {
            return await getObject(room.imageKey);
          } catch {
            // Skip a room whose image can't be read rather than failing the
            // whole export over one missing/unreadable file.
            return null;
          }
        }),
      ),
    ]);

    // --- Floor plan page (only when the client resolved an original upload key) ---
    if (floorPlanBytes) {
      const format = sniffImageFormat(floorPlanBytes);
      if (format) {
        const image = format === "jpg" ? await pdfDoc.embedJpg(floorPlanBytes) : await pdfDoc.embedPng(floorPlanBytes);
        addImagePage(pdfDoc, fontBold, "Floor plan", image);
      }
      // Unreadable format (neither PNG nor JPEG signature) — skip gracefully,
      // same "don't fail the whole export over one asset" contract as rooms below.
    }

    // --- Room pages, 2 per page (was 1 whole page per room, leaving a lot
    // of unused whitespace under each title) ---
    const roomSlots: { title: string; image: PDFImage }[] = [];
    for (let i = 0; i < rooms.length; i++) {
      const room = rooms[i];
      const bytes = roomBytes[i];
      if (!room?.imageKey || !bytes) continue;

      // Byte-sniffed, not extension-guessed — the same reasoning as the
      // floor-plan image above: the upload/render pipeline can produce bytes
      // whose actual format doesn't match the storage key's extension.
      // Skip gracefully on an unrecognized format instead of blindly calling
      // embedPng — that throws inside pdf-lib's PNG parser for anything that
      // isn't actually a PNG, which previously took down the ENTIRE export
      // over one bad room image instead of just omitting that room's page.
      const format = sniffImageFormat(bytes);
      if (!format) continue;
      const image = format === "jpg" ? await pdfDoc.embedJpg(bytes) : await pdfDoc.embedPng(bytes);
      roomSlots.push({ title: room.name || "Room", image });
    }
    for (let i = 0; i < roomSlots.length; i += 2) {
      addRoomImagesPage(pdfDoc, fontBold, roomSlots.slice(i, i + 2));
    }

    // --- Walkthrough link page ---
    if (walkthroughVideoUrl) {
      const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      page.drawText("Walkthrough video", {
        x: MARGIN,
        y: PAGE_HEIGHT - 110,
        size: 18,
        font: fontBold,
        color: rgb(0.1, 0.1, 0.1),
      });
      const linkY = PAGE_HEIGHT - 140;
      const linkFontSize = 11;
      page.drawText(walkthroughVideoUrl, {
        x: MARGIN,
        y: linkY,
        size: linkFontSize,
        font: fontRegular,
        color: rgb(0.15, 0.3, 0.75),
        maxWidth: PAGE_WIDTH - MARGIN * 2,
      });
      const textWidth = fontRegular.widthOfTextAtSize(walkthroughVideoUrl, linkFontSize);
      try {
        addLinkAnnotation(page, walkthroughVideoUrl, [
          MARGIN,
          linkY - 3,
          MARGIN + Math.min(textWidth, PAGE_WIDTH - MARGIN * 2),
          linkY + linkFontSize + 2,
        ]);
      } catch {
        // Clickable annotation is a nice-to-have; the plain text above is
        // still readable/copyable even if this fails.
      }
    }

    const pdfBytes = await pdfDoc.save();
    const safeName = projectName.replace(/[^a-z0-9\-_ ]/gi, "").trim() || "project";

    return new Response(new Uint8Array(pdfBytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${safeName}.pdf"`,
      },
    });
  } catch (e) {
    console.error("[export-pdf]", e);
    return Response.json({ error: "PDF export failed" }, { status: 500 });
  }
}

/**
 * Draws the logo + "Generated by Vastos" tagline at the top of the cover
 * page and returns the y coordinate to continue drawing from below it.
 * Degrades to just the tagline text (no image) if the logo file couldn't be
 * read or doesn't embed — never fails the export over a missing/unreadable
 * static asset.
 */
async function drawLogoHeader(
  pdfDoc: PDFDocument,
  page: PDFPage,
  fontRegular: PDFFont,
  topY: number,
  logoBytes: Buffer | null,
): Promise<number> {
  const logoHeight = 32;
  const tagline = "Generated by Vastos";
  const taglineSize = 11;
  const taglineWidth = fontRegular.widthOfTextAtSize(tagline, taglineSize);
  let logoWidth = 0;
  let logo = null as Awaited<ReturnType<typeof pdfDoc.embedPng>> | null;

  if (logoBytes) {
    try {
      logo = await pdfDoc.embedPng(logoBytes);
      logoWidth = logoHeight * (logo.width / logo.height);
    } catch {
      // Logo failed to embed (corrupt file, etc.) — fall back to text-only.
      logo = null;
    }
  }

  // Logo + tagline drawn as one centered unit, not left-aligned, matching
  // the rest of the cover page's centered treatment.
  const gap = logo ? 12 : 0;
  const totalWidth = logoWidth + gap + taglineWidth;
  let cursorX = (PAGE_WIDTH - totalWidth) / 2;

  if (logo) {
    page.drawImage(logo, { x: cursorX, y: topY - logoHeight, width: logoWidth, height: logoHeight });
    cursorX += logoWidth + gap;
  }

  page.drawText(tagline, {
    x: cursorX,
    y: topY - logoHeight / 2 - 4,
    size: taglineSize,
    font: fontRegular,
    color: rgb(0.45, 0.45, 0.45),
  });

  return topY - logoHeight;
}
