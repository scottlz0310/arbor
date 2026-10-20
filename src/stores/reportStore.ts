import { create } from 'zustand';
import type { RunReport } from '../types';

interface ReportStore {
  /** 直近の更新系の実行（Daily Refresh / sys update / Update All）の報告。dsx がイベント出力に対応しない実行では更新しない。 */
  report: RunReport | null;
  /** 報告を受け取った時刻（Unix ミリ秒）。 */
  receivedAt: number | null;

  setReport: (report: RunReport) => void;
}

export const useReportStore = create<ReportStore>((set) => ({
  report: null,
  receivedAt: null,

  setReport: (report) => set({ report, receivedAt: Date.now() }),
}));
