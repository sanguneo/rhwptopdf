const KOREAN_FALLBACK_FAMILIES = [
  "Malgun Gothic",
  "맑은 고딕",
  "Apple SD Gothic Neo",
  "Noto Sans CJK KR",
  "Noto Sans KR",
  "Batang",
  "바탕",
  "Dotum",
  "돋움",
  "Gulim",
  "굴림",
];

function matchesFamily(font, family) {
  return (
    font.family === family ||
    font.fullName === family ||
    font.postscriptName === family
  );
}

export function selectSystemFontCandidates(systemFonts, fontsRequired) {
  const matches = fontsRequired.flatMap((family) => {
    const match = systemFonts.find((font) => matchesFamily(font, family));
    return match ? [{ family, font: match }] : [];
  });
  if (matches.length > 0) return matches;

  for (const family of KOREAN_FALLBACK_FAMILIES) {
    const font = systemFonts.find((candidate) => matchesFamily(candidate, family));
    if (font) return [{ family, font }];
  }
  return [];
}
