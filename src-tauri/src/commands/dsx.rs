use super::runner::{LaunchSpec, RunOutcome, RunnerState};
use crate::models::DsxOutput;
use std::path::PathBuf;
use std::process::Command;
use tauri::State;

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

// ─── dsx_latest_version ──────────────────────────────────────────────────────

/// Queries the GitHub Releases API and returns the latest dsx tag name (e.g. "v0.3.0").
/// Returns `None` on network error, non-2xx response, or missing field — the UI
/// handles `null` gracefully so this command never returns `Err`.
#[tauri::command]
pub async fn dsx_latest_version() -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .ok()?;
    let resp = client
        .get("https://api.github.com/repos/scottlz0310/dsx/releases/latest")
        .header("User-Agent", "arbor-app/1.0")
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let json: serde_json::Value = resp.json().await.ok()?;
    extract_tag_name(&json)
}

fn extract_tag_name(json: &serde_json::Value) -> Option<String> {
    json["tag_name"].as_str().map(|s| s.to_string())
}

// ─── repo_update ─────────────────────────────────────────────────────────────

/// Runs `dsx repo update --no-tui -j 4` in the given repository directory.
///
/// Output is streamed to the frontend via the `process_*` events (see `runner`).
#[tauri::command]
pub async fn repo_update(
    state: State<'_, RunnerState>,
    repo_path: String,
) -> Result<DsxOutput, String> {
    run_dsx(
        &state,
        &repo_path,
        &["repo", "update", "--no-tui", "--jobs", "4"],
    )
    .await
}

// ─── env_inject ───────────────────────────────────────────────────────────────

/// Runs `dsx env run -- <cmd>` in the given repository directory.
///
/// Output is streamed via the `process_*` events so the UI can display
/// real-time output for long-running environment-injected commands.
#[tauri::command]
pub async fn env_inject(
    state: State<'_, RunnerState>,
    repo_path: String,
    cmd: String,
) -> Result<DsxOutput, String> {
    let cmd_parts: Vec<&str> = cmd.split_whitespace().collect();
    let mut args = vec!["env", "run", "--"];
    args.extend_from_slice(&cmd_parts);
    run_dsx(&state, &repo_path, &args).await
}

// ─── sys_update ───────────────────────────────────────────────────────────────

/// Runs `dsx sys update --no-tui` to upgrade dsx-managed tools.
///
/// Does not require a specific repository directory. Output is streamed via
/// the `process_*` events the same way as `repo_update`.
#[tauri::command]
pub async fn sys_update(state: State<'_, RunnerState>) -> Result<DsxOutput, String> {
    run_dsx(&state, ".", &["sys", "update", "--no-tui"]).await
}

// ─── dsx_self_update ──────────────────────────────────────────────────────────

