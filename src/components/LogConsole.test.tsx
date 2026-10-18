import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';
import * as invoke from '../lib/invoke';
import { useConsoleStore } from '../stores/consoleStore';
import { useUiStore } from '../stores/uiStore';
import type { ProcessFinished, ProcessOutput } from '../types';
import LogConsole from './LogConsole';

const mockCancelRun = spyOn(invoke, 'cancelRun');

// module export への spy をファイル外へ漏らさない
afterAll(() => {
  mock.restore();
});

const E = '\u001b';

const output = (text: string, overrides: Partial<ProcessOutput> = {}): ProcessOutput => ({
  runId: 1,
  stream: 'stdout',
  text,
  overwrite: false,
  ...overrides,
});

function startRun(outputs: ProcessOutput[] = []) {
  act(() => {
    useConsoleStore.getState().handleStarted({ runId: 1, label: 'dsx sys update', argv: ['dsx'], startedAt: 0 });
    useConsoleStore.getState().appendOutputs(outputs);
  });
}

function finishRun(overrides: Partial<ProcessFinished> = {}) {
  act(() => {
    useConsoleStore.getState().handleFinished({ runId: 1, exitCode: 0, durationMs: 1000, cancelled: false, ...overrides });
  });
}

function installClipboard() {
  const writeText = mock((_text: string) => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCancelRun.mockResolvedValue(undefined as never);
});

describe('LogConsole — 表示', () => {
  it('実行前は閉じており、ログ領域は描画されない', () => {
    render(<LogConsole />);

    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.queryByRole('log')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'コンソールを開く' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('実行が始まると自動で開き、開始行と出力を stream ごとに表示する', () => {
    render(<LogConsole />);
    startRun([output('hello'), output('warning', { stream: 'stderr' })]);

    const log = screen.getByRole('log', { name: '実行ログ' });
    expect(within(log).getByText('▶ dsx sys update').closest('[data-kind]')).toHaveAttribute('data-kind', 'system');
    expect(within(log).getByText('hello').closest('[data-kind]')).toHaveAttribute('data-kind', 'stdout');
    expect(within(log).getByText('warning').closest('[data-kind]')).toHaveAttribute('data-kind', 'stderr');
  });

  it('ANSI の色を反映し、エスケープ自体は表示しない', () => {
    render(<LogConsole />);
    startRun([output(`${E}[31mfailed${E}[0m and ${E}[32mok${E}[0m`)]);

    expect(screen.getByText('failed').style.color).toBe('var(--red)');
    expect(screen.getByText('ok').style.color).toBe('var(--green)');
    expect(screen.queryByText(/\[31m/)).not.toBeInTheDocument();
  });

  it('HTML として解釈される文字列は、そのまま文字として表示する', () => {
    render(<LogConsole />);
    startRun([output('<img src=x onerror=alert(1)>')]);

    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it.each<{ name: string; exitCode: number | null; cancelled: boolean; expected: RegExp }>([
    { name: '成功', exitCode: 0, cancelled: false, expected: /^完了: dsx sys update/ },
    { name: '失敗', exitCode: 2, cancelled: false, expected: /^失敗 \(exit 2\): dsx sys update/ },
    { name: 'キャンセル', exitCode: null, cancelled: true, expected: /^キャンセル: dsx sys update/ },
  ])('終了後のヘッダに結果（$name）を表示する', ({ exitCode, cancelled, expected }) => {
    render(<LogConsole />);
    startRun();
    expect(screen.getByText(/^実行中: dsx sys update/)).toBeInTheDocument();

    finishRun({ exitCode, cancelled });

    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('開閉ボタンでログ領域を閉じる・開く', async () => {
    render(<LogConsole />);
    startRun([output('line')]);

    await userEvent.click(screen.getByRole('button', { name: 'コンソールを閉じる' }));
    expect(screen.queryByRole('log')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'コンソールを開く' }));
    expect(screen.getByRole('log')).toBeInTheDocument();
  });
});

describe('LogConsole — 絞り込み・コピー・クリア', () => {
  it('フィルタ入力で表示する行を絞り込み、ANSI を除いた文字列で照合する', async () => {
    render(<LogConsole />);
    startRun([output('alpha'), output(`${E}[31mbeta${E}[0m`), output('gamma')]);

    await userEvent.type(screen.getByLabelText('ログを絞り込む'), 'BETA');

    const log = screen.getByRole('log');
    expect(within(log).getByText('beta')).toBeInTheDocument();
    expect(within(log).queryByText('alpha')).not.toBeInTheDocument();
    expect(within(log).queryByText('gamma')).not.toBeInTheDocument();
  });

  it('一致する行がないときは、その旨を表示する', async () => {
    render(<LogConsole />);
    startRun([output('alpha')]);

    await userEvent.type(screen.getByLabelText('ログを絞り込む'), 'zzz');

    expect(screen.getByText('条件に一致する行がありません。')).toBeInTheDocument();
  });

  it('Copy は表示中の行を ANSI を除いてコピーし、通知する', async () => {
    const writeText = installClipboard();
    render(<LogConsole />);
    startRun([output(`${E}[32mgreen${E}[0m line`), output('other')]);
    await userEvent.type(screen.getByLabelText('ログを絞り込む'), 'line');

    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(writeText).toHaveBeenCalledWith('green line');
    expect(useUiStore.getState().toasts.map((t) => t.message)).toContain('ログをコピーしました');
  });

  it('Copy が失敗したらエラーを通知する', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    });
    render(<LogConsole />);
    startRun([output('line')]);

    await userEvent.click(screen.getByRole('button', { name: 'Copy' }));

    const toast = useUiStore.getState().toasts.find((t) => t.kind === 'error');
    expect(toast?.message).toContain('コピーに失敗しました');
    expect(toast?.message).toContain('denied');
  });

  it('Clear でログを消す', async () => {
    render(<LogConsole />);
    startRun([output('line')]);

    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(useConsoleStore.getState().lines).toEqual([]);
    expect(screen.getByText(/実行ログがここに表示されます/)).toBeInTheDocument();
  });

  it('追従チェックボックスを切り替えられる', async () => {
    render(<LogConsole />);
    startRun([output('line')]);
    const checkbox = screen.getByRole('checkbox', { name: '追従' });
    expect(checkbox).toBeChecked();

    await userEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
  });
});

describe('LogConsole — キャンセル', () => {
  it('実行中だけキャンセルボタンを表示する', () => {
    render(<LogConsole />);
    expect(screen.queryByRole('button', { name: 'キャンセル' })).not.toBeInTheDocument();

    startRun();
    expect(screen.getByRole('button', { name: 'キャンセル' })).toBeInTheDocument();

    finishRun();
    expect(screen.queryByRole('button', { name: 'キャンセル' })).not.toBeInTheDocument();
  });

  it('確認ダイアログで承認すると、実行中の run をキャンセルする', async () => {
    render(<LogConsole />);
    startRun();

    await userEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('dsx sys update');
    expect(mockCancelRun).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole('button', { name: '強制終了' }));

    expect(mockCancelRun).toHaveBeenCalledWith(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('確認ダイアログを取り消すと、キャンセルしない', async () => {
    render(<LogConsole />);
    startRun();

    await userEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

    expect(mockCancelRun).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('キャンセルに失敗したらエラーを通知する', async () => {
    mockCancelRun.mockRejectedValue('実行中のコマンドが見つかりません（run 1）' as never);
    render(<LogConsole />);
    startRun();

    await userEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '強制終了' }));

    expect(useUiStore.getState().toasts.map((t) => t.message)).toContain('実行中のコマンドが見つかりません（run 1）');
  });
});
