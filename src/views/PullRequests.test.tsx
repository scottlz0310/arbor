import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PullRequests from './PullRequests';
import { useRepoStore } from '../stores/repoStore';
import { useUiStore } from '../stores/uiStore';
import * as invoke from '../lib/invoke';

const mockHasGithubPat = vi.spyOn(invoke, 'hasGithubPat');

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
