#!/usr/bin/env bash
# Build the CDN-targeted UMD artifact for rhwptopdf.
#
# Sub-AC 3.1 from the Seed asks for:
#
#   > Configure wasm-pack/build pipeline to emit a UMD bundle
#   > artifact from the crate, with a runnable test asserting the
#   > built file exists and exposes the expected global
#   > (e.g., `window.RhwpToPdf`) when evaluated in a jsdom environment.
#
# The bundler-target build (`pkg-bundler/`) covers the "npm + modern
# bundler" consumption path (Sub-AC 2.4). This script covers the
# *bundler-less* consumption path (parent AC 3): a single JS file
# that a consumer can drop into a `<script>` tag from unpkg or
# jsdelivr and have a `RhwpToPdf` global appear on `window`.
#
# ## Pipeline
#
#   1. Run `wasm-pack build --target no-modules --out-dir
#      target/wasm-pack-build/cdn-stage`. We use `--target
#      no-modules` rather than `--target web` because wasm-pack's
#      `web` output is an ES module that uses static `import` —
#      that can't be loaded via a `<script>` tag without a bundler
#      or `type="module"` + import-map gymnastics. The `no-modules`
#      output, by contrast, is a single self-contained IIFE that
#      attaches a `wasm_bindgen` global to the surrounding scope.
#
#   2. Run `node scripts/wrap_umd.mjs` over the staged glue to:
#        * rename the top-level `let wasm_bindgen = ...` binding so
#          it doesn't leak onto `window`,
#        * wrap the whole thing in the canonical UMD detector
#          pattern, exposing the result as `RhwpToPdf` (browser
#          global), `module.exports` (CommonJS), or the value
#          returned from the AMD factory.
#
#   3. Copy the `.wasm` binary next to the UMD bundle so the
#      no-modules glue's `script_src.replace(/\.js$/, "_bg.wasm")`
#      resolution finds it when a consumer loads the bundle from a
#      CDN.
#
# The bundle does *not* inline the .wasm bytes — that would push the
# CDN download size past ~50KB-of-glue into multi-MB territory, and
# the .wasm-next-to-.js layout is exactly what unpkg/jsdelivr serve
# by default.
#
# ## Usage
#
#   scripts/build_pkg_cdn.sh
#
# ## Environment variables
#
#   WASM_PACK   override the wasm-pack binary (default: `wasm-pack`)
#   OUT_DIR     override the final UMD output directory
#               (default: `pkg-cdn`, crate-root-relative)
#   STAGE_DIR   override the wasm-pack staging directory (default:
#               `target/wasm-pack-build/cdn-stage`, crate-root-relative).
#               Parallel cargo tests pass a per-test path here so they
#               don't race on the staging directory.
#   DEV         set to "1" to pass `--dev` to wasm-pack (skip
#               wasm-opt). Defaults to "1" so the script is fast in
#               CI / `cargo test`; set DEV=0 for a release build.
#
# ## Exit codes
#
#   0   success — pkg-cdn/rhwptopdf.umd.js exists and is non-empty,
#       and pkg-cdn/rhwptopdf_bg.wasm exists and is non-empty
#   1   wasm-pack not found, node not found, build failed, or the
#       UMD wrap step failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRATE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

WASM_PACK="${WASM_PACK:-wasm-pack}"
OUT_DIR_REL="${OUT_DIR:-pkg-cdn}"
STAGE_DIR_REL="${STAGE_DIR:-target/wasm-pack-build/cdn-stage}"
DEV="${DEV:-1}"

# Resolve OUT_DIR to absolute. Allow callers to pass either a
# crate-root-relative path (default) or an absolute path.
case "${OUT_DIR_REL}" in
  /*) OUT_DIR="${OUT_DIR_REL}" ;;
  *)  OUT_DIR="${CRATE_ROOT}/${OUT_DIR_REL}" ;;
esac

# Same treatment for STAGE_DIR — defaults to target/wasm-pack-build/cdn-stage
# under the crate root so `cargo clean` wipes it, but parallel test
# runs can override with a per-test path.
case "${STAGE_DIR_REL}" in
  /*) STAGE_DIR="${STAGE_DIR_REL}" ;;
  *)  STAGE_DIR="${CRATE_ROOT}/${STAGE_DIR_REL}" ;;
esac

if ! command -v "${WASM_PACK}" >/dev/null 2>&1; then
  echo "error: '${WASM_PACK}' is not on PATH" >&2
  echo "       install it with: cargo install wasm-pack --locked" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "error: 'node' is required to wrap the no-modules glue into UMD" >&2
  echo "       install Node.js >= 18 (https://nodejs.org/)" >&2
  exit 1
fi

echo "→ using $(command -v "${WASM_PACK}")"
echo "→ crate root: ${CRATE_ROOT}"
echo "→ stage dir:  ${STAGE_DIR}"
echo "→ out dir:    ${OUT_DIR}"

# Start from a clean stage- and out-dir so stale artifacts from a
# previous run can't accidentally be picked up.
rm -rf "${STAGE_DIR}" "${OUT_DIR}"

WASM_PACK_ARGS=(build --target no-modules --out-dir "${STAGE_DIR}")
if [[ "${DEV}" == "1" ]]; then
  WASM_PACK_ARGS+=(--dev)
fi

(
  cd "${CRATE_ROOT}"
  "${WASM_PACK}" "${WASM_PACK_ARGS[@]}"
)

STAGE_JS="${STAGE_DIR}/rhwptopdf.js"
STAGE_WASM="${STAGE_DIR}/rhwptopdf_bg.wasm"

if [[ ! -f "${STAGE_JS}" ]]; then
  echo "error: wasm-pack did not produce ${STAGE_JS}" >&2
  exit 1
fi
if [[ ! -f "${STAGE_WASM}" ]]; then
  echo "error: wasm-pack did not produce ${STAGE_WASM}" >&2
  exit 1
fi

# Wrap the no-modules glue into UMD.
mkdir -p "${OUT_DIR}"
UMD_JS="${OUT_DIR}/rhwptopdf.umd.js"
node "${SCRIPT_DIR}/wrap_umd.mjs" "${STAGE_JS}" "${UMD_JS}"

# Copy the .wasm binary next to the UMD bundle so the no-modules
# glue's `script_src.replace(/\.js$/, "_bg.wasm")` resolution finds
# it when the bundle is served from a CDN. The filename suffix
# matches what wasm-pack writes upstream — we don't rename it.
cp "${STAGE_WASM}" "${OUT_DIR}/rhwptopdf.umd_bg.wasm"

# Sanity-check the artifacts before declaring success.
if [[ ! -s "${UMD_JS}" ]]; then
  echo "error: ${UMD_JS} is empty after UMD wrap" >&2
  exit 1
fi
if [[ ! -s "${OUT_DIR}/rhwptopdf.umd_bg.wasm" ]]; then
  echo "error: ${OUT_DIR}/rhwptopdf.umd_bg.wasm is empty after copy" >&2
  exit 1
fi

echo "ok: ${OUT_DIR} ready"
echo "    js   : ${UMD_JS} ($(wc -c < "${UMD_JS}") bytes)"
echo "    wasm : ${OUT_DIR}/rhwptopdf.umd_bg.wasm ($(wc -c < "${OUT_DIR}/rhwptopdf.umd_bg.wasm") bytes)"
