# Changelog

All notable changes to **rhwptopdf** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.2] - 2026-08-24

Korean local-font coverage fix for the browser demo.

### Fixed

- A single matching Latin family (for example `Palatino Linotype`) no longer
  masks the Korean fallback: `selectSystemFontCandidates` now appends an
  installed Korean family instead of replacing the match set, so a document
  requesting `함초롬바탕` / `HY헤드라인M` renders real glyphs instead of tofu.
- The demo refuses to report success when a Hangul document ends up with no
  Korean-capable font registered, instead of emitting a blank-glyph PDF.
- Verified end to end in Chromium with the Font Access API granted: fontdb goes
  from `{"count":1,"sansSerif":"Palatino Linotype"}` to
  `{"count":2,"sansSerif":"Malgun Gothic"}` and both pages render Korean text.

## [0.2.1] - 2026-08-14

Local-font fallback reliability release.

### Fixed

- Restored visible PDF text when a document's requested font family does not
  exactly match an installed system font. The browser demo now selects a known
  Korean fallback such as `Malgun Gothic`, registers it with the WASM PDF
  fontdb, and refuses to emit a silently blank PDF when no font can be loaded.
- Added a deterministic regression test for the local Korean fallback
  selection path.

## [0.2.0] - 2026-08-14

Robustness and text-fidelity release.

### Added

- Verified Hancom PUA display table (`src/renderer/hancom_pua.rs`): 12
  Hancom-PDF-verified private-use codepoints now project to public-font
  glyphs during paint and width measurement (adds the `▸ ► ■ ↵` bullets and
  the `한글과컴퓨터` header glyphs). Previously only two codepoints were
  mapped and the rest rendered as tofu or a wrong bullet.
- CI now runs the test suite (`cargo test`) on every push and pull request,
  not just the native and WebAssembly builds.

### Security

- Bounded HWP3 body decompression output at `HWP3_MAX_RECORD_SIZE` (256 MiB)
  via `Read::take`, rejecting a decompression bomb instead of inflating a
  few-KB stream to gigabytes and OOM-killing the 32-bit WebAssembly host.
  This closes the last unbounded inflate after the CFB
  (`MAX_DECOMPRESSED_SIZE`) and HWPX (`MAX_BINDATA_SIZE`) guards.

### Fixed

- Repaired the `cargo test --lib` target and made sample-dependent tests
  skip cleanly when the gitignored `samples/` directory is absent.

## [0.1.0] - 2026-05-29

Initial release. HWP/HWPX → multi-page PDF conversion in the browser via
Rust → WebAssembly, with an in-tree demo page.

### Added

- Rust crate `rhwptopdf` (cdylib + rlib) that builds to WebAssembly via
  `wasm-pack --target no-modules` and is wrapped into a UMD bundle by
  `scripts/wrap_umd.mjs`, exposing the `RhwpToPdf` global on `window`.
- Public WASM API:
  - `version()` → semver string.
  - `analyzeHwp(bytes)` → `{ pageCount, fontsRequired }`.
  - `hwpToPdf(bytes)` → multi-page PDF `Uint8Array`.
  - `registerPdfFont(bytes)` / `clearPdfFonts()` / `pdfFontStatus()` —
    PDF-side font registry. Caller registers TTF/OTF bytes before
    converting; the first registered font's family name is auto-detected
    via `ttf-parser` and pushed into `usvg` fontdb's serif/sans-serif
    fallback slots based on a keyword classifier.
  - `extractThumbnail(bytes)` — light-weight `PrvImage` extraction.
- Conversion pipeline: per page, `SvgRenderer` (96 dpi pixels) emits an
  SVG → `font-family` is normalized to `serif`/`sans-serif` so generic
  fallback always lands on a registered font → `usvg` text-to-path with
  the registered fontdb → `svg2pdf::to_chunk` → `pdf-writer` assembly.
  `media_box` is converted `px × 72/96 → pt` so pages come out as
  standard A4.
- `demo/` — in-tree browser page (Node static server on port 8788) that
  drives the UMD bundle in `demo/vendor/`:
  - Dropzone + primary CTA + 4-step stepper (analyze → fonts → convert →
    done) + collapsible execution log + PDF iframe preview with a
    placeholder empty state.
  - `HwpToPdfJob extends EventTarget` wrapper that dispatches
    `progress`/`complete`/`error` events the page subscribes to.
  - Font Access API (Chrome 105+ `window.queryLocalFonts`) for using
    OS-installed Korean fonts when the `local-fonts` permission is
    granted; otherwise falls back to `demo/public/fonts/HANBatang.ttf` +
    `HANDotum.ttf` (untracked by `.gitignore`; see fonts/README.md).
- MIT `LICENSE`; upstream rhwp Apache-2.0 attribution preserved in
  `NOTICE` (parser + renderer modules are a cherry-pick from
  https://github.com/edwardkim/rhwp).

[0.2.1]: https://github.com/sanguneo/rhwptopdf/releases/tag/v0.2.1
[0.2.0]: https://github.com/sanguneo/rhwptopdf/releases/tag/v0.2.0
[0.1.0]: https://github.com/sanguneo/rhwptopdf/releases/tag/v0.1.0
