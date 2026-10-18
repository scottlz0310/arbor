import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, jest, beforeEach, type Mock } from 'bun:test';
import { act } from 'react';
import Overview from './Overview';
import { useRepoStore } from '../stores/repoStore';
import { useUiStore } from '../stores/uiStore';
import { useConsoleStore } from '../stores/consoleStore';

// Tauri IPC は preload (src/test/setup.ts) でモック済みのため、
// ../lib/invoke は実体のまま使用できる
const mockedTauriInvoke = tauriInvoke as Mock<typeof tauriInvoke>;

function makeRepo(overrides: Record<string, unknown> = {}) {
  return {
    path: '/repo/test',
    name: 'test-repo',
    current_branch: 'main',
    ahead: 0,
    behind: 0,
    modified_count: 0,
    untracked_count: 0,
    stash_count: 0,
    is_detached: false,
    has_upstream: true,
    source: 'workspace' as const,
    last_fetched_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  act(() => {
    useRepoStore.setState({ repos: [], selectedRepo: null });
    useUiStore.setState({ toasts: [] });
  });
});

describe('Overview — Recommended Actions', () => {
  it.each([
    { name: 'diverged', repo: { ahead: 2, behind: 3 }, text: /diverged状態/ },
    { name: 'behind が 5 以上', repo: { behind: 6 }, text: /6コミット遅れています/ },
  ])('$name のリポジトリがあるとパネルに表示される', ({ repo, text }) => {
    act(() => {
      useRepoStore.setState({ repos: [makeRepo(repo)], selectedRepo: makeRepo(repo) });
    });
    render(<Overview />);
    expect(screen.getByText('RECOMMENDED ACTIONS')).toBeTruthy();
    expect(screen.getByText(text)).toBeTruthy();
  });

  it('健全なリポジトリだけならパネルは表示されない', () => {
    act(() => {
      useRepoStore.setState({ repos: [makeRepo()], selectedRepo: makeRepo() });
    });
    render(<Overview />);
    expect(screen.queryByText('RECOMMENDED ACTIONS')).toBeNull();
  });
});

describe('Overview — リポジトリカードの状態バッジ', () => {
  it.each([
    { name: 'detached HEAD', repo: { is_detached: true }, label: '⎇ detached' },
    { name: 'diverged', repo: { ahead: 1, behind: 2 }, label: '⇕ diverged' },
    { name: 'ahead', repo: { ahead: 2 }, label: '↑ ahead' },
    { name: 'behind', repo: { behind: 3 }, label: '↓ behind' },
    { name: 'upstream が無い', repo: { has_upstream: false }, label: '○ no upstream' },
    { name: '同期済み', repo: {}, label: '✓ clean' },
    // detached は upstream の有無より優先する
    { name: 'detached かつ upstream なし', repo: { is_detached: true, has_upstream: false }, label: '⎇ detached' },
  ])('$name → $label', ({ repo, label }) => {
    act(() => {
      useRepoStore.setState({ repos: [makeRepo(repo)], selectedRepo: null });
    });

    render(<Overview />);

    expect(screen.getByText(label)).toBeTruthy();
  });
});

describe('Overview — Fetch All', () => {
  it('リポジトリを選んでいなくても Fetch All を押せる', async () => {
    act(() => {
      useRepoStore.setState({ repos: [makeRepo()], selectedRepo: null });
    });
    render(<Overview />);

    const button = screen.getByRole('button', { name: /Fetch All/ });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(button);

    expect(mockedTauriInvoke).toHaveBeenCalledWith('fetch_repositories');
  });

  it('別のコマンドを実行中は Fetch All を押せない', () => {
    act(() => {
      useConsoleStore.getState().handleStarted({
        runId: 1, label: 'dsx repo update', argv: [], startedAt: 0,
      });
    });
    render(<Overview />);

    const button = screen.getByRole('button', { name: /Fetch All/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
