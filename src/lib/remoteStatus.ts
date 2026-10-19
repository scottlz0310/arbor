import { useRemoteStore } from '../stores/remoteStore';
import { useUiStore } from '../stores/uiStore';
import { checkRemotes } from './invoke';
import type { RemoteCheckSummary, RemoteStatus, Toast } from '../types';

export interface RemoteBadge {
  label: string;
  bg: string;
  color: string;
  /** バッジに乗せるヒント。 */
  title: string;
}

/** 移転したときの、origin の URL の更新を促す文。 */
function movedHint(status: RemoteStatus): string {
  return status.moved_to === null
    ? ''
    : `GitHub 上の現在の名前は ${status.moved_to} です。origin の URL を更新してください。`;
}

/**
 * カードに出す、リモートの状態のバッジ。注意が要らない状態（確認前・通常・GitHub 以外）は null。
 * アーカイブ済み・見つからない・移転・確認に失敗のいずれか。
 */
export function remoteBadge(status: RemoteStatus | undefined): RemoteBadge | null {
  if (!status) return null;
  switch (status.state.kind) {
    case 'archived':
      return {
        label: '▣ archived',
        bg: 'var(--amber-bg)',
        color: 'var(--amber)',
        title: `アーカイブ済みで、更新されません。不要ならフォルダを削除してください。${movedHint(status)}`,
      };
    case 'not_found':
      return {
        label: '✗ remote なし',
        bg: 'var(--red-bg)',
        color: 'var(--red)',
        title: 'GitHub に見つかりません（削除されたか、権限がありません）。',
      };
    case 'error':
      return {
        label: '! 確認失敗',
        bg: '#1e2336',
        color: 'var(--text3)',
        title: status.state.message,
      };
    case 'active':
      return status.moved_to === null
        ? null
        : { label: '→ 移転', bg: 'var(--purple-bg)', color: 'var(--purple)', title: movedHint(status) };
    case 'unsupported':
      return null;
  }
}

export interface RemoteCounts {
  archived: number;
  notFound: number;
  moved: number;
  errors: number;
}

export function countRemote(statuses: Record<string, RemoteStatus>): RemoteCounts {
  const counts: RemoteCounts = { archived: 0, notFound: 0, moved: 0, errors: 0 };
  for (const status of Object.values(statuses)) {
    if (status.state.kind === 'archived') counts.archived += 1;
    if (status.state.kind === 'not_found') counts.notFound += 1;
    if (status.state.kind === 'error') counts.errors += 1;
    if (status.moved_to !== null) counts.moved += 1;
  }
  return counts;
}

/** Summary に添える、リモートの状態の 1 行。注意が要る状態が無ければ null（未確認も含む）。 */
export function remoteNote(counts: RemoteCounts): string | null {
  const parts = [
    counts.archived > 0 ? `${counts.archived} Archived` : null,
    counts.notFound > 0 ? `${counts.notFound} remote なし` : null,
    counts.moved > 0 ? `${counts.moved} 移転` : null,
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** 確認の結果を、Toast に出す 1 行にまとめる。詳細はコンソールに出ている。 */
export function describeRemoteCheck(summary: RemoteCheckSummary): { message: string; kind: Toast['kind'] } {
  const counts = countRemote(Object.fromEntries(summary.statuses.map((s) => [s.path, s])));
  if (summary.cancelled) {
    return { message: `Remote の確認を中断しました（${summary.statuses.length}/${summary.total} 件を確認済み）`, kind: 'info' };
  }
  const note = remoteNote(counts);
  if (counts.errors > 0) {
    return {
      message: `Remote の確認: ${counts.errors} 件を確認できませんでした${note ? `（${note}）` : ''}。詳細はコンソール`,
      kind: 'error',
    };
  }
  return note
    ? { message: `Remote の確認: ${note}`, kind: 'info' }
    : { message: `Remote の確認: ${summary.total} 件すべて問題ありません`, kind: 'success' };
}

/** 全リポジトリの、リモートの状態を確認し、結果を保存して Toast で知らせる。 */
export async function checkAllRemotes(): Promise<void> {
  const { addToast } = useUiStore.getState();
  try {
    const summary = await checkRemotes();
    useRemoteStore.getState().setResult(summary);
    const { message, kind } = describeRemoteCheck(summary);
    addToast(message, kind);
  } catch (e) {
    addToast(String(e), 'error');
  }
}
