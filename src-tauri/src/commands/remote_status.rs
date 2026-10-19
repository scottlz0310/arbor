//! リモートの状態の確認。アーカイブ済み・移転済み・消えた remote のクローンを見つける。
//!
//! git だけでは、アーカイブ済みかどうかが分からない（transfer の後も旧 URL はリダイレクトされ、アーカイブの後も
//! fetch は成功する）。そのため、各リポジトリの `origin`（GitHub のもの）について、`gh api repos/{owner}/{repo}` で
//! 現在の状態を取る。`gh` の認証で、非公開リポジトリも読める。
//! ネットワークを使うため、自動では走らせない。fetch と同じ実行の枠で、手動の操作として行う。

use super::runner::{hide_console, JobContext, Runner, RunnerState, Stream};
use crate::config::AppConfig;
use crate::models::{RemoteCheckSummary, RemoteState, RemoteStatus};
use crate::workspace::{effective_repos, EffectiveRepo};
use git2::Repository;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, PoisonError};

/// 同時に確認するリポジトリ数の上限。GitHub の API の上限（認証あり 5,000 件 / 時）に対して十分に小さい。
const MAX_CHECK_JOBS: usize = 4;

/// `origin` の URL から取り出した、GitHub の `owner/repo`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubSlug {
    pub owner: String,
    pub repo: String,
}

impl GithubSlug {
    fn full_name(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }
}

/// GitHub の owner / repo 名に使える文字だけで、`.` / `..` でないこと。`gh api` の URL に埋め込むため、厳しく検査する。
fn is_valid_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// `https://github.com/o/r(.git)`・`git@github.com:o/r.git`・`ssh://git@github.com/o/r.git` などから、
/// `o/r` を取り出す。GitHub 以外のホスト、形が違うものは None。
pub fn github_slug(url: &str) -> Option<GithubSlug> {
    let url = url.trim();
    // scp 形式（git@github.com:o/r.git）は `host:path`、URL 形式は `scheme://[user@]host/path`。
    let (host, path) = if let Some((_, rest)) = url.split_once("://") {
        let (authority, path) = rest.split_once('/')?;
        (authority.rsplit('@').next()?, path)
    } else {
        let (authority, path) = url.split_once(':')?;
        (authority.rsplit('@').next()?, path)
    };
    if !host.eq_ignore_ascii_case("github.com") {
        return None;
    }
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, repo) = path.split_once('/')?;
    (is_valid_name(owner) && is_valid_name(repo)).then(|| GithubSlug {
        owner: owner.to_string(),
        repo: repo.to_string(),
    })
}

/// `gh api` の結果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lookup {
    Found { archived: bool, full_name: String },
    NotFound,
    Failed(String),
}

/// `gh api repos/{owner}/{repo}` の終了状態と出力を、`Lookup` に読み替える。
pub fn interpret_gh(success: bool, stdout: &str, stderr: &str) -> Lookup {
    if !success {
        // GitHub は、削除されたリポジトリも、権限の無い非公開リポジトリも、404 で答える。
        if stderr.contains("HTTP 404") {
            return Lookup::NotFound;
        }
        let reason = stderr.lines().find(|l| !l.trim().is_empty());
        return Lookup::Failed(reason.unwrap_or("gh api が失敗しました").trim().to_string());
    }
    let Ok(body) = serde_json::from_str::<serde_json::Value>(stdout) else {
        return Lookup::Failed("gh api の応答を読み取れません".to_string());
    };
    let Some(full_name) = body.get("full_name").and_then(|v| v.as_str()) else {
        return Lookup::Failed("gh api の応答に full_name がありません".to_string());
    };
    Lookup::Found {
        archived: body
            .get("archived")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        full_name: full_name.to_string(),
    }
}

