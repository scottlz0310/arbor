import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';
import { act } from 'react';
import Tools from './Tools';
import * as invoke from '../lib/invoke';
import { useConsoleStore } from '../stores/consoleStore';
import { useEnvStore } from '../stores/envStore';
import { useUiStore } from '../stores/uiStore';
import type { DsxStatus } from '../types';

const mockDsxLatestVersion = spyOn(invoke, 'dsxLatestVersion');
const mockSysUpdate = spyOn(invoke, 'sysUpdate');
const mockSysUpdateDryRun = spyOn(invoke, 'sysUpdateDryRun');
const mockRepoUpdate = spyOn(invoke, 'repoUpdate');
const mockDsxDoctor = spyOn(invoke, 'dsxDoctor');
const mockDsxSelfUpdate = spyOn(invoke, 'dsxSelfUpdate');
const mockEnvRefresh = mock();
const mockAddToast = mock();

// module export への spy をファイル外へ漏らさない
afterAll(() => {
  mock.restore();
});

const output = { stdout: '', stderr: '', exit_code: 0 };

function dsxStatus(version: string, overrides: Partial<DsxStatus> = {}): DsxStatus {
  return { available: true, version: `dsx version ${version}`, path: '/usr/local/bin/dsx', supports_daily_refresh: true, ...overrides };
}

const missing: DsxStatus = { available: false, version: null, path: null, supports_daily_refresh: false };

function setDsx(dsx: DsxStatus | null) {
  act(() => useEnvStore.setState({ dsx }));
}

const button = (name: string | RegExp) => screen.getByRole('button', { name });

beforeEach(() => {
  jest.clearAllMocks();
  mockDsxLatestVersion.mockResolvedValue('v0.11.0');
  for (const m of [mockSysUpdate, mockSysUpdateDryRun, mockRepoUpdate, mockDsxDoctor, mockDsxSelfUpdate]) {
    m.mockResolvedValue(output);
  }
  mockEnvRefresh.mockResolvedValue(undefined);
  act(() => {
    useUiStore.setState({ addToast: mockAddToast });
    useEnvStore.setState({ refresh: mockEnvRefresh });
  });
  setDsx(dsxStatus('0.11.0'));
});

describe('Tools — dsx CLI', () => {
  it('版と場所を表示する', () => {
    render(<Tools />);

    expect(screen.getByText(/✓ dsx v0\.11\.0/)).toBeTruthy();
    expect(screen.getByText('/usr/local/bin/dsx')).toBeTruthy();
  });

  it('確認前は、確認中の表示にする', () => {
    setDsx(null);

    render(<Tools />);

    expect(screen.getByText('dsx を確認しています…')).toBeTruthy();
  });

  it('dsx が無いときは、インストール手順を表示し、操作を無効にする', () => {
    setDsx(missing);

    render(<Tools />);

    expect(screen.getByText(/dsx が見つかりません/)).toBeTruthy();
    expect(screen.getByText('go install github.com/scottlz0310/dsx@latest')).toBeTruthy();
    for (const name of [/Update All Tools/, /Dry Run/, /Update Repositories/, /Doctor/]) {
      expect((button(name) as HTMLButtonElement).disabled).toBe(true);
    }
  });
});

describe('Tools — バージョン確認', () => {
  it.each([
    { name: '最新版', current: '0.11.0', latest: 'v0.11.0', text: /最新版です（v0\.11\.0）/, selfUpdate: false },
    { name: 'より新しい版がある', current: '0.10.2', latest: 'v0.11.0', text: /v0\.11\.0 が利用可能/, selfUpdate: true },
    { name: '手元のほうが新しい（0.2.10 > 0.2.9）', current: '0.2.10', latest: 'v0.2.9', text: /最新版です/, selfUpdate: false },
    { name: '手元のほうが古い（0.2.5 < 0.2.50）', current: '0.2.5', latest: 'v0.2.50', text: /v0\.2\.50 が利用可能/, selfUpdate: true },
    { name: '取得できない（null）', current: '0.11.0', latest: null, text: /取得できませんでした/, selfUpdate: false },
    { name: '比較できない版', current: 'dev', latest: 'v0.11.0', text: /比較できませんでした/, selfUpdate: false },
  ])('$name', async ({ current, latest, text, selfUpdate }) => {
    setDsx(dsxStatus(current));
    mockDsxLatestVersion.mockResolvedValue(latest);
    render(<Tools />);

    await userEvent.click(button('バージョン確認'));

    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Self Update' }) !== null).toBe(selfUpdate);
  });

  it('取得に失敗したら、その旨を表示する', async () => {
    mockDsxLatestVersion.mockRejectedValue(new Error('network'));
    render(<Tools />);

    await userEvent.click(button('バージョン確認'));

    expect(await screen.findByText('バージョン情報を取得できませんでした')).toBeTruthy();
  });
});

