#!/usr/bin/env python3
"""
build_toolpath.py -- normalize machine toolpaths into a compact binary .tpath file.

Reads FDM slicer G-code, CNC G-code, or robot arm programs (KUKA KRL, ABB RAPID,
Universal Robots script) and emits a single quantized binary blob that a browser
can fetch and render without any parsing work.

Size reduction is very geometry-dependent, measured against gzipped source:
  - straight-run-heavy paths (normal infill, most real prints):  40-600x
  - curve-heavy organic paths (spiral vase, sculpture):          ~2x
The size win varies. The parse win does not: the browser gets typed arrays it
can hand straight to the GPU instead of megabytes of ASCII to tokenize, which
is what actually keeps a mid-range phone responsive.

Usage:
    python3 build_toolpath.py model.gcode -o ../web/data/model.tpath
    python3 build_toolpath.py arm.src --layer-mode zband --band 5.0 -o ../web/data/arm.tpath
    python3 build_toolpath.py a.gcode b.src --manifest ../web/data/manifest.json --id vase

Format spec lives in FORMAT.md.
"""

import argparse
import gzip
import json
import math
import os
import re
import struct
import sys
from pathlib import Path

MAGIC = b"TPTH"
VERSION = 1

KIND_TRAVEL = 0   # non-cutting / non-extruding repositioning (G0, PTP, movej)
KIND_EXTRUDE = 1  # material deposition (G1 with +E)
KIND_WORK = 2     # linear work move without extrusion (CNC cut, robot LIN)

# Arc moves get flattened into this many mm of chord length before we add a point.
ARC_CHORD_MM = 0.4


# --------------------------------------------------------------------------
# Toolpath container
# --------------------------------------------------------------------------

class Toolpath:
    """A continuous polyline of machine positions plus per-segment kinds."""

    def __init__(self, name=""):
        self.name = name
        self.pts = []          # flat [x0,y0,z0, x1,y1,z1, ...]
        self.kinds = []        # len == len(pts)//3 - 1
        self.layer_starts = [] # point indices where a new layer begins
        self.layer_z = []

    def n_points(self):
        return len(self.pts) // 3

    def add(self, x, y, z, kind):
        """Append a point. The segment from the previous point carries `kind`."""
        if self.pts:
            px, py, pz = self.pts[-3], self.pts[-2], self.pts[-1]
            # Drop zero-length moves; they add bytes and no pixels.
            if abs(px - x) < 1e-9 and abs(py - y) < 1e-9 and abs(pz - z) < 1e-9:
                return
            self.kinds.append(kind)
        self.pts.extend((x, y, z))

    def mark_layer(self, z):
        idx = self.n_points()
        if self.layer_starts and self.layer_starts[-1] == idx:
            self.layer_z[-1] = z
            return
        self.layer_starts.append(idx)
        self.layer_z.append(z)

    def bbox(self):
        if not self.pts:
            return (0, 0, 0, 0, 0, 0)
        xs = self.pts[0::3]
        ys = self.pts[1::3]
        zs = self.pts[2::3]
        return (min(xs), min(ys), min(zs), max(xs), max(ys), max(zs))


# --------------------------------------------------------------------------
# G-code parsing (FDM slicers + CNC)
# --------------------------------------------------------------------------

WORD_RE = re.compile(r"([A-Za-z])\s*(-?\d*\.?\d+(?:[eE][-+]?\d+)?)")

LAYER_COMMENT_RE = re.compile(
    r";\s*(?:LAYER:|LAYER_CHANGE|CHANGE_LAYER|layer\s+\d+|AFTER_LAYER_CHANGE)",
    re.IGNORECASE,
)


def strip_comment(line):
    """Return (code_part, comment_part). Handles ';' and '(...)' comment styles."""
    semi = line.find(";")
    if semi >= 0:
        code, comment = line[:semi], line[semi:]
    else:
        code, comment = line, ""
    code = re.sub(r"\([^)]*\)", " ", code)  # CNC-style parenthetical comments
    return code, comment


