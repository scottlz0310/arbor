use crate::config::load_config;
use crate::models::{BranchInfo, CommitNode, DeleteResult, FetchResult, RepoInfo};
use git2::{BranchType, Repository, StatusOptions};
use std::collections::HashMap;

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

// ─── get_commit_graph ─────────────────────────────────────────────────────────

/// Hard upper bound on commit graph size to prevent accidental large revwalks.
const MAX_COMMITS_LIMIT: usize = 10_000;

/// Returns up to `limit` commits (default 200) in topological order with lane
/// assignments suitable for SVG column rendering.
/// The requested `limit` is clamped to `MAX_COMMITS_LIMIT`.
#[tauri::command]
pub fn get_commit_graph(
    repo_path: String,
    limit: Option<u32>,
) -> Result<Vec<CommitNode>, String> {
    let max = (limit.unwrap_or(200) as usize).min(MAX_COMMITS_LIMIT);
    let repo = Repository::open(&repo_path).map_err(|e| e.to_string())?;

    // Build oid → ref-names map (branches, tags, HEAD).
    let mut ref_map: HashMap<git2::Oid, Vec<String>> = HashMap::new();
    for r in repo.references().map_err(|e| e.to_string())? {
        let r = r.map_err(|e| e.to_string())?;
        let Some(name) = r.shorthand() else { continue };
        if let Ok(commit) = r.peel_to_commit() {
            ref_map.entry(commit.id()).or_default().push(name.to_string());
        }
    }

    // Walk in topological + time order, starting from all local branches.
    let mut walk = repo.revwalk().map_err(|e| e.to_string())?;
    walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)
        .map_err(|e| e.to_string())?;
    // push_glob may return NotFound on repos with no local branches (e.g. bare
    // or freshly `git init`'d). Treat that as "no commits" rather than an error.
    match walk.push_glob("refs/heads/*") {
        Ok(()) => {}
        Err(e) if e.code() == git2::ErrorCode::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.to_string()),
    }
    // Also include HEAD in case of detached state.
    if let Ok(head) = repo.head().and_then(|h| h.peel_to_commit()) {
        let _ = walk.push(head.id());
    }

    // Lane assignment via the pure helper (testable without git2).
    let mut lanes: Vec<Option<git2::Oid>> = Vec::new();
    let mut nodes: Vec<CommitNode> = Vec::with_capacity(max);

    for oid_result in walk.take(max) {
        let oid = oid_result.map_err(|e| e.to_string())?;
        let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
        let parent_ids: Vec<git2::Oid> = commit.parent_ids().collect();

        let my_lane = assign_lane(&mut lanes, &oid, &parent_ids);

        let refs = ref_map.get(&oid).cloned().unwrap_or_default();
        let oid_str = oid.to_string();

        nodes.push(CommitNode {
            short_oid: oid_str[..7].to_string(),
            oid: oid_str,
            summary: commit.summary().unwrap_or_default().to_string(),
            author_name: commit.author().name().unwrap_or_default().to_string(),
            timestamp: commit.time().seconds(),
            parent_oids: parent_ids.iter().map(|id| id.to_string()).collect(),
            refs,
            lane: my_lane as u32,
        });
    }

    Ok(nodes)
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

/// Assigns a display lane (column index) for a commit in a topological walk.
///
/// `lanes` is a slot array where each entry is either `None` (free) or
/// `Some(oid)` meaning "this slot is reserved for the commit with that OID".
/// The function updates `lanes` in-place so callers can re-use the same vec
/// across the entire walk.
///
/// Generic over `Id` so the algorithm can be unit-tested with plain integers
/// without pulling in git2.
fn assign_lane<Id>(lanes: &mut Vec<Option<Id>>, id: &Id, parents: &[Id]) -> usize
where
    Id: PartialEq + Clone,
{
    // Find (or allocate) the slot reserved for this commit.
    let my_lane = if let Some(pos) = lanes.iter().position(|l| l.as_ref() == Some(id)) {
        pos
    } else {
        lanes.iter().position(|l| l.is_none()).unwrap_or_else(|| {
            lanes.push(None);
            lanes.len() - 1
        })
    };

    // Free all slots pointing to this commit.
    for slot in lanes.iter_mut() {
        if slot.as_ref() == Some(id) {
            *slot = None;
        }
    }

    // Reserve my_lane for the first parent (continuing the same line).
    if let Some(first) = parents.first() {
        if !lanes.contains(&Some(first.clone())) {
            lanes[my_lane] = Some(first.clone());
        }
    }

    // Allocate a new slot for each additional parent (branch lines).
    for parent in parents.iter().skip(1) {
        if !lanes.contains(&Some(parent.clone())) {
            let free = lanes.iter().position(|l| l.is_none()).unwrap_or_else(|| {
                lanes.push(None);
                lanes.len() - 1
            });
            lanes[free] = Some(parent.clone());
        }
    }

    my_lane
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::assign_lane;

    fn run(commits: &[(u32, &[u32])]) -> Vec<usize> {
        let mut lanes: Vec<Option<u32>> = Vec::new();
        commits
            .iter()
            .map(|(id, parents)| assign_lane(&mut lanes, id, parents))
            .collect()
    }

    #[test]
    fn lane_single_commit() {
        assert_eq!(run(&[(1, &[])]), vec![0]);
    }

    #[test]
    fn lane_empty_input() {
        assert_eq!(run(&[]), Vec::<usize>::new());
    }

    #[test]
    fn lane_linear_history() {
        // A→B→C (topological order: A first)
        let result = run(&[(3, &[2]), (2, &[1]), (1, &[])]);
        assert_eq!(result, vec![0, 0, 0]);
    }

    #[test]
    fn lane_merge_and_rejoin() {
        // Merge commit M has two parents: A (lane 0) and B (lane 1).
        // After M both lines rejoin on lane 0.
        //   M(0) -> A(0), B(1)
        //   A(0) -> root(0)
        //   B(1) -> root(0)
        //   root(0) -> []
        let result = run(&[(10, &[8, 9]), (8, &[7]), (9, &[7]), (7, &[])]);
        assert_eq!(result, vec![0, 0, 1, 0]);
    }

    #[test]
    fn lane_unseen_branch_tip_gets_new_lane() {
        // Two independent branch tips before they converge.
        //   tip_a(0) -> base(0)
        //   tip_b(1) -> base(0)   ← base already claimed by lane 0
        //   base(0)  -> []
        let result = run(&[(1, &[3]), (2, &[3]), (3, &[])]);
        assert_eq!(result, vec![0, 1, 0]);
    }
}
