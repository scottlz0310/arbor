// ─── Mirror of src-tauri/src/models.rs ─────────────────────────────────────

export interface RepoInfo {
  path: string;
  name: string;
  current_branch: string;
  ahead: number;
  behind: number;
  modified_count: number;
  untracked_count: number;
  stash_count: number;
  github_owner: string | null;
  github_repo: string | null;
  last_fetched_at: number | null;
}

export interface BranchInfo {
  name: string;
  is_current: boolean;
  is_merged: boolean;
  is_squash_merged: boolean;
  ahead: number;
  behind: number;
  last_commit_ts: number;
  last_commit_msg: string;
  author: string;
  remote_name: string | null;
}

export interface CommitNode {
  oid: string;
  short_oid: string;
  summary: string;
  author_name: string;
  timestamp: number;
  parent_oids: string[];
  refs: string[];
  lane: number;
}

export interface DeleteResult {
  name: string;
  success: boolean;
  error: string | null;
}

export interface DsxOutput {
  stdout: string;
  stderr: string;
  exit_code: number;
}

export interface FetchResult {
  updated_refs: string[];
}

export interface DsxStatus {
  available: boolean;
  version: string | null;
  path: string | null;
}

// ─── Cleanup Wizard (Issue #186) ────────────────────────────────────────────

export type CleanupOperation = 'delete_local_branch' | 'prune_remote_tracking_ref';
export type CandidateKind = 'merged' | 'stale' | 'upstream_gone' | 'stale_remote_tracking';
export type UpstreamState = 'none' | 'tracked' | 'gone';
export type SafetyBlock =
  | 'current_branch'
  | 'default_branch'
  | 'protected_branch'
  | 'worktree_checked_out';

export interface CleanupCandidate {
  repo_path: string;
  repo_name: string;
  ref_name: string;
  operation: CleanupOperation;
  kind: CandidateKind;
  remote_name: string | null;
  oid: string;
  last_commit_ts: number;
  is_merged: boolean;
  upstream: UpstreamState;
  stale_days: number | null;
  blocked: SafetyBlock[];
}

export interface RemoteFetchError {
  remote: string;
  error: string;
}

export interface RepoCleanupPreview {
  repo_path: string;
  repo_name: string;
  candidates: CleanupCandidate[];
  remote_errors: RemoteFetchError[];
  error: string | null;
}

export interface CleanupPreview {
  repos: RepoCleanupPreview[];
  generated_at: number;
}

export type CleanupExecutionStatus = 'success' | 'skipped' | 'failed';

export interface CleanupExecutionItemResult {
  repo_path: string;
  repo_name: string;
  ref_name: string;
  operation: CleanupOperation;
  status: CleanupExecutionStatus;
  reason: string | null;
  error: string | null;
}

export interface CleanupExecutionResult {
  items: CleanupExecutionItemResult[];
  completed_at: number;
}

// ─── Mirror of src-tauri/src/config.rs ──────────────────────────────────────

export interface AppConfig {
  settings: Settings;
  ai: AiConfig;
  repositories: RepoConfig[];
}

export interface Settings {
  stale_threshold_days: number;
  fetch_on_startup: boolean;
  github_keychain_key: string;
}

export interface AiConfig {
  provider: string;
  ollama_url: string;
  model: string;
  enabled: boolean;
  timeout_secs: number;
}

export interface RepoConfig {
  path: string;
  name: string;
  github_owner: string | null;
  github_repo: string | null;
}

// ─── Mirror of GitHub API response types in models.rs ───────────────────────

export interface PullRequest {
  number: number;
  title: string;
  /** "open" | "closed" */
  state: string;
  html_url: string;
  user_login: string;
  created_at: string;
  updated_at: string;
  draft: boolean;
  merged_at: string | null;
  /** Source branch name */
  head_ref: string;
  /** HEAD commit SHA of the source branch */
  head_sha: string;
  /** Target branch name */
  base_ref: string;
}

export interface Issue {
  number: number;
  title: string;
  /** "open" | "closed" */
  state: string;
  html_url: string;
  user_login: string;
  created_at: string;
  updated_at: string;
  body: string | null;
  labels: string[];
}

export interface CheckRun {
  id: number;
  name: string;
  /** "queued" | "in_progress" | "completed" */
  status: string;
  /** "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" */
  conclusion: string | null;
  html_url: string;
  started_at: string | null;
  completed_at: string | null;
}

/** Mirror of AiInsight in models.rs — raw response from get_ai_insights. */
export interface AiInsight {
  repo_name: string;
  /**
   * Canonical repo identifier. Same-name repos under different roots are
   * disambiguated by this field. Always matches a `RepoInfo.path`.
   */
  repo_path: string;
  /** "explain" | "prioritize" | "risk" */
  kind: InsightType;
  message: string;
  /** 0 = lowest priority, 3 = highest urgency */
  priority: number;
}

// ─── UI-only types ───────────────────────────────────────────────────────────

export interface StashInfo {
  index: number;
  message: string;
  commit_id: string;
}

export type ViewId = 'overview' | 'branches' | 'graph' | 'prs' | 'cleanup' | 'stash' | 'ai' | 'settings';

export type InsightType = 'explain' | 'prioritize' | 'risk';
export type InsightSource = 'rule' | 'ai';

export interface Insight {
  type: InsightType;
  /**
   * Display label. For repo-level insights this is the repo name; for
   * branch-level insights this is the branch name. Not unique — use
   * `repo_path` for identification / grouping.
   */
  target: string;
  /**
   * Canonical repo identifier (matches `RepoInfo.path`). Always set so
   * insights can be grouped per-repo even when names collide.
   */
  repo_path: string;
  priority: 'low' | 'medium' | 'high';
  reason: string;
  source: InsightSource;
  risk?: 'low' | 'medium' | 'high';
}

export interface Toast {
  id: string;
  message: string;
  kind: 'success' | 'error' | 'info';
}
