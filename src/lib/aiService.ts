/**
 * AI Insight サービス (P3-05)
 *
 * Ollama の可用性をチェックし、利用可能なら AI Insight を返す。
 * 未起動・タイムアウト・エラーの場合はルールベースエンジンにフォールバック。
 */
import type { AiInsight, BranchInfo, Insight, RepoInfo } from '../types';
import { getAiInsightsCached, ollamaAvailable } from './invoke';
import { generateInsights } from './ruleEngine';

export type InsightSource = 'ai' | 'rule';

export interface InsightResult {
  insights: Insight[];
  source: InsightSource;
}

// priority 0-3 → Insight['priority'] のマッピング
const PRIORITY_MAP: Record<number, Insight['priority']> = {
  3: 'high',
  2: 'high',
  1: 'medium',
  0: 'low',
};

/** AiInsight[] (Rust モデル) を UI の Insight[] に変換する。 */
export function convertAiInsights(raw: AiInsight[]): Insight[] {
  return raw.map((r) => ({
    type: r.kind,
    target: r.repo_name,
    priority: PRIORITY_MAP[r.priority] ?? 'low',
    reason: r.message,
    source: 'ai' as const,
  }));
}

/**
 * Ollama が利用可能なら AI Insight を返し、そうでなければルールベースにフォールバック。
 * どちらの場合も必ず InsightResult を返す（例外を投げない）。
 */
export async function fetchInsights(
  repos: RepoInfo[],
  branchesByRepo: Record<string, BranchInfo[]>,
  staleDays: number,
): Promise<InsightResult> {
  const ruleResult = (): InsightResult => ({
    insights: generateInsights(repos, branchesByRepo, staleDays),
    source: 'rule',
  });

  try {
    const available = await ollamaAvailable();
    if (!available) return ruleResult();

    const raw = await getAiInsightsCached(repos);
    return { insights: convertAiInsights(raw), source: 'ai' };
  } catch {
    return ruleResult();
  }
}
