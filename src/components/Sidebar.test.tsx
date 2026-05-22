import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from 'react';
import Sidebar from './Sidebar';
import { useRepoStore } from '../stores/repoStore';
import { useUiStore } from '../stores/uiStore';

function makeRepo(path: string, name: string) {
  return {
    path, name,
    current_branch: 'main',
    ahead: 0, behind: 0,
    modified_count: 0, untracked_count: 0, stash_count: 0,
    github_owner: null, github_repo: null, last_fetched_at: null,
  };
}

beforeEach(() => {
  act(() => {
    useRepoStore.setState({ repos: [], selectedRepo: null });
    useUiStore.setState({ activeView: 'overview', navigate: vi.fn() });
  });
});

describe('Sidebar — ナビゲーション ARIA', () => {
  it('<nav> に aria-label="ナビゲーション" が付与されている', () => {
    render(<Sidebar />);
    expect(screen.getByRole('navigation', { name: 'ナビゲーション' })).toBeInTheDocument();
  });

  it('アクティブなビューのボタンに aria-current="page" が付与されている', () => {
    act(() => { useUiStore.setState({ activeView: 'branches' }); });
    render(<Sidebar />);
    const activeBtn = screen.getByRole('button', { name: 'Branches' });
    expect(activeBtn).toHaveAttribute('aria-current', 'page');
  });

  it('非アクティブなビューのボタンには aria-current が付与されない', () => {
    act(() => { useUiStore.setState({ activeView: 'overview' }); });
    render(<Sidebar />);
    const inactiveBtn = screen.getByRole('button', { name: 'Branches' });
    expect(inactiveBtn).not.toHaveAttribute('aria-current');
  });
});

describe('Sidebar — リポジトリ一覧 ARIA', () => {
  it('リポジトリ一覧 region に aria-label が付与されている', () => {
    render(<Sidebar />);
    expect(screen.getByRole('region', { name: 'リポジトリ一覧' })).toBeInTheDocument();
  });

  it('選択済みリポジトリのボタンに aria-pressed="true" が付与されている', () => {
    const repo = makeRepo('/repo/a', 'my-repo');
    act(() => { useRepoStore.setState({ repos: [repo], selectedRepo: repo }); });
    render(<Sidebar />);
    const btn = screen.getByRole('button', { name: 'my-repo' });
    expect(btn).toHaveAttribute('aria-pressed', 'true');
  });

  it('未選択リポジトリのボタンに aria-pressed="false" が付与されている', () => {
    const repo = makeRepo('/repo/a', 'my-repo');
    act(() => { useRepoStore.setState({ repos: [repo], selectedRepo: null }); });
    render(<Sidebar />);
    const btn = screen.getByRole('button', { name: 'my-repo' });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
  });

  it('リポジトリボタンクリックで selectRepo が呼ばれる', async () => {
    const mockSelectRepo = vi.fn();
    const repo = makeRepo('/repo/a', 'my-repo');
    act(() => { useRepoStore.setState({ repos: [repo], selectedRepo: null, selectRepo: mockSelectRepo }); });
    render(<Sidebar />);
    await userEvent.click(screen.getByRole('button', { name: 'my-repo' }));
    expect(mockSelectRepo).toHaveBeenCalledWith(repo);
  });
});
