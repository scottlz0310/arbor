import { afterAll, beforeEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';
import { act } from 'react';
import { dailyRefreshBlockReason, runDailyRefresh, runRepoUpdate, runSysUpdate, shortVersion } from './dsxActions';
import * as invoke from './invoke';
import { useReportStore } from '../stores/reportStore';
import { useUiStore } from '../stores/uiStore';
import { gemSkipped, npmFailed, runReport, unknownManager } from '../test/runReportFixtures';
import type { DsxStatus, WorkspaceStatus } from '../types';

const mockDailyRefresh = spyOn(invoke, 'dailyRefresh');
const mockSysUpdate = spyOn(invoke, 'sysUpdate');
const mockRepoUpdate = spyOn(invoke, 'repoUpdate');
const mockTakeRunReport = spyOn(invoke, 'takeRunReport');
const mockAddToast = mock();

// module export への spy をファイル外へ漏らさない
afterAll(() => {
  mock.restore();
});

const output = { stdout: '', stderr: '', exit_code: 0 };

function dsx(overrides: Partial<DsxStatus> = {}): DsxStatus {
  return {
    available: true,
    version: 'dsx version 0.12.0',
    path: '/bin/dsx',
    supports_daily_refresh: true,
    ...overrides,
  };
}

function workspace(overrides: Partial<WorkspaceStatus> = {}): WorkspaceStatus {
  return { root: '/home/src', root_error: null, workspace_count: 3, manual_count: 0, ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTakeRunReport.mockResolvedValue(null);
  act(() => {
    useUiStore.setState({ addToast: mockAddToast });
  });
});

describe('shortVersion', () => {
  it.each([
    { raw: 'dsx version 0.10.2', expected: 'v0.10.2' },
    { raw: 'dsx version v0.11.0', expected: 'v0.11.0' },
    { raw: '0.11.0', expected: 'v0.11.0' },
    { raw: '', expected: null },
    { raw: null, expected: null },
  ])('$raw → $expected', ({ raw, expected }) => {
    expect(shortVersion(raw)).toBe(expected);
  });
});

describe('dailyRefreshBlockReason', () => {
  it.each([
    { name: '実行できる', dsx: dsx(), ws: workspace(), expected: null },
    { name: 'dsx 未確認', dsx: null, ws: workspace(), expected: /確認しています/ },
    { name: 'workspace 未確認', dsx: dsx(), ws: null, expected: /確認しています/ },
    { name: 'dsx が無い', dsx: dsx({ available: false, version: null }), ws: workspace(), expected: /見つかりません/ },
    {
      name: 'dsx が古い',
      dsx: dsx({ version: 'dsx version 0.11.0', supports_daily_refresh: false }),
      ws: workspace(),
      expected: /v0\.12\.0 以上.*v0\.11\.0.*dsx Tools.*self-update/,
    },
    { name: 'root 未設定', dsx: dsx(), ws: workspace({ root: null }), expected: /未設定/ },
    {
      name: 'root を読めない',
      dsx: dsx(),
      ws: workspace({ root_error: 'workspace root を読み取れません (/home/src): denied' }),
      expected: /読み取れません/,
    },
  ])('$name', ({ dsx: status, ws, expected }) => {
    const reason = dailyRefreshBlockReason(status, ws);

    if (expected === null) expect(reason).toBeNull();
    else expect(reason).toMatch(expected);
  });
});

describe('run actions', () => {
  it.each([
    { name: 'Daily Refresh', run: runDailyRefresh, mock: mockDailyRefresh },
    { name: 'sys update', run: runSysUpdate, mock: mockSysUpdate },
    { name: 'Update All', run: runRepoUpdate, mock: mockRepoUpdate },
  ])('$name は成功を Toast で知らせる', async ({ name, run, mock: action }) => {
    action.mockResolvedValue(output);

    await run();

    expect(action).toHaveBeenCalledTimes(1);
    expect(mockAddToast).toHaveBeenCalledWith(`${name} 完了`, 'success');
  });

  it.each([
    { name: 'Daily Refresh', run: runDailyRefresh, mock: mockDailyRefresh },
    { name: 'sys update', run: runSysUpdate, mock: mockSysUpdate },
    { name: 'Update All', run: runRepoUpdate, mock: mockRepoUpdate },
  ])('$name の失敗は理由つきで Toast に出す', async ({ name, run, mock: action }) => {
    action.mockRejectedValue('別のコマンドを実行中です（run 3）');

    await run();

    expect(mockAddToast).toHaveBeenCalledWith(`${name}: 別のコマンドを実行中です（run 3）`, 'error');
  });
});

describe('run actions — 実行の報告（dsx v0.13.0 以上のイベント出力）', () => {
  const skippedReport = runReport({
    jobs: { success: 4, failed: 0, skipped: 1 },
    warnings: 1,
    issues: [gemSkipped],
    warning_items: [unknownManager],
  });

  it('成功した実行の報告を保持し、件数を Toast に添える', async () => {
    mockDailyRefresh.mockResolvedValue(output);
    mockTakeRunReport.mockResolvedValue(skippedReport);

    await runDailyRefresh();

    expect(useReportStore.getState().report).toEqual(skippedReport);
    expect(useReportStore.getState().receivedAt).not.toBeNull();
    expect(mockAddToast).toHaveBeenCalledWith('Daily Refresh 完了（スキップ 1・警告 1）', 'success');
  });

  it('件数が無い報告は、Toast を変えない', async () => {
    mockSysUpdate.mockResolvedValue(output);
    mockTakeRunReport.mockResolvedValue(runReport());

    await runSysUpdate();

    expect(useReportStore.getState().report).not.toBeNull();
    expect(mockAddToast).toHaveBeenCalledWith('sys update 完了', 'success');
  });

  it('失敗した実行でも報告を保持する（失敗の内訳が要る）', async () => {
    const failedReport = runReport({
      ok: false,
      jobs: { success: 4, failed: 1, skipped: 0 },
      issues: [npmFailed],
    });
    mockRepoUpdate.mockRejectedValue('dsx exited with code 1: ');
    mockTakeRunReport.mockResolvedValue(failedReport);

    const succeeded = await runRepoUpdate();

    expect(succeeded).toBe(false);
    expect(useReportStore.getState().report).toEqual(failedReport);
    expect(mockAddToast).toHaveBeenCalledWith('Update All: dsx exited with code 1: ', 'error');
  });

  it('報告が無い実行（古い dsx、doctor など）は、直前の報告を消さない', async () => {
    act(() => useReportStore.getState().setReport(skippedReport));
    mockSysUpdate.mockResolvedValue(output);
    mockTakeRunReport.mockResolvedValue(null);

    await runSysUpdate();

    expect(useReportStore.getState().report).toEqual(skippedReport);
  });

  it('報告の取得に失敗しても、実行の結果は変えず、取得の失敗を知らせる', async () => {
    mockSysUpdate.mockResolvedValue(output);
    mockTakeRunReport.mockRejectedValue('ipc failure');

    const succeeded = await runSysUpdate();

    expect(succeeded).toBe(true);
    expect(mockAddToast).toHaveBeenCalledWith('実行結果の詳細を取得できませんでした: ipc failure', 'error');
    expect(mockAddToast).toHaveBeenCalledWith('sys update 完了', 'success');
  });
});
