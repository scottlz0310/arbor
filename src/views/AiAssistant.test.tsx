import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterAll, beforeEach, describe, expect, it, jest, mock, spyOn, type Mock } from 'bun:test';
import { act } from 'react';
import { listen } from '@tauri-apps/api/event';
import AiAssistant from './AiAssistant';
import { useRepoStore } from '../stores/repoStore';
import { useUiStore } from '../stores/uiStore';
import * as invoke from '../lib/invoke';
import * as aiService from '../lib/aiService';
import type { AiInsight, AppConfig, Insight, RepoInfo } from '../types';

// invoke / aiService は spyOn で部分モックする（convertAiInsights は実体を使う）
const mockGetAiInsights   = spyOn(invoke, 'getAiInsights');
const mockGetConfig       = spyOn(invoke, 'getConfig');
const mockOllamaAvailable = spyOn(invoke, 'ollamaAvailable');
const mockFetchInsights   = spyOn(aiService, 'fetchInsights');

// module export への spy をファイル外へ漏らさない
afterAll(() => {
  mock.restore();
});

// @tauri-apps/api/event の listen は preload でモック済み。
// 各 event 名に対する handler を捕捉して、テストから手動で payload を流せるようにする
const eventHandlers = new Map<string, (event: { payload: unknown }) => void>();
const mockListen = listen as Mock<typeof listen>;

function emitEvent(name: string, payload: unknown) {
  const handler = eventHandlers.get(name);
  if (!handler) throw new Error(`No listener registered for "${name}"`);
  handler({ payload });
}

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
  jest.clearAllMocks();
  eventHandlers.clear();
  mockListen.mockImplementation(((event: string, handler: (event: { payload: unknown }) => void) => {
    eventHandlers.set(event, handler);
    return Promise.resolve(() => eventHandlers.delete(event));
  }) as never);
  act(() => {
    useRepoStore.setState({ repos: [], selectedRepo: null });
    useUiStore.setState({ toasts: [], dsxProgress: [], dsxRunning: false, activeView: 'ai' });
  });
  mockGetConfig.mockResolvedValue(makeConfig(true));
  mockOllamaAvailable.mockResolvedValue(true);
  mockFetchInsights.mockResolvedValue({
    insights: NO_INSIGHTS, source: 'rule', ollamaOffline: false,
  });
});

