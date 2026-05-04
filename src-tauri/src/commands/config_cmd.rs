use crate::config::{load_config, save_config, AppConfig, RepoConfig};
use tauri::AppHandle;

#[tauri::command]
pub fn get_config() -> Result<AppConfig, String> {
    load_config()
}

/// Parses a GitHub remote URL and returns `(owner, repo)`.
/// Supports HTTPS (`https://github.com/owner/repo[.git]`) and
/// SSH (`git@github.com:owner/repo[.git]`) formats.
fn parse_github_url(url: &str) -> Option<(String, String)> {
    let path = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("http://github.com/"))
        .or_else(|| url.strip_prefix("git@github.com:"))?;
    let path = path.trim_end_matches('/').trim_end_matches(".git");
    let (owner, repo) = path.split_once('/')?;
    if owner.is_empty() || repo.is_empty() { return None; }
    Some((owner.to_string(), repo.to_string()))
}

/// Tries to read the `origin` remote URL from the git repo and detect GitHub owner/repo.
fn detect_from_git(repo_path: &str) -> Option<(String, String)> {
    let repo = git2::Repository::open(repo_path).ok()?;
    let remote = repo.find_remote("origin").ok()?;
    parse_github_url(remote.url()?)
}

/// Returns the GitHub owner and repo detected from the `origin` remote URL.
/// Returns `null` for both fields if the remote is not a GitHub URL.
#[tauri::command]
pub fn detect_github_remote(path: String) -> (Option<String>, Option<String>) {
    match detect_from_git(&path) {
        Some((owner, repo)) => (Some(owner), Some(repo)),
        None => (None, None),
    }
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

    // Auto-detect GitHub owner/repo from the origin remote if not provided.
    let (github_owner, github_repo) = if github_owner.is_some() || github_repo.is_some() {
        (github_owner, github_repo)
    } else {
        match detect_from_git(&path) {
            Some((owner, repo)) => (Some(owner), Some(repo)),
            None => (None, None),
        }
    };

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

/// Updates the GitHub owner/repo fields for an existing registered repository.
/// Both must be `Some` (non-empty) or both `None`; mixed state is rejected.
#[tauri::command]
pub fn update_repository_github(
    path: String,
    github_owner: Option<String>,
    github_repo: Option<String>,
) -> Result<AppConfig, String> {
    // Normalise: empty strings are treated as None.
    let owner = github_owner.and_then(|s| { let t = s.trim().to_string(); if t.is_empty() { None } else { Some(t) } });
    let repo_name = github_repo.and_then(|s| { let t = s.trim().to_string(); if t.is_empty() { None } else { Some(t) } });
    // Validate: both set or both None.
    match (&owner, &repo_name) {
        (Some(_), None) | (None, Some(_)) =>
            return Err("github_owner と github_repo は両方設定するか、両方空にしてください".to_string()),
        _ => {}
    }
    let mut config = load_config()?;
    let repo = config
        .repositories
        .iter_mut()
        .find(|r| r.path == path)
        .ok_or_else(|| format!("Repository not found: {path}"))?;
    repo.github_owner = owner;
    repo.github_repo = repo_name;
    save_config(&config)?;
    Ok(config)
}

// ─── GitHub PAT storage ───────────────────────────────────────────────────────
//
// Windows: keyring v3.6.x had a cross-entry-read bug (separate Entry instances
// could not read each other's credentials), and v4 is no longer a library.
// We encrypt the PAT with Windows DPAPI (user-account-scoped; unreadable
// on other machines) and store the resulting base64 blob in config.toml.
//
// macOS/Linux: use keyring-core v1 with a platform-native credential store
// (Apple Keychain on macOS, Secret Service via D-Bus on Linux).

#[cfg(target_os = "windows")]
mod pat_crypto {
    use std::ptr;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    // LocalFree is not exposed by windows-sys 0.52; declare it directly.
    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(hmem: *mut core::ffi::c_void) -> *mut core::ffi::c_void;
    }

    fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 }
    }

    pub fn encrypt(plaintext: &str) -> Result<String, String> {
        let input = plaintext.as_bytes();
        let data_in = blob(input);
        let mut data_out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: ptr::null_mut() };
        unsafe {
            let ok: i32 = CryptProtectData(
                &data_in, ptr::null(), ptr::null_mut(),
                ptr::null_mut(), ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN, &mut data_out,
            );
            if ok == 0 {
                return Err("DPAPI 暗号化に失敗しました".to_string());
            }
            let enc = std::slice::from_raw_parts(data_out.pbData, data_out.cbData as usize).to_vec();
            LocalFree(data_out.pbData.cast());
            Ok(base64_encode(&enc))
        }
    }

    pub fn decrypt(encoded: &str) -> Result<String, String> {
        let ciphertext = base64_decode(encoded)
            .map_err(|_| "DPAPI blob の base64 デコードに失敗しました".to_string())?;
        let data_in = blob(&ciphertext);
        let mut data_out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: ptr::null_mut() };
        unsafe {
            let ok: i32 = CryptUnprotectData(
                &data_in, ptr::null_mut(), ptr::null_mut(),
                ptr::null_mut(), ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN, &mut data_out,
            );
            if ok == 0 {
                return Err("DPAPI 復号に失敗しました（別のユーザー/マシンの blob は復号できません）".to_string());
            }
            let bytes = std::slice::from_raw_parts(data_out.pbData, data_out.cbData as usize).to_vec();
            LocalFree(data_out.pbData.cast());
            String::from_utf8(bytes).map_err(|e| format!("UTF-8 変換エラー: {e}"))
        }
    }

    // Minimal base64 via standard alphabet — avoids extra deps.
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    fn base64_encode(data: &[u8]) -> String {
        let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
        for chunk in data.chunks(3) {
            let b0 = chunk[0] as u32;
            let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
            let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
            let n = (b0 << 16) | (b1 << 8) | b2;
            out.push(ALPHABET[((n >> 18) & 0x3f) as usize] as char);
            out.push(ALPHABET[((n >> 12) & 0x3f) as usize] as char);
            out.push(if chunk.len() > 1 { ALPHABET[((n >> 6) & 0x3f) as usize] as char } else { '=' });
            out.push(if chunk.len() > 2 { ALPHABET[(n & 0x3f) as usize] as char } else { '=' });
        }
        out
    }

    fn base64_decode(s: &str) -> Result<Vec<u8>, ()> {
        let mut table = [0xffu8; 256];
        for (i, &b) in ALPHABET.iter().enumerate() { table[b as usize] = i as u8; }
        let s = s.trim_end_matches('=');
        let mut out = Vec::with_capacity(s.len() * 3 / 4);
        let mut buf = 0u32;
        let mut bits = 0u32;
        for c in s.bytes() {
            let v = table[c as usize];
            if v == 0xff { return Err(()); }
            buf = (buf << 6) | v as u32;
            bits += 6;
            if bits >= 8 { bits -= 8; out.push(((buf >> bits) & 0xff) as u8); }
        }
        Ok(out)
    }
}

