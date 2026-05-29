#!/usr/bin/env bash
# Build the bundler-targeted wasm-pack artifact for rhwptopdf.
#
# Sub-AC 2.4 from the Seed asks for:
#
#   > Produce a successful `wasm-pack build --target bundler --out-dir
#   > pkg-bundler` artifact with bundler-compatible JS glue; verified
#   > by a shell/CI test that runs the build and asserts
#   > `pkg-bundler/package.json` exists and its `module` field points
#   > to a `.js` file.
#
# This script is the canonical "produce the bundler artifact" step. It
# is intentionally separate from `verify_wasm_pack_bundler.sh` so that
# the same build command can later be reused by an npm publish flow
# (Exit Condition `publish_pass`) without re-doing the assertions.
#
# ## Why we patch the `module` field
#
# wasm-pack 0.10+ emits the bundler-target `package.json` using
# `"type": "module"` + `"main": "<entry>.js"`. With `type: module`,
# modern bundlers correctly treat `main` as ESM, so the artifact is
# already "bundler-compatible JS glue". However:
#
#   * The Seed's Sub-AC 2.4 literally requires a top-level `module`
#     field pointing to a `.js` file.
#   * The `module` field is also the long-standing legacy convention
#     understood by older bundler versions (webpack 4, rollup pre-v3)
#     that may still appear in consumer projects.
#
# So after wasm-pack finishes, we add a top-level `module` field whose
# value mirrors the `main` field. This is a *pure addition* — it does
# not change `main`, `type`, `files`, or anything wasm-pack already
# wrote — and is therefore safe to run on every build.
#
# ## Usage
#
#   scripts/build_pkg_bundler.sh
#
# ## Environment variables
#
#   WASM_PACK   override the wasm-pack binary (default: `wasm-pack`)
#   OUT_DIR     override the output directory (default: `pkg-bundler`,
#               relative to the crate root, exactly as the Seed names it)
#   DEV         set to "1" to pass `--dev` to wasm-pack (skip wasm-opt).
#               Defaults to "1" so the script is fast in CI; set DEV=0
#               for the actual publish build.
#
# ## Exit codes
#
#   0   success — pkg-bundler/ is ready and package.json has a
#       `module` field pointing to a `.js` file
#   1   wasm-pack not found, the build failed, or the post-build
#       patch failed

set -euo pipefail

# Resolve the crate root from the script's location, not $PWD, so the
# script works regardless of where the caller invoked it.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRATE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

WASM_PACK="${WASM_PACK:-wasm-pack}"
OUT_DIR_REL="${OUT_DIR:-pkg-bundler}"
DEV="${DEV:-1}"

# Permit OUT_DIR to be either crate-root-relative (default) or absolute.
case "${OUT_DIR_REL}" in
  /*) OUT_DIR="${OUT_DIR_REL}" ;;
  *)  OUT_DIR="${CRATE_ROOT}/${OUT_DIR_REL}" ;;
esac

if ! command -v "${WASM_PACK}" >/dev/null 2>&1; then
  echo "error: '${WASM_PACK}' is not on PATH" >&2
  echo "       install it with: cargo install wasm-pack --locked" >&2
  exit 1
fi

# We use `node` for the JSON patch because this package is published
# to npm — `node` is therefore a reasonable build-time dependency.
if ! command -v node >/dev/null 2>&1; then
  echo "error: 'node' is required to patch package.json with the 'module' field" >&2
  echo "       install Node.js >= 18 (https://nodejs.org/)" >&2
  exit 1
fi

echo "→ using $(command -v "${WASM_PACK}")"
echo "→ crate root: ${CRATE_ROOT}"
echo "→ out dir:    ${OUT_DIR}"

# Start from a clean out-dir so stale artifacts from a previous run
# can't accidentally make the consumer's bundler pick up old code.
rm -rf "${OUT_DIR}"

WASM_PACK_ARGS=(build --target bundler --out-dir "${OUT_DIR}")
if [[ "${DEV}" == "1" ]]; then
  WASM_PACK_ARGS+=(--dev)
fi

(
  cd "${CRATE_ROOT}"
  "${WASM_PACK}" "${WASM_PACK_ARGS[@]}"
)

PKG_JSON="${OUT_DIR}/package.json"
if [[ ! -f "${PKG_JSON}" ]]; then
  echo "error: wasm-pack did not produce ${PKG_JSON}" >&2
  exit 1
fi

# Post-build patch: add a top-level `module` field whose value mirrors
# `main`. Idempotent — re-running the script overwrites the field with
# the same value.
#
# We do the patch with `node` rather than `jq` because:
#   * `node` is already a hard dependency of an npm-published package,
#     whereas `jq` is not.
#   * Using `node` keeps the field ordering wasm-pack chose (we use
#     `Object.assign` style insertion that keeps existing keys).
#
# Note on argv indexing: `node -e "..." <arg>` exposes the user arg at
# `process.argv[1]` (not [2] — `-e` skips the script slot a normal
# `node script.js` invocation would occupy).
PATCH_SCRIPT='
const fs = require("fs");
const path = process.argv[1];
const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
if (typeof pkg.main !== "string" || !pkg.main.endsWith(".js")) {
  console.error("error: package.json `main` field is missing or does not end in .js");
  console.error("       got: " + JSON.stringify(pkg.main));
  process.exit(1);
}
// Insert `module` immediately after `main` so the resulting JSON has
// the two ES-module-entry fields visually adjacent. We rebuild the
// object key-by-key to control insertion order.
const out = {};
for (const k of Object.keys(pkg)) {
  out[k] = pkg[k];
  if (k === "main") {
    out.module = pkg.main;
  }
}
if (!("module" in out)) {
  // `main` was absent earlier in the object; append at the end.
  out.module = pkg.main;
}
fs.writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
console.log("ok: patched module field -> " + out.module);
'

node -e "${PATCH_SCRIPT}" "${PKG_JSON}"

echo "ok: ${OUT_DIR} ready"
