import { create } from 'zustand';
import { updaterCheck, updaterInstall } from '../lib/invoke';
import type { UpdateCheck } from '../types';

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'done'; result: UpdateCheck }
  | { state: 'installing'; version: string }
  | { state: 'error'; message: string };

interface UpdateStore {
  status: UpdateStatus;

  /** 更新を確認する。確認中・適用中は何もしない。失敗は `error` の状態になる（例外は投げない）。 */
  check: () => Promise<void>;
  /** 利用できる更新を適用する。成功するとアプリは再起動するので、戻ってくるのは失敗したときだけ。 */
  install: () => Promise<void>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  status: { state: 'idle' },

  check: async () => {
    const { state } = get().status;
    if (state === 'checking' || state === 'installing') return;

    set({ status: { state: 'checking' } });
    try {
      set({ status: { state: 'done', result: await updaterCheck() } });
    } catch (e) {
      set({ status: { state: 'error', message: message(e) } });
    }
  },

  install: async () => {
    const { status } = get();
    if (status.state !== 'done' || status.result.kind !== 'available') return;

    set({ status: { state: 'installing', version: status.result.version } });
    try {
      await updaterInstall();
    } catch (e) {
      set({ status: { state: 'error', message: message(e) } });
    }
  },
}));
