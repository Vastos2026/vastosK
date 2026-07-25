#!/usr/bin/env python3
"""
Label-anchored room detection.

The plain OpenCV detector (`parse_plan.py`) segments rooms from geometry
alone: it has no idea how many rooms exist or what they're called. This
detector reads the plan's PRINTED ROOM LABELS (and the printed DIMENSIONS
under them) with a local OCR engine, then anchors the geometric segmentation
to those labels. Rooms arrive named, typed, and — when the dimension text is
readable — sized in real feet, which also calibrates the whole plan's
feet-per-pixel scale with zero network calls.

For the "pink" CAD style the room segmentation is REGION-BASED on the wall
runs from parse_plan: every free-space region either holds a label (named
room), touches the sheet border (exterior), or is an anonymous void. Voids
that meet exactly ONE labeled room across a candidate wall are merged into it
and that wall is dropped — this is what erases kitchen counters and shelf
outlines (they never separate two real rooms) without losing genuinely
enclosed shafts (lift/ducts border several rooms and survive as anonymous
rooms).

Output is the SAME JSON contract as parse_plan.py plus, per room, "name",
"type" and (when printed dimensions were readable) "widthFt"/"heightFt", and
a top-level "scaleFtPerPx" when enough printed dimensions agree.

Usage:
    python detect_rooms_labeled.py <image_path> [--debug <out.png>]
"""

import difflib
import json
import os
import re
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from parse_plan import (  # noqa: E402
    _dbg,
    build_masks,
    building_box,
    detect_walls,
    extract_runs,
    infer_openings,
    infer_openings_pink,
    pink_wall_band,
    prepare,
    runs_barrier,
    runs_to_walls,
    wall_mask,
    wall_thickness,
)

# Words that mark a printed room label. Matched case-insensitively as
# substrings, then fuzzily, so OCR slips ("KTCHEN", "STAIRCAASE") register.
ROOM_KEYWORDS = (
    "living", "dining", "dinning", "kitchen", "bedroom", "bed room", "master",
    "stair", "staircase", "rest room", "restroom", "toilet", "bath", "wc",
    "wash", "balcony", "balcon", "shop", "hall", "lobby", "foyer", "pooja",
    "puja", "store", "utility", "office", "cabin", "study", "garage",
    "parking", "verandah", "veranda", "terrace", "lift", "dress", "corridor",
    "passage", "ots", "duct", "foyer",
    # generic + commercial labels ("SERVER ROOM", bank/office fit-outs) — these
    # plans label zones the residential list can't know, which silently dropped
    # their rooms (ATM/PANTRY/TELLER read fine in OCR but never became labels)
    "room", "pantry", "atm", "teller", "safe", "server", "reception",
    "waiting", "writing", "counter", "locker", "cubical", "cubicle", "loan",
    "ledge", "hkc",
)

# name -> coarse type, mirroring semantic.ts inferType so downstream colours/3D
# behave the same whether a room is named here or by Gemini.
TYPE_RULES = (
    (re.compile(r"bed|master|dress", re.I), "bedroom"),
    (re.compile(r"bath|toilet|wc|wash|rest", re.I), "bathroom"),
    (re.compile(r"kitchen|pantry", re.I), "kitchen"),
    (re.compile(r"living|lounge|drawing", re.I), "living"),
    (re.compile(r"dinn?ing", re.I), "dining"),
    (re.compile(r"hall|foyer|lobby|corridor|passage", re.I), "hall"),
    (re.compile(r"balcon|veranda|terrace", re.I), "balcony"),
    (re.compile(r"pooja|puja|temple|mandir", re.I), "pooja"),
    (re.compile(r"study|office|cabin|shop", re.I), "office"),
    (re.compile(r"utility|laundry", re.I), "utility"),
    (re.compile(r"store|storage|vault", re.I), "store"),
    (re.compile(r"garage|parking", re.I), "garage"),
    (re.compile(r"stair", re.I), "stair"),
    (re.compile(r"lift|elevator", re.I), "utility"),
)

_READER = None  # easyocr.Reader is expensive to build — make it once per process.


