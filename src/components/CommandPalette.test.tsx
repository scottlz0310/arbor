import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';
import { act } from 'react';
import CommandPalette from './CommandPalette';
import { useRepoStore } from '../stores/repoStore';
import { useUiStore } from '../stores/uiStore';
import * as invoke from '../lib/invoke';

const mockNavigate            = mock();
const mockSelectRepo          = mock();
const mockRefreshRepo         = mock();
const mockLoadRepos           = mock();
const mockCloseCommandPalette = mock();
const mockAddToast            = mock();
const mockFetchAll            = spyOn(invoke, 'fetchAll');
const mockRepoUpdate          = spyOn(invoke, 'repoUpdate');

// module export への spy をファイル外へ漏らさない
afterAll(() => {
  mock.restore();
});

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
  jest.clearAllMocks();
  mockFetchAll.mockResolvedValue({ updated_refs: [] });
  mockRepoUpdate.mockResolvedValue({ stdout: '', stderr: '', exit_code: 0 });
  mockRefreshRepo.mockResolvedValue(undefined);
  mockLoadRepos.mockResolvedValue(undefined);
  act(() => {
    useRepoStore.setState({
      repos: [], selectedRepo: null,
      selectRepo: mockSelectRepo, refreshRepo: mockRefreshRepo, loadRepos: mockLoadRepos,
    });
    useUiStore.setState({
      navigate: mockNavigate,
      closeCommandPalette: mockCloseCommandPalette,
      addToast: mockAddToast,
      commandPaletteOpen: true,
    });
  });
});

function renderPalette() {
  return render(<CommandPalette />);
}

describe('CommandPalette — 表示', () => {
  it('検索インプットが自動フォーカスされる', () => {
    renderPalette();
    expect(document.activeElement?.tagName).toBe('INPUT');
  });

  it('ビューコマンドが全件表示される', () => {
    renderPalette();
    expect(screen.getByText('Overview へ移動')).toBeTruthy();
    expect(screen.getByText('Branches へ移動')).toBeTruthy();
    expect(screen.getByText('Stash へ移動')).toBeTruthy();
    expect(screen.getByText('Settings へ移動')).toBeTruthy();
  });

  it('リポジトリコマンドが表示される', () => {
    act(() => {
      useRepoStore.setState({ repos: [makeRepo('/repo/a', 'my-repo')] });
    });
    renderPalette();
    expect(screen.getByText('my-repo')).toBeTruthy();
  });
});

describe('CommandPalette — フィルタリング', () => {
  it('クエリに一致するコマンドのみ表示される', async () => {
    renderPalette();
    await userEvent.type(screen.getByRole('combobox'), 'branch');
    expect(screen.getByText('Branches へ移動')).toBeTruthy();
    expect(screen.queryByText('Overview へ移動')).toBeNull();
  });

  it('一致なしのとき「一致するコマンドが見つかりません」を表示する', async () => {
    renderPalette();
    await userEvent.type(screen.getByRole('combobox'), 'xyznotexist');
    expect(screen.getByText(/一致するコマンドが見つかりません/)).toBeTruthy();
  });

  it('リポジトリ名でフィルタできる', async () => {
    act(() => {
      useRepoStore.setState({ repos: [makeRepo('/repo/arbor', 'arbor'), makeRepo('/repo/other', 'other-proj')] });
    });
    renderPalette();
    await userEvent.type(screen.getByRole('combobox'), 'arbor');
    expect(screen.getByText('arbor')).toBeTruthy();
    expect(screen.queryByText('other-proj')).toBeNull();
  });
});

describe('CommandPalette — キーボード操作', () => {
  it('Escape で closeCommandPalette が呼ばれる', async () => {
    renderPalette();
    await userEvent.keyboard('{Escape}');
    expect(mockCloseCommandPalette).toHaveBeenCalledTimes(1);
  });

  it('Enter でアクティブなコマンドが実行される', async () => {
    renderPalette();
    // 最初のコマンド (Overview へ移動) が選択されている
    await userEvent.keyboard('{Enter}');
    expect(mockNavigate).toHaveBeenCalledWith('overview');
    expect(mockCloseCommandPalette).toHaveBeenCalled();
  });

  it('↓ キーで次のコマンドへ移動し Enter で実行される', async () => {
    renderPalette();
    await userEvent.keyboard('{ArrowDown}{Enter}');
    // 2番目のコマンドは Branches
    expect(mockNavigate).toHaveBeenCalledWith('branches');
  });

  it('↑ キーで前のコマンドへ移動する', async () => {
    renderPalette();
    // 2つ下へ → 1つ上へ → 2番目が選択される
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}{Enter}');
    expect(mockNavigate).toHaveBeenCalledWith('branches');
  });
});

