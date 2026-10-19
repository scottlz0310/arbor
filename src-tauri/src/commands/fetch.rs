//! 管理対象リポジトリの一括 fetch。
//!
//! git2 で直接 fetch し、進捗を runner の job として `process_*` イベントでコンソールへ流す。
//! dsx の `repo update` と同じ枠を使うため、同時に走るのは 1 件だけで、`cancel_run` で中断できる。

use super::runner::{JobContext, Runner, RunnerState, Stream};
use crate::config::AppConfig;
use crate::models::{FetchFailure, FetchSummary};
use crate::workspace::{effective_repos, EffectiveRepo};
use git2::Repository;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, PoisonError};

/// 同時に fetch するリポジトリ数の上限。dsx の `repo update --jobs 4` と合わせる。
const MAX_FETCH_JOBS: usize = 4;

/// リポジトリ 1 件を fetch する関数が満たす形。`is_cancelled` が true を返したら転送を打ち切る。
/// 成功時は、オブジェクトを受信した remote 名を返す。
/// 呼び出し元から差し替えられるよう trait で受ける（テストではネットワークに出ないフェイクを渡す）。
trait Fetcher: Fn(&str, &(dyn Fn() -> bool + Sync)) -> Result<Vec<String>, String> + Sync {}

impl<F> Fetcher for F where
    F: Fn(&str, &(dyn Fn() -> bool + Sync)) -> Result<Vec<String>, String> + Sync
{
}

/// 認証情報の要求に応える回数の上限。誤った認証情報を返され続けても、fetch が終わらなくならないようにする。
const MAX_CREDENTIAL_ATTEMPTS: u8 = 3;

/// 認証情報の取得元。
#[derive(Debug, PartialEq, Eq)]
enum CredentialSource {
    /// remote が URL にユーザー名を含まないときの、ユーザー名だけの応答。
    Username,
    /// git の認証情報ヘルパー（HTTPS）。
    Helper,
    /// ssh-agent（SSH）。
    SshAgent,
    /// OS の既定の認証（NTLM など）。
    Default,
}

/// remote が受け付ける認証方式から、使う取得元を選ぶ。受け付ける方式が無ければ None。
fn credential_source(allowed: git2::CredentialType) -> Option<CredentialSource> {
    use git2::CredentialType as T;
    if allowed.contains(T::USERNAME) {
        Some(CredentialSource::Username)
    } else if allowed.contains(T::USER_PASS_PLAINTEXT) {
        Some(CredentialSource::Helper)
    } else if allowed.contains(T::SSH_KEY) {
        Some(CredentialSource::SshAgent)
    } else if allowed.contains(T::DEFAULT) {
        Some(CredentialSource::Default)
    } else {
        None
    }
}

/// remote の認証情報の要求に答えるコールバック。git2 は、これを設定しないと認証情報ヘルパーも
/// ssh-agent も使わない（認証が要る remote は 401 などで失敗する）。
fn credentials_callback(
    config: git2::Config,
) -> impl FnMut(&str, Option<&str>, git2::CredentialType) -> Result<git2::Cred, git2::Error> {
    let mut attempts = 0u8;
    move |url, username, allowed| {
        attempts += 1;
        if attempts > MAX_CREDENTIAL_ATTEMPTS {
            return Err(git2::Error::from_str(
                "認証に失敗しました（認証情報ヘルパーまたは ssh-agent の認証情報を確認してください）",
            ));
        }
        match credential_source(allowed) {
            Some(CredentialSource::Username) => git2::Cred::username(username.unwrap_or("git")),
            Some(CredentialSource::Helper) => git2::Cred::credential_helper(&config, url, username),
            Some(CredentialSource::SshAgent) => {
                git2::Cred::ssh_key_from_agent(username.unwrap_or("git"))
            }
            Some(CredentialSource::Default) => git2::Cred::default(),
            None => Err(git2::Error::from_str(
                "対応していない認証方式です（HTTPS の認証情報ヘルパーか SSH を使ってください）",
            )),
        }
    }
}

