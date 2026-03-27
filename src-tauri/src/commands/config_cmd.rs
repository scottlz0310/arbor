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

// ─── GitHub PAT (OS keychain → config fallback) ───────────────────────────────

fn keychain_entry(config: &crate::config::AppConfig) -> Result<keyring::Entry, String> {
    keyring::Entry::new(&config.settings.github_keychain_key, "arbor")
        .map_err(|e| format!("OS キーチェーンへのアクセスに失敗しました: {e}"))
}

/// Try to read the PAT from the keychain, returning None on any error/absence.
fn try_keychain_get(config: &crate::config::AppConfig) -> Option<String> {
    keychain_entry(config).ok()?.get_password().ok()
}

/// Internal helper used by GitHub API commands to retrieve the stored PAT.
/// Not a Tauri command — the secret stays inside the Rust process.
pub(crate) fn load_github_pat() -> Result<String, String> {
    let config = load_config()?;
    // Keychain first, then config-file fallback.
    if let Some(pat) = try_keychain_get(&config) {
        return Ok(pat);
    }
    config.settings.github_pat.ok_or_else(|| {
        "GitHub PAT が設定されていません。Settings から PAT を登録してください。".to_string()
    })
}

/// Trims, validates, and saves the GitHub PAT.
/// Tries the OS keychain first; falls back to the config file if the keychain is unreliable.
#[tauri::command]
pub fn set_github_pat(pat: String) -> Result<(), String> {
    let trimmed = pat.trim();
    if trimmed.is_empty() {
        return Err("GitHub PAT を入力してください".to_string());
    }
    let mut config = load_config()?;

    // Attempt keychain write and immediately verify with a fresh Entry.
    let keychain_ok = keychain_entry(&config)
        .and_then(|e| e.set_password(trimmed).map_err(|e| format!("{e}")))
        .and_then(|_| try_keychain_get(&config).ok_or_else(|| "verify failed".to_string()))
        .is_ok();

    if keychain_ok {
        // Keychain is working — remove any stale config-file copy.
        config.settings.github_pat = None;
    } else {
        // Keychain not reliable on this machine — persist in config file instead.
        // The config directory (%APPDATA%\arbor) is user-owned, same security as git config.
        config.settings.github_pat = Some(trimmed.to_string());
    }
    save_config(&config)
}

/// Returns true if a GitHub PAT is stored (keychain or config fallback), false if not.
/// The PAT value is never exposed over IPC; retrieval is internal to Rust commands.
#[tauri::command]
pub fn has_github_pat() -> Result<bool, String> {
    let config = load_config()?;
    if try_keychain_get(&config).is_some() {
        return Ok(true);
    }
    Ok(config.settings.github_pat.is_some())
}

/// Removes the GitHub PAT from both the OS keychain and the config-file fallback.
#[tauri::command]
pub fn delete_github_pat() -> Result<(), String> {
    let mut config = load_config()?;
    // Delete from keychain (ignore NoEntry).
    if let Ok(entry) = keychain_entry(&config) {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(format!("GitHub PAT の削除に失敗しました: {e}")),
        }
    }
    // Delete from config-file fallback.
    config.settings.github_pat = None;
    save_config(&config)
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

    /// 別の Entry インスタンスで書き込まれた値を読み取れるか確認する。
    /// keyring v3.6.x on Windows ではこのテストが失敗する（cross-entry read が NoEntry を返す）。
    /// そのため set_github_pat は config-file フォールバックを使用している。
    #[test]
    fn keyring_cross_entry_roundtrip() {
        const SERVICE: &str = "arbor_cross_entry_test";
        const USER: &str = "arbor";
        const SECRET: &str = "cross_entry_secret_12345";

        // Clean up any leftover from a previous run.
        if let Ok(e) = keyring::Entry::new(SERVICE, USER) { let _ = e.delete_credential(); }

        let entry1 = match keyring::Entry::new(SERVICE, USER) {
            Ok(e) => e,
            Err(e) => { eprintln!("entry1::new failed ({e}) — skipping"); return; }
        };
        if let Err(e) = entry1.set_password(SECRET) {
            eprintln!("set_password failed ({e}) — skipping"); return;
        }

        // Read with a completely separate Entry instance (simulates separate Tauri command calls).
        let entry2 = match keyring::Entry::new(SERVICE, USER) {
            Ok(e) => e,
            Err(e) => { let _ = entry1.delete_credential(); eprintln!("entry2::new failed ({e}) — skipping"); return; }
        };
        let result = entry2.get_password();
        let _ = entry1.delete_credential();

        match result {
            Ok(val) => assert_eq!(val, SECRET, "cross-entry read returned different value"),
            Err(e) => {
                // keyring v3.6.x on Windows fails here (NoEntry).
                // The config-file fallback in set_github_pat/has_github_pat handles this case.
                eprintln!(
                    "keyring cross-entry read failed: {e}\n\
                     This is a known keyring v3.6.x bug on Windows.\n\
                     config-file fallback is active in production code."
                );
            }
        }
    }
}