/// `gh api repos/{owner}/{repo}` を実行する。
pub fn gh_lookup(slug: &GithubSlug) -> Lookup {
    let mut command = std::process::Command::new("gh");
    command
        .args(["api", &format!("repos/{}/{}", slug.owner, slug.repo)])
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1");
    hide_console(&mut command);
    match command.output() {
        Ok(output) => interpret_gh(
            output.status.success(),
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
        ),
        Err(e) => Lookup::Failed(format!("gh を起動できません: {e}")),
    }
}

/// リポジトリ 1 件の問い合わせ先。呼び出し元から差し替えられるよう trait で受ける（テストではネットワークに出ない）。
trait Looker: Fn(&GithubSlug) -> Lookup + Sync {}

impl<F> Looker for F where F: Fn(&GithubSlug) -> Lookup + Sync {}

/// `origin` の URL。`origin` が無ければ None。
fn origin_url(path: &str) -> Result<Option<String>, String> {
    let repo = Repository::open(path).map_err(|e| e.to_string())?;
    let remote = match repo.find_remote("origin") {
        Ok(remote) => remote,
        Err(e) if e.code() == git2::ErrorCode::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    Ok(remote.url().ok().map(str::to_string))
}

/// 問い合わせの結果と、`origin` の URL の `owner/repo` から、状態と、移転後の名前を決める。
fn classify(slug: &GithubSlug, lookup: Lookup) -> (RemoteState, Option<String>) {
    match lookup {
        Lookup::Found {
            archived,
            full_name,
        } => {
            let moved = (!full_name.eq_ignore_ascii_case(&slug.full_name())).then_some(full_name);
            let state = if archived {
                RemoteState::Archived
            } else {
                RemoteState::Active
            };
            (state, moved)
        }
        Lookup::NotFound => (RemoteState::NotFound, None),
        Lookup::Failed(message) => (RemoteState::Error { message }, None),
    }
}

/// リポジトリ 1 件の、リモートの状態。
fn check_repository(repo: &EffectiveRepo, looker: &impl Looker) -> RemoteStatus {
    let (state, moved_to) = match origin_url(&repo.path) {
        Err(message) => (RemoteState::Error { message }, None),
        Ok(url) => match url.as_deref().and_then(github_slug) {
            None => (RemoteState::Unsupported, None),
            Some(slug) => classify(&slug, looker(&slug)),
        },
    };
    RemoteStatus {
        path: repo.path.clone(),
        name: repo.name.clone(),
        state,
        moved_to,
    }
}

/// 1 件の結果を、コンソールに出す 1 行にする。
fn describe(status: &RemoteStatus) -> (Stream, String) {
    let moved = status
        .moved_to
        .as_deref()
        .map(|to| format!("（移転: {to}）"))
        .unwrap_or_default();
    match &status.state {
        RemoteState::Active if status.moved_to.is_some() => {
            (Stream::Stdout, format!("→ {} {moved}", status.name))
        }
        RemoteState::Active => (Stream::Stdout, format!("✓ {}", status.name)),
        RemoteState::Archived => (
            Stream::Stdout,
            format!("⚠ {}: アーカイブ済み{moved}", status.name),
        ),
        RemoteState::NotFound => (
            Stream::Stderr,
            format!(
                "✗ {}: remote が見つかりません（削除されたか、権限がありません）",
                status.name
            ),
        ),
        RemoteState::Unsupported => (
            Stream::Stdout,
            format!("- {}: GitHub の origin ではないため、対象外", status.name),
        ),
        RemoteState::Error { message } => (Stream::Stderr, format!("✗ {}: {message}", status.name)),
    }
}

/// job の本体。リポジトリを `MAX_CHECK_JOBS` 並列で確認し、1 件ごとに結果を 1 行で出す。
/// 返す終了コードは、確認に失敗した件が無ければ 0、あれば 1（アーカイブ済み・見つからないは、結果であり、失敗ではない）。
fn check_workspace(
    ctx: &JobContext,
    repos: &[EffectiveRepo],
    root_error: Option<&str>,
    looker: &impl Looker,
) -> (i32, Vec<RemoteStatus>) {
    let total = repos.len();
    if let Some(error) = root_error {
        ctx.log(Stream::Stderr, error);
    }
    if total == 0 {
        ctx.log(Stream::Stdout, "確認の対象のリポジトリがありません");
        return (0, Vec::new());
    }

    let workers = total.min(MAX_CHECK_JOBS);
    ctx.log(
        Stream::Stdout,
        format!("{total} 件のリポジトリのリモートの状態を確認します（並列 {workers}）"),
    );

    let results = Mutex::new(Vec::new());
    let next = AtomicUsize::new(0);

    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                if ctx.is_cancelled() {
                    break;
                }
                let Some(repo) = repos.get(next.fetch_add(1, Ordering::Relaxed)) else {
                    break;
                };
                let status = check_repository(repo, looker);
                let (stream, line) = describe(&status);
                let mut results = results.lock().unwrap_or_else(PoisonError::into_inner);
                results.push(status);
                ctx.log(stream, format!("[{}/{total}] {line}", results.len()));
            });
        }
    });

    let mut statuses = results.into_inner().unwrap_or_else(PoisonError::into_inner);
    statuses.sort_by_key(|s| s.name.to_lowercase());
    let count = |f: fn(&RemoteState) -> bool| statuses.iter().filter(|s| f(&s.state)).count();
    let archived = count(|s| matches!(s, RemoteState::Archived));
    let not_found = count(|s| matches!(s, RemoteState::NotFound));
    let errors = count(|s| matches!(s, RemoteState::Error { .. }));
    let moved = statuses.iter().filter(|s| s.moved_to.is_some()).count();
    if ctx.is_cancelled() {
        ctx.log(
            Stream::Stdout,
            format!("中断しました（{}/{total} 件を確認済み）", statuses.len()),
        );
    } else {
        ctx.log(
            Stream::Stdout,
            format!(
                "完了: アーカイブ済み {archived} / 見つからない {not_found} / 移転 {moved} / 確認に失敗 {errors}（全 {total} 件）"
            ),
        );
    }
    (i32::from(errors > 0), statuses)
}

