/**
 * Rust の runner（commands/runner.rs）が送る `process_*` イベントを購読し、consoleStore へ反映する。
 *
 * 出力は 1 行ずつ届くので、そのまま反映すると 1 行ごとに再描画が走る。
 * 受信したイベントを溜め、描画フレームごとに 1 回だけ反映する（順序は保つ）。
 */
import { listen } from '@tauri-apps/api/event';
import { useConsoleStore } from '../stores/consoleStore';
import type { ProcessFinished, ProcessOutput, ProcessStarted } from '../types';

type Pending =
  | { type: 'started'; event: ProcessStarted }
  | { type: 'output'; event: ProcessOutput }
  | { type: 'finished'; event: ProcessFinished };

export type Scheduler = (flush: () => void) => void;

/** 次の描画フレームで実行する。ウィンドウが隠れて描画が止まっても、一定時間後には必ず実行する。 */
const frameScheduler: Scheduler = (flush) => {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    flush();
  };
  const timer = setTimeout(run, 100);
  requestAnimationFrame(run);
};

export function createBatcher(schedule: Scheduler = frameScheduler) {
  let queue: Pending[] = [];
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    const pending = queue;
    queue = [];

    const store = useConsoleStore.getState();
    let outputs: ProcessOutput[] = [];
    const flushOutputs = () => {
      store.appendOutputs(outputs);
      outputs = [];
    };
    for (const item of pending) {
      if (item.type === 'output') {
        outputs.push(item.event);
        continue;
      }
      // 開始・終了の前後で出力の順序が入れ替わらないように、溜めた出力を先に反映する。
      flushOutputs();
      if (item.type === 'started') store.handleStarted(item.event);
      else store.handleFinished(item.event);
    }
    flushOutputs();
  };

  return {
    push(item: Pending) {
      queue.push(item);
      if (!scheduled) {
        scheduled = true;
        schedule(flush);
      }
    },
    /** 溜まっているイベントを破棄する（購読の解除時）。 */
    discard() {
      queue = [];
    },
  };
}

/** `process_*` の購読を開始する。戻り値は購読を解除する関数。 */
export async function subscribeProcessEvents(schedule?: Scheduler): Promise<() => void> {
  const batcher = createBatcher(schedule);
  const unlisteners = await Promise.all([
    listen<ProcessStarted>('process_started', (e) => batcher.push({ type: 'started', event: e.payload })),
    listen<ProcessOutput>('process_output', (e) => batcher.push({ type: 'output', event: e.payload })),
    listen<ProcessFinished>('process_finished', (e) => batcher.push({ type: 'finished', event: e.payload })),
  ]);

  return () => {
    unlisteners.forEach((unlisten) => unlisten());
    batcher.discard();
  };
}
