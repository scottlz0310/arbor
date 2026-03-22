/**
 * Rule-based Insight Engine (Phase 1)
 *
 * Generates deterministic insights from local repo state without any AI calls.
 * The AI engine (Phase 3) will run in parallel and its results will be merged
 * and sorted with these by priority score.
 */
import type { BranchInfo, Insight, RepoInfo } from '../types';

export function generateInsights(
  repos: RepoInfo[],
  branchesByRepo: Record<string, BranchInfo[]>,
  staleDays: number,
): Insight[] {
  const insights: Insight[] = [];
  const nowSec = Math.floor(Date.now() / 1000);
  const staleThresholdSec = staleDays * 86400;

  for (const repo of repos) {
    // Diverged repo — high risk
    if (repo.ahead > 0 && repo.behind > 0) {
      insights.push({
        type: 'risk',
        target: repo.name,
        priority: 'high',
        reason: `${repo.ahead}コミット先行・${repo.behind}コミット遅延: diverged状態`,
        source: 'rule',
        risk: 'high',
      });
    }

    // Far behind — prioritize pull
    if (repo.behind >= 5) {
      insights.push({
        type: 'prioritize',
        target: repo.name,
        priority: 'high',
        reason: `リモートから${repo.behind}コミット遅れています`,
        source: 'rule',
      });
    }

    const branches = branchesByRepo[repo.path] ?? [];

    // Merged branches accumulating
    const mergedCount = branches.filter(
      (b) => (b.is_merged || b.is_squash_merged) && !b.is_current,
    ).length;
    if (mergedCount >= 3) {
      insights.push({
        type: 'prioritize',
        target: repo.name,
        priority: 'medium',
        reason: `${mergedCount}本のマージ済みブランチが残っています`,
        source: 'rule',
      });
    }

    // Stale branches
    for (const branch of branches) {
      if (branch.is_current) continue;
      const ageSec = nowSec - branch.last_commit_ts;
      if (ageSec > staleThresholdSec) {
        const ageDays = Math.floor(ageSec / 86400);
        insights.push({
          type: 'explain',
          target: branch.name,
          priority: branch.behind >= 10 ? 'medium' : 'low',
          reason: `${ageDays}日間更新なし・mainから${branch.behind}コミット遅延`,
          source: 'rule',
        });
      }
    }
  }

  // Sort: high > medium > low
  const order = { high: 3, medium: 2, low: 1 };
  insights.sort((a, b) => order[b.priority] - order[a.priority]);

  return insights;
}
