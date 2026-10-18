use crate::config::{load_config, save_config, AppConfig, RepoConfig};
use crate::models::RepoSource;
use crate::workspace::effective_repos;

#[tauri::command]
pub fn get_config() -> Result<AppConfig, String> {
    load_config()
}

#[tauri::command]
pub fn add_repository(path: String, name: String) -> Result<AppConfig, String> {
    let mut config = load_config()?;

    // Validate the path is actually a git repository.
    git2::Repository::open(&path).map_err(|e| format!("Not a git repository: {e}"))?;

    // Avoid duplicate entries.
    if config.repositories.iter().any(|r| r.path == path) {
        return Err(format!("Repository already registered: {path}"));
    }

    config.repositories.push(RepoConfig {
        path,
        name,
        protected_branches: Vec::new(),
    });

    save_config(&config)?;
    Ok(config)
}

#[tauri::command]
pub fn remove_repository(path: String) -> Result<AppConfig, String> {
    let mut config = load_config()?;
    config.repositories.retain(|r| r.path != path);
    save_config(&config)?;
    Ok(config)
}

// ─── scan_missing_repositories ───────────────────────────────────────────────

/// Filters `repos` to those whose path does not exist on disk.
fn filter_missing_repos(repos: Vec<RepoConfig>) -> Vec<RepoConfig> {
    repos
        .into_iter()
        .filter(|r| !std::path::Path::new(&r.path).exists())
        .collect()
}

/// `update_settings` に渡された workspace root を検証する。空文字列は自動検出の無効化。
fn validate_workspace_root(root: &str) -> Result<String, String> {
    let trimmed = root.trim();
    if !trimmed.is_empty() && !std::path::Path::new(trimmed).is_dir() {
        return Err(format!(
            "workspace root がディレクトリではありません: {trimmed}"
        ));
    }
    Ok(trimmed.to_string())
}

/// Header の root 表示に使う、workspace の現況。
#[derive(Debug, serde::Serialize)]
pub struct WorkspaceStatus {
    /// 自動検出の root。未設定・無効化（空文字列）なら None。
    pub root: Option<String>,
    /// root を読み取れなかったときの理由。
    pub root_error: Option<String>,
    /// root 配下で自動検出したリポジトリ数。
    pub workspace_count: usize,
    /// root の外の手動登録リポジトリ数。
    pub manual_count: usize,
}

fn workspace_status(config: &AppConfig) -> WorkspaceStatus {
    let (repos, root_error) = effective_repos(config);
    let count = |source| repos.iter().filter(|r| r.source == source).count();
    WorkspaceStatus {
        root: config.workspace.root.clone().filter(|r| !r.is_empty()),
        root_error,
        workspace_count: count(RepoSource::Workspace),
        manual_count: count(RepoSource::Manual),
    }
}

/// workspace root と、検出したリポジトリ数を返す。root を読めない場合は `root_error` に理由を入れる。
#[tauri::command(async)]
pub fn get_workspace_status() -> Result<WorkspaceStatus, String> {
    Ok(workspace_status(&load_config()?))
}

/// Returns repositories registered in config whose path no longer exists on disk.
#[tauri::command]
pub fn scan_missing_repositories() -> Result<Vec<RepoConfig>, String> {
    let config = load_config()?;
    Ok(filter_missing_repos(config.repositories))
}