def parse_gcode(path, layer_mode="auto"):
    tp = Toolpath(name=Path(path).stem)

    x = y = z = None
    e = 0.0
    abs_pos = True      # G90 / G91
    abs_e = True        # M82 / M83
    unit_scale = 1.0    # G20 inches -> 25.4
    cur_layer_z = None
    pending_layer_comment = False
    saw_any_layer = False

    def flush_layer(zz):
        nonlocal saw_any_layer
        tp.mark_layer(zz)
        saw_any_layer = True

    with open(path, "r", errors="ignore") as fh:
        for raw in fh:
            code, comment = strip_comment(raw)

            if comment and LAYER_COMMENT_RE.search(comment):
                pending_layer_comment = True

            code = code.strip()
            if not code:
                continue

            words = WORD_RE.findall(code)
            if not words:
                continue

            letter, num = words[0][0].upper(), words[0][1]
            try:
                gnum = int(float(num))
            except ValueError:
                continue

            params = {}
            for l, v in words[1:]:
                try:
                    params[l.upper()] = float(v)
                except ValueError:
                    pass

            if letter == "G":
                if gnum == 20:
                    unit_scale = 25.4
                    continue
                if gnum == 21:
                    unit_scale = 1.0
                    continue
                if gnum == 90:
                    abs_pos = True
                    continue
                if gnum == 91:
                    abs_pos = False
                    continue
                if gnum == 92:
                    if "X" in params: x = params["X"] * unit_scale
                    if "Y" in params: y = params["Y"] * unit_scale
                    if "Z" in params: z = params["Z"] * unit_scale
                    if "E" in params: e = params["E"]
                    continue
                if gnum == 28:
                    # Home. Anything unmentioned homes too when no axes are given.
                    axes = [a for a in ("X", "Y", "Z") if a in params] or ["X", "Y", "Z"]
                    if "X" in axes: x = 0.0
                    if "Y" in axes: y = 0.0
                    if "Z" in axes: z = 0.0
                    continue

                if gnum in (0, 1, 2, 3):
                    nx = params.get("X")
                    ny = params.get("Y")
                    nz = params.get("Z")
                    ne = params.get("E")

                    if nx is not None: nx *= unit_scale
                    if ny is not None: ny *= unit_scale
                    if nz is not None: nz *= unit_scale

                    if abs_pos:
                        tx = nx if nx is not None else x
                        ty = ny if ny is not None else y
                        tz = nz if nz is not None else z
                    else:
                        tx = (x or 0.0) + (nx or 0.0)
                        ty = (y or 0.0) + (ny or 0.0)
                        tz = (z or 0.0) + (nz or 0.0)

                    # Extrusion delta decides travel vs. deposition.
                    de = 0.0
                    if ne is not None:
                        de = (ne - e) if abs_e else ne
                        e = ne if abs_e else e + ne

                    if gnum == 0:
                        kind = KIND_TRAVEL
                    elif de > 1e-9:
                        kind = KIND_EXTRUDE
                    elif ne is None:
                        # No E word at all anywhere -> almost certainly CNC/laser.
                        kind = KIND_WORK
                    else:
                        kind = KIND_TRAVEL

                    if tx is None or ty is None or tz is None:
                        x, y, z = tx, ty, tz
                        continue

                    # Layer bookkeeping before we emit the geometry.
                    if layer_mode in ("auto", "comment") and pending_layer_comment:
                        flush_layer(tz)
                        pending_layer_comment = False
                        cur_layer_z = tz
                    elif layer_mode in ("auto", "z"):
                        if kind == KIND_EXTRUDE and (cur_layer_z is None or tz > cur_layer_z + 1e-6):
                            if not (layer_mode == "auto" and saw_any_layer):
                                flush_layer(tz)
                            cur_layer_z = tz

                    if gnum in (2, 3) and x is not None and y is not None:
                        for (ax, ay, az) in arc_points(x, y, z, tx, ty, tz, params,
                                                      unit_scale, clockwise=(gnum == 2)):
                            tp.add(ax, ay, az, kind)
                    else:
                        tp.add(tx, ty, tz, kind)

                    x, y, z = tx, ty, tz
                    continue

            elif letter == "M":
                if gnum == 82:
                    abs_e = True
                elif gnum == 83:
                    abs_e = False

    finalize_layers(tp, layer_mode)
    return tp


