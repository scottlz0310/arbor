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
  ollamaOffline: boolean;
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
    repo_path: r.repo_path,
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
  const ruleResult = (ollamaOffline = false): InsightResult => ({
    insights: generateInsights(repos, branchesByRepo, staleDays),
    source: 'rule',
    ollamaOffline,
  });

  try {
    const available = await ollamaAvailable();
    if (!available) return ruleResult(true);

    const raw = await getAiInsightsCached(repos);
    // raw=[] はキャッシュミス（バックグラウンド生成中）か全リポジトリがクリーンな場合。
    // どちらもルール結果を返す。AI が成功すれば ai_insights_updated イベントで上書きされる。
    if (raw.length === 0) return ruleResult(false);
    return { insights: convertAiInsights(raw), source: 'ai', ollamaOffline: false };
  } catch {
    return ruleResult(false);
  }
}
