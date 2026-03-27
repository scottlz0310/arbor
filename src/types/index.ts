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

// ─── UI-only types ───────────────────────────────────────────────────────────

export type ViewId = 'overview' | 'branches' | 'graph' | 'prs' | 'cleanup' | 'settings';

export type InsightType = 'explain' | 'prioritize' | 'risk';
export type InsightSource = 'rule' | 'ai';

export interface Insight {
  type: InsightType;
  target: string;
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