def infer_type(name: str) -> str:
    for rx, t in TYPE_RULES:
        if rx.search(name):
            return t
    return "other"


def _reader():
    global _READER
    import easyocr  # imported lazily so parse_plan-only runs don't pay for torch

    if _READER is None:
        _READER = easyocr.Reader(["en"], gpu=False, verbose=False)
    return _READER


# Sheet-title vocabulary — drawing captions ("TYPICAL FLOOR PLAN", "SITE CUM
# STILT FLOOR PLAN", "AREA STATEMENT") read like labels and fuzzy-matched room
# keywords ("stilt"≈"lift", "floor"≈"foyer"), minting phantom rooms.
_TITLE_RE = re.compile(
    r"\b(plan|elevation|section|schedule|statement|detail|drawing|option|scale|sheet"
    r"|site|typical|stilt|cum|ground|first|second|third|fourth|fifth)\b",
    re.I,
)


def _match_keyword(text: str) -> bool:
    low = re.sub(r"[^a-z& ]", "", text.lower())
    if len(low.strip()) < 3:
        return False
    if _TITLE_RE.search(low):
        return False
    if any(k in low for k in ROOM_KEYWORDS):
        return True
    # Fuzzy per-word match absorbs OCR slips (KTCHEN, BLCOVY, 2TRCA3E).
    # Short keywords (ATM/WC/OTS/HKC) are exact-only — fuzzying against them
    # turned unrelated words into labels ("FLAT" scored 0.57 against "atm").
    for word in low.split():
        if len(word) < 4:
            continue
        for k in ROOM_KEYWORDS:
            if len(k) <= 3:
                continue
            if difflib.SequenceMatcher(None, word, k).ratio() >= 0.55:
                return True
    return False


# ---------------------------------------------------------------------------
# Printed dimensions — "8'11"x13'6"", "9' x 15'5"", "12'3"x9'1""
# ---------------------------------------------------------------------------

_DIM_SEP = re.compile(r"[×*✕]|[xX](?=[\s\d])")
# Feet-inches with optional dash: 13'6", 10'-0", 9' 4"
_DIM_PART = re.compile(r"(\d{1,2})\s*'\s*-?\s*(\d{1,2})?\s*\"?")


def _norm_dim_text(t: str) -> str:
    t = t.replace("’", "'").replace("`", "'").replace("′", "'")
    t = t.replace("”", '"').replace("″", '"').replace("''", '"')
    return _DIM_SEP.sub("x", t)


def _part_to_ft(m) -> float:
    ft = int(m.group(1))
    inch = int(m.group(2)) if m.group(2) else 0
    if inch >= 12:  # OCR merged digits: "155" as 15'5" comes pre-split, so
        inch = 0    # a real >=12 here means the quote mark was noise
    return round(ft + inch / 12.0, 2)


# Decimal feet: "2.8", "10.3 ft" (some plans print decimals, not feet-inches)
_DIM_DECIMAL = re.compile(r"(\d{1,2})[.,](\d{1,2})")


def parse_dim(text: str):
    """Parse a printed WxH dimension into (widthFt, heightFt); None if the
    text isn't a clean two-part feet(-inches) pair."""
    t = _norm_dim_text(text)
    if "x" not in t:
        return None
    left, _, right = t.partition("x")
    parts = []
    for side in (left, right):
        side = side.strip()
        m = _DIM_PART.search(side)
        if m and "'" in side:
            parts.append(_part_to_ft(m))
            continue
        # DECIMAL feet ("2.8 x 5 ft" style plans). Must run before the digit
        # squash below, which read "2.8" as 28 ft and "10.3" as 10'3".
        dm = _DIM_DECIMAL.search(side)
        if dm:
            parts.append(round(float(f"{dm.group(1)}.{dm.group(2)}"), 2))
            continue
        # No explicit foot mark — accept bare digits like "155" => 15'5" when
        # a plain feet reading would be absurd for a room.
        digits = re.sub(r"\D", "", side)
        if not digits:
            return None
        n = int(digits)
        if 1 <= n <= 40:
            parts.append(float(n))
        elif 41 <= n <= 409 and n % 10 <= 9:  # "155" -> 15'5"
            ft, inch = divmod(n, 10)
            if inch >= 12 or ft > 40:
                return None
            parts.append(round(ft + inch / 12.0, 2))
        else:
            return None
    if len(parts) != 2 or min(parts) < 1 or max(parts) > 60:
        return None
    return parts[0], parts[1]


