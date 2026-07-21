/**
 * viewer-core.js -- the parts of the viewer that don't touch WebGL.
 *
 * Kept free of any three.js import on purpose: everything in here is pure
 * data-in / typed-arrays-out, so tools/test_viewer_core.mjs can exercise it in
 * Node against the exact files the Python builder produced. The bugs that ruin
 * a gallery install (an off-by-one in a layer offset, a draw range that runs
 * past the end of a buffer) live in this file, not in the scene setup.
 */

export const KIND_TRAVEL = 0;
export const KIND_EXTRUDE = 1;
export const KIND_WORK = 2;

// ---------------------------------------------------------------------------
// Binary .tpath reader -- mirrors tools/build_toolpath.py. See FORMAT.md.
// ---------------------------------------------------------------------------

export function parseTpath(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'TPTH') throw new Error('Not a .tpath file (bad magic).');

  const version = dv.getUint16(4, true);
  if (version !== 1) throw new Error('Unsupported .tpath version ' + version);

  const n = dv.getUint32(8, true);
  const layerCount = dv.getUint32(12, true);
  const bbox = [];
  for (let i = 0; i < 6; i++) bbox.push(dv.getFloat32(16 + i * 4, true));
  const nameLen = dv.getUint32(40, true);

  let off = 64;
  const name = new TextDecoder().decode(new Uint8Array(buf, off, nameLen));
  off += nameLen + ((4 - (nameLen % 4)) % 4);

  const layerOffsets = new Uint32Array(buf.slice(off, off + (layerCount + 1) * 4));
  off += (layerCount + 1) * 4;

  const layerZ = new Float32Array(buf.slice(off, off + layerCount * 4));
  off += layerCount * 4;

  const quant = new Uint16Array(buf.slice(off, off + n * 6));
  off += n * 6;

  const kinds = new Uint8Array(buf.slice(off, off + (n - 1)));
  off += n - 1;

  if (off !== buf.byteLength) {
    throw new Error(`.tpath has ${buf.byteLength - off} unexpected trailing bytes`);
  }

  // Dequantize once into the Float32Array that will become a GPU buffer.
  const pts = new Float32Array(n * 3);
  const lo = [bbox[0], bbox[1], bbox[2]];
  const ext = [bbox[3] - bbox[0], bbox[4] - bbox[1], bbox[5] - bbox[2]];
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      pts[i * 3 + a] = lo[a] + (quant[i * 3 + a] / 65535) * ext[a];
    }
  }

  return { name, pts, kinds, layerOffsets, layerZ, bbox, n };
}

// ---------------------------------------------------------------------------
// Fallback: parse raw G-code in the browser.
// Slower and far heavier than .tpath, but it means ?src=whatever.gcode works
// while you are still iterating on the model.
// ---------------------------------------------------------------------------

const LAYER_COMMENT_RE =
  /;\s*(?:LAYER:|LAYER_CHANGE|CHANGE_LAYER|layer\s+\d+|AFTER_LAYER_CHANGE)/i;

