use super::dsx_report::{EventsFile, ReportState, EVENTS_MIN_VERSION};
use super::runner::{hide_console, LaunchSpec, RunOutcome, RunnerState};
use crate::config::{events_dir, AppConfig};
use crate::models::DsxOutput;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Daily Refresh（`dsx run --root`）に必要な最初の版。`--root` は v0.11.0（dsx#137）、`run` が Bitwarden に
/// 触れなくなったのは v0.12.0（dsx#144）。
const DAILY_REFRESH_MIN_VERSION: (u32, u32, u32) = (0, 12, 0);

// ─── dsx_check ───────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct DsxStatus {
    pub available: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    /// Daily Refresh（`dsx run --root`）を使える版か（v0.12.0 以上）。
    pub supports_daily_refresh: bool,
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

fn supports_daily_refresh(version: Option<&str>) -> bool {
    version
        .and_then(parse_dsx_version)
        .is_some_and(|v| v >= DAILY_REFRESH_MIN_VERSION)
}

/// 機械可読なイベント出力（`--events-file`。dsx#152）を使える版か（v0.13.0 以上）。
fn supports_events(version: Option<&str>) -> bool {
    version
        .and_then(parse_dsx_version)
        .is_some_and(|v| v >= EVENTS_MIN_VERSION)
}

pub fn check_dsx() -> DsxStatus {
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
                supports_daily_refresh: supports_daily_refresh(Some(&version)),
                version: Some(version),
                path,
            }
        }
        _ => DsxStatus {
            available: false,
            version: None,
            path: None,
            supports_daily_refresh: false,
        },
    }
}

fn which_dsx() -> Option<String> {
    which_dsx_in(None)
}

/// `path` を渡すと、探索する PATH をそれに差し替える（テスト用）。
fn which_dsx_in(path: Option<&OsStr>) -> Option<String> {
    // Windows の素の `where dsx` はカレントディレクトリも先に検索し、PATHEXT の `.cmd` なども
    // 候補にする。実行（`Command`）は PATH の `dsx.exe` だけを探すので、表示するパスが
    // 実行されるものと食い違わないよう、PATH 上の `dsx.exe` だけに絞る。
    #[cfg(target_os = "windows")]
    let (program, target) = ("where", "$PATH:dsx.exe");
    #[cfg(not(target_os = "windows"))]
    let (program, target) = ("which", "dsx");
    let mut command = Command::new(program);
    command.arg(target);
    if let Some(path) = path {
        command.env("PATH", path);
    }
    hide_console(&mut command);

    command
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| first_path_line(&String::from_utf8_lossy(&o.stdout)))
}

