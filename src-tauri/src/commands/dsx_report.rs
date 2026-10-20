//! dsx の機械可読なイベント（`--events-file`。dsx v0.13.0 以上）を読み、実行後の報告にする。
//!
//! コンソールのログは変えない。ここで作る報告は、ログの表示を置き換えるのではなく、
//! 「警告・スキップ・失敗」を判定として浮かび上がらせるための追加の情報。
//! 契約は dsx の `docs/Events_Schema.md`。次の場合は、解釈せずに `None` を返し、テキストのログだけにする。
//! - スキーマの版が、Arbor が対応する版ではない。
//! - `summary` が無い（dsx が最後まで書き終えなかった）。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, SystemTime};

/// イベント出力（`--events-file`）に対応する dsx の最初の版（dsx#152）。
pub const EVENTS_MIN_VERSION: (u32, u32, u32) = (0, 13, 0);

/// Arbor が解釈できるイベントのスキーマ版。
pub const SUPPORTED_SCHEMA: u64 = 1;

/// 異常終了で残ったイベントファイルを、次の実行で片付ける期限。
const STALE_AFTER: Duration = Duration::from_secs(24 * 60 * 60);

// ─── 報告 ────────────────────────────────────────────────────────────────────

/// 終了時の要約のジョブ件数。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobCounts {
    #[serde(default)]
    pub success: u64,
    #[serde(default)]
    pub failed: u64,
    #[serde(default)]
    pub skipped: u64,
}

/// 失敗またはスキップしたジョブ。`status` / `code` / `kind` は dsx が値を足しうるため、文字列のまま持つ。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReportIssue {
    #[serde(default)]
    pub phase: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub reason: String,
}

/// 警告。終了コードには影響しない。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReportWarning {
    #[serde(default)]
    pub phase: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub subject: String,
    #[serde(default)]
    pub message: String,
}

/// 1 回の実行の報告（dsx の `summary` イベントを写したもの）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunReport {
    #[serde(default)]
    pub command: String,
    /// dsx の終了コードが 0 だったか。
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub jobs: JobCounts,
    /// 更新したパッケージの合計。
    #[serde(default)]
    pub updated: u64,
    /// 警告の件数。
    #[serde(default)]
    pub warnings: u64,
    #[serde(default)]
    pub issues: Vec<ReportIssue>,
    #[serde(default)]
    pub warning_items: Vec<ReportWarning>,
}

/// イベントの JSON Lines から報告を作る。契約に合わないときは `None`（理由は呼び出し側では区別しない）。
///
/// - 読めない行は飛ばす（強制終了で最後の行が欠けることがある）。
/// - 未知の `type` と未知のフィールドは無視する（dsx が足しても版は上がらない）。
/// - `schema` が対応する版でないイベントが 1 つでもあれば、全体を解釈しない。
pub fn parse_report(text: &str) -> Option<RunReport> {
    let mut summary = None;

    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value.get("schema").and_then(Value::as_u64) != Some(SUPPORTED_SCHEMA) {
            return None;
        }
        if value.get("type").and_then(Value::as_str) == Some("summary") {
            summary = serde_json::from_value::<RunReport>(value).ok();
        }
    }

    summary
}

// ─── イベントファイル ────────────────────────────────────────────────────────

static FILE_SEQ: AtomicU64 = AtomicU64::new(0);

/// dsx に渡すイベントファイル。dsx が書き、終了後に Arbor が読む。破棄するときに消す。
#[derive(Debug)]
pub struct EventsFile {
    path: PathBuf,
}

impl EventsFile {
    /// `dir` の中に、実行ごとに別のファイルを予約する（中身は dsx が作る）。
    /// `dir` が無ければ作り、異常終了で残った古いファイルを片付ける。
    pub fn create_in(dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(dir)
            .map_err(|e| format!("イベントの保存先を作成できません ({}): {e}", dir.display()))?;
        remove_stale(dir, STALE_AFTER);

        let name = format!(
            "run-{}-{}.jsonl",
            std::process::id(),
            FILE_SEQ.fetch_add(1, Ordering::Relaxed)
        );
        Ok(Self {
            path: dir.join(name),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// dsx が書いたイベントから報告を作る。ファイルが無い、読めない、契約に合わないときは `None`。
    pub fn read_report(&self) -> Option<RunReport> {
        let bytes = fs::read(&self.path).ok()?;
        parse_report(&String::from_utf8_lossy(&bytes))
    }
}

impl Drop for EventsFile {
    fn drop(&mut self) {
        // 無い（dsx が書かなかった）ことも普通にあるので、失敗は無視する。
        let _ = fs::remove_file(&self.path);
    }
}

/// `max_age` より古い、Arbor が作ったイベントファイルを消す。失敗しても実行は止めない。
fn remove_stale(dir: &Path, max_age: Duration) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with("run-") && name.ends_with(".jsonl")) {
            continue;
        }
        let age = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok());
        if age.is_some_and(|age| age > max_age) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

// ─── 受け渡し ────────────────────────────────────────────────────────────────

/// 直近の実行の報告を、フロントエンドが取りに来るまで保持する。
/// dsx が失敗（終了コード 1）したときも報告は必要なので、コマンドの戻り値（`Result`）には載せない。
/// 実行は 1 件ずつなので、保持するのは 1 件でよい。
#[derive(Default)]
pub struct ReportState(Mutex<Option<RunReport>>);

impl ReportState {
    pub fn set(&self, report: RunReport) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(report);
    }

