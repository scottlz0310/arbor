use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    #[serde(default)]
    pub settings: Settings,
    #[serde(default)]
    pub repositories: Vec<RepoConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub stale_threshold_days: u32,
    pub fetch_on_startup: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            stale_threshold_days: 14,
            fetch_on_startup: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoConfig {
    pub path: String,
    pub name: String,
    /// Cleanup Wizard で削除対象から除外する branch/ref 名 (Issue #186)。
    #[serde(default)]
    pub protected_branches: Vec<String>,
}

/// Returns the platform-appropriate config directory:
/// - Windows: %APPDATA%\arbor\config.toml
/// - macOS:   ~/Library/Application Support/arbor/config.toml
/// - Linux:   ~/.config/arbor/config.toml
fn config_path() -> Result<PathBuf, String> {
    // 実機テストが利用者の設定を触れないよう、debug build のみ隔離先を許可する。
    #[cfg(debug_assertions)]
    let debug_override = std::env::var_os("ARBOR_CONFIG_DIR");
    #[cfg(not(debug_assertions))]
    let debug_override = None;

    let base = resolve_config_base(dirs::config_dir(), debug_override)?;
    Ok(base.join("arbor").join("config.toml"))
}

fn resolve_config_base(
    default_base: Option<PathBuf>,
    debug_override: Option<OsString>,
) -> Result<PathBuf, String> {
    debug_override
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or(default_base)
        .ok_or_else(|| "Could not determine config directory for this OS".to_string())
}

pub fn load_config() -> Result<AppConfig, String> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    toml::from_str(&content).map_err(|e| e.to_string())
}

pub fn save_config(config: &AppConfig) -> Result<(), String> {
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = toml::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_settings_values() {
        let s = Settings::default();
        assert_eq!(s.stale_threshold_days, 14);
        assert!(s.fetch_on_startup);
    }

    #[test]
    fn resolve_config_base_cases() {
        let default = PathBuf::from("default-config");
        let isolated = PathBuf::from("isolated-config");

        let cases = [
            (
                Some(default.clone()),
                Some(OsString::from("isolated-config")),
                Ok(isolated),
            ),
            (
                Some(default.clone()),
                Some(OsString::new()),
                Ok(default.clone()),
            ),
            (Some(default.clone()), None, Ok(default)),
            (
                None,
                None,
                Err("Could not determine config directory for this OS"),
            ),
        ];

        for (default_base, debug_override, expected) in cases {
            let actual = resolve_config_base(default_base, debug_override);
            match expected {
                Ok(path) => assert_eq!(actual.expect("config base should resolve"), path),
                Err(message) => assert_eq!(actual.expect_err("config base should fail"), message),
            }
        }
    }

    #[test]
    fn default_app_config_has_no_repositories() {
        let cfg = AppConfig::default();
        assert!(cfg.repositories.is_empty());
    }

    #[test]
    fn app_config_roundtrip_toml() {
        let original = AppConfig::default();
        let serialized = toml::to_string_pretty(&original).expect("serialize");
        let deserialized: AppConfig = toml::from_str(&serialized).expect("deserialize");
        assert_eq!(
            deserialized.settings.stale_threshold_days,
            original.settings.stale_threshold_days
        );
    }

    /// GitHub 連携 / AI Insight の削除前に保存された config.toml が、そのまま読み込めること。
    /// 未知のフィールド（[ai]・PAT・リポジトリごとの GitHub 設定）は無視され、残りは保持される。
    #[test]
    fn legacy_config_with_removed_fields_still_loads() {
        let legacy = r#"
[settings]
stale_threshold_days = 30
fetch_on_startup = false
github_keychain_key = "arbor_github_pat"
github_pat_enc = "AQAAANCMnd8BFdERjHoAwE"

[ai]
provider = "ollama"
ollama_url = "http://localhost:11434"
model = "qwen3.5:latest"
enabled = true
timeout_secs = 120

[[repositories]]
path = "/src/arbor"
name = "arbor"
github_owner = "scottlz0310"
github_repo = "arbor"
protected_branches = ["release"]
"#;

        let cfg: AppConfig = toml::from_str(legacy).expect("legacy config should load");

        assert_eq!(cfg.settings.stale_threshold_days, 30);
        assert!(!cfg.settings.fetch_on_startup);
        assert_eq!(cfg.repositories.len(), 1);
        assert_eq!(cfg.repositories[0].name, "arbor");
        assert_eq!(cfg.repositories[0].protected_branches, vec!["release"]);
    }
}
