//! WASM ↔ JavaScript 공개 API
//!
//! ## hwp-to-pdf 인터페이스
//! - `version()` — 빌드 버전 문자열
//! - `analyzeHwp(bytes)` → `AnalyzeResult` (`pageCount`, `fontsRequired`)
//! - `hwpToPdf(bytes)` → multi-page PDF 바이트 (SVG 렌더 결과를 PDF 페이지로 합침)
//! - `registerPdfFont(bytes)` / `clearPdfFonts()` / `pdfFontStatus()` — 변환용 폰트 레지스트리
//! - `extractThumbnail(bytes)` — 썸네일 경량 추출

use wasm_bindgen::prelude::*;

use crate::document_core::DocumentCore;
use crate::error::HwpError;

impl From<HwpError> for JsValue {
    fn from(err: HwpError) -> Self {
        JsValue::from_str(&err.to_string())
    }
}

/// HWP 파일에서 썸네일 이미지만 경량 추출 (전체 파싱 없이).
///
/// 반환: JSON `{ "format": "png"|"gif", "base64": "...", "width": N, "height": N }`
/// PrvImage 가 없으면 `null` 반환.
#[wasm_bindgen(js_name = extractThumbnail)]
pub fn extract_thumbnail(data: &[u8]) -> JsValue {
    match crate::parser::extract_thumbnail_only(data) {
        Some(result) => {
            let base64 = base64_encode(&result.data);
            let mime = match result.format.as_str() {
                "png" => "image/png",
                "bmp" => "image/bmp",
                "gif" => "image/gif",
                _ => "application/octet-stream",
            };
            let json = format!(
                r#"{{"format":"{}","base64":"{}","dataUri":"data:{};base64,{}","width":{},"height":{}}}"#,
                result.format, base64, mime, base64, result.width, result.height
            );
            JsValue::from_str(&json)
        }
        None => JsValue::NULL,
    }
}

fn base64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}

// ─── ../hwptopdf 호환 API ─────────────────────────────────────────

/// `analyzeHwp(bytes)` 결과 — `{ pageCount, fontsRequired }`.
#[wasm_bindgen]
pub struct AnalyzeResult {
    page_count: u32,
    fonts_required: Vec<String>,
}

#[wasm_bindgen]
impl AnalyzeResult {
    #[wasm_bindgen(getter, js_name = pageCount)]
    pub fn page_count(&self) -> u32 {
        self.page_count
    }

    #[wasm_bindgen(getter, js_name = fontsRequired)]
    pub fn fonts_required(&self) -> Vec<String> {
        self.fonts_required.clone()
    }
}

/// HWP doc_info 가 face name 끝에 garbage character (control bytes, geometric
/// box-drawing, mis-decoded multi-byte 등) 를 남기는 경우가 있다 (실 케이스:
/// "신명조\u{25A0}얒a"). 첫 비정상 character 직전까지만 보존한다.
///
/// 허용: 한글 음절/자모, CJK 한자, ASCII 영문/숫자, ` `, `-`, `_`, `.`, `/`,
/// `(`, `)`. 그 외 (control / geometric / 기타 마커) 만나면 truncate.
fn sanitize_font_family(name: &str) -> String {
    let mut out = String::new();
    for ch in name.chars() {
        let cp = ch as u32;
        let allowed = matches!(ch, ' ' | '-' | '_' | '.' | '/' | '(' | ')')
            || (0x0030..=0x0039).contains(&cp)  // ASCII digits
            || (0x0041..=0x005A).contains(&cp)  // ASCII A-Z
            || (0x0061..=0x007A).contains(&cp)  // ASCII a-z
            || (0xAC00..=0xD7A3).contains(&cp)  // Hangul syllables
            || (0x1100..=0x11FF).contains(&cp)  // Hangul Jamo
            || (0x3130..=0x318F).contains(&cp)  // Hangul Compat Jamo
            || (0x4E00..=0x9FFF).contains(&cp); // CJK Unified Ideographs
        if !allowed {
            break;
        }
        out.push(ch);
    }
    out.trim().to_string()
}

