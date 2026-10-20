import { create } from 'zustand';
import { dsxCheck, getWorkspaceStatus } from '../lib/invoke';
import type { DsxStatus, WorkspaceStatus } from '../types';

const DSX_UNAVAILABLE: DsxStatus = {
  available: false,
  version: null,
  path: null,
  supports_daily_refresh: false,
};

interface EnvStore {
  /** null は未確認。 */
  dsx: DsxStatus | null;
  workspace: WorkspaceStatus | null;

  /** dsx・workspace の状態を確認し直す。 */
  refresh: () => Promise<void>;
}

export const useEnvStore = create<EnvStore>((set) => ({
  dsx: null,
  workspace: null,

  refresh: async () => {
    // 2 つは独立しているので並行して確認し、失敗したものだけ「確認できない」状態にする。
    const [dsx, workspace] = await Promise.allSettled([dsxCheck(), getWorkspaceStatus()]);
    set({
      dsx: dsx.status === 'fulfilled' ? dsx.value : DSX_UNAVAILABLE,
      workspace: workspace.status === 'fulfilled' ? workspace.value : null,
    });
  },
}));
