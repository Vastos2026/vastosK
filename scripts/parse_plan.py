#!/usr/bin/env python3
"""
Server-side floor-plan geometry detection with Python OpenCV.

Reads an image path from argv[1], runs the CV pipeline, and prints a single
JSON object to stdout:

    {
      "imageWidth": int, "imageHeight": int,
      "buildingBox": {"x","y","w","h"},                 # outer-wall bbox, pixels
      "wallThicknessPx": float,                          # measured wall thickness
      "walls":   [{"x1","y1","x2","y2","thickness"}],    # pixels
      "doors":   [{"x","y","orientation","length"}],     # pixels
      "windows": [{"x","y","orientation","length"}],     # pixels
      "rooms":   [{"x","y","w","h"}],                    # pixel bounding boxes
      "confidence": float,
      "style": "pink" | "yellow" | "ink"
    }

Geometry only — scale (feet per pixel) is resolved downstream (Merge Engine /
the labeled detector's printed-dimension calibration).

The sheet's drawing STYLE is probed first and drives segmentation:

  • "pink"   — CAD exports where walls are thin red/pink double lines (hue≈175),
               window frames + columns are black rectangles embedded in the
               walls, doors are wall GAPS (swing arcs in gray, sliding doors as
               an orange rail across the gap), furniture is orange, labels are
               red text. Openings are read from the actual symbols.
  • "yellow" — walls drawn as a yellow/tan COLOUR FILL; legacy contour pipeline.
  • "ink"    — black-line drawings; legacy Otsu pipeline.

Usage:
    python parse_plan.py <image_path> [--debug <out.png>]
"""

import json
import os
import sys

import cv2
import numpy as np


def _dbg(msg):
    """Tuning trace, enabled with PARSE_DEBUG=1 (stderr, never in the JSON)."""
    if os.environ.get("PARSE_DEBUG"):
        print(msg, file=sys.stderr)

# The pink pipeline normalises the sheet to this working size so every
# threshold below can be expressed in wall-thickness units and behave the same
# for a 350px screenshot and a 3000px export.
PINK_MAX_SIDE = 800
LEGACY_MAX_SIDE = 1600


# --------------------------------------------------------------------------
# Style probe + symbol masks
# --------------------------------------------------------------------------

def build_masks(img):
    """Split the sheet into symbol masks and classify its drawing style.

    Returns a dict with:
      style       "pink" | "yellow" | "ink"
      red         red-family ink (walls + labels + dims) — pink style only
      wall_lines  long straight red runs = candidate wall strokes (text removed)
      black       near-black ink (window frames + columns)
      orange      orange/brown ink (furniture, stair treads, slider rails)
    """
    H, W = img.shape[:2]
    area = W * H
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    hh, ss, vv = cv2.split(hsv)

    red = (((hh >= 165) | (hh <= 8)) & (ss >= 50) & (vv >= 60)).astype(np.uint8) * 255
    black = ((vv < 120) & (ss < 90)).astype(np.uint8) * 255
    orange = ((hh >= 9) & (hh <= 30) & (ss >= 60) & (vv >= 90)).astype(np.uint8) * 255
    # Light-gray strokes: door swing arcs (and the dashed grid + anti-aliasing
    # halos; told apart later by the arc-shaped annulus test). Arcs print VERY
    # pale, so the band reaches almost to paper white.
    gray = ((ss < 60) & (vv >= 140) & (vv <= 251)).astype(np.uint8) * 255

    # Long straight runs of red ink = wall strokes. Text glyphs, dimension
    # arrows and furniture accents die under the long-kernel opening.
    k = max(8, int(round(min(W, H) * 0.03)))
    horiz = cv2.morphologyEx(red, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (k, 1)))
    vert = cv2.morphologyEx(red, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, k)))
    wall_lines = cv2.bitwise_or(horiz, vert)

    # Style routing. Pink = red-family wall LINES with modest total red coverage
    # (a brick-hatch plan is red too but nearly solid-red, and a yellow-fill plan
    # has almost no red). Yellow-fill is probed on a band that EXCLUDES the pink
    # style's orange furniture (hue<22), which used to hijack the wall mask.
    yellow = cv2.inRange(hsv, (22, 35, 110), (42, 255, 255))
    n_red = cv2.countNonZero(red)
    n_lines = cv2.countNonZero(wall_lines)

    # Render style probe: walls drawn as SOLID gray fill (marketing-style
    # rendered plans) — a pure-neutral mid gray (s≈0, v≈140-150) plus darker
    # edge lines, both far from the textured floors and white corridors.
    # Solidity separates it from B&W line art: a 5×5 opening keeps solid fills
    # but kills thin strokes.
    # ROUTING probe uses a TIGHT mask (the pure-neutral wall fill only) so the
    # coverage bounds stay meaningful; the EXTRACTION mask below is wider to
    # survive JPEG noise. A 5×5 opening keeps only SOLID fill — thin line-art
    # strokes and floor-shadow speckle die, so the opened coverage directly
    # answers "does this sheet have solid gray walls?".
    probe = ((ss <= 10) & (vv >= 55) & (vv <= 172)).astype(np.uint8) * 255
    probe_solid = cv2.morphologyEx(
        probe, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    )
    n_solid = cv2.countNonZero(probe_solid)

    # CAD-ink style probe ("cad"): AutoCAD sheet exports — walls as BLACK
    # strokes (solid double lines or brick-hatch boundaries), CYAN window
    # symbols, BLUE column blocks, red dimension chains + a magenta sheet
    # border. The signature is long BLACK wall runs alongside meaningful cyan;
    # black runs must DOMINATE the red runs so pink-walled plans (whose red
    # walls also come with blue/cyan windows) keep routing "pink".
    cyan = ((hh >= 80) & (hh <= 105) & (ss >= 60) & (vv >= 100)).astype(np.uint8) * 255
    blue = ((hh >= 106) & (hh <= 132) & (ss >= 110) & (vv >= 70)).astype(np.uint8) * 255
    bh_ = cv2.morphologyEx(black, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (k, 1)))
    bv_ = cv2.morphologyEx(black, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, k)))
    black_runs = cv2.bitwise_or(bh_, bv_)
    n_cyan = cv2.countNonZero(cyan)
    n_black_runs = cv2.countNonZero(black_runs)
    # Black runs need only RIVAL the red runs (0.8×), not dominate them — a CAD
    # sheet's magenta border + red dimension chains produce nearly as many red
    # run pixels as the walls produce black ones. A red-WALLED plan is still
    # safe: its wall strokes dwarf its black ink (no long black runs at all).
    is_cad = (
        n_cyan > 0.0012 * area
        and n_black_runs > 0.003 * area
        and n_black_runs > 0.8 * n_lines
    )

    if is_cad:
        style = "cad"
    elif n_lines > 0.004 * area and n_red < 0.10 * area and n_lines > 0.5 * n_red:
        style = "pink"
    elif 0.012 * area < n_solid < 0.20 * area:
        style = "render"
    elif cv2.countNonZero(yellow) > 0.01 * area:
        style = "yellow"
    else:
        style = "ink"

    if style == "cad":
        # Same mask semantics as "render" so the run/opening machinery reads
        # this style unchanged: wall ink = long black strokes + blue columns.
        # The plain `black` mask (v<120) loses anti-aliased PDF/photo strokes,
        # so the wall ink comes from an OTSU threshold with colored pixels
        # removed (dimension chains, cyan symbols, furniture stay out).
        # The WINDOW-symbol mask is the cyan ink — cyan double-lines sit
        # exactly in the wall gaps that are windows, while door gaps carry no
        # cyan (labelled "D/D1" or pale swing arcs), which is how
        # infer_openings_pink tells the two apart on these sheets.
        gk = cv2.GaussianBlur(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), (3, 3), 0)
        _, ink = cv2.threshold(gk, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        ink = cv2.bitwise_and(ink, ((ss < 90).astype(np.uint8) * 255))
        ih2 = cv2.morphologyEx(ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (k, 1)))
        iv2 = cv2.morphologyEx(ink, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, k)))
        t = max(2, int(round(min(W, H) * 0.004)))
        wall_ink = cv2.bitwise_or(cv2.bitwise_or(ih2, iv2), blue)
        wall_ink = cv2.morphologyEx(
            wall_ink, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (3 * t, 3 * t))
        )
        wall_solid = cad_network(wall_ink, W, H)
        return {
            "style": style,
            "red": wall_solid,
            "wall_lines": wall_solid,
            "black": cyan,
            "orange": orange,
            "gray": gray,
        }

    if style == "render":
        # Remap the masks so the run/opening machinery reads this style with
        # the SAME semantics as pink: `red`/`wall_lines` = wall ink (the solid
        # fill's own pixels are both "faces"), `black` = the window/glazing
        # symbol (mid-gray sills inside wall gaps), `orange` = furniture ink
        # that blocks a doorway's walk-through clearance. The extraction mask
        # is wider than the routing probe (JPEG noise tints the flat fill) and
        # closed so a wall reads as one solid bar.
        # The wall fill is PURE neutral (s=0 even under JPEG; the floors and
        # corridor tiles carry s≥8), so a strict saturation cut is what keeps
        # floors/corridors out of the wall band.
        dark = (((ss <= 4) & (vv >= 95) & (vv <= 180)) |
                ((ss < 75) & (vv < 115))).astype(np.uint8) * 255
        dark_solid = cv2.morphologyEx(
            dark, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
        )
        dark_solid = cv2.morphologyEx(
            dark_solid, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
        )
        wall_solid = wall_network(dark_solid, W, H)
        # Window glazing is PURE neutral gray (s≈0); the floors that show
        # through door gaps are warm (beige s≥9, wood s≈100), so a strict
        # saturation cut splits window from door.
        glaze = ((ss <= 6) & (vv >= 60) & (vv <= 230)).astype(np.uint8) * 255
        glaze = cv2.bitwise_and(glaze, cv2.bitwise_not(cv2.dilate(
            wall_solid, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)))))
        furn = ((ss >= 60) & (vv >= 60)).astype(np.uint8) * 255
        white = ((ss <= 12) & (vv >= 232)).astype(np.uint8) * 255
        return {
            "style": style,
            "red": wall_solid,
            "wall_lines": wall_solid,
            "black": glaze,
            "orange": furn,
            "gray": gray,
            "white": white,
        }

    return {
        "style": style,
        "red": red,
        "wall_lines": wall_lines,
        # Window symbols on pink-family CAD sheets are drawn in BLACK frames
        # AND/OR CYAN double-lines (brick-hatch exports use cyan only) — union
        # them so a cyan-only window still reads as a window, not a door gap.
        # Cyan is tested ON wall runs only, so stair treads / balcony rails
        # elsewhere can't mint windows.
        "black": cv2.bitwise_or(black, cyan) if style == "pink" else black,
        "orange": orange,
        "gray": gray,
    }


