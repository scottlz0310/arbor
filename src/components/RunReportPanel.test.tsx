import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'bun:test';
import RunReportPanel from './RunReportPanel';
import { gemSkipped, npmFailed, runReport, unknownManager } from '../test/runReportFixtures';

describe('RunReportPanel', () => {
  it('問題が無ければ、その旨と件数だけを出す', () => {
    render(<RunReportPanel report={runReport()} receivedAt={null} />);

    expect(screen.getByText('問題なし')).toBeInTheDocument();
    expect(screen.getByText(/失敗・スキップ・警告はありません/)).toBeInTheDocument();
    expect(screen.queryByText('失敗・スキップ')).not.toBeInTheDocument();
    expect(screen.queryByText('警告')).not.toBeInTheDocument();
  });

  it('スキップと警告の理由を、対象ごとに出す（ログを読まなくても気づける）', () => {
    const report = runReport({
      jobs: { success: 4, failed: 0, skipped: 1 },
      warnings: 1,
      issues: [gemSkipped],
      warning_items: [unknownManager],
    });

    render(<RunReportPanel report={report} receivedAt={null} />);

    expect(screen.getByText('要確認')).toBeInTheDocument();
    expect(screen.getByText('失敗・スキップ')).toBeInTheDocument();
    expect(screen.getByText('未インストール / 利用不可')).toBeInTheDocument();
    expect(screen.getByText('gem')).toBeInTheDocument();
    expect(screen.getByText('未インストールまたは利用不可のためスキップ')).toBeInTheDocument();
    expect(screen.getByText('警告')).toBeInTheDocument();
    expect(screen.getByText('未知のマネージャ')).toBeInTheDocument();
    expect(screen.getByText('foo')).toBeInTheDocument();
  });

  it('失敗した実行は、終了の理由と失敗したジョブを出す', () => {
    const report = runReport({
      ok: false,
      error: '1 件のエラーが発生しました',
      jobs: { success: 4, failed: 1, skipped: 0 },
      issues: [npmFailed, { ...gemSkipped, kind: 'phase', name: 'repo', status: 'failed', code: 'error', reason: 'root が存在しません' }],
    });

    render(<RunReportPanel report={report} receivedAt={null} />);

    expect(screen.getByText('失敗あり')).toBeInTheDocument();
    expect(screen.getByText(/終了: 1 件のエラーが発生しました/)).toBeInTheDocument();
    expect(screen.getByText('exit status 1')).toBeInTheDocument();
    expect(screen.getByText('repo（段階）')).toBeInTheDocument();
    expect(screen.getByText('root が存在しません')).toBeInTheDocument();
  });

  it('受け取った時刻があれば添える', () => {
    const at = new Date(2026, 9, 21, 9, 5, 7).getTime();

    render(<RunReportPanel report={runReport()} receivedAt={at} />);

    expect(screen.getByText(new Date(at).toLocaleTimeString('ja-JP'))).toBeInTheDocument();
  });
});
