# Toolpath Demos

Tap the RFID tag on a Haddy print and your phone opens a private, interactive
demo of that exact piece — a 3D slice/toolpath you can orbit and scrub through,
layer by layer. A shared access code (kept in a Cloudflare environment variable)
gates the demos; once you're in, you can move straight to the next one.

```
scan RFID ──► https://demos.haddy.life/?p=rockwork
                     │
                     ▼
             [ password gate ]  enter the shared code, e.g. "haddy"
                     │
                     ▼
             the demo: 3D slice viewer for that print   ──►   "Next demo →"
```

The access code is a light, **client-side** gate — an `ACCESS_CODE` constant near
the bottom of `web/index.html`. It keeps casual eyes out and is instant to iterate
on; it is *not* real security, since the code ships in the page. Unlock is
remembered per browser session, so "Next demo" and refreshes don't re-prompt.

```
web/                    a plain static site — serve it from anywhere
  index.html      the demo — 3D slice/toolpath viewer, access gate + Haddy chrome
  viewer-core.js  parsing + scrub maths, unit-tested in Node
  vendor/         three.js r184, self-hosted
  data/           built .tpath demos + manifest.json (one entry per print)
start.command           double-click (macOS) to serve locally + open the browser
```

Each print is one entry in `web/data/manifest.json`; the RFID URL selects it with
`?p=<id>`. Add a print → add a manifest entry → write a tag pointing at it.

---

## 1. Architecture and why

### The core decision: precompile, don't parse on the phone

The obvious approach is to fetch the `.gcode` and parse it in JavaScript. It
works, and this repo includes that path as a fallback, but it's the wrong
default for an exhibition piece. Parsing a few hundred thousand lines of ASCII
on a mid-range Android takes seconds of blocked main thread — during which the
screen is blank and the person who tapped your sculpture has already looked
away.

So a Python tool converts machine programs into `.tpath`: quantized positions,
a kind byte per segment, and a precomputed layer index. The browser does a
`fetch`, two typed-array views and a dequantize loop, then renders. See
[FORMAT.md](FORMAT.md).

Measured on the included samples (gzipped source vs. gzipped `.tpath`):

| Source | Raw | Gzipped source | `.tpath` gzipped |
|---|---|---|---|
| `infill_test.gcode` (straight runs, typical infill) | 1.4 MB | 205 KB | **2.3 KB** |
| `twisted_vase.gcode` (all curves, worst case) | 468 KB | 170 KB | **83 KB** |

The size win swings enormously with geometry — curve-dense organic work barely
compresses, because every point is genuinely unique information. The parse win
is constant, and it's the one that matters.

### Library options, and why this doesn't use one

I looked at what's actually maintained before writing anything:

