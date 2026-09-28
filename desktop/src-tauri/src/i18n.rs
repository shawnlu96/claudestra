//! Menu text follows the macOS preferred language: Chinese for zh-*, English otherwise.

use std::sync::OnceLock;

static ZH: OnceLock<bool> = OnceLock::new();

pub fn is_zh() -> bool {
    *ZH.get_or_init(|| sys_locale::get_locale().map(|l| l.to_lowercase().starts_with("zh")).unwrap_or(false))
}

pub fn tr(zh: &str, en: &str) -> String {
    if is_zh() { zh } else { en }.to_string()
}