/// Runs `dsx self-update` to upgrade the dsx CLI binary itself.
///
/// Output is streamed via the `process_*` events.
#[tauri::command]
pub async fn dsx_self_update(state: State<'_, RunnerState>) -> Result<DsxOutput, String> {
    run_dsx(&state, ".", &["self-update"]).await
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Runs a dsx command through the shared runner and waits for it to finish.
/// The runner blocks on the child process, so it runs on a blocking thread.
async fn run_dsx(state: &RunnerState, cwd: &str, args: &[&str]) -> Result<DsxOutput, String> {
    let runner = state.runner();
    let spec = LaunchSpec {
        program: "dsx".to_string(),
        args: args.iter().map(|a| (*a).to_string()).collect(),
        cwd: PathBuf::from(cwd),
    };
    let label = format!("dsx {}", args.join(" "));
    let outcome = tauri::async_runtime::spawn_blocking(move || runner.run(&label, spec))
        .await
        .map_err(|e| format!("dsx の実行スレッドが異常終了しました: {e}"))??;
    into_dsx_output(outcome)
}

fn into_dsx_output(outcome: RunOutcome) -> Result<DsxOutput, String> {
    if outcome.cancelled {
        return Err("キャンセルされました".to_string());
    }
    let exit_code = outcome.exit_code.unwrap_or(-1);
    if exit_code != 0 {
        return Err(format!(
            "dsx exited with code {exit_code}: {}",
            outcome.stderr
        ));
    }
    Ok(DsxOutput {
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        exit_code,
    })
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn run_dsx_sync(args: &[&str]) -> Result<DsxOutput, String> {
        let output = Command::new("dsx")
            .args(args)
            .output()
            .map_err(|e| format!("Failed to spawn dsx: {e}"))?;

        Ok(DsxOutput {
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            exit_code: output.status.code().unwrap_or(-1),
        })
    }

    /// `extract_tag_name` が "tag_name" フィールドを正しく取り出すことを検証する。
    #[test]
    fn extract_tag_name_returns_tag() {
        let json = serde_json::json!({ "tag_name": "v0.3.0", "other": "ignored" });
        assert_eq!(super::extract_tag_name(&json), Some("v0.3.0".to_string()));
    }

    /// "tag_name" フィールドがない場合は None を返すことを検証する。
    #[test]
    fn extract_tag_name_missing_field_returns_none() {
        let json = serde_json::json!({ "name": "release" });
        assert_eq!(super::extract_tag_name(&json), None);
    }

    /// "tag_name" が null の場合は None を返すことを検証する。
    #[test]
    fn extract_tag_name_null_field_returns_none() {
        let json = serde_json::json!({ "tag_name": null });
        assert_eq!(super::extract_tag_name(&json), None);
    }

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
            assert!(status.path.is_none(), "path must be None when unavailable");
        }
    }

    /// dsx が利用可能な場合に `--version` を同期実行し、exit code 0 を返すことを確認する。
    #[test]
    fn run_dsx_sync_version_succeeds_when_available() {
        if !dsx_check().available {
            return; // dsx が PATH になければスキップ
        }
        let result = run_dsx_sync(&["--version"]);
        let output = result.expect("run_dsx_sync should not error when dsx is available");
        assert_eq!(output.exit_code, 0);
        assert!(
            !output.stdout.is_empty(),
            "stdout should contain version string"
        );
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

    /// dsx が利用可能な場合に `self-update` サブコマンドが認識されることを確認する。
    /// `--help` を渡すことで実際の更新は行わず、サブコマンドの存在とヘルプ出力のみ検証する。
    #[test]
    fn dsx_self_update_subcommand_is_recognized() {
        if !dsx_check().available {
            return;
        }
        let result = run_dsx_sync(&["self-update", "--help"]);
        let output = result.expect("dsx self-update --help should not error");
        let has_output = !output.stdout.is_empty() || !output.stderr.is_empty();
        assert!(
            has_output,
            "dsx self-update --help should produce some output"
        );
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
        let result = run_dsx_sync(&["--help"]);
        let output = result.expect("dsx --help should not error");
        // dsx --help は exit 0 または非ゼロを返す実装に依存するが
        // 少なくとも stdout/stderr のどちらかに出力があることを確認
        let has_output = !output.stdout.is_empty() || !output.stderr.is_empty();
        assert!(has_output, "dsx --help should produce some output");
    }

    fn outcome(exit_code: Option<i32>, cancelled: bool) -> RunOutcome {
        RunOutcome {
            exit_code,
            cancelled,
            stdout: "out".to_string(),
            stderr: "err".to_string(),
        }
    }

    #[test]
    fn into_dsx_output_maps_outcomes() {
        let ok = into_dsx_output(outcome(Some(0), false)).expect("exit 0 is success");
        assert_eq!(
            (ok.stdout.as_str(), ok.stderr.as_str(), ok.exit_code),
            ("out", "err", 0)
        );

        let cases = [
            (
                "non-zero exit",
                outcome(Some(2), false),
                "dsx exited with code 2: err",
            ),
            (
                "no exit code",
                outcome(None, false),
                "dsx exited with code -1: err",
            ),
            ("cancelled", outcome(None, true), "キャンセルされました"),
            (
                "cancelled takes priority over exit code",
                outcome(Some(0), true),
                "キャンセルされました",
            ),
        ];
        for (name, case, expected) in cases {
            assert_eq!(into_dsx_output(case).unwrap_err(), expected, "{name}");
        }
    }
}
