import { create } from 'zustand';
import type { ProcessFinished, ProcessOutput, ProcessStarted } from '../types';

/** 画面に保持する行数の上限。超えた分は古い行から捨てる。 */
export const MAX_LINES = 10_000;

export type LineKind = 'stdout' | 'stderr' | 'system';

export interface ConsoleLine {
  /** React の key 用。進捗行の上書きでは変わらない。 */
  id: number;
  runId: number;
  kind: LineKind;
  text: string;
}

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface ConsoleRun {
  runId: number;
  label: string;
  startedAt: number;
  status: RunStatus;
  exitCode: number | null;
  durationMs: number | null;
}

interface ConsoleStore {
  lines: ConsoleLine[];
  /** 実行中、または直近に終了した run。 */
  run: ConsoleRun | null;
  open: boolean;

  handleStarted: (event: ProcessStarted) => void;
  /** 複数のイベントをまとめて反映する（描画回数を減らすため）。 */
  appendOutputs: (events: ProcessOutput[]) => void;
  handleFinished: (event: ProcessFinished) => void;
  clear: () => void;
  setOpen: (open: boolean) => void;
}

let nextLineId = 1;

function makeLine(runId: number, kind: LineKind, text: string): ConsoleLine {
  return { id: nextLineId++, runId, kind, text };
}

function trim(lines: ConsoleLine[]): ConsoleLine[] {
  return lines.length > MAX_LINES ? lines.slice(lines.length - MAX_LINES) : lines;
}

function findLastIndex(lines: ConsoleLine[], predicate: (line: ConsoleLine) => boolean): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (predicate(lines[i])) return i;
  }
  return -1;
}

function formatSeconds(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function finishedMessage(event: ProcessFinished): string {
  const elapsed = formatSeconds(event.durationMs);
  if (event.cancelled) return `■ キャンセルしました (${elapsed})`;
  if (event.exitCode === 0) return `✓ 完了 (${elapsed})`;
  return `✗ 失敗 (exit ${event.exitCode ?? '不明'}, ${elapsed})`;
}

function finishedStatus(event: ProcessFinished): RunStatus {
  if (event.cancelled) return 'cancelled';
  return event.exitCode === 0 ? 'succeeded' : 'failed';
}

export const useConsoleStore = create<ConsoleStore>((set) => ({
  lines: [],
  run: null,
  open: false,

  handleStarted: (event) =>
    set((s) => ({
      // 実行が始まったら、ログが見えるようにドックを開く。
      open: true,
      run: {
        runId: event.runId,
        label: event.label,
        startedAt: event.startedAt,
        status: 'running',
        exitCode: null,
        durationMs: null,
      },
      lines: trim([...s.lines, makeLine(event.runId, 'system', `▶ ${event.label}`)]),
    })),

  appendOutputs: (events) => {
    if (events.length === 0) return;
    set((s) => {
      const lines = [...s.lines];
      for (const event of events) {
        if (event.overwrite) {
          // 進捗行の置き換え。同じ run・同じ stream の直近の行が対象（他の stream の行が間に入ってもよい）。
          const index = findLastIndex(lines, (l) => l.runId === event.runId && l.kind === event.stream);
          if (index >= 0) {
            lines[index] = { ...lines[index], text: event.text };
            continue;
          }
        }
        lines.push(makeLine(event.runId, event.stream, event.text));
      }
      return { lines: trim(lines) };
    });
  },

  handleFinished: (event) =>
    set((s) => ({
      run:
        s.run?.runId === event.runId
          ? { ...s.run, status: finishedStatus(event), exitCode: event.exitCode, durationMs: event.durationMs }
          : s.run,
      lines: trim([...s.lines, makeLine(event.runId, 'system', finishedMessage(event))]),
    })),

  clear: () => set({ lines: [] }),

  setOpen: (open) => set({ open }),
}));
