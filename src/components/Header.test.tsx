import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';
import { act } from 'react';
import Header from './Header';
import * as invoke from '../lib/invoke';
import { useConsoleStore } from '../stores/consoleStore';
import { useEnvStore } from '../stores/envStore';
import { useRepoStore } from '../stores/repoStore';
import { useUiStore } from '../stores/uiStore';
import type { BitwardenState, DsxStatus, WorkspaceStatus } from '../types';

const mockDailyRefresh = spyOn(invoke, 'dailyRefresh');
const mockSysUpdate = spyOn(invoke, 'sysUpdate');
const mockFetchRepositories = spyOn(invoke, 'fetchRepositories');
const mockDsxCheck = spyOn(invoke, 'dsxCheck');
const mockBitwardenStatus = spyOn(invoke, 'bitwardenStatus');
const mockGetWorkspaceStatus = spyOn(invoke, 'getWorkspaceStatus');
const mockLoadRepos = mock();
const mockAddToast = mock();

afterAll(() => {
  mock.restore();
});

const dsxReady: DsxStatus = {
  available: true,
  version: 'dsx version 0.11.0',
  path: '/bin/dsx',
  supports_run_root: true,
};
const dsxOld: DsxStatus = { ...dsxReady, version: 'dsx version 0.10.2', supports_run_root: false };
const dsxMissing: DsxStatus = { available: false, version: null, path: null, supports_run_root: false };
const workspaceOk: WorkspaceStatus = {
  root: '/home/src',
  root_error: null,
  workspace_count: 5,
  manual_count: 1,
};
const output = { stdout: '', stderr: '', exit_code: 0 };

function setEnv(dsx: DsxStatus | null, bitwarden: BitwardenState | null, workspace: WorkspaceStatus | null) {
  act(() => {
    useEnvStore.setState({ dsx, bitwarden, workspace });
  });
}

