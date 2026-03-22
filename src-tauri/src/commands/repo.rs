use crate::config::load_config;
use crate::models::{BranchInfo, DeleteResult, FetchResult, RepoInfo};
use git2::{BranchType, Repository, StatusOptions};

// ─── list_repositories ───────────────────────────────────────────────────────

#[tauri::command]
pub fn list_repositories() -> Result<Vec<RepoInfo>, String> {
    let config = load_config()?;
    let mut result = Vec::new();
    for repo_cfg in &config.repositories {
        match repo_info_for_path(&repo_cfg.path) {
            Ok(mut info) => {
                info.github_owner = repo_cfg.github_owner.clone();
                info.github_repo = repo_cfg.github_repo.clone();
                // Override display name with configured name.
                info.name = repo_cfg.name.clone();
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
                    github_owner: repo_cfg.github_owner.clone(),
                    github_repo: repo_cfg.github_repo.clone(),
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
    repo_info_for_path(&repo_path)
}

// ─── get_branches ─────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_branches(repo_path: String) -> Result<Vec<BranchInfo>, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.to_string())?;
    let head_oid = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok())
        .map(|c| c.id());

    let mut branches = Vec::new();
    for item in repo
        .branches(Some(BranchType::Local))
        .map_err(|e| e.to_string())?
    {
        let (branch, _) = item.map_err(|e| e.to_string())?;
        let name = match branch.name() {
            Ok(Some(n)) => n.to_string(),
            _ => continue,
        };
        let is_current = branch.is_head();

        let ref_ = branch.get();
        let commit = match ref_.peel_to_commit() {
            Ok(c) => c,
            Err(_) => continue,
        };
        let branch_tip_oid = commit.id();

        // Merged detection: is HEAD a descendant of (or equal to) branch tip?
        let is_merged = if let Some(head) = head_oid {
            if head == branch_tip_oid {
                false // This IS HEAD, not merged into it.
            } else {
                repo.graph_descendant_of(head, branch_tip_oid)
                    .unwrap_or(false)
            }
        } else {
            false
        };

        // Ahead/behind relative to upstream tracking branch.
        let (ahead, behind) = upstream_ahead_behind(&repo, &branch);

        let author = commit.author();
        branches.push(BranchInfo {
            name,
            is_current,
            is_merged,
            is_squash_merged: false, // Determined by dsx dry-run in Cleanup Wizard.
            ahead,
            behind,
            last_commit_ts: commit.time().seconds(),
            last_commit_msg: commit
                .summary()
                .unwrap_or_default()
                .to_string(),
            author: author.name().unwrap_or_default().to_string(),
            remote_name: branch
                .upstream()
                .ok()
                .and_then(|u| u.name().ok().flatten().map(|s| s.to_string())),
        });
    }
    Ok(branches)
}

// ─── delete_branches ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn delete_branches(
    repo_path: String,
    names: Vec<String>,
) -> Result<Vec<DeleteResult>, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.to_string())?;
    let mut results = Vec::new();
    for name in names {
        let result = (|| {
            let mut branch = repo
                .find_branch(&name, BranchType::Local)
                .map_err(|e| e.to_string())?;
            if branch.is_head() {
                return Err("Cannot delete the currently checked-out branch".to_string());
            }
            branch.delete().map_err(|e| e.to_string())
        })();
        results.push(DeleteResult {
            success: result.is_ok(),
            error: result.err(),
            name,
        });
    }
    Ok(results)
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

    for name in remotes.iter().flatten() {
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
        .and_then(|h| h.shorthand().map(|s| s.to_string()))
        .unwrap_or_else(|| "HEAD (detached)".to_string());

    // Ahead / behind for the current branch vs its upstream.
    let (ahead, behind) = current_ahead_behind(&repo);

    // Modified + untracked counts.
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(false);
    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;

    let mut modified_count = 0u32;
    let mut untracked_count = 0u32;
    for entry in statuses.iter() {
        let s = entry.status();
        if s.contains(git2::Status::WT_MODIFIED)
            || s.contains(git2::Status::INDEX_MODIFIED)
            || s.contains(git2::Status::WT_DELETED)
            || s.contains(git2::Status::INDEX_DELETED)
        {
            modified_count += 1;
        }
        if s.contains(git2::Status::WT_NEW) {
            untracked_count += 1;
        }
    }

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
        github_owner: None,
        github_repo: None,
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
