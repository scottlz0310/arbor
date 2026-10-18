import { describe, expect, it } from 'bun:test';
import type { ProcessFinished, ProcessOutput, ProcessStarted } from '../types';
import { MAX_LINES, useConsoleStore } from './consoleStore';

const started = (runId = 1): ProcessStarted => ({
  runId,
  label: 'dsx sys update',
  argv: ['dsx', 'sys', 'update'],
  startedAt: 1_700_000_000_000,
});

const output = (text: string, overrides: Partial<ProcessOutput> = {}): ProcessOutput => ({
  runId: 1,
  stream: 'stdout',
  text,
  overwrite: false,
  ...overrides,
});

const finished = (overrides: Partial<ProcessFinished> = {}): ProcessFinished => ({
  runId: 1,
  exitCode: 0,
  durationMs: 2340,
  cancelled: false,
  ...overrides,
});

const texts = () => useConsoleStore.getState().lines.map((l) => l.text);

describe('consoleStore — run のライフサイクル', () => {
  it('開始でドックが開き、実行中の run と開始行が記録される', () => {
    useConsoleStore.getState().handleStarted(started());

    const state = useConsoleStore.getState();
    expect(state.open).toBe(true);
    expect(state.run).toMatchObject({ runId: 1, label: 'dsx sys update', status: 'running' });
    expect(texts()).toEqual(['▶ dsx sys update']);
    expect(state.lines[0].kind).toBe('system');
  });

  it.each([
    { name: '成功', event: finished(), status: 'succeeded', message: '✓ 完了 (2.3s)' },
    { name: '失敗', event: finished({ exitCode: 3 }), status: 'failed', message: '✗ 失敗 (exit 3, 2.3s)' },
    { name: '終了コードなし', event: finished({ exitCode: null }), status: 'failed', message: '✗ 失敗 (exit 不明, 2.3s)' },
    {
      name: 'キャンセル',
      event: finished({ exitCode: null, cancelled: true }),
      status: 'cancelled',
      message: '■ キャンセルしました (2.3s)',
    },
  ])('終了（$name）で状態と結果行が更新される', ({ event, status, message }) => {
    useConsoleStore.getState().handleStarted(started());
    useConsoleStore.getState().handleFinished(event);

    const state = useConsoleStore.getState();
    expect(state.run).toMatchObject({ status, exitCode: event.exitCode, durationMs: 2340 });
    expect(texts().at(-1)).toBe(message);
  });

  it('別の run の終了イベントでは、現在の run の状態を変えない', () => {
    useConsoleStore.getState().handleStarted(started(2));
    useConsoleStore.getState().handleFinished(finished({ runId: 1 }));

    expect(useConsoleStore.getState().run?.status).toBe('running');
  });
});

describe('consoleStore — 出力', () => {
  it('出力を受信順に追記し、stream を保持する', () => {
    useConsoleStore.getState().appendOutputs([
      output('out-1'),
      output('err-1', { stream: 'stderr' }),
      output('out-2'),
    ]);

    expect(useConsoleStore.getState().lines.map((l) => [l.kind, l.text])).toEqual([
      ['stdout', 'out-1'],
      ['stderr', 'err-1'],
      ['stdout', 'out-2'],
    ]);
  });

  it('空の配列では状態を更新しない', () => {
    const before = useConsoleStore.getState().lines;
    useConsoleStore.getState().appendOutputs([]);
    expect(useConsoleStore.getState().lines).toBe(before);
  });

  it('overwrite は同じ run・同じ stream の直近の行を置き換える（id は保つ）', () => {
    useConsoleStore.getState().appendOutputs([output('10%')]);
    const firstId = useConsoleStore.getState().lines[0].id;

    useConsoleStore.getState().appendOutputs([output('20%', { overwrite: true }), output('30%', { overwrite: true })]);

    const lines = useConsoleStore.getState().lines;
    expect(lines.map((l) => l.text)).toEqual(['30%']);
    expect(lines[0].id).toBe(firstId);
  });

  it('overwrite の間に別 stream の行が入っても、同じ stream の行を置き換える', () => {
    useConsoleStore.getState().appendOutputs([
      output('10%'),
      output('warn', { stream: 'stderr' }),
      output('20%', { overwrite: true }),
    ]);

    expect(texts()).toEqual(['20%', 'warn']);
  });

  const appendCases: { name: string; events: ProcessOutput[]; expected: string[] }[] = [
    { name: '置き換える行がない', events: [output('first', { overwrite: true })], expected: ['first'] },
    {
      name: '別の run の行は置き換えない',
      events: [output('run1'), output('run2', { runId: 2, overwrite: true })],
      expected: ['run1', 'run2'],
    },
  ];

  it.each(appendCases)('overwrite でも$name場合は追記する', ({ events, expected }) => {
    useConsoleStore.getState().appendOutputs(events);
    expect(texts()).toEqual(expected);
  });

  it('上限を超えた分は古い行から捨てる', () => {
    const events = Array.from({ length: MAX_LINES + 5 }, (_, i) => output(`line-${i}`));
    useConsoleStore.getState().appendOutputs(events);

    const lines = useConsoleStore.getState().lines;
    expect(lines).toHaveLength(MAX_LINES);
    expect(lines[0].text).toBe('line-5');
    expect(lines.at(-1)?.text).toBe(`line-${MAX_LINES + 4}`);
  });
});

describe('consoleStore — 操作', () => {
  it('clear は行だけを消し、run の状態は保つ', () => {
    useConsoleStore.getState().handleStarted(started());
    useConsoleStore.getState().appendOutputs([output('a')]);

    useConsoleStore.getState().clear();

    expect(useConsoleStore.getState().lines).toEqual([]);
    expect(useConsoleStore.getState().run?.status).toBe('running');
  });

  it('setOpen でドックを開閉できる', () => {
    useConsoleStore.getState().setOpen(true);
    expect(useConsoleStore.getState().open).toBe(true);
    useConsoleStore.getState().setOpen(false);
    expect(useConsoleStore.getState().open).toBe(false);
  });
});
