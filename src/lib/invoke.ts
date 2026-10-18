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
  RepoConfig,
  RepoInfo,
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

export const scanDirectory = (root: string) =>
  tauriInvoke<string[]>('scan_directory', { root });

export const scanMissingRepositories = () =>
  tauriInvoke<RepoConfig[]>('scan_missing_repositories');

export const updateSettings = (args: {
  staleThresholdDays?: number;
  fetchOnStartup?: boolean;
}) => tauriInvoke<AppConfig>('update_settings', args);

// ─── Repo / git2 ─────────────────────────────────────────────────────────────

export const listRepositories = () =>
  tauriInvoke<RepoInfo[]>('list_repositories');

export const getRepoStatus = (repoPath: string) =>
  tauriInvoke<RepoInfo>('get_repo_status', { repoPath });

export const fetchAll = (repoPath: string) =>
  tauriInvoke<FetchResult>('fetch_all', { repoPath });

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

export const repoUpdate = (repoPath: string) =>
  tauriInvoke<DsxOutput>('repo_update', { repoPath });

export const envInject = (repoPath: string, cmd: string) =>
  tauriInvoke<DsxOutput>('env_inject', { repoPath, cmd });

export const sysUpdate = () =>
  tauriInvoke<DsxOutput>('sys_update');

export const dsxSelfUpdate = () =>
  tauriInvoke<DsxOutput>('dsx_self_update');