/// HWP/HWPX 바이트를 분석하여 페이지 수와 사용 폰트 family 목록을 반환한다.
#[wasm_bindgen(js_name = analyzeHwp)]
pub fn analyze_hwp(bytes: &[u8]) -> Result<AnalyzeResult, JsValue> {
    use crate::renderer::style_resolver::resolve_font_substitution;

    let core = DocumentCore::from_bytes(bytes).map_err(JsValue::from)?;
    let page_count = core.page_count();

    let mut fonts: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (lang_idx, lang_fonts) in core.document().doc_info.font_faces.iter().enumerate() {
        for font in lang_fonts {
            let resolved = resolve_font_substitution(&font.name, font.alt_type, lang_idx)
                .unwrap_or(&font.name);
            let cleaned = sanitize_font_family(resolved);
            if !cleaned.is_empty() && seen.insert(cleaned.clone()) {
                fonts.push(cleaned);
            }
        }
    }

    Ok(AnalyzeResult {
        page_count,
        fonts_required: fonts,
    })
}

// ─── 글로벌 PDF 폰트 레지스트리 ─────────────────────────────
//
// hwpToPdf 변환 시 usvg fontdb 에 등록될 TTF/OTF 바이트.
// 호출자가 registerPdfFont(bytes) 로 등록하고 hwpToPdf(bytes) 를 호출한다.
// 등록된 폰트가 없으면 한글 텍스트는 .notdef 처리되어 PDF 에 보이지 않는다.
//
// WASM 은 single-thread context 라 std::sync::Mutex 로 충분.
static PDF_FONTS: std::sync::OnceLock<std::sync::Mutex<PdfFontRegistry>> =
    std::sync::OnceLock::new();

#[derive(Default)]
struct PdfFontRegistry {
    /// 등록된 폰트 바이트들
    fonts: Vec<Vec<u8>>,
    /// usvg generic `serif` fallback 으로 사용할 family name (첫 등록 폰트에서 자동 추출)
    serif_family: Option<String>,
    /// usvg generic `sans-serif` fallback 으로 사용할 family name
    sans_serif_family: Option<String>,
}

fn pdf_fonts() -> &'static std::sync::Mutex<PdfFontRegistry> {
    PDF_FONTS.get_or_init(|| std::sync::Mutex::new(PdfFontRegistry::default()))
}

/// family 이름 keyword 로 serif / sans-serif 계열을 분류한다.
/// 명확한 keyword (Dotum/Gothic/돋움/고딕/굴림/맑은 = sans-serif, 바탕/명조/궁서/Batang/
/// Myeongjo/Gungsuh = serif) 가 없으면 `None` 반환.
fn classify_font_kind(family: &str) -> Option<&'static str> {
    const SANS_KEYWORDS: &[&str] = &[
        "Dotum", "dotum", "Gothic", "gothic", "Gulim", "gulim", "Malgun", "malgun",
        "돋움", "고딕", "굴림", "맑은",
    ];
    const SERIF_KEYWORDS: &[&str] = &[
        "Batang", "batang", "Myeongjo", "myeongjo", "Myeong", "myeong", "Gungsuh", "gungsuh",
        "바탕", "명조", "궁서",
    ];
    if SANS_KEYWORDS.iter().any(|k| family.contains(k)) {
        return Some("sans-serif");
    }
    if SERIF_KEYWORDS.iter().any(|k| family.contains(k)) {
        return Some("serif");
    }
    None
}

/// TTF/OTF 폰트 바이트를 PDF 변환용 fontdb 에 등록한다.
///
/// 같은 폰트를 여러 번 호출하면 중복 등록된다 (`clearPdfFonts` 로 초기화).
/// 추출한 family name 을 keyword 로 serif / sans-serif 계열을 판별하여 해당 generic
/// fallback 으로 지정한다. 한 쪽만 등록된 상태에서는 다른 generic 도 같은 family 로
/// 채워둠 → 한 폰트만 있을 때 모든 글리프가 그 폰트로 fallback.
/// 반환값: 자동 추출된 family name (디버깅용). family 추출 실패 시 빈 문자열.
#[wasm_bindgen(js_name = registerPdfFont)]
pub fn register_pdf_font(data: &[u8]) -> String {
    let mut reg = pdf_fonts().lock().unwrap();
    let mut extracted = String::new();

    if let Ok(face) = ttf_parser::Face::parse(data, 0) {
        let family = face
            .names()
            .into_iter()
            .filter(|n| n.name_id == ttf_parser::name_id::FAMILY)
            .find_map(|n| n.to_string());
        if let Some(f) = family {
            extracted = f.clone();
            match classify_font_kind(&f) {
                Some("sans-serif") => reg.sans_serif_family = Some(f.clone()),
                Some("serif") => reg.serif_family = Some(f.clone()),
                _ => {
                    // 분류 불가 — 양쪽이 비어있는 슬롯에 채움 (default).
                    if reg.serif_family.is_none() {
                        reg.serif_family = Some(f.clone());
                    }
                    if reg.sans_serif_family.is_none() {
                        reg.sans_serif_family = Some(f.clone());
                    }
                }
            }
            // 한 쪽만 채워진 상태면 빈 쪽도 같은 값으로 fallback.
            if reg.serif_family.is_none() {
                reg.serif_family = reg.sans_serif_family.clone();
            }
            if reg.sans_serif_family.is_none() {
                reg.sans_serif_family = reg.serif_family.clone();
            }
        }
    }
    reg.fonts.push(data.to_vec());
    extracted
}

