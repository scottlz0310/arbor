use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    #[serde(default)]
    pub settings: Settings,
    #[serde(default)]
    pub ai: AiConfig,
    #[serde(default)]
    pub repositories: Vec<RepoConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub stale_threshold_days: u32,
    pub fetch_on_startup: bool,
    pub github_keychain_key: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            stale_threshold_days: 14,
            fetch_on_startup: true,
            github_keychain_key: "arbor_github_pat".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConfig {
    pub provider: String,
    pub ollama_url: String,
    /// Model name to use. Verify with `ollama list` before use.
    pub model: String,
    pub enabled: bool,
    pub timeout_secs: u64,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            provider: "ollama".to_string(),
            ollama_url: "http://localhost:11434".to_string(),
            model: "qwen3.5:latest".to_string(),
            enabled: true,
            timeout_secs: 30,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoConfig {
    pub path: String,
    pub name: String,
    pub github_owner: Option<String>,
    pub github_repo: Option<String>,
}

/// Returns the platform-appropriate config directory:
/// - Windows: %APPDATA%\arbor\config.toml
/// - macOS:   ~/Library/Application Support/arbor/config.toml
/// - Linux:   ~/.config/arbor/config.toml
fn config_path() -> Result<PathBuf, String> {
    let base = dirs::config_dir()
        .ok_or_else(|| "Could not determine config directory for this OS".to_string())?;
    Ok(base.join("arbor").join("config.toml"))
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
