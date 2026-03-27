/**
 * Type-safe wrappers around @tauri-apps/api/core `invoke`.
 * All commands mirror the Tauri command names in src-tauri/src/commands/.
 */
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type {
  AppConfig,
  BranchInfo,
  CheckRun,
  DeleteResult,
  DsxOutput,
  DsxStatus,
  FetchResult,
  Issue,
  PullRequest,
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

// ─── GitHub PAT ──────────────────────────────────────────────────────────────

export const setGithubPat = (pat: string) =>
  tauriInvoke<void>('set_github_pat', { pat });

/** Returns true if a PAT is stored. The secret value never crosses the IPC boundary. */
export const hasGithubPat = () =>
  tauriInvoke<boolean>('has_github_pat');

export const deleteGithubPat = () =>
  tauriInvoke<void>('delete_github_pat');

// ─── GitHub API ──────────────────────────────────────────────────────────────

/** `state`: "open" | "closed" | "all" (default: "open") */
export const getPullRequests = (owner: string, repo: string, state?: string) =>
  tauriInvoke<PullRequest[]>('get_pull_requests', { owner, repo, state });

/** `state`: "open" | "closed" | "all" (default: "open"). PRs are excluded. */
export const getIssues = (owner: string, repo: string, state?: string) =>
  tauriInvoke<Issue[]>('get_issues', { owner, repo, state });

/** Returns check runs for the given branch name or commit SHA. */
export const getCheckRuns = (owner: string, repo: string, git_ref: string) =>
  tauriInvoke<CheckRun[]>('get_check_runs', { owner, repo, git_ref });

// ─── dsx ─────────────────────────────────────────────────────────────────────

export const dsxCheck = () =>
  tauriInvoke<DsxStatus>('dsx_check');

export const repoUpdate = (repo_path: string) =>
  tauriInvoke<DsxOutput>('repo_update', { repo_path });

export const repoCleanupPreview = (repo_path: string) =>
  tauriInvoke<DsxOutput>('repo_cleanup_preview', { repo_path });

export const repoCleanup = (repo_path: string) =>
  tauriInvoke<DsxOutput>('repo_cleanup', { repo_path });
