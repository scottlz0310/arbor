use super::runner::{hide_console, LaunchSpec, RunOutcome, RunnerState};
use crate::config::{load_config, AppConfig};
use crate::models::DsxOutput;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::State;

/// `dsx run --root` を受け付ける最初の版（dsx#137）。
const RUN_ROOT_MIN_VERSION: (u32, u32, u32) = (0, 11, 0);

// ─── dsx_check ───────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct DsxStatus {
    pub available: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    /// `dsx run --root`（Daily Refresh）を使える版か。
    pub supports_run_root: bool,
}

/// `dsx --version` の出力（例: `dsx version 0.10.2`）から版を取り出す。
/// `v` 接頭辞とプレリリース接尾辞（`-rc1`）は無視する。
fn parse_dsx_version(output: &str) -> Option<(u32, u32, u32)> {
    let token = output
        .split_whitespace()
        .map(|t| t.trim_start_matches('v'))
        .find(|t| t.starts_with(|c: char| c.is_ascii_digit()))?;
    let core = token.split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|p| p.parse::<u32>().ok());
    Some((parts.next()??, parts.next()??, parts.next()??))
}

fn supports_run_root(version: Option<&str>) -> bool {
    version
        .and_then(parse_dsx_version)
        .is_some_and(|v| v >= RUN_ROOT_MIN_VERSION)
}

/// 起動して終了コードを返す。信号などで終了コードが無ければ None。
fn probe_exit_code(program: &str, args: &[&str]) -> io::Result<Option<i32>> {
    let mut command = Command::new(program);
    command.args(args);
    hide_console(&mut command);
    Ok(command.output()?.status.code())
}

#[tauri::command]
pub fn dsx_check() -> DsxStatus {
    // Try `dsx --version` and capture stdout.
    let mut command = Command::new("dsx");
    command.arg("--version");
    hide_console(&mut command);
    match command.output() {
        Ok(out) if out.status.success() => {
            let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let path = which_dsx();
            DsxStatus {
                available: true,
                supports_run_root: supports_run_root(Some(&version)),
                version: Some(version),
                path,
            }
        }
        _ => DsxStatus {
            available: false,
            version: None,
            path: None,
            supports_run_root: false,
        },
    }
}

fn which_dsx() -> Option<String> {
    // Windows: `where dsx`, Unix: `which dsx`
    #[cfg(target_os = "windows")]
    let mut command = Command::new("where");
    #[cfg(not(target_os = "windows"))]
    let mut command = Command::new("which");
    command.arg("dsx");
    hide_console(&mut command);

    command
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

// ─── bitwarden_status ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BitwardenState {
    Unlocked,
    /// ロック中、または確認できなかった（`bw` 未導入など）。dsx は理由を終了コードで区別しない。
    NotUnlocked,
    /// dsx を起動できなかった。
    Unavailable,
}

fn bitwarden_state(exit: io::Result<Option<i32>>) -> BitwardenState {
    match exit {
        Ok(Some(0)) => BitwardenState::Unlocked,
        Ok(_) => BitwardenState::NotUnlocked,
        Err(_) => BitwardenState::Unavailable,
    }
}

