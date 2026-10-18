import type { RepoInfo, StatusFilter } from '../types';

export interface StatusBadge {
  label: string;
  bg: string;
  color: string;
}

/**
 * 手を入れる必要があるか（branch-chk の DETACHED / DIRTY / AHEAD / BEHIND / DIVERGED / no-upstream）。
 * upstream が無いと ahead / behind は 0 になり、同期済みに見えてしまうため、no upstream も対象にする。
 */
export function needsAction(repo: RepoInfo): boolean {
  return (
    repo.is_detached
    || repo.ahead > 0
    || repo.behind > 0
    || repo.modified_count + repo.untracked_count > 0
    || !repo.has_upstream
  );
}

/** 最も優先度の高い状態を 1 つ返す（detached > diverged > ahead > behind > dirty > no upstream > clean）。 */
export function statusBadge(repo: RepoInfo): StatusBadge {
  if (repo.is_detached) return { label: '⎇ detached', bg: 'var(--amber-bg)', color: 'var(--amber)' };
  if (repo.ahead > 0 && repo.behind > 0) return { label: '⇕ diverged', bg: 'var(--red-bg)', color: 'var(--red)' };
  if (repo.ahead > 0) return { label: '↑ ahead', bg: 'var(--green-bg)', color: 'var(--green)' };
  if (repo.behind > 0) return { label: '↓ behind', bg: 'var(--purple-bg)', color: 'var(--purple)' };
  if (repo.modified_count + repo.untracked_count > 0) {
    return { label: '~ dirty', bg: 'var(--amber-bg)', color: 'var(--amber)' };
  }
  if (!repo.has_upstream) return { label: '○ no upstream', bg: '#1e2336', color: 'var(--text3)' };
  return { label: '✓ clean', bg: '#1e2336', color: 'var(--text3)' };
}

/** 絞り込み後の一覧。要対応を先頭に、同じ区分の中では元の順（名前順）を保つ。 */
export function filterRepos(repos: RepoInfo[], filter: StatusFilter): RepoInfo[] {
  const attention = repos.filter(needsAction);
  const clean = repos.filter((repo) => !needsAction(repo));
  if (filter === 'attention') return attention;
  if (filter === 'clean') return clean;
  return [...attention, ...clean];
}

export function countRepos(repos: RepoInfo[]): Record<StatusFilter, number> {
  const attention = repos.filter(needsAction).length;
  return { all: repos.length, attention, clean: repos.length - attention };
}
