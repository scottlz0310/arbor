import { describe, it, expect } from 'vitest';
import { generateInsights } from './ruleEngine';
import type { BranchInfo, RepoInfo } from '../types';

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
    github_owner: null,
    github_repo: null,
    last_fetched_at: null,
    ...overrides,
  };
}

function makeBranch(overrides: Partial<BranchInfo> = {}): BranchInfo {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    name: 'feature/x',
    is_current: false,
    is_merged: false,
    is_squash_merged: false,
    ahead: 0,
    behind: 0,
    last_commit_ts: nowSec,
    last_commit_msg: 'initial commit',
    author: 'dev',
    remote_name: null,
    ...overrides,
  };
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('generateInsights', () => {
  it('diverged repo → high risk insight', () => {
    const repo = makeRepo({ ahead: 2, behind: 3 });
    const insights = generateInsights([repo], {}, 14);
    const risk = insights.find((i) => i.type === 'risk');
    expect(risk).toBeDefined();
    expect(risk?.priority).toBe('high');
    expect(risk?.risk).toBe('high');
  });

  it('behind >= 5 → high priority prioritize insight', () => {
    const repo = makeRepo({ behind: 5 });
    const insights = generateInsights([repo], {}, 14);
    const p = insights.find((i) => i.type === 'prioritize' && i.target === 'test');
    expect(p).toBeDefined();
    expect(p?.priority).toBe('high');
  });

  it('behind < 5 → no behind insight', () => {
    const repo = makeRepo({ behind: 4 });
    const insights = generateInsights([repo], {}, 14);
    expect(insights.filter((i) => i.type === 'prioritize')).toHaveLength(0);
  });

  it('3 or more merged branches → medium cleanup insight', () => {
    const repo = makeRepo();
    const branches = [
      makeBranch({ name: 'feat/a', is_merged: true }),
      makeBranch({ name: 'feat/b', is_merged: true }),
      makeBranch({ name: 'feat/c', is_squash_merged: true }),
    ];
    const insights = generateInsights([repo], { [repo.path]: branches }, 14);
    const cleanup = insights.find((i) => i.type === 'prioritize');
    expect(cleanup).toBeDefined();
    expect(cleanup?.priority).toBe('medium');
    expect(cleanup?.reason).toContain('3');
  });

  it('fewer than 3 merged branches → no cleanup insight', () => {
    const repo = makeRepo();
    const branches = [
      makeBranch({ name: 'feat/a', is_merged: true }),
      makeBranch({ name: 'feat/b', is_merged: true }),
    ];
    const insights = generateInsights([repo], { [repo.path]: branches }, 14);
    expect(insights.filter((i) => i.type === 'prioritize')).toHaveLength(0);
  });

  it('stale branch (age > staleDays) → explain insight', () => {
    const repo = makeRepo();
    const staleSec = Math.floor(Date.now() / 1000) - 30 * 86400; // 30 days ago
    const branch = makeBranch({ name: 'old-feat', last_commit_ts: staleSec });
    const insights = generateInsights([repo], { [repo.path]: [branch] }, 14);
    const explain = insights.find((i) => i.type === 'explain');
    expect(explain).toBeDefined();
    expect(explain?.target).toBe('old-feat');
  });

  it('fresh branch (age <= staleDays) → no explain insight', () => {
    const repo = makeRepo();
    const recentSec = Math.floor(Date.now() / 1000) - 5 * 86400; // 5 days ago
    const branch = makeBranch({ name: 'new-feat', last_commit_ts: recentSec });
    const insights = generateInsights([repo], { [repo.path]: [branch] }, 14);
    expect(insights.filter((i) => i.type === 'explain')).toHaveLength(0);
  });

  it('stale branch with behind >= 10 → medium priority', () => {
    const repo = makeRepo();
    const staleSec = Math.floor(Date.now() / 1000) - 30 * 86400;
    const branch = makeBranch({ name: 'stale-feat', last_commit_ts: staleSec, behind: 10 });
    const insights = generateInsights([repo], { [repo.path]: [branch] }, 14);
    const explain = insights.find((i) => i.type === 'explain');
    expect(explain?.priority).toBe('medium');
  });

  it('stale branch with behind < 10 → low priority', () => {
    const repo = makeRepo();
    const staleSec = Math.floor(Date.now() / 1000) - 30 * 86400;
    const branch = makeBranch({ name: 'stale-feat', last_commit_ts: staleSec, behind: 3 });
    const insights = generateInsights([repo], { [repo.path]: [branch] }, 14);
    const explain = insights.find((i) => i.type === 'explain');
    expect(explain?.priority).toBe('low');
  });

  it('results sorted high → medium → low', () => {
    const repo = makeRepo({ ahead: 1, behind: 6 }); // diverged + behind>=5 → 2 high
    const staleSec = Math.floor(Date.now() / 1000) - 30 * 86400;
    const branches = [
      makeBranch({ name: 'feat/a', is_merged: true }),
      makeBranch({ name: 'feat/b', is_merged: true }),
      makeBranch({ name: 'feat/c', is_merged: true }),
      makeBranch({ name: 'stale', last_commit_ts: staleSec, behind: 3 }), // low
    ];
    const insights = generateInsights([repo], { [repo.path]: branches }, 14);
    const priorities = insights.map((i) => i.priority);
    const order: Record<string, number> = { high: 3, medium: 2, low: 1 };
    for (let i = 1; i < priorities.length; i++) {
      expect(order[priorities[i - 1]]).toBeGreaterThanOrEqual(order[priorities[i]]);
    }
  });

  it('current branch is excluded from merged/stale checks', () => {
    const repo = makeRepo();
    const branch = makeBranch({ name: 'main', is_current: true, is_merged: true });
    const insights = generateInsights([repo], { [repo.path]: [branch] }, 14);
    expect(insights).toHaveLength(0);
  });

  it('empty repos list → empty insights', () => {
    expect(generateInsights([], {}, 14)).toHaveLength(0);
  });
});
