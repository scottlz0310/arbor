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

/// Commit node for the Graph view (lane rendering).
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

// ─── GitHub API response types ────────────────────────────────────────────────

/// A GitHub pull request (subset of fields returned by the REST API).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    /// "open" | "closed"
    pub state: String,
    pub html_url: String,
    pub user_login: String,
    pub created_at: String,
    pub updated_at: String,
    pub draft: bool,
    pub merged_at: Option<String>,
    /// Source branch name.
    pub head_ref: String,
    /// HEAD commit SHA of the source branch.
    pub head_sha: String,
    /// Target branch name.
    pub base_ref: String,
}

/// A GitHub issue (PR items are excluded).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Issue {
    pub number: u64,
    pub title: String,
    /// "open" | "closed"
    pub state: String,
    pub html_url: String,
    pub user_login: String,
    pub created_at: String,
    pub updated_at: String,
    pub body: Option<String>,
    pub labels: Vec<String>,
}

/// Discriminates the three insight categories the AI (and rule engine) can emit.
/// Serde rejects any other string, closing the boundary at parse time.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum InsightKind {
    Explain,
    Prioritize,
    Risk,
}

/// A single AI-generated insight for a repository.
///
/// `repo_path` is the canonical identifier (Arbor allows same-name repos under
/// different root directories, so name alone is ambiguous). `repo_name` is
/// kept as a display label.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiInsight {
    pub repo_name: String,
    pub repo_path: String,
    pub kind: InsightKind,
    pub message: String,
    /// Priority level: 0 = lowest, 3 = highest urgency.
    pub priority: u8,
}

/// A single git stash entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StashInfo {
    /// Zero-based stash index (stash@{index}).
    pub index: usize,
    /// Stash reflog message (e.g. "WIP on main: abc1234 message").
    pub message: String,
    /// Full commit OID of the stash entry.
    pub commit_id: String,
}

// ─── Cleanup Wizard (Issue #186) ─────────────────────────────────────────────

/// Cleanup の操作種別。local branch 削除と remote-tracking ref の prune は
/// ライフサイクルと復旧性が異なるため、別 operation として明示的に分離する。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CleanupOperation {
    DeleteLocalBranch,
    PruneRemoteTrackingRef,
}

/// 候補と判定された理由のカテゴリ。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateKind {
    /// HEAD にマージ済みの local branch（初期選択対象）。
    Merged,
    /// stale 閾値を超えた local branch（明示選択のみ）。
    Stale,
    /// upstream が設定されているが remote-tracking ref が消失した local branch。
    UpstreamGone,
    /// remote 上に存在しなくなった remote-tracking ref（prune 対象）。
    StaleRemoteTracking,
}

/// local branch の upstream 追跡状態。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpstreamState {
    /// upstream 未設定。
    None,
    /// upstream 設定済みで remote-tracking ref が存在する。
    Tracked,
    /// upstream 設定済みだが remote-tracking ref が消失している。
    Gone,
}

/// 選択・実行を拒否する安全条件。空でなければ UI 上で選択不可にする。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SafetyBlock {
    CurrentBranch,
    DefaultBranch,
    ProtectedBranch,
    WorktreeCheckedOut,
}

/// repo 横断 Cleanup の削除候補 1 件。
/// 同名 branch が複数 repo / remote に存在しても
/// `repo_path` + `operation` + `ref_name` で一意に識別できる。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanupCandidate {
    pub repo_path: String,
    pub repo_name: String,
    /// local: branch 名 (`feature/x`)、remote-tracking: short ref (`origin/feature/x`)。
    pub ref_name: String,
    pub operation: CleanupOperation,
    pub kind: CandidateKind,
    /// remote-tracking では対象 remote、local branch では upstream の remote。
    pub remote_name: Option<String>,
    /// preview 時点の tip OID。execute 直前の再検証に使う。
    pub oid: String,
    pub last_commit_ts: i64,
    pub is_merged: bool,
    pub upstream: UpstreamState,
    /// kind == Stale のときの経過日数。
    pub stale_days: Option<u32>,
    /// 安全条件に該当する場合は非空（選択不可）。
    pub blocked: Vec<SafetyBlock>,
}

/// remote への接続（ls-remote 相当）に失敗した記録。
/// 該当 remote の prune 候補は安全のため一切提示しない。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteFetchError {
    pub remote: String,
    pub error: String,
}

/// 1 repo 分の preview 結果。repo が開けない場合も `error` 付きで返し、
/// 他 repo の結果を巻き込まない。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoCleanupPreview {
    pub repo_path: String,
    pub repo_name: String,
    pub candidates: Vec<CleanupCandidate>,
    pub remote_errors: Vec<RemoteFetchError>,
    pub error: Option<String>,
}

/// repo 横断 Cleanup preview の全体結果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanupPreview {
    pub repos: Vec<RepoCleanupPreview>,
    /// preview 生成時刻 (Unix秒)。execute 時の再検証基準に使う。
    pub generated_at: i64,
}

/// A single check run result for a commit.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckRun {
    pub id: u64,
    pub name: String,
    /// "queued" | "in_progress" | "completed"
    pub status: String,
    /// "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required"
    pub conclusion: Option<String>,
    pub html_url: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}