/// runner の枠を取って `check_workspace` を実行する。別のコマンドが実行中ならエラー。
fn run_check(
    runner: &Runner,
    repos: &[EffectiveRepo],
    root_error: Option<&str>,
    looker: &impl Looker,
) -> Result<RemoteCheckSummary, String> {
    let outcome = runner.run_job("check remote status", |ctx| {
        check_workspace(ctx, repos, root_error, looker)
    })?;
    Ok(RemoteCheckSummary {
        total: repos.len(),
        statuses: outcome.value,
        cancelled: outcome.cancelled,
    })
}

/// 管理対象の全リポジトリの、リモートの状態を確認する。
/// 進捗は `process_*` イベントで流れ、`cancel_run` で中断できる。
pub async fn check_all_remotes(
    state: &RunnerState,
    config: &AppConfig,
) -> Result<RemoteCheckSummary, String> {
    let (repos, root_error) = effective_repos(config);
    let runner = state.runner();
    tauri::async_runtime::spawn_blocking(move || {
        run_check(&runner, &repos, root_error.as_deref(), &gh_lookup)
    })
    .await
    .map_err(|e| format!("確認の実行スレッドが異常終了しました: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::runner::{
        EventSink, ProcessFinished, ProcessOutput, ProcessStarted, SystemLauncher,
    };
    use crate::models::RepoSource;
    use std::collections::HashMap;
    use std::sync::Arc;

    // ── github_slug ──────────────────────────────────────────────────────────

    fn slug(owner: &str, repo: &str) -> Option<GithubSlug> {
        Some(GithubSlug {
            owner: owner.to_string(),
            repo: repo.to_string(),
        })
    }

    #[test]
    fn github_slug_reads_the_common_url_forms() {
        let cases = [
            (
                "https",
                "https://github.com/scottlz0310/arbor.git",
                slug("scottlz0310", "arbor"),
            ),
            (
                "https（.git なし）",
                "https://github.com/scottlz0310/arbor",
                slug("scottlz0310", "arbor"),
            ),
            (
                "末尾の /",
                "https://github.com/scottlz0310/arbor/",
                slug("scottlz0310", "arbor"),
            ),
            (
                "ユーザー名つき",
                "https://user@github.com/cli/cli.git",
                slug("cli", "cli"),
            ),
            (
                "scp 形式",
                "git@github.com:github/github-mcp-server.git",
                slug("github", "github-mcp-server"),
            ),
            (
                "ssh://",
                "ssh://git@github.com/CursorTouch/Windows-MCP.git",
                slug("CursorTouch", "Windows-MCP"),
            ),
            (
                "ホストの大文字小文字",
                "https://GitHub.com/a/b",
                slug("a", "b"),
            ),
            (
                "ドットを含む名前",
                "https://github.com/a/b.c.git",
                slug("a", "b.c"),
            ),
        ];
        for (name, url, expected) in cases {
            assert_eq!(github_slug(url), expected, "{name}");
        }
    }

    #[test]
    fn github_slug_rejects_other_hosts_and_malformed_urls() {
        let cases = [
            ("別のホスト", "https://gitlab.com/a/b.git"),
            (
                "ホストが似ている",
                "https://github.com.evil.example/a/b.git",
            ),
            ("パスが 1 段", "https://github.com/a"),
            ("パスが 3 段", "https://github.com/a/b/c"),
            ("空", ""),
            ("ローカルのパス", "/srv/git/repo.git"),
            ("Windows のパス", r"C:\src\repo"),
            ("owner が空", "https://github.com//b"),
            ("パスの辿り（..）", "https://github.com/../b"),
            ("使えない文字", "https://github.com/a/b?x=1"),
            ("空白", "https://github.com/a/b c"),
        ];
        for (name, url) in cases {
            assert_eq!(github_slug(url), None, "{name}: {url}");
        }
    }

    // ── interpret_gh ─────────────────────────────────────────────────────────

    #[test]
    fn interpret_gh_reads_successful_responses() {
        let found = |archived, name: &str| Lookup::Found {
            archived,
            full_name: name.to_string(),
        };
        let cases = [
            (
                "通常",
                true,
                r#"{"full_name":"a/b","archived":false}"#,
                found(false, "a/b"),
            ),
            (
                "アーカイブ",
                true,
                r#"{"full_name":"a/b","archived":true,"x":1}"#,
                found(true, "a/b"),
            ),
            (
                "archived が無い",
                true,
                r#"{"full_name":"a/b"}"#,
                found(false, "a/b"),
            ),
        ];
        for (name, success, stdout, expected) in cases {
            assert_eq!(interpret_gh(success, stdout, ""), expected, "{name}");
        }
    }

    #[test]
    fn interpret_gh_classifies_failures() {
        let cases = [
            (
                "404",
                false,
                "",
                "gh: Not Found (HTTP 404)",
                Lookup::NotFound,
            ),
            (
                "未ログイン",
                false,
                "",
                "\nTo get started with GitHub CLI, please run:  gh auth login\n",
                Lookup::Failed(
                    "To get started with GitHub CLI, please run:  gh auth login".to_string(),
                ),
            ),
            (
                "理由が無い",
                false,
                "",
                "  \n",
                Lookup::Failed("gh api が失敗しました".to_string()),
            ),
            (
                "JSON ではない",
                true,
                "<html>",
                "",
                Lookup::Failed("gh api の応答を読み取れません".to_string()),
            ),
            (
                "full_name が無い",
                true,
                r#"{"archived":true}"#,
                "",
                Lookup::Failed("gh api の応答に full_name がありません".to_string()),
            ),
        ];
        for (name, success, stdout, stderr, expected) in cases {
            assert_eq!(interpret_gh(success, stdout, stderr), expected, "{name}");
        }
    }

    // ── classify ─────────────────────────────────────────────────────────────

    #[test]
    fn classify_detects_archive_and_transfer() {
        let origin = GithubSlug {
            owner: "Org".to_string(),
            repo: "tool".to_string(),
        };
        let found = |archived, name: &str| Lookup::Found {
            archived,
            full_name: name.to_string(),
        };
        let cases = [
            ("通常", found(false, "Org/tool"), RemoteState::Active, None),
            (
                "大文字小文字だけの違いは、移転ではない",
                found(false, "org/TOOL"),
                RemoteState::Active,
                None,
            ),
            (
                "アーカイブ",
                found(true, "Org/tool"),
                RemoteState::Archived,
                None,
            ),
            (
                "transfer 済み",
                found(false, "me/tool"),
                RemoteState::Active,
                Some("me/tool"),
            ),
            (
                "transfer 済みで、アーカイブ",
                found(true, "me/tool"),
                RemoteState::Archived,
                Some("me/tool"),
            ),
            (
                "rename",
                found(false, "Org/tool2"),
                RemoteState::Active,
                Some("Org/tool2"),
            ),
            (
                "見つからない",
                Lookup::NotFound,
                RemoteState::NotFound,
                None,
            ),
            (
                "失敗",
                Lookup::Failed("boom".to_string()),
                RemoteState::Error {
                    message: "boom".to_string(),
                },
                None,
            ),
        ];
        for (name, lookup, state, moved) in cases {
            assert_eq!(
                classify(&origin, lookup),
                (state, moved.map(str::to_string)),
                "{name}"
            );
        }
    }

    // ── check_repository ─────────────────────────────────────────────────────

    struct TempDir {
        path: std::path::PathBuf,
    }

    impl TempDir {
        fn new(prefix: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "arbor-remote-{prefix}-{}",
                crate::test_util::unique_suffix()
            ));
            std::fs::create_dir_all(&path).expect("create temp dir");
            Self { path }
        }

        fn path_str(&self) -> String {
            self.path.to_string_lossy().into_owned()
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    /// `origin` に `url` を持つリポジトリ（`url` が None なら、remote なし）。
    fn repo_with_origin(prefix: &str, url: Option<&str>) -> (TempDir, EffectiveRepo) {
        let dir = TempDir::new(prefix);
        let git = Repository::init(&dir.path).expect("init");
        if let Some(url) = url {
            git.remote("origin", url).expect("add origin");
        }
        let repo = EffectiveRepo {
            path: dir.path_str(),
            name: prefix.to_string(),
            protected_branches: Vec::new(),
            source: RepoSource::Workspace,
        };
        (dir, repo)
    }

    /// `owner/repo` ごとの答えを返すフェイク。未登録は NotFound。
    fn fake(answers: &[(&str, Lookup)]) -> impl Looker {
        let answers: HashMap<String, Lookup> = answers
            .iter()
            .map(|(name, lookup)| (name.to_string(), lookup.clone()))
            .collect();
        move |slug: &GithubSlug| {
            answers
                .get(&slug.full_name())
                .cloned()
                .unwrap_or(Lookup::NotFound)
        }
    }

    #[test]
    fn check_repository_covers_every_state() {
        let looker = fake(&[
            (
                "me/live",
                Lookup::Found {
                    archived: false,
                    full_name: "me/live".to_string(),
                },
            ),
            (
                "me/old",
                Lookup::Found {
                    archived: true,
                    full_name: "me/old".to_string(),
                },
            ),
            (
                "org/moved",
                Lookup::Found {
                    archived: true,
                    full_name: "me/moved".to_string(),
                },
            ),
            ("me/flaky", Lookup::Failed("rate limit".to_string())),
        ]);
        let cases = [
            (
                "live",
                Some("https://github.com/me/live.git"),
                RemoteState::Active,
                None,
            ),
            (
                "old",
                Some("git@github.com:me/old.git"),
                RemoteState::Archived,
                None,
            ),
            (
                "moved",
                Some("https://github.com/org/moved"),
                RemoteState::Archived,
                Some("me/moved"),
            ),
            (
                "gone",
                Some("https://github.com/me/gone"),
                RemoteState::NotFound,
                None,
            ),
            (
                "flaky",
                Some("https://github.com/me/flaky"),
                RemoteState::Error {
                    message: "rate limit".to_string(),
                },
                None,
            ),
            (
                "gitlab",
                Some("https://gitlab.com/me/x.git"),
                RemoteState::Unsupported,
                None,
            ),
            ("noremote", None, RemoteState::Unsupported, None),
        ];
        for (name, url, state, moved) in cases {
            let (_dir, repo) = repo_with_origin(name, url);

            let status = check_repository(&repo, &looker);

            assert_eq!(status.state, state, "{name}");
            assert_eq!(status.moved_to.as_deref(), moved, "{name}");
            assert_eq!(status.name, name);
        }
    }

    #[test]
    fn check_repository_reports_unopenable_paths_as_errors() {
        let dir = TempDir::new("not-a-repo");
        let repo = EffectiveRepo {
            path: dir.path_str(),
            name: "x".to_string(),
            protected_branches: Vec::new(),
            source: RepoSource::Workspace,
        };

        let status = check_repository(&repo, &fake(&[]));

        assert!(
            matches!(status.state, RemoteState::Error { .. }),
            "{status:?}"
        );
    }

    // ── describe ─────────────────────────────────────────────────────────────

    #[test]
    fn describe_writes_one_line_per_state() {
        let status = |state, moved: Option<&str>| RemoteStatus {
            path: "/r/x".to_string(),
            name: "x".to_string(),
            state,
            moved_to: moved.map(str::to_string),
        };
        let cases = [
            (status(RemoteState::Active, None), Stream::Stdout, "✓ x"),
            (
                status(RemoteState::Active, Some("me/x")),
                Stream::Stdout,
                "→ x （移転: me/x）",
            ),
            (
                status(RemoteState::Archived, None),
                Stream::Stdout,
                "⚠ x: アーカイブ済み",
            ),
            (
                status(RemoteState::Archived, Some("me/x")),
                Stream::Stdout,
                "⚠ x: アーカイブ済み（移転: me/x）",
            ),
            (
                status(RemoteState::NotFound, None),
                Stream::Stderr,
                "✗ x: remote が見つかりません（削除されたか、権限がありません）",
            ),
            (
                status(RemoteState::Unsupported, None),
                Stream::Stdout,
                "- x: GitHub の origin ではないため、対象外",
            ),
            (
                status(
                    RemoteState::Error {
                        message: "boom".to_string(),
                    },
                    None,
                ),
                Stream::Stderr,
                "✗ x: boom",
            ),
        ];
        for (input, stream, line) in cases {
            assert_eq!(describe(&input), (stream, line.to_string()));
        }
    }

    // ── run_check（runner の job として）────────────────────────────────────────

    #[derive(Default)]
    struct RecordingSink {
        lines: Mutex<Vec<(Stream, String)>>,
    }

    impl EventSink for RecordingSink {
        fn started(&self, _event: &ProcessStarted) {}

        fn output(&self, event: &ProcessOutput) {
            self.lines
                .lock()
                .unwrap()
                .push((event.stream, event.text.clone()));
        }

        fn finished(&self, _event: &ProcessFinished) {}
    }

    fn runner(sink: &Arc<RecordingSink>) -> Arc<Runner> {
        Arc::new(Runner::new(
            Arc::new(SystemLauncher),
            Arc::clone(sink) as Arc<dyn EventSink>,
        ))
    }

    #[test]
    fn run_check_collects_sorted_statuses_and_summarizes() {
        let (_a, zeta) = repo_with_origin("zeta", Some("https://github.com/me/zeta"));
        let (_b, alpha) = repo_with_origin("Alpha", Some("https://github.com/me/Alpha"));
        let (_c, old) = repo_with_origin("old", Some("https://github.com/me/old"));
        let looker = fake(&[
            (
                "me/zeta",
                Lookup::Found {
                    archived: false,
                    full_name: "me/zeta".to_string(),
                },
            ),
            (
                "me/Alpha",
                Lookup::Found {
                    archived: false,
                    full_name: "me/Alpha".to_string(),
                },
            ),
            (
                "me/old",
                Lookup::Found {
                    archived: true,
                    full_name: "me/old".to_string(),
                },
            ),
        ]);
        let sink = Arc::new(RecordingSink::default());

        let summary = run_check(&runner(&sink), &[zeta, alpha, old], None, &looker).expect("run");

        let names: Vec<_> = summary.statuses.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(
            names,
            ["Alpha", "old", "zeta"],
            "名前の昇順（大文字小文字を区別しない）"
        );
        assert_eq!(summary.total, 3);
        assert!(!summary.cancelled);
        let lines = sink.lines.lock().unwrap();
        assert!(
            lines
                .iter()
                .any(|(_, l)| l.contains("⚠ old: アーカイブ済み")),
            "{lines:?}"
        );
        assert!(
            lines.iter().any(|(_, l)| l.contains(
                "完了: アーカイブ済み 1 / 見つからない 0 / 移転 0 / 確認に失敗 0（全 3 件）"
            )),
            "{lines:?}"
        );
    }

    #[test]
    fn run_check_with_no_repositories_and_a_root_error() {
        let sink = Arc::new(RecordingSink::default());

        let summary = run_check(
            &runner(&sink),
            &[],
            Some("root を読み取れません"),
            &fake(&[]),
        )
        .expect("run");

        assert_eq!((summary.total, summary.statuses.len()), (0, 0));
        let lines = sink.lines.lock().unwrap();
        assert_eq!(
            lines[0],
            (Stream::Stderr, "root を読み取れません".to_string())
        );
        assert!(lines
            .iter()
            .any(|(_, l)| l.contains("確認の対象のリポジトリがありません")));
    }

    #[test]
    fn run_check_fails_the_job_only_when_a_check_itself_failed() {
        let (_a, flaky) = repo_with_origin("flaky", Some("https://github.com/me/flaky"));
        let (_b, gone) = repo_with_origin("gone", Some("https://github.com/me/gone"));
        let looker = fake(&[("me/flaky", Lookup::Failed("rate limit".to_string()))]);
        let sink = Arc::new(RecordingSink::default());

        let summary = run_check(&runner(&sink), &[flaky, gone], None, &looker).expect("run");

        // 失敗（確認できなかった）と、結果（見つからない）は、別。両方とも一覧に残る。
        assert_eq!(summary.statuses.len(), 2);
        let lines = sink.lines.lock().unwrap();
        assert!(
            lines
                .iter()
                .any(|(s, l)| *s == Stream::Stderr && l.contains("✗ flaky: rate limit")),
            "{lines:?}"
        );
        assert!(
            lines
                .iter()
                .any(|(_, l)| l.contains("見つからない 1 / 移転 0 / 確認に失敗 1")),
            "{lines:?}"
        );
    }

    #[test]
    fn check_all_remotes_checks_the_managed_repositories() {
        // gh は実際には呼ばれない: origin が無いリポジトリは、問い合わせずに「対象外」になる。
        let (dir, _repo) = repo_with_origin("managed", None);
        let root = TempDir::new("workspace-root");
        let target = root.path.join("managed");
        std::fs::create_dir_all(&target).unwrap();
        Repository::init(&target).unwrap();
        drop(dir);
        let mut config = AppConfig::default();
        config.workspace.root = Some(root.path_str());
        let sink = Arc::new(RecordingSink::default());
        let state = RunnerState::with_runner(runner(&sink));

        let summary =
            tauri::async_runtime::block_on(check_all_remotes(&state, &config)).expect("check");

        assert_eq!(summary.total, 1);
        assert_eq!(summary.statuses[0].state, RemoteState::Unsupported);
    }
}