/// 디버깅: 현재 등록된 PDF 폰트 수와 fallback family 를 JSON 으로 반환.
#[wasm_bindgen(js_name = pdfFontStatus)]
pub fn pdf_font_status() -> String {
    let reg = pdf_fonts().lock().unwrap();
    format!(
        r#"{{"count":{},"serif":{},"sansSerif":{}}}"#,
        reg.fonts.len(),
        reg.serif_family
            .as_deref()
            .map(|s| format!("\"{}\"", s.replace('"', "\\\"")))
            .unwrap_or_else(|| "null".into()),
        reg.sans_serif_family
            .as_deref()
            .map(|s| format!("\"{}\"", s.replace('"', "\\\"")))
            .unwrap_or_else(|| "null".into()),
    )
}

/// 등록된 PDF 변환용 폰트를 모두 해제한다.
#[wasm_bindgen(js_name = clearPdfFonts)]
pub fn clear_pdf_fonts() {
    *pdf_fonts().lock().unwrap() = PdfFontRegistry::default();
}

fn build_usvg_options() -> usvg::Options<'static> {
    let mut options = usvg::Options::default();
    {
        let fontdb = std::sync::Arc::get_mut(&mut options.fontdb)
            .expect("fresh fontdb is uniquely owned");
        let reg = pdf_fonts().lock().unwrap();
        for data in &reg.fonts {
            fontdb.load_font_data(data.clone());
        }
        if let Some(family) = &reg.serif_family {
            fontdb.set_serif_family(family);
        }
        if let Some(family) = &reg.sans_serif_family {
            fontdb.set_sans_serif_family(family);
        }
    }
    options
}

/// SVG 의 `font-family="..."` 속성을 family 계열에 따라 `serif` 또는 `sans-serif`
/// 로 치환한다.
///
/// usvg 의 generic family fallback (fontdb 의 `set_serif_family` / `set_sans_serif_family`)
/// 가 등록된 폰트 family 로 지정되어 있으므로, family keyword 분류 결과가 그대로 PDF
/// 글리프 폰트 선택에 반영된다. 같은 계열 fallback 보장.
fn normalize_svg_font_family(svg: &str) -> String {
    let needles: [&str; 2] = ["font-family=\"", "font-family='"];

    let mut result = String::with_capacity(svg.len());
    let mut cursor = 0;

    'outer: while cursor < svg.len() {
        let mut next_hit: Option<(usize, char)> = None;
        for needle in &needles {
            if let Some(idx) = svg[cursor..].find(needle) {
                let abs = cursor + idx;
                let quote = if *needle == "font-family=\"" { '"' } else { '\'' };
                if next_hit.map_or(true, |(h, _)| abs < h) {
                    next_hit = Some((abs, quote));
                }
            }
        }

        let Some((hit, quote)) = next_hit else {
            result.push_str(&svg[cursor..]);
            break 'outer;
        };

        let attr_start = hit + "font-family=".len();
        let value_start = attr_start + 1;
        let Some(rel_end) = svg[value_start..].find(quote) else {
            result.push_str(&svg[cursor..]);
            break 'outer;
        };
        let value_end = value_start + rel_end;

        let original_value = &svg[value_start..value_end];
        let generic = pick_generic_family(original_value);

        result.push_str(&svg[cursor..attr_start]);
        result.push(quote);
        result.push_str(generic);
        result.push(quote);

        cursor = value_end + 1;
    }

    result
}

/// 원본 `font-family` 값 (chain) 에서 첫 family 이름을 보고 generic 계열을 선택한다.
/// 분류 불가 시 `serif` 를 default 로 사용 (한컴 본문 default 가 serif).
fn pick_generic_family(family_chain: &str) -> &'static str {
    // chain 의 첫 family 만 본다. quote / 공백 stripped.
    let first = family_chain
        .split(',')
        .next()
        .unwrap_or("")
        .trim()
        .trim_matches(|c| c == '\'' || c == '"');
    match classify_font_kind(first) {
        Some("sans-serif") => "sans-serif",
        _ => "serif",
    }
}

