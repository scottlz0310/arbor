import { useRepoStore } from '../stores/repoStore';
import { useUiStore } from '../stores/uiStore';
import { fetchRepositories } from './invoke';
import type { FetchSummary, Toast } from '../types';

/** fetch の結果を、Toast に出す 1 行にまとめる。失敗の詳細はコンソールに出ている。 */
export function describeFetch(summary: FetchSummary): { message: string; kind: Toast['kind'] } {
  const failed = summary.failed.length;
  if (summary.cancelled) {
    return { message: `Fetch を中断しました（成功 ${summary.succeeded} 件 / 失敗 ${failed} 件）`, kind: 'info' };
  }
  if (failed > 0) {
    return { message: `Fetch 完了: 成功 ${summary.succeeded} 件 / 失敗 ${failed} 件（詳細はコンソール）`, kind: 'error' };
  }
  return { message: `Fetch 完了: ${summary.succeeded} 件`, kind: 'success' };
}

/** 全リポジトリを fetch し、一覧を読み直して結果を Toast で知らせる。 */
export async function fetchAllRepositories(): Promise<void> {
  const { addToast } = useUiStore.getState();
  try {
    const summary = await fetchRepositories();
    await useRepoStore.getState().loadRepos();
    const { message, kind } = describeFetch(summary);
    addToast(message, kind);
  } catch (e) {
    addToast(String(e), 'error');
  }
}
