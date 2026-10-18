import { create } from 'zustand';
import { bitwardenStatus, dsxCheck, getWorkspaceStatus } from '../lib/invoke';
import type { BitwardenState, DsxStatus, WorkspaceStatus } from '../types';

const DSX_UNAVAILABLE: DsxStatus = {
  available: false,
  version: null,
  path: null,
  supports_run_root: false,
};

interface EnvStore {
  /** null は未確認。 */
  dsx: DsxStatus | null;
  bitwarden: BitwardenState | null;
  workspace: WorkspaceStatus | null;

  /** dsx・Bitwarden・workspace の状態を確認し直す。 */
  refresh: () => Promise<void>;
}

export const useEnvStore = create<EnvStore>((set) => ({
  dsx: null,
  bitwarden: null,
  workspace: null,

  refresh: async () => {
    // 3 つは独立しているので並行して確認し、失敗したものだけ「確認できない」状態にする。
    const [dsx, bitwarden, workspace] = await Promise.allSettled([
      dsxCheck(),
      bitwardenStatus(),
      getWorkspaceStatus(),
    ]);
    set({
      dsx: dsx.status === 'fulfilled' ? dsx.value : DSX_UNAVAILABLE,
      bitwarden: bitwarden.status === 'fulfilled' ? bitwarden.value : 'unavailable',
      workspace: workspace.status === 'fulfilled' ? workspace.value : null,
    });
  },
}));
