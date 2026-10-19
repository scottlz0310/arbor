import { create } from 'zustand';
import type { RemoteCheckSummary, RemoteStatus } from '../types';

interface RemoteStore {
  /**
   * 直近の確認の結果（リポジトリのパスごと）。確認は GitHub への問い合わせで遅いため、自動では行わない。
   * アプリを閉じると失われる。
   */
  statuses: Record<string, RemoteStatus>;
  /** 最後に確認が終わった時刻（Unix ミリ秒）。未確認は null。 */
  checkedAt: number | null;

  /** 確認の結果を取り込む。中断された確認は、確認できた分だけを、前の結果へ重ねる。 */
  setResult: (summary: RemoteCheckSummary, now?: number) => void;
}

export const useRemoteStore = create<RemoteStore>((set) => ({
  statuses: {},
  checkedAt: null,

  setResult: (summary, now = Date.now()) =>
    set((state) => {
      const checked = Object.fromEntries(summary.statuses.map((status) => [status.path, status]));
      return {
        statuses: summary.cancelled ? { ...state.statuses, ...checked } : checked,
        checkedAt: now,
      };
    }),
}));