# ---------------------------------------------------------------------------
# OCR — labels + dimensions off the sheet
# ---------------------------------------------------------------------------

def read_labels(full_img, coord_scale=1.0):
    """OCR the sheet and return room labels [{name,type,cx,cy,wFt?,hFt?}] in
    WORKING-image coordinates.

    Two passes both run at an upscale chosen from the sheet size:
      1. the raw image (colour text on plan)
      2. the isolated red-text mask (text minus wall strokes), binarized —
         much cleaner for the small red annotations this style uses.
    Dimension tokens are parsed and attached to the nearest label above.
    """
    reader = _reader()
    H0 = full_img.shape[0]
    up = 4 if H0 < 900 else (2 if H0 < 1800 else 1)

    tokens = []  # (text, cx, cy, conf) in full-image coords

    def collect(image, scale):
        for box, text, conf in reader.readtext(image, detail=1, paragraph=False):
            if conf < 0.15 or not text.strip():
                continue
            xs = [p[0] for p in box]
            ys = [p[1] for p in box]
            tokens.append((text.strip(), sum(xs) / 4 / scale, sum(ys) / 4 / scale, conf))

    if up > 1:
        big = cv2.resize(full_img, None, fx=up, fy=up, interpolation=cv2.INTER_CUBIC)
        collect(big, up)
    else:
        collect(full_img, 1)

    # Pass 2: binarized red-text canvas (pink style's labels are red).
    masks = build_masks(full_img)
    if masks["style"] == "pink":
        walls = cv2.dilate(masks["wall_lines"], cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)))
        text_mask = cv2.bitwise_and(masks["red"], cv2.bitwise_not(walls))
        canvas = np.full(text_mask.shape, 255, np.uint8)
        canvas[text_mask > 0] = 0
        big = cv2.resize(canvas, None, fx=up, fy=up, interpolation=cv2.INTER_CUBIC)
        big = cv2.GaussianBlur(big, (3, 3), 0)
        collect(big, up)

    labels = []
    dims = []
    for text, cx, cy, conf in tokens:
        if _match_keyword(text):
            labels.append({
                "name": clean_name(text),
                "cx": int(cx * coord_scale),
                "cy": int(cy * coord_scale),
                "conf": conf,
            })
        else:
            d = parse_dim(text)
            if d:
                dims.append({"wFt": d[0], "hFt": d[1],
                             "cx": int(cx * coord_scale), "cy": int(cy * coord_scale)})

    labels = merge_split_labels(dedupe_labels(labels))
    _dbg(f"[labels] {[(l['name'], l['cx'], l['cy']) for l in labels]}")
    _dbg(f"[dims] {dims}")

    # Attach each dimension to the nearest label ABOVE it (labels sit directly
    # over their dimension line in this style).
    for d in dims:
        best = None
        for lab in labels:
            dy = d["cy"] - lab["cy"]
            dx = abs(d["cx"] - lab["cx"])
            if 0 <= dy <= 60 and dx <= 80:
                score = dy + dx
                if best is None or score < best[1]:
                    best = (lab, score)
        if best and "wFt" not in best[0]:
            best[0]["wFt"] = d["wFt"]
            best[0]["hFt"] = d["hFt"]
    return labels


