use crate::config::{load_config, save_config, AppConfig, RepoConfig};

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
    use super::{filter_missing_repos, validate_workspace_root};
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
}
