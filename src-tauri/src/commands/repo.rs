use super::fetch::fetch_repository;
use crate::config::AppConfig;
use crate::models::{FetchResult, RepoInfo, RepoSource};
use crate::workspace::{effective_repos, find_managed, EffectiveRepo};
use git2::{Repository, StatusOptions};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

/// 同時に走らせるスキャンの上限。status の取得は I/O 主体で、リポジトリが多いほど逐次だと遅い。
const MAX_SCAN_THREADS: usize = 8;

// ─── apply_effective ─────────────────────────────────────────────────────────

/// Overlays the display `name` and `source` from the resolved repository list onto a live
/// `RepoInfo`. Used by both `list_repositories` and `get_repo_status` so the two
/// code paths cannot drift.
fn apply_effective(info: &mut RepoInfo, repo: &EffectiveRepo) {
    info.name.clone_from(&repo.name);
    info.source = repo.source;
}

// ─── list_repositories ───────────────────────────────────────────────────────

/// Scans one repository. An unreadable repository becomes a degraded entry so the
/// sidebar still shows it.
fn scan_one(repo: &EffectiveRepo) -> RepoInfo {
    match repo_info_for_path(&repo.path) {
        Ok(mut info) => {
            apply_effective(&mut info, repo);
            info
        }
        Err(e) => {
            eprintln!("Warning: could not open repo {}: {e}", repo.path);
            RepoInfo {
                path: repo.path.clone(),
                name: repo.name.clone(),
                current_branch: "unknown".to_string(),
                is_detached: false,
                has_upstream: false,
                source: repo.source,
                ahead: 0,
                behind: 0,
                modified_count: 0,
                untracked_count: 0,
                stash_count: 0,
                last_fetched_at: None,
            }
        }
    }
}

/// Scans repositories in parallel and returns the results in input order.
fn scan_repositories(repos: &[EffectiveRepo]) -> Vec<RepoInfo> {
    let results: Vec<Mutex<Option<RepoInfo>>> = repos.iter().map(|_| Mutex::new(None)).collect();
    let next = AtomicUsize::new(0);
    let workers = repos
        .len()
        .min(MAX_SCAN_THREADS)
        .min(std::thread::available_parallelism().map_or(4, std::num::NonZero::get));

    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                let index = next.fetch_add(1, Ordering::Relaxed);
                let Some(repo) = repos.get(index) else {
                    break;
                };
                let info = scan_one(repo);
                *results[index]
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(info);
            });
        }
    });

    results
        .into_iter()
        .filter_map(|slot| {
            slot.into_inner()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
        })
        .collect()
}

/// Lists every managed repository (workspace root + manual registrations) with its local status.
/// Local only: no network access. Runs on a worker thread so a large workspace does not block the UI.
pub fn list_repos(config: &AppConfig) -> Vec<RepoInfo> {
    let (repos, root_error) = effective_repos(config);
    if let Some(error) = root_error {
        eprintln!("Warning: {error}");
    }
    scan_repositories(&repos)
}

// ─── get_repo_status ─────────────────────────────────────────────────────────

pub fn repo_status(config: &AppConfig, repo_path: &str) -> Result<RepoInfo, String> {
    let mut info = repo_info_for_path(repo_path)?;
    let (repos, _) = effective_repos(config);
    if let Some(repo) = repos.iter().find(|r| r.path == repo_path) {
        apply_effective(&mut info, repo);
    }
    Ok(info)
}

// ─── fetch_all ───────────────────────────────────────────────────────────────

/// Fetches all remotes for the given repository.
/// Authentication uses the git credential helper (HTTPS) and ssh-agent (SSH);
/// there is no credential-entry UI (see `fetch::credentials_callback`).
pub fn fetch_repo(repo_path: &str) -> Result<FetchResult, String> {
    let updated_refs = fetch_repository(repo_path, &|| false)?;
    Ok(FetchResult { updated_refs })
}

// ─── open_repo_folder ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Os {
    Windows,
    Mac,
    Other,
}

impl Os {
    fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Mac
        } else {
            Self::Other
        }
    }
}