def clean_name(t: str) -> str:
    """Tidy an OCR'd label into a presentable room name."""
    t = re.sub(r"[^A-Za-z& ]", " ", t)
    t = re.sub(r"\s+", " ", t).strip().title()
    # Snap fuzzy words onto their canonical keyword so "Ktchen" renders
    # "Kitchen", "Uvino" renders "Living" and "Trca" renders "Stair". A word
    # that already IS a keyword stays put verbatim — that's what stops correct
    # words being rewritten ("Room" scored 0.73 against "bedroom", which used
    # to rename "SERVER ROOM" to "Server Bedroom"; "room" is a keyword now).
    words = []
    for w in t.split(" "):
        if w.lower() in ROOM_KEYWORDS:
            words.append(w)
            continue
        best, score = w, 0.0
        for k in ROOM_KEYWORDS:
            r = difflib.SequenceMatcher(None, w.lower(), k).ratio()
            if r > score:
                best, score = k.title(), r
        words.append(best if score >= 0.55 else w)
    t = " ".join(words)
    # Drop stray single-character words OCR fabricates from stroke noise.
    t = " ".join(w for w in t.split(" ") if len(w) > 1 or w == "&")
    return t.replace("Dinning", "Dining")


def merge_split_labels(labels):
    """Join labels OCR split across lines ("LIVING" + "& DINING") when their
    centres are close, so a single room doesn't get two seeds. The radii are
    TIGHT — a split label's parts sit within a couple of text-heights of each
    other, while two different rooms' labels (Bath next to Bedroom on a dense
    multi-unit sheet) are at least half a room apart."""
    out = []
    used = [False] * len(labels)
    for i, a in enumerate(labels):
        if used[i]:
            continue
        for j in range(i + 1, len(labels)):
            if used[j]:
                continue
            b = labels[j]
            if abs(a["cx"] - b["cx"]) < 45 and abs(a["cy"] - b["cy"]) < 26:
                a = {
                    "name": f"{a['name']} & {b['name']}",
                    "cx": (a["cx"] + b["cx"]) // 2,
                    "cy": (a["cy"] + b["cy"]) // 2,
                    "conf": max(a.get("conf", 0), b.get("conf", 0)),
                }
                used[j] = True
        used[i] = True
        out.append(a)
    return out


def labels_inside(labels, building):
    """Drop labels outside the detected building footprint — the TITLE BLOCK
    below a sheet ("Typical Floor Plan", architect names) would otherwise seed
    phantom rooms."""
    pad = 15
    x0 = building["x"] - pad
    y0 = building["y"] - pad
    x1 = building["x"] + building["w"] + pad
    y1 = building["y"] + building["h"] + pad
    return [l for l in labels if x0 <= l["cx"] <= x1 and y0 <= l["cy"] <= y1]


def dedupe_labels(labels):
    """Both OCR passes see the same text — keep the higher-confidence copy."""
    out = []
    for lab in sorted(labels, key=lambda l: -l.get("conf", 0)):
        if any(abs(lab["cx"] - o["cx"]) < 25 and abs(lab["cy"] - o["cy"]) < 15 for o in out):
            continue
        out.append(lab)
    return out


# ---------------------------------------------------------------------------
# Pink style: region segmentation on the wall runs + label anchoring
# ---------------------------------------------------------------------------

