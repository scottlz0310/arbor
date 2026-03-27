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
  BranchInfo,
  CheckRun,
  CommitNode,
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
  githubOwner?: string;
  githubRepo?: string;
}) => tauriInvoke<AppConfig>('add_repository', args);

export const removeRepository = (path: string) =>
  tauriInvoke<AppConfig>('remove_repository', { path });

export const updateRepositoryGithub = (args: {
  path: string;
  githubOwner: string | null;
  githubRepo: string | null;
}) => tauriInvoke<AppConfig>('update_repository_github', args);

export const detectGithubRemote = (path: string) =>
  tauriInvoke<[string | null, string | null]>('detect_github_remote', { path });

export const scanDirectory = (root: string) =>
  tauriInvoke<string[]>('scan_directory', { root });

export const updateSettings = (args: {
  staleThresholdDays?: number;
  fetchOnStartup?: boolean;
}) => tauriInvoke<AppConfig>('update_settings', args);

// ─── Repo / git2 ─────────────────────────────────────────────────────────────

export const listRepositories = () =>
  tauriInvoke<RepoInfo[]>('list_repositories');

export const getRepoStatus = (repoPath: string) =>
  tauriInvoke<RepoInfo>('get_repo_status', { repoPath });

export const getBranches = (repoPath: string) =>
  tauriInvoke<BranchInfo[]>('get_branches', { repoPath });

export const deleteBranches = (repoPath: string, names: string[]) =>
  tauriInvoke<DeleteResult[]>('delete_branches', { repoPath, names });

export const fetchAll = (repoPath: string) =>
  tauriInvoke<FetchResult>('fetch_all', { repoPath });

export const getCommitGraph = (repoPath: string, limit?: number) =>
  tauriInvoke<CommitNode[]>('get_commit_graph', { repoPath, limit });

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
export const getCheckRuns = (owner: string, repo: string, gitRef: string) =>
  tauriInvoke<CheckRun[]>('get_check_runs', { owner, repo, gitRef });

// ─── dsx ─────────────────────────────────────────────────────────────────────

export const dsxCheck = () =>
  tauriInvoke<DsxStatus>('dsx_check');

export const repoUpdate = (repoPath: string) =>
  tauriInvoke<DsxOutput>('repo_update', { repoPath });

export const repoCleanupPreview = (repoPath: string) =>
  tauriInvoke<DsxOutput>('repo_cleanup_preview', { repoPath });

export const repoCleanup = (repoPath: string) =>
  tauriInvoke<DsxOutput>('repo_cleanup', { repoPath });

export const envInject = (repoPath: string, cmd: string) =>
  tauriInvoke<DsxOutput>('env_inject', { repoPath, cmd });

export const sysUpdate = () =>
  tauriInvoke<DsxOutput>('sys_update');