def cad_network(wall_ink, W, H):
    """Keep the building's wall components on a CAD SHEET export.

    Pixel connectivity (wall_network) fails here: door/window gaps split the
    thin wall strokes into many separated pieces. Instead: (1) drop sheet
    FRAME lines (components spanning nearly the whole sheet — plot borders),
    then (2) keep every component whose bbox falls inside the largest
    surviving component's bbox expanded by 25% — walls all live inside the
    building's extent, while the title block / banners / dimension text sit
    well outside it."""
    n, lab, stats, _ = cv2.connectedComponentsWithStats(wall_ink, 8)
    if n <= 1:
        return wall_ink
    drop = {
        i for i in range(1, n)
        if stats[i, cv2.CC_STAT_WIDTH] > 0.86 * W or stats[i, cv2.CC_STAT_HEIGHT] > 0.86 * H
    }
    cands = [(stats[i, cv2.CC_STAT_AREA], i) for i in range(1, n) if i not in drop]
    if not cands:
        return wall_ink
    # The building rarely survives as ONE component (door/window gaps split
    # it) — so the building's extent is the UNION bbox of all LARGE pieces
    # (≥30% of the biggest). Small far-away ink (title-block table rules,
    # banner remnants) neither seeds nor fits that box and is dropped.
    big_area = max(cands)[0]
    seeds = [i for a, i in cands if a >= 0.3 * big_area]
    x0 = min(stats[i, cv2.CC_STAT_LEFT] for i in seeds)
    y0 = min(stats[i, cv2.CC_STAT_TOP] for i in seeds)
    x1 = max(stats[i, cv2.CC_STAT_LEFT] + stats[i, cv2.CC_STAT_WIDTH] for i in seeds)
    y1 = max(stats[i, cv2.CC_STAT_TOP] + stats[i, cv2.CC_STAT_HEIGHT] for i in seeds)
    mx, my = int(0.08 * (x1 - x0)), int(0.08 * (y1 - y0))
    x0, y0, x1, y1 = x0 - mx, y0 - my, x1 + mx, y1 + my
    keep = np.zeros_like(wall_ink)
    for i in range(1, n):
        if i in drop or stats[i, cv2.CC_STAT_AREA] < 30:
            continue
        cx0, cy0 = stats[i, cv2.CC_STAT_LEFT], stats[i, cv2.CC_STAT_TOP]
        cx1 = cx0 + stats[i, cv2.CC_STAT_WIDTH]
        cy1 = cy0 + stats[i, cv2.CC_STAT_HEIGHT]
        if cx0 >= x0 and cy0 >= y0 and cx1 <= x1 and cy1 <= y1:
            keep[lab == i] = 255
    return keep


def wall_network(dark_solid, W, H):
    """Keep only the dark components that form the WALL NETWORK: the giant
    connected component spanning the sheet plus anything sizeable touching it.
    Dark furniture (TV units, appliance fronts) sits isolated inside rooms and
    is dropped, so it can't mint phantom walls."""
    n, lab, stats, _ = cv2.connectedComponentsWithStats(dark_solid, 8)
    if n <= 1:
        return dark_solid
    biggest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    big_mask = (lab == biggest).astype(np.uint8) * 255
    near = cv2.dilate(big_mask, cv2.getStructuringElement(cv2.MORPH_RECT, (9, 9)))
    keep = np.zeros_like(dark_solid)
    min_area = 0.0004 * W * H
    for i in range(1, n):
        if i == biggest:
            keep[lab == i] = 255
            continue
        if stats[i, cv2.CC_STAT_AREA] < min_area:
            continue
        comp = (lab == i).astype(np.uint8) * 255
        if cv2.countNonZero(cv2.bitwise_and(comp, near)) > 0:
            keep[lab == i] = 255
    return keep


