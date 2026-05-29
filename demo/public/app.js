// rhwptopdf 브라우저 데모
//
// `/vendor/rhwptopdf.umd.js` 가 `window.RhwpToPdf` 글로벌을 노출한다.
// 초기화 후 wrapped 함수는 `RhwpToPdf` 자체의 own property 로 붙으므로
// 항상 `RhwpToPdf.analyzeHwp(...)` / `RhwpToPdf.hwpToPdf(...)` 식으로 호출한다.

// ─── DOM ───────────────────────────────────────────────────────────
const statusEl = document.querySelector("#status");
const statusDotEl = document.querySelector("#status-dot");
const versionEl = document.querySelector("#version");
const dropzoneEl = document.querySelector("#dropzone");
const dropzoneEmpty = dropzoneEl.querySelector(".dropzone-empty");
const dropzoneSelected = dropzoneEl.querySelector(".dropzone-selected");
const selectedFileEl = document.querySelector("#selected-file");
const clearButton = document.querySelector("#clear-button");
const fileInput = document.querySelector("#file-input");
const convertButton = document.querySelector("#convert-button");
const downloadLink = document.querySelector("#download-link");
const logEl = document.querySelector("#log");
const previewFrame = document.querySelector("#preview-frame");
const previewPlaceholder = document.querySelector("#preview-placeholder");
const analysisEl = document.querySelector("#analysis");
const pageCountEl = document.querySelector("#page-count");
const fontsListEl = document.querySelector("#fonts-required");
const stepperEl = document.querySelector("#stepper");

// ─── State ─────────────────────────────────────────────────────────
let RhwpToPdf = null;
let currentFile = null;
let activePdfUrl = null;

// ─── Utilities ─────────────────────────────────────────────────────
function log(message) {
  const time = new Date().toLocaleTimeString("ko-KR", { hour12: false });
  logEl.textContent = `[${time}] ${message}\n${logEl.textContent}`.trim();
}

function setStatus(text, kind /* "idle" | "ready" | "busy" | "error" */) {
  statusEl.textContent = text;
  statusDotEl.classList.remove("ready", "busy", "error");
  if (kind && kind !== "idle") statusDotEl.classList.add(kind);
}

const STEP_ORDER = ["analyze", "fonts", "convert", "done"];

function resetStepper() {
  stepperEl.querySelectorAll("li").forEach((li) => {
    li.classList.remove("is-active", "is-done");
  });
}

function setStep(name /* one of STEP_ORDER or null to reset */) {
  if (!name) {
    resetStepper();
    return;
  }
  const idx = STEP_ORDER.indexOf(name);
  stepperEl.querySelectorAll("li").forEach((li, i) => {
    li.classList.remove("is-active", "is-done");
    if (i < idx) li.classList.add("is-done");
    else if (i === idx) li.classList.add("is-active");
  });
}

function setSelectedFile(file) {
  currentFile = file;
  if (file) {
    selectedFileEl.textContent =
      `${file.name} (${file.size.toLocaleString()} bytes)`;
    dropzoneEl.classList.add("has-file");
    dropzoneEmpty.hidden = true;
    dropzoneSelected.hidden = false;
    convertButton.disabled = false;
    log(`파일 선택: ${file.name}`);
  } else {
    selectedFileEl.textContent = "—";
    dropzoneEl.classList.remove("has-file");
    dropzoneEmpty.hidden = false;
    dropzoneSelected.hidden = true;
    convertButton.disabled = true;
    fileInput.value = "";
    resetAnalysisAndPreview();
    log("파일 선택 해제");
  }
}

function resetAnalysisAndPreview() {
  pageCountEl.textContent = "—";
  fontsListEl.textContent = "—";
  analysisEl.hidden = true;
  resetStepper();
  // 활성 PDF blob URL 해제 + iframe 자리에 placeholder 복귀.
  if (activePdfUrl) {
    URL.revokeObjectURL(activePdfUrl);
    activePdfUrl = null;
  }
  showPreviewPlaceholder();
  downloadLink.classList.add("disabled");
  downloadLink.setAttribute("aria-disabled", "true");
  downloadLink.removeAttribute("href");
  downloadLink.removeAttribute("download");
}

function showPreviewPlaceholder() {
  previewPlaceholder.hidden = false;
  previewFrame.hidden = true;
  previewFrame.removeAttribute("src");
}