#[cfg(not(target_os = "windows"))]
mod pat_crypto {
    use std::sync::Once;

    // Keep the same service/user pair as used before this PR for backward compatibility.
    const SERVICE: &str = "arbor_github_pat";
    const USER: &str = "github";

    static INIT_STORE: Once = Once::new();

    /// keyring-core requires a default credential store to be registered once
    /// per process before any Entry can be created.
    /// Store::new() returns Result<Arc<Self>>, which is unsized to Arc<dyn CredentialStore>
    /// when passed to keyring_core::set_default_store.
    pub(super) fn ensure_default_store() {
        INIT_STORE.call_once(|| {
            #[cfg(target_os = "macos")]
            match apple_native_keyring_store::keychain::Store::new() {
                Ok(s) => keyring_core::set_default_store(s),
                Err(e) => eprintln!("credential store の初期化に失敗: {e}"),
            }
            #[cfg(target_os = "linux")]
            match dbus_secret_service_keyring_store::Store::new() {
                Ok(s) => keyring_core::set_default_store(s),
                Err(e) => eprintln!("credential store の初期化に失敗: {e}"),
            }
        });
    }

    fn keychain_entry() -> Result<keyring_core::Entry, String> {
        ensure_default_store();
        keyring_core::Entry::new(SERVICE, USER)
            .map_err(|e| format!("keychain エラー: {e}"))
    }

