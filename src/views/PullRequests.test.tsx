import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PullRequests from './PullRequests';
import { useRepoStore } from '../stores/repoStore';
import { useUiStore } from '../stores/uiStore';
import * as invoke from '../lib/invoke';

const mockHasGithubPat    = vi.spyOn(invoke, 'hasGithubPat');
const mockGetPullRequests = vi.spyOn(invoke, 'getPullRequests');
const mockGetCheckRuns    = vi.spyOn(invoke, 'getCheckRuns');

function makePr(number: number, headSha: string, headRef = 'feat/branch') {
  return {
    number,
    title: `PR #${number}`,
    state: 'open',
    html_url: `https://github.com/o/r/pull/${number}`,
    user_login: 'alice',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-02T00:00:00Z',
    draft: false,
    merged_at: null,
    head_ref: headRef,
    head_sha: headSha,
    base_ref: 'main',
  };
}

const baseRepo = {
  path: '/repo/a',
  name: 'repo-a',
  current_branch: 'main',
  ahead: 0,
  behind: 0,
  modified_count: 0,
  untracked_count: 0,
  stash_count: 0,
  github_owner: null,
  github_repo: null,
  last_fetched_at: null,
};

function renderPullRequests() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PullRequests />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  act(() => {
    useRepoStore.setState({ repos: [], selectedRepo: null });
    useUiStore.setState({ activeView: 'prs', toasts: [], dsxProgress: [], dsxRunning: false });
  });
  mockHasGithubPat.mockResolvedValue(false as never);
  mockGetPullRequests.mockResolvedValue([] as never);
  mockGetCheckRuns.mockResolvedValue([] as never);
});

describe('PullRequests — ガード状態', () => {
  it('リポジトリ未選択時に選択を促すメッセージを表示する', () => {
    renderPullRequests();
    expect(screen.getByText('リポジトリを選択してください')).toBeInTheDocument();
  });

  it('PAT 未設定時に設定を促すメッセージを表示する', async () => {
    act(() => { useRepoStore.setState({ selectedRepo: { ...baseRepo } }); });
    renderPullRequests();
    await screen.findByText('GitHub PAT が設定されていません');
  });

  it('PAT 未設定時に Settings へのナビゲーションボタンを表示する', async () => {
    act(() => { useRepoStore.setState({ selectedRepo: { ...baseRepo } }); });
    renderPullRequests();
    await screen.findByRole('button', { name: 'Settings で設定する' });
  });

  it('PAT 未設定時の Settings ボタンをクリックすると settings ビューに遷移する', async () => {
    act(() => { useRepoStore.setState({ selectedRepo: { ...baseRepo } }); });
    renderPullRequests();
    const btn = await screen.findByRole('button', { name: 'Settings で設定する' });
    await userEvent.click(btn);
    expect(useUiStore.getState().activeView).toBe('settings');
  });

  it('PAT 設定済みで owner/repo 未設定時に設定を促すメッセージを表示する', async () => {
    mockHasGithubPat.mockResolvedValue(true as never);
    act(() => { useRepoStore.setState({ selectedRepo: { ...baseRepo } }); });
    renderPullRequests();
    await screen.findByText('このリポジトリに GitHub Owner / Repo が設定されていません');
  });

  it('PAT 設定済みで owner/repo 未設定時の Settings ボタンをクリックすると settings ビューに遷移する', async () => {
    mockHasGithubPat.mockResolvedValue(true as never);
    act(() => { useRepoStore.setState({ selectedRepo: { ...baseRepo } }); });
    renderPullRequests();
    const btn = await screen.findByRole('button', { name: 'Settings で設定する' });
    await userEvent.click(btn);
    expect(useUiStore.getState().activeView).toBe('settings');
  });

  it('PAT 設定済みかつ owner/repo 設定済みの場合はガード画面を表示しない', async () => {
    mockHasGithubPat.mockResolvedValue(true as never);
    act(() => {
      useRepoStore.setState({
        selectedRepo: { ...baseRepo, github_owner: 'scott', github_repo: 'arbor' },
      });
    });
    renderPullRequests();
    // PR/Issues の AppBar が表示される（PRs ボタンが存在する）
    await screen.findByRole('button', { name: 'PRs' });
    expect(screen.queryByText('リポジトリを選択してください')).not.toBeInTheDocument();
    expect(screen.queryByText('GitHub PAT が設定されていません')).not.toBeInTheDocument();
    expect(screen.queryByText('このリポジトリに GitHub Owner / Repo が設定されていません')).not.toBeInTheDocument();
  });
});

describe('PullRequests — check-runs (head_sha)', () => {
  const repoWithGithub = { ...baseRepo, github_owner: 'scott', github_repo: 'arbor' };

  beforeEach(() => {
    mockHasGithubPat.mockResolvedValue(true as never);
    act(() => { useRepoStore.setState({ selectedRepo: repoWithGithub }); });
  });

  it('getCheckRuns を head_ref ではなく head_sha で呼び出す', async () => {
    const sha = 'abc1234def5678901234567890abcdef12345678';
    mockGetPullRequests.mockResolvedValue([makePr(1, sha, 'feat/same-branch')] as never);
    renderPullRequests();
    // PRs タブが表示されるまで待つ
    await screen.findByRole('button', { name: 'PRs' });
    // TanStack Query が fetch を開始するまで待つ
    await vi.waitFor(() => {
      expect(mockGetCheckRuns).toHaveBeenCalledWith('scott', 'arbor', sha);
    });
    // branch name では呼ばれていないことを確認
    expect(mockGetCheckRuns).not.toHaveBeenCalledWith('scott', 'arbor', 'feat/same-branch');
  });

  it('同名ブランチを持つ 2 PR がそれぞれ別の SHA で check-runs を取得する', async () => {
    const sha1 = 'aaaa1111';
    const sha2 = 'bbbb2222';
    mockGetPullRequests.mockResolvedValue([
      makePr(1, sha1, 'feat/shared'),
      makePr(2, sha2, 'feat/shared'),
    ] as never);
    renderPullRequests();
    await screen.findByRole('button', { name: 'PRs' });
    await vi.waitFor(() => {
      expect(mockGetCheckRuns).toHaveBeenCalledWith('scott', 'arbor', sha1);
      expect(mockGetCheckRuns).toHaveBeenCalledWith('scott', 'arbor', sha2);
    });
  });
});
