/**
 * Rule-based Insight Engine
 *
 * Generates deterministic insights from local repo state (diverged / far behind).
 */
import type { Insight, RepoInfo } from '../types';

export function generateInsights(repos: RepoInfo[]): Insight[] {
  const insights: Insight[] = [];

  for (const repo of repos) {
    // Diverged repo — high risk
    if (repo.ahead > 0 && repo.behind > 0) {
      insights.push({
        type: 'risk',
        target: repo.name,
        repo_path: repo.path,
        priority: 'high',
        reason: `${repo.ahead}コミット先行・${repo.behind}コミット遅延: diverged状態`,
      });
    }

    // Far behind — prioritize pull
    if (repo.behind >= 5) {
      insights.push({
        type: 'prioritize',
        target: repo.name,
        repo_path: repo.path,
        priority: 'high',
        reason: `リモートから${repo.behind}コミット遅れています`,
      });
    }
  }

  // Sort: high > medium > low
  const order = { high: 3, medium: 2, low: 1 };
  insights.sort((a, b) => order[b.priority] - order[a.priority]);

  return insights;
}