def arc_points(x0, y0, z0, x1, y1, z1, params, unit_scale, clockwise):
    """Flatten G2/G3 into line segments. Supports I/J center and R radius forms."""
    if "I" in params or "J" in params:
        cx = x0 + params.get("I", 0.0) * unit_scale
        cy = y0 + params.get("J", 0.0) * unit_scale
    elif "R" in params:
        r = params["R"] * unit_scale
        dx, dy = x1 - x0, y1 - y0
        d = math.hypot(dx, dy)
        if d < 1e-9 or abs(r) < d / 2:
            return [(x1, y1, z1)]
        h = math.sqrt(max(r * r - (d / 2) ** 2, 0.0))
        mx, my = (x0 + x1) / 2, (y0 + y1) / 2
        sign = 1 if (r > 0) != clockwise else -1
        cx = mx + sign * h * (-dy / d)
        cy = my + sign * h * (dx / d)
    else:
        return [(x1, y1, z1)]

    r0 = math.hypot(x0 - cx, y0 - cy)
    a0 = math.atan2(y0 - cy, x0 - cx)
    a1 = math.atan2(y1 - cy, x1 - cx)

    if clockwise:
        while a1 >= a0:
            a1 -= 2 * math.pi
    else:
        while a1 <= a0:
            a1 += 2 * math.pi

    sweep = abs(a1 - a0)
    arc_len = sweep * r0
    steps = max(2, min(512, int(arc_len / ARC_CHORD_MM) + 1))

    out = []
    for i in range(1, steps + 1):
        t = i / steps
        a = a0 + (a1 - a0) * t
        out.append((cx + r0 * math.cos(a), cy + r0 * math.sin(a), z0 + (z1 - z0) * t))
    return out


def finalize_layers(tp, layer_mode):
    """Guarantee at least one layer and that layer 0 starts at point 0."""
    if not tp.layer_starts:
        tp.layer_starts = [0]
        tp.layer_z = [tp.pts[2] if tp.pts else 0.0]
    if tp.layer_starts[0] != 0:
        tp.layer_starts.insert(0, 0)
        tp.layer_z.insert(0, tp.pts[2] if tp.pts else 0.0)


# --------------------------------------------------------------------------
# Robot arm program parsing
# --------------------------------------------------------------------------

# KUKA KRL:   LIN {X 100, Y 20, Z 5} C_DIS   /  PTP {X ...}
KRL_RE = re.compile(
    r"^\s*(LIN|PTP|LIN_REL|PTP_REL|CIRC)\b(.*)$", re.IGNORECASE)
KRL_XYZ_RE = re.compile(r"\b([XYZ])\s+(-?\d*\.?\d+)", re.IGNORECASE)

# ABB RAPID:  MoveL [[100,20,5],[1,0,0,0]],v100,z10,tool0;
RAPID_RE = re.compile(
    r"^\s*(MoveL|MoveJ|MoveAbsJ|MoveC)\b(.*)$", re.IGNORECASE)
RAPID_POS_RE = re.compile(r"\[\s*\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]")

# Universal Robots: movel(p[0.1,0.02,0.005,0,0,0], a=1.2, v=0.25)
URS_RE = re.compile(
    r"^\s*(movel|movej|movep|movec)\s*\(\s*p?\[\s*"
    r"(-?[\d.eE+-]+)\s*,\s*(-?[\d.eE+-]+)\s*,\s*(-?[\d.eE+-]+)", re.IGNORECASE)

# Heuristic: a line that switches the process on/off (weld, extrude, spray...)
TOOL_ON_RE = re.compile(
    r"\b(ExtrudeOn|WeldOn|ArcL?Start|SprayOn|TOOL_ON|LaserOn|set_digital_out\s*\(\s*\d+\s*,\s*True)\b",
    re.IGNORECASE)
TOOL_OFF_RE = re.compile(
    r"\b(ExtrudeOff|WeldOff|ArcL?End|SprayOff|TOOL_OFF|LaserOff|set_digital_out\s*\(\s*\d+\s*,\s*False)\b",
    re.IGNORECASE)


