use crate::config::{load_config, RepoConfig};
use crate::models::{FetchResult, RepoInfo};
use git2::{Repository, StatusOptions};

// ─── apply_repo_cfg ──────────────────────────────────────────────────────────

/// Overlays the display `name` from a registered `RepoConfig` onto a live
/// `RepoInfo`. Used by both `list_repositories` and `get_repo_status` so the two
/// code paths cannot drift.
fn apply_repo_cfg(info: &mut RepoInfo, cfg: &RepoConfig) {
    info.name = cfg.name.clone();
}

// ─── list_repositories ───────────────────────────────────────────────────────

#[tauri::command]
pub fn list_repositories() -> Result<Vec<RepoInfo>, String> {
    let config = load_config()?;
    let mut result = Vec::new();
    for repo_cfg in &config.repositories {
        match repo_info_for_path(&repo_cfg.path) {
            Ok(mut info) => {
                apply_repo_cfg(&mut info, repo_cfg);
                result.push(info);
            }
            Err(e) => {
                // Return a degraded entry so the sidebar still shows the repo.
                result.push(RepoInfo {
                    path: repo_cfg.path.clone(),
                    name: repo_cfg.name.clone(),
                    current_branch: "unknown".to_string(),
                    ahead: 0,
                    behind: 0,
                    modified_count: 0,
                    untracked_count: 0,
                    stash_count: 0,
                    last_fetched_at: None,
                });
                eprintln!("Warning: could not open repo {}: {e}", repo_cfg.path);
            }
        }
    }
    Ok(result)
}

// ─── get_repo_status ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_repo_status(repo_path: String) -> Result<RepoInfo, String> {
    let config = load_config()?;
    let mut info = repo_info_for_path(&repo_path)?;
    if let Some(repo_cfg) = config.repositories.iter().find(|r| r.path == repo_path) {
        apply_repo_cfg(&mut info, repo_cfg);
    }
    Ok(info)
}

// ─── fetch_all ───────────────────────────────────────────────────────────────

/// Fetches all remotes for the given repository.
/// Phase 1: uses git2 with no credential callback (relies on the system git
/// credential helper / SSH agent already being authenticated).
/// Full SSH / HTTPS credential UI is deferred to Phase 2.
#[tauri::command]
pub fn fetch_all(repo_path: String) -> Result<FetchResult, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.to_string())?;
    let remotes = repo.remotes().map_err(|e| e.to_string())?;
    let mut updated_refs = Vec::new();

    for name in remotes.iter() {
        let Some(name) = name.map_err(|e| e.to_string())? else {
            continue;
        };
        let mut remote = repo.find_remote(name).map_err(|e| e.to_string())?;
        let mut fo = git2::FetchOptions::new();
        fo.download_tags(git2::AutotagOption::Unspecified);

        remote
            .fetch(&[] as &[&str], Some(&mut fo), None)
            .map_err(|e| format!("fetch {name}: {e}"))?;

        // Collect updated refs.
        let stats = remote.stats();
        if stats.received_objects() > 0 {
            updated_refs.push(name.to_string());
        }
    }

    Ok(FetchResult { updated_refs })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn repo_info_for_path(path: &str) -> Result<RepoInfo, String> {
    let mut repo = Repository::open(path).map_err(|e| e.to_string())?;

    // Current branch name.
    let current_branch = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().ok().map(|s| s.to_string()))
        .unwrap_or_else(|| "HEAD (detached)".to_string());

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
    use super::{apply_repo_cfg, fetch_all, repo_info_for_path};
    use crate::config::RepoConfig;
    use crate::models::RepoInfo;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(prefix: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock should be after epoch")
                .as_nanos();
            let path = std::env::temp_dir()
                .join(format!("arbor-{prefix}-{}-{unique}", std::process::id()));
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

    // ── apply_repo_cfg ────────────────────────────────────────────────────────

    // ── apply_repo_cfg ────────────────────────────────────────────────────────

    fn stub_info() -> RepoInfo {
        RepoInfo {
            path: "/tmp/repo".to_string(),
            name: "derived-name".to_string(),
            current_branch: "main".to_string(),
            ahead: 0,
            behind: 0,
            modified_count: 0,
            untracked_count: 0,
            stash_count: 0,
            last_fetched_at: None,
        }
    }

    fn stub_cfg() -> RepoConfig {
        RepoConfig {
            path: "/tmp/repo".to_string(),
            name: "configured-name".to_string(),
            protected_branches: Vec::new(),
        }
    }

    #[test]
    fn apply_repo_cfg_sets_name() {
        let mut info = stub_info();
        apply_repo_cfg(&mut info, &stub_cfg());
        assert_eq!(info.name, "configured-name");
    }

    #[test]
    fn apply_repo_cfg_does_not_touch_git_fields() {
        let mut info = stub_info();
        info.ahead = 3;
        info.behind = 1;
        info.modified_count = 2;
        apply_repo_cfg(&mut info, &stub_cfg());
        assert_eq!(info.ahead, 3);
        assert_eq!(info.behind, 1);
        assert_eq!(info.modified_count, 2);
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

        let result = fetch_all(target.path_str().to_string()).expect("fetch all");

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
}