export function parseGcodeText(text) {
  const pts = [], kinds = [], layerOffsets = [], layerZ = [];
  let x = null, y = null, z = null, e = 0;
  let absPos = true, absE = true, unit = 1;
  let curLayerZ = null, pendingLayerComment = false, sawAnyLayer = false;

  // Mirrors Toolpath.add() in build_toolpath.py: the first point seeds the
  // polyline and carries no incoming segment; zero-length moves are dropped.
  // Keeping these two implementations byte-identical is what lets the test
  // suite compare them directly.
  const addPoint = (px, py, pz, kind) => {
    if (pts.length) {
      const n = pts.length;
      if (Math.abs(pts[n - 3] - px) < 1e-9 &&
          Math.abs(pts[n - 2] - py) < 1e-9 &&
          Math.abs(pts[n - 1] - pz) < 1e-9) return;
      kinds.push(kind);
    }
    pts.push(px, py, pz);
  };
  const markLayer = (zz) => {
    const idx = pts.length / 3;
    if (layerOffsets.length && layerOffsets[layerOffsets.length - 1] === idx) {
      layerZ[layerZ.length - 1] = zz;
      return;
    }
    layerOffsets.push(idx);
    layerZ.push(zz);
    sawAnyLayer = true;
  };

  for (const rawLine of text.split('\n')) {
    const semi = rawLine.indexOf(';');
    const comment = semi >= 0 ? rawLine.slice(semi) : '';
    if (comment && LAYER_COMMENT_RE.test(comment)) pendingLayerComment = true;

    const line = (semi >= 0 ? rawLine.slice(0, semi) : rawLine)
      .replace(/\([^)]*\)/g, ' ').trim();
    if (!line) continue;

    const m = line.match(/^([GM])\s*(\d+)/i);
    if (!m) continue;
    const letter = m[1].toUpperCase(), num = parseInt(m[2], 10);

    if (letter === 'M') {
      if (num === 82) absE = true;
      else if (num === 83) absE = false;
      continue;
    }
    if (num === 20) { unit = 25.4; continue; }
    if (num === 21) { unit = 1; continue; }
    if (num === 90) { absPos = true; continue; }
    if (num === 91) { absPos = false; continue; }

    const p = {};
    for (const w of line.matchAll(/([XYZEF])\s*(-?\d*\.?\d+)/gi)) {
      p[w[1].toUpperCase()] = parseFloat(w[2]);
    }

    if (num === 92) {
      if ('X' in p) x = p.X * unit;
      if ('Y' in p) y = p.Y * unit;
      if ('Z' in p) z = p.Z * unit;
      if ('E' in p) e = p.E;
      continue;
    }
    if (num === 28) {
      const axes = ('X' in p || 'Y' in p || 'Z' in p) ? p : { X: 0, Y: 0, Z: 0 };
      if ('X' in axes) x = 0;
      if ('Y' in axes) y = 0;
      if ('Z' in axes) z = 0;
      continue;
    }
    if (num !== 0 && num !== 1) continue;  // arcs are handled by the Python tool

    const nx = 'X' in p ? p.X * unit : null;
    const ny = 'Y' in p ? p.Y * unit : null;
    const nz = 'Z' in p ? p.Z * unit : null;

    const tx = absPos ? (nx !== null ? nx : x) : (x || 0) + (nx || 0);
    const ty = absPos ? (ny !== null ? ny : y) : (y || 0) + (ny || 0);
    const tz = absPos ? (nz !== null ? nz : z) : (z || 0) + (nz || 0);

    let de = 0;
    if ('E' in p) { de = absE ? p.E - e : p.E; e = absE ? p.E : e + p.E; }

    const kind = num === 0 ? KIND_TRAVEL
               : de > 1e-9 ? KIND_EXTRUDE
               : ('E' in p ? KIND_TRAVEL : KIND_WORK);

    // Position not fully established yet (no homing, no G92) — track it but
    // don't draw, or we'd streak a line in from a phantom origin.
    if (tx === null || ty === null || tz === null) { x = tx; y = ty; z = tz; continue; }

    // Layer bookkeeping happens before the point is added, so the recorded
    // offset is the index of the first point *of* the new layer.
    if (pendingLayerComment) {
      markLayer(tz);
      pendingLayerComment = false;
      curLayerZ = tz;
    } else if (kind === KIND_EXTRUDE && (curLayerZ === null || tz > curLayerZ + 1e-6)) {
      if (!sawAnyLayer) markLayer(tz);
      curLayerZ = tz;
    }

    addPoint(tx, ty, tz, kind);
    x = tx; y = ty; z = tz;
  }

  if (pts.length < 6) throw new Error('No usable moves found in that G-code.');

  const arr = new Float32Array(pts);
  let mnx = Infinity, mny = Infinity, mnz = Infinity;
  let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let i = 0; i < arr.length; i += 3) {
    mnx = Math.min(mnx, arr[i]);     mxx = Math.max(mxx, arr[i]);
    mny = Math.min(mny, arr[i + 1]); mxy = Math.max(mxy, arr[i + 1]);
    mnz = Math.min(mnz, arr[i + 2]); mxz = Math.max(mxz, arr[i + 2]);
  }

  const n = arr.length / 3;
  // finalize_layers() in build_toolpath.py: always at least one layer, and
  // layer 0 must begin at point 0 or the binary search walks off the front.
  if (!layerOffsets.length) {
    layerOffsets.push(0);
    layerZ.push(arr[2]);
  } else if (layerOffsets[0] !== 0) {
    layerOffsets.unshift(0);
    layerZ.unshift(arr[2]);
  }

  return {
    name: 'gcode',
    pts: arr,
    kinds: new Uint8Array(kinds),
    layerOffsets: Uint32Array.from([...layerOffsets, n]),
    layerZ: Float32Array.from(layerZ),
    bbox: [mnx, mny, mnz, mxx, mxy, mxz],
    n,
  };
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/** three.js treats vertex colours as already being in linear working space. */
function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// Saturated, mid-dark stops so the deposited object reads clearly on the white
// print bed (the old cyan/violet/rose washed out). Cool base → hot top.
const RAMP = [
  { t: 0.0,  c: [0x0e / 255, 0x74 / 255, 0x90 / 255] },  // deep teal
  { t: 0.38, c: [0x6d / 255, 0x28 / 255, 0xd9 / 255] },  // violet
  { t: 0.70, c: [0xe1 / 255, 0x1d / 255, 0x48 / 255] },  // rose-red
  { t: 1.0,  c: [0xf9 / 255, 0x73 / 255, 0x16 / 255] },  // orange
];
const WORK_RGB = [0x4a / 255, 0xde / 255, 0x80 / 255];  // green