describe('CommandPalette — マウス操作', () => {
  it('コマンドクリックで実行される', async () => {
    renderPalette();
    await userEvent.click(screen.getByText('Cleanup へ移動'));
    expect(mockNavigate).toHaveBeenCalledWith('cleanup');
    expect(mockCloseCommandPalette).toHaveBeenCalled();
  });

  it('リポジトリクリックで selectRepo が呼ばれる', async () => {
    const repo = makeRepo('/repo/a', 'test-repo');
    act(() => { useRepoStore.setState({ repos: [repo] }); });
    renderPalette();
    await userEvent.click(screen.getByText('test-repo'));
    expect(mockSelectRepo).toHaveBeenCalledWith(repo);
    expect(mockCloseCommandPalette).toHaveBeenCalled();
  });

  it('オーバーレイクリックで closeCommandPalette が呼ばれる', async () => {
    renderPalette();
    // role="dialog" の外側（オーバーレイ）をクリック
    await userEvent.click(screen.getByRole('dialog'));
    expect(mockCloseCommandPalette).toHaveBeenCalled();
  });
});

describe('CommandPalette — 境界ケース', () => {
  it('↑ キーは先頭で 0 のまま', async () => {
    renderPalette();
    await userEvent.keyboard('{ArrowUp}{Enter}');
    expect(mockNavigate).toHaveBeenCalledWith('overview');
  });

  it('↓ キーは末尾を超えない', async () => {
    renderPalette();
    // ビュー 7 件を超えて押す
    for (let i = 0; i < 20; i++) {
      await userEvent.keyboard('{ArrowDown}');
    }
    await userEvent.keyboard('{Enter}');
    // 最後のコマンドが実行される（undefined にならない）
    expect(mockNavigate).toHaveBeenCalled();
  });

  it('query 変更時にカーソルが 0 にリセットされる', async () => {
    renderPalette();
    // Branches (index 1) に移動してから絞り込む
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.type(screen.getByRole('combobox'), 'clean');
    // Cleanup がトップに来るのでそのまま Enter
    await userEvent.keyboard('{Enter}');
    expect(mockNavigate).toHaveBeenCalledWith('cleanup');
  });

  it('結果 0 件のとき ArrowDown/Enter は何もしない', async () => {
    renderPalette();
    await userEvent.type(screen.getByRole('combobox'), 'xyznotexist');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockCloseCommandPalette).not.toHaveBeenCalled();
  });
});

describe('CommandPalette — アクションコマンド', () => {
  const repo = makeRepo('/repo/a', 'my-repo');

  beforeEach(() => {
    act(() => { useRepoStore.setState({ repos: [repo], selectedRepo: repo }); });
  });

  it('selectedRepo があるとき Fetch コマンドが表示される', () => {
    renderPalette();
    expect(screen.getByText('Fetch: my-repo')).toBeTruthy();
  });

  it('selectedRepo があるとき dsx Update コマンドが表示される', () => {
    renderPalette();
    expect(screen.getByText('dsx Update: my-repo')).toBeTruthy();
  });

  it('Fetch コマンドクリックで fetchAll と refreshRepo が呼ばれる', async () => {
    renderPalette();
    await userEvent.click(screen.getByText('Fetch: my-repo'));
    expect(mockCloseCommandPalette).toHaveBeenCalled();
    expect(mockFetchAll).toHaveBeenCalledWith('/repo/a');
    expect(mockRefreshRepo).toHaveBeenCalledWith('/repo/a');
  });

  it('dsx Update コマンドクリックで repoUpdate と loadRepos が呼ばれる', async () => {
    renderPalette();
    await userEvent.click(screen.getByText('dsx Update: my-repo'));
    expect(mockCloseCommandPalette).toHaveBeenCalled();
    expect(mockRepoUpdate).toHaveBeenCalledWith('/repo/a');
    expect(mockLoadRepos).toHaveBeenCalled();
  });

  it('selectedRepo がないとき Fetch/Update コマンドは表示されない', () => {
    act(() => { useRepoStore.setState({ selectedRepo: null }); });
    renderPalette();
    expect(screen.queryByText(/Fetch:/)).toBeNull();
    expect(screen.queryByText(/dsx Update:/)).toBeNull();
  });
});

