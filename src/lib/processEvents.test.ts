import { listen } from '@tauri-apps/api/event';
import { afterEach, describe, expect, it, type Mock } from 'bun:test';
import { useConsoleStore } from '../stores/consoleStore';
import type { ProcessFinished, ProcessOutput, ProcessStarted } from '../types';
import { createBatcher, subscribeProcessEvents } from './processEvents';

const started: ProcessStarted = { runId: 1, label: 'dsx doctor', argv: ['dsx', 'doctor'], startedAt: 0 };
const output = (text: string): ProcessOutput => ({ runId: 1, stream: 'stdout', text, overwrite: false });
const finished: ProcessFinished = { runId: 1, exitCode: 0, durationMs: 1000, cancelled: false };

/** 手動で進められるスケジューラ。 */
function manualScheduler() {
  const callbacks: Array<() => void> = [];
  return {
    schedule: (flush: () => void) => {
      callbacks.push(flush);
    },
    pending: () => callbacks.length,
    runFrame: () => callbacks.splice(0).forEach((cb) => cb()),
  };
}

const texts = () => useConsoleStore.getState().lines.map((l) => l.text);

describe('createBatcher', () => {
  it('フレームが来るまで反映せず、1 フレームで 1 回だけ反映する', () => {
    const scheduler = manualScheduler();
    const batcher = createBatcher(scheduler.schedule);
    let updates = 0;
    const unsubscribe = useConsoleStore.subscribe(() => updates++);

    batcher.push({ type: 'output', event: output('a') });
    batcher.push({ type: 'output', event: output('b') });
    batcher.push({ type: 'output', event: output('c') });

    expect(texts()).toEqual([]);
    expect(scheduler.pending()).toBe(1);

    scheduler.runFrame();
    unsubscribe();

    expect(texts()).toEqual(['a', 'b', 'c']);
    expect(updates).toBe(1);
  });

  it('開始・出力・終了の順序を保つ', () => {
    const scheduler = manualScheduler();
    const batcher = createBatcher(scheduler.schedule);

    batcher.push({ type: 'started', event: started });
    batcher.push({ type: 'output', event: output('line-1') });
    batcher.push({ type: 'output', event: output('line-2') });
    batcher.push({ type: 'finished', event: finished });
    scheduler.runFrame();

    expect(texts()).toEqual(['▶ dsx doctor', 'line-1', 'line-2', '✓ 完了 (1.0s)']);
    expect(useConsoleStore.getState().run?.status).toBe('succeeded');
  });

  it('反映後に届いたイベントは、次のフレームで反映する', () => {
    const scheduler = manualScheduler();
    const batcher = createBatcher(scheduler.schedule);

    batcher.push({ type: 'output', event: output('first') });
    scheduler.runFrame();
    batcher.push({ type: 'output', event: output('second') });

    expect(texts()).toEqual(['first']);
    expect(scheduler.pending()).toBe(1);
    scheduler.runFrame();
    expect(texts()).toEqual(['first', 'second']);
  });

  it('discard すると、溜まっているイベントは反映されない', () => {
    const scheduler = manualScheduler();
    const batcher = createBatcher(scheduler.schedule);

    batcher.push({ type: 'output', event: output('dropped') });
    batcher.discard();
    scheduler.runFrame();

    expect(texts()).toEqual([]);
  });
});

describe('subscribeProcessEvents', () => {
  const mockedListen = listen as Mock<typeof listen>;

  // preload のグローバルモックの実装を差し替えるため、他のテストへ漏れないよう既定に戻す
  afterEach(() => {
    mockedListen.mockImplementation((() => Promise.resolve(() => {})) as unknown as typeof listen);
  });

  type Handler = (event: { payload: unknown }) => void;
  function captureHandlers() {
    const handlers = new Map<string, Handler>();
    const unlisten = Object.assign(() => {}, { calls: 0 });
    const unlistenFn = () => {
      unlisten.calls++;
    };
    mockedListen.mockImplementation(((name: string, handler: Handler) => {
      handlers.set(name, handler);
      return Promise.resolve(unlistenFn);
    }) as unknown as typeof listen);
    return { handlers, unlisten };
  }

  it('3 種類のイベントを購読し、受信内容を consoleStore へ反映する', async () => {
    const { handlers } = captureHandlers();
    const scheduler = manualScheduler();

    await subscribeProcessEvents(scheduler.schedule);

    expect([...handlers.keys()].sort()).toEqual(['process_finished', 'process_output', 'process_started']);
    handlers.get('process_started')?.({ payload: started });
    handlers.get('process_output')?.({ payload: output('hello') });
    handlers.get('process_finished')?.({ payload: finished });
    scheduler.runFrame();

    expect(texts()).toEqual(['▶ dsx doctor', 'hello', '✓ 完了 (1.0s)']);
  });

  it('解除すると全ての購読を外し、溜まっているイベントを破棄する', async () => {
    const { handlers, unlisten } = captureHandlers();
    const scheduler = manualScheduler();

    const unsubscribe = await subscribeProcessEvents(scheduler.schedule);
    handlers.get('process_output')?.({ payload: output('late') });
    unsubscribe();
    scheduler.runFrame();

    expect(unlisten.calls).toBe(3);
    expect(texts()).toEqual([]);
  });
});
