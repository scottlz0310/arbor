import type { ReportIssue, RunReport } from '../types';

export type ReportTone = 'ok' | 'attention' | 'error';

export interface ReportCounts {
  failed: number;
  skipped: number;
  warnings: number;
}

export function reportCounts(report: RunReport): ReportCounts {
  return { failed: report.jobs.failed, skipped: report.jobs.skipped, warnings: report.warnings };
}

/**
 * 実行の総合判定。dsx の終了コードが 0 でないとき、または失敗があるとき error。
 * 失敗はなくても、スキップか警告があれば attention（ログを読まないと気づけないことを浮かび上がらせる）。
 */
export function reportTone(report: RunReport): ReportTone {
  const { failed, skipped, warnings } = reportCounts(report);
  if (!report.ok || failed > 0) return 'error';
  return skipped > 0 || warnings > 0 ? 'attention' : 'ok';
}

/** 「失敗 1・スキップ 2・警告 3」。0 件の項目は省く。すべて 0 なら null。 */
export function countsLabel(report: RunReport): string | null {
  const { failed, skipped, warnings } = reportCounts(report);
  const parts = [
    failed > 0 ? `失敗 ${failed}` : null,
    skipped > 0 ? `スキップ ${skipped}` : null,
    warnings > 0 ? `警告 ${warnings}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join('・') : null;
}

const CODE_LABELS: Record<string, string> = {
  error: '失敗',
  unavailable: '未インストール / 利用不可',
  pull_skipped: 'pull を実行せず',
  cancelled: 'キャンセル / タイムアウト',
};

/** 失敗・スキップの理由の分類（`code`）の表示名。dsx が値を足したときは、そのまま見せる。 */
export function codeLabel(code: string): string {
  return CODE_LABELS[code] ?? code;
}

const KIND_LABELS: Record<string, string> = {
  manager_self_update: '本体更新',
  phase: '段階',
};

/** ジョブの表示名。マネージャ本体の更新と段階の失敗は、種別を添える。 */
export function issueTitle(issue: ReportIssue): string {
  const kind = KIND_LABELS[issue.kind];
  return kind ? `${issue.name}（${kind}）` : issue.name;
}

const CATEGORY_LABELS: Record<string, string> = {
  manager_unknown: '未知のマネージャ',
  manager_config: 'マネージャの設定',
  repo_warning: 'リポジトリ',
  config_fallback: '設定ファイル',
  github_rate_limit: 'GitHub のレート制限',
};

/** 警告の分類（`category`）の表示名。dsx が値を足したときは、そのまま見せる。 */
export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

/** Toast に添える件数（「（スキップ 1・警告 2）」）。件数がなければ空文字。 */
export function toastSuffix(report: RunReport | null): string {
  const label = report ? countsLabel(report) : null;
  return label ? `（${label}）` : '';
}
