#!/usr/bin/env python3
"""
verify_tpath.py -- read a .tpath back the way the browser will and assert the
invariants the viewer relies on. Run this after every build; a corrupt offset
table shows up as a blank canvas on a phone in a gallery, which is a bad place
to find out.

    python3 verify_tpath.py ../web/data/*.tpath
"""

import struct
import sys
from pathlib import Path

MAGIC = b"TPTH"


def read_tpath(path):
    buf = Path(path).read_bytes()
    assert buf[0:4] == MAGIC, f"{path}: bad magic {buf[0:4]!r}"

    version, flags = struct.unpack_from("<HH", buf, 4)
    n, layer_count = struct.unpack_from("<II", buf, 8)
    bbox = struct.unpack_from("<6f", buf, 16)
    name_len = struct.unpack_from("<I", buf, 40)[0]

    assert version == 1, f"{path}: unexpected version {version}"

    off = 64
    name = buf[off:off + name_len].decode("utf-8")
    off += name_len + ((-name_len) % 4)

    layer_offsets = struct.unpack_from(f"<{layer_count + 1}I", buf, off)
    off += (layer_count + 1) * 4

    layer_z = struct.unpack_from(f"<{layer_count}f", buf, off)
    off += layer_count * 4

    pos_bytes = n * 6
    quant = struct.unpack_from(f"<{n * 3}H", buf, off)
    off += pos_bytes

    kinds = buf[off:off + (n - 1)]
    off += n - 1

    assert off == len(buf), f"{path}: {len(buf) - off} trailing bytes (expected 0)"

    return dict(name=name, n=n, layer_count=layer_count, bbox=bbox,
                layer_offsets=layer_offsets, layer_z=layer_z,
                quant=quant, kinds=kinds, size=len(buf))


def check(path):
    d = read_tpath(path)
    n = d["n"]
    lo = d["layer_offsets"]
    minx, miny, minz, maxx, maxy, maxz = d["bbox"]

    assert len(d["kinds"]) == n - 1, \
        f"{path}: kinds {len(d['kinds'])} != points-1 {n-1}"
    assert lo[0] == 0, f"{path}: first layer offset is {lo[0]}, expected 0"
    assert lo[-1] == n, f"{path}: terminator {lo[-1]} != point count {n}"
    assert all(a <= b for a, b in zip(lo, lo[1:])), \
        f"{path}: layer offsets are not monotonic"
    assert max(lo) <= n, f"{path}: layer offset past end of point array"
    assert set(d["kinds"]) <= {0, 1, 2}, \
        f"{path}: unknown segment kind {set(d['kinds']) - {0,1,2}}"

    # Dequantize and confirm the reconstructed extent matches the stored bbox.
    ext = [maxx - minx, maxy - miny, maxz - minz]
    q = d["quant"]
    worst = 0.0
    for axis in range(3):
        vals = q[axis::3]
        if ext[axis] <= 1e-9:
            continue
        lo_v = minx if axis == 0 else miny if axis == 1 else minz
        hi_v = maxx if axis == 0 else maxy if axis == 1 else maxz
        rec_min = lo_v + (min(vals) / 65535.0) * ext[axis]
        rec_max = lo_v + (max(vals) / 65535.0) * ext[axis]
        worst = max(worst, abs(rec_min - lo_v), abs(rec_max - hi_v))

    max_ext = max(ext) if max(ext) > 0 else 1.0
    tol = max_ext / 65535.0 * 2
    assert worst <= tol, \
        f"{path}: dequantized bbox drifts {worst:.6f} mm (tolerance {tol:.6f})"

    kinds = d["kinds"]
    counts = {k: kinds.count(k) for k in (0, 1, 2)}
    print(f"OK  {Path(path).name}")
    print(f"    name        {d['name']}")
    print(f"    points      {n:,}   segments {n-1:,}")
    print(f"    layers      {d['layer_count']:,}"
          f"   z {d['layer_z'][0]:.2f} .. {d['layer_z'][-1]:.2f} mm")
    print(f"    segments    travel {counts[0]:,}  extrude {counts[1]:,}  work {counts[2]:,}")
    print(f"    bbox        {maxx-minx:.1f} x {maxy-miny:.1f} x {maxz-minz:.1f} mm")
    print(f"    quant error {worst*1000:.3f} um worst axis")
    print()
    return True


if __name__ == "__main__":
    paths = sys.argv[1:]
    if not paths:
        print(__doc__)
        sys.exit(1)
    ok = 0
    for p in paths:
        try:
            check(p)
            ok += 1
        except AssertionError as exc:
            print(f"FAIL {exc}\n")
    print(f"{ok}/{len(paths)} files passed")
    sys.exit(0 if ok == len(paths) else 1)
