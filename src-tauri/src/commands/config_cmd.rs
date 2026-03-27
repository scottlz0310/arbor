use crate::config::{load_config, save_config, AppConfig, RepoConfig};
use tauri::AppHandle;

#[tauri::command]
pub fn get_config() -> Result<AppConfig, String> {
    load_config()
}

#[tauri::command]
pub fn add_repository(
    path: String,
    name: String,
    github_owner: Option<String>,
    github_repo: Option<String>,
) -> Result<AppConfig, String> {
    let mut config = load_config()?;

    // Validate the path is actually a git repository.
    git2::Repository::open(&path)
        .map_err(|e| format!("Not a git repository: {e}"))?;

    // Avoid duplicate entries.
    if config.repositories.iter().any(|r| r.path == path) {
        return Err(format!("Repository already registered: {path}"));
    }

    config.repositories.push(RepoConfig {
        path,
        name,
        github_owner,
        github_repo,
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

// ─── GitHub PAT (OS keychain) ─────────────────────────────────────────────────

/// Internal helper used by GitHub API commands to retrieve the stored PAT.
/// Not a Tauri command — the secret stays inside the Rust process.
pub(crate) fn load_github_pat() -> Result<String, String> {
    let config = load_config()?;
    match keychain_entry(&config)?.get_password() {
        Ok(pat) => Ok(pat),
        Err(keyring::Error::NoEntry) => Err(
            "GitHub PAT が設定されていません。Settings から PAT を登録してください。".to_string(),
        ),
        Err(e) => Err(format!("OS キーチェーンの読み取りに失敗しました: {e}")),
    }
}

fn keychain_entry(config: &crate::config::AppConfig) -> Result<keyring::Entry, String> {
    keyring::Entry::new(&config.settings.github_keychain_key, "github")
        .map_err(|e| format!("OS キーチェーンへのアクセスに失敗しました: {e}"))
}

/// Trims, validates, and saves the GitHub PAT to the OS keychain.
#[tauri::command]
pub fn set_github_pat(pat: String) -> Result<(), String> {
    let trimmed = pat.trim();
    if trimmed.is_empty() {
        return Err("GitHub PAT を入力してください".to_string());
    }
    let config = load_config()?;
    keychain_entry(&config)?
        .set_password(trimmed)
        .map_err(|e| format!("GitHub PAT の保存に失敗しました: {e}"))
}

/// Returns true if a GitHub PAT is stored, false if not.
/// The PAT value is never exposed over IPC; retrieval is internal to Rust commands.
#[tauri::command]
pub fn has_github_pat() -> Result<bool, String> {
    let config = load_config()?;
    match keychain_entry(&config)?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(format!("OS キーチェーンの読み取りに失敗しました: {e}")),
    }
}

/// Removes the GitHub PAT from the OS keychain.
#[tauri::command]
pub fn delete_github_pat() -> Result<(), String> {
    let config = load_config()?;
    match keychain_entry(&config)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("GitHub PAT の削除に失敗しました: {e}")),
    }
}

// ─── scan_directory ───────────────────────────────────────────────────────────

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
    _app: AppHandle,
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
    /// キーチェーンの書き込み → 読み取り → 削除が正常に動作することを確認する。
    /// キーチェーンが利用できない環境（CI サービスアカウント等）ではスキップする。
    #[test]
    fn keyring_roundtrip() {
        const SERVICE: &str = "arbor_keyring_test";
        const USER: &str = "test";
        const SECRET: &str = "roundtrip_secret_12345";

        let entry = match keyring::Entry::new(SERVICE, USER) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("keyring::Entry::new failed ({e}) — skipping");
                return;
            }
        };

        // 前回テストの残骸を削除
        let _ = entry.delete_credential();

        if let Err(e) = entry.set_password(SECRET) {
            eprintln!("set_password failed ({e}) — keyring not functional, skipping");
            return;
        }

        match entry.get_password() {
            Ok(val) => {
                let _ = entry.delete_credential();
                assert_eq!(val, SECRET, "キーチェーンの読み取り値が書き込み値と一致しない");
            }
            Err(e) => {
                let _ = entry.delete_credential();
                panic!("set_password は成功したが get_password が失敗: {e}");
            }
        }
    }
}
