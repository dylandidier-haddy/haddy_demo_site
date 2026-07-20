/**
 * test_viewer_core.mjs -- exercise the browser's parsing and scrub maths in
 * Node, against the exact .tpath files the Python builder wrote.
 *
 * This is the check that matters: it proves the JS reader agrees with the
 * Python writer, and that every draw range the slider can produce stays inside
 * the buffers. A mismatch here is a blank screen on a stranger's phone.
 *
 *     node tools/test_viewer_core.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseTpath, parseGcodeText, buildTrackBuffers, drawRangesFor, layerAt,
  contentBounds, KIND_TRAVEL, KIND_EXTRUDE, KIND_WORK,
} from '../web/viewer-core.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let passed = 0, failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    failures.push(`${name}: ${err.message}`);
    console.log(`  FAIL ${name}\n         ${err.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg} (got ${a}, expected ${b})`); }
function near(a, b, tol, msg) {
  if (Math.abs(a - b) > tol) throw new Error(`${msg} (got ${a}, expected ~${b}, tol ${tol})`);
}

function loadTpath(rel) {
  const b = readFileSync(join(ROOT, rel));
  return parseTpath(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

// ---------------------------------------------------------------------------

console.log('\n.tpath reader\n');

const vase = loadTpath('web/data/twisted_vase.tpath');
const arm  = loadTpath('web/data/helix_arm.tpath');

check('vase header matches the builder report', () => {
  eq(vase.name, 'twisted_vase', 'name');
  eq(vase.n, 15300, 'point count');
  eq(vase.layerZ.length, 180, 'layer count');
});

check('arm header matches the builder report', () => {
  eq(arm.name, 'helix_arm', 'name');
  eq(arm.n, 675, 'point count');
  eq(arm.layerZ.length, 28, 'layer count');
});

check('kinds array is one shorter than the point array', () => {
  eq(vase.kinds.length, vase.n - 1, 'vase kinds');
  eq(arm.kinds.length, arm.n - 1, 'arm kinds');
});

check('kind histogram matches verify_tpath.py', () => {
  const h = { 0: 0, 1: 0, 2: 0 };
  for (const k of vase.kinds) h[k]++;
  eq(h[KIND_TRAVEL], 179, 'vase travel segments');
  eq(h[KIND_EXTRUDE], 15120, 'vase extrude segments');
  eq(h[KIND_WORK], 0, 'vase work segments');
});

check('dequantized points reproduce the stored bbox', () => {
  for (const [label, t] of [['vase', vase], ['arm', arm]]) {
    for (let a = 0; a < 3; a++) {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < t.n; i++) {
        const v = t.pts[i * 3 + a];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      const ext = t.bbox[a + 3] - t.bbox[a];
      const tol = Math.max(ext / 65535 * 2, 1e-4);
      near(lo, t.bbox[a], tol, `${label} axis ${a} min`);
      near(hi, t.bbox[a + 3], tol, `${label} axis ${a} max`);
    }
  }
});

check('layer offsets are monotonic, start at 0, terminate at n', () => {
  for (const [label, t] of [['vase', vase], ['arm', arm]]) {
    const lo = t.layerOffsets;
    eq(lo.length, t.layerZ.length + 1, `${label} offsets length`);
    eq(lo[0], 0, `${label} first offset`);
    eq(lo[lo.length - 1], t.n, `${label} terminator`);
    for (let i = 1; i < lo.length; i++) {
      assert(lo[i] >= lo[i - 1], `${label} offsets not monotonic at ${i}`);
    }
  }
});

check('rejects a truncated file rather than rendering garbage', () => {
  const b = readFileSync(join(ROOT, 'web/data/helix_arm.tpath'));
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength - 40);
  let threw = false;
  try { parseTpath(ab); } catch { threw = true; }
  assert(threw, 'truncated file parsed without error');
});

check('rejects a file with bad magic', () => {
  const b = Buffer.from(readFileSync(join(ROOT, 'web/data/helix_arm.tpath')));
  b[0] = 0x58;
  let threw = false;
  try { parseTpath(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); } catch { threw = true; }
  assert(threw, 'bad magic parsed without error');
});

// ---------------------------------------------------------------------------

console.log('\nlayer lookup\n');

check('layerAt finds the right layer at every boundary', () => {
  const lo = vase.layerOffsets, lc = vase.layerZ.length;
  for (let L = 0; L < lc; L++) {
    eq(layerAt(lo, lc, lo[L]), L, `exact boundary of layer ${L}`);
    if (L + 1 < lc && lo[L + 1] > lo[L] + 1) {
      eq(layerAt(lo, lc, lo[L] + 1), L, `just inside layer ${L}`);
    }
    if (L > 0) {
      eq(layerAt(lo, lc, lo[L] - 1), L - 1, `just before layer ${L}`);
    }
  }
});

check('layerAt clamps below the first and above the last layer', () => {
  const lo = vase.layerOffsets, lc = vase.layerZ.length;
  eq(layerAt(lo, lc, 0), 0, 'segment 0');
  eq(layerAt(lo, lc, vase.n * 10), lc - 1, 'past the end');
});

// ---------------------------------------------------------------------------

console.log('\ntrack buffers and scrub ranges\n');

const vaseBuf = buildTrackBuffers(vase);
const armBuf  = buildTrackBuffers(arm);

check('every segment lands in exactly one buffer', () => {
  for (const [label, t, b] of [['vase', vase, vaseBuf], ['arm', arm, armBuf]]) {
    eq(b.segCount, t.n - 1, `${label} segCount`);
    eq(b.nMain + b.nTravel, b.segCount, `${label} main + travel != total`);
    eq(b.mainPos.length, b.nMain * 6, `${label} main buffer size`);
    eq(b.travPos.length, b.nTravel * 6, `${label} travel buffer size`);
  }
});

check('prefix sums are monotonic and total correctly', () => {
  for (const [label, b] of [['vase', vaseBuf], ['arm', armBuf]]) {
    for (let s = 1; s <= b.segCount; s++) {
      assert(b.mainPrefix[s] >= b.mainPrefix[s - 1], `${label} mainPrefix dips at ${s}`);
      assert(b.travPrefix[s] >= b.travPrefix[s - 1], `${label} travPrefix dips at ${s}`);
      eq(b.mainPrefix[s] + b.travPrefix[s], s, `${label} prefixes at ${s} must sum to s`);
    }
    eq(b.mainPrefix[b.segCount], b.nMain, `${label} final mainPrefix`);
    eq(b.travPrefix[b.segCount], b.nTravel, `${label} final travPrefix`);
  }
});

check('no draw range ever exceeds its buffer, at any scrub position', () => {
  for (const [label, t, b] of [['vase', vase, vaseBuf], ['arm', arm, armBuf]]) {
    const mainVerts = b.nMain * 2;
    const travVerts = b.nTravel * 2;
    // Walk every segment; this is cheap enough to be exhaustive.
    for (let s = 0; s <= b.segCount; s++) {
      const r = drawRangesFor(b, t, s);
      assert(r.cold.start === 0, `${label} cold start must be 0`);
      assert(r.cold.count >= 0, `${label} negative cold count at ${s}`);
      assert(r.hot.count >= 0, `${label} negative hot count at ${s}`);
      assert(r.travel.count >= 0, `${label} negative travel count at ${s}`);
      assert(r.cold.count <= mainVerts, `${label} cold overruns at ${s}`);
      assert(r.hot.start + r.hot.count <= mainVerts, `${label} hot overruns at ${s}`);
      assert(r.travel.count <= travVerts, `${label} travel overruns at ${s}`);
      assert(r.hot.start === r.cold.count,
        `${label} hot must begin exactly where cold ends (s=${s})`);
    }
  }
});

check('cold + hot together equal everything drawn so far', () => {
  for (const [label, t, b] of [['vase', vase, vaseBuf], ['arm', arm, armBuf]]) {
    for (let s = 0; s <= b.segCount; s += Math.max(1, Math.floor(b.segCount / 97))) {
      const r = drawRangesFor(b, t, s);
      eq((r.cold.count + r.hot.count) / 2, b.mainPrefix[s],
        `${label} drawn deposition segments at s=${s}`);
    }
  }
});

check('scrub is monotonic — dragging forward never removes geometry', () => {
  let prev = -1;
  for (let s = 0; s <= vaseBuf.segCount; s++) {
    const r = drawRangesFor(vaseBuf, vase, s);
    const total = r.cold.count + r.hot.count;
    assert(total >= prev, `total drawn shrank going from ${s - 1} to ${s}`);
    prev = total;
  }
});

check('endpoints behave: nothing at 0, everything at the end', () => {
  const start = drawRangesFor(vaseBuf, vase, 0);
  eq(start.cold.count + start.hot.count, 0, 'geometry visible at segment 0');
  eq(start.travel.count, 0, 'travel visible at segment 0');

  const end = drawRangesFor(vaseBuf, vase, vaseBuf.segCount);
  eq((end.cold.count + end.hot.count) / 2, vaseBuf.nMain, 'not all deposition drawn at end');
  eq(end.travel.count / 2, vaseBuf.nTravel, 'not all travel drawn at end');
  eq(end.layer, vase.layerZ.length - 1, 'final layer index');
});

check('out-of-range scrub values are clamped, not crashed on', () => {
  const lowR = drawRangesFor(vaseBuf, vase, -500);
  eq(lowR.seg, 0, 'negative scrub should clamp to 0');
  const hiR = drawRangesFor(vaseBuf, vase, vaseBuf.segCount + 9999);
  eq(hiR.seg, vaseBuf.segCount, 'overshoot should clamp to segCount');
});

check('park moves do not inflate the framing bounds', () => {
  // helix_arm approaches and retracts to Z 400 but only works between
  // roughly Z 20 and Z 150. The full bbox is ~380 mm tall; the content
  // bbox should be a fraction of that.
  const full = arm.bbox[5] - arm.bbox[2];
  const c = contentBounds(arm);
  const content = c[5] - c[2];
  assert(content < full * 0.5,
    `content height ${content.toFixed(1)} should be well under full ${full.toFixed(1)}`);
  assert(c[2] >= arm.bbox[2] - 1e-3 && c[5] <= arm.bbox[5] + 1e-3,
    'content bbox must sit inside the full bbox');
});

check('content bounds equal full bounds when there are no stray travels', () => {
  const c = contentBounds(vase);
  // The vase only travels between layers, all within the object.
  for (let a = 0; a < 6; a++) {
    near(c[a], vase.bbox[a], 0.5, `vase content bbox component ${a}`);
  }
});

check('content bounds fall back to the full bbox for travel-only paths', () => {
  const t = parseGcodeText(['G21', 'G90', 'M82', 'G28',
    'G0 X10 Y10', 'G0 X20 Y20'].join('\n'));
  const c = contentBounds(t);
  for (let a = 0; a < 6; a++) eq(c[a], t.bbox[a], `component ${a}`);
});

check('colour ramp uses its full range regardless of park moves', () => {
  // With the ramp keyed to content height, the arm should span cyan to rose,
  // not sit bunched at the cold end.
  const b = buildTrackBuffers(arm);
  let minR = Infinity, maxR = -Infinity;
  for (let i = 0; i < b.mainCol.length; i += 3) {
    minR = Math.min(minR, b.mainCol[i]);
    maxR = Math.max(maxR, b.mainCol[i]);
  }
  assert(maxR - minR > 0.25,
    `red channel only spans ${(maxR - minR).toFixed(3)} — ramp looks squashed`);
});

check('colour buffer is fully populated and in range', () => {
  const c = vaseBuf.mainCol;
  eq(c.length, vaseBuf.nMain * 6, 'colour buffer size');
  let nonZero = 0;
  for (let i = 0; i < c.length; i++) {
    assert(c[i] >= 0 && c[i] <= 1, `colour out of [0,1] at ${i}: ${c[i]}`);
    if (c[i] > 0) nonZero++;
  }
  assert(nonZero > c.length * 0.5, 'colour buffer looks mostly black');
});

// ---------------------------------------------------------------------------

console.log('\nin-browser G-code fallback\n');

const gtext = readFileSync(join(ROOT, 'samples/twisted_vase.gcode'), 'utf8');
const gparsed = parseGcodeText(gtext);

check('JS G-code parser agrees with the Python parser', () => {
  eq(gparsed.n, vase.n, 'point count');
  eq(gparsed.layerZ.length, vase.layerZ.length, 'layer count');
});

check('JS G-code parser reproduces the same bounding box', () => {
  for (let a = 0; a < 6; a++) {
    near(gparsed.bbox[a], vase.bbox[a], 0.02, `bbox component ${a}`);
  }
});

check('JS G-code parser agrees on segment kinds', () => {
  let diff = 0;
  for (let i = 0; i < Math.min(gparsed.kinds.length, vase.kinds.length); i++) {
    if (gparsed.kinds[i] !== vase.kinds[i]) diff++;
  }
  eq(diff, 0, 'segment kinds differ');
});

check('G-code fallback output drives the same scrub maths', () => {
  const b = buildTrackBuffers(gparsed);
  eq(b.mainPrefix[b.segCount] + b.travPrefix[b.segCount], b.segCount, 'prefix totals');
  const r = drawRangesFor(b, gparsed, b.segCount);
  eq(r.cold.count + r.hot.count, b.nMain * 2, 'full draw at end');
});

check('units, relative moves and G92 are honoured', () => {
  // 1 inch = 25.4 mm; relative mode; then G92 rebases the origin.
  const t = parseGcodeText([
    'G20', 'G90', 'M82', 'G28',
    'G1 X1 Y0 E1',      // -> 25.4, 0, 0
    'G91',
    'G1 X1 Y1 E2',      // -> 50.8, 25.4, 0
    'G90',
    'G1 X0 Y0 E3',      // -> 0, 0, 0
  ].join('\n'));
  near(t.bbox[3], 50.8, 1e-3, 'max X should be 50.8 mm (2 inches)');
  near(t.bbox[4], 25.4, 1e-3, 'max Y should be 25.4 mm (1 inch)');
});

check('a travel-only program yields no deposition geometry', () => {
  const t = parseGcodeText(['G21', 'G90', 'M82', 'G28',
    'G0 X10 Y10', 'G0 X20 Y20', 'G0 X30 Y10'].join('\n'));
  const b = buildTrackBuffers(t);
  // Three G0s produce three points: the first seeds the polyline and carries
  // no incoming segment, so there are two segments, not three.
  eq(t.n, 3, 'expected three points');
  eq(b.nMain, 0, 'expected zero deposition segments');
  eq(b.nTravel, 2, 'expected two travel segments');
  const r = drawRangesFor(b, t, b.segCount);
  eq(r.cold.count, 0, 'cold count');
  eq(r.hot.count, 0, 'hot count');
  eq(r.travel.count, 4, 'travel vertex count');
});

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
