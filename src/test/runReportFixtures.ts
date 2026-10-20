import type { ReportIssue, ReportWarning, RunReport } from '../types';

/** テスト用の dsx の実行の報告。既定は「問題なし」。 */
export function runReport(overrides: Partial<RunReport> = {}): RunReport {
  return {
    command: 'run',
    ok: true,
    error: null,
    jobs: { success: 5, failed: 0, skipped: 0 },
    updated: 2,
    warnings: 0,
    issues: [],
    warning_items: [],
    ...overrides,
  };
}

/** 未インストールのマネージャのスキップ（dsx#152 の動機になった例）。 */
export const gemSkipped: ReportIssue = {
  phase: 'sys',
  kind: 'manager',
  name: 'gem',
  status: 'skipped',
  code: 'unavailable',
  reason: '未インストールまたは利用不可のためスキップ',
};

export const npmFailed: ReportIssue = {
  phase: 'sys',
  kind: 'manager',
  name: 'npm',
  status: 'failed',
  code: 'error',
  reason: 'exit status 1',
};

export const unknownManager: ReportWarning = {
  phase: 'sys',
  category: 'manager_unknown',
  subject: 'foo',
  message: '未知のマネージャが指定されています',
};
