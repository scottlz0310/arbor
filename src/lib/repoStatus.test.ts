import { describe, expect, it } from 'bun:test';
import { countRepos, filterRepos, needsAction, statusBadge } from './repoStatus';
import type { RepoInfo } from '../types';

function repo(name: string, overrides: Partial<RepoInfo> = {}): RepoInfo {
  return {
    path: `/src/${name}`,
    name,
    current_branch: 'main',
    ahead: 0,
    behind: 0,
    modified_count: 0,
    untracked_count: 0,
    stash_count: 0,
    is_detached: false,
    has_upstream: true,
    source: 'workspace',
    last_fetched_at: null,
    ...overrides,
  };
}

describe('needsAction / statusBadge', () => {
  it.each([
    { name: '同期済み', overrides: {}, action: false, label: '✓ clean' },
    { name: 'detached HEAD', overrides: { is_detached: true }, action: true, label: '⎇ detached' },
    { name: 'diverged', overrides: { ahead: 1, behind: 2 }, action: true, label: '⇕ diverged' },
    { name: 'ahead', overrides: { ahead: 2 }, action: true, label: '↑ ahead' },
    { name: 'behind', overrides: { behind: 3 }, action: true, label: '↓ behind' },
    { name: '未コミットの変更', overrides: { modified_count: 1 }, action: true, label: '~ dirty' },
    { name: '未追跡ファイル', overrides: { untracked_count: 2 }, action: true, label: '~ dirty' },
    { name: 'upstream が無い', overrides: { has_upstream: false }, action: true, label: '○ no upstream' },
    // 複数の状態があるときは、優先度の高い 1 つを出す
    { name: 'detached は他より優先', overrides: { is_detached: true, behind: 1, has_upstream: false }, action: true, label: '⎇ detached' },
    { name: 'behind は dirty より優先', overrides: { behind: 1, modified_count: 4 }, action: true, label: '↓ behind' },
    { name: 'dirty は no upstream より優先', overrides: { modified_count: 1, has_upstream: false }, action: true, label: '~ dirty' },
    // stash は作業ツリーの未整理とは数えない
    { name: 'stash だけ', overrides: { stash_count: 3 }, action: false, label: '✓ clean' },
  ])('$name', ({ overrides, action, label }) => {
    const target = repo('r', overrides);

    expect(needsAction(target)).toBe(action);
    expect(statusBadge(target).label).toBe(label);
  });
});

describe('filterRepos / countRepos', () => {
  const repos = [
    repo('a-clean'),
    repo('b-dirty', { modified_count: 1 }),
    repo('c-clean'),
    repo('d-behind', { behind: 2 }),
  ];

  it.each([
    { filter: 'all' as const, names: ['b-dirty', 'd-behind', 'a-clean', 'c-clean'] },
    { filter: 'attention' as const, names: ['b-dirty', 'd-behind'] },
    { filter: 'clean' as const, names: ['a-clean', 'c-clean'] },
  ])('$filter: 要対応を先頭に、同じ区分では元の順を保つ', ({ filter, names }) => {
    expect(filterRepos(repos, filter).map((r) => r.name)).toEqual([...names]);
  });

  it('件数は all = attention + clean', () => {
    expect(countRepos(repos)).toEqual({ all: 4, attention: 2, clean: 2 });
    expect(countRepos([])).toEqual({ all: 0, attention: 0, clean: 0 });
  });
});
