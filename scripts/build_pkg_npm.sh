#!/usr/bin/env bash
# Build the complete npm-publishable package for rhwptopdf.
#
# Sub-AC 3.3 from the Seed asks for:
#
#   > Add a packaging/publish-config test that verifies the npm package's
#   > `unpkg`/`jsdelivr` fields point to the UMD bundle and that fetching
#   > the resolved CDN path (or a simulated equivalent) returns the same
#   > bytes as the local artifact.
#
# This script is the canonical "produce the npm-publishable directory"
# step. It composes the two pre-existing builds:
#
#   1. `scripts/build_pkg_bundler.sh` — wasm-pack `--target bundler`
#      output, which is what an `npm install rhwptopdf` + modern
#      bundler consumer imports. Produces `pkg-bundler/` with
#      `module` and `main` fields pointing at `rhwptopdf.js`.
#
#   2. `scripts/build_pkg_cdn.sh` — wasm-pack `--target no-modules`
#      output, re-wrapped into a UMD bundle by `scripts/wrap_umd.mjs`.
#      Produces a `rhwptopdf.umd.js` + `rhwptopdf.umd_bg.wasm`
#      pair that a bundler-less `<script>`-tag consumer loads from
#      unpkg/jsdelivr.
#
# This script merges the second pair *into* the first directory, then
# adds the publish-config fields (`unpkg`, `jsdelivr`, `browser`) to
# `pkg-bundler/package.json` so a CDN URL like
#
#     https://unpkg.com/rhwptopdf@<v>/rhwptopdf.umd.js
#
# resolves to the UMD bundle file the script just placed under
# `pkg-bundler/`. The `browser` field is the conventional hint that
# tells browser-aware bundlers (webpack/browserify) and CDNs which
# self-contained build to serve in a browser context; per Sub-AC 3.2
# it points at the same UMD bundle as `unpkg`/`jsdelivr` so all three
# CDN fields resolve to one canonical file.
#
# ## Why one directory instead of two
#
# unpkg and jsdelivr serve files *inside the published npm tarball* —
# they do not have access to a sibling `pkg-cdn/` directory at the
# repository root. The published artifact must therefore contain both
# the bundler glue and the UMD bundle. Keeping the source build
# pipelines (`build_pkg_bundler.sh` and `build_pkg_cdn.sh`) separate is
# still useful for their own sub-AC tests (2.4, 3.1, 3.2), so this
# script composes them rather than rewriting them.
#
# ## Usage
#
#   scripts/build_pkg_npm.sh
#
# ## Environment variables
#
#   WASM_PACK   override the wasm-pack binary (default: `wasm-pack`)
#   OUT_DIR     override the merged output directory
#               (default: `pkg-bundler`, exactly where the bundler
#               build already lands and the AC 2.4 test reads from)
#   DEV         set to "1" to pass `--dev` to wasm-pack (skip wasm-opt).
#               Defaults to "1" so the script is fast in CI; set DEV=0
#               for the actual publish build.
#
# ## Exit codes
#
#   0   success — OUT_DIR is ready, package.json has `unpkg`,
#       `jsdelivr`, and `browser` fields pointing to a non-empty UMD
#       bundle file present in OUT_DIR
#   1   wasm-pack/node not found, any sub-build failed, or the
#       publish-config patch failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRATE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

WASM_PACK="${WASM_PACK:-wasm-pack}"
OUT_DIR_REL="${OUT_DIR:-pkg-bundler}"
DEV="${DEV:-1}"

