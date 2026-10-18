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

// ─── scan_directory / scan_missing_repositories ──────────────────────────────

/// Filters `repos` to those whose path does not exist on disk.
fn filter_missing_repos(repos: Vec<RepoConfig>) -> Vec<RepoConfig> {
    repos
        .into_iter()
        .filter(|r| !std::path::Path::new(&r.path).exists())
        .collect()
}

/// Returns repositories registered in config whose path no longer exists on disk.
#[tauri::command]
pub fn scan_missing_repositories() -> Result<Vec<RepoConfig>, String> {
    let config = load_config()?;
    Ok(filter_missing_repos(config.repositories))
}

#[tauri::command]
pub fn scan_directory(root: String) -> Result<Vec<String>, String> {
    use std::path::Path;

    let mut found = Vec::new();
    scan_recursive(Path::new(&root), &mut found, 0);
    Ok(found)
}

fn scan_recursive(dir: &std::path::Path, found: &mut Vec<String>, depth: u32) {
    if depth > 4 {
        return;
    }
    let git_dir = dir.join(".git");
    if git_dir.exists() {
        found.push(dir.to_string_lossy().into_owned());
        return; // Don't descend into sub-repos.
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                // Skip hidden directories (e.g. .git, node_modules handled above).
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if !name_str.starts_with('.') && name_str != "node_modules" {
                    scan_recursive(&path, found, depth + 1);
                }
            }
        }
    }
}

#[tauri::command]
pub fn update_settings(
    stale_threshold_days: Option<u32>,
    fetch_on_startup: Option<bool>,
) -> Result<AppConfig, String> {
    let mut config = load_config()?;
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
    use super::filter_missing_repos;
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