function showPreviewPdf(url, sourceName) {
  if (activePdfUrl) URL.revokeObjectURL(activePdfUrl);
  activePdfUrl = url;
  previewPlaceholder.hidden = true;
  previewFrame.hidden = false;
  previewFrame.src = `${url}#view=FitH&zoom=page-width`;
  downloadLink.href = url;
  downloadLink.download = sourceName
    ? sourceName.replace(/\.(hwp|hwpx)$/i, "") + ".pdf"
    : "output.pdf";
  downloadLink.classList.remove("disabled");
  downloadLink.removeAttribute("aria-disabled");
}

function renderAnalysis(analysis) {
  pageCountEl.textContent = `${analysis.pageCount} 페이지`;
  const fonts = Array.from(analysis.fontsRequired ?? []);
  fontsListEl.textContent = fonts.length === 0 ? "—" : fonts.join(", ");
  analysisEl.hidden = false;
}

async function readFileBytes(file) {
  const buffer = await file.arrayBuffer();
  return new Uint8Array(buffer);
}

// ─── Fonts (static fallback) ───────────────────────────────────────
const STATIC_FONT_MAP = {
  "HCR Batang": "/fonts/HANBatang.ttf",
  "함초롬바탕": "/fonts/HANBatang.ttf",
  "HCR Dotum": "/fonts/HANDotum.ttf",
  "함초롬돋움": "/fonts/HANDotum.ttf",
};
const STATIC_FALLBACK_URL = "/fonts/HANBatang.ttf";
const fontBytesCache = new Map();

// ─── Font Access API (Chrome/Edge desktop) ─────────────────────────
let systemFontsCache = null;

function getFontQueryFn() {
  if (typeof window.queryLocalFonts === "function") {
    return () => window.queryLocalFonts();
  }
  if ("fonts" in navigator && typeof navigator.fonts.query === "function") {
    return () => navigator.fonts.query();
  }
  return null;
}

async function checkFontPermission() {
  if (!("permissions" in navigator)) return "unknown";
  try {
    const status = await navigator.permissions.query({ name: "local-fonts" });
    return status.state;
  } catch (_) {
    return "unknown";
  }
}

async function preflightSystemFonts() {
  if (systemFontsCache !== null) return;
  const queryFn = getFontQueryFn();
  if (!queryFn) {
    log("Font Access API 미지원 브라우저 — 정적 폰트로만 동작");
    systemFontsCache = [];
    return;
  }
  const state = await checkFontPermission();
  log(`Font Access API: local-fonts 권한 = ${state}`);
  if (state === "denied") {
    log("→ 시스템 폰트 사용 불가 (Chrome 설정에서 변경 가능)");
    systemFontsCache = [];
    return;
  }
  if (state === "granted") {
    try {
      const list = await queryFn();
      systemFontsCache = list;
      log(`시스템 폰트 ${list.length}개 사전 캐시`);
    } catch (e) {
      log(`사전 query 실패: ${e.message} (변환 시 재시도)`);
    }
  }
}

async function querySystemFonts() {
  if (systemFontsCache !== null) return systemFontsCache;
  const queryFn = getFontQueryFn();
  if (!queryFn) {
    systemFontsCache = [];
    return systemFontsCache;
  }
  const state = await checkFontPermission();
  if (state === "denied") {
    log("local-fonts 권한 거부 — 정적 폴백");
    systemFontsCache = [];
    return systemFontsCache;
  }
  try {
    log("시스템 폰트 조회 중 (권한 prompt 가 뜨면 허용해 주세요)…");
    const list = await queryFn();
    log(`시스템 폰트 ${list.length}개 인식`);
    systemFontsCache = list;
    return systemFontsCache;
  } catch (e) {
    log(`Font Access API 실패: ${e.message} (다음 변환 시 재시도)`);
    return [];
  }
}

function findSystemMatch(systemFonts, family) {
  for (const fd of systemFonts) {
    if (
      fd.family === family ||
      fd.fullName === family ||
      fd.postscriptName === family
    ) {
      return fd;
    }
  }
  return null;
}