/// `where` は PATH 上の一致をすべて改行区切りで返す。実行されるのは先頭なので、先頭の 1 行を使う。
fn first_path_line(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

// ─── dsx_latest_version ──────────────────────────────────────────────────────

/// Queries the GitHub Releases API and returns the latest dsx tag name (e.g. "v0.3.0").
/// Returns `None` on network error, non-2xx response, or missing field — the UI
/// handles `null` gracefully so this command never returns `Err`.
pub async fn latest_dsx_version() -> Option<String> {
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
pub fn update_root(config: &AppConfig) -> Result<String, String> {
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
fn ensure_daily_refresh_supported(status: &DsxStatus) -> Result<(), String> {
    if !status.available {
        return Err("dsx が見つかりません".to_string());
    }
    if status.supports_daily_refresh {
        return Ok(());
    }
    let (major, minor, patch) = DAILY_REFRESH_MIN_VERSION;
    Err(format!(
        "Daily Refresh には dsx v{major}.{minor}.{patch} 以上が必要です（現在: {}）。dsx self-update で更新してください",
        status.version.as_deref().unwrap_or("不明")
    ))
}

// ─── dsx の実行 ──────────────────────────────────────────────────────────────

/// `dsx sys update` の引数。`dry_run` なら `-n` を付け、実際の更新は行わず計画だけを表示させる。
fn sys_update_args(dry_run: bool) -> Vec<&'static str> {
    let mut args = vec!["sys", "update", "--no-tui"];
    if dry_run {
        args.push("-n");
    }
    args
}

/// Arbor から実行する dsx の操作。起動するコマンドと作業ディレクトリの決定は `invocation` にまとめ、
/// Tauri のコマンド（`ipc/dsx.rs`）は、タスクを選んで `run_task` に渡すだけにする。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DsxTask {
    /// `dsx sys update`: dsx が管理するツール群を更新する。
    SysUpdate,
    /// `dsx sys update -n`: 更新はせず、計画だけを表示する。
    SysUpdateDryRun,
    /// `dsx doctor`: 依存ツールと環境を診断する。
    Doctor,
    /// `dsx self-update`: dsx 本体を更新する。
    SelfUpdate,
    /// `dsx repo update --root <root>`: root 配下の全リポジトリを更新する。
    RepoUpdate { root: String },
    /// `dsx run --root <root>`: システム更新 → リポジトリ更新。
    DailyRefresh { root: String },
    /// `dsx env run -- <command>`: 環境変数を注入してコマンドを実行する。
    EnvRun { cwd: String, command: String },
}

impl DsxTask {
    /// 実行結果を、dsx のイベント出力（`--events-file`）で受け取れるか。dsx が対応するのは、更新系の 4 つ。
    fn reports_events(&self) -> bool {
        matches!(
            self,
            Self::SysUpdate
                | Self::SysUpdateDryRun
                | Self::RepoUpdate { .. }
                | Self::DailyRefresh { .. }
        )
    }

    /// 作業ディレクトリと、`dsx` に渡す引数。
    fn invocation(&self) -> (String, Vec<String>) {
        let strings = |args: &[&str]| args.iter().map(|a| (*a).to_string()).collect();
        match self {
            Self::SysUpdate => (".".to_string(), strings(&sys_update_args(false))),
            Self::SysUpdateDryRun => (".".to_string(), strings(&sys_update_args(true))),
            Self::Doctor => (".".to_string(), strings(&["doctor"])),
            Self::SelfUpdate => (".".to_string(), strings(&["self-update"])),
            Self::RepoUpdate { root } => (".".to_string(), repo_update_args(root)),
            Self::DailyRefresh { root } => (".".to_string(), daily_refresh_args(root)),
            Self::EnvRun { cwd, command } => {
                let mut args: Vec<String> = strings(&["env", "run", "--"]);
                args.extend(command.split_whitespace().map(String::from));
                (cwd.clone(), args)
            }
        }
    }
}

/// `dsx` を共有の runner で実行し、終了を待つ。出力は `process_*` イベントで流れる。
/// dsx がイベント出力に対応していれば、終了後に報告を `reports` へ置く（失敗した実行も含む）。
pub async fn run_task(
    state: &RunnerState,
    reports: &ReportState,
    task: DsxTask,
) -> Result<DsxOutput, String> {
    run_task_with(state, reports, task, check_dsx, events_dir).await
}

/// `run_task` の本体。確認する dsx の状態を `check`、イベントファイルの置き場を `events_dir` で差し替えられる（テスト用）。
async fn run_task_with(
    state: &RunnerState,
    reports: &ReportState,
    task: DsxTask,
    check: fn() -> DsxStatus,
    events_dir: fn() -> Result<PathBuf, String>,
) -> Result<DsxOutput, String> {
    let is_daily_refresh = matches!(task, DsxTask::DailyRefresh { .. });
    let status = if is_daily_refresh || task.reports_events() {
        Some(
            tauri::async_runtime::spawn_blocking(check)
                .await
                .map_err(|e| format!("dsx の確認スレッドが異常終了しました: {e}"))?,
        )
    } else {
        None
    };
    if let (true, Some(status)) = (is_daily_refresh, &status) {
        ensure_daily_refresh_supported(status)?;
    }

    // 対応しない版の dsx には `--events-file` を渡さない（これまでどおり、テキストのログだけ）。
    let events = match &status {
        Some(status) if task.reports_events() && supports_events(status.version.as_deref()) => {
            Some(EventsFile::create_in(&events_dir()?)?)
        }
        _ => None,
    };

    let (cwd, mut args) = task.invocation();
    if let Some(events) = &events {
        args.push("--events-file".to_string());
        args.push(events.path().to_string_lossy().into_owned());
    }
    let result = run_dsx_args(state, &cwd, args).await;

    // 失敗（終了コード 1）した実行ほど、警告・スキップ・失敗の内訳が要るので、結果に関わらず読む。
    if let Some(report) = events.as_ref().and_then(EventsFile::read_report) {
        reports.set(report);
    }
    result
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Runs a dsx command through the shared runner and waits for it to finish.
/// The runner blocks on the child process, so it runs on a blocking thread.
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
    use std::io;

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
        let status = check_dsx();
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
        if !check_dsx().available {
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
        if !check_dsx().available {
            return;
        }
        let path = which_dsx();
        assert!(path.is_some(), "which_dsx should return a path");
        let path = path.unwrap();
        assert!(!path.is_empty());
        assert!(!path.contains('\n'), "path must be a single line: {path:?}");
    }

    /// `where` / `which` の出力から、先頭の 1 行だけを取り出すことを検証する。
    #[test]
    fn first_path_line_cases() {
        let cases: &[(&str, &str, Option<&str>)] = &[
            ("1 件", "C:\\a\\dsx.exe\r\n", Some("C:\\a\\dsx.exe")),
            (
                "複数件は先頭",
                "C:\\a\\dsx.exe\r\nC:\\b\\dsx.exe\r\n",
                Some("C:\\a\\dsx.exe"),
            ),
            (
                "LF 区切り",
                "/usr/bin/dsx\n/opt/dsx\n",
                Some("/usr/bin/dsx"),
            ),
            (
                "先頭の空行を飛ばす",
                "\r\n  /usr/bin/dsx  \n",
                Some("/usr/bin/dsx"),
            ),
            ("空", "", None),
            ("空白のみ", " \r\n\n", None),
        ];
        for (name, stdout, want) in cases {
            assert_eq!(first_path_line(stdout).as_deref(), *want, "{name}");
        }
    }

    /// PATH 上に `dsx.cmd` などがあっても、実行される `dsx.exe` だけを返すことを検証する
    /// （`Command` は `.exe` しか探さない）。
    #[cfg(target_os = "windows")]
    #[test]
    fn which_dsx_returns_only_the_exe_that_command_would_run() {
        struct Case {
            name: &'static str,
            in_a: &'static [&'static str],
            in_b: &'static [&'static str],
            /// 期待する dsx.exe の場所（PATH の先頭側が "a"、後ろ側が "b"）。
            want: Option<&'static str>,
        }
        let cases = [
            Case {
                name: ".cmd が先で .exe が後",
                in_a: &["dsx.cmd"],
                in_b: &["dsx.exe"],
                want: Some("b"),
            },
            Case {
                name: ".exe が両方にあれば先頭",
                in_a: &["dsx.exe"],
                in_b: &["dsx.exe"],
                want: Some("a"),
            },
            Case {
                name: ".cmd と .bat だけなら見つからない",
                in_a: &["dsx.cmd"],
                in_b: &["dsx.bat"],
                want: None,
            },
            Case {
                name: "何も無い",
                in_a: &[],
                in_b: &[],
                want: None,
            },
        ];
        let system32 =
            Path::new(&std::env::var_os("SystemRoot").expect("SystemRoot")).join("System32");
        let root = std::env::temp_dir().join(format!("arbor-which-dsx-{}", std::process::id()));
        for case in cases {
            let _ = std::fs::remove_dir_all(&root);
            for (dir, files) in [("a", case.in_a), ("b", case.in_b)] {
                std::fs::create_dir_all(root.join(dir)).unwrap();
                for file in files {
                    std::fs::write(root.join(dir).join(file), b"").unwrap();
                }
            }
            // where.exe 自身を見つけるため System32 は残す。
            let path =
                std::env::join_paths([root.join("a"), root.join("b"), system32.clone()]).unwrap();
            let got = which_dsx_in(Some(&path));
            let want = case.want.map(|dir| {
                root.join(dir)
                    .join("dsx.exe")
                    .to_string_lossy()
                    .into_owned()
            });
            assert_eq!(got, want, "{}", case.name);
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// dsx が利用可能な場合に `self-update` サブコマンドが認識されることを確認する。
    /// `--help` を渡すことで実際の更新は行わず、サブコマンドの存在とヘルプ出力のみ検証する。
    #[test]
    fn dsx_self_update_subcommand_is_recognized() {
        if !check_dsx().available {
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

    /// dsx が利用可能な場合に `sys update --no-tui` が存在するサブコマンドとして
    /// 認識されることを確認する（`--help` でサブコマンド一覧が取れれば十分）。
    #[test]
    fn run_dsx_sync_help_succeeds_when_available() {
        if !check_dsx().available {
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
    fn supports_daily_refresh_cases() {
        let cases = [
            (Some("dsx version 0.10.2"), false),
            (Some("dsx version 0.11.0"), false),
            (Some("dsx version 0.11.99"), false),
            (Some("dsx version 0.12.0"), true),
            (Some("dsx version 0.12.1"), true),
            (Some("dsx version 1.0.0"), true),
            (Some("dsx version dev"), false),
            (None, false),
        ];
        for (version, expected) in cases {
            assert_eq!(supports_daily_refresh(version), expected, "{version:?}");
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
    fn ensure_daily_refresh_supported_cases() {
        let status = |available, version: Option<&str>, supported| DsxStatus {
            available,
            version: version.map(String::from),
            path: None,
            supports_daily_refresh: supported,
        };

        assert!(
            ensure_daily_refresh_supported(&status(true, Some("dsx version 0.12.0"), true)).is_ok()
        );

        let old = ensure_daily_refresh_supported(&status(true, Some("dsx version 0.11.0"), false))
            .unwrap_err();
        assert!(old.contains("v0.12.0 以上"), "{old}");
        assert!(old.contains("0.11.0"), "{old}");
        assert!(old.contains("self-update"), "{old}");

        let missing = ensure_daily_refresh_supported(&status(false, None, false)).unwrap_err();
        assert!(missing.contains("見つかりません"), "{missing}");
    }

    #[test]
    fn sys_update_args_add_the_dry_run_flag_only_when_asked() {
        assert_eq!(sys_update_args(false), ["sys", "update", "--no-tui"]);
        assert_eq!(sys_update_args(true), ["sys", "update", "--no-tui", "-n"]);
    }

    #[test]
    fn dsx_task_invocation_cases() {
        let root = "C:/src".to_string();
        let cases: [(&str, DsxTask, &str, &[&str]); 7] = [
            (
                "sys update",
                DsxTask::SysUpdate,
                ".",
                &["sys", "update", "--no-tui"],
            ),
            (
                "sys update -n",
                DsxTask::SysUpdateDryRun,
                ".",
                &["sys", "update", "--no-tui", "-n"],
            ),
            ("doctor", DsxTask::Doctor, ".", &["doctor"]),
            ("self-update", DsxTask::SelfUpdate, ".", &["self-update"]),
            (
                "repo update は root を --root で渡す",
                DsxTask::RepoUpdate { root: root.clone() },
                ".",
                &[
                    "repo", "update", "--root", "C:/src", "--no-tui", "--jobs", "4",
                ],
            ),
            (
                "daily refresh は root を --root で渡す",
                DsxTask::DailyRefresh { root },
                ".",
                &["run", "--root", "C:/src", "--no-tui", "--jobs", "4"],
            ),
            (
                "env run は空白でコマンドを分け、指定のディレクトリで実行する",
                DsxTask::EnvRun {
                    cwd: "/repo/a".to_string(),
                    command: "npm  install --frozen-lockfile".to_string(),
                },
                "/repo/a",
                &["env", "run", "--", "npm", "install", "--frozen-lockfile"],
            ),
        ];

        for (name, task, expected_cwd, expected_args) in cases {
            let (cwd, args) = task.invocation();

            assert_eq!(cwd, expected_cwd, "{name}");
            assert_eq!(args, expected_args, "{name}");
        }
    }

    // ── run_task（起動を差し替えた Runner）──────────────────────────────────────

    use crate::commands::dsx_report::RunReport;
    use crate::commands::runner::{
        EventSink, Launched, Launcher, ProcessFinished, ProcessOutput, ProcessStarted, Runner,
    };
    use std::sync::{Arc, Mutex};

    /// 起動の依頼だけを記録し、すぐに指定の終了コードで終わる。
    /// `events_body` を指定すると、`--events-file` で渡されたファイルへ、dsx の代わりに書き込む。
    struct RecordingLauncher {
        exit_code: i32,
        events_body: Option<String>,
        launched: Mutex<Vec<(String, Vec<String>, PathBuf)>>,
    }

    impl RecordingLauncher {
        fn new(exit_code: i32) -> Arc<Self> {
            Self::with_events(exit_code, None)
        }

        fn with_events(exit_code: i32, events_body: Option<&str>) -> Arc<Self> {
            Arc::new(Self {
                exit_code,
                events_body: events_body.map(str::to_string),
                launched: Mutex::new(Vec::new()),
            })
        }
    }

    impl Launcher for RecordingLauncher {
        fn launch(&self, spec: &LaunchSpec) -> io::Result<Launched> {
            self.launched.lock().unwrap().push((
                spec.program.clone(),
                spec.args.clone(),
                spec.cwd.clone(),
            ));
            if let (Some(body), Some(path)) = (&self.events_body, events_file_arg(&spec.args)) {
                std::fs::write(path, body)?;
            }
            let exit_code = self.exit_code;
            Ok(Launched {
                stdout: Box::new(io::empty()),
                stderr: Box::new(io::empty()),
                wait: Box::new(move || Ok(Some(exit_code))),
                terminate: Arc::new(|| {}),
            })
        }
    }

    /// 引数の `--events-file` の値。
    fn events_file_arg(args: &[String]) -> Option<&String> {
        let index = args.iter().position(|a| a == "--events-file")?;
        args.get(index + 1)
    }

    struct NullSink;

    impl EventSink for NullSink {
        fn started(&self, _: &ProcessStarted) {}
        fn output(&self, _: &ProcessOutput) {}
        fn finished(&self, _: &ProcessFinished) {}
    }

    fn state_with(launcher: &Arc<RecordingLauncher>) -> RunnerState {
        let runner = Runner::new(
            Arc::clone(launcher) as Arc<dyn Launcher>,
            Arc::new(NullSink),
        );
        RunnerState::with_runner(Arc::new(runner))
    }

    fn dsx_with_version(version: &str) -> DsxStatus {
        DsxStatus {
            available: true,
            version: Some(format!("dsx version {version}")),
            path: None,
            supports_daily_refresh: supports_daily_refresh(Some(version)),
        }
    }

    /// イベント出力に対応する dsx（v0.13.0）。
    fn ready_dsx() -> DsxStatus {
        dsx_with_version("0.13.0")
    }

    /// Daily Refresh は使えるが、イベント出力には対応しない dsx（v0.12.0）。
    fn no_events_dsx() -> DsxStatus {
        dsx_with_version("0.12.0")
    }

    /// Daily Refresh も使えない dsx（v0.11.0）。
    fn old_dsx() -> DsxStatus {
        dsx_with_version("0.11.0")
    }

    fn launched(launcher: &RecordingLauncher) -> Vec<(String, Vec<String>, PathBuf)> {
        launcher.launched.lock().unwrap().clone()
    }

    /// テスト用のイベントファイルの置き場。
    fn test_events_dir() -> Result<PathBuf, String> {
        Ok(std::env::temp_dir().join(format!("arbor-dsx-tests-{}", std::process::id())))
    }

    fn broken_events_dir() -> Result<PathBuf, String> {
        Err("イベントの保存先を決められません".to_string())
    }

    fn run(
        launcher: &Arc<RecordingLauncher>,
        reports: &ReportState,
        task: DsxTask,
        check: fn() -> DsxStatus,
    ) -> Result<DsxOutput, String> {
        let state = state_with(launcher);
        tauri::async_runtime::block_on(run_task_with(&state, reports, task, check, test_events_dir))
    }

    #[test]
    fn run_task_launches_dsx_with_the_task_invocation() {
        let launcher = RecordingLauncher::new(0);

        let output = run(
            &launcher,
            &ReportState::default(),
            DsxTask::Doctor,
            ready_dsx,
        )
        .expect("doctor");

        assert_eq!(output.exit_code, 0);
        assert_eq!(
            launched(&launcher),
            [(
                "dsx".to_string(),
                vec!["doctor".to_string()],
                PathBuf::from(".")
            )]
        );
    }

    #[test]
    fn run_task_reports_a_failing_exit_code() {
        let launcher = RecordingLauncher::new(3);

        let err = run(
            &launcher,
            &ReportState::default(),
            DsxTask::SysUpdate,
            ready_dsx,
        )
        .unwrap_err();

        assert!(err.contains("exited with code 3"), "{err}");
    }

    #[test]
    fn daily_refresh_runs_only_when_dsx_supports_daily_refresh() {
        let root = "C:/src".to_string();

        let launcher = RecordingLauncher::new(0);
        run(
            &launcher,
            &ReportState::default(),
            DsxTask::DailyRefresh { root: root.clone() },
            no_events_dsx,
        )
        .expect("daily refresh");
        assert_eq!(launched(&launcher).len(), 1);
        assert_eq!(launched(&launcher)[0].1[..2], ["run", "--root"]);

        let launcher = RecordingLauncher::new(0);
        let err = run(
            &launcher,
            &ReportState::default(),
            DsxTask::DailyRefresh { root },
            old_dsx,
        )
        .unwrap_err();
        assert!(err.contains("v0.12.0 以上"), "{err}");
        assert!(launched(&launcher).is_empty(), "古い dsx では起動しない");
    }

    #[test]
    fn tasks_other_than_daily_refresh_run_on_old_dsx() {
        let launcher = RecordingLauncher::new(0);

        // 古い dsx でも、Daily Refresh 以外は実行できる（イベント出力なしで）
        run(
            &launcher,
            &ReportState::default(),
            DsxTask::SysUpdateDryRun,
            old_dsx,
        )
        .expect("dry run");

        assert_eq!(launched(&launcher).len(), 1);
        assert_eq!(events_file_arg(&launched(&launcher)[0].1), None);
    }

    #[test]
    fn run_task_uses_the_real_dsx_check_only_for_tasks_that_need_it() {
        let launcher = RecordingLauncher::new(0);
        let state = state_with(&launcher);

        // Doctor は dsx の版を確認しないので、実際の dsx を起動せずに、記録だけを確かめられる
        tauri::async_runtime::block_on(run_task(&state, &ReportState::default(), DsxTask::Doctor))
            .expect("doctor");

        assert_eq!(launched(&launcher).len(), 1);
    }

    // ── イベント出力（--events-file。dsx#152）────────────────────────────────────

    #[test]
    fn supports_events_cases() {
        let cases = [
            (None, false),
            (Some("dsx version 0.12.0"), false),
            (Some("dsx version 0.12.9"), false),
            (Some("dsx version 0.13.0"), true),
            (Some("v0.13.0"), true),
            (Some("dsx version 0.13.1-rc1"), true),
            (Some("dsx version 1.0.0"), true),
            (Some("dev"), false),
        ];

        for (version, expected) in cases {
            assert_eq!(supports_events(version), expected, "{version:?}");
        }
    }

    #[test]
    fn only_update_tasks_report_events() {
        let root = "/src".to_string();
        let cases = [
            (DsxTask::SysUpdate, true),
            (DsxTask::SysUpdateDryRun, true),
            (DsxTask::RepoUpdate { root: root.clone() }, true),
            (DsxTask::DailyRefresh { root }, true),
            (DsxTask::Doctor, false),
            (DsxTask::SelfUpdate, false),
            (
                DsxTask::EnvRun {
                    cwd: ".".to_string(),
                    command: "ls".to_string(),
                },
                false,
            ),
        ];

        for (task, expected) in cases {
            assert_eq!(task.reports_events(), expected, "{task:?}");
        }
    }

    const EVENTS_OK: &str = concat!(
        r#"{"schema":1,"type":"start","command":"sys update","version":"v0.13.0"}"#,
        "\n",
        r#"{"schema":1,"type":"summary","command":"sys update","ok":true,"jobs":{"success":1,"failed":0,"skipped":1},"updated":0,"warnings":0,"issues":[{"phase":"sys","kind":"manager","name":"gem","status":"skipped","code":"unavailable","reason":"未インストール"}],"warning_items":[]}"#,
        "\n"
    );

    const EVENTS_FAILED: &str = concat!(
        r#"{"schema":1,"type":"start","command":"run","version":"v0.13.0"}"#,
        "\n",
        r#"{"schema":1,"type":"summary","command":"run","ok":false,"error":"1 件のフェーズでエラーが発生しました","jobs":{"success":0,"failed":1,"skipped":0},"updated":0,"warnings":0,"issues":[{"phase":"repo","kind":"phase","name":"repo","status":"failed","code":"error","reason":"root が存在しません"}],"warning_items":[]}"#,
        "\n"
    );

    #[test]
    fn events_file_is_passed_to_dsx_and_the_report_is_kept() {
        let launcher = RecordingLauncher::with_events(0, Some(EVENTS_OK));
        let reports = ReportState::default();

        run(&launcher, &reports, DsxTask::SysUpdate, ready_dsx).expect("sys update");

        let args = launched(&launcher)[0].1.clone();
        assert_eq!(&args[..3], ["sys", "update", "--no-tui"]);
        let path = events_file_arg(&args).expect("--events-file が渡される");
        assert!(
            Path::new(path).starts_with(test_events_dir().unwrap()),
            "{path}"
        );

        let report = reports.take().expect("報告が残る");
        assert_eq!(report.command, "sys update");
        assert_eq!(report.jobs.skipped, 1);
        assert_eq!(report.issues[0].name, "gem");
        assert!(
            !Path::new(path).exists(),
            "読み終えたイベントファイルは消す"
        );
    }

    /// dsx が失敗（終了コード 1）した実行ほど、報告が要る。
    #[test]
    fn the_report_is_kept_even_when_dsx_fails() {
        let launcher = RecordingLauncher::with_events(1, Some(EVENTS_FAILED));
        let reports = ReportState::default();

        let err = run(
            &launcher,
            &reports,
            DsxTask::DailyRefresh {
                root: "C:/src".to_string(),
            },
            ready_dsx,
        )
        .unwrap_err();

        assert!(err.contains("exited with code 1"), "{err}");
        let report: RunReport = reports.take().expect("失敗した実行の報告も残る");
        assert!(!report.ok);
        assert_eq!(report.issues[0].reason, "root が存在しません");
    }

    /// 対応しない版の dsx には `--events-file` を渡さず、報告も作らない（これまでどおり）。
    #[test]
    fn dsx_without_events_support_gets_no_events_file() {
        let launcher = RecordingLauncher::with_events(0, Some(EVENTS_OK));
        let reports = ReportState::default();

        run(&launcher, &reports, DsxTask::SysUpdate, no_events_dsx).expect("sys update");

        assert_eq!(events_file_arg(&launched(&launcher)[0].1), None);
        assert_eq!(reports.take(), None);
    }

    #[test]
    fn tasks_that_do_not_report_events_get_no_events_file() {
        let launcher = RecordingLauncher::with_events(0, Some(EVENTS_OK));
        let reports = ReportState::default();

        run(&launcher, &reports, DsxTask::Doctor, ready_dsx).expect("doctor");

        assert_eq!(events_file_arg(&launched(&launcher)[0].1), None);
        assert_eq!(reports.take(), None);
    }

    /// dsx が契約に合わない出力を書いたとき（版違い・途中で終了）は、報告を作らない。
    #[test]
    fn an_event_file_that_does_not_meet_the_contract_yields_no_report() {
        let bodies = [
            (
                "schema が未対応",
                EVENTS_OK.replace("\"schema\":1", "\"schema\":2"),
            ),
            (
                "summary が無い",
                EVENTS_OK.lines().next().unwrap().to_string() + "\n",
            ),
            ("空", String::new()),
        ];

        for (name, body) in bodies {
            let launcher = RecordingLauncher::with_events(0, Some(&body));
            let reports = ReportState::default();

            run(&launcher, &reports, DsxTask::SysUpdate, ready_dsx).expect(name);

            assert_eq!(reports.take(), None, "{name}");
        }
    }

    #[test]
    fn a_previous_report_is_not_replaced_by_a_run_without_events() {
        let reports = ReportState::default();
        run(
            &RecordingLauncher::with_events(0, Some(EVENTS_OK)),
            &reports,
            DsxTask::SysUpdate,
            ready_dsx,
        )
        .expect("sys update");

        // 報告を取り出す前に、イベントの無い実行（doctor）が走っても、報告は消えない
        run(
            &RecordingLauncher::new(0),
            &reports,
            DsxTask::Doctor,
            ready_dsx,
        )
        .expect("doctor");

        assert_eq!(
            reports.take().map(|r| r.command),
            Some("sys update".to_string())
        );
    }

    /// イベントの置き場を用意できないときは、黙って省かず、実行の前にエラーにする。
    #[test]
    fn an_unusable_events_dir_fails_before_launching() {
        let launcher = RecordingLauncher::new(0);
        let state = state_with(&launcher);

        let err = tauri::async_runtime::block_on(run_task_with(
            &state,
            &ReportState::default(),
            DsxTask::SysUpdate,
            ready_dsx,
            broken_events_dir,
        ))
        .unwrap_err();

        assert!(err.contains("イベントの保存先"), "{err}");
        assert!(launched(&launcher).is_empty(), "起動しない");
    }
}
