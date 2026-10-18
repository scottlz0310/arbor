use serde::{Deserialize, Serialize};

/// リポジトリが一覧に入った経路。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RepoSource {
    /// workspace root 配下から自動検出した。
    Workspace,
    /// root の外にある、手動で登録したリポジトリ。
    Manual,
}

/// Overall status of a registered repository.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoInfo {
    pub path: String,
    pub name: String,
    pub current_branch: String,
    /// HEAD がブランチを指していない（detached HEAD）。
    pub is_detached: bool,
    /// 現在のブランチに upstream が設定されている。false のとき ahead / behind は 0 になる。
    pub has_upstream: bool,
    pub source: RepoSource,
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
    /// Unix timestamp of last successful fetch (stored in arbor's own state).
    pub last_fetched_at: Option<i64>,
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
    /// default branch にマージ済みの local branch（初期選択対象）。
    /// local に default branch が無い repo では HEAD 基準にフォールバックする。
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

/// Cleanup preview からユーザーが選択した項目を execute へ渡す入力。
/// 各 candidate 自体が preview 時点の OID / upstream 状態を保持する。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanupExecutionRequest {
    pub candidates: Vec<CleanupCandidate>,
}

/// Cleanup execute の項目単位ステータス。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CleanupExecutionStatus {
    Success,
    Skipped,
    Failed,
}

/// Cleanup execute の項目単位結果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanupExecutionItemResult {
    pub repo_path: String,
    pub repo_name: String,
    pub ref_name: String,
    pub operation: CleanupOperation,
    pub status: CleanupExecutionStatus,
    /// 再検証で skip した理由。success / failed では None。
    pub reason: Option<String>,
    /// 実行に失敗したエラー。success / skipped では None。
    pub error: Option<String>,
}

/// repo 横断 Cleanup execute の全体結果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanupExecutionResult {
    pub items: Vec<CleanupExecutionItemResult>,
    pub completed_at: i64,
}