def pink_wall_band(masks, thickness, W, H):
    """Solid wall band for the pink style: wall strokes plus the black
    window/column rectangles that sit INSIDE the wall (they are wall, not void),
    closed across the measured face spacing so the band reads as one solid
    stroke. Door gaps (≳ wall thickness) survive the closing kernel."""
    t = int(max(5, round(thickness)))
    on_wall = cv2.dilate(
        masks["wall_lines"], cv2.getStructuringElement(cv2.MORPH_RECT, (t | 1, t | 1))
    )
    black_on_wall = cv2.bitwise_and(masks["black"], on_wall)
    band = cv2.bitwise_or(masks["wall_lines"], black_on_wall)
    close = cv2.getStructuringElement(cv2.MORPH_RECT, ((t + 2) | 1, (t + 2) | 1))
    return cv2.morphologyEx(band, cv2.MORPH_CLOSE, close)


# --------------------------------------------------------------------------
# Wall runs (pink style): axis-aligned centrelines merged ACROSS openings
# --------------------------------------------------------------------------

def extract_runs(wall_lines, W, H, thickness=None):
    """Wall centreline runs + wall thickness from the wall-ink mask.

    Two drawing families feed this: PINK walls are two parallel face LINES
    (stage 2 measures thickness as the dominant face spacing, stage 3 pairs
    the faces into one centreline run); RENDER walls are one SOLID bar (the
    caller passes `thickness` measured from the fill, and each bar arrives as
    a single "face" whose cross-extent is kept as cmin/cmax). Collinear runs
    are then merged WITH gap bridging so a run spans across its door/window
    openings — the opening scan walks each run and reads what fills every gap.

    Returns ({"h": [...], "v": [...]}, thickness_px).
    """
    def comps_to_segs(mask, horizontal, min_len):
        segs = []
        n, _lab, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
        for i in range(1, n):
            x, y, w, h = stats[i, 0], stats[i, 1], stats[i, 2], stats[i, 3]
            if horizontal:
                if w < min_len:
                    continue
                segs.append({"a0": int(x), "a1": int(x + w), "c": int(y + h / 2),
                             "lo": int(y), "hi": int(y + h)})
            else:
                if h < min_len:
                    continue
                segs.append({"a0": int(y), "a1": int(y + h), "c": int(x + w / 2),
                             "lo": int(x), "hi": int(x + w)})
        return segs

    # Stage 1 — per-face segments (tiny dilate only bridges anti-aliasing).
    min_len = max(10, int(round(min(W, H) * 0.03)))
    tiny = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    horiz = cv2.dilate(cv2.morphologyEx(
        wall_lines, cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_RECT, (min_len, 1))), tiny)
    vert = cv2.dilate(cv2.morphologyEx(
        wall_lines, cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_RECT, (1, min_len))), tiny)
    faces_h = comps_to_segs(horiz, True, min_len)
    faces_v = comps_to_segs(vert, False, min_len)

    # Stage 2 — wall thickness = dominant spacing between overlapping parallel
    # faces (each wall contributes its inner↔outer face distance). Skipped when
    # the caller already measured it (solid-fill walls have no face pairs).
    if thickness is None:
        max_t = max(6, int(round(min(W, H) * 0.055)))
        spacings = []
        for faces in (faces_h, faces_v):
            for i, a in enumerate(faces):
                for b in faces[i + 1:]:
                    d = abs(a["c"] - b["c"])
                    if d < 3 or d > max_t:
                        continue
                    overlap = min(a["a1"], b["a1"]) - max(a["a0"], b["a0"])
                    if overlap >= 0.5 * min(a["a1"] - a["a0"], b["a1"] - b["a0"]):
                        spacings.append(d)
        thickness = float(np.median(spacings)) if spacings else 5.0

    def merge(segs, span_max, tol):
        """Merge collinear line fragments; bridge gaps (openings) up to
        span_max px, tracking how much of the span is real ink so a line glued
        out of scattered furniture fragments can be rejected."""
        segs = sorted(segs, key=lambda s: (s["c"], s["a0"]))
        out = []
        for s in segs:
            merged = False
            for o in out:
                if abs(o["c"] - s["c"]) <= tol and \
                        s["a0"] - o["a1"] <= span_max and o["a0"] - s["a1"] <= span_max:
                    w_o = o["a1"] - o["a0"]
                    w_s = s["a1"] - s["a0"]
                    o["c"] = int(round((o["c"] * w_o + s["c"] * w_s) / max(1, w_o + w_s)))
                    o["a0"] = min(o["a0"], s["a0"])
                    o["a1"] = max(o["a1"], s["a1"])
                    o["lo"] = min(o.get("lo", o["c"]), s.get("lo", s["c"]))
                    o["hi"] = max(o.get("hi", o["c"]), s.get("hi", s["c"]))
                    o["ink"] = o.get("ink", w_o) + w_s
                    merged = True
                    break
            if not merged:
                s = dict(s)
                s["ink"] = s["a1"] - s["a0"]
                out.append(s)
        return out

    # Stage 3 — glue collinear FACE fragments into full face lines first (walls
    # are interrupted by their windows/doors), then pair parallel face lines
    # into one CENTRELINE run per wall. Pairing is ASCENDING-GREEDY (outermost
    # face grabs the next line inward), which matches the drawing's anatomy:
    # wall = [outer face, inner face], and the parasitic FLOOR/skirting line
    # ~1 thickness further inside is left an orphan and dropped.
    # Bridge generously: an inner face is interrupted by every window/door on
    # its wall (single interruptions reach ~8t for a wide window), and the ink
    # coverage floor rejects lines glued out of scattered furniture fragments.
    bridge = int(round(10 * thickness))
    lines_h = [l for l in merge(faces_h, bridge, 3)
               if l["ink"] >= 0.55 * (l["a1"] - l["a0"])]
    lines_v = [l for l in merge(faces_v, bridge, 3)
               if l["ink"] >= 0.55 * (l["a1"] - l["a0"])]

    def pair_lines(lines):
        lines = sorted(lines, key=lambda s: s["c"])
        used = [False] * len(lines)
        out = []
        for i, a in enumerate(lines):
            if used[i]:
                continue
            used[i] = True
            partner = None
            for j in range(i + 1, len(lines)):
                if used[j]:
                    continue
                b = lines[j]
                if b["c"] - a["c"] > 1.6 * thickness:
                    break
                if b["c"] - a["c"] < 3:
                    continue
                la = a["a1"] - a["a0"]
                lb = b["a1"] - b["a0"]
                # Faces of one wall have comparable spans — a tiny fragment
                # must not marry a full-height line (floor line + furniture
                # sliver would mint a phantom wall).
                if min(la, lb) < max(3 * thickness, 0.15 * max(la, lb)):
                    continue
                overlap = min(a["a1"], b["a1"]) - max(a["a0"], b["a0"])
                if overlap >= 0.7 * min(la, lb):
                    partner = j
                    break
            if partner is not None:
                b = lines[partner]
                used[partner] = True
                out.append({
                    "c": (a["c"] + b["c"]) // 2,
                    "cmin": a["c"], "cmax": b["c"],
                    "a0": min(a["a0"], b["a0"]),
                    "a1": max(a["a1"], b["a1"]),
                    "faces": 2,
                })
            else:
                # A lone line keeps its true cross-extent: a SOLID wall bar
                # (render style / maroon fill) is one "face" spanning its full
                # thickness, so the opening scan's band must cover all of it.
                out.append({
                    "c": a["c"],
                    "cmin": a.get("lo", a["c"]),
                    "cmax": a.get("hi", a["c"]),
                    "a0": a["a0"], "a1": a["a1"], "faces": 1,
                })
        return out

    def merge_runs(segs, span_max, tol):
        """Collinear-merge paired runs, keeping the widest face extent."""
        segs = sorted(segs, key=lambda s: (s["c"], s["a0"]))
        out = []
        for s in segs:
            merged = False
            for o in out:
                if abs(o["c"] - s["c"]) <= tol and \
                        s["a0"] - o["a1"] <= span_max and o["a0"] - s["a1"] <= span_max:
                    o["a0"] = min(o["a0"], s["a0"])
                    o["a1"] = max(o["a1"], s["a1"])
                    o["cmin"] = min(o["cmin"], s["cmin"])
                    o["cmax"] = max(o["cmax"], s["cmax"])
                    o["c"] = (o["cmin"] + o["cmax"]) // 2
                    o["faces"] = max(o["faces"], s["faces"])
                    merged = True
                    break
            if not merged:
                out.append(dict(s))
        return out

    tol = max(3, int(round(thickness * 0.6)))
    runs = {
        "h": merge_runs(pair_lines(lines_h), bridge, tol),
        "v": merge_runs(pair_lines(lines_v), bridge, tol),
    }

    # A single face line living in the SHADOW of a paired wall (parallel,
    # within ~2 thicknesses, mostly overlapping) is that wall's floor/skirting
    # line — drop it before it can mint phantom openings.
    def shadowed(s, peers):
        for p in peers:
            if p is s or p["faces"] < 2:
                continue
            if abs(p["c"] - s["c"]) > 2.2 * thickness:
                continue
            overlap = min(s["a1"], p["a1"]) - max(s["a0"], p["a0"])
            if overlap >= 0.6 * (s["a1"] - s["a0"]):
                return True
        return False

    runs["h"] = [s for s in runs["h"] if s["faces"] >= 2 or not shadowed(s, runs["h"])]
    runs["v"] = [s for s in runs["v"] if s["faces"] >= 2 or not shadowed(s, runs["v"])]

    # Extend run ends to the perpendicular run they abut (a door hinged at a
    # corner leaves its gap OUTSIDE the run span otherwise) and remember the
    # junction so the opening scan can treat it as solid support. Reach must
    # cover a full corner-hinged door (gap ≈ 3-4 thicknesses).
    reach = int(round(4.5 * thickness))

    def extend(runs_a, runs_b):
        for s in runs_a:
            s["j0"] = s.get("j0", False)
            s["j1"] = s.get("j1", False)
            for p in runs_b:
                if not (p["a0"] - 2 <= s["c"] <= p["a1"] + 2):
                    continue
                if abs(s["a0"] - p["c"]) <= reach:
                    s["a0"] = min(s["a0"], p["c"])
                    s["j0"] = True
                if abs(s["a1"] - p["c"]) <= reach:
                    s["a1"] = max(s["a1"], p["c"])
                    s["j1"] = True

    extend(runs["h"], runs["v"])
    extend(runs["v"], runs["h"])

    # Lone face lines are real walls only when a SOLID fill backs them (the
    # dark-maroon party walls) or they SPAN between perpendicular walls (thin
    # single-stroke partitions); free-floating strokes are dropped.
    def solid_backed(s, horizontal):
        n = hits = 0
        for a in range(s["a0"], s["a1"] + 1, 3):
            x, y = (a, s["c"]) if horizontal else (s["c"], a)
            x0, x1 = max(0, x - 2), min(W, x + 3)
            y0, y1 = max(0, y - 2), min(H, y + 3)
            n += 1
            if cv2.countNonZero(wall_lines[y0:y1, x0:x1]) >= (x1 - x0) * (y1 - y0) * 0.55:
                hits += 1
        return n > 0 and hits / n >= 0.6

    runs["h"] = [s for s in runs["h"]
                 if s["faces"] >= 2 or (s["j0"] and s["j1"]) or solid_backed(s, True)]
    runs["v"] = [s for s in runs["v"]
                 if s["faces"] >= 2 or (s["j0"] and s["j1"]) or solid_backed(s, False)]
    return runs, thickness


