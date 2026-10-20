import { describe, expect, it } from 'bun:test';
import { categoryLabel, codeLabel, countsLabel, issueTitle, reportCounts, reportTone, toastSuffix } from './runReport';
import { gemSkipped, npmFailed, runReport } from '../test/runReportFixtures';

describe('reportTone', () => {
  it.each([
    { name: '問題なし', report: runReport(), expected: 'ok' },
    {
      name: 'スキップだけ（終了コード 0）は要確認',
      report: runReport({ jobs: { success: 4, failed: 0, skipped: 1 }, issues: [gemSkipped] }),
      expected: 'attention',
    },
    { name: '警告だけ（終了コード 0）は要確認', report: runReport({ warnings: 1 }), expected: 'attention' },
    {
      name: '失敗があれば失敗',
      report: runReport({ ok: false, jobs: { success: 4, failed: 1, skipped: 0 }, issues: [npmFailed] }),
      expected: 'error',
    },
    {
      name: '失敗ジョブが無くても終了コードが 1 なら失敗（キャンセル・段階の失敗など）',
      report: runReport({ ok: false, error: '1 件のエラーが発生しました' }),
      expected: 'error',
    },
    {
      name: 'ok でも failed が 1 件でもあれば失敗（防御）',
      report: runReport({ jobs: { success: 0, failed: 1, skipped: 0 } }),
      expected: 'error',
    },
  ])('$name', ({ report, expected }) => {
    expect(reportTone(report)).toBe(expected);
  });
});

describe('countsLabel / reportCounts', () => {
  it.each([
    { name: 'すべて 0 なら null', report: runReport(), expected: null },
    { name: '失敗だけ', report: runReport({ jobs: { success: 0, failed: 2, skipped: 0 } }), expected: '失敗 2' },
    { name: 'スキップだけ', report: runReport({ jobs: { success: 0, failed: 0, skipped: 3 } }), expected: 'スキップ 3' },
    { name: '警告だけ', report: runReport({ warnings: 1 }), expected: '警告 1' },
    {
      name: '全部あれば 失敗・スキップ・警告 の順',
      report: runReport({ jobs: { success: 0, failed: 1, skipped: 2 }, warnings: 3 }),
      expected: '失敗 1・スキップ 2・警告 3',
    },
  ])('$name', ({ report, expected }) => {
    expect(countsLabel(report)).toBe(expected);
  });

  it('reportCounts は要約の件数をそのまま返す', () => {
    const report = runReport({ jobs: { success: 9, failed: 1, skipped: 2 }, warnings: 3 });

    expect(reportCounts(report)).toEqual({ failed: 1, skipped: 2, warnings: 3 });
  });
});

describe('toastSuffix', () => {
  it.each([
    { name: '報告なし', report: null, expected: '' },
    { name: '件数なし', report: runReport(), expected: '' },
    { name: '件数あり', report: runReport({ jobs: { success: 1, failed: 0, skipped: 1 }, warnings: 2 }), expected: '（スキップ 1・警告 2）' },
  ])('$name', ({ report, expected }) => {
    expect(toastSuffix(report)).toBe(expected);
  });
});

describe('表示名', () => {
  it.each([
    { code: 'error', expected: '失敗' },
    { code: 'unavailable', expected: '未インストール / 利用不可' },
    { code: 'pull_skipped', expected: 'pull を実行せず' },
    { code: 'cancelled', expected: 'キャンセル / タイムアウト' },
    { code: 'future_code', expected: 'future_code' },
  ])('codeLabel($code)', ({ code, expected }) => {
    expect(codeLabel(code)).toBe(expected);
  });

  it.each([
    { category: 'manager_unknown', expected: '未知のマネージャ' },
    { category: 'repo_warning', expected: 'リポジトリ' },
    { category: 'config_fallback', expected: '設定ファイル' },
    { category: 'github_rate_limit', expected: 'GitHub のレート制限' },
    { category: 'manager_config', expected: 'マネージャの設定' },
    { category: 'future_category', expected: 'future_category' },
  ])('categoryLabel($category)', ({ category, expected }) => {
    expect(categoryLabel(category)).toBe(expected);
  });

  it.each([
    { kind: 'manager', name: 'gem', expected: 'gem' },
    { kind: 'repo', name: 'arbor', expected: 'arbor' },
    { kind: 'manager_self_update', name: 'pnpm', expected: 'pnpm（本体更新）' },
    { kind: 'phase', name: 'repo', expected: 'repo（段階）' },
  ])('issueTitle($kind $name)', ({ kind, name, expected }) => {
    expect(issueTitle({ ...gemSkipped, kind, name })).toBe(expected);
  });
});
