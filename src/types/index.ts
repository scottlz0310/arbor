// ─── Mirror of src-tauri/src/models.rs ─────────────────────────────────────

export type RepoSource = 'workspace' | 'manual';

export interface RepoInfo {
  path: string;
  name: string;
  current_branch: string;
  /** HEAD がブランチを指していない（detached HEAD）。 */
  is_detached: boolean;
  /** 現在のブランチに upstream が設定されている。false のとき ahead / behind は 0。 */
  has_upstream: boolean;
  source: RepoSource;
  ahead: number;
  behind: number;
  modified_count: number;
  untracked_count: number;
  stash_count: number;
  last_fetched_at: number | null;
}

export interface DsxOutput {
  stdout: string;
  stderr: string;
  exit_code: number;
}

export interface FetchResult {
  updated_refs: string[];
}

/** 一括 fetch で失敗した 1 件（commands/fetch.rs）。 */
export interface FetchFailure {
  path: string;
  name: string;
  error: string;
}

/** `fetch_repositories` の結果。キャンセルされた場合、成功と失敗の合計は total に満たない。 */
export interface FetchSummary {
  total: number;
  succeeded: number;
  failed: FetchFailure[];
  cancelled: boolean;
}

/** GitHub 側から見たリポジトリの状態（Rust の `RemoteState`）。 */
export type RemoteState =
  | { kind: 'active' }
  | { kind: 'archived' }
  /** 削除されたか、権限が無い（GitHub は、権限の無い非公開リポジトリも 404 で答える）。 */
  | { kind: 'not_found' }
  /** `origin` が無い、または GitHub 以外。 */
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string };

export interface RemoteStatus {
  path: string;
  name: string;
  state: RemoteState;
  /** `origin` の URL と、GitHub が答えた現在の `owner/repo` が違うとき（transfer や rename の後）の、現在の名前。 */
  moved_to: string | null;
}

/** `check_remotes` の結果。キャンセルされた場合、`statuses` の件数は total に満たない。 */
export interface RemoteCheckSummary {
  total: number;
  statuses: RemoteStatus[];
  cancelled: boolean;
}

/** Mirror of the `process_started` event payload (commands/runner.rs). */
export interface ProcessStarted {
  runId: number;
  label: string;
  argv: string[];
  /** Unix epoch milliseconds. */
  startedAt: number;
}

/** Mirror of the `process_output` event payload. */
export interface ProcessOutput {
  runId: number;
  stream: 'stdout' | 'stderr';
  text: string;
  /** true replaces the previous in-progress line (a line that ended with `\r`). */
  overwrite: boolean;
}

/** Mirror of the `process_finished` event payload. */
export interface ProcessFinished {
  runId: number;
  /** null when the process ended without an exit code (e.g. killed). */
  exitCode: number | null;
  durationMs: number;
  cancelled: boolean;
}

export interface DsxStatus {
  available: boolean;
  version: string | null;
  path: string | null;
  /** `dsx run --root`（Daily Refresh）を使える版か（v0.12.0 以上）。 */
  supports_daily_refresh: boolean;
}

/** dsx のイベント出力（`--events-file`。dsx v0.13.0 以上）の終了時の要約のジョブ件数。 */
export interface ReportJobCounts {
  success: number;
  failed: number;
  skipped: number;
}

/** 失敗またはスキップしたジョブ。`status` / `code` / `kind` は dsx が値を足しうるため string。 */
export interface ReportIssue {
  phase: string;
  /** `manager` / `manager_self_update` / `repo` / `phase`（sys・repo の段階そのものの失敗）。 */
  kind: string;
  name: string;
  /** `failed` / `skipped`。 */
  status: string;
  /** `error` / `unavailable` / `pull_skipped` / `cancelled`。 */
  code: string;
  reason: string;
}

/** 警告。終了コードには影響しない。 */
export interface ReportWarning {
  phase: string;
  category: string;
  subject: string;
  message: string;
}

/** 1 回の dsx の実行の報告（`summary` イベント。commands/dsx_report.rs）。 */
export interface RunReport {
  /** `run` / `sys update` / `repo update`。 */
  command: string;
  /** dsx の終了コードが 0 だったか。 */
  ok: boolean;
  error: string | null;
  jobs: ReportJobCounts;
  /** 更新したパッケージの合計。 */
  updated: number;
  warnings: number;
  issues: ReportIssue[];
  warning_items: ReportWarning[];
}

/** Header の root 表示に使う workspace の現況（commands/config_cmd.rs）。 */
export interface WorkspaceStatus {
  /** 自動検出の root。未設定・無効化なら null。 */
  root: string | null;
  /** root を読み取れなかったときの理由。 */
  root_error: string | null;
  workspace_count: number;
  manual_count: number;
}

/** Arbor 自身の更新の確認結果（commands/updater.rs の `UpdateCheck`）。 */
export type UpdateCheck =
  /** アプリ内では更新できない（Windows の MSIX、Linux の deb など）。 */
  | { kind: 'unsupported'; reason: string }
  | { kind: 'up_to_date'; current_version: string }
  | { kind: 'available'; current_version: string; version: string; notes: string | null };

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
  workspace: Workspace;
  repositories: RepoConfig[];
}

export interface Workspace {
  /** 自動検出の root。空文字列は自動検出の無効化。 */
  root: string | null;
}

export interface Settings {
  stale_threshold_days: number;
  fetch_on_startup: boolean;
  /** 全リポジトリ共通の protected branches。 */
  protected_branches: string[];
}

export interface RepoConfig {
  path: string;
  name: string;
}

// ─── UI-only types ───────────────────────────────────────────────────────────

export type ViewId = 'status' | 'cleanup' | 'tools' | 'settings';

/** Status タブの絞り込み。 */
export type StatusFilter = 'all' | 'attention' | 'clean';

export type InsightType = 'prioritize' | 'risk';

export interface Insight {
  type: InsightType;
  /** Display label (the repo name). Not unique — use `repo_path` for identification / grouping. */
  target: string;
  /**
   * Canonical repo identifier (matches `RepoInfo.path`). Always set so
   * insights can be grouped per-repo even when names collide.
   */
  repo_path: string;
  priority: 'low' | 'medium' | 'high';
  reason: string;
}

export interface Toast {
  id: string;
  message: string;
  kind: 'success' | 'error' | 'info';
}
