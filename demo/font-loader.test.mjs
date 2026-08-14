import assert from "node:assert/strict";
import test from "node:test";

import { selectSystemFontCandidates } from "./public/font-loader.js";

test("selects an installed Korean fallback when document families do not match", () => {
  // Given
  const malgun = {
    family: "Malgun Gothic",
    fullName: "Malgun Gothic",
    postscriptName: "MalgunGothic",
  };
  const systemFonts = [
    { family: "Arial", fullName: "Arial", postscriptName: "ArialMT" },
    malgun,
  ];

  // When
  const candidates = selectSystemFontCandidates(systemFonts, ["함초롬바탕"]);

  // Then
  assert.deepEqual(candidates, [{ family: "Malgun Gothic", font: malgun }]);
});
