import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiInsight, BranchInfo, Insight, RepoInfo } from '../types';
import { convertAiInsights, fetchInsights } from './aiService';
import * as invoke from './invoke';
import * as ruleEngine from './ruleEngine';

vi.mock('./invoke');
vi.mock('./ruleEngine');

const REPOS: RepoInfo[] = [
  {
    path: '/r/a',
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
  },
];

const BRANCHES: Record<string, BranchInfo[]> = {};

const RULE_INSIGHTS: Insight[] = [
  { type: 'explain', target: 'alpha', repo_path: '/repos/alpha', priority: 'low', reason: 'rule', source: 'rule' },
];

const AI_RAW: AiInsight[] = [
  { repo_name: 'alpha', repo_path: '/repos/alpha', kind: 'risk', message: 'diverged', priority: 3 },
  { repo_name: 'alpha', repo_path: '/repos/alpha', kind: 'prioritize', message: 'pull needed', priority: 2 },
  { repo_name: 'alpha', repo_path: '/repos/alpha', kind: 'explain', message: 'stale branch', priority: 0 },
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(ruleEngine.generateInsights).mockReturnValue(RULE_INSIGHTS);
});

// ─── convertAiInsights ───────────────────────────────────────────────────────

describe('convertAiInsights', () => {
  it('priority 3 → high', () => {
    const insights = convertAiInsights([{ repo_name: 'r', repo_path: '/p/r', kind: 'risk', message: 'x', priority: 3 }]);
    expect(insights[0].priority).toBe('high');
    expect(insights[0].source).toBe('ai');
  });

  it('priority 2 → high', () => {
    const insights = convertAiInsights([{ repo_name: 'r', repo_path: '/p/r', kind: 'prioritize', message: 'x', priority: 2 }]);
    expect(insights[0].priority).toBe('high');
  });

  it('priority 1 → medium', () => {
    const insights = convertAiInsights([{ repo_name: 'r', repo_path: '/p/r', kind: 'explain', message: 'x', priority: 1 }]);
    expect(insights[0].priority).toBe('medium');
  });

  it('priority 0 → low', () => {
    const insights = convertAiInsights([{ repo_name: 'r', repo_path: '/p/r', kind: 'explain', message: 'x', priority: 0 }]);
    expect(insights[0].priority).toBe('low');
  });

  it('copies repo_path through to Insight', () => {
    const insights = convertAiInsights([{ repo_name: 'r', repo_path: '/root/dup/r', kind: 'risk', message: 'x', priority: 1 }]);
    expect(insights[0].repo_path).toBe('/root/dup/r');
  });

  it('maps kind and message correctly', () => {
    const insights = convertAiInsights(AI_RAW);
    expect(insights).toHaveLength(3);
    expect(insights[0].type).toBe('risk');
    expect(insights[0].target).toBe('alpha');
    expect(insights[0].reason).toBe('diverged');
  });

  it('empty array returns empty array', () => {
    expect(convertAiInsights([])).toEqual([]);
  });
});

// ─── fetchInsights ───────────────────────────────────────────────────────────

describe('fetchInsights', () => {
  it('Ollama 利用不可のとき rule フォールバック', async () => {
    vi.mocked(invoke.ollamaAvailable).mockResolvedValue(false);
    const result = await fetchInsights(REPOS, BRANCHES, 14);
    expect(result.source).toBe('rule');
    expect(result.insights).toEqual(RULE_INSIGHTS);
    expect(invoke.getAiInsightsCached).not.toHaveBeenCalled();
  });

  it('Ollama 利用可能のとき AI Insight を返す', async () => {
    vi.mocked(invoke.ollamaAvailable).mockResolvedValue(true);
    vi.mocked(invoke.getAiInsightsCached).mockResolvedValue(AI_RAW);
    const result = await fetchInsights(REPOS, BRANCHES, 14);
    expect(result.source).toBe('ai');
    expect(result.insights).toHaveLength(3);
    expect(result.insights[0].source).toBe('ai');
  });

  it('getAiInsightsCached が例外を投げたとき rule フォールバック', async () => {
    vi.mocked(invoke.ollamaAvailable).mockResolvedValue(true);
    vi.mocked(invoke.getAiInsightsCached).mockRejectedValue(new Error('timeout'));
    const result = await fetchInsights(REPOS, BRANCHES, 14);
    expect(result.source).toBe('rule');
    expect(result.insights).toEqual(RULE_INSIGHTS);
  });

  it('ollamaAvailable が例外を投げたとき rule フォールバック', async () => {
    vi.mocked(invoke.ollamaAvailable).mockRejectedValue(new Error('network'));
    const result = await fetchInsights(REPOS, BRANCHES, 14);
    expect(result.source).toBe('rule');
    expect(result.insights).toEqual(RULE_INSIGHTS);
  });

  it('getAiInsightsCached が [] を返したとき rule フォールバック (cache miss)', async () => {
    vi.mocked(invoke.ollamaAvailable).mockResolvedValue(true);
    vi.mocked(invoke.getAiInsightsCached).mockResolvedValue([]);
    const result = await fetchInsights(REPOS, BRANCHES, 14);
    expect(result.source).toBe('rule');
    expect(result.insights).toEqual(RULE_INSIGHTS);
    expect(result.ollamaOffline).toBe(false);
  });
});