def runs_to_walls(runs, thickness):
    """Run segments → the JSON wall contract (x1,y1,x2,y2,thickness)."""
    t = round(float(thickness), 1)
    walls = []
    for s in runs["h"]:
        walls.append({"x1": s["a0"], "y1": s["c"], "x2": s["a1"], "y2": s["c"], "thickness": t})
    for s in runs["v"]:
        walls.append({"x1": s["c"], "y1": s["a0"], "x2": s["c"], "y2": s["a1"], "thickness": t})
    return walls


def runs_barrier(runs, thickness, W, H):
    """Wall-run centrelines drawn as a solid barrier mask. Runs span their
    door/window gaps, so rooms become enclosed cells for the watershed. Each
    run is extended slightly past its endpoints so two runs meeting at a
    corner always overlap — a one-pixel corner gap would leak a room into its
    neighbour (or out to the sheet border, losing the room entirely)."""
    barrier = np.zeros((H, W), np.uint8)
    ext = max(2, int(round(thickness / 2)) + 1)
    for s in runs["h"]:
        w = max(3, s["cmax"] - s["cmin"] + 2)
        cv2.line(barrier, (s["a0"] - ext, s["c"]), (s["a1"] + ext, s["c"]), 255, w)
    for s in runs["v"]:
        w = max(3, s["cmax"] - s["cmin"] + 2)
        cv2.line(barrier, (s["c"], s["a0"] - ext), (s["c"], s["a1"] + ext), 255, w)
    return barrier


# --------------------------------------------------------------------------
# Openings (pink style): read the actual symbols along each wall run
# --------------------------------------------------------------------------

