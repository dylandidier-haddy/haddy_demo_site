#!/usr/bin/env python3
"""
render_preview.py -- software-render a .tpath the same way the browser will.

Uses the identical camera framing, Z-up -> Y-up rotation, colour ramp and
cold/hot layer split as web/index.html, but with PIL instead of WebGL. Two uses:

  1. Verification. If the contact sheet looks like the object, the binary
     format, layer offsets and scrub maths are all correct -- no phone needed.
  2. A poster frame / QR-card thumbnail for the exhibit label.

    python3 tools/render_preview.py web/data/twisted_vase.tpath -o preview.png
"""

import argparse
import math
import struct
from pathlib import Path

from PIL import Image, ImageDraw

SS = 2  # supersample factor, downscaled at the end for cheap antialiasing

KIND_TRAVEL, KIND_EXTRUDE, KIND_WORK = 0, 1, 2

RAMP = [(0.0, (0x22, 0xd3, 0xee)), (0.5, (0xa7, 0x8b, 0xfa)), (1.0, (0xfb, 0x71, 0x85))]
WORK_RGB = (0x4a, 0xde, 0x80)
BG = (0x0b, 0x0f, 0x14)


def read_tpath(path):
    buf = Path(path).read_bytes()
    assert buf[0:4] == b"TPTH", "bad magic"
    n, layer_count = struct.unpack_from("<II", buf, 8)
    bbox = struct.unpack_from("<6f", buf, 16)
    name_len = struct.unpack_from("<I", buf, 40)[0]

    off = 64
    name = buf[off:off + name_len].decode()
    off += name_len + ((-name_len) % 4)

    layer_offsets = struct.unpack_from(f"<{layer_count + 1}I", buf, off)
    off += (layer_count + 1) * 4
    layer_z = struct.unpack_from(f"<{layer_count}f", buf, off)
    off += layer_count * 4

    quant = struct.unpack_from(f"<{n * 3}H", buf, off)
    off += n * 6
    kinds = buf[off:off + n - 1]

    lo = bbox[0:3]
    ext = [bbox[3] - bbox[0], bbox[4] - bbox[1], bbox[5] - bbox[2]]
    pts = []
    for i in range(n):
        pts.append(tuple(lo[a] + (quant[i * 3 + a] / 65535.0) * ext[a] for a in range(3)))

    return dict(name=name, n=n, pts=pts, kinds=kinds, bbox=bbox,
                layer_offsets=layer_offsets, layer_z=layer_z, layer_count=layer_count)


def content_bounds(data):
    """Bbox of points touched by deposition/work segments only.

    Mirrors contentBounds() in web/viewer-core.js. Park and approach moves would
    otherwise stretch the framing and the colour ramp far past the object.
    """
    pts, kinds = data["pts"], data["kinds"]
    lo = [math.inf] * 3
    hi = [-math.inf] * 3
    any_ = False
    for s in range(data["n"] - 1):
        if kinds[s] == KIND_TRAVEL:
            continue
        any_ = True
        for i in (s, s + 1):
            for a in range(3):
                lo[a] = min(lo[a], pts[i][a])
                hi[a] = max(hi[a], pts[i][a])
    return (lo + hi) if any_ else list(data["bbox"])


def ramp_at(t):
    t = max(0.0, min(1.0, t))
    for i in range(1, len(RAMP)):
        if t <= RAMP[i][0]:
            (t0, c0), (t1, c1) = RAMP[i - 1], RAMP[i]
            k = (t - t0) / (t1 - t0)
            return tuple(int(c0[j] + (c1[j] - c0[j]) * k) for j in range(3))
    return RAMP[-1][1]