const button = (name: RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;

beforeEach(() => {
  jest.clearAllMocks();
  mockDailyRefresh.mockResolvedValue(output);
  mockSysUpdate.mockResolvedValue(output);
  mockFetchRepositories.mockResolvedValue({ total: 1, succeeded: 1, failed: [], cancelled: false });
  mockDsxCheck.mockResolvedValue(dsxReady);
  mockBitwardenStatus.mockResolvedValue('unlocked');
  mockGetWorkspaceStatus.mockResolvedValue(workspaceOk);
  mockLoadRepos.mockResolvedValue(undefined);
  act(() => {
    useRepoStore.setState({ loadRepos: mockLoadRepos });
    useUiStore.setState({ addToast: mockAddToast });
  });
});

describe('Header — 状態の pill', () => {
  it('確認前は「確認中」を表示する', () => {
    render(<Header />);

    expect(screen.getByText('dsx: 確認中')).toBeTruthy();
    expect(screen.getByText('Bitwarden: 確認中')).toBeTruthy();
    expect(screen.getByText('Root: 確認中')).toBeTruthy();
  });

  it.each([
    {
      name: '正常',
      dsx: dsxReady,
      bitwarden: 'unlocked' as const,
      workspace: workspaceOk,
      labels: ['dsx v0.11.0', 'Bitwarden: 解錠済み', 'Root: /home/src (6 repos)'],
    },
    {
      name: 'dsx が古く Bitwarden も未解錠',
      dsx: dsxOld,
      bitwarden: 'not_unlocked' as const,
      workspace: workspaceOk,
      labels: ['dsx v0.10.2（要更新）', 'Bitwarden: 未解錠', 'Root: /home/src (6 repos)'],
    },
    {
      name: 'dsx が無い',
      dsx: dsxMissing,
      bitwarden: 'unavailable' as const,
      workspace: workspaceOk,
      labels: ['dsx: 未検出', 'Bitwarden: 不明', 'Root: /home/src (6 repos)'],
    },
    {
      name: 'root が未設定',
      dsx: dsxReady,
      bitwarden: 'unlocked' as const,
      workspace: { ...workspaceOk, root: null },
      labels: ['dsx v0.11.0', 'Bitwarden: 解錠済み', 'Root: 未設定'],
    },
    {
      name: 'root を読めない',
      dsx: dsxReady,
      bitwarden: 'unlocked' as const,
      workspace: { ...workspaceOk, root_error: 'workspace root を読み取れません (/home/src): denied' },
      labels: ['dsx v0.11.0', 'Bitwarden: 解錠済み', 'Root: 読み取れません (/home/src)'],
    },
  ])('$name', ({ dsx, bitwarden, workspace, labels }) => {
    setEnv(dsx, bitwarden, workspace);

    render(<Header />);

    for (const label of labels) expect(screen.getByText(label)).toBeTruthy();
  });

  it('root を読めないときは、理由を pill のツールチップに出す', () => {
    const reason = 'workspace root を読み取れません (/home/src): denied';
    setEnv(dsxReady, 'unlocked', { ...workspaceOk, root_error: reason });

    render(<Header />);

    expect(screen.getByText('Root: 読み取れません (/home/src)').getAttribute('title')).toBe(reason);
  });
});

describe('Header — Daily Refresh', () => {
  it('実行できる状態なら押せて、dailyRefresh を呼ぶ', async () => {
    setEnv(dsxReady, 'unlocked', workspaceOk);
    render(<Header />);

    await userEvent.click(button(/Daily Refresh/));

    expect(mockDailyRefresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockAddToast).toHaveBeenCalledWith('Daily Refresh 完了', 'success'));
  });

  it.each([
    { name: '状態が未確認', dsx: null, workspace: null, reason: /確認しています/ },
    { name: 'dsx が無い', dsx: dsxMissing, workspace: workspaceOk, reason: /見つかりません/ },
    { name: 'dsx が古い', dsx: dsxOld, workspace: workspaceOk, reason: /v0\.11\.0 以上/ },
    { name: 'root が未設定', dsx: dsxReady, workspace: { ...workspaceOk, root: null }, reason: /未設定/ },
  ])('$name ときは押せず、理由をツールチップに出す', async ({ dsx, workspace, reason }) => {
    setEnv(dsx, 'unlocked', workspace);
    render(<Header />);

    const target = button(/Daily Refresh/);
    expect(target.disabled).toBe(true);
    expect(target.getAttribute('title')).toMatch(reason);
  });

  it('別のコマンドの実行中は押せない', () => {
    setEnv(dsxReady, 'unlocked', workspaceOk);
    act(() => {
      useConsoleStore.getState().handleStarted({ runId: 1, label: 'dsx repo update', argv: [], startedAt: 0 });
    });

    render(<Header />);

    for (const name of [/Fetch All/, /sys update/, /Daily Refresh/]) {
      expect(button(name).disabled).toBe(true);
    }
    // Scan は読み取りだけなので、実行中でも押せる。
    expect(button(/Scan/).disabled).toBe(false);
  });

  it('Bitwarden が未解錠なら、確認してから実行する', async () => {
    setEnv(dsxReady, 'not_unlocked', workspaceOk);
    render(<Header />);

    await userEvent.click(button(/Daily Refresh/));
    expect(screen.getByText('Bitwarden が解錠されていません')).toBeTruthy();
    expect(mockDailyRefresh).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: '実行する' }));

    expect(mockDailyRefresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Bitwarden が解錠されていません')).toBeNull();
  });

  it('確認ダイアログをキャンセルすると実行しない', async () => {
    setEnv(dsxReady, 'not_unlocked', workspaceOk);
    render(<Header />);

    await userEvent.click(button(/Daily Refresh/));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(mockDailyRefresh).not.toHaveBeenCalled();
    expect(screen.queryByText('Bitwarden が解錠されていません')).toBeNull();
  });
});

describe('Header — その他のボタン', () => {
  it('dsx sys update は sysUpdate を呼ぶ', async () => {
    setEnv(dsxReady, 'unlocked', workspaceOk);
    render(<Header />);

    await userEvent.click(button(/sys update/));

    expect(mockSysUpdate).toHaveBeenCalledTimes(1);
  });

  it('dsx が無いと dsx sys update は押せない', () => {
    setEnv(dsxMissing, 'unavailable', workspaceOk);
    render(<Header />);

    expect(button(/sys update/).disabled).toBe(true);
  });

  it('Fetch All は fetchRepositories を呼ぶ', async () => {
    setEnv(dsxReady, 'unlocked', workspaceOk);
    render(<Header />);

    await userEvent.click(button(/Fetch All/));

    expect(mockFetchRepositories).toHaveBeenCalledTimes(1);
  });

  it('Scan は一覧と環境の状態を読み直す（ネットワークには出ない）', async () => {
    setEnv(dsxReady, 'unlocked', workspaceOk);
    render(<Header />);

    await userEvent.click(button(/Scan/));

    expect(mockLoadRepos).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockGetWorkspaceStatus).toHaveBeenCalledTimes(1));
    expect(mockFetchRepositories).not.toHaveBeenCalled();
  });
});

describe('Header — Settings', () => {
  it('Settings ボタンで Settings を開き、開いている間は押し直すと Status へ戻る', async () => {
    act(() => useUiStore.setState({ activeView: 'status' }));
    render(<Header />);

    await userEvent.click(button(/Settings/));
    expect(useUiStore.getState().activeView).toBe('settings');
    expect(button(/Settings/).getAttribute('aria-pressed')).toBe('true');

    await userEvent.click(button(/Settings/));
    expect(useUiStore.getState().activeView).toBe('status');
  });
});
