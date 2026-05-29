<h1 align="center">rhwptopdf</h1>

<p align="center">
  <strong>HWP / HWPX to PDF, right in the browser.</strong><br/>
  No install, no upload, fully offline.
</p>

<p align="center">
  <a href="https://github.com/sanguneo/rhwptopdf/actions/workflows/ci.yml">
    <img src="https://github.com/sanguneo/rhwptopdf/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <a href="https://sanguneo.github.io/rhwptopdf/">
    <img src="https://img.shields.io/badge/Demo-GitHub%20Pages-bd5b2f" alt="Demo" />
  </a>
  <a href="https://github.com/sanguneo/rhwptopdf/releases">
    <img src="https://img.shields.io/github/v/release/sanguneo/rhwptopdf?display_name=tag&color=blue" alt="Release" />
  </a>
  <a href="https://opensource.org/licenses/MIT">
    <img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" />
  </a>
  <a href="https://www.rust-lang.org/">
    <img src="https://img.shields.io/badge/Rust-1.70%2B-orange.svg" alt="Rust 1.70+" />
  </a>
  <a href="https://webassembly.org/">
    <img src="https://img.shields.io/badge/WebAssembly-Ready-654FF0.svg" alt="WASM" />
  </a>
</p>

<p align="center">
  <a href="README.md">한국어</a> · <strong>English</strong>
</p>

---

`rhwptopdf` is a WebAssembly library that converts Hancom Office documents
(`.hwp` / `.hwpx`) **directly inside the browser** into PDF. Files never leave
the user's machine — conversion runs entirely on the client.