    pub fn encrypt(plaintext: &str) -> Result<String, String> {
        keychain_entry()?.set_password(plaintext).map_err(|e| format!("{e}"))?;
        Ok(String::new()) // sentinel: PAT is in keyring, not in this blob
    }

    pub fn decrypt(_encoded: &str) -> Result<String, String> {
        keychain_entry()?.get_password().map_err(|e| format!("{e}"))
    }

    /// Returns true if a PAT entry exists in the keyring.
    pub fn has_in_keyring() -> bool {
        keychain_entry().map(|e| e.get_password().is_ok()).unwrap_or(false)
    }

    /// Removes the keyring entry. `NoEntry` is treated as success.
    pub fn delete() -> Result<(), String> {
        match keychain_entry()?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("{e}")),
        }
    }
}

/// Encrypt the PAT and return an opaque, portable-but-user-scoped blob.
fn pat_encrypt(plaintext: &str) -> Result<String, String> {
    pat_crypto::encrypt(plaintext)
}

/// Decrypt the blob stored in config.github_pat_enc.
fn pat_decrypt(encoded: &str) -> Result<String, String> {
    pat_crypto::decrypt(encoded)
}

/// Internal helper used by GitHub API commands to retrieve the stored PAT.
/// Not a Tauri command — the secret stays inside the Rust process.
/// On Windows: decrypts the DPAPI blob from `github_pat_enc`.
/// On non-Windows: reads from OS keyring (falls back to keyring directly when
/// `github_pat_enc` is None, supporting pre-migration installs).
pub(crate) fn load_github_pat() -> Result<String, String> {
    let config = load_config()?;
    match &config.settings.github_pat_enc {
        Some(blob) => pat_decrypt(blob),
        None => {
            // Non-Windows: fall back to keyring for pre-migration PATs (github_pat_enc absent).
            #[cfg(not(target_os = "windows"))]
            return pat_crypto::decrypt("");
            #[cfg(target_os = "windows")]
            Err("GitHub PAT が設定されていません。Settings から PAT を登録してください。".to_string())
        }
    }
}

/// Trims, validates, and saves the GitHub PAT.
/// On Windows: encrypts with DPAPI and stores as a base64 blob in config.toml.
/// On non-Windows: stores in OS keyring; `github_pat_enc` holds an empty sentinel.
#[tauri::command]
pub fn set_github_pat(pat: String) -> Result<(), String> {
    let trimmed = pat.trim();
    if trimmed.is_empty() {
        return Err("GitHub PAT を入力してください".to_string());
    }
    let mut config = load_config()?;
    config.settings.github_pat_enc = Some(pat_encrypt(trimmed)?);
    save_config(&config)
}

/// Returns true if a GitHub PAT is stored, false if not.
/// The PAT value is never exposed over IPC; retrieval is internal to Rust commands.
/// On non-Windows: also checks keyring directly for pre-migration installs where
/// `github_pat_enc` is None.
#[tauri::command]
pub fn has_github_pat() -> Result<bool, String> {
    let config = load_config()?;
    if config.settings.github_pat_enc.is_some() {
        return Ok(true);
    }
    // Non-Windows: fall back to keyring for pre-migration PATs.
    #[cfg(not(target_os = "windows"))]
    return Ok(pat_crypto::has_in_keyring());
    #[cfg(target_os = "windows")]
    Ok(false)
}

