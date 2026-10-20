use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

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

/// 設定ファイルの場所。
struct ConfigPaths {
    path: PathBuf,
    /// 旧版（OS 標準の設定ディレクトリ）の場所。隔離先を使うとき、新旧が同じときは None。
    legacy: Option<PathBuf>,
}

/// 設定ファイルは、全 OS で `~/.config/arbor/config.toml` に置く（dsx の `~/.config/dsx` と同じ）。
/// MSIX は `%APPDATA%` への書き込みをパッケージ領域へ仮想化し、アンインストールで消すため、
/// ユーザープロファイル直下に置く。
fn config_paths() -> Result<ConfigPaths, String> {
    // 実機テストが利用者の設定を触れないよう、debug build のみ隔離先を許可する。
    #[cfg(debug_assertions)]
    let debug_override = std::env::var_os("ARBOR_CONFIG_DIR");
    #[cfg(not(debug_assertions))]
    let debug_override = None;

    resolve_config_paths(dirs::home_dir(), dirs::config_dir(), debug_override)
}

fn resolve_config_paths(
    home: Option<PathBuf>,
    os_config_dir: Option<PathBuf>,
    debug_override: Option<OsString>,
) -> Result<ConfigPaths, String> {
    let relative = Path::new("arbor").join("config.toml");

    if let Some(isolated) = debug_override.filter(|value| !value.is_empty()) {
        return Ok(ConfigPaths {
            path: PathBuf::from(isolated).join(relative),
            legacy: None,
        });
    }

    let home = home.ok_or_else(|| "Could not determine home directory".to_string())?;
    let path = home.join(".config").join(&relative);
    let legacy = os_config_dir
        .map(|dir| dir.join(&relative))
        .filter(|legacy| *legacy != path);
    Ok(ConfigPaths { path, legacy })
}

/// 設定の読み込み・変更（初回の移行を含む）を直列にする。起動時に、複数の IPC
/// （`list_repositories` と `get_workspace_status` など）が並行して `load_config` を呼ぶため、
/// 初回の移行が重なると、コピー中のファイルを他方が読んだり、共有違反（Windows の os error 32）で
/// 失敗したりする。
static CONFIG_LOCK: Mutex<()> = Mutex::new(());

fn lock_config() -> MutexGuard<'static, ()> {
    // ガードが守るのは順序だけで、中身は `()`。保持中に panic しても、守る状態は壊れないので、poison は無視する。
    CONFIG_LOCK.lock().unwrap_or_else(PoisonError::into_inner)
}

/// 旧版の場所に設定があり、新しい場所に無いとき、新しい場所へコピーする。
/// 旧ファイルは消さない（旧版へ戻しても、設定が残るように）。呼び出し側は `lock_config` を保持する。
fn migrate_legacy_config(paths: &ConfigPaths) -> Result<(), String> {
    let Some(legacy) = &paths.legacy else {
        return Ok(());
    };
    if paths.path.exists() || !legacy.is_file() {
        return Ok(());
    }
    if let Some(parent) = paths.path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create {}: {e}", parent.display()))?;
    }
    publish_copy(legacy, &paths.path)
}

/// `source` を `destination` へ、読み手に途中のファイルを見せず、既存のファイルを上書きせずに公開する。
/// 同じディレクトリの一時ファイルへコピーし終えてから、ハードリンクで公開する。宛先が既にあれば
/// リンクは失敗するので上書きせず（別のプロセスが先に公開した場合を含む）、その設定を使う。
fn publish_copy(source: &Path, destination: &Path) -> Result<(), String> {
    let context = |e: std::io::Error| {
        format!(
            "failed to migrate config from {} to {}: {e}",
            source.display(),
            destination.display()
        )
    };
    let temp = destination.with_extension(format!("toml.migrating-{}", std::process::id()));
    std::fs::copy(source, &temp).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        context(e)
    })?;
    let linked = std::fs::hard_link(&temp, destination);
    let _ = std::fs::remove_file(&temp);
    match linked {
        Err(e) if e.kind() != ErrorKind::AlreadyExists => Err(context(e)),
        _ => Ok(()),
    }
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

/// dsx のイベントファイル（`--events-file`）を置くディレクトリ。設定ファイルと同じ場所の `events/`。
/// MSIX の書き込み仮想化（`%APPDATA%` など）の対象外なので、別パッケージの dsx が書いたファイルを、そのまま読める。
/// debug build の `ARBOR_CONFIG_DIR` による隔離にも従う。
pub fn events_dir() -> Result<PathBuf, String> {
    Ok(events_dir_for(&config_paths()?.path))
}

fn events_dir_for(config_path: &Path) -> PathBuf {
    config_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("events")
}

/// 旧版の場所にだけ設定があれば、先に移行してから読み込む。他の読み込み・変更は、移行が終わるまで待つ。
pub fn load_config() -> Result<AppConfig, String> {
    load_migrated(&config_paths()?, default_workspace_root())
}