/// 全 remote を fetch する。認証は、git の認証情報ヘルパー（HTTPS）と ssh-agent（SSH）を使う。
pub fn fetch_repository(
    path: &str,
    is_cancelled: &(dyn Fn() -> bool + Sync),
) -> Result<Vec<String>, String> {
    let repo = Repository::open(path).map_err(|e| e.to_string())?;
    let mut config = repo.config().map_err(|e| e.to_string())?;
    let remotes = repo.remotes().map_err(|e| e.to_string())?;
    let mut updated = Vec::new();

    for name in remotes.iter() {
        let Some(name) = name.map_err(|e| e.to_string())? else {
            continue;
        };
        let mut remote = repo.find_remote(name).map_err(|e| e.to_string())?;

        let mut callbacks = git2::RemoteCallbacks::new();
        callbacks.credentials(credentials_callback(
            config.snapshot().map_err(|e| e.to_string())?,
        ));
        callbacks.transfer_progress(|_| !is_cancelled());
        let mut options = git2::FetchOptions::new();
        options.download_tags(git2::AutotagOption::Unspecified);
        options.remote_callbacks(callbacks);

        remote
            .fetch(&[] as &[&str], Some(&mut options), None)
            .map_err(|e| format!("fetch {name}: {e}"))?;

        if remote.stats().received_objects() > 0 {
            updated.push(name.to_string());
        }
    }

    Ok(updated)
}

#[derive(Default)]
struct Tally {
    succeeded: usize,
    failed: Vec<FetchFailure>,
}

/// job の本体。リポジトリを `MAX_FETCH_JOBS` 並列で fetch し、1 件ごとに結果を 1 行で出す。
/// 返す終了コードは、失敗が無ければ 0、あれば 1。
fn fetch_workspace(
    ctx: &JobContext,
    repos: &[EffectiveRepo],
    root_error: Option<&str>,
    fetcher: &impl Fetcher,
) -> (i32, Tally) {
    let total = repos.len();
    if let Some(error) = root_error {
        ctx.log(Stream::Stderr, error);
    }
    if total == 0 {
        ctx.log(Stream::Stdout, "fetch 対象のリポジトリがありません");
        return (0, Tally::default());
    }

    let workers = total.min(MAX_FETCH_JOBS);
    ctx.log(
        Stream::Stdout,
        format!("{total} 件のリポジトリを fetch します（並列 {workers}）"),
    );

    let tally = Mutex::new(Tally::default());
    let next = AtomicUsize::new(0);
    let done = AtomicUsize::new(0);

    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                if ctx.is_cancelled() {
                    break;
                }
                let Some(repo) = repos.get(next.fetch_add(1, Ordering::Relaxed)) else {
                    break;
                };
                let result = fetcher(&repo.path, &|| ctx.is_cancelled());
                // キャンセルで打ち切られた fetch は、失敗として数えない。
                if result.is_err() && ctx.is_cancelled() {
                    continue;
                }

                let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                let mut tally = tally.lock().unwrap_or_else(PoisonError::into_inner);
                match result {
                    Ok(updated) => {
                        let detail = if updated.is_empty() {
                            "更新なし".to_string()
                        } else {
                            format!("更新: {}", updated.join(", "))
                        };
                        ctx.log(
                            Stream::Stdout,
                            format!("[{n}/{total}] ✓ {} ({detail})", repo.name),
                        );
                        tally.succeeded += 1;
                    }
                    Err(error) => {
                        ctx.log(
                            Stream::Stderr,
                            format!("[{n}/{total}] ✗ {}: {error}", repo.name),
                        );
                        tally.failed.push(FetchFailure {
                            path: repo.path.clone(),
                            name: repo.name.clone(),
                            error,
                        });
                    }
                }
            });
        }
    });

    let mut tally = tally.into_inner().unwrap_or_else(PoisonError::into_inner);
    tally.failed.sort_by(|a, b| a.name.cmp(&b.name));
    let processed = done.load(Ordering::Relaxed);
    if ctx.is_cancelled() {
        ctx.log(
            Stream::Stdout,
            format!("中断しました（{processed}/{total} 件を処理済み）"),
        );
    } else {
        ctx.log(
            Stream::Stdout,
            format!(
                "完了: 成功 {} / 失敗 {}（全 {total} 件）",
                tally.succeeded,
                tally.failed.len()
            ),
        );
    }
    (i32::from(!tally.failed.is_empty()), tally)
}

