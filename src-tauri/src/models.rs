use serde::{Deserialize, Serialize};

/// Overall status of a registered repository.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoInfo {
    pub path: String,
    pub name: String,
    pub current_branch: String,
    /// Commits ahead of the remote tracking branch.
    pub ahead: u32,
    /// Commits behind the remote tracking branch.
    pub behind: u32,
    /// Number of tracked files with unstaged modifications.
    pub modified_count: u32,
    /// Number of untracked files.
    pub untracked_count: u32,
    /// Number of stash entries.
    pub stash_count: u32,
    pub github_owner: Option<String>,
    pub github_repo: Option<String>,
    /// Unix timestamp of last successful fetch (stored in arbor's own state).
    pub last_fetched_at: Option<i64>,
}

/// Per-branch metadata for the Branches view.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
    /// True if HEAD is a descendant of this branch tip (merged into current branch).
    pub is_merged: bool,
    /// True if the branch was squash-merged (requires dsx dry-run parse).
    pub is_squash_merged: bool,
    /// Commits ahead of its upstream tracking branch.
    pub ahead: u32,
    /// Commits behind its upstream tracking branch.
    pub behind: u32,
    /// Unix timestamp of the most recent commit on this branch.
    pub last_commit_ts: i64,
    pub last_commit_msg: String,
    pub author: String,
    pub remote_name: Option<String>,
}

/// Commit node for the Graph view (d3 lane rendering). Used in Phase 2.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitNode {
    pub oid: String,
    pub short_oid: String,
    pub summary: String,
    pub author_name: String,
    pub timestamp: i64,
    pub parent_oids: Vec<String>,
    /// Branch / tag refs pointing at this commit.
    pub refs: Vec<String>,
    /// Zero-based column index for SVG lane rendering.
    pub lane: u32,
}

/// Result of a single branch deletion attempt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeleteResult {
    pub name: String,
    pub success: bool,
    pub error: Option<String>,
}

/// Raw output captured from a dsx subprocess.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DsxOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// Result returned by fetch_all.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FetchResult {
    pub updated_refs: Vec<String>,
}
