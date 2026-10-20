import { afterAll, beforeEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';
import { act } from 'react';
import { dailyRefreshBlockReason, runDailyRefresh, runRepoUpdate, runSysUpdate, shortVersion } from './dsxActions';
import * as invoke from './invoke';
import { useUiStore } from '../stores/uiStore';
import type { DsxStatus, WorkspaceStatus } from '../types';

const mockDailyRefresh = spyOn(invoke, 'dailyRefresh');
const mockSysUpdate = spyOn(invoke, 'sysUpdate');
const mockRepoUpdate = spyOn(invoke, 'repoUpdate');
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
