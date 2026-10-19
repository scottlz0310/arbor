import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'bun:test';
import { act } from 'react';
import TabBar from './TabBar';
import { useCleanupStore } from '../stores/cleanupStore';
import { useRepoStore } from '../stores/repoStore';
import { useUiStore } from '../stores/uiStore';
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

const tab = (name: RegExp) => screen.getByRole('tab', { name });

beforeEach(() => {
  act(() => {
    useRepoStore.setState({ repos: [repo('a'), repo('b', { behind: 1 }), repo('c', { modified_count: 2 })] });
    useUiStore.setState({ activeView: 'status' });
  });
});

describe('TabBar', () => {
  it('現在のビューのタブだけが選択状態になる', () => {
    render(<TabBar />);

    expect(tab(/Repository Status/).getAttribute('aria-selected')).toBe('true');
    expect(tab(/Branch Cleanup/).getAttribute('aria-selected')).toBe('false');
  });

  it('タブを押すとそのビューへ移動する', async () => {
    render(<TabBar />);

    await userEvent.click(tab(/Branch Cleanup/));
    expect(useUiStore.getState().activeView).toBe('cleanup');

    await userEvent.click(tab(/dsx Tools/));
    expect(useUiStore.getState().activeView).toBe('tools');

    await userEvent.click(tab(/Repository Status/));
    expect(useUiStore.getState().activeView).toBe('status');
  });

  it('Status には要対応の件数、Cleanup には読み込み済みの候補数をバッジで出す', () => {
    act(() => useCleanupStore.setState({ candidateCount: 5 }));

    render(<TabBar />);

    expect(tab(/Repository Status/).textContent).toContain('2');
    expect(tab(/Branch Cleanup/).textContent).toContain('5');
  });

  it.each([
    { name: '要対応が無い', repos: [repo('a')], count: null },
    { name: '候補が 0 件', repos: [repo('a')], count: 0 },
    { name: '候補が未集計', repos: [repo('a')], count: null },
  ])('$name ときはバッジを出さない', ({ repos, count }) => {
    act(() => {
      useRepoStore.setState({ repos: [...repos] });
      useCleanupStore.setState({ candidateCount: count });
    });

    render(<TabBar />);

    expect(tab(/Repository Status/).textContent).toBe('Repository Status');
    expect(tab(/Branch Cleanup/).textContent).toBe('Branch Cleanup');
    expect(tab(/dsx Tools/).textContent).toBe('dsx Tools');
  });
});
