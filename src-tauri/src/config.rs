use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    #[serde(default)]
    pub settings: Settings,
    #[serde(default)]
    pub workspace: Workspace,
    #[serde(default)]
    pub repositories: Vec<RepoConfig>,
}

/// Cleanup の削除対象から常に除外するブランチ（branch-cleanup-chk と同じ既定）。
const DEFAULT_PROTECTED_BRANCHES: [&str; 4] = ["main", "master", "develop", "dev"];

fn default_protected_branches() -> Vec<String> {
    DEFAULT_PROTECTED_BRANCHES.map(String::from).to_vec()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub stale_threshold_days: u32,
    pub fetch_on_startup: bool,
    /// 全リポジトリ共通の protected branches。リポジトリごとの設定（`RepoConfig`）は、これに追加される。
    #[serde(default = "default_protected_branches")]
    pub protected_branches: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            stale_threshold_days: 14,
            fetch_on_startup: true,
            protected_branches: default_protected_branches(),
        }
    }
}

/// リポジトリの自動検出の対象。
/// `root` 直下（深さ 1。`root` 自身が git リポジトリならそれも）を検出する。dsx の `repo.root` と同じ規則。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Workspace {
    /// None は未設定（読み込み時に、あれば既定の `~/src` で補う）。空文字列は自動検出を無効にする。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
}

/// 手動で登録したリポジトリ。root 配下のリポジトリに対しては、名前・protected branches の上書き（追加）として働く。
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

/// 既定の workspace root（`~/src`）。存在するときだけ返す。
fn default_workspace_root() -> Option<PathBuf> {
    dirs::home_dir()
        .map(|home| home.join("src"))
        .filter(|path| path.is_dir())
}

/// 未設定の項目を既定値で補う。保存済みの設定は変えない。
fn apply_defaults(config: &mut AppConfig, default_root: Option<PathBuf>) {
    if config.workspace.root.is_none() {
        config.workspace.root = default_root.map(|path| path.to_string_lossy().into_owned());
    }
}

/// `path` の設定を読み込む。無ければ既定値。`default_root` は、workspace root が未設定のときの既定。
fn load_from(path: &Path, default_root: Option<PathBuf>) -> Result<AppConfig, String> {
    let mut config = if path.exists() {
        let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        toml::from_str(&content).map_err(|e| e.to_string())?
    } else {
        AppConfig::default()
    };
    apply_defaults(&mut config, default_root);
    Ok(config)
}

fn save_to(path: &Path, config: &AppConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = toml::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(path, content).map_err(|e| e.to_string())
}

pub fn load_config() -> Result<AppConfig, String> {
    load_from(&config_path()?, default_workspace_root())
}

/// 設定を読み込み、`change` で変更して保存し、変更後の設定を返す。`change` が失敗したら保存しない。
pub fn modify_config(
    change: impl FnOnce(AppConfig) -> Result<AppConfig, String>,
) -> Result<AppConfig, String> {
    modify_at(&config_path()?, default_workspace_root(), change)
}