def detect_robot_dialect(path):
    head = Path(path).read_text(errors="ignore")[:20000]
    if RAPID_RE.search(head) or "PROC main" in head:
        return "rapid"
    if KRL_RE.search(head) or re.search(r"\bDEF\s+\w+\s*\(", head):
        return "krl"
    if URS_RE.search(head) or "def " in head and "movel" in head.lower():
        return "urscript"
    return None


def parse_robot(path, dialect, layer_mode="zband", band=5.0):
    tp = Toolpath(name=Path(path).stem)
    tool_on = False

    with open(path, "r", errors="ignore") as fh:
        for raw in fh:
            line = raw.split("!")[0].split("//")[0]  # RAPID '!' and generic '//'

            if TOOL_ON_RE.search(line):
                tool_on = True
            if TOOL_OFF_RE.search(line):
                tool_on = False

            pos = None
            motion = None

            if dialect == "krl":
                m = KRL_RE.match(line)
                if m:
                    motion = m.group(1).upper()
                    coords = {k.upper(): float(v) for k, v in KRL_XYZ_RE.findall(m.group(2))}
                    if {"X", "Y", "Z"} <= coords.keys():
                        pos = (coords["X"], coords["Y"], coords["Z"])
            elif dialect == "rapid":
                m = RAPID_RE.match(line)
                if m:
                    motion = m.group(1).upper()
                    pm = RAPID_POS_RE.search(m.group(2))
                    if pm:
                        pos = tuple(float(g) for g in pm.groups())
            elif dialect == "urscript":
                m = URS_RE.match(line)
                if m:
                    motion = m.group(1).upper()
                    # URScript is metres; convert to mm to match everything else.
                    pos = tuple(float(g) * 1000.0 for g in m.groups()[1:4])

            if pos is None:
                continue

            rapid_motion = motion in ("PTP", "PTP_REL", "MOVEJ", "MOVEABSJ")
            if rapid_motion:
                kind = KIND_TRAVEL
            elif tool_on:
                kind = KIND_EXTRUDE
            else:
                kind = KIND_WORK

            tp.add(pos[0], pos[1], pos[2], kind)

    apply_band_layers(tp, layer_mode, band)
    return tp


