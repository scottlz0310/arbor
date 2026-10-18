import { describe, it, expect } from 'bun:test';
import { generateInsights } from './ruleEngine';
import type { RepoInfo } from '../types';

// ── helpers ────────────────────────────────────────────────────────────────

function makeRepo(overrides: Partial<RepoInfo> = {}): RepoInfo {
  return {
    path: '/repos/test',
    name: 'test',
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

// ── tests ──────────────────────────────────────────────────────────────────

describe('generateInsights', () => {
  it.each([
    { name: 'diverged（先行・遅延の両方）', repo: { ahead: 2, behind: 3 }, type: 'risk', priority: 'high' },
    { name: 'behind が 5 以上', repo: { behind: 5 }, type: 'prioritize', priority: 'high' },
  ] as const)('$name → $type / $priority の insight を返す', ({ repo, type, priority }) => {
    const insights = generateInsights([makeRepo(repo)]);
    const found = insights.find((i) => i.type === type);
    expect(found).toBeDefined();
    expect(found?.priority).toBe(priority);
  });

  it.each([
    { name: 'behind が 4（閾値未満）', repo: { behind: 4 } },
    { name: 'ahead のみ', repo: { ahead: 3 } },
    { name: 'clean', repo: {} },
  ])('$name → insight なし', ({ repo }) => {
    expect(generateInsights([makeRepo(repo)])).toHaveLength(0);
  });

  it('diverged かつ behind >= 5 → risk と prioritize の両方を返す', () => {
    const types = generateInsights([makeRepo({ ahead: 1, behind: 6 })]).map((i) => i.type);
    expect(types).toEqual(expect.arrayContaining(['risk', 'prioritize']));
  });

  it('results sorted high → medium → low', () => {
    const insights = generateInsights([
      makeRepo({ path: '/repos/a', name: 'a', ahead: 1, behind: 6 }),
      makeRepo({ path: '/repos/b', name: 'b', behind: 9 }),
    ]);
    const order: Record<string, number> = { high: 3, medium: 2, low: 1 };
    for (let i = 1; i < insights.length; i++) {
      expect(order[insights[i - 1].priority]).toBeGreaterThanOrEqual(order[insights[i].priority]);
    }
  });

  it('empty repos list → empty insights', () => {
    expect(generateInsights([])).toHaveLength(0);
  });

  it('全 insight に repo_path がセットされ、同名 repo も区別できる', () => {
    const repoA = makeRepo({ path: '/root1/alpha', name: 'alpha', ahead: 1, behind: 1 });
    const repoB = makeRepo({ path: '/root2/alpha', name: 'alpha', behind: 8 });
    const insights = generateInsights([repoA, repoB]);

    for (const ins of insights) {
      expect([repoA.path, repoB.path]).toContain(ins.repo_path);
    }
    expect(insights.some((i) => i.repo_path === repoA.path)).toBe(true);
    expect(insights.some((i) => i.repo_path === repoB.path)).toBe(true);
  });
});