def infer_openings_pink(masks, runs, thickness, W, H):
    """Walk every wall run and classify what occupies each stretch of it.

    Along a run (sampled on the wall CENTRELINE, a band of ±thickness/2), each
    position is one of:
      wall   — a red wall face stroke is present
      black  — a black rectangle fills the wall band  → window (or column)
      orange — an orange rail crosses the band        → sliding-door evidence
      void   — nothing                                → door candidate

    • black stretches are windows UNLESS a perpendicular wall run crosses the
      spot (then it's a structural column drawn in the same black).
    • void stretches of door width flanked by real wall need DOOR EVIDENCE to
      emit: a swing symbol (gray arc + orange leaf spreading across the swing
      box beside the gap) or an orange slider rail along the gap itself. This
      is what keeps counters / shelf lines from minting phantom doors.
    Never invents an opening: every emission is anchored to drawn symbols.
    """
    t = max(4.0, float(thickness))
    min_black = max(5, int(1.2 * t))          # smallest window rectangle
    max_black = int(6 * t)                    # widest window rectangle
    # Doorway width floor: the pink CAD's thin walls want a stricter floor
    # (2.2×) to reject sliver gaps; render walls are THICK (a door is barely
    # 2 wall-thicknesses wide), so 1.8× would miss real doors there.
    min_gap = max(9, int((1.8 if masks.get("style") == "render" else 2.2) * t))
    max_gap = int(6 * t)                      # widest swing door
    max_slider = int(14 * t)                  # widest orange-rail slider
    flank = max(4, int(0.8 * t))              # solid wall required beside a gap

    black_m = masks["black"]
    orange_m = masks["orange"]
    red_m = masks["red"]

    # The pink CAD's window rects are sparse strokes (any pixel counts); the
    # render style's glaze is 2-3 thin lines across the band (~15-25% of it) —
    # require enough of that so a stray neutral grout pixel in a door gap
    # doesn't read as window, without losing real glazing.
    blk_frac = 0.15 if masks.get("style") == "render" else 0.0

    def present(mask, x, y, rx, ry, frac=0.0):
        x0, x1 = max(0, x - rx), min(W, x + rx + 1)
        y0, y1 = max(0, y - ry), min(H, y + ry + 1)
        if x0 >= x1 or y0 >= y1:
            return False
        n = cv2.countNonZero(mask[y0:y1, x0:x1])
        if frac <= 0:
            return n > 0
        return n >= frac * (x1 - x0) * (y1 - y0)

    def perpendicular_crosses(horizontal, mid, c):
        """True when a perpendicular wall run passes THROUGH (mid,c) — the
        black rectangle there is a structural column, not a window."""
        for s in (runs["v"] if horizontal else runs["h"]):
            if abs(s["c"] - mid) <= 1.5 * t and s["a0"] - 2 <= c <= s["a1"] + 2:
                return True
        return False

    # Solid ink that blocks walking through: walls, window frames, furniture.
    # (Gray arcs/dashes and the blue fixtures are see-through for this test.)
    # Render floors are TEXTURED (beige/wood, saturated) — they'd read as
    # obstacles, blocking every doorway's own threshold. There, only walls and
    # glazing block passage; pink's flat white floors keep the furniture test.
    if masks.get("style") == "render":
        blocking = cv2.bitwise_or(red_m, black_m)
    else:
        blocking = cv2.bitwise_or(cv2.bitwise_or(red_m, black_m), orange_m)

    def walkthrough_clearance(horizontal, b0, b1, run):
        """A doorway must have CLEAR PASSAGE: the ribbon just beyond the wall
        faces at the gap is furniture-free on at least one side and mostly
        free on the other (a door can open onto stairs, but not into a kitchen
        counter's sink, the lift machine, or a sofa)."""
        glen = b1 - b0
        if glen < 8:
            return True  # too small a ribbon to judge — leave to other gates
        lo, hi = run["cmin"], run["cmax"]
        depth = max(5, int(round(1.2 * t)))
        # Skip a margin at the ends so the drawn door leaf (parked at the
        # hinge) doesn't count as an obstacle.
        m = max(2, glen // 6)
        fracs = []
        for side_out in (False, True):
            if horizontal:
                x0, x1 = b0 + m, b1 - m
                y0, y1 = (lo - depth - 1, lo - 2) if side_out else (hi + 2, hi + depth + 1)
            else:
                y0, y1 = b0 + m, b1 - m
                x0, x1 = (lo - depth - 1, lo - 2) if side_out else (hi + 2, hi + depth + 1)
            x0, y0 = max(0, x0), max(0, y0)
            x1, y1 = min(W, x1), min(H, y1)
            if x1 - x0 < 2 or y1 - y0 < 2:
                fracs.append(1.0)  # at the sheet edge — nothing blocking
                continue
            roi = blocking[y0:y1, x0:x1]
            fracs.append(1.0 - cv2.countNonZero(roi) / roi.size)
        hi_side, lo_side = max(fracs), min(fracs)
        return hi_side >= 0.85 and lo_side >= 0.5

    doors, windows = [], []

    for horizontal in (True, False):
        for s in (runs["h"] if horizontal else runs["v"]):
            a0, a1 = s["a0"], s["a1"]
            c, cmin, cmax = s["c"], s["cmin"], s["cmax"]
            length = a1 - a0
            if length < 3 * min_gap:
                continue
            # Black window frames hang a few px past the faces (the sill), so
            # the black probe spans the face extent plus a margin either side.
            inner_r = (cmax - cmin) // 2 + 4

            # Classify every position: 'b' black rect in the band (window
            # frame — checked FIRST, the sill line stays red through windows),
            # 'w' any face inked (a lone face is a junction overlap), else gap.
            states = []
            orange_in_band = []
            orange_beyond = []
            white_m = masks.get("white")
            for a in range(a0, a1 + 1):
                if horizontal:
                    f0 = present(red_m, a, cmin, 1, 2)
                    f1 = present(red_m, a, cmax, 1, 2)
                    blk = present(black_m, a, c, 1, inner_r, blk_frac)
                    org = present(orange_m, a, c, 1, max(2, inner_r - 1))
                    beyond = (present(orange_m, a, cmin - 4, 1, 2)
                              or present(orange_m, a, cmax + 4, 1, 2))
                    # Render windows: glazing prints nearly the same gray as the
                    # wall fill, but only a WINDOW's band mixes in white gaps.
                    if white_m is not None and not blk and (f0 or f1):
                        blk = present(white_m, a, c, 1, inner_r, 0.15)
                else:
                    f0 = present(red_m, cmin, a, 2, 1)
                    f1 = present(red_m, cmax, a, 2, 1)
                    blk = present(black_m, c, a, inner_r, 1, blk_frac)
                    org = present(orange_m, c, a, max(2, inner_r - 1), 1)
                    beyond = (present(orange_m, cmin - 4, a, 2, 1)
                              or present(orange_m, cmax + 4, a, 2, 1))
                    if white_m is not None and not blk and (f0 or f1):
                        blk = present(white_m, c, a, inner_r, 1, 0.15)
                orange_in_band.append(org)
                orange_beyond.append(beyond)
                if blk:
                    states.append("b")
                elif f0 and f1:
                    states.append("w")
                elif f0 or f1:
                    # One face still inked: a junction overlap — or a doorway
                    # crossed by a parallel floor/threshold line. Kept distinct
                    # so it can become a door WITH swing evidence.
                    states.append("p")
                else:
                    states.append(".")

            # SLIDING DOOR pass: an orange rail INSIDE the wall band reads as
            # 'w' (its red frame lines sit where the faces were) — find long
            # orange stretches between the faces. A rail is CONFINED to the
            # band; orange that continues past the faces (the lift machine, a
            # wardrobe against the wall) is furniture, not a slider. Only a
            # two-faced wall can host a slider (the rail's frame is the pair).
            i = 0
            slid = []
            if s["faces"] < 2:
                i = len(orange_in_band)
            while i < len(orange_in_band):
                if not orange_in_band[i]:
                    i += 1
                    continue
                j = i
                while j < len(orange_in_band) and orange_in_band[j]:
                    j += 1
                if 2.5 * t <= j - i <= max_slider:
                    spill = sum(1 for k in range(i, j) if orange_beyond[k])
                    if spill <= 0.3 * (j - i):
                        slid.append((a0 + i, a0 + j))
                i = j
            for (b0, b1) in slid:
                mid = (b0 + b1) // 2
                cx, cy = (mid, c) if horizontal else (c, mid)
                doors.append({
                    "x": int(cx), "y": int(cy),
                    "orientation": "h" if horizontal else "v",
                    "length": int(b1 - b0),
                })

            # Collapse states into stretches [start, end, kind]; '.' and 'p'
            # merge into one gap kind (a doorway keeps its width even where a
            # floor/threshold line crosses it).
            stretches = []
            i = 0
            while i < len(states):
                kind = "g" if states[i] in (".", "p") else states[i]
                j = i
                while j < len(states) and ("g" if states[j] in (".", "p") else states[j]) == kind:
                    j += 1
                stretches.append([a0 + i, a0 + j, kind])
                i = j

            # Absorb tiny (≤2px) wall islands between gap stretches — a dashed
            # grid line or door threshold crossing the opening splits it into
            # fragments smaller than min_gap otherwise. Same for windows.
            k = 1
            while k + 1 < len(stretches):
                prev, cur, nxt = stretches[k - 1], stretches[k], stretches[k + 1]
                if cur[1] - cur[0] <= 2 and prev[2] == nxt[2] and prev[2] in ("g", "b") \
                        and cur[2] not in ("g", "b"):
                    prev[1] = nxt[1]
                    del stretches[k:k + 2]
                else:
                    k += 1

            for si, (b0, b1, kind) in enumerate(stretches):
                glen = b1 - b0
                mid = (b0 + b1) // 2
                cx, cy = (mid, c) if horizontal else (c, mid)

                if kind == "b" and min_black <= glen <= max_black:
                    # Columns are black rects too, but SHORT (≈1-2 wall
                    # thicknesses) and pierced by a perpendicular wall.
                    if glen < 2.2 * t and perpendicular_crosses(horizontal, mid, c):
                        continue
                    windows.append({
                        "x": int(cx), "y": int(cy),
                        "orientation": "h" if horizontal else "v",
                        "length": int(glen),
                    })
                    continue

                if kind == "g" and min_gap <= glen <= max_gap:
                    # Skip gaps the slider pass already claimed.
                    if any(not (b1 <= s0 or b0 >= s1) for (s0, s1) in slid):
                        continue
                    # A doorway must sit BETWEEN support: solid wall beside it,
                    # or the perpendicular wall it hinges on (corner doors).
                    left_wall = sum(sk[1] - sk[0] for sk in stretches[:si] if sk[2] in ("w", "b"))
                    right_wall = sum(sk[1] - sk[0] for sk in stretches[si + 1:] if sk[2] in ("w", "b"))
                    # A corner-hinged door may keep a small sliver of wall
                    # between the gap and the junction it hinges on.
                    if left_wall < flank and not (s.get("j0") and b0 - a0 <= flank + 2):
                        _dbg(f"gap {horizontal and 'h' or 'v'} c={c} {b0}..{b1} rejected: left flank {left_wall}")
                        continue
                    if right_wall < flank and not (s.get("j1") and a1 - b1 <= flank + 2):
                        _dbg(f"gap {horizontal and 'h' or 'v'} c={c} {b0}..{b1} rejected: right flank {right_wall}")
                        continue
                    if not walkthrough_clearance(horizontal, b0, b1, s):
                        _dbg(f"gap {horizontal and 'h' or 'v'} c={c} {b0}..{b1} rejected: no walkthrough clearance")
                        continue
                    doors.append({
                        "x": int(cx), "y": int(cy),
                        "orientation": "h" if horizontal else "v",
                        "length": int(glen),
                    })

    doors = merge_openings(doors, gap=max(4, int(t)))
    windows = merge_openings(windows, gap=max(4, int(t)))
    return doors, windows


def merge_openings(items, gap):
    """Merge same-orientation openings whose spans touch within `gap` px."""
    out = []
    for it in sorted(items, key=lambda d: (d["orientation"], d["y"] if d["orientation"] == "h" else d["x"],
                                           d["x"] if d["orientation"] == "h" else d["y"])):
        merged = False
        for o in out:
            if o["orientation"] != it["orientation"]:
                continue
            if it["orientation"] == "h":
                same_line = abs(o["y"] - it["y"]) <= gap
                d = abs(o["x"] - it["x"]) - (o["length"] + it["length"]) / 2
            else:
                same_line = abs(o["x"] - it["x"]) <= gap
                d = abs(o["y"] - it["y"]) - (o["length"] + it["length"]) / 2
            if same_line and d <= gap:
                total = o["length"] + it["length"]
                if it["orientation"] == "h":
                    o["x"] = int(round((o["x"] * o["length"] + it["x"] * it["length"]) / total))
                else:
                    o["y"] = int(round((o["y"] * o["length"] + it["y"] * it["length"]) / total))
                o["length"] = int(total)
                merged = True
                break
        if not merged:
            out.append(dict(it))
    return out


# --------------------------------------------------------------------------
# Shared measurements
# --------------------------------------------------------------------------

def building_box(wmask, W, H):
    """Outer bounding box of all wall pixels = the building footprint (pixels)."""
    ys, xs = np.where(wmask > 0)
    if len(xs) == 0:
        return {"x": 0, "y": 0, "w": W, "h": H}
    x0, x1 = int(xs.min()), int(xs.max())
    y0, y1 = int(ys.min()), int(ys.max())
    return {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0}


def wall_thickness(wmask):
    """Median wall stroke thickness in pixels, via the distance transform."""
    dt = cv2.distanceTransform(wmask, cv2.DIST_L2, 3)
    vals = dt[dt > 0]
    if vals.size == 0:
        return 4.0
    # Ridge values ≈ half-thickness; use a high percentile, ×2 for full width.
    return float(np.percentile(vals, 85) * 2.0)


def prepare(img):
    """Normalise the sheet and build masks: downscale to the style's working
    size, probing the style at (or near) full resolution first so tiny sheets
    and huge exports route identically. Returns (img, masks, scale_from_input)."""
    h0, w0 = img.shape[:2]
    probe = img
    if max(h0, w0) > LEGACY_MAX_SIDE:
        s = LEGACY_MAX_SIDE / max(h0, w0)
        probe = cv2.resize(img, (int(w0 * s), int(h0 * s)), interpolation=cv2.INTER_AREA)
    style = build_masks(probe)["style"]

    max_side = PINK_MAX_SIDE if style == "pink" else LEGACY_MAX_SIDE
    scale = 1.0
    work = img
    if max(h0, w0) > max_side:
        scale = max_side / max(h0, w0)
        work = cv2.resize(img, (int(w0 * scale), int(h0 * scale)), interpolation=cv2.INTER_AREA)
    masks = build_masks(work)
    masks["style"] = style  # probe verdict wins (working-size probe may drift)
    return work, masks, scale


# --------------------------------------------------------------------------
# Legacy pipeline (yellow-fill / ink styles) — unchanged behaviour
# --------------------------------------------------------------------------

def wall_mask(img):
    """Binary mask of the walls for the LEGACY styles. White = wall.

    Prefers the (yellow) wall FILL used by colour CAD plans; else falls back to
    segmenting dark ink so line-art plans detect too. NOTE: this mask closes
    door/window gaps (rooms must read as enclosed cells) — openings for these
    styles are inferred on the RAW pre-close mask, see detect().
    """
    H, W = img.shape[:2]
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, (22, 35, 110), (42, 255, 255))

    if cv2.countNonZero(mask) < 0.01 * W * H:
        gray = cv2.GaussianBlur(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), (3, 3), 0)
        _, mask = cv2.threshold(
            gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU
        )
    raw = mask.copy()
    # Close door/window gaps so rooms read as enclosed cells, and fill pinholes.
    link = max(3, int(round(min(W, H) * 0.012)))
    mask = cv2.morphologyEx(
        mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (link, link))
    )
    clean = max(2, int(round(min(W, H) * 0.004)))
    mask = cv2.morphologyEx(
        mask, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (clean, clean))
    )
    return mask, raw


