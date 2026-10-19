import { afterAll, beforeEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';
import { act } from 'react';
import {
  checkAllRemotes,
  countRemote,
  describeRemoteCheck,
  remoteBadge,
  remoteNote,
} from './remoteStatus';
import * as invoke from './invoke';
import { useRemoteStore } from '../stores/remoteStore';
import { useUiStore } from '../stores/uiStore';
import type { RemoteCheckSummary, RemoteState, RemoteStatus } from '../types';

const mockCheckRemotes = spyOn(invoke, 'checkRemotes');
const mockAddToast = mock();

// module export への spy をファイル外へ漏らさない
afterAll(() => {
  mock.restore();
});

function status(name: string, state: RemoteState, moved_to: string | null = null): RemoteStatus {
  return { path: `/src/${name}`, name, state, moved_to };
}

function summary(statuses: RemoteStatus[], overrides: Partial<RemoteCheckSummary> = {}): RemoteCheckSummary {
  return { total: statuses.length, statuses, cancelled: false, ...overrides };
}

const active: RemoteState = { kind: 'active' };

beforeEach(() => {
  jest.clearAllMocks();
  act(() => {
    useUiStore.setState({ addToast: mockAddToast });
  });
});

describe('remoteBadge', () => {
  it.each([
    { name: '未確認', input: undefined, label: null },
    { name: '通常', input: status('a', active), label: null },
    { name: 'GitHub 以外', input: status('a', { kind: 'unsupported' }), label: null },
    { name: 'アーカイブ済み', input: status('a', { kind: 'archived' }), label: '▣ archived' },
    { name: 'remote が見つからない', input: status('a', { kind: 'not_found' }), label: '✗ remote なし' },
    { name: '確認に失敗', input: status('a', { kind: 'error', message: 'boom' }), label: '! 確認失敗' },
    { name: '移転済み', input: status('a', active, 'me/a'), label: '→ 移転' },
    { name: 'アーカイブ済みで移転済み', input: status('a', { kind: 'archived' }, 'me/a'), label: '▣ archived' },
  ])('$name', ({ input, label }) => {
    expect(remoteBadge(input)?.label ?? null).toBe(label);
  });

  it('ヒントに、移転後の名前・失敗の理由を載せる', () => {
    expect(remoteBadge(status('a', active, 'me/a'))?.title).toContain('me/a');
    expect(remoteBadge(status('a', { kind: 'archived' }, 'me/a'))?.title).toContain('me/a');
    expect(remoteBadge(status('a', { kind: 'archived' }))?.title).not.toContain('現在の名前');
    expect(remoteBadge(status('a', { kind: 'error', message: 'rate limit' }))?.title).toBe('rate limit');
  });
});

describe('countRemote と remoteNote', () => {
  const statuses = Object.fromEntries(
    [
      status('a', { kind: 'archived' }, 'me/a'),
      status('b', { kind: 'archived' }),
      status('c', { kind: 'not_found' }),
      status('d', active, 'me/d'),
      status('e', { kind: 'error', message: 'x' }),
      status('f', active),
    ].map((s) => [s.path, s]),
  );

  it('状態ごとに数える（移転は、アーカイブ・通常のどちらでも数える）', () => {
    expect(countRemote(statuses)).toEqual({ archived: 2, notFound: 1, moved: 2, errors: 1 });
  });

  it.each([
    { name: '全部', counts: { archived: 2, notFound: 1, moved: 2, errors: 1 }, note: '2 Archived · 1 remote なし · 2 移転' },
    { name: 'アーカイブだけ', counts: { archived: 1, notFound: 0, moved: 0, errors: 0 }, note: '1 Archived' },
    { name: '確認の失敗だけなら、注意は出さない', counts: { archived: 0, notFound: 0, moved: 0, errors: 3 }, note: null },
    { name: '未確認', counts: { archived: 0, notFound: 0, moved: 0, errors: 0 }, note: null },
  ])('remoteNote: $name', ({ counts, note }) => {
    expect(remoteNote(counts)).toBe(note);
  });
});

describe('describeRemoteCheck', () => {
  it.each([
    {
      name: 'すべて問題なし',
      input: summary([status('a', active), status('b', active)]),
      kind: 'success',
      message: 'Remote の確認: 2 件すべて問題ありません',
    },
    {
      name: 'アーカイブ済みがある',
      input: summary([status('a', { kind: 'archived' }), status('b', active)]),
      kind: 'info',
      message: 'Remote の確認: 1 Archived',
    },
    {
      name: '確認に失敗した件がある',
      input: summary([status('a', { kind: 'error', message: 'x' }), status('b', { kind: 'archived' })]),
      kind: 'error',
      message: 'Remote の確認: 1 件を確認できませんでした（1 Archived）。詳細はコンソール',
    },
    {
      name: '失敗だけ',
      input: summary([status('a', { kind: 'error', message: 'x' })]),
      kind: 'error',
      message: 'Remote の確認: 1 件を確認できませんでした。詳細はコンソール',
    },
    {
      name: '中断',
      input: summary([status('a', active)], { total: 5, cancelled: true }),
      kind: 'info',
      message: 'Remote の確認を中断しました（1/5 件を確認済み）',
    },
  ])('$name', ({ input, kind, message }) => {
    expect(describeRemoteCheck(input)).toEqual({ kind, message });
  });
});

describe('checkAllRemotes', () => {
  it('結果を store に保存し、Toast で知らせる', async () => {
    const result = summary([status('a', { kind: 'archived' })]);
    mockCheckRemotes.mockResolvedValue(result);

    await checkAllRemotes();

    expect(useRemoteStore.getState().statuses['/src/a']?.state).toEqual({ kind: 'archived' });
    expect(mockAddToast).toHaveBeenCalledWith('Remote の確認: 1 Archived', 'info');
  });

  it('実行できなかったとき（別の run が実行中など）は、結果を変えず、エラーを Toast に出す', async () => {
    const previous = status('a', { kind: 'archived' });
    act(() => useRemoteStore.getState().setResult(summary([previous])));
    mockCheckRemotes.mockRejectedValue('別のコマンドが実行中です');

    await checkAllRemotes();

    expect(useRemoteStore.getState().statuses['/src/a']).toEqual(previous);
    expect(mockAddToast).toHaveBeenCalledWith('別のコマンドが実行中です', 'error');
  });
});