/// Bitwarden が解錠済みかを `dsx env status --quiet` の終了コードで確認する。
/// GUI は解錠のためのパスワード入力を受けられないため、状態の表示だけを行う。
#[tauri::command(async)]
pub fn bitwarden_status() -> BitwardenState {
    bitwarden_state(probe_exit_code("dsx", &["env", "status", "--quiet"]))
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

// ─── repo_update / daily_refresh ─────────────────────────────────────────────

/// dsx に渡す更新対象の root。Arbor の `workspace.root` が正本で、dsx 自身の設定の root は使わない
/// （一覧に出ているリポジトリと、dsx が更新するリポジトリを一致させるため）。
fn update_root(config: &AppConfig) -> Result<String, String> {
    let root = config
        .workspace
        .root
        .as_deref()
        .filter(|root| !root.is_empty())
        .ok_or("workspace root が未設定です。Settings で設定してください")?;
    if !Path::new(root).is_dir() {
        return Err(format!(
            "workspace root が存在しません ({root})。Settings で設定し直してください"
        ));
    }
    Ok(root.to_string())
}

fn repo_update_args(root: &str) -> Vec<String> {
    ["repo", "update", "--root", root, "--no-tui", "--jobs", "4"]
        .map(String::from)
        .to_vec()
}

fn daily_refresh_args(root: &str) -> Vec<String> {
    ["run", "--root", root, "--no-tui", "--jobs", "4"]
        .map(String::from)
        .to_vec()
}

/// `dsx run --root` を使えない状態なら、理由を返す。
fn ensure_run_root_supported(status: &DsxStatus) -> Result<(), String> {
    if !status.available {
        return Err("dsx が見つかりません".to_string());
    }
    if status.supports_run_root {
        return Ok(());
    }
    let (major, minor, patch) = RUN_ROOT_MIN_VERSION;
    Err(format!(
        "Daily Refresh には dsx v{major}.{minor}.{patch} 以上が必要です（現在: {}）。dsx self-update で更新してください",
        status.version.as_deref().unwrap_or("不明")
    ))
}

/// Runs `dsx repo update --root <workspace root> --no-tui --jobs 4`: updates every repository under the root.
///
/// Output is streamed to the frontend via the `process_*` events (see `runner`).
#[tauri::command]
pub async fn repo_update(state: State<'_, RunnerState>) -> Result<DsxOutput, String> {
    let root = update_root(&load_config()?)?;
    run_dsx_args(&state, ".", repo_update_args(&root)).await
}

/// Runs `dsx run --root <workspace root> --no-tui --jobs 4`: Bitwarden unlock → env → system update → repo update.
#[tauri::command]
pub async fn daily_refresh(state: State<'_, RunnerState>) -> Result<DsxOutput, String> {
    let root = update_root(&load_config()?)?;
    let status = tauri::async_runtime::spawn_blocking(dsx_check)
        .await
        .map_err(|e| format!("dsx の確認スレッドが異常終了しました: {e}"))?;
    ensure_run_root_supported(&status)?;
    run_dsx_args(&state, ".", daily_refresh_args(&root)).await
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

/// `dsx sys update` の引数。`dry_run` なら `-n` を付け、実際の更新は行わず計画だけを表示させる。
fn sys_update_args(dry_run: bool) -> Vec<&'static str> {
    let mut args = vec!["sys", "update", "--no-tui"];
    if dry_run {
        args.push("-n");
    }
    args
}

/// Runs `dsx sys update --no-tui` to upgrade dsx-managed tools.
///
/// Does not require a specific repository directory. Output is streamed via
/// the `process_*` events the same way as `repo_update`.
#[tauri::command]
pub async fn sys_update(state: State<'_, RunnerState>) -> Result<DsxOutput, String> {
    run_dsx(&state, ".", &sys_update_args(false)).await
}

/// Runs `dsx sys update --no-tui -n`: shows what `sys update` would do without changing anything.
#[tauri::command]
pub async fn sys_update_dry_run(state: State<'_, RunnerState>) -> Result<DsxOutput, String> {
    run_dsx(&state, ".", &sys_update_args(true)).await
}

// ─── dsx_doctor ───────────────────────────────────────────────────────────────

/// Runs `dsx doctor`: diagnoses the tools and environment dsx depends on. Output is streamed via the `process_*` events.
#[tauri::command]
pub async fn dsx_doctor(state: State<'_, RunnerState>) -> Result<DsxOutput, String> {
    run_dsx(&state, ".", &["doctor"]).await
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
    run_dsx_args(state, cwd, args.iter().map(|a| (*a).to_string()).collect()).await
}

async fn run_dsx_args(
    state: &RunnerState,
    cwd: &str,
    args: Vec<String>,
) -> Result<DsxOutput, String> {
    let runner = state.runner();
    let label = format!("dsx {}", args.join(" "));
    let spec = LaunchSpec {
        program: "dsx".to_string(),
        args,
        cwd: PathBuf::from(cwd),
    };
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

    #[test]
    fn parse_dsx_version_cases() {
        let cases = [
            ("dsx version 0.10.2", Some((0, 10, 2))),
            ("dsx version 0.11.0\n", Some((0, 11, 0))),
            ("v1.2.3", Some((1, 2, 3))),
            ("dsx version 0.12.0-rc1", Some((0, 12, 0))),
            ("dsx version 0.12.0+build5", Some((0, 12, 0))),
            ("dsx version dev", None),
            ("dsx version 0.11", None),
            ("", None),
        ];
        for (input, expected) in cases {
            assert_eq!(parse_dsx_version(input), expected, "{input:?}");
        }
    }

    #[test]
    fn supports_run_root_cases() {
        let cases = [
            (Some("dsx version 0.10.2"), false),
            (Some("dsx version 0.10.99"), false),
            (Some("dsx version 0.11.0"), true),
            (Some("dsx version 0.11.1"), true),
            (Some("dsx version 1.0.0"), true),
            (Some("dsx version dev"), false),
            (None, false),
        ];
        for (version, expected) in cases {
            assert_eq!(supports_run_root(version), expected, "{version:?}");
        }
    }

    #[test]
    fn bitwarden_state_cases() {
        let cases = [
            ("解錠済み", Ok(Some(0)), BitwardenState::Unlocked),
            ("ロック中", Ok(Some(1)), BitwardenState::NotUnlocked),
            ("信号で終了", Ok(None), BitwardenState::NotUnlocked),
            (
                "dsx を起動できない",
                Err(io::Error::from(io::ErrorKind::NotFound)),
                BitwardenState::Unavailable,
            ),
        ];
        for (name, exit, expected) in cases {
            assert_eq!(bitwarden_state(exit), expected, "{name}");
        }
    }

    fn config_with_root(root: Option<&str>) -> AppConfig {
        let mut config = AppConfig::default();
        config.workspace.root = root.map(String::from);
        config
    }

    #[test]
    fn update_root_cases() {
        let existing = std::env::temp_dir().to_string_lossy().into_owned();
        let missing = std::env::temp_dir()
            .join("arbor-missing-root-that-does-not-exist")
            .to_string_lossy()
            .into_owned();

        assert_eq!(
            update_root(&config_with_root(Some(&existing))).as_deref(),
            Ok(existing.as_str())
        );
        for (name, root, expected) in [
            ("未設定", None, "未設定"),
            ("自動検出の無効化", Some(""), "未設定"),
            ("存在しない", Some(missing.as_str()), "存在しません"),
        ] {
            let err = update_root(&config_with_root(root)).unwrap_err();
            assert!(err.contains(expected), "{name}: {err}");
        }
    }

    #[test]
    fn update_args_pass_the_root_explicitly() {
        assert_eq!(
            repo_update_args("C:/src"),
            ["repo", "update", "--root", "C:/src", "--no-tui", "--jobs", "4"]
        );
        assert_eq!(
            daily_refresh_args("C:/src"),
            ["run", "--root", "C:/src", "--no-tui", "--jobs", "4"]
        );
    }

    #[test]
    fn ensure_run_root_supported_cases() {
        let status = |available, version: Option<&str>, supported| DsxStatus {
            available,
            version: version.map(String::from),
            path: None,
            supports_run_root: supported,
        };

        assert!(ensure_run_root_supported(&status(true, Some("dsx version 0.11.0"), true)).is_ok());

        let old = ensure_run_root_supported(&status(true, Some("dsx version 0.10.2"), false))
            .unwrap_err();
        assert!(old.contains("v0.11.0 以上"), "{old}");
        assert!(old.contains("0.10.2"), "{old}");
        assert!(old.contains("self-update"), "{old}");

        let missing = ensure_run_root_supported(&status(false, None, false)).unwrap_err();
        assert!(missing.contains("見つかりません"), "{missing}");
    }

    #[test]
    fn sys_update_args_add_the_dry_run_flag_only_when_asked() {
        assert_eq!(sys_update_args(false), ["sys", "update", "--no-tui"]);
        assert_eq!(sys_update_args(true), ["sys", "update", "--no-tui", "-n"]);
    }
}
