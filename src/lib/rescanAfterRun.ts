import { useConsoleStore } from '../stores/consoleStore';
import { useEnvStore } from '../stores/envStore';
import { useRepoStore } from '../stores/repoStore';

/** リポジトリ一覧と環境の状態（dsx の版・Bitwarden・root）を読み直す。 */
export async function rescan(): Promise<void> {
  await Promise.all([useRepoStore.getState().loadRepos(), useEnvStore.getState().refresh()]);
}

/**
 * 実行ログコンソールの run が終わったら、自動で再スキャンする。
 * 中断された run も、途中まで進んだ更新が状態に表れるので対象にする。
 */
export function subscribeRescanAfterRun(): () => void {
  return useConsoleStore.subscribe((state, previous) => {
    const before = previous.run;
    const now = state.run;
    if (before?.status === 'running' && now?.runId === before.runId && now.status !== 'running') {
      void rescan();
    }
  });
}
