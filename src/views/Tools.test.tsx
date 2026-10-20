import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';
import { act } from 'react';
import Tools from './Tools';
import * as invoke from '../lib/invoke';
import { useConsoleStore } from '../stores/consoleStore';
import { useEnvStore } from '../stores/envStore';
import { useReportStore } from '../stores/reportStore';
import { useUiStore } from '../stores/uiStore';
import { useUpdateStore } from '../stores/updateStore';
import { gemSkipped, runReport, unknownManager } from '../test/runReportFixtures';
import type { DsxStatus, UpdateCheck } from '../types';

const mockDsxLatestVersion = spyOn(invoke, 'dsxLatestVersion');
const mockSysUpdate = spyOn(invoke, 'sysUpdate');
const mockSysUpdateDryRun = spyOn(invoke, 'sysUpdateDryRun');
const mockRepoUpdate = spyOn(invoke, 'repoUpdate');
const mockDsxDoctor = spyOn(invoke, 'dsxDoctor');
const mockDsxSelfUpdate = spyOn(invoke, 'dsxSelfUpdate');
const mockUpdaterCheck = spyOn(invoke, 'updaterCheck');
const mockUpdaterInstall = spyOn(invoke, 'updaterInstall');
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
  mockUpdaterCheck.mockResolvedValue({ kind: 'up_to_date', current_version: '0.5.0' });
  mockUpdaterInstall.mockResolvedValue(undefined);
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

describe('Tools — Arbor の更新', () => {
  const available: UpdateCheck = { kind: 'available', current_version: '0.5.0', version: '0.6.0', notes: '新機能: 自動更新' };

  function setUpdate(status: Partial<ReturnType<typeof useUpdateStore.getState>>) {
    act(() => useUpdateStore.setState(status));
  }

  it.each([
    { name: '未確認', status: { state: 'idle' } as const, text: '更新を確認していません' },
    { name: '確認中', status: { state: 'checking' } as const, text: '更新を確認しています…' },
    {
      name: '最新版',
      status: { state: 'done', result: { kind: 'up_to_date', current_version: '0.5.0' } } as const,
      text: '✓ 最新版です（v0.5.0）',
    },
    {
      name: '対応していない環境',
      status: { state: 'done', result: { kind: 'unsupported', reason: 'Windows 版は MSIX で自動更新されます' } } as const,
      text: 'Windows 版は MSIX で自動更新されます',
    },
    { name: '失敗', status: { state: 'error', message: '更新の確認に失敗しました: timeout' } as const, text: '更新の確認に失敗しました: timeout' },
    {
      name: '適用中',
      status: { state: 'installing', version: '0.6.0' } as const,
      text: 'v0.6.0 をダウンロードして適用しています。完了すると再起動します…',
    },
  ])('$name の状態を表示する', ({ status, text }) => {
    setUpdate({ status });

    render(<Tools />);

    expect(screen.getByText(text)).toBeTruthy();
  });

  it('更新を確認 → 結果を表示する', async () => {
    mockUpdaterCheck.mockResolvedValue(available);
    render(<Tools />);

    await userEvent.click(button('更新を確認'));

    expect(await screen.findByText('↑ v0.6.0 が利用可能です（現在 v0.5.0）')).toBeTruthy();
    expect(screen.getByText('新機能: 自動更新')).toBeTruthy();
  });

  it('対応していない環境では、更新の確認を押せない', () => {
    setUpdate({ status: { state: 'done', result: { kind: 'unsupported', reason: 'x' } } });

    render(<Tools />);

    expect((button('更新を確認') as HTMLButtonElement).disabled).toBe(true);
  });

  it('確認ダイアログで承認すると、更新を適用する', async () => {
    setUpdate({ status: { state: 'done', result: available } });
    render(<Tools />);

    await userEvent.click(button('ダウンロードして再起動'));
    expect(screen.getByText('Arbor を v0.6.0 に更新しますか？')).toBeTruthy();
    await userEvent.click(button('更新して再起動'));

    await waitFor(() => expect(mockUpdaterInstall).toHaveBeenCalledTimes(1));
  });

  it('確認ダイアログでキャンセルすると、適用しない', async () => {
    setUpdate({ status: { state: 'done', result: available } });
    render(<Tools />);

    await userEvent.click(button('ダウンロードして再起動'));
    await userEvent.click(button('Cancel'));

    expect(mockUpdaterInstall).not.toHaveBeenCalled();
  });

  it('別のコマンドを実行中は、適用できない（再起動で中断するため）', () => {
    setUpdate({ status: { state: 'done', result: available } });
    act(() => {
      useConsoleStore.getState().handleStarted({ runId: 1, label: 'dsx run', argv: [], startedAt: 0 });
    });

    render(<Tools />);

    expect((button('ダウンロードして再起動') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Tools — 直近の実行の報告', () => {
  it('報告が無ければ LAST RUN を出さない', () => {
    render(<Tools />);

    expect(screen.queryByText('LAST RUN')).not.toBeInTheDocument();
  });

  it('報告があれば、失敗・スキップ・警告の内訳を出す', () => {
    act(() =>
      useReportStore.getState().setReport(
        runReport({
          jobs: { success: 4, failed: 0, skipped: 1 },
          warnings: 1,
          issues: [gemSkipped],
          warning_items: [unknownManager],
        }),
      ),
    );

    render(<Tools />);

    expect(screen.getByText('LAST RUN')).toBeInTheDocument();
    expect(screen.getByText('gem')).toBeInTheDocument();
    expect(screen.getByText('未インストールまたは利用不可のためスキップ')).toBeInTheDocument();
    expect(screen.getByText('foo')).toBeInTheDocument();
  });
});
