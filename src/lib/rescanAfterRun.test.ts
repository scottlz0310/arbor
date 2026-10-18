import { afterAll, afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { act } from 'react';
import { rescan, subscribeRescanAfterRun } from './rescanAfterRun';
import { useCleanupStore } from '../stores/cleanupStore';
import { useConsoleStore } from '../stores/consoleStore';
import { useEnvStore } from '../stores/envStore';
import { useRepoStore } from '../stores/repoStore';
import type { ProcessFinished, ProcessStarted } from '../types';

const mockLoadRepos = mock();
const mockRefresh = mock();

afterAll(() => {
  mock.restore();
});

function started(runId: number): ProcessStarted {
  return { runId, label: 'dsx run', argv: [], startedAt: 0 };
}

function finished(runId: number, overrides: Partial<ProcessFinished> = {}): ProcessFinished {
  return { runId, exitCode: 0, durationMs: 10, cancelled: false, ...overrides };
}

let unsubscribe: () => void;

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadRepos.mockResolvedValue(undefined);
  mockRefresh.mockResolvedValue(undefined);
  act(() => {
    useRepoStore.setState({ loadRepos: mockLoadRepos });
    useEnvStore.setState({ refresh: mockRefresh });
  });
  unsubscribe = subscribeRescanAfterRun();
});

afterEach(() => {
  unsubscribe();
});

describe('rescan', () => {
  it('一覧と環境の状態の両方を読み直す', async () => {
    await rescan();

    expect(mockLoadRepos).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});

describe('subscribeRescanAfterRun', () => {
  it('run が始まっただけでは再スキャンしない', () => {
    act(() => useConsoleStore.getState().handleStarted(started(1)));

    expect(mockLoadRepos).not.toHaveBeenCalled();
  });

  it.each([
    { name: '成功', event: finished(1) },
    { name: '失敗', event: finished(1, { exitCode: 2 }) },
    // 中断までに進んだ更新も、状態には表れる
    { name: '中断', event: finished(1, { exitCode: null, cancelled: true }) },
  ])('run が $name で終わったら再スキャンする', async ({ event }) => {
    act(() => useConsoleStore.getState().handleStarted(started(1)));

    act(() => useConsoleStore.getState().handleFinished(event));

    expect(mockLoadRepos).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('別の run の終了通知では再スキャンしない', () => {
    act(() => useConsoleStore.getState().handleStarted(started(2)));

    act(() => useConsoleStore.getState().handleFinished(finished(1)));

    expect(mockLoadRepos).not.toHaveBeenCalled();
  });

  it('終了済みの run の表示が変わっても、再スキャンを繰り返さない', () => {
    act(() => useConsoleStore.getState().handleStarted(started(1)));
    act(() => useConsoleStore.getState().handleFinished(finished(1)));
    mockLoadRepos.mockClear();

    act(() => useConsoleStore.getState().appendOutputs([]));
    act(() => useConsoleStore.getState().setOpen(false));

    expect(mockLoadRepos).not.toHaveBeenCalled();
  });

  it('購読を解除すると再スキャンしない', () => {
    act(() => useConsoleStore.getState().handleStarted(started(1)));
    unsubscribe();

    act(() => useConsoleStore.getState().handleFinished(finished(1)));

    expect(mockLoadRepos).not.toHaveBeenCalled();
  });
});

describe('rescan と Cleanup 候補数', () => {
  it('読み込み済みの Cleanup 候補数は、状態が変わるので捨てる', async () => {
    act(() => useCleanupStore.setState({ candidateCount: 4 }));

    await rescan();

    expect(useCleanupStore.getState().candidateCount).toBeNull();
  });
});
