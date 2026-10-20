/**
 * Type-safe wrappers around @tauri-apps/api/core `invoke`.
 * All commands mirror the Tauri command names in src-tauri/src/commands/.
 *
 * NOTE: Tauri v2 IPC converts camelCase (JS) ↔ snake_case (Rust) automatically.
 * All multi-word argument keys must be camelCase on the JS side.
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type {
  AppConfig,
  CleanupCandidate,
  CleanupExecutionResult,
  CleanupPreview,
  DsxOutput,
  DsxStatus,
  FetchResult,
  FetchSummary,
  RemoteCheckSummary,
  RepoConfig,
  RepoInfo,
  RunReport,
  UpdateCheck,
  WorkspaceStatus,
} from '../types';

// ─── Config ──────────────────────────────────────────────────────────────────

export const getConfig = () =>
  tauriInvoke<AppConfig>('get_config');

export const addRepository = (args: {
  path: string;
  name: string;
}) => tauriInvoke<AppConfig>('add_repository', args);

export const removeRepository = (path: string) =>
  tauriInvoke<AppConfig>('remove_repository', { path });

export const scanMissingRepositories = () =>
  tauriInvoke<RepoConfig[]>('scan_missing_repositories');

export const updateSettings = (args: {
  staleThresholdDays?: number;
  fetchOnStartup?: boolean;
  /** 自動検出の root。空文字列で無効化。 */
  workspaceRoot?: string;
}) => tauriInvoke<AppConfig>('update_settings', args);

export const getWorkspaceStatus = () =>
  tauriInvoke<WorkspaceStatus>('get_workspace_status');

// ─── Repo / git2 ─────────────────────────────────────────────────────────────

export const listRepositories = () =>
  tauriInvoke<RepoInfo[]>('list_repositories');

export const getRepoStatus = (repoPath: string) =>
  tauriInvoke<RepoInfo>('get_repo_status', { repoPath });

export const openRepoFolder = (repoPath: string) =>
  tauriInvoke<void>('open_repo_folder', { repoPath });

export const fetchAll = (repoPath: string) =>
  tauriInvoke<FetchResult>('fetch_all', { repoPath });

/** 管理対象の全リポジトリを fetch する。進捗は `process_*` イベントで流れ、`cancelRun` で中断できる。 */
export const fetchRepositories = () =>
  tauriInvoke<FetchSummary>('fetch_repositories');

/** 管理対象の全リポジトリの、リモートの状態（アーカイブ済み・移転・見つからない）を確認する。進捗は `process_*` イベントで流れ、`cancelRun` で中断できる。 */
export const checkRemotes = () =>
  tauriInvoke<RemoteCheckSummary>('check_remotes');

// ─── Cleanup Wizard ─────────────────────────────────────────────────────────

export const cleanupPreview = () =>
  tauriInvoke<CleanupPreview>('cleanup_preview');

export const cleanupExecute = (candidates: CleanupCandidate[]) =>
  tauriInvoke<CleanupExecutionResult>('cleanup_execute', { request: { candidates } });

// ─── dsx ─────────────────────────────────────────────────────────────────────

export const dsxCheck = () =>
  tauriInvoke<DsxStatus>('dsx_check');

export const dsxLatestVersion = () =>
  tauriInvoke<string | null>('dsx_latest_version');

/** workspace root 配下の全リポジトリを `dsx repo update --root` で更新する。 */
export const repoUpdate = () =>
  tauriInvoke<DsxOutput>('repo_update');

/** `dsx run --root`: システム更新 → リポジトリ更新。dsx v0.12.0 以上が必要。 */
export const dailyRefresh = () =>
  tauriInvoke<DsxOutput>('daily_refresh');

export const envInject = (repoPath: string, cmd: string) =>
  tauriInvoke<DsxOutput>('env_inject', { repoPath, cmd });

export const sysUpdate = () =>
  tauriInvoke<DsxOutput>('sys_update');

/** `dsx sys update -n`: 実際の更新は行わず、計画だけを表示する。 */
export const sysUpdateDryRun = () =>
  tauriInvoke<DsxOutput>('sys_update_dry_run');

/** `dsx doctor`: dsx が依存するツールと環境を診断する。 */
export const dsxDoctor = () =>
  tauriInvoke<DsxOutput>('dsx_doctor');

export const dsxSelfUpdate = () =>
  tauriInvoke<DsxOutput>('dsx_self_update');

/**
 * 直近の dsx の実行の報告（警告・スキップ・失敗の内訳）を取り出す。取り出したら空になる。
 * 実行が失敗した場合も、dsx がイベントを書き終えていれば報告がある。dsx v0.13.0 未満では常に null。
 */
export const takeRunReport = () =>
  tauriInvoke<RunReport | null>('take_run_report');

export const cancelRun = (runId: number) =>
  tauriInvoke<void>('cancel_run', { runId });

// ─── Arbor 自身の更新 ────────────────────────────────────────────────────────

/** リリースの `latest.json` で、Arbor の新しい版の有無を調べる（macOS と Linux の AppImage 向け）。 */
export const updaterCheck = () =>
  tauriInvoke<UpdateCheck>('updater_check');

/** 新しい版をダウンロードして適用する。成功するとアプリは再起動する。 */
export const updaterInstall = () =>
  tauriInvoke<void>('updater_install');
