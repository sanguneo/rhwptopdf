# demo fonts

이 디렉토리는 `app.js` 가 `registerPdfFont` 로 등록할 정적 fallback 폰트를
둡니다. 저작권 / 파일 크기 문제로 git 추적은 하지 않습니다.

## 필요한 파일

- `HANBatang.ttf` — 함초롬바탕 (HCR Batang) 계열
- `HANDotum.ttf`  — 함초롬돋움 (HCR Dotum) 계열

Chrome / Edge 데스크탑에서 Font Access API 권한을 허용하면 시스템 폰트가
우선 사용되고, 이 폴더의 폰트는 미지원 / 거부 / 미매칭 시 fallback 으로만
사용됩니다.