case "${OUT_DIR_REL}" in
  /*) OUT_DIR="${OUT_DIR_REL}" ;;
  *)  OUT_DIR="${CRATE_ROOT}/${OUT_DIR_REL}" ;;
esac

if ! command -v "${WASM_PACK}" >/dev/null 2>&1; then
  echo "error: '${WASM_PACK}' is not on PATH" >&2
  echo "       install it with: cargo install wasm-pack --locked" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "error: 'node' is required to patch package.json" >&2
  echo "       install Node.js >= 18 (https://nodejs.org/)" >&2
  exit 1
fi

echo "→ using $(command -v "${WASM_PACK}")"
echo "→ crate root: ${CRATE_ROOT}"
echo "→ out dir:    ${OUT_DIR}"

# ----------------------------------------------------------------------
# Step 1: Build the bundler-target artifact into OUT_DIR.
# build_pkg_bundler.sh handles its own `rm -rf "${OUT_DIR}"` at the top,
# so we don't need to clean here.
# ----------------------------------------------------------------------
echo "→ Step 1/3 — building bundler-target wasm-pack artifact"
WASM_PACK="${WASM_PACK}" OUT_DIR="${OUT_DIR}" DEV="${DEV}" \
  "${SCRIPT_DIR}/build_pkg_bundler.sh"

# ----------------------------------------------------------------------
# Step 2: Build the UMD bundle into a separate staging directory under
# target/ so build_pkg_cdn.sh's `rm -rf "${OUT_DIR}"` does NOT wipe the
# bundler artifact we just produced. After the build completes we copy
# the two UMD files (`.umd.js` + `.umd_bg.wasm`) into OUT_DIR.
# ----------------------------------------------------------------------
echo "→ Step 2/3 — building UMD bundle in staging dir"
# Staging directories are env-overridable (with absolute-path defaults)
# so parallel callers — e.g. the Sub-AC 3.2 CDN-fields test and the
# Sub-AC 3.3 publish-config test — can each point at a private staging
# tree and never race on `rm -rf` of a shared directory.
UMD_STAGE="${UMD_STAGE:-${CRATE_ROOT}/target/wasm-pack-build/pkg-npm-umd-merge}"
UMD_WASM_STAGE="${UMD_WASM_STAGE:-${CRATE_ROOT}/target/wasm-pack-build/pkg-npm-umd-stage}"
WASM_PACK="${WASM_PACK}" \
  OUT_DIR="${UMD_STAGE}" \
  STAGE_DIR="${UMD_WASM_STAGE}" \
  DEV="${DEV}" \
  "${SCRIPT_DIR}/build_pkg_cdn.sh"

UMD_JS_SRC="${UMD_STAGE}/rhwptopdf.umd.js"
UMD_WASM_SRC="${UMD_STAGE}/rhwptopdf.umd_bg.wasm"
if [[ ! -s "${UMD_JS_SRC}" ]]; then
  echo "error: ${UMD_JS_SRC} is missing or empty after UMD build" >&2
  exit 1
fi
if [[ ! -s "${UMD_WASM_SRC}" ]]; then
  echo "error: ${UMD_WASM_SRC} is missing or empty after UMD build" >&2
  exit 1
fi

echo "→ copying UMD artifacts into ${OUT_DIR}"
cp "${UMD_JS_SRC}"   "${OUT_DIR}/rhwptopdf.umd.js"
cp "${UMD_WASM_SRC}" "${OUT_DIR}/rhwptopdf.umd_bg.wasm"

# ----------------------------------------------------------------------
# Step 2b: Ship the canonical CHANGELOG.md inside the published tarball.
#
# npm does NOT auto-include CHANGELOG.md the way it always-includes
# README and LICENSE (verified against npm 11): with a `files` whitelist
# present, anything not listed is dropped. The open_source_readiness
# evaluation principle requires the CHANGELOG to ship at v1, and Sub-AC
# 14.2 pins this with a test that runs `npm pack` against OUT_DIR and
# asserts a top-level CHANGELOG.md entry. So we copy the crate-root
# CHANGELOG.md into OUT_DIR here and add it to the `files` whitelist in
# Step 3 below. The packaged copy is byte-identical to the canonical
# repo-root file (the test enforces this).
# ----------------------------------------------------------------------
CHANGELOG_SRC="${CRATE_ROOT}/CHANGELOG.md"
if [[ ! -s "${CHANGELOG_SRC}" ]]; then
  echo "error: ${CHANGELOG_SRC} is missing or empty — a CHANGELOG.md is" >&2
  echo "       required for an open-source v1 release (Sub-AC 14.2)." >&2
  exit 1
fi
echo "→ copying CHANGELOG.md into ${OUT_DIR}"
cp "${CHANGELOG_SRC}" "${OUT_DIR}/CHANGELOG.md"

# ----------------------------------------------------------------------
# Step 3: Patch OUT_DIR/package.json with:
#   * `unpkg`     → "./rhwptopdf.umd.js"
#   * `jsdelivr`  → "./rhwptopdf.umd.js"
#   * `browser`   → "./rhwptopdf.umd.js"
#   * append the UMD files to the `files` whitelist so they make it
#     into the published tarball.
#
# Idempotent — re-running the script overwrites the three CDN fields
# with the same value and de-duplicates the `files` entries.
#
# Note on argv indexing: `node -e "..." <arg>` exposes the user arg at
# `process.argv[1]`.
# ----------------------------------------------------------------------
echo "→ Step 3/3 — patching package.json with unpkg/jsdelivr/browser fields"
PKG_JSON="${OUT_DIR}/package.json"
if [[ ! -f "${PKG_JSON}" ]]; then
  echo "error: ${PKG_JSON} is missing — build_pkg_bundler.sh failed silently?" >&2
  exit 1
fi

PATCH_SCRIPT='
const fs = require("fs");
const path = process.argv[1];
const pkg = JSON.parse(fs.readFileSync(path, "utf8"));

// The UMD bundle filename we just copied into OUT_DIR. The leading "./"
// is the conventional package.json relative-path form; unpkg/jsdelivr
// both accept it and the file lookup is identical to "rhwptopdf.umd.js".
const UMD_PATH = "./rhwptopdf.umd.js";
const UMD_WASM_PATH = "./rhwptopdf.umd_bg.wasm";

// Insert unpkg + jsdelivr + browser immediately after `module` so the
// publish-related CDN fields cluster together in the resulting JSON.
// We rebuild the object key-by-key to control insertion order. All
// three point to the same canonical UMD bundle (Sub-AC 3.2).
const out = {};
for (const k of Object.keys(pkg)) {
  // Skip any pre-existing copies of the fields we are about to set so
  // they cannot appear twice when we rebuild the object below.
  if (k === "unpkg" || k === "jsdelivr" || k === "browser") continue;
  out[k] = pkg[k];
  if (k === "module") {
    out.unpkg = UMD_PATH;
    out.jsdelivr = UMD_PATH;
    out.browser = UMD_PATH;
  }
}
// Defensive fallback if `module` was absent (would mean
// build_pkg_bundler.sh broke its contract — caught by the AC 2.4 test
// already, but still: dont silently swallow).
if (!("unpkg" in out)) {
  out.unpkg = UMD_PATH;
  out.jsdelivr = UMD_PATH;
  out.browser = UMD_PATH;
}

// Ensure the UMD files are in the `files` whitelist so they end up in
// the npm tarball. wasm-pack writes `files` as an array; we de-dup
// while preserving original order.
if (!Array.isArray(out.files)) {
  out.files = [];
}
const wantedFiles = [
  "rhwptopdf.umd.js",
  "rhwptopdf.umd_bg.wasm",
  // CHANGELOG.md is not auto-included by npm when a `files` whitelist is
  // present, so list it explicitly to guarantee it ships (Sub-AC 14.2).
  "CHANGELOG.md",
];
for (const f of wantedFiles) {
  if (!out.files.includes(f)) {
    out.files.push(f);
  }
}

fs.writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
console.log("ok: patched unpkg/jsdelivr/browser -> " + out.unpkg);
console.log("ok: files now includes UMD artifacts");
'

node -e "${PATCH_SCRIPT}" "${PKG_JSON}"

# ----------------------------------------------------------------------
# Final sanity checks before declaring success.
# ----------------------------------------------------------------------
UMD_JS_OUT="${OUT_DIR}/rhwptopdf.umd.js"
UMD_WASM_OUT="${OUT_DIR}/rhwptopdf.umd_bg.wasm"
if [[ ! -s "${UMD_JS_OUT}" ]]; then
  echo "error: ${UMD_JS_OUT} is missing or empty after merge" >&2
  exit 1
fi
if [[ ! -s "${UMD_WASM_OUT}" ]]; then
  echo "error: ${UMD_WASM_OUT} is missing or empty after merge" >&2
  exit 1
fi

echo "ok: ${OUT_DIR} ready for npm publish"
echo "    package.json : ${PKG_JSON}"
echo "    umd js       : ${UMD_JS_OUT} ($(wc -c < "${UMD_JS_OUT}") bytes)"
echo "    umd wasm     : ${UMD_WASM_OUT} ($(wc -c < "${UMD_WASM_OUT}") bytes)"