def apply_band_layers(tp, layer_mode, band):
    """Robot programs have no layer concept, so synthesize one."""
    if tp.n_points() == 0:
        tp.layer_starts = [0]
        tp.layer_z = [0.0]
        return

    if layer_mode == "none":
        tp.layer_starts = [0]
        tp.layer_z = [tp.pts[2]]
        return

    # Note: these run after every point exists, so we append indices directly
    # rather than going through mark_layer() (which infers the index from the
    # current point count and would stamp every layer at the end of the path).
    starts, zs = [], []

    if layer_mode == "zband":
        cur_band = None
        for i in range(tp.n_points()):
            z = tp.pts[i * 3 + 2]
            b = math.floor(z / band) if band > 0 else 0
            if cur_band is None or b != cur_band:
                starts.append(i)
                zs.append(z)
                cur_band = b
    else:  # 'segments' -- split into ~120 equal chunks so the slider has stops
        n = tp.n_points()
        chunks = min(120, max(1, n // 50))
        step = max(1, n // chunks)
        for i in range(0, n, step):
            starts.append(i)
            zs.append(tp.pts[i * 3 + 2])

    if not starts or starts[0] != 0:
        starts.insert(0, 0)
        zs.insert(0, tp.pts[2])

    tp.layer_starts = starts
    tp.layer_z = zs


# --------------------------------------------------------------------------
# Simplification
# --------------------------------------------------------------------------

def simplify(tp, eps):
    """Drop interior points that sit within `eps` of the line joining neighbours.

    Only collapses points where the segment kind is unchanged, and never
    collapses a layer boundary. Cuts 30-70% of points off typical infill.
    """
    if eps <= 0 or tp.n_points() < 3:
        return tp

    n = tp.n_points()
    protected = set(tp.layer_starts)
    keep = [True] * n

    anchor = 0
    i = 1
    while i < n - 1:
        if i in protected or tp.kinds[i - 1] != tp.kinds[i]:
            anchor = i
            i += 1
            continue

        ax, ay, az = tp.pts[anchor*3], tp.pts[anchor*3+1], tp.pts[anchor*3+2]
        cx, cy, cz = tp.pts[(i+1)*3], tp.pts[(i+1)*3+1], tp.pts[(i+1)*3+2]
        bx, by, bz = tp.pts[i*3], tp.pts[i*3+1], tp.pts[i*3+2]

        vx, vy, vz = cx - ax, cy - ay, cz - az
        wx, wy, wz = bx - ax, by - ay, bz - az
        vlen2 = vx*vx + vy*vy + vz*vz

        if vlen2 < 1e-12:
            anchor = i
            i += 1
            continue

        t = (wx*vx + wy*vy + wz*vz) / vlen2
        t = max(0.0, min(1.0, t))
        dx = wx - t*vx
        dy = wy - t*vy
        dz = wz - t*vz

        if dx*dx + dy*dy + dz*dz <= eps*eps:
            keep[i] = False
            i += 1
        else:
            anchor = i
            i += 1

    out = Toolpath(tp.name)
    remap = {}
    new_pts = []
    kept_idx = [i for i in range(n) if keep[i]]
    for new_i, i in enumerate(kept_idx):
        remap[i] = new_i
        new_pts.extend(tp.pts[i*3:i*3+3])

    # A surviving segment spans the collapsed run a..b. Every original segment in
    # that run shares one kind by construction, so inherit the kind at `a`.
    new_kinds = [tp.kinds[a] for a in kept_idx[:-1]]

    out.pts = new_pts
    out.kinds = new_kinds
    out.layer_starts = [remap[i] for i in tp.layer_starts if i in remap]
    out.layer_z = [z for i, z in zip(tp.layer_starts, tp.layer_z) if i in remap]
    if not out.layer_starts:
        out.layer_starts = [0]
        out.layer_z = [out.pts[2] if out.pts else 0.0]
    return out


# --------------------------------------------------------------------------
# Binary writer
# --------------------------------------------------------------------------

def write_tpath(tp, out_path, do_gzip=True):
    n = tp.n_points()
    if n < 2:
        raise SystemExit(f"error: {tp.name} produced {n} points -- nothing to render.")

    minx, miny, minz, maxx, maxy, maxz = tp.bbox()
    ext = [maxx - minx, maxy - miny, maxz - minz]
    inv = [(65535.0 / e if e > 1e-9 else 0.0) for e in ext]

    name_b = tp.name.encode("utf-8")[:255]
    name_pad = (-len(name_b)) % 4

    layer_count = len(tp.layer_starts)

    header = bytearray(64)
    header[0:4] = MAGIC
    struct.pack_into("<HH", header, 4, VERSION, 0)
    struct.pack_into("<II", header, 8, n, layer_count)
    struct.pack_into("<6f", header, 16, minx, miny, minz, maxx, maxy, maxz)
    struct.pack_into("<I", header, 40, len(name_b))

    parts = [bytes(header), name_b, b"\x00" * name_pad]

    # Layer point offsets, with a terminating entry equal to the point count.
    offs = list(tp.layer_starts) + [n]
    parts.append(struct.pack(f"<{len(offs)}I", *offs))
    parts.append(struct.pack(f"<{layer_count}f", *tp.layer_z))

    quant = bytearray(n * 6)
    for i in range(n):
        px = tp.pts[i*3]     - minx
        py = tp.pts[i*3 + 1] - miny
        pz = tp.pts[i*3 + 2] - minz
        struct.pack_into("<HHH", quant, i * 6,
                         int(px * inv[0] + 0.5) if inv[0] else 0,
                         int(py * inv[1] + 0.5) if inv[1] else 0,
                         int(pz * inv[2] + 0.5) if inv[2] else 0)
    parts.append(bytes(quant))
    parts.append(bytes(bytearray(tp.kinds)))

    blob = b"".join(parts)

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(blob)

    gz_size = None
    if do_gzip:
        gz_path = out_path.with_suffix(out_path.suffix + ".gz")
        with gzip.open(gz_path, "wb", compresslevel=9) as fh:
            fh.write(blob)
        gz_size = gz_path.stat().st_size

    return {
        "points": n,
        "layers": layer_count,
        "bytes": len(blob),
        "gzip_bytes": gz_size,
        "bbox": [minx, miny, minz, maxx, maxy, maxz],
    }


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def human(nbytes):
    if nbytes is None:
        return "-"
    for unit in ("B", "KB", "MB", "GB"):
        if nbytes < 1024 or unit == "GB":
            return f"{nbytes:.1f} {unit}" if unit != "B" else f"{nbytes} B"
        nbytes /= 1024.0


def main():
    ap = argparse.ArgumentParser(description="Convert G-code / robot programs to .tpath")
    ap.add_argument("inputs", nargs="+", help="source .gcode / .nc / .src / .mod / .script files")
    ap.add_argument("-o", "--out", help="output .tpath path (single input only)")
    ap.add_argument("--outdir", default=".", help="output directory when converting several files")
    ap.add_argument("--layer-mode", default="auto",
                    choices=["auto", "comment", "z", "zband", "segments", "none"],
                    help="how to segment the timeline into layers")
    ap.add_argument("--band", type=float, default=5.0,
                    help="mm per band for --layer-mode zband (robot programs)")
    ap.add_argument("--simplify", type=float, default=0.008,
                    help="collinear tolerance in mm; 0 disables")
    ap.add_argument("--no-gzip", action="store_true", help="skip writing the .gz sibling")
    ap.add_argument("--manifest", help="write/update an exhibit manifest.json here")
    ap.add_argument("--id", help="exhibit id used in the manifest and the NFC URL")
    ap.add_argument("--title", help="human-readable title for the manifest")
    ap.add_argument("--subtitle", default="", help="one-line caption shown under the title")
    args = ap.parse_args()

    if args.out and len(args.inputs) > 1:
        ap.error("--out only works with a single input; use --outdir instead")

    tracks = []
    for src in args.inputs:
        src_path = Path(src)
        if not src_path.exists():
            raise SystemExit(f"error: {src} not found")

        raw_size = src_path.stat().st_size
        dialect = detect_robot_dialect(src_path)

        if dialect:
            lm = args.layer_mode if args.layer_mode != "auto" else "zband"
            tp = parse_robot(src_path, dialect, layer_mode=lm, band=args.band)
            kind_label = f"robot/{dialect}"
        else:
            tp = parse_gcode(src_path, layer_mode=args.layer_mode)
            kind_label = "gcode"

        before = tp.n_points()
        if args.simplify > 0:
            tp = simplify(tp, args.simplify)
        after = tp.n_points()

        if args.out:
            out_path = Path(args.out)
        else:
            out_path = Path(args.outdir) / (src_path.stem + ".tpath")

        stats = write_tpath(tp, out_path, do_gzip=not args.no_gzip)

        ratio = raw_size / stats["gzip_bytes"] if stats["gzip_bytes"] else 0
        print(f"{src_path.name}  [{kind_label}]")
        print(f"   points   {before:,} -> {after:,} after simplify")
        print(f"   layers   {stats['layers']:,}")
        print(f"   source   {human(raw_size)}")
        print(f"   .tpath   {human(stats['bytes'])}   gzip {human(stats['gzip_bytes'])}"
              + (f"   ({ratio:.0f}x smaller)" if ratio else ""))
        print(f"   -> {out_path}")
        print()

        tracks.append({
            "name": tp.name,
            "file": out_path.name,
            "kind": kind_label,
            "points": stats["points"],
            "layers": stats["layers"],
            "bbox": [round(v, 3) for v in stats["bbox"]],
        })

    if args.manifest:
        mpath = Path(args.manifest)
        data = {"exhibits": {}}
        if mpath.exists():
            try:
                data = json.loads(mpath.read_text())
            except json.JSONDecodeError:
                pass
        data.setdefault("exhibits", {})
        eid = args.id or tracks[0]["name"]
        data["exhibits"][eid] = {
            "title": args.title or eid,
            "subtitle": args.subtitle,
            "tracks": tracks,
        }
        mpath.parent.mkdir(parents=True, exist_ok=True)
        mpath.write_text(json.dumps(data, indent=2))
        print(f"manifest updated: {mpath}  (exhibit id '{eid}')")


if __name__ == "__main__":
    main()