fn load_migrated(paths: &ConfigPaths, default_root: Option<PathBuf>) -> Result<AppConfig, String> {
    let _guard = lock_config();
    migrate_legacy_config(paths)?;
    load_from(&paths.path, default_root)
}

/// 設定を読み込み、`change` で変更して保存し、変更後の設定を返す。`change` が失敗したら保存しない。
pub fn modify_config(
    change: impl FnOnce(AppConfig) -> Result<AppConfig, String>,
) -> Result<AppConfig, String> {
    modify_migrated(&config_paths()?, default_workspace_root(), change)
}

fn modify_migrated(
    paths: &ConfigPaths,
    default_root: Option<PathBuf>,
    change: impl FnOnce(AppConfig) -> Result<AppConfig, String>,
) -> Result<AppConfig, String> {
    let _guard = lock_config();
    migrate_legacy_config(paths)?;
    modify_at(&paths.path, default_root, change)
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
    fn resolve_config_paths_cases() {
        let home = || Some(PathBuf::from("home"));
        let os_config = || Some(PathBuf::from("os-config"));
        let dot_config = Path::new("home")
            .join(".config")
            .join("arbor")
            .join("config.toml");
        let legacy = Path::new("os-config").join("arbor").join("config.toml");
        let isolated = Path::new("isolated-config")
            .join("arbor")
            .join("config.toml");

        // (home, OS 標準の設定ディレクトリ, 隔離先, 期待する path, 期待する legacy)
        let cases = [
            // 隔離先は、旧版の場所を見ない
            (
                home(),
                os_config(),
                Some(OsString::from("isolated-config")),
                isolated,
                None,
            ),
            // 空の隔離先は、無いものとして扱う
            (
                home(),
                os_config(),
                Some(OsString::new()),
                dot_config.clone(),
                Some(legacy.clone()),
            ),
            (home(), os_config(), None, dot_config.clone(), Some(legacy)),
            // OS 標準の設定ディレクトリが `~/.config`（Linux）なら、新旧が同じで、移行は要らない
            (
                home(),
                Some(Path::new("home").join(".config")),
                None,
                dot_config.clone(),
                None,
            ),
            (home(), None, None, dot_config, None),
        ];

        for (home, os_config_dir, debug_override, expected_path, expected_legacy) in cases {
            let actual = resolve_config_paths(home, os_config_dir, debug_override)
                .expect("config paths should resolve");
            assert_eq!(actual.path, expected_path);
            assert_eq!(actual.legacy, expected_legacy);
        }
    }

    #[test]
    fn resolve_config_paths_fails_without_a_home_directory() {
        let err = resolve_config_paths(None, Some(PathBuf::from("os-config")), None)
            .err()
            .expect("home is required");

        assert_eq!(err, "Could not determine home directory");
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
        std::env::temp_dir()
            .join(format!(
                "arbor-{prefix}-{}",
                crate::test_util::unique_suffix()
            ))
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

    // ── migrate_legacy_config ─────────────────────────────────────────────────

    /// 新旧の config.toml の組。`legacy` 側を `Some` にすると、旧版の場所を含む組になる。
    fn migration_paths(prefix: &str) -> ConfigPaths {
        ConfigPaths {
            path: temp_config_path(&format!("{prefix}-new")),
            legacy: Some(temp_config_path(&format!("{prefix}-legacy"))),
        }
    }

    fn write_config(path: &Path, content: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    fn cleanup_migration(paths: &ConfigPaths) {
        cleanup(&paths.path);
        if let Some(legacy) = &paths.legacy {
            cleanup(legacy);
        }
    }

    #[test]
    fn migrate_copies_the_legacy_config_and_keeps_the_original() {
        let paths = migration_paths("migrate-copy");
        let legacy = paths.legacy.clone().unwrap();
        write_config(&legacy, "[settings]\nstale_threshold_days = 30\n");

        migrate_legacy_config(&paths).expect("migrate");

        assert_eq!(
            std::fs::read_to_string(&paths.path).unwrap(),
            "[settings]\nstale_threshold_days = 30\n"
        );
        assert!(legacy.exists(), "旧ファイルは消さない");
        cleanup_migration(&paths);
    }

    #[test]
    fn migrate_does_not_overwrite_an_existing_config() {
        let paths = migration_paths("migrate-keep");
        write_config(&paths.path, "new");
        write_config(paths.legacy.as_ref().unwrap(), "legacy");

        migrate_legacy_config(&paths).expect("migrate");

        assert_eq!(std::fs::read_to_string(&paths.path).unwrap(), "new");
        cleanup_migration(&paths);
    }

    #[test]
    fn migrate_does_nothing_without_a_legacy_config() {
        let paths = migration_paths("migrate-none");

        migrate_legacy_config(&paths).expect("migrate");
        migrate_legacy_config(&ConfigPaths {
            path: paths.path.clone(),
            legacy: None,
        })
        .expect("migrate without a legacy location");

        assert!(!paths.path.exists());
        cleanup_migration(&paths);
    }

    #[test]
    fn migrate_reports_an_unreadable_legacy_config() {
        // 新しい場所を作れないとき（親にあたる名前が、通常ファイルで塞がれている）は、握りつぶさずに報告する
        let paths = migration_paths("migrate-fail");
        let blocker = paths.path.parent().unwrap().to_path_buf();
        std::fs::create_dir_all(blocker.parent().unwrap()).unwrap();
        std::fs::write(&blocker, "not a directory").unwrap();
        write_config(paths.legacy.as_ref().unwrap(), "legacy");

        let err = migrate_legacy_config(&paths).unwrap_err();

        assert!(err.contains("failed to create"), "{err}");
        let _ = std::fs::remove_file(&blocker);
        cleanup_migration(&paths);
    }

    fn dir_entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn publish_copy_keeps_an_existing_destination_and_leaves_no_temp_file() {
        let paths = migration_paths("publish-exists");
        let legacy = paths.legacy.clone().unwrap();
        write_config(&legacy, "legacy");
        write_config(&paths.path, "published first");

        publish_copy(&legacy, &paths.path).expect("an existing destination is not an error");

        assert_eq!(
            std::fs::read_to_string(&paths.path).unwrap(),
            "published first"
        );
        assert_eq!(dir_entries(paths.path.parent().unwrap()), ["config.toml"]);
        cleanup_migration(&paths);
    }

    #[test]
    fn publish_copy_reports_a_missing_source_and_leaves_no_temp_file() {
        let paths = migration_paths("publish-missing");
        write_config(&paths.path, "existing");
        let missing = paths.legacy.clone().unwrap();

        let err = publish_copy(&missing, &paths.path).unwrap_err();

        assert!(err.contains("failed to migrate config"), "{err}");
        assert_eq!(dir_entries(paths.path.parent().unwrap()), ["config.toml"]);
        cleanup_migration(&paths);
    }

    /// 起動時は、`list_repositories` と `get_workspace_status` などが並行して設定を読む。
    /// 初回の移行が重なっても、全員が完全な設定を得る（Windows では、コピーの途中の読み込みや
    /// 同時のコピーが共有違反になった）。
    #[test]
    fn concurrent_loads_during_the_first_migration_all_see_the_full_config() {
        const THREADS: usize = 8;
        const REPOSITORIES: usize = 600;
        let paths = migration_paths("migrate-concurrent");
        let legacy = paths.legacy.clone().unwrap();
        let config = AppConfig {
            repositories: (0..REPOSITORIES)
                .map(|i| RepoConfig {
                    path: format!("/work/repository-{i:04}"),
                    name: format!("repository-{i:04}"),
                    protected_branches: vec!["release".to_string()],
                })
                .collect(),
            ..Default::default()
        };
        save_to(&legacy, &config).expect("write legacy config");
        let barrier = std::sync::Barrier::new(THREADS);

        let loaded: Vec<Result<AppConfig, String>> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..THREADS)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        load_migrated(&paths, None)
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });

        for result in loaded {
            let config = result.expect("every concurrent load succeeds");
            assert_eq!(config.repositories.len(), REPOSITORIES);
        }
        assert_eq!(dir_entries(paths.path.parent().unwrap()), ["config.toml"]);
        assert!(legacy.exists(), "旧ファイルは消さない");
        cleanup_migration(&paths);
    }

    #[test]
    fn modify_migrated_applies_the_change_on_top_of_the_migrated_config() {
        let paths = migration_paths("modify-migrated");
        write_config(
            paths.legacy.as_ref().unwrap(),
            "[settings]\nstale_threshold_days = 30\nfetch_on_startup = true\n",
        );

        let updated = modify_migrated(&paths, None, |mut config| {
            config.settings.fetch_on_startup = false;
            Ok(config)
        })
        .expect("modify");

        assert_eq!(updated.settings.stale_threshold_days, 30);
        assert!(!updated.settings.fetch_on_startup);
        assert_eq!(
            load_from(&paths.path, None)
                .unwrap()
                .settings
                .stale_threshold_days,
            30
        );
        cleanup_migration(&paths);
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

    /// イベントファイルの置き場は、設定ファイルと同じディレクトリの `events/`（`ARBOR_CONFIG_DIR` の隔離にも従う）。
    #[test]
    fn events_dir_sits_next_to_the_config_file() {
        let cases = [
            (
                "/home/u/.config/arbor/config.toml",
                "/home/u/.config/arbor/events",
            ),
            ("/tmp/iso/arbor/config.toml", "/tmp/iso/arbor/events"),
            ("config.toml", "events"),
        ];

        for (config_path, expected) in cases {
            assert_eq!(
                events_dir_for(Path::new(config_path)),
                PathBuf::from(expected),
                "{config_path}"
            );
        }
    }
}