describe('AiAssistant — 接続ステータス', () => {
  it('Ollama 接続成功時に "接続済み" を表示する', async () => {
    mockOllamaAvailable.mockResolvedValue(true);
    render(<AiAssistant />);
    await waitFor(() => {
      expect(screen.getByText('Ollama に接続済み')).toBeTruthy();
    });
  });

  it('Ollama 接続失敗時に "接続できません" を表示する', async () => {
    mockOllamaAvailable.mockResolvedValue(false);
    render(<AiAssistant />);
    await waitFor(() => {
      expect(screen.getByText('Ollama に接続できません')).toBeTruthy();
    });
  });

  it('AI 無効化時は接続ステータスより先に "無効化されています" を表示する', async () => {
    mockGetConfig.mockResolvedValue(makeConfig(false));
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
    await waitFor(() => expect(mockOllamaAvailable).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '接続テスト' }));
    await waitFor(() => expect(mockOllamaAvailable).toHaveBeenCalledTimes(2));
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
    mockOllamaAvailable.mockResolvedValue(false);
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
    mockGetConfig.mockResolvedValue(makeConfig(false));
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
      { repo_name: 'alpha', repo_path: '/repo/alpha', kind: 'risk', message: '危険なブランチ', priority: 3 },
    ];
    mockGetAiInsights.mockResolvedValue(mockInsights);
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
      expect(mockGetAiInsights).toHaveBeenCalledWith([makeRepo()]);
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
      { type: 'risk',    target: 'alpha', repo_path: '/repo/alpha', priority: 'high',   reason: 'alpha-risk',    source: 'ai' },
      { type: 'explain', target: 'beta',  repo_path: '/repo/beta',  priority: 'low',    reason: 'beta-explain',  source: 'ai' },
    ];
    mockFetchInsights.mockResolvedValue({
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
    mockFetchInsights.mockResolvedValue({
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

  it('同名 repo の区別のため selected セクションに path が補助表示される', async () => {
    const repo = makeRepo({ path: '/work/clone-a/alpha', name: 'alpha' });
    act(() => {
      useRepoStore.setState({ repos: [repo], selectedRepo: repo });
    });
    render(<AiAssistant />);
    await waitFor(() => {
      expect(screen.getAllByText('/work/clone-a/alpha').length).toBeGreaterThan(0);
    });
  });

  it('RepoInsightGroup に repo path が表示される（同名 repo 区別）', async () => {
    const repos = [
      makeRepo({ path: '/work/clone-a/alpha', name: 'alpha' }),
      makeRepo({ path: '/work/clone-b/alpha', name: 'alpha' }),
    ];
    act(() => {
      useRepoStore.setState({ repos, selectedRepo: repos[0] });
    });
    render(<AiAssistant />);
    // clone-a path は selected セクション + group の両方に出るため getAllByText
    await waitFor(() => {
      expect(screen.getAllByText('/work/clone-a/alpha').length).toBeGreaterThan(0);
      expect(screen.getAllByText('/work/clone-b/alpha').length).toBeGreaterThan(0);
    });
  });

  it('同名 repo の insight が path によって正しく分離される', async () => {
    // 同名 repo を 2 つ用意し、それぞれに別の insight を割り当てる
    const repoA = makeRepo({ path: '/work/clone-a/alpha', name: 'alpha' });
    const repoB = makeRepo({ path: '/work/clone-b/alpha', name: 'alpha' });
    const insights: Insight[] = [
      // repo_path = clone-a を指す insight
      { type: 'risk',    target: 'alpha', repo_path: '/work/clone-a/alpha',
        priority: 'high', reason: 'clone-a-only-risk', source: 'ai' },
      // repo_path = clone-b を指す insight
      { type: 'explain', target: 'alpha', repo_path: '/work/clone-b/alpha',
        priority: 'low',  reason: 'clone-b-only-explain', source: 'ai' },
    ];
    mockFetchInsights.mockResolvedValue({
      insights, source: 'ai', ollamaOffline: false,
    });
    act(() => {
      useRepoStore.setState({ repos: [repoA, repoB], selectedRepo: repoA });
    });
    render(<AiAssistant />);
    // selected = clone-a なので selected セクションに clone-a の reason のみが出る
    // ALL REPOSITORIES グループは両方出るため、それぞれの reason が「丁度 1 回ずつ」現れる
    await waitFor(() => {
      // selected セクション + ALL REPOSITORIES の clone-a group の両方に表示 → 2 回
      expect(screen.getAllByText('clone-a-only-risk').length).toBe(2);
      // clone-b は selected ではないので ALL REPOSITORIES の clone-b group のみ → 1 回
      expect(screen.getAllByText('clone-b-only-explain').length).toBe(1);
    });
  });
});

describe('AiAssistant — AI disabled 時の挙動', () => {
  it('AI disabled 時は fetchInsights を呼ばず "Settings で有効化" 表示', async () => {
    mockGetConfig.mockResolvedValue(makeConfig(false));
    act(() => {
      useRepoStore.setState({ repos: [makeRepo()], selectedRepo: makeRepo() });
    });
    render(<AiAssistant />);
    await waitFor(() => {
      expect(screen.getAllByText(/Settings で有効化してください/).length).toBeGreaterThan(0);
    });
    expect(mockFetchInsights).not.toHaveBeenCalled();
  });
});

describe('AiAssistant — loading 状態のリセット', () => {
  it('mid-fetch 中に repos が空になっても insightLoading が残らない', async () => {
    // 解決可能な fetch を pending のまま保持して mid-fetch 状態を再現する
    let resolveFetch!: (v: { insights: Insight[]; source: 'rule' | 'ai'; ollamaOffline: boolean }) => void;
    mockFetchInsights.mockReturnValue(
      new Promise((res) => { resolveFetch = res; }),
    );
    act(() => {
      useRepoStore.setState({ repos: [makeRepo()], selectedRepo: makeRepo() });
    });
    render(<AiAssistant />);
    // loading 表示が出るまで待つ（aiConfig 読み込み完了後）
    await waitFor(() => {
      expect(screen.getByText('分析中…')).toBeTruthy();
    });
    // repos を空にする → cancelled guard で finally がスキップされるが、
    // 新しい effect 側が setInsightLoading(false) を明示実行するので loading は残らない
    act(() => {
      useRepoStore.setState({ repos: [], selectedRepo: null });
    });
    await waitFor(() => {
      expect(screen.queryByText('分析中…')).toBeNull();
    });
    // pending fetch を後から解決しても loading は復活しない
    act(() => resolveFetch({ insights: [], source: 'rule', ollamaOffline: false }));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('分析中…')).toBeNull();
  });
});

describe('AiAssistant — イベント購読', () => {
  it('ai_insights_loading で "AI 分析中…" バッジが表示される', async () => {
    act(() => {
      useRepoStore.setState({ repos: [makeRepo()], selectedRepo: makeRepo() });
    });
    render(<AiAssistant />);
    await waitFor(() => {
      expect(eventHandlers.has('ai_insights_loading')).toBe(true);
    });
    act(() => emitEvent('ai_insights_loading', undefined));
    await waitFor(() => {
      expect(screen.getByText(/AI 分析中…/)).toBeTruthy();
    });
  });

  it('ai_insights_updated で AI insight に差し替わる', async () => {
    act(() => {
      useRepoStore.setState({ repos: [makeRepo()], selectedRepo: makeRepo() });
    });
    render(<AiAssistant />);
    await waitFor(() => {
      expect(eventHandlers.has('ai_insights_updated')).toBe(true);
    });
    const ai: AiInsight[] = [
      { repo_name: 'alpha', repo_path: '/repo/alpha', kind: 'risk', message: 'event-pushed-risk', priority: 3 },
    ];
    act(() => emitEvent('ai_insights_updated', ai));
    // selected セクションと repo グループの両方に表示され得るため getAllByText
    await waitFor(() => {
      expect(screen.getAllByText('event-pushed-risk').length).toBeGreaterThan(0);
    });
  });

  it('ai_insights_failed で "AI 失敗" バッジが表示される', async () => {
    act(() => {
      useRepoStore.setState({ repos: [makeRepo()], selectedRepo: makeRepo() });
    });
    render(<AiAssistant />);
    // SectionHeader の aiFailed バッジは !loading 条件下でのみ表示されるので、
    // 初回 fetchInsights の loading が解けるまで待ってから emit する
    await waitFor(() => {
      expect(mockFetchInsights).toHaveBeenCalled();
      expect(screen.getByText(/特筆すべき項目はありません/)).toBeTruthy();
    });
    act(() => emitEvent('ai_insights_failed', undefined));
    await waitFor(() => {
      expect(screen.getByText(/AI 失敗/)).toBeTruthy();
    });
  });
});