function rampAt(t, out) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < RAMP.length; i++) {
    if (t <= RAMP[i].t) {
      const a = RAMP[i - 1], b = RAMP[i];
      const k = (t - a.t) / (b.t - a.t);
      for (let j = 0; j < 3; j++) out[j] = srgbToLinear(a.c[j] + (b.c[j] - a.c[j]) * k);
      return out;
    }
  }
  const last = RAMP[RAMP.length - 1].c;
  for (let j = 0; j < 3; j++) out[j] = srgbToLinear(last[j]);
  return out;
}

// ---------------------------------------------------------------------------
// Track buffers
// ---------------------------------------------------------------------------

/**
 * Bounding box of the points actually touched by deposition/work segments.
 *
 * This is deliberately not data.bbox. A single park or approach move -- a robot
 * retracting to Z 400, a printer homing to a corner -- stretches the real bbox
 * far past the object, which would frame the camera around empty space and
 * squash the height colour ramp into a fraction of its range. Quantization
 * still needs the full bbox; everything the eye sees should use this one.
 *
 * Falls back to the full bbox for travel-only programs.
 */
export function contentBounds(data) {
  const { pts, kinds, bbox } = data;
  const segCount = data.n - 1;
  let mnx = Infinity, mny = Infinity, mnz = Infinity;
  let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  let any = false;

  for (let s = 0; s < segCount; s++) {
    if (kinds[s] === KIND_TRAVEL) continue;
    any = true;
    for (const i of [s, s + 1]) {
      const x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2];
      if (x < mnx) mnx = x; if (x > mxx) mxx = x;
      if (y < mny) mny = y; if (y > mxy) mxy = y;
      if (z < mnz) mnz = z; if (z > mxz) mxz = z;
    }
  }
  return any ? [mnx, mny, mnz, mxx, mxy, mxz] : bbox.slice();
}

/**
 * Split a toolpath into two line-segment buffers (deposition and travel) and
 * build the prefix sums that make scrubbing O(1).
 *
 * Segment s joins point s to point s+1. mainPrefix[s] is how many deposition
 * segments occur strictly before s, so showing "the first s segments" is just
 * a draw range of mainPrefix[s] * 2 vertices -- no geometry rebuild, no upload.
 */