async function fetchStaticBytes(url) {
  if (fontBytesCache.has(url)) return fontBytesCache.get(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  fontBytesCache.set(url, bytes);
  return bytes;
}

async function loadFontsFor(fontsRequired) {
  if (typeof RhwpToPdf.registerPdfFont !== "function") {
    log("registerPdfFont 가 노출되지 않음 (구버전 번들)");
    return;
  }
  const systemFonts = await querySystemFonts();
  RhwpToPdf.clearPdfFonts?.();

  const systemMatched = [];
  const staticMatched = new Set();
  const unmatched = [];

  for (const family of fontsRequired ?? []) {
    const sys = findSystemMatch(systemFonts, family);
    if (sys) { systemMatched.push({ family, fd: sys }); continue; }
    const url = STATIC_FONT_MAP[family];
    if (url) { staticMatched.add(url); continue; }
    unmatched.push(family);
  }

  for (const { family, fd } of systemMatched) {
    try {
      const blob = await fd.blob();
      const buf = await blob.arrayBuffer();
      const detected = RhwpToPdf.registerPdfFont(new Uint8Array(buf));
      log(
        `시스템 폰트: "${family}" → ${fd.fullName} (${buf.byteLength.toLocaleString()} bytes, family="${detected}")`,
      );
    } catch (e) {
      log(`시스템 폰트 "${family}" 로드 실패: ${e.message}`);
    }
  }
  for (const url of staticMatched) {
    try {
      const bytes = await fetchStaticBytes(url);
      const detected = RhwpToPdf.registerPdfFont(bytes);
      log(
        `정적 폰트 등록: ${url} (${bytes.byteLength.toLocaleString()} bytes, family="${detected}")`,
      );
    } catch (e) {
      log(`정적 폰트 로드 실패 ${url}: ${e.message}`);
    }
  }
  if (unmatched.length > 0 && !staticMatched.has(STATIC_FALLBACK_URL)) {
    try {
      const bytes = await fetchStaticBytes(STATIC_FALLBACK_URL);
      const detected = RhwpToPdf.registerPdfFont(bytes);
      log(
        `미매칭 → fallback (${unmatched.join(", ")}): ${STATIC_FALLBACK_URL}, family="${detected}"`,
      );
    } catch (e) {
      log(`fallback 로드 실패: ${e.message}`);
    }
  }
  if (typeof RhwpToPdf.pdfFontStatus === "function") {
    log(`PDF fontdb 상태: ${RhwpToPdf.pdfFontStatus()}`);
  }
}

// ─── RhwpToPdfJob — JS 측 진행/완료 이벤트 인터페이스 ───────────────
//
// WASM 의 `analyzeHwp` + `hwpToPdf` 는 단일 동기 호출이라 페이지별 progress
// 를 받을 수 없다. 이 wrapper 는 단계 (analyze → fonts → convert → done) 마다
// `progress` 이벤트를 발행하고, 끝나면 `complete` 이벤트로 PDF 바이트를 전달한다.
//
// 사용:
//   const job = new RhwpToPdfJob();
//   job.addEventListener("progress", e => console.log(e.detail));
//   job.addEventListener("complete", e => downloadPdf(e.detail.pdfBytes));
//   job.addEventListener("error",    e => console.error(e.detail.error));
//   await job.run(hwpBytes, { registerFonts: loadFontsFor });
//
// progress event detail shape: `{ phase, state, ...payload }`
//   phase ∈ { "analyze" | "fonts" | "convert" }
//   state ∈ { "start" | "done" }
//   payload (state=done): { pageCount, fontsRequired, elapsedMs, bytes, ... }
class RhwpToPdfJob extends EventTarget {
  async run(bytes, { registerFonts } = {}) {
    const startedAt = performance.now();
    try {
      // analyze
      this._emit("progress", { phase: "analyze", state: "start" });
      const analysis = RhwpToPdf.analyzeHwp(bytes);
      const fontsRequired = Array.from(analysis.fontsRequired ?? []);
      this._emit("progress", {
        phase: "analyze",
        state: "done",
        pageCount: analysis.pageCount,
        fontsRequired,
      });

      // fonts (호출자가 옵션으로 등록 콜백 전달)
      this._emit("progress", { phase: "fonts", state: "start", fontsRequired });
      if (registerFonts) await registerFonts(analysis.fontsRequired);
      this._emit("progress", { phase: "fonts", state: "done" });

      // convert (WASM 호출 — 동기. 시간 측정만 가능.)
      this._emit("progress", { phase: "convert", state: "start", pageCount: analysis.pageCount });
      const t0 = performance.now();
      const pdfBytes = RhwpToPdf.hwpToPdf(bytes);
      const convertMs = performance.now() - t0;
      this._emit("progress", {
        phase: "convert",
        state: "done",
        bytes: pdfBytes.length,
        elapsedMs: convertMs,
      });

      const totalMs = performance.now() - startedAt;
      this._emit("complete", {
        pdfBytes,
        pageCount: analysis.pageCount,
        fontsRequired,
        totalMs,
        convertMs,
      });
      return pdfBytes;
    } catch (error) {
      this._emit("error", { error });
      throw error;
    }
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

// ─── Init + handlers ───────────────────────────────────────────────
async function init() {
  RhwpToPdf = window.RhwpToPdf;
  if (typeof RhwpToPdf !== "function") {
    setStatus("초기화 실패", "error");
    log("rhwptopdf UMD 번들이 로드되지 않았습니다.");
    return;
  }

  setStatus("엔진 로딩 중", "busy");
  log("rhwptopdf UMD 번들 로드 완료");

  await RhwpToPdf({ module_or_path: "/vendor/rhwptopdf.umd_bg.wasm" });
  versionEl.textContent = `v${RhwpToPdf.version()}`;

  await preflightSystemFonts();

  setStatus("준비 완료", "ready");
  log(`엔진 v${RhwpToPdf.version()} 준비 완료. HWP 파일을 선택하세요.`);
}

// — Drop zone events
function handleFileList(files) {
  const file = files?.[0];
  if (!file) return;
  setSelectedFile(file);
}

dropzoneEl.addEventListener("click", (e) => {
  // clear button 클릭은 file input open 되지 않게.
  if (e.target.closest(".dropzone-clear")) return;
  // hidden <input> 자체 클릭도 native 처리 → 이중 open 방지.
  if (e.target === fileInput) return;
  fileInput.click();
});

dropzoneEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});

clearButton.addEventListener("click", (e) => {
  // dropzone 의 click handler 가 같이 trigger 되지 않게.
  e.stopPropagation();
  e.preventDefault();
  setSelectedFile(null);
});

fileInput.addEventListener("change", (event) => {
  handleFileList(event.target.files);
});

["dragenter", "dragover"].forEach((ev) => {
  dropzoneEl.addEventListener(ev, (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzoneEl.classList.add("is-drag-over");
  });
});

["dragleave", "dragend"].forEach((ev) => {
  dropzoneEl.addEventListener(ev, (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.target === dropzoneEl) dropzoneEl.classList.remove("is-drag-over");
  });
});