#[tauri::command]
pub fn update_settings(
    stale_threshold_days: Option<u32>,
    fetch_on_startup: Option<bool>,
    workspace_root: Option<String>,
) -> Result<AppConfig, String> {
    let mut config = load_config()?;
    if let Some(root) = workspace_root {
        config.workspace.root = Some(validate_workspace_root(&root)?);
    }
    if let Some(v) = stale_threshold_days {
        config.settings.stale_threshold_days = v;
    }
    if let Some(v) = fetch_on_startup {
        config.settings.fetch_on_startup = v;
    }
    save_config(&config)?;
    Ok(config)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::{filter_missing_repos, validate_workspace_root, workspace_status};
    use crate::config::AppConfig;
    use crate::config::RepoConfig;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(prefix: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock should be after epoch")
                .as_nanos();
            let path = std::env::temp_dir()
                .join(format!("arbor-{prefix}-{}-{unique}", std::process::id()));
            std::fs::create_dir_all(&path).expect("create temp dir");
            Self { path }
        }

        fn path_str(&self) -> &str {
            self.path.to_str().expect("temp path should be utf-8")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn make_repo(path: &str) -> RepoConfig {
        RepoConfig {
            path: path.into(),
            name: path.split('/').next_back().unwrap_or(path).into(),
            protected_branches: Vec::new(),
        }
    }

    #[test]
    fn validate_workspace_root_cases() {
        let dir = TempDir::new("workspace-root");
        let file = dir.path.join("file.txt");
        std::fs::write(&file, "x").unwrap();
        let padded = format!("  {}  ", dir.path_str());

        let ok_cases = [
            ("空文字列は自動検出の無効化", String::new(), String::new()),
            ("空白だけも無効化", "   ".to_string(), String::new()),
            (
                "存在するディレクトリ（前後の空白は除く）",
                padded,
                dir.path_str().to_string(),
            ),
        ];
        for (name, input, expected) in ok_cases {
            assert_eq!(validate_workspace_root(&input), Ok(expected), "{name}");
        }

        let err_cases = [
            (
                "存在しないパス",
                dir.path.join("missing").to_string_lossy().into_owned(),
            ),
            ("ファイル", file.to_string_lossy().into_owned()),
        ];
        for (name, input) in err_cases {
            let error = validate_workspace_root(&input).expect_err(name);
            assert!(
                error.contains("ディレクトリではありません"),
                "{name}: {error}"
            );
        }
    }

    #[test]
    fn filter_missing_repos_returns_only_nonexistent_paths() {
        let existing = TempDir::new("filter-existing");
        let repos = vec![
            make_repo(existing.path_str()),
            make_repo("/nonexistent/__arbor_test_missing__"),
        ];
        let missing = filter_missing_repos(repos);
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].name, "__arbor_test_missing__");
    }

    #[test]
    fn filter_missing_repos_empty_when_all_exist() {
        let existing = TempDir::new("filter-all-exist");
        let repos = vec![make_repo(existing.path_str())];
        let missing = filter_missing_repos(repos);
        assert!(missing.is_empty());
    }

    #[test]
    fn filter_missing_repos_all_missing() {
        let repos = vec![
            make_repo("/nonexistent/__arbor_a__"),
            make_repo("/nonexistent/__arbor_b__"),
        ];
        let missing = filter_missing_repos(repos);
        assert_eq!(missing.len(), 2);
    }

    #[test]
    fn workspace_status_counts_repositories_by_source() {
        let dir = TempDir::new("workspace-status");
        std::fs::create_dir_all(dir.path.join("alpha").join(".git")).unwrap();
        std::fs::create_dir_all(dir.path.join("beta").join(".git")).unwrap();
        let mut config = AppConfig::default();
        config.workspace.root = Some(dir.path_str().to_string());
        config.repositories = vec![make_repo("/elsewhere/gamma")];

        let status = workspace_status(&config);

        assert_eq!(status.root.as_deref(), Some(dir.path_str()));
        assert_eq!(status.root_error, None);
        assert_eq!((status.workspace_count, status.manual_count), (2, 1));
    }

    #[test]
    fn workspace_status_reports_unusable_roots() {
        let missing = TempDir::new("workspace-status-missing")
            .path
            .join("gone")
            .to_string_lossy()
            .into_owned();
        let cases = [
            ("未設定", None, None, false),
            ("自動検出の無効化", Some(String::new()), None, false),
            (
                "root が存在しない",
                Some(missing.clone()),
                Some(missing.as_str()),
                true,
            ),
        ];

        for (name, root, expected_root, has_error) in cases {
            let mut config = AppConfig::default();
            config.workspace.root = root;
            config.repositories = vec![make_repo("/elsewhere/gamma")];

            let status = workspace_status(&config);

            assert_eq!(status.root.as_deref(), expected_root, "{name}");
            assert_eq!(status.root_error.is_some(), has_error, "{name}");
            // 手動登録は root の状態に関わらず残る。
            assert_eq!(
                (status.workspace_count, status.manual_count),
                (0, 1),
                "{name}"
            );
        }
    }
}
