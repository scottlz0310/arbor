import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';
import { act } from 'react';
import Stash from './Stash';
import { useRepoStore } from '../stores/repoStore';
import { useUiStore } from '../stores/uiStore';
import * as invoke from '../lib/invoke';

const mockListStashes = spyOn(invoke, 'listStashes');
const mockApplyStash  = spyOn(invoke, 'applyStash');
const mockDropStash   = spyOn(invoke, 'dropStash');
const mockLoadRepos   = mock();

// module export への spy をファイル外へ漏らさない
afterAll(() => {
  mock.restore();
});

function makeRepo(path = '/repo/a', name = 'repo-a') {
  return {
    path, name,
    current_branch: 'main',
    ahead: 0, behind: 0,
    modified_count: 0, untracked_count: 0, stash_count: 2,
    github_owner: null, github_repo: null, last_fetched_at: null,
  };
}

function makeStash(index: number, message = `stash entry ${index}`) {
  return { index, message, commit_id: `abc123${index}def456` };
}

function renderStash() {
  return render(<Stash />);
}

beforeEach(() => {
  jest.clearAllMocks();
  act(() => {
    useRepoStore.setState({ repos: [], selectedRepo: null, loadRepos: mockLoadRepos });
    useUiStore.setState({ toasts: [] });
  });
  mockListStashes.mockResolvedValue([]);
  mockApplyStash.mockResolvedValue(undefined);
  mockDropStash.mockResolvedValue(undefined);
  mockLoadRepos.mockResolvedValue(undefined);
});

describe('Stash — リポジトリ未選択', () => {
  it('案内メッセージを表示する', () => {
    renderStash();
    expect(screen.getByText(/サイドバーからリポジトリを選択/)).toBeTruthy();
  });

  it('listStashes を呼ばない', () => {
    renderStash();
    expect(mockListStashes).not.toHaveBeenCalled();
  });
});

describe('Stash — スタッシュなし', () => {
  it('"スタッシュはありません" を表示する', async () => {
    act(() => { useRepoStore.setState({ selectedRepo: makeRepo() }); });
    renderStash();
    await waitFor(() => {
      expect(screen.getByText(/スタッシュはありません/)).toBeTruthy();
    });
  });
});

describe('Stash — スタッシュ一覧', () => {
  beforeEach(() => {
    mockListStashes.mockResolvedValue([makeStash(0), makeStash(1)]);
    act(() => { useRepoStore.setState({ selectedRepo: makeRepo() }); });
  });

  it('stash エントリが表示される', async () => {
    renderStash();
    await waitFor(() => {
      expect(screen.getByText('stash entry 0')).toBeTruthy();
      expect(screen.getByText('stash entry 1')).toBeTruthy();
    });
  });

  it('各行に Apply / Drop ボタンがある', async () => {
    renderStash();
    await waitFor(() => {
      const applies = screen.getAllByRole('button', { name: 'Apply' });
      const drops   = screen.getAllByRole('button', { name: 'Drop' });
      expect(applies).toHaveLength(2);
      expect(drops).toHaveLength(2);
    });
  });
});

describe('Stash — Apply 操作', () => {
  beforeEach(() => {
    mockListStashes.mockResolvedValue([makeStash(0)]);
    act(() => { useRepoStore.setState({ selectedRepo: makeRepo() }); });
  });

  it('Apply クリックで applyStash と loadRepos が呼ばれる', async () => {
    renderStash();
    await waitFor(() => screen.getByRole('button', { name: 'Apply' }));
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      expect(mockApplyStash).toHaveBeenCalledWith('/repo/a', 0);
      expect(mockLoadRepos).toHaveBeenCalled();
    });
  });
});

describe('Stash — Drop 操作', () => {
  beforeEach(() => {
    mockListStashes.mockResolvedValue([makeStash(0, 'WIP on main: test')]);
    act(() => { useRepoStore.setState({ selectedRepo: makeRepo() }); });
  });

  it('Drop クリックで ConfirmDialog が表示される', async () => {
    renderStash();
    await waitFor(() => screen.getByRole('button', { name: 'Drop' }));
    await userEvent.click(screen.getByRole('button', { name: 'Drop' }));
    expect(screen.getByText(/スタッシュを削除しますか/)).toBeTruthy();
  });

  it('Cancel で ConfirmDialog が閉じ、dropStash は呼ばれない', async () => {
    renderStash();
    await waitFor(() => screen.getByRole('button', { name: 'Drop' }));
    await userEvent.click(screen.getByRole('button', { name: 'Drop' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockDropStash).not.toHaveBeenCalled();
    expect(screen.queryByText(/スタッシュを削除しますか/)).toBeNull();
  });

  it('Confirm で dropStash と loadRepos が呼ばれる', async () => {
    renderStash();
    await waitFor(() => screen.getByRole('button', { name: 'Drop' }));
    await userEvent.click(screen.getByRole('button', { name: 'Drop' }));
    await userEvent.click(screen.getByRole('button', { name: '削除' }));
    await waitFor(() => {
      expect(mockDropStash).toHaveBeenCalledWith('/repo/a', 0);
      expect(mockLoadRepos).toHaveBeenCalled();
    });
  });
});

describe('Stash — repo 切り替え race', () => {
  it('repo 切り替え後に古いレスポンスで上書きされない', async () => {
    const repoA = makeRepo('/repo/a', 'repo-a');
    const repoB = makeRepo('/repo/b', 'repo-b');

    let resolveA!: (v: ReturnType<typeof makeStash>[]) => void;
    mockListStashes.mockImplementationOnce(
      () => new Promise((res) => { resolveA = res; }),
    );
    mockListStashes.mockResolvedValueOnce([makeStash(0, 'stash-b')]);

    act(() => { useRepoStore.setState({ selectedRepo: repoA }); });
    renderStash();

    // repo B に切り替え（A の resolve より先に）
    act(() => { useRepoStore.setState({ selectedRepo: repoB }); });
    await waitFor(() => screen.getByText('stash-b'));

    // A の古いレスポンスを後から返す → 上書きされないことを確認
    act(() => { resolveA([makeStash(99, 'stash-a-old')]); });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('stash-a-old')).toBeNull();
    expect(screen.getByText('stash-b')).toBeTruthy();
  });
});