| Option | Verdict |
|---|---|
| **[gcode-preview](https://www.npmjs.com/package/gcode-preview)** | The best FDM-only option. Nicely built, extrusion-aware rendering. But last published 2.18.0 in Aug 2024, pinned to three.js 0.159 (current is 0.184), and it only understands extrusion G-code — no robot dialects. |
| **three.js `GCodeLoader`** | Built into three's addons, but it builds one static geometry with no layer indexing, so scrubbing means rebuilding. Not designed for playback. |
| **[gcode-viewer](https://github.com/aligator/gcode-viewer)** | Renders tubes instead of lines to work around 1px line width. Good-looking, much heavier per segment. |
| **Sindarius GCodeViewer** | Powerful, used in Duet/mainsail. Substantially more code than this whole repo, and tuned for printer dashboards rather than kiosks. |

Since you need **both** FDM prints and robot arm programs in one viewer, no
existing library covers it — they're all built around the extrusion model.
Normalizing both into one intermediate format and writing ~200 lines of
rendering was simpler than bridging two libraries.

**If you were only ever doing FDM prints, use `gcode-preview` instead of this.**

### How scrubbing stays smooth

The whole timeline is uploaded to the GPU once, as two `LineSegments` buffers
(deposition and travel). Scrubbing never rebuilds geometry or re-uploads
anything — it just moves a draw range:

```js
cold.geometry.setDrawRange(0, hotStart * 2);          // completed layers, dim
hot .geometry.setDrawRange(hotStart * 2, hotLen * 2); // current layer, bright
```

Prefix sums computed at load time map "segment *N*" to "how many vertices of
each buffer to draw", so a scrub is O(1) regardless of file size. The cold and
hot meshes **share the same `BufferAttribute` objects**, so the bright
current-layer highlight costs no extra memory and no copying.

### Other things that turned out to matter

- **Frame on the object, not the machine envelope.** One robot `PTP` retract to
  Z 400 stretched the bounding box until the object was a speck in the distance
  and the height colour ramp was squashed into its bottom third.
  `contentBounds()` ignores travel-only extremes. This was caught by rendering a
  preview, not by reading the code.
- **Cap `devicePixelRatio` at 2.** A 3× iPhone otherwise renders 2.25× the
  pixels for no visible gain on 1px lines.
- **Vendor three.js.** Gallery wifi blocks things and captive portals intercept
  things. A CDN outage mid-show is unfixable from the floor.
- **Attract loop.** The animation loops until someone touches a control, then
  stops looping and hands over. A static object doesn't invite a tap.

### Known limitation

Lines render 1px wide, because WebGL ignores `linewidth` on almost every
platform. It reads fine on a dark background and it scales to millions of
segments. If you want chunky ribbon-like paths and your models are under
~100k segments, swap `LineSegments` for `LineSegments2` /
`LineMaterial` from three's addons — roughly 4× the memory, much bolder look.

---

## 2. Step-by-step

### Prerequisites

Python 3.9+ (no packages needed for the core tool; `pillow` only for previews)
and Node 18+ if you want to run the tests.

### Step 1 — Get your toolpath out of your software

**FDM print:** slice as normal and keep the `.gcode` your slicer writes. Any of
PrusaSlicer, Orca, Bambu Studio, Cura or Simplify3D is fine. Layer detection
prefers the slicer's own `;LAYER:`-style comments and falls back to detecting Z
increases.

**Robot arm:** export the program as usual. Recognized dialects:

| Controller | Extension | Motion parsed |
|---|---|---|
| KUKA KRL | `.src` / `.dat` | `LIN`, `PTP`, `LIN_REL`, `PTP_REL` |
| ABB RAPID | `.mod` / `.prg` | `MoveL`, `MoveJ`, `MoveAbsJ` |
| Universal Robots | `.script` | `movel`, `movej`, `movep` |

**Ai Build large-format prints** are auto-detected and handled directly — the
Sinumerik-style export with `N` line-numbers, modal `G0`/`G1`, and incremental
`E=IC(...)` extrusion (what Haddy's slicer writes). Just point the tool at the
`.gcode`; no flags needed.

The parser looks for process on/off signals (`ExtrudeOn`, `WeldOn`, `ArcStart`,
`set_digital_out(n, True)`, …) to distinguish depositing moves from dry ones. If
your program signals the tool differently, add the pattern to `TOOL_ON_RE` in
`tools/build_toolpath.py`.

> Rhino/Grasshopper users: export G-code or the robot program from your
> postprocessor. Nothing here needs Rhino at runtime.

### Step 2 — Convert

```bash
python3 tools/build_toolpath.py my_print.gcode \
    --outdir web/data \
    --manifest web/data/manifest.json \
    --id vase \
    --title "Twisted Hex Vase" \
    --subtitle "PLA, 0.3 mm layers, spiral vase mode"
```

You'll get a size report. Useful flags:

- `--simplify 0.008` — collapse collinear points within this many mm. The
  default is safe and invisible; raise it to `0.05` if you need to shrink an
  enormous file further. `0` disables.
- `--layer-mode zband --band 5.0` — for robot programs, band the timeline into
  5 mm slices of height so the slider has meaningful stops.
- `--layer-mode segments` — for programs where height isn't meaningful at all;
  chops the timeline into ~120 equal chunks.

Multiple files become multiple tracks in one exhibit, with chips to switch:

```bash
python3 tools/build_toolpath.py print.gcode arm.src \
    --outdir web/data --manifest web/data/manifest.json --id piece01
```

### Step 3 — Check it before you trust it

```bash
python3 tools/verify_tpath.py web/data/*.tpath   # format invariants
node tools/test_viewer_core.mjs                  # 28 tests, parser + scrub maths
python3 tools/render_preview.py web/data/twisted_vase.tpath -o preview.png
```

`render_preview.py` software-renders the file using the same camera, colour
ramp and layer logic as the browser. If the contact sheet looks like your
object, the format, layer offsets and scrub maths are all correct — no phone
required. It also gives you a poster frame for the exhibit label.

### Step 4 — Run it locally

Double-click `start.command` (macOS) — it serves `web/` over HTTP and opens your
browser. Or do it by hand:

```bash
cd web && python3 -m http.server 8000
```

Open `http://localhost:8000/?p=rockwork` and type the access code (`haddy`). It
**must** be served over HTTP — double-clicking `index.html` in Finder opens it as
a `file://` URL, and browsers block ES modules and `fetch` there, so the 3D view
never loads. To skip straight to a raw G-code file without converting:
`?src=../samples/twisted_vase.gcode`.

### Step 5 — Deploy

It's a plain static site — host `web/` anywhere: Cloudflare Pages, GitHub Pages,
Netlify, Vercel, an S3 bucket. No build step, no serverless functions.

- Point the host's output/root directory at `web/` (or push `web/` as the site
  root). On GitHub Pages the included `.nojekyll` matters.
- Change the shared code by editing `ACCESS_CODE` near the bottom of
  `web/index.html`.

You get HTTPS on a stable domain — point something like `demos.haddy.life` at it;
that's the URL the tag opens.

> Want a real server-side gate (code checked against an environment variable, not
> shipped in the page)? That's a small Cloudflare Pages Function — just ask.

### Step 6 — Write the tag

Full detail in [NFC-SETUP.md](NFC-SETUP.md). In brief: write an NDEF URI record
containing the print's demo URL — e.g. `https://demos.haddy.life/?p=rockwork` — to
an NTAG213 sticker using the NFC Tools app, test it on a phone you didn't write
it with, then lock it read-only. The URL lands on the access screen first; the
visitor enters the shared code once and can then move between demos.

---

## 3. Repository layout

```
tools/
  build_toolpath.py     G-code + robot program  ->  .tpath      (the main tool)
  verify_tpath.py       assert format invariants on a built file
  test_viewer_core.mjs  28 tests over the browser's parsing and scrub maths
  render_preview.py     software-render a .tpath to PNG, no browser needed
  make_sample.py        generate the sample files below

samples/
  twisted_vase.gcode    spiral-vase FDM print, 15k moves
  helix_arm.src         KUKA KRL helix with tool on/off
  infill_test.gcode     straight-run-heavy file, exercises --simplify

web/
  index.html            the demo — 3D slice/toolpath viewer, access gate + chrome
  viewer-core.js        format reader, G-code fallback, scrub maths (no WebGL)
  vendor/               three.js r184, MIT
  data/                 built .tpath files + manifest.json (one entry per print)

start.command           double-click (macOS) to serve web/ locally + open browser
```

The split between `index.html` and `viewer-core.js` exists so the logic that
can be wrong in subtle ways — binary parsing, layer lookup, draw ranges — runs
under test in Node, while the part that needs a GPU stays thin.

The access gate is deliberately light: `ACCESS_CODE` in `index.html`, checked in
the browser, remembered in `sessionStorage`. It keeps casual passers-by out; it
is not real security (view-source reveals the code). Swap it for a server-side
check when that matters — see Step 5.

## 4. Customizing

**Colours.** The height ramp is `RAMP` in `viewer-core.js` (cyan → violet →
rose). Values are sRGB and converted to linear for three.js. `WORK_RGB` is the
colour for non-extruding work moves.

**Playback speed.** `state.duration` in `index.html`, seconds for a full pass.
14 is a reasonable dwell time for a gallery.

**Attract loop.** `state.attract` starts `true` and flips off on first
interaction. Set it to `false` initially if you'd rather it play once and stop.

**Copy on screen.** Title and subtitle come from `manifest.json`, so you can
retitle a piece without touching code.
# haddy_demo_site
