import { create } from 'zustand';

interface CleanupStore {
  /**
   * 直近の Cleanup プレビューで、実行できる候補（ブロックされていないもの）の数。
   * プレビューは全リポジトリの remote へ接続して遅いため、自動では読み込まない。未読み込み・古くなったときは null。
   */
  candidateCount: number | null;

  setCandidateCount: (count: number | null) => void;
  /** run の終了などでリポジトリの状態が変わったとき、古くなった件数を捨てる。 */
  invalidate: () => void;
}

export const useCleanupStore = create<CleanupStore>((set) => ({
  candidateCount: null,
  setCandidateCount: (count) => set({ candidateCount: count }),
  invalidate: () => set({ candidateCount: null }),
}));
