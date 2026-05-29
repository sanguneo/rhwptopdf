//! rhwptopdf — HWP/HWPX → multi-page PDF 변환 라이브러리 (Rust + WebAssembly).
//!
//! [rhwp](https://github.com/edwardkim/rhwp) (Apache-2.0) 의 parser/renderer
//! 일부를 cherry-pick 한 뒤 PDF 출력 파이프라인 (svg2pdf + pdf-writer) 을 추가한
//! 별개 트랙입니다. 한글과컴퓨터의 한글 문서 파일(.hwp) 공개 문서를 참고합니다.

use wasm_bindgen::prelude::*;

pub mod document_core;
pub mod emf;
pub mod error;
pub mod model;
pub mod ooxml_chart;
pub mod paint;
pub mod parser;
pub mod renderer;
pub mod wasm_api;
pub mod wmf;

pub use document_core::DocumentCore;
pub use error::HwpError;
pub use model::event::DocumentEvent;
pub use parser::{parse_document, DocumentParser};

/// WASM panic hook 초기화 (한 번만 실행)
#[wasm_bindgen(start)]
pub fn init_panic_hook() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version() {
        assert_eq!(version(), env!("CARGO_PKG_VERSION"));
    }
}
