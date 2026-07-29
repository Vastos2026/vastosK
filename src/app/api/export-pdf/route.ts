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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface ExportRoom {
  name: string;
  imageKey: string;
}

interface ExportRequest {
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
 * the floor-plan page and each room page laid out identically, so this was
 * pulled into one helper instead of two copies of the same scale/center math.
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

  if (!projectName || !propertyTypeLabel || !Array.isArray(rooms)) {
    return Response.json(
      { error: "projectName, propertyTypeLabel and rooms are required" },
      { status: 400 },
    );
  }

  try {
    const pdfDoc = await PDFDocument.create();
    const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // --- Cover page ---
    const cover = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    let y = PAGE_HEIGHT - MARGIN;

    y = await drawLogoHeader(pdfDoc, cover, fontRegular, y, await loadLogoBytes());
    y -= 30;

    cover.drawText(projectName, {
      x: MARGIN,
      y,
      size: 28,
      font: fontBold,
      color: rgb(0.1, 0.1, 0.1),
      maxWidth: PAGE_WIDTH - MARGIN * 2,
    });
    y -= 42;

    const subtitle = [propertyTypeLabel, subcategory].filter(Boolean).join(" · ");
    if (subtitle) {
      cover.drawText(subtitle, {
        x: MARGIN,
        y,
        size: 13,
        font: fontRegular,
        color: rgb(0.35, 0.35, 0.35),
      });
      y -= 40;
    }

    if (styleLabel) {
      cover.drawText(`Style: ${styleLabel}`, {
        x: MARGIN,
        y,
        size: 12,
        font: fontRegular,
        color: rgb(0.2, 0.2, 0.2),
      });
      y -= 22;
    }
    if (luxuryLevel) {
      cover.drawText(`Luxury level: ${luxuryLevel}`, {
        x: MARGIN,
        y,
        size: 12,
        font: fontRegular,
        color: rgb(0.2, 0.2, 0.2),
      });
      y -= 22;
    }
    // Room count — sensible extra context beyond what the cover already
    // showed, cheap to compute (just the resolved rooms list's length).
    cover.drawText(`Rooms: ${rooms.length}`, {
      x: MARGIN,
      y,
      size: 12,
      font: fontRegular,
      color: rgb(0.2, 0.2, 0.2),
    });
    y -= 22;
    if (colourPaletteLabel) {
      cover.drawText(`Colour palette: ${colourPaletteLabel}`, {
        x: MARGIN,
        y,
        size: 12,
        font: fontRegular,
        color: rgb(0.2, 0.2, 0.2),
      });
      y -= 26;

      if (colourSwatch?.length) {
        const swatchSize = 22;
        let swatchX = MARGIN;
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
          swatchX += swatchSize + 8;
        }
        y -= swatchSize + 16;
      }
    }

    const exportedDate = new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    cover.drawText(`Exported ${exportedDate}`, {
      x: MARGIN,
      y: MARGIN,
      size: 10,
      font: fontRegular,
      color: rgb(0.55, 0.55, 0.55),
    });

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

    // --- One page per approved + included room ---
    for (let i = 0; i < rooms.length; i++) {
      const room = rooms[i];
      const bytes = roomBytes[i];
      if (!room?.imageKey || !bytes) continue;

      // Byte-sniffed, not extension-guessed — the same reasoning as the
      // floor-plan image above: the upload/render pipeline can produce bytes
      // whose actual format doesn't match the storage key's extension.
      const format = sniffImageFormat(bytes);
      const image = format === "jpg" ? await pdfDoc.embedJpg(bytes) : await pdfDoc.embedPng(bytes);
      addImagePage(pdfDoc, fontBold, room.name || "Room", image);
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
    return Response.json(
      { error: e instanceof Error ? e.message : "PDF export failed" },
      { status: 500 },
    );
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
  let textX = MARGIN;

  if (logoBytes) {
    try {
      const logo = await pdfDoc.embedPng(logoBytes);
      const logoWidth = logoHeight * (logo.width / logo.height);
      page.drawImage(logo, { x: MARGIN, y: topY - logoHeight, width: logoWidth, height: logoHeight });
      textX = MARGIN + logoWidth + 12;
    } catch {
      // Logo failed to embed (corrupt file, etc.) — fall back to text-only.
    }
  }

  page.drawText("Generated by Vastos", {
    x: textX,
    y: topY - logoHeight / 2 - 4,
    size: 11,
    font: fontRegular,
    color: rgb(0.45, 0.45, 0.45),
  });

  return topY - logoHeight;
}
