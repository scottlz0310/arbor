import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';
import Overview from './Overview';
import { useRepoStore } from '../stores/repoStore';
import { useUiStore } from '../stores/uiStore';

// Tauri invoke は jsdom 環境では使用不可のためモック
vi.mock('../lib/invoke', () => ({
  fetchAll: vi.fn(),
  repoUpdate: vi.fn(),
}));

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
    github_owner: null,
    github_repo: null,
    last_fetched_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  act(() => {
    useRepoStore.setState({ repos: [], selectedRepo: null });
    useUiStore.setState({ toasts: [], dsxProgress: [], dsxRunning: false });
  });
});

describe('Overview — dsx ログパネル', () => {
  it('dsxProgress が空かつ dsxRunning が false のときパネルは非表示', () => {
    act(() => {
      useRepoStore.setState({ repos: [makeRepo()], selectedRepo: makeRepo() });
      useUiStore.setState({ dsxProgress: [], dsxRunning: false });
    });
    render(<Overview />);
    expect(screen.queryByText('dsx output')).toBeNull();
  });

  it('dsxRunning が true のときパネルが表示され spinner タイトルになる', () => {
    act(() => {
      useRepoStore.setState({ repos: [makeRepo()], selectedRepo: makeRepo() });
      useUiStore.setState({ dsxProgress: [], dsxRunning: true });
    });
    render(<Overview />);
    expect(screen.getByText('⟳ dsx output…')).toBeTruthy();
  });

  it('dsxProgress に行がある場合パネルが表示される', () => {
    act(() => {
      useRepoStore.setState({ repos: [makeRepo()], selectedRepo: makeRepo() });
      useUiStore.setState({ dsxProgress: ['fetch complete', 'pull done'], dsxRunning: false });
    });
    render(<Overview />);
    expect(screen.getByText('dsx output')).toBeTruthy();
    expect(screen.getByText('fetch complete')).toBeTruthy();
    expect(screen.getByText('pull done')).toBeTruthy();
  });

  it('pull スキップ行（スキップ）がアンバー色でレンダリングされる', () => {
    act(() => {
      useRepoStore.setState({ repos: [makeRepo()], selectedRepo: makeRepo() });
      useUiStore.setState({
        dsxProgress: ['✅ repo-a', 'pull スキップ: 1 件', '- repo-b'],
        dsxRunning: false,
      });
    });
    render(<Overview />);

    const skipLine = screen.getByText('pull スキップ: 1 件');
    expect(skipLine.style.color).toBe('var(--amber)');

    // スキップキーワードを含まない行は通常色
    const normalLine = screen.getByText('✅ repo-a');
    expect(normalLine.style.color).toBe('var(--text2)');
  });

  it('skip（英語）を含む行もアンバー色になる', () => {
    act(() => {
      useRepoStore.setState({ repos: [makeRepo()], selectedRepo: makeRepo() });
      useUiStore.setState({ dsxProgress: ['pull skip: arbor'], dsxRunning: false });
    });
    render(<Overview />);
    const skipLine = screen.getByText('pull skip: arbor');
    expect(skipLine.style.color).toBe('var(--amber)');
  });

  it('dsxRunning が false のとき Clear ボタンが表示される', () => {
    act(() => {
      useRepoStore.setState({ repos: [makeRepo()], selectedRepo: makeRepo() });
      useUiStore.setState({ dsxProgress: ['some output'], dsxRunning: false });
    });
    render(<Overview />);
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy();
  });

  it('Clear ボタンをクリックすると dsxProgress がクリアされてパネルが消える', () => {
    act(() => {
      useRepoStore.setState({ repos: [makeRepo()], selectedRepo: makeRepo() });
      useUiStore.setState({ dsxProgress: ['some output'], dsxRunning: false });
    });
    render(<Overview />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(useUiStore.getState().dsxProgress).toHaveLength(0);
  });

  it('dsxRunning が true のとき Clear ボタンは非表示', () => {
    act(() => {
      useRepoStore.setState({ repos: [makeRepo()], selectedRepo: makeRepo() });
      useUiStore.setState({ dsxProgress: ['running…'], dsxRunning: true });
    });
    render(<Overview />);
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
  });
});