def detect_walls(wmask, W, H):
    """Hough on the wall mask edges → axis-aligned, merged segments."""
    edges = cv2.Canny(wmask, 50, 150)
    min_len = max(30, int(min(W, H) * 0.08))
    lines = cv2.HoughLinesP(
        edges, 1, np.pi / 180, threshold=80, minLineLength=min_len, maxLineGap=10
    )
    raw = []
    if lines is not None:
        for line in lines:
            # cv2.HoughLinesP's output shape is (N, 1, 4) on some OpenCV builds
            # and (N, 4) on others (observed: opencv-python 5.x) — np.ravel
            # flattens either into one 4-element array regardless, instead of
            # assuming line[0] is itself the 4-tuple (which crashes with
            # "cannot unpack non-iterable numpy.int32 object" on the (N, 4) shape,
            # since line[0] there is just the first scalar, not a row).
            x1, y1, x2, y2 = np.ravel(line)[:4]
            dx, dy = abs(int(x2) - int(x1)), abs(int(y2) - int(y1))
            angle = np.degrees(np.arctan2(dy, dx))
            if 8 <= angle <= 82:
                continue  # keep only near-horizontal / near-vertical walls
            if dx >= dy:
                y = (y1 + y2) // 2
                raw.append({"x1": int(min(x1, x2)), "y1": int(y),
                            "x2": int(max(x1, x2)), "y2": int(y), "thickness": 4})
            else:
                x = (x1 + x2) // 2
                raw.append({"x1": int(x), "y1": int(min(y1, y2)),
                            "x2": int(x), "y2": int(max(y1, y2)), "thickness": 4})
    return merge_walls(raw)


