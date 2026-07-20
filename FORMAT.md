# The `.tpath` format

A single binary blob holding one machine program: a continuous polyline of
positions, a kind per segment, and a layer index. Written by
`tools/build_toolpath.py`, read by `web/viewer-core.js`. Version 1.

Everything is **little-endian**. All distances are millimetres.

## Why a custom format

Three reasons, in order of how much they matter for an exhibition piece:

1. **No parsing on the phone.** The browser gets typed arrays it can hand
   straight to the GPU. Tokenizing megabytes of ASCII G-code in JavaScript on a
   mid-range Android is the difference between "instant" and "did it crash?".
2. **Layer offsets are precomputed.** Scrubbing needs to know where layer *N*
   starts. Working that out client-side means a full parse before the first
   frame renders.
3. **Smaller, sometimes dramatically.** Quantized positions are 6 bytes; the
   equivalent `G1 X104.882 Y112.317 E1.60518` is ~30 bytes of text.

## Layout

| Offset | Size | Type | Field |
|---|---|---|---|
| 0 | 4 | char[4] | magic, always `TPTH` |
| 4 | 2 | uint16 | version (currently 1) |
| 6 | 2 | uint16 | flags (reserved, 0) |
| 8 | 4 | uint32 | `point_count` |
| 12 | 4 | uint32 | `layer_count` |
| 16 | 24 | float32[6] | bbox: `minX minY minZ maxX maxY maxZ` |
| 40 | 4 | uint32 | `name_len` |
| 44 | 20 | — | reserved, zeroed |
| 64 | `name_len` | utf8 | name, then zero-padded to a 4-byte boundary |
| … | `(layer_count+1)*4` | uint32[] | layer start offsets, **in point indices** |
| … | `layer_count*4` | float32[] | Z height of each layer |
| … | `point_count*6` | uint16[3][] | quantized positions |
| … | `point_count-1` | uint8[] | segment kinds |

Block order is chosen so every array lands on its natural alignment without
padding: 4-byte arrays first, then 2-byte, then 1-byte.

## Positions

Each axis is quantized independently to 16 bits across that axis's extent:

```
stored  = round((value - min[axis]) / (max[axis] - min[axis]) * 65535)
decoded = min[axis] + (stored / 65535) * (max[axis] - min[axis])
```

Worst-case error is half a step — for a 200 mm part, about 1.5 µm. Far below
any nozzle or tool diameter, and far below one screen pixel.

If an axis has zero extent (a flat plate), the encoder writes 0 and the decoder
returns `min`, avoiding a divide by zero.

## Segments

The toolpath is one continuous polyline: the machine head never teleports, so
point *i* connects to point *i+1*. Segment *i* is described by `kinds[i]`, which
is why the kinds array is exactly one shorter than the point array.

| Value | Kind | Meaning |
|---|---|---|
| 0 | `TRAVEL` | repositioning — `G0`, KRL `PTP`, RAPID `MoveJ`, `movej` |
| 1 | `EXTRUDE` | depositing material — `G1` with a positive E delta, or a robot move with the process signal on |
| 2 | `WORK` | linear work with no extrusion axis — CNC cutting, `LIN`/`MoveL` with the tool off |

The first point seeds the polyline and has no incoming segment. Zero-length
moves are dropped at write time, so no segment has identical endpoints.

## Layers

`layer_offsets[L]` is the **point index** where layer *L* begins.
`layer_offsets[layer_count]` is a terminator equal to `point_count`, so
`layer_offsets[L+1] - layer_offsets[L]` is always the length of layer *L*
without a special case for the last one.

Invariants the reader relies on, all asserted by `tools/verify_tpath.py`:

- `layer_offsets[0] == 0`
- `layer_offsets` is non-decreasing
- `layer_offsets[layer_count] == point_count`

For FDM G-code, layers come from slicer comments (`;LAYER:`, `;LAYER_CHANGE`,
…) when present, falling back to detecting a Z increase on an extruding move.

Robot programs have no layer concept, so one is synthesized — see
`--layer-mode` in `build_toolpath.py`. `zband` slices the program into
fixed-height bands; `segments` chops it into roughly equal chunks so the slider
still has meaningful stops.

## Bounding boxes: two of them

The header bbox covers **every** point, including park and approach moves,
because quantization needs the true range.

The viewer does *not* frame the camera or key its colour ramp to that box. A
robot retracting to Z 400 would push the object into the distance and squash
the height gradient into its bottom third. `contentBounds()` in
`viewer-core.js` recomputes bounds over deposition segments only, and that's
what drives framing, zoom limits, fog and colour.

## Compression

`build_toolpath.py` writes a `.gz` sibling. The viewer requests `file.tpath.gz`
first and inflates it with `DecompressionStream`, falling back to the plain
file. That works on any static host, including ones that won't gzip an unknown
extension for you.