/// フォルダをファイルマネージャで開くコマンド。
fn folder_opener(path: &str, os: Os) -> (&'static str, Vec<String>) {
    match os {
        // explorer は、区切りが `/` のパスだと別のフォルダを開くことがある。
        Os::Windows => ("explorer", vec![path.replace('/', "\\")]),
        Os::Mac => ("open", vec![path.to_string()]),
        Os::Other => ("xdg-open", vec![path.to_string()]),
    }
}

/// フォルダを開くコマンドを起動する（プログラム名, 引数）。テストでは差し替える。
type Launch<'a> = &'a dyn Fn(&str, &[String]) -> std::io::Result<()>;

/// 管理対象のリポジトリのフォルダを、`launch` で開く。
/// 渡されたパスは検索にだけ使い、実際に開くのは管理対象として解決した実在のフォルダ（任意のパスは開かない）。
fn open_folder(
    repos: &[EffectiveRepo],
    requested: &str,
    os: Os,
    launch: Launch<'_>,
) -> Result<(), String> {
    let repo = find_managed(repos, requested)
        .ok_or_else(|| format!("管理対象のリポジトリではありません: {requested}"))?;
    if !std::path::Path::new(&repo.path).is_dir() {
        return Err(format!("フォルダが見つかりません: {}", repo.path));
    }

    let (program, args) = folder_opener(&repo.path, os);
    launch(program, &args).map_err(|e| format!("{program} を起動できません: {e}"))
}