/// HWP/HWPX 바이트를 multi-page PDF 바이트로 변환한다.
///
/// 각 페이지를 SVG 로 렌더한 뒤 `svg2pdf` 로 XObject 청크로 변환하고,
/// `pdf-writer` 로 page tree 를 직접 조립하여 하나의 PDF 로 합친다.
///
/// 한글 글리프는 빌드 시 임베드된 `EMBEDDED_FONTS` 가 usvg fontdb 에 등록되어
/// 사용된다. 문서가 임베드 폰트와 다른 family 를 지정한 경우 usvg 의 family
/// fallback 으로 처리된다 (정확 매칭이 필요하면 SVG 단계에서
/// `HwpDocument::renderPageSvgWithFonts` 로 임베드한 SVG 를 별도 경로로 사용).
#[wasm_bindgen(js_name = hwpToPdf)]
pub fn hwp_to_pdf(bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
    use pdf_writer::{Content, Finish, Name, Pdf, Rect, Ref};
    use std::collections::HashMap;

    let core = DocumentCore::from_bytes(bytes).map_err(JsValue::from)?;
    let page_count = core.page_count();

    let mut alloc = Ref::new(1);
    let catalog_id = alloc.bump();
    let page_tree_id = alloc.bump();

    let mut pdf = Pdf::new();

    struct PageData {
        chunk: pdf_writer::Chunk,
        svg_ref: Ref,
        page_id: Ref,
        content_id: Ref,
        width_pt: f32,
        height_pt: f32,
    }
    let mut pages: Vec<PageData> = Vec::with_capacity(page_count as usize);

    let usvg_options = build_usvg_options();

    // SvgRenderer 는 96 dpi 픽셀 단위로 SVG width/height 를 출력한다.
    // PDF media_box 는 points 단위 (1 pt = 1/72 inch) 이므로 72/96 비율로 변환해야
    // A4 같은 표준 페이지 사이즈가 된다. 미적용 시 page 가 1.33 × 부풀어 글자 폭·간격
    // 비율이 시각적으로 어긋난다.
    const PX_TO_PT: f32 = 72.0 / 96.0;

    for page_num in 0..page_count {
        let svg_str = core
            .render_page_svg_native(page_num)
            .map_err(JsValue::from)?;
        let svg_str = normalize_svg_font_family(&svg_str);

        let tree = usvg::Tree::from_str(&svg_str, &usvg_options)
            .map_err(|e| JsValue::from_str(&format!("usvg parse: {e}")))?;

        let (chunk, svg_ref) =
            svg2pdf::to_chunk(&tree, svg2pdf::ConversionOptions::default())
                .map_err(|e| JsValue::from_str(&format!("svg2pdf: {e}")))?;

        let mut id_map: HashMap<Ref, Ref> = HashMap::new();
        let chunk = chunk.renumber(|old| *id_map.entry(old).or_insert_with(|| alloc.bump()));
        let svg_ref = *id_map
            .get(&svg_ref)
            .ok_or_else(|| JsValue::from_str("svg2pdf: missing svg ref in chunk"))?;

        let page_id = alloc.bump();
        let content_id = alloc.bump();

        let size = tree.size();
        let w = size.width() * PX_TO_PT;
        let h = size.height() * PX_TO_PT;

        pages.push(PageData {
            chunk,
            svg_ref,
            page_id,
            content_id,
            width_pt: w,
            height_pt: h,
        });
    }

    let page_kids: Vec<Ref> = pages.iter().map(|p| p.page_id).collect();

    pdf.catalog(catalog_id).pages(page_tree_id);
    pdf.pages(page_tree_id)
        .kids(page_kids.iter().copied())
        .count(page_count as i32);

    let svg_name = Name(b"S1");

    for p in &pages {
        let mut page = pdf.page(p.page_id);
        page.media_box(Rect::new(0.0, 0.0, p.width_pt, p.height_pt));
        page.parent(page_tree_id);
        page.contents(p.content_id);
        let mut resources = page.resources();
        resources.x_objects().pair(svg_name, p.svg_ref);
        resources.finish();
        page.finish();

        // XObject 의 기본 단위는 1pt × 1pt 이므로 page size 로 스케일링.
        let mut content = Content::new();
        content
            .transform([p.width_pt, 0.0, 0.0, p.height_pt, 0.0, 0.0])
            .x_object(svg_name);
        pdf.stream(p.content_id, &content.finish());

        pdf.extend(&p.chunk);
    }

    Ok(pdf.finish())
}