fn modify_at(
    path: &Path,
    default_root: Option<PathBuf>,
    change: impl FnOnce(AppConfig) -> Result<AppConfig, String>,
) -> Result<AppConfig, String> {
    let updated = change(load_from(path, default_root)?)?;
    save_to(path, &updated)?;
    Ok(updated)
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
    fn default_protected_branches_match_branch_cleanup_chk() {
        assert_eq!(
            Settings::default().protected_branches,
            ["main", "master", "develop", "dev"]
        );
    }

    #[test]
    fn apply_defaults_cases() {
        let home_src = PathBuf::from("home-src");
        let cases = [
            (
                "未設定なら既定の root で補う",
                None,
                Some(home_src.clone()),
                Some("home-src"),
            ),
            (
                "設定済みの root は変えない",
                Some("custom"),
                Some(home_src.clone()),
                Some("custom"),
            ),
            (
                "空文字列（自動検出の無効化）は補わない",
                Some(""),
                Some(home_src),
                Some(""),
            ),
            ("既定の root が無ければ未設定のまま", None, None, None),
        ];

        for (name, configured, default_root, expected) in cases {
            let mut config = AppConfig::default();
            config.workspace.root = configured.map(String::from);

            apply_defaults(&mut config, default_root);

            assert_eq!(config.workspace.root.as_deref(), expected, "{name}");
        }
    }

    #[test]
    fn workspace_root_roundtrips_and_unset_is_omitted() {
        let unset = toml::to_string_pretty(&AppConfig::default()).expect("serialize");
        assert!(
            !unset.contains("root"),
            "未設定の root は保存しない: {unset}"
        );

        let mut config = AppConfig::default();
        config.workspace.root = Some(String::new());
        let serialized = toml::to_string_pretty(&config).expect("serialize");
        let restored: AppConfig = toml::from_str(&serialized).expect("deserialize");
        assert_eq!(restored.workspace.root.as_deref(), Some(""));
    }

    #[test]
    fn config_without_workspace_or_protected_branches_still_loads() {
        let before_workspace = r#"
[settings]
stale_threshold_days = 20
fetch_on_startup = true

[[repositories]]
path = "/src/arbor"
name = "arbor"
"#;

        let config: AppConfig = toml::from_str(before_workspace).expect("older config should load");

        assert_eq!(config.workspace.root, None);
        assert_eq!(
            config.settings.protected_branches,
            ["main", "master", "develop", "dev"]
        );
        assert!(config.repositories[0].protected_branches.is_empty());
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

    // ── load_from / save_to / modify_at ───────────────────────────────────────

    fn temp_config_path(prefix: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos();
        std::env::temp_dir()
            .join(format!("arbor-{prefix}-{}-{unique}", std::process::id()))
            .join("arbor")
            .join("config.toml")
    }

    fn cleanup(path: &Path) {
        // config.toml / arbor / 一時ディレクトリの順にたどる
        if let Some(root) = path.parent().and_then(Path::parent) {
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn load_from_a_missing_file_gives_defaults_with_the_default_root() {
        let path = temp_config_path("load-missing");

        let config = load_from(&path, Some(PathBuf::from("home-src"))).expect("load");

        assert_eq!(config.workspace.root.as_deref(), Some("home-src"));
        assert_eq!(config.settings.stale_threshold_days, 14);
        assert!(config.repositories.is_empty());
    }

    #[test]
    fn save_to_creates_the_directory_and_round_trips() {
        let path = temp_config_path("save");
        let mut config = AppConfig::default();
        config.settings.stale_threshold_days = 42;
        config.workspace.root = Some("/work".to_string());

        save_to(&path, &config).expect("save");
        let loaded = load_from(&path, None).expect("load");

        assert_eq!(loaded.settings.stale_threshold_days, 42);
        assert_eq!(loaded.workspace.root.as_deref(), Some("/work"));
        cleanup(&path);
    }

    #[test]
    fn load_from_reports_a_broken_file() {
        let path = temp_config_path("load-broken");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "this is = = not toml").unwrap();

        assert!(load_from(&path, None).is_err());
        cleanup(&path);
    }

    #[test]
    fn modify_at_saves_the_changed_config_and_returns_it() {
        let path = temp_config_path("modify");

        let updated = modify_at(&path, None, |mut config| {
            config.settings.stale_threshold_days = 7;
            Ok(config)
        })
        .expect("modify");

        assert_eq!(updated.settings.stale_threshold_days, 7);
        assert_eq!(
            load_from(&path, None)
                .unwrap()
                .settings
                .stale_threshold_days,
            7
        );
        cleanup(&path);
    }

    #[test]
    fn modify_at_does_not_save_when_the_change_fails() {
        let path = temp_config_path("modify-fail");

        let err = modify_at(&path, None, |_| Err("rejected".to_string())).unwrap_err();

        assert_eq!(err, "rejected");
        assert!(!path.exists(), "失敗した変更は保存しない");
        cleanup(&path);
    }

    // ── load_config / modify_config（設定ファイルの場所を解決する入口）──────────────

    /// `ARBOR_CONFIG_DIR`（debug build のみ有効な、実機テスト用の隔離先）を一時的に差し替える。
    /// この環境変数を読むのは `load_config` / `modify_config` だけで、他のテストは読まない。
    #[cfg(debug_assertions)]
    struct IsolatedConfigDir {
        base: PathBuf,
    }

    #[cfg(debug_assertions)]
    impl IsolatedConfigDir {
        fn new(prefix: &str) -> Self {
            let path = temp_config_path(prefix);
            let base = path
                .parent()
                .and_then(Path::parent)
                .expect("temp path has two parents")
                .to_path_buf();
            std::fs::create_dir_all(&base).expect("create isolated dir");
            std::env::set_var("ARBOR_CONFIG_DIR", &base);
            Self { base }
        }
    }

    #[cfg(debug_assertions)]
    impl Drop for IsolatedConfigDir {
        fn drop(&mut self) {
            std::env::remove_var("ARBOR_CONFIG_DIR");
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    #[cfg(debug_assertions)]
    #[test]
    fn load_config_and_modify_config_use_the_isolated_config_dir() {
        let isolated = IsolatedConfigDir::new("isolated");

        // ファイルが無ければ既定値
        let initial = load_config().expect("load");
        assert_eq!(initial.settings.stale_threshold_days, 14);

        // 変更は、隔離先の config.toml に保存される
        let updated = modify_config(|mut config| {
            config.settings.stale_threshold_days = 21;
            Ok(config)
        })
        .expect("modify");
        assert_eq!(updated.settings.stale_threshold_days, 21);
        assert!(isolated.base.join("arbor").join("config.toml").exists());
        assert_eq!(
            load_config().expect("reload").settings.stale_threshold_days,
            21
        );

        // 失敗した変更は、保存済みの設定を変えない
        assert!(modify_config(|_| Err("rejected".to_string())).is_err());
        assert_eq!(
            load_config().expect("reload").settings.stale_threshold_days,
            21
        );
    }
}