def merge_walls(walls, tol=6):
    """Merge collinear, overlapping axis-aligned segments."""
    merged = []
    used = [False] * len(walls)
    for i, a in enumerate(walls):
        if used[i]:
            continue
        a = dict(a)
        horizontal = a["y1"] == a["y2"]
        for j in range(i + 1, len(walls)):
            if used[j]:
                continue
            b = walls[j]
            if (b["y1"] == b["y2"]) != horizontal:
                continue
            if horizontal:
                if abs(a["y1"] - b["y1"]) > tol:
                    continue
                if b["x1"] > a["x2"] + tol or b["x2"] < a["x1"] - tol:
                    continue
                a["x1"], a["x2"] = min(a["x1"], b["x1"]), max(a["x2"], b["x2"])
                used[j] = True
            else:
                if abs(a["x1"] - b["x1"]) > tol:
                    continue
                if b["y1"] > a["y2"] + tol or b["y2"] < a["y1"] - tol:
                    continue
                a["y1"], a["y2"] = min(a["y1"], b["y1"]), max(a["y2"], b["y2"])
                used[j] = True
        used[i] = True
        merged.append(a)
    return merged


def detect_rooms(img, wmask, W, H):
    """
    Segment rooms with the watershed transform so they TILE (share walls) — the
    real layout, not floating boxes. Door gaps no longer merge rooms: eroded
    interior "cores" seed one marker per room, and watershed grows them back to
    the walls, splitting neighbours at the doorway.
    """
    cnts, _ = cv2.findContours(wmask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    building = np.zeros((H, W), np.uint8)
    if cnts:
        cv2.drawContours(building, [max(cnts, key=cv2.contourArea)], -1, 255, -1)
    interior = cv2.bitwise_and(building, cv2.bitwise_not(wmask))
    interior = cv2.morphologyEx(
        interior, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    )

    er = max(6, int(round(min(W, H) * 0.045)))
    cores = cv2.erode(interior, cv2.getStructuringElement(cv2.MORPH_RECT, (er, er)))

    n_seed, seed = cv2.connectedComponents(cores)
    markers = seed.astype(np.int32) + 1  # background (walls + outside) = 1
    markers[building == 0] = 1
    unknown = cv2.subtract(interior, cores)  # interior not yet in a core
    markers[unknown > 0] = 0

    cv2.watershed(img, markers)

    img_area = W * H
    boxes = []
    for lab in range(2, n_seed + 1):
        ys, xs = np.where(markers == lab)
        if xs.size < img_area * 0.0015:
            continue
        x, y = int(xs.min()), int(ys.min())
        w, h = int(xs.max() - x), int(ys.max() - y)
        aspect = w / max(1, h)
        fill = xs.size / max(1, w * h)
        if 0.15 < aspect < 7.0 and w > W * 0.03 and h > H * 0.03 and fill > 0.45:
            boxes.append({"x": x, "y": y, "w": w, "h": h})
    return dedupe_boxes(boxes)


def dedupe_boxes(boxes):
    """Drop boxes ~contained within a larger one; keep up to 20."""
    boxes = sorted(boxes, key=lambda b: b["w"] * b["h"], reverse=True)
    keep = []
    for box in boxes:
        contained = False
        for k in keep:
            ix = max(box["x"], k["x"])
            iy = max(box["y"], k["y"])
            ax = min(box["x"] + box["w"], k["x"] + k["w"])
            ay = min(box["y"] + box["h"], k["y"] + k["h"])
            inter = max(0, ax - ix) * max(0, ay - iy)
            if inter > 0.8 * (box["w"] * box["h"]):
                contained = True
                break
        if not contained:
            keep.append(box)
    return keep[:20]


def infer_openings(walls, wmask_raw, building, W, H):
    """LEGACY opening inference (yellow/ink styles): contiguous runs along a
    detected wall where the wall mask is absent. Runs on the RAW (pre-close)
    mask — the closed mask has the very gaps we're hunting filled in. Gaps on
    the building's outer edge are windows; interior gaps are doors.
    """
    mh, mw = wmask_raw.shape[:2]
    bx, by, bw, bh = building["x"], building["y"], building["w"], building["h"]
    edge = max(8, int(0.04 * max(W, H)))
    step = 2
    min_len = max(24, int(0.05 * max(W, H)))

    def wall_present(x, y):
        x0, x1 = max(0, x - 4), min(mw, x + 5)
        y0, y1 = max(0, y - 4), min(mh, y + 5)
        return x0 < x1 and y0 < y1 and cv2.countNonZero(wmask_raw[y0:y1, x0:x1]) > 0

    doors, windows = [], []
    for w in walls:
        horizontal = w["y1"] == w["y2"]
        length = abs(w["x2"] - w["x1"]) if horizontal else abs(w["y2"] - w["y1"])
        if length < min_len:
            continue
        base = min(w["x1"], w["x2"]) if horizontal else min(w["y1"], w["y2"])
        fixed = w["y1"] if horizontal else w["x1"]

        gaps, run, run_start = [], 0, 0
        for tpos in range(0, int(length) + 1, step):
            x, y = (base + tpos, fixed) if horizontal else (fixed, base + tpos)
            if wall_present(int(x), int(y)):
                if 0.08 * length <= run <= 0.7 * length:
                    gaps.append((run_start, run))
                run = 0
            else:
                if run == 0:
                    run_start = tpos
                run += step
        if 0.08 * length <= run <= 0.7 * length:
            gaps.append((run_start, run))

        for start, glen in gaps:
            mid = start + glen / 2
            cx, cy = (base + mid, fixed) if horizontal else (fixed, base + mid)
            exterior = (cx < bx + edge or cx > bx + bw - edge
                        or cy < by + edge or cy > by + bh - edge)
            if exterior:
                windows.append({"x": int(cx), "y": int(cy),
                                "orientation": "h" if horizontal else "v",
                                "length": int(glen)})
            else:
                doors.append({"x": int(cx), "y": int(cy),
                              "orientation": "h" if horizontal else "v",
                              "length": int(glen)})
    return doors[:12], windows[:12]


# --------------------------------------------------------------------------
# Detection entry
# --------------------------------------------------------------------------

def detect(image_path: str, debug_path: str | None = None) -> dict:
    img = cv2.imread(image_path)
    if img is None:
        raise ValueError(f"Could not read image: {image_path}")

    img, masks, _ = prepare(img)
    H, W = img.shape[:2]

    if masks["style"] in ("pink", "render", "cad"):
        if masks["style"] == "pink":
            runs, thickness = extract_runs(masks["wall_lines"], W, H)
            band = pink_wall_band(masks, thickness, W, H)
        else:
            # Render/CAD styles: the wall network IS the band; thickness comes
            # from the solid fill's distance transform.
            band = masks["wall_lines"]
            thickness = wall_thickness(band)
            runs, _ = extract_runs(band, W, H, thickness=thickness)
        building = building_box(band, W, H)
        walls = runs_to_walls(runs, thickness)
        doors, windows = infer_openings_pink(masks, runs, thickness, W, H)
        # Rooms: watershed against a barrier of the RUN centrelines — runs span
        # their door gaps, so every room reads as an enclosed cell.
        rooms = detect_rooms(img, runs_barrier(runs, thickness, W, H), W, H)
        confidence = score(len(walls), len(rooms), len(doors), building, W, H)
        if debug_path:
            draw_debug(img, band, walls, rooms, building, debug_path, doors, windows)
        return {
            "imageWidth": W,
            "imageHeight": H,
            "buildingBox": building,
            "wallThicknessPx": round(thickness, 1),
            "walls": walls,
            "doors": doors,
            "windows": windows,
            "rooms": rooms,
            "confidence": confidence,
            "style": masks["style"],
        }

    wmask, wmask_raw = wall_mask(img)
    building = building_box(wmask, W, H)
    thickness = wall_thickness(wmask)
    walls = detect_walls(wmask, W, H)
    rooms = detect_rooms(img, wmask, W, H)
    doors, windows = infer_openings(walls, wmask_raw, building, W, H)

    confidence = score(len(walls), len(rooms), len(doors), building, W, H)

    if debug_path:
        draw_debug(img, wmask, walls, rooms, building, debug_path, doors, windows)

    return {
        "imageWidth": W,
        "imageHeight": H,
        "buildingBox": building,
        "wallThicknessPx": round(thickness, 1),
        "walls": walls,
        "doors": doors,
        "windows": windows,
        "rooms": rooms,
        "confidence": confidence,
        "style": masks["style"],
    }


def score(n_walls, n_rooms, n_doors, building, W, H):
    wall = min(1.0, n_walls / 16)
    room = min(1.0, n_rooms / 8)
    cover = (building["w"] * building["h"]) / max(1, W * H)
    foot = 1.0 if 0.2 < cover < 0.98 else 0.3
    return round(0.4 * room + 0.3 * wall + 0.2 * foot + 0.1 * min(1.0, n_doors / 3), 2)


def draw_debug(img, wmask, walls, rooms, building, out_path, doors=None, windows=None):
    """Annotate the source image with detected geometry for visual QA."""
    vis = img.copy()
    vis[wmask > 0] = (0, 255, 255)  # tint detected walls
    b = building
    cv2.rectangle(vis, (b["x"], b["y"]), (b["x"] + b["w"], b["y"] + b["h"]), (255, 0, 0), 2)
    for r in rooms:
        cv2.rectangle(vis, (r["x"], r["y"]),
                      (r["x"] + r["w"], r["y"] + r["h"]), (0, 200, 0), 2)
    for w in walls:
        cv2.line(vis, (w["x1"], w["y1"]), (w["x2"], w["y2"]), (255, 0, 200), 1)
    for d in doors or []:
        cv2.circle(vis, (d["x"], d["y"]), 6, (0, 0, 255), 2)
    for w in windows or []:
        half = max(3, w.get("length", 8) // 2)
        if w["orientation"] == "h":
            cv2.rectangle(vis, (w["x"] - half, w["y"] - 3), (w["x"] + half, w["y"] + 3), (255, 120, 0), 2)
        else:
            cv2.rectangle(vis, (w["x"] - 3, w["y"] - half), (w["x"] + 3, w["y"] + half), (255, 120, 0), 2)
    cv2.imwrite(out_path, vis)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print(json.dumps({"error": "usage: parse_plan.py <image_path> [--debug <out.png>]"}))
        sys.exit(1)
    debug_path = None
    if "--debug" in sys.argv:
        i = sys.argv.index("--debug")
        if i + 1 < len(sys.argv):
            debug_path = sys.argv[i + 1]
    try:
        result = detect(args[0], debug_path)
        print(json.dumps(result))
    except Exception as e:  # noqa: BLE001 — surface any failure as JSON
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
