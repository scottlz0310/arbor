/**
 * Type-safe wrappers around @tauri-apps/api/core `invoke`.
 * All commands mirror the Tauri command names in src-tauri/src/commands/.
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type {
  AppConfig,
  BranchInfo,
  DeleteResult,
  DsxOutput,
  DsxStatus,
  FetchResult,
  RepoInfo,
} from '../types';

// ─── Config ──────────────────────────────────────────────────────────────────

export const getConfig = () =>
  tauriInvoke<AppConfig>('get_config');

export const addRepository = (args: {
  path: string;
  name: string;
  github_owner?: string;
  github_repo?: string;
}) => tauriInvoke<AppConfig>('add_repository', args);

export const removeRepository = (path: string) =>
  tauriInvoke<AppConfig>('remove_repository', { path });

export const scanDirectory = (root: string) =>
  tauriInvoke<string[]>('scan_directory', { root });

export const updateSettings = (args: {
  stale_threshold_days?: number;
  fetch_on_startup?: boolean;
}) => tauriInvoke<AppConfig>('update_settings', args);

// ─── Repo / git2 ─────────────────────────────────────────────────────────────

export const listRepositories = () =>
  tauriInvoke<RepoInfo[]>('list_repositories');

export const getRepoStatus = (repo_path: string) =>
  tauriInvoke<RepoInfo>('get_repo_status', { repo_path });

export const getBranches = (repo_path: string) =>
  tauriInvoke<BranchInfo[]>('get_branches', { repo_path });

export const deleteBranches = (repo_path: string, names: string[]) =>
  tauriInvoke<DeleteResult[]>('delete_branches', { repo_path, names });

export const fetchAll = (repo_path: string) =>
  tauriInvoke<FetchResult>('fetch_all', { repo_path });

// ─── dsx ─────────────────────────────────────────────────────────────────────

export const dsxCheck = () =>
  tauriInvoke<DsxStatus>('dsx_check');

export const repoUpdate = (repo_path: string) =>
  tauriInvoke<DsxOutput>('repo_update', { repo_path });

export const repoCleanupPreview = (repo_path: string) =>
  tauriInvoke<DsxOutput>('repo_cleanup_preview', { repo_path });

export const repoCleanup = (repo_path: string) =>
  tauriInvoke<DsxOutput>('repo_cleanup', { repo_path });
