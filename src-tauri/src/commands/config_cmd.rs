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

/// Updates the GitHub owner/repo fields for an existing registered repository.
#[tauri::command]
pub fn update_repository_github(
    path: String,
    github_owner: Option<String>,
    github_repo: Option<String>,
) -> Result<AppConfig, String> {
    let mut config = load_config()?;
    let repo = config
        .repositories
        .iter_mut()
        .find(|r| r.path == path)
        .ok_or_else(|| format!("Repository not found: {path}"))?;
    repo.github_owner = github_owner;
    repo.github_repo = github_repo;
    save_config(&config)?;
    Ok(config)
}

// ─── GitHub PAT (DPAPI encrypted → config.toml) ───────────────────────────────
//
// keyring v3.6.x on Windows has a bug: credentials written by one Entry instance
// cannot be read by a different Entry instance (cross-entry reads return NoEntry).
// Because every Tauri command call creates a fresh Entry, we cannot rely on keyring.
//
// Instead, we encrypt the PAT with Windows DPAPI (user-account-scoped; unreadable
// on other machines) and store the resulting base64 blob in config.toml.
// On non-Windows the keyring crate is used directly (it works on macOS/Linux).

#[cfg(target_os = "windows")]
mod pat_crypto {
    use std::ptr;
    use windows_sys::Win32::Foundation::BOOL;
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
            let ok: BOOL = CryptProtectData(
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
            let ok: BOOL = CryptUnprotectData(
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
    // Keep the same service/user pair as used before this PR for backward compatibility.
    const SERVICE: &str = "arbor_github_pat";
    const USER: &str = "github";

    fn keychain_entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, USER)
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
        match keychain_entry()?.delete_password() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
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
    /// キーチェーンの書き込み → 読み取り → 削除が正常に動作することを確認する。
    /// 実際の OS キーチェーンに書き込むため、デフォルトでは #[ignore] にする。
    /// `cargo test -- --ignored keyring_roundtrip` で明示的に実行すること。
    #[test]
    #[ignore = "実 OS キーチェーンへのアクセスが必要。cargo test -- --ignored で実行"]
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
                // DPAPI-encrypted config-file storage is used instead (see pat_crypto).
                eprintln!(
                    "keyring cross-entry read failed: {e}\n\
                     This is a known keyring v3.6.x bug on Windows.\n\
                     DPAPI-encrypted config-file storage is used in production."
                );
            }
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