describe('Tools — Self Update', () => {
  async function openSelfUpdateConfirm() {
    setDsx(dsxStatus('0.10.2'));
    render(<Tools />);
    await userEvent.click(button('バージョン確認'));
    await userEvent.click(await screen.findByRole('button', { name: 'Self Update' }));
  }

  it('確認ダイアログでキャンセルすると実行しない', async () => {
    await openSelfUpdateConfirm();

    await userEvent.click(button('Cancel'));

    expect(mockDsxSelfUpdate).not.toHaveBeenCalled();
  });

  it('版が上がったら、完了を知らせ、手順の案内は出さない', async () => {
    await openSelfUpdateConfirm();
    mockEnvRefresh.mockImplementation(async () => setDsx(dsxStatus('0.11.0')));

    await userEvent.click(button('実行'));

    await waitFor(() => expect(mockDsxSelfUpdate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockEnvRefresh).toHaveBeenCalled());
    expect(mockAddToast).toHaveBeenCalledWith('dsx self-update 完了', 'success');
    expect(screen.queryByText(/dsx の版が上がりませんでした/)).toBeNull();
  });

  it('完了しても版が上がらなかったら（MSIX 版）、install.ps1 の手順を案内する', async () => {
    await openSelfUpdateConfirm();
    // 版は 0.10.2 のまま

    await userEvent.click(button('実行'));

    expect(await screen.findByText(/dsx の版が上がりませんでした/)).toBeTruthy();
    expect(screen.getByText(/MSIX 版の dsx は/)).toBeTruthy();
    expect(screen.getByText(/install\.ps1/)).toBeTruthy();
  });

  it('self-update が失敗したときは、版が上がらなかった案内は出さない（失敗は Toast で伝える）', async () => {
    await openSelfUpdateConfirm();
    mockDsxSelfUpdate.mockRejectedValue('network error');

    await userEvent.click(button('実行'));

    await waitFor(() => expect(mockAddToast).toHaveBeenCalledWith('dsx self-update: network error', 'error'));
    expect(screen.queryByText(/dsx の版が上がりませんでした/)).toBeNull();
    expect(mockEnvRefresh).not.toHaveBeenCalled();
  });
});

describe('Tools — アクション', () => {
  it('Update All Tools は、確認してから sysUpdate を実行する', async () => {
    render(<Tools />);

    await userEvent.click(button(/Update All Tools/));
    expect(screen.getByText('dsx sys update — システム全体の更新')).toBeTruthy();
    expect(mockSysUpdate).not.toHaveBeenCalled();
    await userEvent.click(button('実行'));

    await waitFor(() => expect(mockSysUpdate).toHaveBeenCalledTimes(1));
  });

  it('Update All Tools の確認をキャンセルすると、実行しない', async () => {
    render(<Tools />);

    await userEvent.click(button(/Update All Tools/));
    await userEvent.click(button('Cancel'));

    expect(mockSysUpdate).not.toHaveBeenCalled();
  });

  it.each([
    { name: /Dry Run/, mock: mockSysUpdateDryRun, toast: 'sys update -n 完了' },
    { name: /Update Repositories/, mock: mockRepoUpdate, toast: 'Update All 完了' },
    { name: /Doctor/, mock: mockDsxDoctor, toast: 'dsx doctor 完了' },
  ])('$name は確認なしで実行し、完了を知らせる', async ({ name, mock: action, toast }) => {
    render(<Tools />);

    await userEvent.click(button(name));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockAddToast).toHaveBeenCalledWith(toast, 'success'));
  });

  it('別のコマンドを実行中は、すべての操作を無効にする', () => {
    act(() => {
      useConsoleStore.getState().handleStarted({ runId: 1, label: 'dsx run', argv: [], startedAt: 0 });
    });

    render(<Tools />);

    for (const name of [/Update All Tools/, /Dry Run/, /Update Repositories/, /Doctor/]) {
      expect((button(name) as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