    /// 保持している報告を取り出す（取り出したら空になる）。
    pub fn take(&self) -> Option<RunReport> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).take()
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const START: &str = r#"{"schema":1,"type":"start","time":"2026-10-20T20:16:29Z","command":"run","version":"v0.13.0"}"#;
    const GEM_SKIPPED: &str = r#"{"schema":1,"type":"job_finished","phase":"sys","kind":"manager","name":"gem","status":"skipped","code":"unavailable","reason":"未インストールまたは利用不可のためスキップ","updated":0,"duration_ms":0}"#;
    const SUMMARY: &str = r#"{"schema":1,"type":"summary","command":"run","ok":true,"jobs":{"success":13,"failed":0,"skipped":1},"updated":2,"warnings":1,"issues":[{"phase":"sys","kind":"manager","name":"gem","status":"skipped","code":"unavailable","reason":"未インストールまたは利用不可のためスキップ"}],"warning_items":[{"phase":"sys","category":"manager_unknown","subject":"foo","message":"未知のマネージャが指定されています"}]}"#;

    fn lines(parts: &[&str]) -> String {
        parts.join("\n") + "\n"
    }

    /// 実際の dsx（`dsx sys update -n --events-file`。#152 の実装を実機で動かしたもの）の出力。
    /// 手で組んだ JSON ではなく、実物で契約（dsx の `docs/Events_Schema.md`）を満たすことを確かめる。
    const REAL_DSX_OUTPUT: &str = include_str!("testdata/dsx_events_sys_update.jsonl");

    #[test]
    fn parse_report_reads_real_dsx_output() {
        let report = parse_report(REAL_DSX_OUTPUT).expect("実際の dsx の出力は報告になる");

        assert_eq!(report.command, "sys update");
        assert!(report.ok);
        assert_eq!(
            report.jobs,
            JobCounts {
                success: 13,
                failed: 0,
                skipped: 1
            }
        );
        assert_eq!(report.warnings, 0);
        assert_eq!(report.issues.len(), 1);
        assert_eq!(
            (
                report.issues[0].name.as_str(),
                report.issues[0].code.as_str()
            ),
            ("gem", "unavailable")
        );
        assert!(report.warning_items.is_empty());
    }

    #[test]
    fn parse_report_reads_the_summary() {
        let report = parse_report(&lines(&[START, GEM_SKIPPED, SUMMARY]))
            .expect("summary がある schema 1 の出力は報告になる");

        assert_eq!(report.command, "run");
        assert!(report.ok);
        assert_eq!(
            report.jobs,
            JobCounts {
                success: 13,
                failed: 0,
                skipped: 1
            }
        );
        assert_eq!((report.updated, report.warnings), (2, 1));
        assert_eq!(report.issues.len(), 1);
        assert_eq!(report.issues[0].name, "gem");
        assert_eq!(report.issues[0].code, "unavailable");
        assert_eq!(report.warning_items[0].category, "manager_unknown");
        assert_eq!(report.warning_items[0].subject, "foo");
    }

    /// 契約に合わない出力は、解釈せずに `None`（テキストのログだけにする）。
    #[test]
    fn parse_report_returns_none_when_the_contract_is_not_met() {
        let cases: [(&str, String); 7] = [
            ("空", String::new()),
            ("空行だけ", "\n\n".to_string()),
            (
                "summary が無い（dsx が最後まで書かなかった）",
                lines(&[START, GEM_SKIPPED]),
            ),
            (
                "schema が未対応の版",
                lines(&[START, &SUMMARY.replace("\"schema\":1", "\"schema\":2")]),
            ),
            (
                "途中のイベントだけ未対応の版",
                lines(&[&START.replace("\"schema\":1", "\"schema\":2"), SUMMARY]),
            ),
            (
                "schema が無い",
                lines(&[START, r#"{"type":"summary","ok":true}"#]),
            ),
            ("JSON ではない", "not json\nalso not json\n".to_string()),
        ];

        for (name, text) in cases {
            assert_eq!(parse_report(&text), None, "{name}");
        }
    }

    /// 強制終了で最後の行が欠けても、読める行から報告を作る。ただし summary が欠けたら `None`。
    #[test]
    fn parse_report_tolerates_broken_lines() {
        let truncated_summary = &SUMMARY[..SUMMARY.len() / 2];

        assert_eq!(
            parse_report(&lines(&[START, "{broken", GEM_SKIPPED, SUMMARY])).map(|r| r.jobs.skipped),
            Some(1),
            "途中の壊れた行は飛ばす"
        );
        assert_eq!(
            parse_report(&lines(&[START, GEM_SKIPPED, truncated_summary])),
            None,
            "summary が途中で切れていれば不完全"
        );
    }

    /// dsx が足した未知の type とフィールドは無視する（版は上がらない契約）。
    #[test]
    fn parse_report_ignores_unknown_types_and_fields() {
        let future_event = r#"{"schema":1,"type":"progress","percent":50}"#;
        let future_summary = SUMMARY.replace(
            "\"ok\":true",
            "\"ok\":true,\"duration_ms\":1234,\"future\":{\"a\":1}",
        );

        let report = parse_report(&lines(&[START, future_event, &future_summary]))
            .expect("未知の type とフィールドは無視して読める");

        assert_eq!(report.jobs.success, 13);
    }

    /// 失敗した実行の報告: 終了コード 1、`phase` の失敗（run の root が不正など）。
    #[test]
    fn parse_report_reads_a_failed_run() {
        let failed = r#"{"schema":1,"type":"summary","command":"run","ok":false,"error":"1 件のフェーズでエラーが発生しました","jobs":{"success":0,"failed":1,"skipped":0},"updated":0,"warnings":0,"issues":[{"phase":"repo","kind":"phase","name":"repo","status":"failed","code":"error","reason":"root が存在しません"}],"warning_items":[]}"#;

        let report = parse_report(&lines(&[START, failed])).expect("失敗した実行も報告になる");

        assert!(!report.ok);
        assert_eq!(
            report.error.as_deref(),
            Some("1 件のフェーズでエラーが発生しました")
        );
        assert_eq!(report.issues[0].kind, "phase");
        assert_eq!(report.issues[0].reason, "root が存在しません");
    }

    /// summary の件数や一覧が欠けていても、既定値で読める（値の追加・省略に強い）。
    #[test]
    fn parse_report_fills_defaults_for_missing_fields() {
        let minimal = r#"{"schema":1,"type":"summary","ok":true}"#;

        let report = parse_report(minimal).expect("最小の summary も読める");

        assert_eq!(
            report,
            RunReport {
                ok: true,
                ..RunReport::default()
            }
        );
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "arbor-dsx-report-{name}-{}-{}",
            std::process::id(),
            FILE_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn events_file_reads_what_dsx_wrote_and_cleans_up_on_drop() {
        let dir = temp_dir("read");
        let path;
        {
            let file = EventsFile::create_in(&dir).expect("作成できる");
            path = file.path().to_path_buf();
            assert!(path.starts_with(&dir), "指定のディレクトリの中に置く");
            assert_eq!(file.read_report(), None, "dsx が書く前は報告がない");

            fs::write(&path, lines(&[START, SUMMARY])).unwrap();
            assert_eq!(file.read_report().map(|r| r.jobs.success), Some(13));
        }
        assert!(!path.exists(), "破棄するときに消す");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn events_file_names_are_unique_per_run() {
        let dir = temp_dir("unique");
        let first = EventsFile::create_in(&dir).unwrap();
        let second = EventsFile::create_in(&dir).unwrap();

        assert_ne!(first.path(), second.path());

        drop((first, second));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn events_file_fails_clearly_when_the_directory_cannot_be_created() {
        let dir = temp_dir("blocked");
        fs::create_dir_all(&dir).unwrap();
        let blocker = dir.join("file");
        fs::write(&blocker, "x").unwrap();

        // ファイルの下にはディレクトリを作れない
        let err = EventsFile::create_in(&blocker.join("events")).expect_err("作成できない");

        assert!(err.contains("イベントの保存先を作成できません"), "{err}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn remove_stale_deletes_only_old_files_arbor_created() {
        let dir = temp_dir("stale");
        fs::create_dir_all(&dir).unwrap();
        let old = dir.join("run-1-0.jsonl");
        let fresh = dir.join("run-1-1.jsonl");
        let foreign = dir.join("notes.txt");
        for path in [&old, &fresh, &foreign] {
            fs::write(path, "x").unwrap();
        }
        let two_days_ago = SystemTime::now() - Duration::from_secs(2 * 24 * 60 * 60);
        fs::File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_modified(two_days_ago)
            .unwrap();
        fs::File::options()
            .write(true)
            .open(&foreign)
            .unwrap()
            .set_modified(two_days_ago)
            .unwrap();

        remove_stale(&dir, STALE_AFTER);

        assert!(!old.exists(), "古い run-*.jsonl は消す");
        assert!(fresh.exists(), "新しいものは残す");
        assert!(
            foreign.exists(),
            "Arbor が作ったものではないファイルには触らない"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn report_state_hands_over_a_report_once() {
        let state = ReportState::default();
        assert_eq!(state.take(), None);

        state.set(RunReport {
            command: "run".to_string(),
            ..RunReport::default()
        });

        assert_eq!(state.take().map(|r| r.command), Some("run".to_string()));
        assert_eq!(state.take(), None, "取り出したら空になる");
    }
}
