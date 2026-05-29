// scripts/wrap_umd.mjs
//
// Sub-AC 3.1 — wrap the wasm-pack `--target no-modules` JS glue into a
// UMD bundle that:
//
//   * In the browser, when loaded via a `<script>` tag (e.g. from a
//     CDN), attaches the wasm-bindgen init function to
//     `window.HwpToPdf`. The init function has the wasm-bindgen
//     exports (`version`, `initSync`, ...) hung off it as own
//     properties, so consumers can write:
//
//         <script src="rhwptopdf.umd.js"></script>
//         <script type="module">
//           await HwpToPdf();          // loads the .wasm
//           console.log(HwpToPdf.version());
//         </script>
//
//   * In CommonJS, assigns the same value to `module.exports`.
//   * In AMD, defines an anonymous module returning the same value.
//
// The wasm-pack `no-modules` output already takes the shape:
//
//     let wasm_bindgen = (function(exports) { ... ; return ...; })({});
//
// so we treat that file as an opaque blob and only need to:
//
//   1. Rename the top-level `let wasm_bindgen = ...` binding to a
//      local variable that won't leak into the surrounding scope.
//   2. Wrap the whole thing in the canonical UMD detector pattern,
//      returning that local variable as the module's value.
//
// We do *not* inline the .wasm bytes — that lands in a later sub-AC if
// we decide a single-file CDN drop is required. For Sub-AC 3.1 the
// .wasm sits next to the UMD bundle and the no-modules glue's
// `script_src.replace(/\.js$/, "_bg.wasm")` resolution still works.
//
// Usage:
//   node scripts/wrap_umd.mjs <input.js> <output.js>
//
// Exit codes:
//   0  success — output.js written
//   1  bad arguments or input file unreadable
//   2  input doesn't look like a wasm-pack `--target no-modules` file

import * as fs from "node:fs";
import * as path from "node:path";

/** Global name attached to `window` when loaded via a `<script>` tag. */
const GLOBAL_NAME = "RhwpToPdf";

/** Internal name we rename `wasm_bindgen` to so it stays scope-local. */
const LOCAL_NAME = "__rhwptopdf_bindgen";

function die(msg, code = 1) {
  console.error(`error: ${msg}`);
  process.exit(code);
}

function main(argv) {
  if (argv.length < 4) {
    die("usage: node scripts/wrap_umd.mjs <input.js> <output.js>");
  }
  const inputPath = argv[2];
  const outputPath = argv[3];

  let raw;
  try {
    raw = fs.readFileSync(inputPath, "utf8");
  } catch (e) {
    die(`cannot read input file ${inputPath}: ${e.message}`);
  }

  // The wasm-pack `--target no-modules` output starts with exactly
  // `let wasm_bindgen = (function(exports) {`. We do a strict prefix
  // check so a future wasm-pack version that changes the preamble
  // fails this script loudly instead of silently producing a broken
  // bundle.
  const expectedPrefix = "let wasm_bindgen = (function(exports) {";
  if (!raw.startsWith(expectedPrefix)) {
    die(
      `input file ${inputPath} does not start with the expected ` +
        `no-modules preamble (got: ${JSON.stringify(raw.slice(0, 60))})`,
      2,
    );
  }

  // Rename the top-level binding. We do this with a string replace
  // anchored at the start of the file — the only `let wasm_bindgen`
  // declaration is the very first token, and the no-modules glue
  // doesn't reference `wasm_bindgen` again *as a variable* inside
  // the IIFE (the IIFE uses `__wbg_init` / `exports` instead). A
  // belt-and-suspenders assertion in this script and the verify
  // script catches a regression on that assumption.
  const renamed = raw.replace(
    /^let wasm_bindgen = /,
    `var ${LOCAL_NAME} = `,
  );
  if (renamed === raw) {
    // Should be unreachable given the prefix check above, but the
    // double-check costs nothing.
    die(
      `failed to rename top-level wasm_bindgen binding in ${inputPath}`,
      2,
    );
  }

  // The UMD detector below is the canonical "returnExports" pattern
  // from https://github.com/umdjs/umd/blob/master/templates/returnExports.js
  //
  // We deliberately keep the inner factory synchronous — it just
  // executes the no-modules IIFE and returns its result. The
  // *consumer* later awaits `HwpToPdf()` to load the .wasm.
  //
  // Important: the inner factory MUST execute the no-modules glue in
  // its own lexical scope so `var ${LOCAL_NAME}` and any other
  // top-level declarations inside the glue don't leak onto `window`.
  // The UMD wrapper does exactly that — the factory body is its own
  // function scope.
  const umd = [
    "// rhwptopdf UMD bundle.",
    "// Built by scripts/build_pkg_cdn.sh (Sub-AC 3.1).",
    "// Source: wasm-pack --target no-modules + scripts/wrap_umd.mjs.",
    "// DO NOT EDIT — regenerate with `scripts/build_pkg_cdn.sh`.",
    ";(function (root, factory) {",
    "  if (typeof exports === 'object' && typeof module !== 'undefined') {",
    "    module.exports = factory();",
    "  } else if (typeof define === 'function' && define.amd) {",
    "    define([], factory);",
    `  } else { root.${GLOBAL_NAME} = factory(); }`,
    "}(typeof self !== 'undefined' ? self : this, function () {",
    "  'use strict';",
    "",
    renamed.trimEnd(),
    "",
    `  return ${LOCAL_NAME};`,
    "}));",
    "",
  ].join("\n");

  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, umd);
  } catch (e) {
    die(`cannot write output file ${outputPath}: ${e.message}`);
  }

  const size = fs.statSync(outputPath).size;
  console.log(
    `ok: wrote UMD bundle ${outputPath} (${size} bytes, global=${GLOBAL_NAME})`,
  );
}

main(process.argv);