def make_camera(bbox, w, h):
    """Exactly the framing frameCamera() uses in index.html."""
    span = max(bbox[3] - bbox[0], bbox[4] - bbox[1], bbox[5] - bbox[2])
    cx = (bbox[0] + bbox[3]) / 2
    cy = (bbox[1] + bbox[4]) / 2
    cz = (bbox[2] + bbox[5]) / 2

    # Machine (x, y, z) -> world (x, z, -y)
    target = (cx, cz, -cy)
    d = span * 1.75
    eye = (target[0] + d * 0.62, target[1] + d * 0.5, target[2] + d * 0.62)

    fwd = [target[i] - eye[i] for i in range(3)]
    fl = math.sqrt(sum(v * v for v in fwd))
    fwd = [v / fl for v in fwd]

    up = (0.0, 1.0, 0.0)
    right = [fwd[1] * up[2] - fwd[2] * up[1],
             fwd[2] * up[0] - fwd[0] * up[2],
             fwd[0] * up[1] - fwd[1] * up[0]]
    rl = math.sqrt(sum(v * v for v in right))
    right = [v / rl for v in right]
    trueup = [right[1] * fwd[2] - right[2] * fwd[1],
              right[2] * fwd[0] - right[0] * fwd[2],
              right[0] * fwd[1] - right[1] * fwd[0]]

    fov = math.radians(42)
    f = (h / 2) / math.tan(fov / 2)

    def project(p):
        # machine -> world
        wx, wy, wz = p[0], p[2], -p[1]
        vx, vy, vz = wx - eye[0], wy - eye[1], wz - eye[2]
        cxx = vx * right[0] + vy * right[1] + vz * right[2]
        cyy = vx * trueup[0] + vy * trueup[1] + vz * trueup[2]
        czz = vx * fwd[0] + vy * fwd[1] + vz * fwd[2]
        if czz <= 1e-6:
            return None
        return (w / 2 + cxx * f / czz, h / 2 - cyy * f / czz)

    return project


def render(data, progress, w, h):
    W, H = w * SS, h * SS
    img = Image.new("RGB", (W, H), BG)
    dr = ImageDraw.Draw(img)

    cbox = content_bounds(data)
    project = make_camera(cbox, W, H)
    pts, kinds = data["pts"], data["kinds"]
    seg_count = data["n"] - 1
    s = max(0, min(seg_count, int(round(progress * seg_count))))

    # Which layer are we in? (same binary search as layerAt())
    lo = data["layer_offsets"]
    layer = 0
    a, b = 0, data["layer_count"] - 1
    while a <= b:
        mid = (a + b) // 2
        if lo[mid] <= s:
            layer, a = mid, mid + 1
        else:
            b = mid - 1
    hot_start = lo[layer]

    zmin = cbox[2]
    zext = max(cbox[5] - cbox[2], 1e-6)

    proj = [None] * (s + 2)
    for i in range(min(s + 2, data["n"])):
        proj[i] = project(pts[i])

    for i in range(s):
        if kinds[i] == KIND_TRAVEL:
            continue
        p0, p1 = proj[i], proj[i + 1]
        if p0 is None or p1 is None:
            continue

        if i >= hot_start:
            col = (255, 255, 255)          # current layer, bright
            wdt = SS
        else:
            base = WORK_RGB if kinds[i] == KIND_WORK else ramp_at((pts[i][2] - zmin) / zext)
            col = tuple(int(BG[j] + (base[j] - BG[j]) * 0.62) for j in range(3))
            wdt = SS
        dr.line([p0, p1], fill=col, width=wdt)

    # Print head
    if s > 0 and proj[s]:
        r = 3 * SS
        dr.ellipse([proj[s][0] - r, proj[s][1] - r, proj[s][0] + r, proj[s][1] + r],
                   fill=(255, 255, 255))

    return img.resize((w, h), Image.LANCZOS), layer


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tpath")
    ap.add_argument("-o", "--out", default="preview.png")
    ap.add_argument("--at", type=float, nargs="*", default=[0.25, 0.6, 1.0],
                    help="scrub positions to render, 0..1")
    ap.add_argument("--size", type=int, nargs=2, default=[420, 520])
    args = ap.parse_args()

    data = read_tpath(args.tpath)
    w, h = args.size

    frames = []
    for p in args.at:
        img, layer = render(data, p, w, h)
        frames.append((img, p, layer))
        print(f"  {int(p*100):3d}%  layer {layer + 1}/{data['layer_count']}"
              f"  z {data['layer_z'][layer]:.2f} mm")

    sheet = Image.new("RGB", (w * len(frames), h), BG)
    for i, (img, _, _) in enumerate(frames):
        sheet.paste(img, (i * w, 0))

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    sheet.save(args.out)
    print(f"wrote {args.out}  ({sheet.width}x{sheet.height})")


if __name__ == "__main__":
    main()
