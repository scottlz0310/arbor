import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';
import { act } from 'react';
import Status from './Status';
import * as invoke from '../lib/invoke';
import { useRepoStore } from '../stores/repoStore';
import { useUiStore } from '../stores/uiStore';

const mockFetchAll = spyOn(invoke, 'fetchAll');
const mockOpenRepoFolder = spyOn(invoke, 'openRepoFolder');
const mockRefreshRepo = mock();
const mockAddToast = mock();

// module export への spy をファイル外へ漏らさない
afterAll(() => {
  mock.restore();
});

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

function setRepos(repos: ReturnType<typeof makeRepo>[]) {
  act(() => {
    useRepoStore.setState({ repos, selectedRepo: null, refreshRepo: mockRefreshRepo });
  });
}

const cardOf = (name: string) => screen.getByRole('group', { name });
const cardNames = () =>
  screen
    .getAllByRole('group')
    .map((el) => el.getAttribute('aria-label'))
    .filter((label) => label !== '状態で絞り込み');

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchAll.mockResolvedValue({ updated_refs: [] });
  mockOpenRepoFolder.mockResolvedValue(undefined);
  mockRefreshRepo.mockResolvedValue(undefined);
  act(() => {
    useRepoStore.setState({ repos: [], selectedRepo: null });
    useUiStore.setState({ toasts: [], statusFilter: 'all', addToast: mockAddToast });
  });
});

describe('Status — Recommended Actions', () => {
  it.each([
    { name: 'diverged', repo: { ahead: 2, behind: 3 }, text: /diverged状態/ },
    { name: 'behind が 5 以上', repo: { behind: 6 }, text: /6コミット遅れています/ },
  ])('$name のリポジトリがあるとパネルに表示される', ({ repo, text }) => {
    setRepos([makeRepo(repo)]);

    render(<Status />);

    expect(screen.getByText('RECOMMENDED ACTIONS')).toBeTruthy();
    expect(screen.getByText(text)).toBeTruthy();
  });

  it('健全なリポジトリだけならパネルは表示されない', () => {
    setRepos([makeRepo()]);

    render(<Status />);

    expect(screen.queryByText('RECOMMENDED ACTIONS')).toBeNull();
  });
});

describe('Status — 一覧と絞り込み', () => {
  const repos = [
    makeRepo({ path: '/r/a', name: 'a-clean' }),
    makeRepo({ path: '/r/b', name: 'b-dirty', modified_count: 2 }),
    makeRepo({ path: '/r/c', name: 'c-clean' }),
    makeRepo({ path: '/r/d', name: 'd-behind', behind: 1 }),
  ];

  it('要対応のリポジトリを先頭に並べ、フィルタに件数を出す', () => {
    setRepos(repos);

    render(<Status />);

    expect(cardNames()).toEqual(['b-dirty', 'd-behind', 'a-clean', 'c-clean']);
    expect(screen.getByRole('button', { name: /All Repositories\s*4/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Needs Action\s*2/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Clean \/ Up-to-date\s*2/ })).toBeTruthy();
  });

  it.each([
    { filter: 'Needs Action', names: ['b-dirty', 'd-behind'] },
    { filter: 'Clean / Up-to-date', names: ['a-clean', 'c-clean'] },
    { filter: 'All Repositories', names: ['b-dirty', 'd-behind', 'a-clean', 'c-clean'] },
  ])('「$filter」で絞り込む', async ({ filter, names }) => {
    setRepos(repos);
    render(<Status />);

    await userEvent.click(screen.getByRole('button', { name: new RegExp(filter) }));

    expect(cardNames()).toEqual([...names]);
    expect(screen.getByRole('button', { name: new RegExp(filter) }).getAttribute('aria-pressed')).toBe('true');
  });

  it('Summary など別の場所で設定した絞り込みを引き継ぐ', () => {
    setRepos(repos);
    act(() => useUiStore.setState({ statusFilter: 'attention' }));

    render(<Status />);

    expect(cardNames()).toEqual(['b-dirty', 'd-behind']);
  });

  it.each([
    { name: 'リポジトリが無い', repos: [], text: /Settings で workspace root を設定/ },
    { name: '絞り込みに該当しない', repos: [makeRepo({ name: 'only-clean' })], filter: 'attention' as const, text: /該当するリポジトリはありません/ },
  ])('$name とき、案内を表示する', ({ repos: list, filter, text }) => {
    setRepos([...list]);
    if (filter) act(() => useUiStore.setState({ statusFilter: filter }));

    render(<Status />);

    expect(screen.getByText(text)).toBeTruthy();
  });
});

describe('Status — リポジトリカード', () => {
  it.each([
    { name: 'detached HEAD', repo: { is_detached: true }, label: '⎇ detached' },
    { name: 'dirty', repo: { modified_count: 1 }, label: '~ dirty' },
    { name: 'upstream が無い', repo: { has_upstream: false }, label: '○ no upstream' },
    { name: '同期済み', repo: {}, label: '✓ clean' },
  ])('$name → $label', ({ repo, label }) => {
    setRepos([makeRepo(repo)]);

    render(<Status />);

    expect(within(cardOf('test-repo')).getByText(label)).toBeTruthy();
  });

  it('カードをクリックすると選択される', async () => {
    setRepos([makeRepo({ name: 'pick-me' })]);
    render(<Status />);

    await userEvent.click(cardOf('pick-me'));

    expect(useRepoStore.getState().selectedRepo?.name).toBe('pick-me');
  });

  it('Fetch は、そのリポジトリだけを fetch して状態を読み直し、選択は変えない', async () => {
    setRepos([makeRepo({ path: '/r/a', name: 'a' }), makeRepo({ path: '/r/b', name: 'b' })]);
    render(<Status />);

    await userEvent.click(screen.getByRole('button', { name: 'Fetch b' }));

    expect(mockFetchAll).toHaveBeenCalledWith('/r/b');
    await waitFor(() => expect(mockRefreshRepo).toHaveBeenCalledWith('/r/b'));
    expect(mockAddToast).toHaveBeenCalledWith('b: fetch 完了', 'success');
    expect(useRepoStore.getState().selectedRepo).toBeNull();
  });

  it('Fetch の失敗は、リポジトリ名つきで通知する', async () => {
    mockFetchAll.mockRejectedValue('fetch origin: boom');
    setRepos([makeRepo({ path: '/r/a', name: 'a' })]);
    render(<Status />);

    await userEvent.click(screen.getByRole('button', { name: 'Fetch a' }));

    await waitFor(() => expect(mockAddToast).toHaveBeenCalledWith('a: fetch origin: boom', 'error'));
    expect(mockRefreshRepo).not.toHaveBeenCalled();
  });

  it('フォルダを開く操作は、そのリポジトリのパスで openRepoFolder を呼ぶ', async () => {
    setRepos([makeRepo({ path: '/r/a', name: 'a' })]);
    render(<Status />);

    await userEvent.click(screen.getByRole('button', { name: 'a のフォルダを開く' }));

    expect(mockOpenRepoFolder).toHaveBeenCalledWith('/r/a');
  });

  it('フォルダを開けなかったときは、理由を通知する', async () => {
    mockOpenRepoFolder.mockRejectedValue('フォルダが見つかりません: /r/a');
    setRepos([makeRepo({ path: '/r/a', name: 'a' })]);
    render(<Status />);

    await userEvent.click(screen.getByRole('button', { name: 'a のフォルダを開く' }));

    await waitFor(() => expect(mockAddToast).toHaveBeenCalledWith('フォルダが見つかりません: /r/a', 'error'));
  });
});