/// runner の枠を取って `fetch_workspace` を実行する。別のコマンドが実行中ならエラー。
fn run_fetch(
    runner: &Runner,
    repos: &[EffectiveRepo],
    root_error: Option<&str>,
    fetcher: &impl Fetcher,
) -> Result<FetchSummary, String> {
    let outcome = runner.run_job("fetch all repositories", |ctx| {
        fetch_workspace(ctx, repos, root_error, fetcher)
    })?;
    Ok(FetchSummary {
        total: repos.len(),
        succeeded: outcome.value.succeeded,
        failed: outcome.value.failed,
        cancelled: outcome.cancelled,
    })
}

/// 管理対象（workspace root 配下の自動検出 + 手動登録）の全リポジトリを fetch する。
/// 進捗は `process_*` イベントで流れ、`cancel_run` で中断できる。
pub async fn fetch_all_repositories(
    state: &RunnerState,
    config: &AppConfig,
) -> Result<FetchSummary, String> {
    let (repos, root_error) = effective_repos(config);
    let runner = state.runner();
    tauri::async_runtime::spawn_blocking(move || {
        run_fetch(&runner, &repos, root_error.as_deref(), &fetch_repository)
    })
    .await
    .map_err(|e| format!("fetch の実行スレッドが異常終了しました: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::runner::{
        EventSink, ProcessFinished, ProcessOutput, ProcessStarted, SystemLauncher,
    };
    use crate::models::RepoSource;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::AtomicU64;
    use std::sync::Arc;
    use std::time::Duration;

    // ── フェイク ──────────────────────────────────────────────────────────────

    #[derive(Default)]
    struct RecordingSink {
        started: Mutex<Vec<ProcessStarted>>,
        lines: Mutex<Vec<(Stream, String)>>,
        finished: Mutex<Vec<ProcessFinished>>,
    }

    impl RecordingSink {
        fn lines(&self, stream: Stream) -> Vec<String> {
            self.lines
                .lock()
                .unwrap()
                .iter()
                .filter(|(s, _)| *s == stream)
                .map(|(_, text)| text.clone())
                .collect()
        }
    }

    impl EventSink for RecordingSink {
        fn started(&self, event: &ProcessStarted) {
            self.started.lock().unwrap().push(event.clone());
        }

        fn output(&self, event: &ProcessOutput) {
            self.lines
                .lock()
                .unwrap()
                .push((event.stream, event.text.clone()));
        }

        fn finished(&self, event: &ProcessFinished) {
            self.finished.lock().unwrap().push(event.clone());
        }
    }

    fn runner(sink: &Arc<RecordingSink>) -> Arc<Runner> {
        Arc::new(Runner::new(
            Arc::new(SystemLauncher),
            Arc::clone(sink) as Arc<dyn EventSink>,
        ))
    }

    fn repo(name: &str) -> EffectiveRepo {
        EffectiveRepo {
            path: format!("/repos/{name}"),
            name: name.to_string(),
            protected_branches: Vec::new(),
            source: RepoSource::Workspace,
        }
    }

    fn repos(names: &[&str]) -> Vec<EffectiveRepo> {
        names.iter().map(|n| repo(n)).collect()
    }

    fn wait_until(mut condition: impl FnMut() -> bool) {
        for _ in 0..500 {
            if condition() {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("condition was not met within 5s");
    }

    // ── fetch_workspace / run_fetch ────────────────────────────────────────────

    #[test]
    fn fetch_workspace_reports_each_repository_and_the_totals() {
        let sink = Arc::new(RecordingSink::default());
        let fetcher = |path: &str, _: &(dyn Fn() -> bool + Sync)| match path {
            "/repos/alpha" => Ok(vec!["origin".to_string()]),
            "/repos/beta" => Ok(Vec::new()),
            _ => Err("fetch origin: network is unreachable".to_string()),
        };

        let summary = run_fetch(
            &runner(&sink),
            &repos(&["alpha", "beta", "gamma"]),
            None,
            &fetcher,
        )
        .unwrap();

        assert_eq!(summary.total, 3);
        assert_eq!(summary.succeeded, 2);
        assert!(!summary.cancelled);
        assert_eq!(summary.failed.len(), 1);
        assert_eq!(summary.failed[0].name, "gamma");
        assert_eq!(summary.failed[0].path, "/repos/gamma");
        assert_eq!(
            summary.failed[0].error,
            "fetch origin: network is unreachable"
        );

        let stdout = sink.lines(Stream::Stdout);
        assert_eq!(stdout[0], "3 件のリポジトリを fetch します（並列 3）");
        assert!(stdout.iter().any(|l| l.ends_with("✓ alpha (更新: origin)")));
        assert!(stdout.iter().any(|l| l.ends_with("✓ beta (更新なし)")));
        assert_eq!(stdout.last().unwrap(), "完了: 成功 2 / 失敗 1（全 3 件）");
        let stderr = sink.lines(Stream::Stderr);
        assert_eq!(stderr.len(), 1);
        assert!(stderr[0].ends_with("✗ gamma: fetch origin: network is unreachable"));

        // 失敗があれば終了コード 1。
        assert_eq!(sink.finished.lock().unwrap()[0].exit_code, Some(1));
    }

    #[test]
    fn fetch_workspace_numbers_each_result_once() {
        let sink = Arc::new(RecordingSink::default());
        let fetcher = |_: &str, _: &(dyn Fn() -> bool + Sync)| Ok(Vec::new());

        run_fetch(
            &runner(&sink),
            &repos(&["a", "b", "c", "d", "e", "f"]),
            None,
            &fetcher,
        )
        .unwrap();

        let mut numbers: Vec<String> = sink
            .lines(Stream::Stdout)
            .iter()
            .filter_map(|l| l.split_once(' ').map(|(head, _)| head.to_string()))
            .filter(|head| head.starts_with('['))
            .collect();
        numbers.sort();
        assert_eq!(
            numbers,
            ["[1/6]", "[2/6]", "[3/6]", "[4/6]", "[5/6]", "[6/6]"]
        );
    }

    #[test]
    fn fetch_workspace_exits_zero_when_nothing_failed() {
        let sink = Arc::new(RecordingSink::default());
        let fetcher = |_: &str, _: &(dyn Fn() -> bool + Sync)| Ok(Vec::new());

        let summary = run_fetch(&runner(&sink), &repos(&["a"]), None, &fetcher).unwrap();

        assert!(summary.failed.is_empty());
        assert_eq!(sink.finished.lock().unwrap()[0].exit_code, Some(0));
    }

    #[test]
    fn fetch_workspace_cases_without_repositories() {
        let cases = [
            ("root を読めた", None, 0),
            (
                "root を読めなかった",
                Some("workspace root を読み取れません (/x): denied"),
                1,
            ),
        ];

        for (name, root_error, stderr_lines) in cases {
            let sink = Arc::new(RecordingSink::default());
            let fetcher = |_: &str, _: &(dyn Fn() -> bool + Sync)| -> Result<Vec<String>, String> {
                panic!("fetch must not run")
            };

            let summary = run_fetch(&runner(&sink), &[], root_error, &fetcher).unwrap();

            assert_eq!(summary.total, 0, "{name}");
            assert_eq!(
                sink.lines(Stream::Stdout),
                ["fetch 対象のリポジトリがありません"],
                "{name}"
            );
            assert_eq!(sink.lines(Stream::Stderr).len(), stderr_lines, "{name}");
        }
    }

    #[test]
    fn fetch_workspace_limits_concurrency() {
        let sink = Arc::new(RecordingSink::default());
        let running = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let fetcher = |_: &str, _: &(dyn Fn() -> bool + Sync)| {
            let now = running.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(now, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(20));
            running.fetch_sub(1, Ordering::SeqCst);
            Ok(Vec::new())
        };

        run_fetch(
            &runner(&sink),
            &repos(&["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]),
            None,
            &fetcher,
        )
        .unwrap();

        let peak = peak.load(Ordering::SeqCst);
        assert!(
            (2..=MAX_FETCH_JOBS).contains(&peak),
            "並列数は 2〜{MAX_FETCH_JOBS}: {peak}"
        );
    }

    #[test]
    fn cancel_interrupts_running_fetches_and_skips_the_rest() {
        let sink = Arc::new(RecordingSink::default());
        let runner = runner(&sink);
        let calls = AtomicU64::new(0);
        // キャンセルされるまで終わらない fetch。中断されたら、転送の打ち切りと同じくエラーを返す。
        let fetcher = |_: &str, is_cancelled: &(dyn Fn() -> bool + Sync)| {
            calls.fetch_add(1, Ordering::SeqCst);
            while !is_cancelled() {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err("fetch origin: callback returned error".to_string())
        };
        let names: Vec<String> = (0..8).map(|i| format!("repo{i}")).collect();
        let targets = repos(&names.iter().map(String::as_str).collect::<Vec<_>>());

        let summary = std::thread::scope(|scope| {
            let handle = scope.spawn(|| run_fetch(&runner, &targets, None, &fetcher));
            wait_until(|| calls.load(Ordering::SeqCst) == MAX_FETCH_JOBS as u64);
            let run_id = sink.started.lock().unwrap()[0].run_id;
            runner.cancel(run_id).unwrap();
            handle.join().unwrap().unwrap()
        });

        assert!(summary.cancelled);
        assert_eq!(summary.total, 8);
        assert_eq!(summary.succeeded, 0);
        assert!(summary.failed.is_empty(), "中断された fetch は失敗にしない");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            MAX_FETCH_JOBS as u64,
            "キャンセル後は新しい fetch を始めない"
        );
        assert_eq!(
            sink.lines(Stream::Stdout).last().unwrap(),
            "中断しました（0/8 件を処理済み）"
        );
        assert!(sink.finished.lock().unwrap()[0].cancelled);
    }

    #[test]
    fn run_fetch_is_rejected_while_another_command_is_running() {
        let sink = Arc::new(RecordingSink::default());
        let runner = runner(&sink);
        let (inside_tx, inside_rx) = std::sync::mpsc::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let holder = {
            let runner = Arc::clone(&runner);
            std::thread::spawn(move || {
                runner.run_job("other", |_| {
                    inside_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    (0, ())
                })
            })
        };
        inside_rx.recv().unwrap();
        let fetcher = |_: &str, _: &(dyn Fn() -> bool + Sync)| Ok(Vec::new());

        let err = run_fetch(&runner, &repos(&["a"]), None, &fetcher).unwrap_err();

        assert!(err.contains("別のコマンドを実行中"), "{err}");
        release_tx.send(()).unwrap();
        holder.join().unwrap().unwrap();
    }

    // ── fetch_repository（実際の git2）─────────────────────────────────────────

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(prefix: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "arbor-{prefix}-{}",
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

    fn commit_file(repo: &git2::Repository, name: &str) {
        let workdir = repo.workdir().expect("workdir").to_path_buf();
        std::fs::write(workdir.join(name), "x\n").expect("write file");
        let mut index = repo.index().expect("index");
        index.add_path(Path::new(name)).expect("add path");
        index.write().expect("write index");
        let tree = repo
            .find_tree(index.write_tree().expect("write tree"))
            .expect("find tree");
        let signature =
            git2::Signature::now("Arbor Test", "arbor@example.invalid").expect("signature");
        let parent = repo.head().ok().and_then(|head| head.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        repo.commit(Some("HEAD"), &signature, &signature, name, &tree, &parents)
            .expect("commit");
    }

    /// コミットが 1 つある `source` と、それを origin とする空の `target`。
    fn source_and_target() -> (TempDir, git2::Repository, TempDir) {
        let source = TempDir::new("fetch-source");
        let mut options = git2::RepositoryInitOptions::new();
        options.initial_head("main");
        let source_repo = git2::Repository::init_opts(&source.path, &options).expect("init source");
        commit_file(&source_repo, "one.txt");

        let target = TempDir::new("fetch-target");
        let target_repo = git2::Repository::init_opts(&target.path, &options).expect("init target");
        target_repo
            .remote("origin", &source.path_str())
            .expect("add origin");
        drop(target_repo);
        (source, source_repo, target)
    }

    #[test]
    fn fetch_repository_reports_remotes_that_received_objects() {
        let (_source, source_repo, target) = source_and_target();

        let first = fetch_repository(&target.path_str(), &|| false).expect("first fetch");
        assert_eq!(first, ["origin"]);

        // 新しいコミットが無ければ、受信するオブジェクトも無い。
        let second = fetch_repository(&target.path_str(), &|| false).expect("second fetch");
        assert!(second.is_empty(), "{second:?}");

        commit_file(&source_repo, "two.txt");
        let third = fetch_repository(&target.path_str(), &|| false).expect("third fetch");
        assert_eq!(third, ["origin"]);
    }

    #[test]
    fn fetch_repository_reports_unopenable_paths() {
        let dir = TempDir::new("not-a-repo");
        assert!(fetch_repository(&dir.path_str(), &|| false).is_err());
    }

    #[test]
    fn fetch_repository_stops_the_transfer_when_cancelled() {
        let (_source, _source_repo, target) = source_and_target();

        let result = fetch_repository(&target.path_str(), &|| true);

        assert!(result.is_err(), "転送を打ち切ってエラーにする: {result:?}");
    }

    // ── 認証情報の取得元 ─────────────────────────────────────────────────────────

    #[test]
    fn credential_source_follows_the_methods_the_remote_accepts() {
        use git2::CredentialType as T;
        let cases = [
            (
                "ユーザー名の要求",
                T::USERNAME,
                Some(CredentialSource::Username),
            ),
            (
                "HTTPS",
                T::USER_PASS_PLAINTEXT,
                Some(CredentialSource::Helper),
            ),
            ("SSH", T::SSH_KEY, Some(CredentialSource::SshAgent)),
            ("OS の既定", T::DEFAULT, Some(CredentialSource::Default)),
            // 複数を受け付けるなら、ユーザー名 → HTTPS → SSH → 既定の順に選ぶ。
            (
                "SSH と既定",
                T::SSH_KEY | T::DEFAULT,
                Some(CredentialSource::SshAgent),
            ),
            (
                "HTTPS と SSH",
                T::USER_PASS_PLAINTEXT | T::SSH_KEY,
                Some(CredentialSource::Helper),
            ),
            ("対応外（SSH 鍵ファイルのみ）", T::SSH_MEMORY, None),
        ];
        for (name, allowed, expected) in cases {
            assert_eq!(credential_source(allowed), expected, "{name}");
        }
    }

    #[test]
    fn credentials_callback_answers_the_username_request() {
        let mut callback = credentials_callback(git2::Config::new().expect("config"));

        let cred = callback(
            "ssh://example.invalid/r.git",
            None,
            git2::CredentialType::USERNAME,
        )
        .expect("username");

        assert!(cred.has_username());
    }

    #[test]
    fn credentials_callback_gives_up_after_the_attempt_limit() {
        let mut callback = credentials_callback(git2::Config::new().expect("config"));
        let mut ask = || {
            callback(
                "https://example.invalid/r.git",
                None,
                git2::CredentialType::DEFAULT,
            )
        };

        for attempt in 1..=MAX_CREDENTIAL_ATTEMPTS {
            assert!(ask().is_ok(), "{attempt} 回目は応える");
        }
        let error = ask().err().expect("上限を超えたら応えない");

        assert!(error.message().contains("認証に失敗しました"), "{error}");
    }

    #[test]
    fn credentials_callback_rejects_unsupported_methods() {
        let mut callback = credentials_callback(git2::Config::new().expect("config"));

        let error = callback(
            "https://example.invalid/r.git",
            None,
            git2::CredentialType::SSH_MEMORY,
        )
        .err()
        .expect("unsupported");

        assert!(
            error.message().contains("対応していない認証方式"),
            "{error}"
        );
    }

    // ── fetch_all_repositories（設定を受ける入口）──────────────────────────────

    #[test]
    fn fetch_all_repositories_fetches_the_managed_repositories_and_summarizes() {
        let (_source, _source_repo, target) = source_and_target();
        let mut config = AppConfig::default();
        config.workspace.root = Some(target.path_str());
        let sink = Arc::new(RecordingSink::default());
        let state = RunnerState::with_runner(runner(&sink));

        let summary =
            tauri::async_runtime::block_on(fetch_all_repositories(&state, &config)).expect("fetch");

        assert_eq!(summary.total, 1);
        assert_eq!(summary.succeeded, 1);
        assert!(summary.failed.is_empty());
        assert!(!summary.cancelled);
    }

    #[test]
    fn fetch_all_repositories_reports_a_root_that_cannot_be_read() {
        let missing = TempDir::new("fetch-missing-root").path.join("gone");
        let mut config = AppConfig::default();
        config.workspace.root = Some(missing.to_string_lossy().into_owned());
        let sink = Arc::new(RecordingSink::default());
        let state = RunnerState::with_runner(runner(&sink));

        let summary =
            tauri::async_runtime::block_on(fetch_all_repositories(&state, &config)).expect("fetch");

        assert_eq!(summary.total, 0);
        assert!(sink
            .lines(Stream::Stderr)
            .iter()
            .any(|line| line.contains("workspace root を読み取れません")));
    }
}
