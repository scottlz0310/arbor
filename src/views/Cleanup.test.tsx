import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';
import Cleanup from './Cleanup';
import { useRepoStore } from '../stores/repoStore';
import { useUiStore } from '../stores/uiStore';
import * as invoke from '../lib/invoke';
import * as aiService from '../lib/aiService';
import type { Insight } from '../types';

vi.mock('../lib/aiService', async () => {
  const actual = await vi.importActual<typeof import('../lib/aiService')>('../lib/aiService');
  return {
    ...actual,
    fetchInsights: vi.fn().mockResolvedValue({ insights: [], source: 'rule', ollamaOffline: false }),
  };
});

// @tauri-apps/api/event の listen をスタブ化（jsdom では IPC 利用不可）
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

const mockGetBranches = vi.spyOn(invoke, 'getBranches');

function makeRepo(path: string, name: string) {
  return {
    path,
    name,
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
}

function makeBranch(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    is_current: false,
    is_merged: false,
    is_squash_merged: false,
    ahead: 0,
    behind: 0,
    last_commit_ts: Math.floor(Date.now() / 1000) - 86400 * 20, // 20 日前
    last_commit_msg: 'test commit',
    author: 'test',
    remote_name: null,
    ...overrides,
  };
}

function renderCleanup() {
  return render(<Cleanup />);
}

beforeEach(() => {
  vi.clearAllMocks();
  act(() => {
    useRepoStore.setState({ repos: [], selectedRepo: null });
    useUiStore.setState({ toasts: [], dsxProgress: [], dsxRunning: false });
  });
  mockGetBranches.mockResolvedValue([]);
});

describe('Cleanup — selectedRepo スコープ', () => {
  const repoA = makeRepo('/repo/a', 'repo-a');
  const repoB = makeRepo('/repo/b', 'repo-b');

  it('selectedRepo が未選択の場合、全リポジトリの getBranches を呼ぶ', async () => {
    act(() => { useRepoStore.setState({ repos: [repoA, repoB], selectedRepo: null }); });
    renderCleanup();
    await waitFor(() => {
      expect(mockGetBranches).toHaveBeenCalledWith('/repo/a');
      expect(mockGetBranches).toHaveBeenCalledWith('/repo/b');
    });
  });

  it('selectedRepo が設定済みの場合、そのリポジトリのみ getBranches を呼ぶ', async () => {
    act(() => { useRepoStore.setState({ repos: [repoA, repoB], selectedRepo: repoA }); });
    renderCleanup();
    await waitFor(() => {
      expect(mockGetBranches).toHaveBeenCalledWith('/repo/a');
    });
    expect(mockGetBranches).not.toHaveBeenCalledWith('/repo/b');
  });

  it('selectedRepo 切替時に対象リポジトリのみ getBranches を呼ぶ', async () => {
    act(() => { useRepoStore.setState({ repos: [repoA, repoB], selectedRepo: repoA }); });
    renderCleanup();
    await waitFor(() => expect(mockGetBranches).toHaveBeenCalledWith('/repo/a'));

    // selectedRepo を repoB に切替
    mockGetBranches.mockClear();
    act(() => { useRepoStore.setState({ selectedRepo: repoB }); });
    await waitFor(() => {
      expect(mockGetBranches).toHaveBeenCalledWith('/repo/b');
    });
    expect(mockGetBranches).not.toHaveBeenCalledWith('/repo/a');
  });
});

describe('Cleanup — ブランチ表示', () => {
  const repo = makeRepo('/repo/a', 'repo-a');

  it('マージ済みブランチが MERGED BRANCHES セクションに表示される', async () => {
    mockGetBranches.mockResolvedValue([makeBranch('feature/done', { is_merged: true })]);
    act(() => { useRepoStore.setState({ repos: [repo], selectedRepo: null }); });
    renderCleanup();
    await screen.findByText('feature/done');
    expect(screen.getByText('MERGED BRANCHES')).toBeInTheDocument();
  });

  it('squash マージ済みブランチも MERGED BRANCHES に表示される', async () => {
    mockGetBranches.mockResolvedValue([makeBranch('feature/squashed', { is_squash_merged: true })]);
    act(() => { useRepoStore.setState({ repos: [repo], selectedRepo: null }); });
    renderCleanup();
    await screen.findByText('feature/squashed');
    expect(screen.getByText('MERGED BRANCHES')).toBeInTheDocument();
  });

  it('古いブランチが STALE BRANCHES セクションに表示される', async () => {
    mockGetBranches.mockResolvedValue([makeBranch('feature/old')]);
    act(() => { useRepoStore.setState({ repos: [repo], selectedRepo: null }); });
    renderCleanup();
    await screen.findByText('feature/old');
    expect(screen.getByText(/STALE BRANCHES/)).toBeInTheDocument();
  });

  it('14 日以内のブランチは STALE BRANCHES に表示されない', async () => {
    const recentBranch = makeBranch('feature/recent', {
      last_commit_ts: Math.floor(Date.now() / 1000) - 86400 * 5, // 5 日前
    });
    mockGetBranches.mockResolvedValue([recentBranch]);
    act(() => { useRepoStore.setState({ repos: [repo], selectedRepo: null }); });
    renderCleanup();
    // セクションタイトルは表示されるが、ブランチ名は表示されない
    await screen.findByText(/STALE BRANCHES/);
    expect(screen.queryByText('feature/recent')).not.toBeInTheDocument();
  });

  it('現在のブランチはどのセクションにも表示されない', async () => {
    mockGetBranches.mockResolvedValue([
      makeBranch('main', { is_current: true, is_merged: true }),
    ]);
    act(() => { useRepoStore.setState({ repos: [repo], selectedRepo: null }); });
    renderCleanup();
    // タイトルは出るが main は表示されない
    await screen.findByText('MERGED BRANCHES');
    expect(screen.queryByText('main')).not.toBeInTheDocument();
  });
});