> 📺 **[Live demo](https://sanguneo.github.io/rhwptopdf/)** &nbsp;·&nbsp;
> 📦 **[GitHub Release](https://github.com/sanguneo/rhwptopdf/releases/latest)** &nbsp;·&nbsp;
> 📑 **[CHANGELOG](CHANGELOG.md)**

<p align="center">
  <img src="assets/demo-screenshot.png" alt="rhwptopdf demo page" width="720" />
</p>

## ✨ Highlights

- 🦀 **Rust → WebAssembly** — single `.wasm` (6 MB) + UMD bundle (16 KB)
- 📄 **Multi-page PDF** — `svg2pdf` + `pdf-writer` assemble the page tree directly
- 🎨 **Vector glyphs** — text is baked as outline `path`s, so the output looks
  identical in every PDF viewer
- 🅰️ **System fonts first** — Chrome 105+ `window.queryLocalFonts` picks up OS
  Korean fonts when granted; bundled Hancom faces are the fallback
- 🔒 **Browser-only** — no uploads, no network round-trip
- 🪶 **MIT** — self-authored code is MIT; the cherry-picked rhwp modules ship
  under Apache-2.0 (preserved verbatim in `NOTICE`)

## 🚀 Quickstart

### 1. CDN-style `<script>`

```html
<script src="https://github.com/sanguneo/rhwptopdf/releases/latest/download/rhwptopdf.umd.js"></script>
<script type="module">
  // 1) Init WASM
  await RhwpToPdf({ module_or_path: ".../rhwptopdf.umd_bg.wasm" });

  // 2) Register fonts (required — once each)
  const ttf = new Uint8Array(await (await fetch("/fonts/HANBatang.ttf")).arrayBuffer());
  RhwpToPdf.registerPdfFont(ttf);

  // 3) HWP → PDF
  const hwpBytes = new Uint8Array(await file.arrayBuffer());
  const info     = RhwpToPdf.analyzeHwp(hwpBytes);   // { pageCount, fontsRequired }
  const pdfBytes = RhwpToPdf.hwpToPdf(hwpBytes);     // Uint8Array (multi-page PDF)
</script>
```

### 2. Run the demo locally

```sh
git clone https://github.com/sanguneo/rhwptopdf
cd rhwptopdf/demo
npm start                 # http://127.0.0.1:8788
```

## 🔁 Conversion pipeline

Each page goes through five stages:

```
┌──────────┐   ┌────────────┐   ┌────────────┐   ┌────────────┐   ┌────────────┐
│ HWP/HWPX │──▶│ SvgRenderer│──▶│ font-family│──▶│   usvg     │──▶│ pdf-writer │──▶ PDF
│  bytes   │   │ (96 dpi px)│   │ normalize  │   │ text→path  │   │ page tree  │
└──────────┘   └────────────┘   └────────────┘   └────────────┘   └────────────┘
                    │                  │                │                  │
                    │                  │                ▼                  ▼
                    │                  │      fontdb (registered)   media_box = px × 72/96
                    ▼                  ▼
              one SVG page    serif / sans-serif
              (body + table   generic family
               + equation)
```

Stage-by-stage:

1. **`SvgRenderer`** — HWP page (body, tables, shapes, equations) → SVG at
   96 dpi pixel units.
2. **`font-family` normalization** — every `font-family="..."` is collapsed to
   `serif` / `sans-serif` based on a keyword classifier (`바탕` / `명조` /
   `궁서` → `serif`; `돋움` / `고딕` / `굴림` → `sans-serif`).
3. **`usvg` text-to-path** — text is converted to glyph paths using the
   registered fontdb. If the fontdb is empty, glyphs come out blank — call
   `registerPdfFont(bytes)` before `hwpToPdf`.
4. **`svg2pdf::to_chunk`** — SVG → PDF XObject chunk.
5. **`pdf-writer`** — chunks are stitched into a page tree; the `media_box`
   uses `px × 72/96 → pt` so pages come out as standard A4 (`595 × 842 pt`).

> The output stores glyphs as vector paths, so the PDF renders identically in
> any viewer. The fontdb requirement is the price for that consistency.

## 📚 API

```ts
// Entry points
function version(): string;
function analyzeHwp(bytes: Uint8Array): AnalyzeResult;  // { pageCount, fontsRequired }
function hwpToPdf(bytes: Uint8Array): Uint8Array;       // multi-page PDF bytes

// PDF-side font registry
function registerPdfFont(bytes: Uint8Array): string;    // auto-detected family name
function clearPdfFonts(): void;
function pdfFontStatus(): string;                       // JSON debug

// Extras
function extractThumbnail(bytes: Uint8Array): unknown;  // PrvImage extraction
```

The demo also exposes a JS-only `HwpToPdfJob extends EventTarget` wrapper that
emits `progress` / `complete` / `error` events around the call sequence —
see `demo/public/app.js`.

## 🌱 Origin — Forked from rhwp

`rhwptopdf` is a **separate track** that cherry-picks the HWP/HWPX parser +
layout renderer from [`edwardkim/rhwp`](https://github.com/edwardkim/rhwp)
(Apache-2.0). While upstream rhwp is a full viewer / editor, this project is
a minimal package that adds one thing: a PDF output pipeline.

```
2026-04   edwardkim/rhwp v0.7.x
            │ HWP 5.0 / HWPX parser, pagination, SVG/Canvas rendering
            │ (Apache-2.0)
            │
            ▼ cherry-pick parser/ + parts of renderer/
2026-05   rhwptopdf v0.1.0  ← you are here
            │ + svg2pdf + pdf-writer to assemble multi-page PDFs
            │ + Font Access API integration (system fonts first, static fallback)
            │ + wasm-pack UMD bundle + browser demo (GitHub Pages)
            │ + slimmed down: removed editor, diagnostics, CLI tooling
            │ (MIT — Apache-2.0 attribution preserved in NOTICE)
            ▼
        Browser-only HWP → PDF converter — one `.umd.js` + one `.wasm`
```

See [`NOTICE`](NOTICE) for the exact attribution and the list of preserved
upstream modules.

## 🛠️ Build

```sh
# 1) Build the WASM cdylib
wasm-pack build --target no-modules --release --out-dir pkg-bundler --out-name rhwptopdf

# 2) Wrap wasm-bindgen output into a UMD bundle (window.RhwpToPdf)
node scripts/wrap_umd.mjs pkg-bundler/rhwptopdf.js pkg-bundler/rhwptopdf.umd.js

# 3) Alias .wasm path the UMD loader looks for
cp pkg-bundler/rhwptopdf_bg.wasm pkg-bundler/rhwptopdf.umd_bg.wasm
```

Artifacts:

| File | Purpose | Size |
|---|---|---|
| `rhwptopdf.umd.js` | `window.RhwpToPdf` global (UMD) | ~ 16 KB |
| `rhwptopdf.umd_bg.wasm` | Runtime WASM | ~ 6.1 MB |
| `rhwptopdf.d.ts` | TypeScript definitions | — |

## 📜 License

- This project (rhwptopdf) — **MIT**, © 2026 sanguneo. See [`LICENSE`](LICENSE).
- Upstream [`edwardkim/rhwp`](https://github.com/edwardkim/rhwp) —
  **Apache License 2.0**, © Edward Kim and contributors. Parser / renderer
  modules cherry-picked.

The Apache-2.0 attribution, list of modifications, and the upstream license
text live in [`NOTICE`](NOTICE) and must be preserved on every redistribution
(source or binary) per Apache-2.0 § 4.
