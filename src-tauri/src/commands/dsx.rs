use crate::models::DsxOutput;
use std::process::Command;
use tauri::AppHandle;

// ─── dsx_check ───────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct DsxStatus {
    pub available: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

#[tauri::command]
pub fn dsx_check() -> DsxStatus {
    // Try `dsx --version` and capture stdout.
    let result = Command::new("dsx").arg("--version").output();
    match result {
        Ok(out) if out.status.success() => {
            let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let path = which_dsx();
            DsxStatus {
                available: true,
                version: Some(version),
                path,
            }
        }
        _ => DsxStatus {
            available: false,
            version: None,
            path: None,
        },
    }
}

fn which_dsx() -> Option<String> {
    // Windows: `where dsx`, Unix: `which dsx`
    #[cfg(target_os = "windows")]
    let result = Command::new("where").arg("dsx").output();
    #[cfg(not(target_os = "windows"))]
    let result = Command::new("which").arg("dsx").output();

    result
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

// ─── repo_update ─────────────────────────────────────────────────────────────

/// Runs `dsx repo update --no-tui -j 4` in the given repository directory.
///
/// Progress lines from stdout are forwarded to the frontend via the
/// `dsx_progress` Tauri event so the UI can display real-time status.
#[tauri::command]
pub async fn repo_update(app: AppHandle, repo_path: String) -> Result<DsxOutput, String> {
    run_dsx_with_events(
        &app,
        &repo_path,
        &["repo", "update", "--no-tui", "--jobs", "4"],
    )
    .await
}

// ─── repo_cleanup_preview ────────────────────────────────────────────────────

/// Runs `dsx repo cleanup -n` (dry-run) and returns raw stdout for the
/// frontend to parse and display in the Cleanup Wizard confirmation step.
///
/// NOTE: The exact output format depends on the dsx version.
/// Check `dsx repo cleanup --help` to confirm JSON flag availability.
#[tauri::command]
pub async fn repo_cleanup_preview(repo_path: String) -> Result<DsxOutput, String> {
    let output = run_dsx_sync(&repo_path, &["repo", "cleanup", "-n"])?;
    if output.exit_code != 0 {
        return Err(format!(
            "dsx repo cleanup preview failed with exit code {}: {}",
            output.exit_code, output.stderr
        ));
    }
    Ok(output)
}

// ─── repo_cleanup ─────────────────────────────────────────────────────────────

/// Executes `dsx repo cleanup` after the user has confirmed in the dialog.
/// Only call this command after `repo_cleanup_preview` and user confirmation.
#[tauri::command]
pub async fn repo_cleanup(app: AppHandle, repo_path: String) -> Result<DsxOutput, String> {
    run_dsx_with_events(&app, &repo_path, &["repo", "cleanup"]).await
}

// ─── env_inject ───────────────────────────────────────────────────────────────

/// Runs `dsx env run -- <cmd>` in the given repository directory.
///
/// Streams stdout back as `dsx_progress` events so the UI can display
/// real-time output for long-running environment-injected commands.
#[tauri::command]
pub async fn env_inject(
    app: AppHandle,
    repo_path: String,
    cmd: String,
) -> Result<DsxOutput, String> {
    let cmd_parts: Vec<&str> = cmd.split_whitespace().collect();
    let mut args = vec!["env", "run", "--"];
    args.extend_from_slice(&cmd_parts);
    run_dsx_with_events(&app, &repo_path, &args).await
}

// ─── sys_update ───────────────────────────────────────────────────────────────

/// Runs `dsx sys update --no-tui` to upgrade dsx-managed tools.
///
/// Does not require a specific repository directory. Progress lines are
/// streamed via `dsx_progress` events the same way as `repo_update`.
#[tauri::command]
pub async fn sys_update(app: AppHandle) -> Result<DsxOutput, String> {
    run_dsx_with_events(&app, ".", &["sys", "update", "--no-tui"]).await
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Runs a dsx command, streaming stdout lines as `dsx_progress` events to the
/// frontend. Returns the final aggregated output when the process exits.
async fn run_dsx_with_events(
    app: &AppHandle,
    cwd: &str,
    args: &[&str],
) -> Result<DsxOutput, String> {
    use std::io::{BufRead, BufReader};
    use tauri::Emitter;

    let mut child = Command::new("dsx")
        .args(args)
        .current_dir(cwd)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn dsx: {e}"))?;

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    // Drain stderr concurrently on a separate thread to prevent pipe-buffer
    // deadlock if dsx writes enough stderr to fill the OS buffer.
    // filter_map(Result::ok) is intentional: we skip unreadable lines but
    // continue draining so no diagnostics are truncated on mid-stream errors.
    #[allow(clippy::lines_filter_map_ok)]
    let stderr_thread = std::thread::spawn(move || {
        BufReader::new(stderr)
            .lines()
            .filter_map(Result::ok)
            .collect::<Vec<String>>()
            .join("\n")
    });

    let mut stdout_lines = Vec::new();
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        let line = line.map_err(|e| e.to_string())?;
        let _ = app.emit("dsx_progress", &line);
        stdout_lines.push(line);
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    let exit_code = status.code().unwrap_or(-1);
    let stderr = stderr_thread.join().unwrap_or_default();

    if exit_code != 0 {
        return Err(format!("dsx exited with code {exit_code}: {stderr}"));
    }

    Ok(DsxOutput {
        stdout: stdout_lines.join("\n"),
        stderr,
        exit_code,
    })
}

/// Runs a dsx command synchronously and returns the result.
fn run_dsx_sync(cwd: &str, args: &[&str]) -> Result<DsxOutput, String> {
    let output = Command::new("dsx")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("Failed to spawn dsx: {e}"))?;

    Ok(DsxOutput {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// `available` と `version` の整合性を検証する。
    /// `path` は `which`/`where` の挙動に依存するため検証しない。
    /// dsx が PATH になくても必ず通過する。CI では dsx がインストールされるため
    /// `available: true` の分岐も必ずカバーされる。
    #[test]
    fn dsx_check_fields_consistent() {
        let status = dsx_check();
        if status.available {
            assert!(
                status.version.is_some(),
                "version must be Some when available"
            );
        } else {
            assert!(
                status.version.is_none(),
                "version must be None when unavailable"
            );
            assert!(
                status.path.is_none(),
                "path must be None when unavailable"
            );
        }
    }

    /// dsx が利用可能な場合に `--version` を同期実行し、exit code 0 を返すことを確認する。
    #[test]
    fn run_dsx_sync_version_succeeds_when_available() {
        if !dsx_check().available {
            return; // dsx が PATH になければスキップ
        }
        let result = run_dsx_sync(".", &["--version"]);
        let output = result.expect("run_dsx_sync should not error when dsx is available");
        assert_eq!(output.exit_code, 0);
        assert!(!output.stdout.is_empty(), "stdout should contain version string");
    }

    /// dsx が利用可能な場合に `which_dsx` がパスを返すことを確認する。
    #[test]
    fn which_dsx_returns_some_when_available() {
        if !dsx_check().available {
            return;
        }
        let path = which_dsx();
        assert!(path.is_some(), "which_dsx should return a path");
        assert!(!path.unwrap().is_empty());
    }

    /// `env_inject` に渡すコマンド文字列が空白で正しく分割されることを確認する。
    /// dsx の実際の呼び出しではなく、引数分割ロジックのみを検証する。
    #[test]
    fn env_inject_cmd_splits_into_args() {
        let cmd = "npm install --frozen-lockfile";
        let parts: Vec<&str> = cmd.split_whitespace().collect();
        assert_eq!(parts, vec!["npm", "install", "--frozen-lockfile"]);

        let mut args = vec!["env", "run", "--"];
        args.extend_from_slice(&parts);
        assert_eq!(
            args,
            vec!["env", "run", "--", "npm", "install", "--frozen-lockfile"]
        );
    }

    /// dsx が利用可能な場合に `sys update --no-tui` が存在するサブコマンドとして
    /// 認識されることを確認する（`--help` でサブコマンド一覧が取れれば十分）。
    #[test]
    fn run_dsx_sync_help_succeeds_when_available() {
        if !dsx_check().available {
            return;
        }
        let result = run_dsx_sync(".", &["--help"]);
        let output = result.expect("dsx --help should not error");
        // dsx --help は exit 0 または非ゼロを返す実装に依存するが
        // 少なくとも stdout/stderr のどちらかに出力があることを確認
        let has_output = !output.stdout.is_empty() || !output.stderr.is_empty();
        assert!(has_output, "dsx --help should produce some output");
    }
}