describe('Cleanup — Insight 行コンテキストマッチング', () => {
  const repo = makeRepo('/repo/a', 'repo-a');

  it('branch-level insight は同じ repo の他ブランチ行に漏れない', async () => {
    // 同じ repo に 2 つの stale branch、片方だけ branch-level insight を持つ
    const insights: Insight[] = [
      {
        type: 'explain',
        target: 'feature/old-a',           // 特定ブランチに紐づく
        repo_path: '/repo/a',
        priority: 'low',
        reason: 'only-for-old-a',
        source: 'rule',
      },
    ];
    vi.mocked(aiService.fetchInsights).mockResolvedValue({
      insights, source: 'rule', ollamaOffline: false,
    });
    mockGetBranches.mockResolvedValue([
      makeBranch('feature/old-a'),
      makeBranch('feature/old-b'),
    ]);
    act(() => { useRepoStore.setState({ repos: [repo], selectedRepo: null }); });
    renderCleanup();
    await screen.findByText('feature/old-a');
    await screen.findByText('feature/old-b');
    // reason が出るのは feature/old-a 行のみで、feature/old-b 行には現れない
    await waitFor(() => {
      expect(screen.getAllByText(/only-for-old-a/).length).toBe(1);
    });
  });

  it('branch-level insight が無い場合は repo-level insight にフォールバック', async () => {
    const insights: Insight[] = [
      {
        type: 'risk',
        target: 'repo-a',                  // repo-level (target == repo name)
        repo_path: '/repo/a',
        priority: 'high',
        reason: 'repo-level-warning',
        source: 'ai',
      },
    ];
    vi.mocked(aiService.fetchInsights).mockResolvedValue({
      insights, source: 'ai', ollamaOffline: false,
    });
    mockGetBranches.mockResolvedValue([
      makeBranch('feature/x'),
      makeBranch('feature/y'),
    ]);
    act(() => { useRepoStore.setState({ repos: [repo], selectedRepo: null }); });
    renderCleanup();
    await screen.findByText('feature/x');
    await screen.findByText('feature/y');
    // 両ブランチ行に repo-level reason が出る（行コンテキストでの fallback として妥当）
    await waitFor(() => {
      expect(screen.getAllByText(/repo-level-warning/).length).toBe(2);
    });
  });

  it('別 path の同名 repo に insight が漏れない', async () => {
    const repoA = makeRepo('/work/clone-a/alpha', 'alpha');
    const repoB = makeRepo('/work/clone-b/alpha', 'alpha');
    const insights: Insight[] = [
      // clone-a のみに紐づく repo-level insight
      {
        type: 'risk',
        target: 'alpha',
        repo_path: '/work/clone-a/alpha',
        priority: 'high',
        reason: 'clone-a-warning',
        source: 'ai',
      },
    ];
    vi.mocked(aiService.fetchInsights).mockResolvedValue({
      insights, source: 'ai', ollamaOffline: false,
    });
    mockGetBranches.mockImplementation((path: string) =>
      Promise.resolve([makeBranch(path === '/work/clone-a/alpha' ? 'br-a' : 'br-b')]),
    );
    act(() => { useRepoStore.setState({ repos: [repoA, repoB], selectedRepo: null }); });
    renderCleanup();
    await screen.findByText('br-a');
    await screen.findByText('br-b');
    // clone-a の行にのみ reason が現れる、clone-b には現れない
    await waitFor(() => {
      expect(screen.getAllByText(/clone-a-warning/).length).toBe(1);
    });
  });
});