dropzoneEl.addEventListener("drop", (e) => {
  e.preventDefault();
  e.stopPropagation();
  dropzoneEl.classList.remove("is-drag-over");
  handleFileList(e.dataTransfer?.files);
});

// 페이지 전체 영역에서 우발적 drop 으로 navigate 되는 것 방지.
["dragover", "drop"].forEach((ev) => {
  window.addEventListener(ev, (e) => e.preventDefault());
});

// — Convert (RhwpToPdfJob 이 progress/complete/error 이벤트 발행 → UI 가 구독)
convertButton.addEventListener("click", async () => {
  if (!RhwpToPdf) { log("엔진이 아직 준비되지 않았습니다."); return; }
  if (!currentFile) { log("HWP 파일을 먼저 선택하세요."); return; }

  convertButton.disabled = true;
  try {
    // Font Access prompt 는 user-gesture 안에서 먼저.
    setStep("fonts");
    setStatus("시스템 폰트 확인 중", "busy");
    await querySystemFonts();

    const bytes = await readFileBytes(currentFile);
    const sourceName = currentFile.name;

    const job = new RhwpToPdfJob();
    job.addEventListener("progress", ({ detail }) => {
      const { phase, state } = detail;
      if (state === "start") {
        setStep(phase);
        setStatus(
          phase === "analyze" ? "문서 분석 중" :
          phase === "fonts" ? "필요 폰트 로드 중" :
          phase === "convert" ? "PDF 변환 중" :
          "처리 중",
          "busy",
        );
        if (phase === "convert" && typeof detail.pageCount === "number") {
          log(`변환 시작 (${detail.pageCount} 페이지)`);
        }
      } else if (state === "done") {
        if (phase === "analyze") {
          renderAnalysis({
            pageCount: detail.pageCount,
            fontsRequired: detail.fontsRequired,
          });
          log(
            `분석 완료: pageCount=${detail.pageCount}, fonts=[${detail.fontsRequired.join(", ")}]`,
          );
        } else if (phase === "convert") {
          log(`변환 완료: ${detail.bytes.toLocaleString()} bytes (${detail.elapsedMs.toFixed(0)} ms)`);
        }
      }
    });
    job.addEventListener("complete", ({ detail }) => {
      const blob = new Blob([detail.pdfBytes], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      showPreviewPdf(url, sourceName);
      setStep("done");
      setStatus("변환 완료", "ready");
      log(`전체 소요 ${detail.totalMs.toFixed(0)} ms`);
    });
    job.addEventListener("error", ({ detail }) => {
      setStatus("변환 실패", "error");
      log(`에러: ${detail.error?.message ?? String(detail.error)}`);
      console.error(detail.error);
    });

    await job.run(bytes, { registerFonts: loadFontsFor });
  } finally {
    convertButton.disabled = !currentFile;
  }
});

init().catch((error) => {
  setStatus("초기화 실패", "error");
  log(`에러: ${error instanceof Error ? error.message : String(error)}`);
});