fn spawn_detached(program: &str, args: &[String]) -> std::io::Result<()> {
    let mut child = std::process::Command::new(program).args(args).spawn()?;
    // explorer は成功しても終了コード 1 を返すため、結果は見ない。子プロセスの回収だけを行う。
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// 管理対象のリポジトリのフォルダを、OS のファイルマネージャで開く。
pub fn open_managed_folder(config: &AppConfig, repo_path: &str) -> Result<(), String> {
    let (repos, _) = effective_repos(config);
    open_folder(&repos, repo_path, Os::current(), &spawn_detached)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn repo_info_for_path(path: &str) -> Result<RepoInfo, String> {
    let mut repo = Repository::open(path).map_err(|e| e.to_string())?;

    // HEAD がブランチを指していない。未生成（初回コミット前）の HEAD は detached ではない。
    let is_detached = repo.head_detached().unwrap_or(false);

    // Current branch name.
    let current_branch = if is_detached {
        "HEAD (detached)".to_string()
    } else {
        repo.head()
            .ok()
            .and_then(|h| h.shorthand().ok().map(|s| s.to_string()))
            .unwrap_or_else(|| "HEAD (detached)".to_string())
    };

    // 現在のブランチに upstream があるか。無いと ahead / behind は常に 0 で、「同期済み」と区別できない。
    let has_upstream = repo
        .head()
        .ok()
        .filter(git2::Reference::is_branch)
        .is_some_and(|head| git2::Branch::wrap(head).upstream().is_ok());

    // Ahead / behind for the current branch vs its upstream.
    let (ahead, behind) = current_ahead_behind(&repo);

    // Modified + untracked counts.
    let (modified_count, untracked_count) = {
        let mut opts = StatusOptions::new();
        opts.include_untracked(true).recurse_untracked_dirs(false);
        let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
        let mut modified = 0u32;
        let mut untracked = 0u32;
        for entry in statuses.iter() {
            let s = entry.status();
            if s.contains(git2::Status::WT_MODIFIED)
                || s.contains(git2::Status::INDEX_MODIFIED)
                || s.contains(git2::Status::WT_DELETED)
                || s.contains(git2::Status::INDEX_DELETED)
            {
                modified += 1;
            }
            if s.contains(git2::Status::WT_NEW) {
                untracked += 1;
            }
        }
        (modified, untracked)
    };

    // Stash count.
    let mut stash_count = 0u32;
    let _ = repo.stash_foreach(|_, _, _| {
        stash_count += 1;
        true
    });

    // Derive display name from last path component.
    let name = std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());

    Ok(RepoInfo {
        path: path.to_string(),
        name,
        current_branch,
        is_detached,
        has_upstream,
        source: RepoSource::Manual,
        ahead,
        behind,
        modified_count,
        untracked_count,
        stash_count,
        last_fetched_at: None,
    })
}

/// Returns (ahead, behind) for the current HEAD vs its upstream, or (0, 0).
fn current_ahead_behind(repo: &Repository) -> (u32, u32) {
    (|| -> Option<(u32, u32)> {
        let head = repo.head().ok()?;
        let branch = git2::Branch::wrap(head);
        let (a, b) = upstream_ahead_behind(repo, &branch);
        Some((a, b))
    })()
    .unwrap_or((0, 0))
}

fn upstream_ahead_behind(repo: &Repository, branch: &git2::Branch) -> (u32, u32) {
    (|| -> Option<(u32, u32)> {
        let local_oid = branch.get().peel_to_commit().ok()?.id();
        let upstream = branch.upstream().ok()?;
        let upstream_oid = upstream.get().peel_to_commit().ok()?.id();
        let (a, b) = repo.graph_ahead_behind(local_oid, upstream_oid).ok()?;
        Some((a as u32, b as u32))
    })()
    .unwrap_or((0, 0))
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::{
        apply_effective, fetch_repo, folder_opener, list_repos, open_folder, open_managed_folder,
        repo_info_for_path, repo_status, scan_repositories, spawn_detached, Os,
    };
    use crate::models::{RepoInfo, RepoSource};
    use crate::workspace::EffectiveRepo;
    use std::path::{Path, PathBuf};

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

        fn path_str(&self) -> &str {
            self.path.to_str().expect("temp path should be utf-8")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn init_repo_with_commit(message: &str) -> TempDir {
        let dir = TempDir::new("repo");
        let mut opts = git2::RepositoryInitOptions::new();
        opts.initial_head("main");
        let repo = git2::Repository::init_opts(&dir.path, &opts).expect("init repo");
        std::fs::write(dir.path.join("README.md"), "hello\n").expect("write file");

        let mut index = repo.index().expect("index");
        index.add_path(Path::new("README.md")).expect("add path");
        index.write().expect("write index");
        let tree_id = index.write_tree().expect("write tree");
        let signature =
            git2::Signature::now("Arbor Test", "arbor@example.invalid").expect("test signature");

        {
            let tree = repo.find_tree(tree_id).expect("find tree");
            repo.commit(Some("HEAD"), &signature, &signature, message, &tree, &[])
                .expect("commit");
        }

        drop(repo);
        dir
    }

    // ── apply_effective ───────────────────────────────────────────────────────

    fn stub_info() -> RepoInfo {
        RepoInfo {
            path: "/tmp/repo".to_string(),
            name: "derived-name".to_string(),
            current_branch: "main".to_string(),
            is_detached: false,
            has_upstream: true,
            source: RepoSource::Manual,
            ahead: 0,
            behind: 0,
            modified_count: 0,
            untracked_count: 0,
            stash_count: 0,
            last_fetched_at: None,
        }
    }

    fn effective(path: &str, name: &str, source: RepoSource) -> EffectiveRepo {
        EffectiveRepo {
            path: path.to_string(),
            name: name.to_string(),
            protected_branches: Vec::new(),
            source,
        }
    }

    #[test]
    fn apply_effective_sets_name_and_source() {
        let mut info = stub_info();
        apply_effective(
            &mut info,
            &effective("/tmp/repo", "configured-name", RepoSource::Workspace),
        );
        assert_eq!(info.name, "configured-name");
        assert_eq!(info.source, RepoSource::Workspace);
    }

    #[test]
    fn apply_effective_does_not_touch_git_fields() {
        let mut info = stub_info();
        info.ahead = 3;
        info.behind = 1;
        info.modified_count = 2;
        apply_effective(
            &mut info,
            &effective("/tmp/repo", "x", RepoSource::Workspace),
        );
        assert_eq!(info.ahead, 3);
        assert_eq!(info.behind, 1);
        assert_eq!(info.modified_count, 2);
    }

    // ── detached / upstream ───────────────────────────────────────────────────

    #[test]
    fn repo_info_for_path_flags_branch_without_upstream() {
        let repo = init_repo_with_commit("init");

        let info = repo_info_for_path(repo.path_str()).expect("repo info");

        assert!(!info.is_detached);
        assert!(
            !info.has_upstream,
            "clone ではない repo は upstream を持たない"
        );
        assert_eq!((info.ahead, info.behind), (0, 0));
    }

    #[test]
    fn repo_info_for_path_flags_branch_with_upstream() {
        let source = init_repo_with_commit("origin commit");
        let clone_dir = TempDir::new("clone-upstream");
        git2::Repository::clone(source.path_str(), &clone_dir.path).expect("clone");

        let info = repo_info_for_path(clone_dir.path_str()).expect("repo info");

        assert!(info.has_upstream);
        assert!(!info.is_detached);
    }

    #[test]
    fn repo_info_for_path_flags_detached_head() {
        let dir = init_repo_with_commit("init");
        let repo = git2::Repository::open(dir.path_str()).expect("open");
        let head = repo
            .head()
            .expect("head")
            .peel_to_commit()
            .expect("commit")
            .id();
        repo.set_head_detached(head).expect("detach");
        drop(repo);

        let info = repo_info_for_path(dir.path_str()).expect("repo info");

        assert!(info.is_detached);
        assert_eq!(info.current_branch, "HEAD (detached)");
        assert!(!info.has_upstream);
    }

    // ── scan_repositories ─────────────────────────────────────────────────────

    #[test]
    fn scan_repositories_keeps_input_order_across_threads() {
        let dirs: Vec<TempDir> = (0..12).map(|_| init_repo_with_commit("init")).collect();
        let repos: Vec<EffectiveRepo> = dirs
            .iter()
            .enumerate()
            .map(|(i, d)| effective(d.path_str(), &format!("repo-{i:02}"), RepoSource::Workspace))
            .collect();

        let infos = scan_repositories(&repos);

        let names: Vec<_> = infos.iter().map(|i| i.name.as_str()).collect();
        let expected: Vec<_> = (0..12).map(|i| format!("repo-{i:02}")).collect();
        assert_eq!(names, expected);
        assert!(infos
            .iter()
            .all(|i| i.source == RepoSource::Workspace && i.current_branch == "main"));
    }

    #[test]
    fn scan_repositories_returns_a_degraded_entry_for_an_unreadable_repository() {
        let good = init_repo_with_commit("init");
        let missing = TempDir::new("scan-missing").path.join("gone");
        let repos = vec![
            effective(&missing.to_string_lossy(), "broken", RepoSource::Manual),
            effective(good.path_str(), "good", RepoSource::Workspace),
        ];

        let infos = scan_repositories(&repos);

        assert_eq!(infos.len(), 2);
        assert_eq!(
            (infos[0].name.as_str(), infos[0].current_branch.as_str()),
            ("broken", "unknown")
        );
        assert_eq!(infos[0].source, RepoSource::Manual);
        assert_eq!(infos[1].current_branch, "main");
    }

    #[test]
    fn scan_repositories_handles_an_empty_list() {
        assert!(scan_repositories(&[]).is_empty());
    }

    #[test]
    fn repo_info_for_path_reads_current_branch() {
        let repo = init_repo_with_commit("initial commit");

        let info = repo_info_for_path(repo.path_str()).expect("repo info");

        assert_eq!(info.current_branch, "main");
    }

    #[test]
    fn repo_info_for_path_modified_count() {
        let dir = init_repo_with_commit("init");
        // 追跡済みファイルを変更する
        std::fs::write(dir.path.join("README.md"), "modified content\n").expect("write");

        let info = repo_info_for_path(dir.path_str()).expect("repo info");

        assert_eq!(
            info.modified_count, 1,
            "modified_count should be 1 after editing a tracked file"
        );
        assert_eq!(info.untracked_count, 0);
    }

    #[test]
    fn repo_info_for_path_untracked_count() {
        let dir = init_repo_with_commit("init");
        // 追跡されていない新規ファイルを作成する
        std::fs::write(dir.path.join("new_file.txt"), "new\n").expect("write");

        let info = repo_info_for_path(dir.path_str()).expect("repo info");

        assert_eq!(
            info.untracked_count, 1,
            "untracked_count should be 1 for a new untracked file"
        );
        assert_eq!(info.modified_count, 0);
    }

    #[test]
    fn repo_info_for_path_deleted_file_counts_as_modified() {
        let dir = init_repo_with_commit("init");
        // 追跡済みファイルを削除する (WT_DELETED は modified 扱い)
        std::fs::remove_file(dir.path.join("README.md")).expect("remove");

        let info = repo_info_for_path(dir.path_str()).expect("repo info");

        assert_eq!(
            info.modified_count, 1,
            "deleted tracked file should count as modified"
        );
    }

    #[test]
    fn repo_info_for_path_stash_count() {
        let dir = init_repo_with_commit("init");
        let mut repo = git2::Repository::open(dir.path_str()).expect("open");
        create_stash(&mut repo, "stashed work");
        drop(repo);

        let info = repo_info_for_path(dir.path_str()).expect("repo info");

        assert_eq!(
            info.stash_count, 1,
            "stash_count should reflect the number of stash entries"
        );
        assert_eq!(
            info.modified_count, 0,
            "working tree should be clean after stash"
        );
    }

    #[test]
    fn repo_info_for_path_multiple_stashes() {
        let dir = init_repo_with_commit("init");
        let mut repo = git2::Repository::open(dir.path_str()).expect("open");
        create_stash(&mut repo, "stash 1");
        // stash_save を再び呼ぶため working tree を再度汚す
        let path = repo.workdir().expect("workdir").join("README.md");
        std::fs::write(&path, "second change\n").expect("write");
        let sig = git2::Signature::now("Arbor Test", "arbor@example.invalid").expect("sig");
        repo.stash_save(&sig, "stash 2", None).expect("stash 2");
        drop(repo);

        let info = repo_info_for_path(dir.path_str()).expect("repo info");

        assert_eq!(info.stash_count, 2);
    }

    #[test]
    fn repo_info_for_path_ahead_count() {
        // ローカルの「リモート」リポジトリを作成し、クローン後にローカルコミットを追加する
        let source = init_repo_with_commit("origin commit");
        let clone_dir = TempDir::new("clone-ahead");
        let clone = git2::Repository::clone(source.path_str(), &clone_dir.path).expect("clone");

        // クローン先でファイルを変更してコミットする
        let readme = clone_dir.path.join("README.md");
        std::fs::write(&readme, "local change\n").expect("write");
        {
            let sig = git2::Signature::now("Arbor Test", "arbor@example.invalid").expect("sig");
            let mut index = clone.index().expect("index");
            index
                .add_path(std::path::Path::new("README.md"))
                .expect("add");
            index.write().expect("write index");
            let tree_id = index.write_tree().expect("write tree");
            let tree = clone.find_tree(tree_id).expect("find tree");
            let parent = clone
                .head()
                .expect("head")
                .peel_to_commit()
                .expect("commit");
            clone
                .commit(Some("HEAD"), &sig, &sig, "local only", &tree, &[&parent])
                .expect("commit");
        }
        drop(clone);

        let info = repo_info_for_path(clone_dir.path_str()).expect("repo info");

        assert_eq!(info.ahead, 1, "should be 1 commit ahead of origin/main");
        assert_eq!(info.behind, 0);
    }

    #[test]
    fn repo_info_for_path_behind_count() {
        // ローカルの「リモート」リポジトリを作成してクローンし、
        // クローン元にコミットを追加後 fetch してから behind を確認する
        use git2::Repository as Repo;

        let source = init_repo_with_commit("origin commit");
        let clone_dir = TempDir::new("clone-behind");
        git2::Repository::clone(source.path_str(), &clone_dir.path).expect("clone");

        // クローン元に追加コミットを作成する
        {
            let source_repo = Repo::open(source.path_str()).expect("open source");
            std::fs::write(source.path.join("README.md"), "upstream change\n").expect("write");
            let sig = git2::Signature::now("Arbor Test", "arbor@example.invalid").expect("sig");
            let mut idx = source_repo.index().expect("index");
            idx.add_path(std::path::Path::new("README.md"))
                .expect("add");
            idx.write().expect("write idx");
            let tree_id = idx.write_tree().expect("write tree");
            let tree = source_repo.find_tree(tree_id).expect("tree");
            let parent = source_repo
                .head()
                .expect("head")
                .peel_to_commit()
                .expect("commit");
            source_repo
                .commit(Some("HEAD"), &sig, &sig, "upstream only", &tree, &[&parent])
                .expect("commit");
        }

        // clone 側で fetch して origin/main を更新する
        let clone_repo = Repo::open(clone_dir.path_str()).expect("open clone");
        clone_repo
            .find_remote("origin")
            .expect("remote")
            .fetch(&["main"], None, None)
            .expect("fetch");
        drop(clone_repo);

        let info = repo_info_for_path(clone_dir.path_str()).expect("repo info");

        assert_eq!(info.behind, 1, "should be 1 commit behind origin/main");
        assert_eq!(info.ahead, 0);
    }

    #[test]
    fn fetch_all_handles_named_local_remote() {
        let source = init_repo_with_commit("remote source");
        let target = TempDir::new("fetch-target");
        let mut opts = git2::RepositoryInitOptions::new();
        opts.initial_head("main");
        let repo = git2::Repository::init_opts(&target.path, &opts).expect("init target");
        repo.remote("origin", source.path_str())
            .expect("add origin");
        drop(repo);

        let result = fetch_repo(target.path_str()).expect("fetch all");

        assert!(result.updated_refs.iter().all(|name| name == "origin"));
    }

    // ── stash helpers ─────────────────────────────────────────────────────────

    fn create_stash(repo: &mut git2::Repository, message: &str) -> git2::Oid {
        // Modify a tracked file so there is something to stash.
        let path = repo.workdir().expect("workdir").join("README.md");
        std::fs::write(&path, format!("stash content: {message}\n")).expect("write");
        let sig = git2::Signature::now("Arbor Test", "arbor@example.invalid").expect("signature");
        repo.stash_save(&sig, message, None).expect("stash save")
    }

    // ── folder_opener ─────────────────────────────────────────────────────────

    #[test]
    fn folder_opener_cases() {
        let cases = [
            (
                "Windows は区切りを バックスラッシュ にそろえる",
                Os::Windows,
                "C:/Users/dev/src/arbor",
                ("explorer", r"C:\Users\dev\src\arbor"),
            ),
            (
                "Windows のバックスラッシュ区切りはそのまま",
                Os::Windows,
                r"C:\src\arbor",
                ("explorer", r"C:\src\arbor"),
            ),
            (
                "macOS",
                Os::Mac,
                "/Users/dev/src/arbor",
                ("open", "/Users/dev/src/arbor"),
            ),
            (
                "その他",
                Os::Other,
                "/home/dev/src/arbor",
                ("xdg-open", "/home/dev/src/arbor"),
            ),
        ];
        for (name, os, path, (program, arg)) in cases {
            assert_eq!(
                folder_opener(path, os),
                (program, vec![arg.to_string()]),
                "{name}"
            );
        }
    }

    // ── open_folder ───────────────────────────────────────────────────────────

    type Launched = std::cell::RefCell<Vec<(String, Vec<String>)>>;

    fn managed(path: &str) -> Vec<EffectiveRepo> {
        vec![EffectiveRepo {
            path: path.to_string(),
            name: "repo".to_string(),
            protected_branches: Vec::new(),
            source: RepoSource::Workspace,
        }]
    }

    fn recording(launched: &Launched) -> impl Fn(&str, &[String]) -> std::io::Result<()> + '_ {
        move |program, args| {
            launched
                .borrow_mut()
                .push((program.to_string(), args.to_vec()));
            Ok(())
        }
    }

    #[test]
    fn open_folder_opens_the_resolved_managed_path_not_the_requested_spelling() {
        let dir = TempDir::new("open-folder");
        let launched = Launched::default();
        // 末尾の区切りがついた別の表記で依頼しても、管理対象として解決したパスを開く。
        let requested = format!("{}/", dir.path_str());

        open_folder(
            &managed(dir.path_str()),
            &requested,
            Os::Other,
            &recording(&launched),
        )
        .expect("open");

        assert_eq!(
            *launched.borrow(),
            [("xdg-open".to_string(), vec![dir.path_str().to_string()])]
        );
    }

    #[test]
    fn open_folder_rejects_paths_that_are_not_managed_without_launching() {
        let dir = TempDir::new("open-folder-unmanaged");
        let other = TempDir::new("open-folder-other");
        let launched = Launched::default();

        let err = open_folder(
            &managed(dir.path_str()),
            other.path_str(),
            Os::Other,
            &recording(&launched),
        )
        .unwrap_err();

        assert!(err.contains("管理対象のリポジトリではありません"), "{err}");
        assert!(launched.borrow().is_empty());
    }

    #[test]
    fn open_folder_rejects_a_managed_path_that_no_longer_exists() {
        let gone = TempDir::new("open-folder-gone").path.join("deleted");
        let gone = gone.to_string_lossy().into_owned();
        let launched = Launched::default();

        let err =
            open_folder(&managed(&gone), &gone, Os::Other, &recording(&launched)).unwrap_err();

        assert!(err.contains("フォルダが見つかりません"), "{err}");
        assert!(launched.borrow().is_empty());
    }

    #[test]
    fn open_folder_reports_a_launch_failure_with_the_program_name() {
        let dir = TempDir::new("open-folder-fail");
        let fail = |_: &str, _: &[String]| Err(std::io::Error::from(std::io::ErrorKind::NotFound));

        let err =
            open_folder(&managed(dir.path_str()), dir.path_str(), Os::Windows, &fail).unwrap_err();

        assert!(err.contains("explorer を起動できません"), "{err}");
    }

    #[test]
    fn current_os_matches_the_build_target() {
        let expected = if cfg!(windows) {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::Mac
        } else {
            Os::Other
        };
        assert_eq!(Os::current(), expected);
    }

    #[test]
    fn spawn_detached_reports_a_missing_program() {
        assert!(spawn_detached("arbor-no-such-program-xyz", &[]).is_err());
    }

    // ── list_repos / repo_status / open_managed_folder（設定を受ける入口）──────────

    fn config_with_root(root: &str) -> crate::config::AppConfig {
        let mut config = crate::config::AppConfig::default();
        config.workspace.root = Some(root.to_string());
        config
    }

    #[test]
    fn list_repos_lists_the_workspace_repository_with_its_status() {
        let repo = init_repo_with_commit("first");

        let repos = list_repos(&config_with_root(repo.path_str()));

        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].path, repo.path_str());
        assert_eq!(repos[0].source, RepoSource::Workspace);
        assert_eq!(repos[0].current_branch, "main");
    }

    #[test]
    fn list_repos_keeps_manual_repositories_when_the_root_cannot_be_read() {
        let manual = init_repo_with_commit("manual");
        let missing = TempDir::new("list-missing-root").path.join("gone");
        let mut config = config_with_root(&missing.to_string_lossy());
        config.repositories = vec![crate::config::RepoConfig {
            path: manual.path_str().to_string(),
            name: "manual-tool".to_string(),
            protected_branches: Vec::new(),
        }];

        let repos = list_repos(&config);

        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].name, "manual-tool");
        assert_eq!(repos[0].source, RepoSource::Manual);
    }

    #[test]
    fn repo_status_applies_the_configured_name_to_a_managed_repository() {
        let repo = init_repo_with_commit("managed");
        let mut config = config_with_root(repo.path_str());
        config.repositories = vec![crate::config::RepoConfig {
            path: repo.path_str().to_string(),
            name: "Custom Name".to_string(),
            protected_branches: Vec::new(),
        }];

        let info = repo_status(&config, repo.path_str()).expect("status");

        assert_eq!(info.name, "Custom Name");
        assert_eq!(info.source, RepoSource::Workspace);
    }

    #[test]
    fn repo_status_reads_a_repository_that_is_not_managed_and_rejects_non_repositories() {
        let unmanaged = init_repo_with_commit("unmanaged");
        let plain = TempDir::new("status-plain");
        let config = crate::config::AppConfig::default();

        let info = repo_status(&config, unmanaged.path_str()).expect("status");
        let err = repo_status(&config, plain.path_str()).unwrap_err();

        assert_eq!(info.current_branch, "main");
        assert!(!err.is_empty());
    }

    #[test]
    fn open_managed_folder_rejects_unmanaged_paths_before_launching_anything() {
        let unmanaged = TempDir::new("open-unmanaged");

        let err = open_managed_folder(&crate::config::AppConfig::default(), unmanaged.path_str())
            .unwrap_err();

        assert!(err.contains("管理対象のリポジトリではありません"), "{err}");
    }
}
