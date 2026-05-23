import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';
import AiAssistant from './AiAssistant';
import { useRepoStore } from '../stores/repoStore';
import { useUiStore } from '../stores/uiStore';
import * as invoke from '../lib/invoke';
import * as aiService from '../lib/aiService';
import type { AiInsight, AppConfig, Insight, RepoInfo } from '../types';

vi.mock('../lib/invoke', () => ({
  getAiInsights:    vi.fn(),
  getConfig:        vi.fn(),
  ollamaAvailable:  vi.fn(),
}));

vi.mock('../lib/aiService', async () => {
  const actual = await vi.importActual<typeof import('../lib/aiService')>('../lib/aiService');
  return {
    ...actual,
    fetchInsights: vi.fn(),
  };
});

// @tauri-apps/api/event の listen をスタブ化（jsdom では IPC 利用不可）
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

function makeRepo(overrides: Partial<RepoInfo> = {}): RepoInfo {
  return {
    path: '/repo/alpha',
    name: 'alpha',
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

function makeConfig(enabled = true): AppConfig {
  return {
    settings: { stale_threshold_days: 14, fetch_on_startup: false, github_keychain_key: 'k' },
    ai:       { provider: 'ollama', ollama_url: 'http://localhost:11434', model: 'qwen3.5:latest', enabled, timeout_secs: 30 },
    repositories: [],
  };
}

const NO_INSIGHTS: Insight[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  act(() => {
    useRepoStore.setState({ repos: [], selectedRepo: null });
    useUiStore.setState({ toasts: [], dsxProgress: [], dsxRunning: false, activeView: 'ai' });
  });
  vi.mocked(invoke.getConfig).mockResolvedValue(makeConfig(true));
  vi.mocked(invoke.ollamaAvailable).mockResolvedValue(true);
  vi.mocked(aiService.fetchInsights).mockResolvedValue({
    insights: NO_INSIGHTS, source: 'rule', ollamaOffline: false,
  });
});

describe('AiAssistant — 接続ステータス', () => {
  it('Ollama 接続成功時に "接続済み" を表示する', async () => {
    vi.mocked(invoke.ollamaAvailable).mockResolvedValue(true);
    render(<AiAssistant />);
    await waitFor(() => {
      expect(screen.getByText('Ollama に接続済み')).toBeTruthy();
    });
  });

  it('Ollama 接続失敗時に "接続できません" を表示する', async () => {
    vi.mocked(invoke.ollamaAvailable).mockResolvedValue(false);
    render(<AiAssistant />);
    await waitFor(() => {
      expect(screen.getByText('Ollama に接続できません')).toBeTruthy();
    });
  });

  it('AI 無効化時は接続ステータスより先に "無効化されています" を表示する', async () => {
    vi.mocked(invoke.getConfig).mockResolvedValue(makeConfig(false));
    render(<AiAssistant />);
    await waitFor(() => {
      expect(screen.getByText('AI Insight は無効化されています')).toBeTruthy();
    });
  });

  it('使用モデル名 / プロバイダが表示される', async () => {
    render(<AiAssistant />);
    await waitFor(() => {
      expect(screen.getByText('qwen3.5:latest')).toBeTruthy();
      expect(screen.getByText('ollama')).toBeTruthy();
    });
  });

  it('接続テストボタンで ollamaAvailable が再実行される', async () => {
    render(<AiAssistant />);
    await waitFor(() => expect(invoke.ollamaAvailable).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '接続テスト' }));
    await waitFor(() => expect(invoke.ollamaAvailable).toHaveBeenCalledTimes(2));
  });
});

describe('AiAssistant — 再分析ボタン', () => {
  it('リポジトリ未登録時は disabled', async () => {
    render(<AiAssistant />);
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /再分析/ }) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    });
  });

  it('接続失敗時は disabled', async () => {
    vi.mocked(invoke.ollamaAvailable).mockResolvedValue(false);
    act(() => {
      useRepoStore.setState({ repos: [makeRepo()], selectedRepo: makeRepo() });
    });
    render(<AiAssistant />);
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /再分析/ }) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    });
  });

  it('AI 無効時は disabled', async () => {
    vi.mocked(invoke.getConfig).mockResolvedValue(makeConfig(false));
    act(() => {
      useRepoStore.setState({ repos: [makeRepo()], selectedRepo: makeRepo() });
    });
    render(<AiAssistant />);
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /再分析/ }) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    });
  });

  it('正常時にクリックすると getAiInsights が呼ばれる', async () => {
    const mockInsights: AiInsight[] = [
      { repo_name: 'alpha', kind: 'risk', message: '危険なブランチ', priority: 3 },
    ];
    vi.mocked(invoke.getAiInsights).mockResolvedValue(mockInsights);
    act(() => {
      useRepoStore.setState({ repos: [makeRepo()], selectedRepo: makeRepo() });
    });
    render(<AiAssistant />);
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /再分析/ }) as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });
    fireEvent.click(screen.getByRole('button', { name: /再分析/ }));
    await waitFor(() => {
      expect(invoke.getAiInsights).toHaveBeenCalledWith([makeRepo()]);
    });
  });
});

describe('AiAssistant — Insight 表示', () => {
  it('リポジトリが選択されていなければプロンプトを表示', async () => {
    render(<AiAssistant />);
    await waitFor(() => {
      expect(screen.getByText('リポジトリを選択してください')).toBeTruthy();
    });
  });

  it('選択リポジトリの insights だけがメインセクションに表示される', async () => {
    const repos = [makeRepo(), makeRepo({ path: '/repo/beta', name: 'beta' })];
    const insights: Insight[] = [
      { type: 'risk',    target: 'alpha', priority: 'high',   reason: 'alpha-risk',    source: 'ai' },
      { type: 'explain', target: 'beta',  priority: 'low',    reason: 'beta-explain',  source: 'ai' },
    ];
    vi.mocked(aiService.fetchInsights).mockResolvedValue({
      insights, source: 'ai', ollamaOffline: false,
    });
    act(() => {
      useRepoStore.setState({ repos, selectedRepo: repos[0] });
    });
    render(<AiAssistant />);
    await waitFor(() => {
      // 選択中の reason が反映されるまで待つ
      expect(screen.getAllByText('alpha-risk').length).toBeGreaterThan(0);
    });
    // 選択中リポジトリヘッダ（getAllByText で重複表示にも耐える）
    expect(screen.getAllByText(/AI INSIGHTS — alpha/).length).toBeGreaterThan(0);
    // 他リポジトリの reason はリポジトリ別グループに表示される
    expect(screen.getAllByText('beta-explain').length).toBeGreaterThan(0);
  });

  it('Ollama オフライン時に専用メッセージを表示', async () => {
    vi.mocked(aiService.fetchInsights).mockResolvedValue({
      insights: [], source: 'rule', ollamaOffline: true,
    });
    act(() => {
      useRepoStore.setState({ repos: [makeRepo()], selectedRepo: makeRepo() });
    });
    render(<AiAssistant />);
    await waitFor(() => {
      expect(screen.getByText('Ollama が未起動のため AI 分析を実行できません')).toBeTruthy();
    });
  });
});