export function buildTrackBuffers(data) {
  const { pts, kinds } = data;
  const segCount = data.n - 1;
  const cbox = contentBounds(data);
  const zMin = cbox[2];
  const zExt = Math.max(cbox[5] - cbox[2], 1e-6);

  let nMain = 0, nTravel = 0;
  for (let s = 0; s < segCount; s++) {
    if (kinds[s] === KIND_TRAVEL) nTravel++; else nMain++;
  }

  const mainPos = new Float32Array(nMain * 6);
  const mainCol = new Float32Array(nMain * 6);
  const travPos = new Float32Array(nTravel * 6);
  const mainPrefix = new Uint32Array(segCount + 1);
  const travPrefix = new Uint32Array(segCount + 1);

  const c0 = [0, 0, 0], c1 = [0, 0, 0];
  let mi = 0, ti = 0;

  for (let s = 0; s < segCount; s++) {
    mainPrefix[s] = mi;
    travPrefix[s] = ti;

    const a = s * 3, b = (s + 1) * 3;
    if (kinds[s] === KIND_TRAVEL) {
      const o = ti * 6;
      travPos[o]     = pts[a];     travPos[o + 1] = pts[a + 1]; travPos[o + 2] = pts[a + 2];
      travPos[o + 3] = pts[b];     travPos[o + 4] = pts[b + 1]; travPos[o + 5] = pts[b + 2];
      ti++;
    } else {
      const o = mi * 6;
      mainPos[o]     = pts[a];     mainPos[o + 1] = pts[a + 1]; mainPos[o + 2] = pts[a + 2];
      mainPos[o + 3] = pts[b];     mainPos[o + 4] = pts[b + 1]; mainPos[o + 5] = pts[b + 2];

      if (kinds[s] === KIND_WORK) {
        const lw = [srgbToLinear(WORK_RGB[0]), srgbToLinear(WORK_RGB[1]), srgbToLinear(WORK_RGB[2])];
        mainCol[o]     = lw[0]; mainCol[o + 1] = lw[1]; mainCol[o + 2] = lw[2];
        mainCol[o + 3] = lw[0]; mainCol[o + 4] = lw[1]; mainCol[o + 5] = lw[2];
      } else {
        rampAt((pts[a + 2] - zMin) / zExt, c0);
        rampAt((pts[b + 2] - zMin) / zExt, c1);
        mainCol[o]     = c0[0]; mainCol[o + 1] = c0[1]; mainCol[o + 2] = c0[2];
        mainCol[o + 3] = c1[0]; mainCol[o + 4] = c1[1]; mainCol[o + 5] = c1[2];
      }
      mi++;
    }
  }

  mainPrefix[segCount] = mi;
  travPrefix[segCount] = ti;

  return {
    mainPos, mainCol, travPos, mainPrefix, travPrefix,
    segCount, nMain, nTravel, contentBbox: cbox,
  };
}

/** Largest layer index whose first segment is at or before segment `s`. */
export function layerAt(layerOffsets, layerCount, s) {
  let a = 0, b = layerCount - 1, best = 0;
  while (a <= b) {
    const mid = (a + b) >> 1;
    if (layerOffsets[mid] <= s) { best = mid; a = mid + 1; } else { b = mid - 1; }
  }
  return best;
}

/**
 * Work out the three draw ranges for a given scrub position.
 * Returns vertex offsets/counts, ready to hand to BufferGeometry.setDrawRange.
 */
export function drawRangesFor(track, data, s) {
  s = Math.max(0, Math.min(track.segCount, Math.round(s)));
  const layerCount = data.layerZ.length;
  const layer = layerAt(data.layerOffsets, layerCount, s);
  const layerStartSeg = data.layerOffsets[layer];

  const hotStart = track.mainPrefix[layerStartSeg];
  const hotEnd = track.mainPrefix[s];

  return {
    seg: s,
    layer,
    cold:   { start: 0, count: hotStart * 2 },
    hot:    { start: hotStart * 2, count: Math.max(0, hotEnd - hotStart) * 2 },
    travel: { start: 0, count: track.travPrefix[s] * 2 },
  };
}
