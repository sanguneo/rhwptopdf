import assert from "node:assert/strict";
import test from "node:test";

import {
  requiresKorean,
  selectSystemFontCandidates,
} from "./public/font-loader.js";

const ARIAL = { family: "Arial", fullName: "Arial", postscriptName: "ArialMT" };
const MALGUN = {
  family: "Malgun Gothic",
  fullName: "Malgun Gothic",
  postscriptName: "MalgunGothic",
};
const PALATINO = {
  family: "Palatino Linotype",
  fullName: "Palatino Linotype",
  postscriptName: "PalatinoLinotype",
};

test("appends a Korean fallback when only a Latin family matched", () => {
  // Given
  const systemFonts = [PALATINO, MALGUN, ARIAL];
  const fontsRequired = ["함초롬바탕", "HY헤드라인M", "Palatino Linotype"];

  // When
  const candidates = selectSystemFontCandidates(systemFonts, fontsRequired);

  // Then
  assert.deepEqual(candidates, [
    { family: "Palatino Linotype", font: PALATINO },
    { family: "Malgun Gothic", font: MALGUN },
  ]);
});

test("keeps only the matches when a Korean family already matched", () => {
  // Given
  const malgunKo = {
    family: "맑은 고딕",
    fullName: "Malgun Gothic",
    postscriptName: "MalgunGothic",
  };
  const systemFonts = [PALATINO, malgunKo];
  const fontsRequired = ["맑은 고딕", "Palatino Linotype"];

  // When
  const candidates = selectSystemFontCandidates(systemFonts, fontsRequired);

  // Then
  assert.deepEqual(candidates, [
    { family: "맑은 고딕", font: malgunKo },
    { family: "Palatino Linotype", font: PALATINO },
  ]);
});

test("does not add a Korean fallback for a Latin-only document", () => {
  // Given / When
  const candidates = selectSystemFontCandidates(
    [PALATINO, MALGUN],
    ["Palatino Linotype"],
  );

  // Then
  assert.deepEqual(candidates, [{ family: "Palatino Linotype", font: PALATINO }]);
});

test("requiresKorean detects Hangul family names", () => {
  assert.equal(requiresKorean(["Palatino Linotype", "휴먼명조"]), true);
  assert.equal(requiresKorean(["Palatino Linotype", "Arial"]), false);
  assert.equal(requiresKorean(undefined), false);
});

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