def segment_pink(img, masks, runs, thickness, labels, W, H):
    """Anchor free-space regions to labels; merge label-less voids into their
    single labeled neighbour (dropping the furniture 'wall' between); return
    (rooms, pruned_runs).
    """
    # Smallest area that still counts as a room. Relative to the sheet, with an
    # absolute floor: on a high-res multi-unit sheet a 4'×7' bath is a tiny
    # fraction of the total area but very much a room.
    min_room = max(500, 0.0008 * W * H)

    def regions_of(current_runs):
        barrier = runs_barrier(current_runs, thickness, W, H)
        free = np.where(barrier > 0, 0, 255).astype(np.uint8)
        n, comp = cv2.connectedComponents(free, connectivity=4)
        return barrier, comp, n

    def side_samples(s, horizontal, comp):
        d = (s["cmax"] - s["cmin"]) // 2 + max(4, int(thickness / 2) + 2)
        a_ids, b_ids = [], []
        for k in range(1, 8):
            a = s["a0"] + (s["a1"] - s["a0"]) * k // 8
            if horizontal:
                pa, pb = (a, s["c"] - d), (a, s["c"] + d)
            else:
                pa, pb = (s["c"] - d, a), (s["c"] + d, a)
            for (x, y), ids in ((pa, a_ids), (pb, b_ids)):
                if 0 <= x < W and 0 <= y < H and comp[y, x] > 0:
                    ids.append(int(comp[y, x]))
        mode = lambda ids: max(set(ids), key=ids.count) if ids else 0
        return mode(a_ids), mode(b_ids)

    def has_window(s, horizontal):
        """True when a black window rectangle sits ON this run — furniture
        outlines never carry window symbols, so such a run is a REAL wall and
        must never be pruned (nor merged across)."""
        need = max(5, int(1.2 * thickness))
        d = (s["cmax"] - s["cmin"]) // 2 + 3
        run_len = 0
        for a in range(s["a0"], s["a1"] + 1):
            if horizontal:
                x0, x1 = a, a + 1
                y0, y1 = s["c"] - d, s["c"] + d + 1
            else:
                x0, x1 = s["c"] - d, s["c"] + d + 1
                y0, y1 = a, a + 1
            x0, y0 = max(0, x0), max(0, y0)
            x1, y1 = min(W, x1), min(H, y1)
            hit = x1 > x0 and y1 > y0 and cv2.countNonZero(masks["black"][y0:y1, x0:x1]) > 0
            run_len = run_len + 1 if hit else 0
            if run_len >= need:
                return True
        return False

    runs = {"h": [dict(s) for s in runs["h"]], "v": [dict(s) for s in runs["v"]]}

    for _pass in range(3):
        barrier, comp, n = regions_of(runs)

        # Classify regions: which hold a label seed / touch the border.
        label_of = {}
        for lab in labels:
            x = min(W - 1, max(0, lab["cx"]))
            y = min(H - 1, max(0, lab["cy"]))
            cid = int(comp[y, x])
            if cid == 0:  # label sits ON a wall stroke — nudge around
                for r in range(3, 24, 3):
                    ys, xs = np.where(comp[max(0, y - r):y + r + 1, max(0, x - r):x + r + 1] > 0)
                    if xs.size:
                        cid = int(comp[max(0, y - r) + ys[0], max(0, x - r) + xs[0]])
                        break
            if cid > 0 and cid not in label_of:
                label_of[cid] = lab
        border_ids = set(np.unique(np.concatenate([
            comp[0, :], comp[-1, :], comp[:, 0], comp[:, -1]]))) - {0}

        sizes = {cid: int((comp == cid).sum()) for cid in range(1, n)}

        # Find furniture runs: both sides in the SAME region, or separating a
        # labeled room from a label-less void that borders ONLY that room.
        void_neighbours = {}
        run_sides = []
        for horizontal in (True, False):
            for s in (runs["h"] if horizontal else runs["v"]):
                a, b = side_samples(s, horizontal, comp)
                # A run bearing a WINDOW rectangle is a real wall and can't be
                # pruned — furniture outlines never carry window symbols. Face
                # count is NOT evidence: counters are drawn as face pairs too.
                real = has_window(s, horizontal)
                run_sides.append((s, horizontal, a, b, real))
                if real:
                    continue
                for v, o in ((a, b), (b, a)):
                    if v > 0 and v not in label_of and v not in border_ids and o > 0:
                        void_neighbours.setdefault(v, set()).add(o)

        merges = {}
        for v, neigh in void_neighbours.items():
            neigh = neigh - {v} - border_ids
            labeled_neigh = {x for x in neigh if x in label_of}
            void_neigh = neigh - labeled_neigh
            # Merge ONLY the unambiguous case: the void borders exactly one
            # labeled room and no other interior space — i.e. it's a slice of
            # that room cut off by a furniture outline. A lift shaft or the
            # lower stair flight borders several regions and stays a room.
            if len(labeled_neigh) == 1 and not void_neigh:
                merges[v] = next(iter(labeled_neigh))

        if not merges:
            break
        keep_h, keep_v = [], []
        dropped = 0
        for s, horizontal, a, b, real in run_sides:
            ra = merges.get(a, a)
            rb = merges.get(b, b)
            if not real and ra == rb and ra != 0:
                dropped += 1
                _dbg(f"[prune] furniture run {'h' if horizontal else 'v'} c={s['c']} "
                     f"span {s['a0']}..{s['a1']} (sides {a}/{b} → {ra})")
                continue
            (keep_h if horizontal else keep_v).append(s)
        runs = {"h": keep_h, "v": keep_v}
        if not dropped:
            break

    # Final regions → rooms. A label-seeded WATERSHED grows one room per label
    # (splitting open-plan components where two labels share free space, e.g.
    # kitchen/living across a counter passage); enclosed components without a
    # label (lift and service shafts) are appended as anonymous rooms so the
    # geometry stays complete.
    barrier, comp, n = regions_of(runs)
    free = np.where(barrier > 0, 0, 255).astype(np.uint8)

    markers = np.zeros((H, W), np.int32)
    markers[barrier > 0] = 1
    markers[0, :] = markers[-1, :] = markers[:, 0] = markers[:, -1] = 1

    seed_r = max(3, int(round(min(W, H) * 0.006)))
    placed = []
    mid = 2
    for lab in labels:
        pt = nearest_free(free, lab["cx"], lab["cy"])
        if pt is None:
            continue
        disk = np.zeros((H, W), np.uint8)
        cv2.circle(disk, pt, seed_r, 255, -1)
        markers[(disk > 0) & (free > 0)] = mid
        placed.append((mid, lab))
        mid += 1

    labeled_comp_ids = set()
    for _, lab in placed:
        x = min(W - 1, max(0, lab["cx"]))
        y = min(H - 1, max(0, lab["cy"]))
        if comp[y, x] > 0:
            labeled_comp_ids.add(int(comp[y, x]))

    pad = int(thickness / 2) + 1
    rooms = []
    if placed:
        cv2.watershed(img, markers)
        for marker_id, lab in placed:
            ys, xs = np.where(markers == marker_id)
            if xs.size < min_room:
                continue
            x0, x1 = int(xs.min()), int(xs.max())
            y0, y1 = int(ys.min()), int(ys.max())
            x0, y0 = max(0, x0 - pad), max(0, y0 - pad)
            x1, y1 = min(W - 1, x1 + pad), min(H - 1, y1 + pad)
            room = {"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0,
                    "name": lab["name"], "type": infer_type(lab["name"])}
            if lab.get("wFt"):
                room["widthFt"] = lab["wFt"]
                room["heightFt"] = lab["hFt"]
            rooms.append(room)

    border_ids = set(np.unique(np.concatenate([
        comp[0, :], comp[-1, :], comp[:, 0], comp[:, -1]]))) - {0}
    for cid in range(1, n):
        if cid in border_ids or cid in labeled_comp_ids:
            continue
        ys, xs = np.where(comp == cid)
        if xs.size < min_room:
            continue
        x0, x1 = int(xs.min()), int(xs.max())
        y0, y1 = int(ys.min()), int(ys.max())
        x0, y0 = max(0, x0 - pad), max(0, y0 - pad)
        x1, y1 = min(W - 1, x1 + pad), min(H - 1, y1 + pad)
        rooms.append({"x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0})
    return rooms, runs


def resolve_scale(rooms):
    """Feet-per-pixel from printed dimensions vs detected boxes: the MEDIAN of
    per-room ratios, emitted only when several ratios agree (guards against a
    single garbled dimension poisoning the scale)."""
    ratios = []
    for r in rooms:
        if not r.get("widthFt") or r["w"] < 8 or r["h"] < 8:
            continue
        w, h = r["widthFt"], r["heightFt"]
        # The printed pair may be transposed vs the drawn box — use the
        # orientation that best matches the box's aspect.
        if (r["w"] >= r["h"]) != (w >= h):
            w, h = h, w
        ratios.append(w / r["w"])
        ratios.append(h / r["h"])
    if len(ratios) < 4:
        return None
    med = float(np.median(ratios))
    dev = float(np.median([abs(x - med) for x in ratios]))
    if med <= 0 or dev / med > 0.25:
        return None
    return round(med, 5)


def score(n_rooms, n_labels, building, W, H):
    """Confidence = how well rooms grew, gated by label coverage."""
    if n_labels == 0:
        return 0.0
    grown = min(1.0, n_rooms / max(1, n_labels))
    cover = (building["w"] * building["h"]) / max(1, W * H)
    foot = 1.0 if 0.15 < cover < 0.99 else 0.4
    return round(0.7 * grown + 0.3 * foot, 2)


# ---------------------------------------------------------------------------
# Legacy styles (yellow fill / ink) — original watershed flow
# ---------------------------------------------------------------------------

def wall_barrier(walls, thickness_px, W, H):
    """A clean room-dividing barrier drawn from the DETECTED WALL LINES."""
    barrier = np.zeros((H, W), np.uint8)
    t = int(max(3, min(9, round(thickness_px or 4))))
    for w in walls:
        cv2.line(barrier, (w["x1"], w["y1"]), (w["x2"], w["y2"]), 255, t)
    return barrier


def nearest_free(free, x, y):
    """Snap a seed point to the closest free pixel if the label sits on a wall /
    text stroke / hatch. Returns None if no free pixel is within a sane radius."""
    H, W = free.shape
    x = max(0, min(W - 1, x))
    y = max(0, min(H - 1, y))
    if free[y, x] > 0:
        return x, y
    for r in range(4, 60, 4):
        x0, x1 = max(0, x - r), min(W, x + r + 1)
        y0, y1 = max(0, y - r), min(H, y + r + 1)
        ys, xs = np.where(free[y0:y1, x0:x1] > 0)
        if xs.size:
            k = np.argmin((xs + x0 - x) ** 2 + (ys + y0 - y) ** 2)
            return int(xs[k] + x0), int(ys[k] + y0)
    return None


def segment_rooms_legacy(img, walls, thickness_px, labels, W, H):
    """Marker-controlled watershed growing one room per label (legacy styles)."""
    barrier = wall_barrier(walls, thickness_px, W, H)
    free = np.where(barrier > 0, 0, 255).astype(np.uint8)

    markers = np.zeros((H, W), np.int32)
    markers[barrier > 0] = 1
    markers[0, :] = markers[-1, :] = markers[:, 0] = markers[:, -1] = 1

    seed_r = max(3, int(round(min(W, H) * 0.006)))
    placed = []
    mid = 2
    for lab in labels:
        pt = nearest_free(free, lab["cx"], lab["cy"])
        if pt is None:
            continue
        disk = np.zeros((H, W), np.uint8)
        cv2.circle(disk, pt, seed_r, 255, -1)
        markers[(disk > 0) & (free > 0)] = mid
        placed.append((mid, lab))
        mid += 1

    if not placed:
        return []

    cv2.watershed(img, markers)

    img_area = W * H
    rooms = []
    for marker_id, lab in placed:
        ys, xs = np.where(markers == marker_id)
        if xs.size < img_area * 0.0008:
            continue
        x, y = int(xs.min()), int(ys.min())
        w, h = int(xs.max() - x), int(ys.max() - y)
        room = {"x": x, "y": y, "w": w, "h": h,
                "name": lab["name"], "type": infer_type(lab["name"])}
        if lab.get("wFt"):
            room["widthFt"] = lab["wFt"]
            room["heightFt"] = lab["hFt"]
        rooms.append(room)
    return rooms


# ---------------------------------------------------------------------------
# Entry
# ---------------------------------------------------------------------------

def detect(image_path: str, debug_path: str | None = None) -> dict:
    img = cv2.imread(image_path)
    if img is None:
        raise ValueError(f"Could not read image: {image_path}")

    full = img
    img, masks, coord_scale = prepare(img)
    H, W = img.shape[:2]

    labels = read_labels(full, coord_scale)

    if masks["style"] in ("pink", "render", "cad"):
        if masks["style"] == "pink":
            runs, thickness = extract_runs(masks["wall_lines"], W, H)
            band = pink_wall_band(masks, thickness, W, H)
        else:
            band = masks["wall_lines"]  # render/cad: the solid wall network
            thickness = wall_thickness(band)
            runs, _ = extract_runs(band, W, H, thickness=thickness)
        building = building_box(band, W, H)
        labels = labels_inside(labels, building)
        rooms, runs = segment_pink(img, masks, runs, thickness, labels, W, H)
        doors, windows = infer_openings_pink(masks, runs, thickness, W, H)
        walls = runs_to_walls(runs, thickness)
        result = {
            "imageWidth": W,
            "imageHeight": H,
            "buildingBox": building,
            "wallThicknessPx": round(thickness, 1),
            "walls": walls,
            "doors": doors,
            "windows": windows,
            "rooms": rooms,
            "confidence": score(len(rooms), len(labels), building, W, H),
            "source": "labeled",
            "style": masks["style"],
        }
    else:
        wmask, wmask_raw = wall_mask(img)
        building = building_box(wmask, W, H)
        labels = labels_inside(labels, building)
        thickness = wall_thickness(wmask)
        walls = detect_walls(wmask, W, H)
        rooms = segment_rooms_legacy(img, walls, thickness, labels, W, H)
        doors, windows = infer_openings(walls, wmask_raw, building, W, H)
        result = {
            "imageWidth": W,
            "imageHeight": H,
            "buildingBox": building,
            "wallThicknessPx": round(thickness, 1),
            "walls": walls,
            "doors": doors,
            "windows": windows,
            "rooms": rooms,
            "confidence": score(len(rooms), len(labels), building, W, H),
            "source": "labeled",
            "style": masks["style"],
        }

    scale = resolve_scale(result["rooms"])
    if scale:
        result["scaleFtPerPx"] = scale
        bb = result["buildingBox"]
        result["overallWidthFt"] = round(bb["w"] * scale, 1)
        result["overallHeightFt"] = round(bb["h"] * scale, 1)

    if debug_path:
        draw_debug(img, result, debug_path)
    return result


def draw_debug(img, result, out_path):
    vis = img.copy()
    b = result["buildingBox"]
    cv2.rectangle(vis, (b["x"], b["y"]), (b["x"] + b["w"], b["y"] + b["h"]), (255, 0, 0), 2)
    for w in result["walls"]:
        cv2.line(vis, (w["x1"], w["y1"]), (w["x2"], w["y2"]), (255, 0, 200), 1)
    for r in result["rooms"]:
        cv2.rectangle(vis, (r["x"], r["y"]), (r["x"] + r["w"], r["y"] + r["h"]), (0, 180, 0), 2)
        tag = r.get("name", "?")
        if r.get("widthFt"):
            tag += f" {r['widthFt']}x{r['heightFt']}"
        cv2.putText(vis, tag, (r["x"] + 3, r["y"] + 14),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.38, (0, 0, 220), 1)
    for d in result["doors"]:
        cv2.circle(vis, (d["x"], d["y"]), 6, (0, 0, 255), 2)
    for w in result["windows"]:
        half = max(3, w.get("length", 8) // 2)
        if w["orientation"] == "h":
            cv2.rectangle(vis, (w["x"] - half, w["y"] - 3), (w["x"] + half, w["y"] + 3), (255, 120, 0), 2)
        else:
            cv2.rectangle(vis, (w["x"] - 3, w["y"] - half), (w["x"] + 3, w["y"] + half), (255, 120, 0), 2)
    cv2.imwrite(out_path, vis)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print(json.dumps({"error": "usage: detect_rooms_labeled.py <image_path> [--debug <out.png>]"}))
        sys.exit(1)
    debug_path = None
    if "--debug" in sys.argv:
        i = sys.argv.index("--debug")
        if i + 1 < len(sys.argv):
            debug_path = sys.argv[i + 1]
    try:
        print(json.dumps(detect(args[0], debug_path)))
    except Exception as e:  # noqa: BLE001 — surface any failure as JSON
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
