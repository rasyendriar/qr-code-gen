# Bulk QR Code Generator — web app

A static, client-only webpage for turning a CSV/Excel file of links into thousands
of QR codes, built to comfortably handle **50,000+ rows**. Nothing is uploaded to
a server — parsing, QR rendering, and packaging all happen in your browser.

Pairs with `../qrcode_gen.py` if you'd rather run a batch job from the command line
(same input shape: name column + data column).

## Running it

It's a static site, but the app uses ES modules and Web Workers, which browsers
refuse to load from a plain `file://` URL. Serve the folder over HTTP instead:

```bash
cd web
python3 -m http.server 8000
# or: npx serve .
```

Then open `http://localhost:8000`.

## Features

- **Drag-and-drop CSV/XLSX upload** with column mapping (pick which column is the
  filename/tag and which is the data) and a live preview table.
- **Data validation** before you commit to a run: flags missing values and
  duplicate names (duplicate names would overwrite each other's output file).
- **One-click single preview** so you can sanity-check formatting/colors before
  generating thousands of files.
- **Multi-core generation** — spreads QR rendering across a pool of Web Workers
  (defaults to `hardwareConcurrency - 1`), mirroring the `ProcessPoolExecutor`
  approach in `qrcode_gen.py`.
- **Two output targets:**
  - **Save straight to a folder** (Chrome/Edge, via the File System Access API)
    — writes each file to disk as it's generated. This is the recommended path
    for very large runs: memory use stays flat regardless of whether you're
    generating 500 or 500,000 codes, since nothing is held in memory to be
    zipped later.
  - **Download as ZIP** (works everywhere) — automatically split into multiple
    ZIP parts (configurable, default 5,000 files per part) so the browser never
    has to hold one giant archive in memory at once.
- **Three output formats:** SVG (vector, default — best for print/etching and
  the cheapest to generate at scale), PNG, or a CSV of base64-encoded PNGs (for
  piping straight into another system/database).
- **Base64 image decode mode** — matches the CLI's `--type base64_image` mode:
  paste in already-generated base64 PNGs and this will decode + losslessly
  upscale them (nearest-neighbor) into files, instead of generating new QR
  codes.
- **Pause / resume / cancel** a run in progress, with a live progress bar,
  processed count, error count, throughput, and ETA.
- **Manifest + error CSV** downloads after every run — a full row-by-row record
  of what succeeded, what filename it got, and why anything failed.
- **Settings persistence** (box size, error correction, colors, worker count,
  batch size, etc.) via `localStorage`, and a dark/light theme toggle.

## Why this design scales to 50k+

The two failure modes that usually break browser-based bulk generators are (1)
blocking the UI thread while generating thousands of images, and (2) building
one enormous ZIP/blob in memory. This app avoids both:

- QR rendering runs in a pool of Web Workers, not the main thread — the UI
  stays responsive and generation is parallelized across CPU cores.
- The "save to folder" path writes each file to disk immediately, so peak
  memory is bounded by one batch of files, not the whole dataset.
- The ZIP fallback path never holds more than one ZIP part's worth of files
  in memory at a time — it flushes and downloads a part, then starts a fresh
  archive.
- CSV parsing reads directly from the `File`/`Blob` object (streamed
  internally by PapaParse/SheetJS) rather than loading the whole file into a
  JS string first.

## Project layout

```
web/
  index.html          entry point
  styles.css
  src/
    app.js            UI wiring + generation orchestration (main thread)
    qrWorker.js        runs in each Web Worker; does the actual QR/image rendering
    workerPool.js       pull-based worker pool (load-balances batches across cores)
    fileParser.js       CSV/XLSX -> rows
    zipWriter.js         chunked ZIP writer (JSZip, split into parts)
    csvWriter.js         streamed/chunked CSV writer (folder or downloaded parts)
    util.js
  vendor/               pre-built bundles of third-party libraries (see below)
  build/                esbuild scripts that produce vendor/*.bundle.js
```

## Rebuilding the vendor bundles

`vendor/qrcode.bundle.js` and `vendor/main-libs.bundle.js` are pre-built with
esbuild so the app has zero install step for end users. If you need to update
a dependency version:

```bash
cd web
npm install
npm run build
```

This regenerates the two files in `vendor/`, which are committed to the repo
like any other static asset.

## Browser support notes

- The "save to folder" output target needs the File System Access API
  (Chrome/Edge). Other browsers automatically fall back to ZIP download.
- PNG and base64 output need `OffscreenCanvas` inside a Web Worker (supported
  in current Chrome, Edge, and Firefox). If your browser doesn't support it,
  use SVG output instead — it works everywhere and is the recommended format
  for large runs anyway (smaller, infinitely scalable, no canvas needed).
