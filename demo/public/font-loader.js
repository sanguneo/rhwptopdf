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

// 자모 / 완성형 한글 음절 — 문서가 요구한 family 이름이 한글이면 한글 글리프가
// 필요한 문서로 간주한다.
const HANGUL_PATTERN = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/;

function matchesFamily(font, family) {
  return (
    font.family === family ||
    font.fullName === family ||
    font.postscriptName === family
  );
}

/** 이 family 가 한글 글리프를 커버한다고 볼 수 있는지. */
export function isKoreanCapableFamily(family) {
  return HANGUL_PATTERN.test(family) || KOREAN_FALLBACK_FAMILIES.includes(family);
}

/** 문서가 요구한 family 목록에 한글 글꼴이 포함되어 있는지. */
export function requiresKorean(fontsRequired) {
  return Array.from(fontsRequired ?? []).some((family) =>
    HANGUL_PATTERN.test(family),
  );
}

function findKoreanFallback(systemFonts) {
  for (const family of KOREAN_FALLBACK_FAMILIES) {
    const font = systemFonts.find((candidate) => matchesFamily(candidate, family));
    if (font) return { family, font };
  }
  return null;
}

export function selectSystemFontCandidates(systemFonts, fontsRequired) {
  const required = Array.from(fontsRequired ?? []);
  const matches = required.flatMap((family) => {
    const match = systemFonts.find((font) => matchesFamily(font, family));
    return match ? [{ family, font: match }] : [];
  });

  // 라틴 글꼴 하나가 매칭됐다는 이유로 한글 폴백을 건너뛰면 한글이 전부 두부로
  // 렌더된다. 한글이 필요한 문서인데 매칭된 글꼴 중 한글 커버리지가 없으면
  // 폴백을 "추가로" 붙인다.
  const koreanCovered = matches.some(({ family }) => isKoreanCapableFamily(family));
  if (matches.length > 0 && (!requiresKorean(required) || koreanCovered)) {
    return matches;
  }

  const fallback = findKoreanFallback(systemFonts);
  return fallback ? [...matches, fallback] : matches;
}
