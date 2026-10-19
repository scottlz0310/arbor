import { describe, expect, it } from 'bun:test';
import { useRemoteStore } from './remoteStore';
import type { RemoteCheckSummary, RemoteStatus } from '../types';

function status(name: string, kind: 'active' | 'archived' = 'active'): RemoteStatus {
  return { path: `/src/${name}`, name, state: { kind }, moved_to: null };
}

function summary(statuses: RemoteStatus[], cancelled = false): RemoteCheckSummary {
  return { total: statuses.length, statuses, cancelled };
}

describe('remoteStore.setResult', () => {
  it('完了した確認は、前の結果を置き換える（もう管理対象でないリポジトリは残らない）', () => {
    useRemoteStore.getState().setResult(summary([status('a'), status('gone', 'archived')]), 1_000);

    useRemoteStore.getState().setResult(summary([status('a', 'archived')]), 2_000);

    const { statuses, checkedAt } = useRemoteStore.getState();
    expect(Object.keys(statuses)).toEqual(['/src/a']);
    expect(statuses['/src/a']?.state.kind).toBe('archived');
    expect(checkedAt).toBe(2_000);
  });

  it('中断された確認は、確認できた分だけを、前の結果へ重ねる', () => {
    useRemoteStore.getState().setResult(summary([status('a'), status('b', 'archived')]), 1_000);

    useRemoteStore.getState().setResult(summary([status('a', 'archived')], true), 2_000);

    const { statuses } = useRemoteStore.getState();
    expect(statuses['/src/a']?.state.kind).toBe('archived');
    expect(statuses['/src/b']?.state.kind).toBe('archived');
  });

  it('確認の時刻を、渡さなければ現在時刻にする', () => {
    const before = Date.now();

    useRemoteStore.getState().setResult(summary([status('a')]));

    expect(useRemoteStore.getState().checkedAt).toBeGreaterThanOrEqual(before);
  });
});
