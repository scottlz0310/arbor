import { afterAll, beforeEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';
import { act } from 'react';
import { describeFetch, fetchAllRepositories } from './fetchRepositories';
import * as invoke from './invoke';
import { useUiStore } from '../stores/uiStore';
import type { FetchSummary } from '../types';

const mockFetchRepositories = spyOn(invoke, 'fetchRepositories');
const mockAddToast = mock();

// module export への spy をファイル外へ漏らさない
afterAll(() => {
  mock.restore();
});

function summary(overrides: Partial<FetchSummary> = {}): FetchSummary {
  return { total: 3, succeeded: 3, failed: [], cancelled: false, ...overrides };
}

const failure = { path: '/r/x', name: 'x', error: 'fetch origin: boom' };

beforeEach(() => {
  jest.clearAllMocks();
  act(() => {
    useUiStore.setState({ addToast: mockAddToast });
  });
});

describe('describeFetch', () => {
  it.each([
    { name: '全件成功', input: summary(), kind: 'success', message: 'Fetch 完了: 3 件' },
    {
      name: '一部失敗',
      input: summary({ succeeded: 2, failed: [failure] }),
      kind: 'error',
      message: 'Fetch 完了: 成功 2 件 / 失敗 1 件（詳細はコンソール）',
    },
    {
      name: 'キャンセル',
      input: summary({ succeeded: 1, cancelled: true }),
      kind: 'info',
      message: 'Fetch を中断しました（成功 1 件 / 失敗 0 件）',
    },
    {
      // 中断と失敗が同時でも、中断を優先して伝える
      name: 'キャンセル済みで失敗も出ていた',
      input: summary({ succeeded: 1, failed: [failure], cancelled: true }),
      kind: 'info',
      message: 'Fetch を中断しました（成功 1 件 / 失敗 1 件）',
    },
  ])('$name', ({ input, kind, message }) => {
    expect(describeFetch(input)).toEqual({ kind, message });
  });
});

describe('fetchAllRepositories', () => {
  it('fetch の結果を Toast で知らせる（一覧の読み直しは run の終了時に行う）', async () => {
    mockFetchRepositories.mockResolvedValue(summary());

    await fetchAllRepositories();

    expect(mockFetchRepositories).toHaveBeenCalledTimes(1);
    expect(mockAddToast).toHaveBeenCalledWith('Fetch 完了: 3 件', 'success');
  });

  it('実行できなかったとき（別のコマンドが実行中など）はエラーを出す', async () => {
    mockFetchRepositories.mockRejectedValue('別のコマンドを実行中です（run 3）');

    await fetchAllRepositories();

    expect(mockAddToast).toHaveBeenCalledWith('別のコマンドを実行中です（run 3）', 'error');
  });
});