/// Removes the GitHub PAT from config.toml.
/// On non-Windows: also deletes the keyring entry.
#[tauri::command]
pub fn delete_github_pat() -> Result<(), String> {
    let mut config = load_config()?;
    config.settings.github_pat_enc = None;
    save_config(&config)?;
    #[cfg(not(target_os = "windows"))]
    pat_crypto::delete()?;
    Ok(())
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
    use super::parse_github_url;

    #[test]
    fn parse_github_url_https() {
        let r = parse_github_url("https://github.com/scottlz0310/arbor.git").unwrap();
        assert_eq!(r, ("scottlz0310".into(), "arbor".into()));
    }

    #[test]
    fn parse_github_url_https_no_git_suffix() {
        let r = parse_github_url("https://github.com/org/repo").unwrap();
        assert_eq!(r, ("org".into(), "repo".into()));
    }

    #[test]
    fn parse_github_url_ssh() {
        let r = parse_github_url("git@github.com:scottlz0310/arbor.git").unwrap();
        assert_eq!(r, ("scottlz0310".into(), "arbor".into()));
    }

    #[test]
    fn parse_github_url_non_github_returns_none() {
        assert!(parse_github_url("https://gitlab.com/org/repo.git").is_none());
        assert!(parse_github_url("git@bitbucket.org:org/repo.git").is_none());
    }

    /// キーチェーンの書き込み → 読み取り → 削除が正常に動作することを確認する。
    /// 実際の OS キーチェーンに書き込むため、デフォルトでは #[ignore] にする。
    /// `cargo test -- --ignored keyring_roundtrip` で明示的に実行すること。
    #[cfg(not(target_os = "windows"))]
    #[test]
    #[ignore = "実 OS キーチェーンへのアクセスが必要。cargo test -- --ignored で実行"]
    fn keyring_roundtrip() {
        const SERVICE: &str = "arbor_keyring_test";
        const USER: &str = "test";
        const SECRET: &str = "roundtrip_secret_12345";

        super::pat_crypto::ensure_default_store();

        let entry = match keyring_core::Entry::new(SERVICE, USER) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("keyring_core::Entry::new failed ({e}) — skipping");
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
    /// keyring v3.6.x on Windows では cross-entry read が NoEntry を返す既知のバグがあったため、
    /// Windows では DPAPI フォールバックを採用してきた。Windows ではそもそも keyring-core 依存を
    /// 持たないため、このテストは non-Windows でのみコンパイル対象とする。
    #[cfg(not(target_os = "windows"))]
    #[test]
    #[ignore = "実 OS キーチェーンへのアクセスが必要。cargo test -- --ignored で実行"]
    fn keyring_cross_entry_roundtrip() {
        const SERVICE: &str = "arbor_cross_entry_test";
        const USER: &str = "arbor";
        const SECRET: &str = "cross_entry_secret_12345";

        super::pat_crypto::ensure_default_store();

        // Clean up any leftover from a previous run.
        if let Ok(e) = keyring_core::Entry::new(SERVICE, USER) { let _ = e.delete_credential(); }

        let entry1 = match keyring_core::Entry::new(SERVICE, USER) {
            Ok(e) => e,
            Err(e) => { eprintln!("entry1::new failed ({e}) — skipping"); return; }
        };
        if let Err(e) = entry1.set_password(SECRET) {
            eprintln!("set_password failed ({e}) — skipping"); return;
        }

        // Read with a completely separate Entry instance (simulates separate Tauri command calls).
        let entry2 = match keyring_core::Entry::new(SERVICE, USER) {
            Ok(e) => e,
            Err(e) => { let _ = entry1.delete_credential(); eprintln!("entry2::new failed ({e}) — skipping"); return; }
        };
        let result = entry2.get_password();
        let _ = entry1.delete_credential();

        match result {
            Ok(val) => assert_eq!(val, SECRET, "cross-entry read returned different value"),
            Err(e) => panic!("cross-entry read failed: {e}"),
        }
    }

    /// DPAPI の暗号化 → 復号が同じ値を返すことを確認する。
    #[cfg(target_os = "windows")]
    #[test]
    fn dpapi_encrypt_decrypt_roundtrip() {
        const PAT: &str = "ghp_TestDpapiRoundtrip12345";
        let encrypted = super::pat_encrypt(PAT).expect("DPAPI encrypt");
        assert!(!encrypted.is_empty(), "encrypted blob should not be empty");
        assert_ne!(encrypted, PAT, "encrypted blob should differ from plaintext");
        let decrypted = super::pat_decrypt(&encrypted).expect("DPAPI decrypt");
        assert_eq!(decrypted, PAT, "decrypted value should match original");
    }
}
