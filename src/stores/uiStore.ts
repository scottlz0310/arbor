import { create } from 'zustand';
import type { StatusFilter, Toast, ViewId } from '../types';

interface UiStore {
  activeView: ViewId;
  /** Status タブの絞り込み。Summary のカードからも切り替える。 */
  statusFilter: StatusFilter;
  toasts: Toast[];
  commandPaletteOpen: boolean;

  navigate: (view: ViewId) => void;
  setStatusFilter: (filter: StatusFilter) => void;
  addToast: (message: string, kind?: Toast['kind']) => void;
  dismissToast: (id: string) => void;
  openCommandPalette: () => void;
  closeCommandPalette: () => void;
}

let toastSeq = 0;

export const useUiStore = create<UiStore>((set) => ({
  activeView: 'status',
  statusFilter: 'all',
  toasts: [],
  commandPaletteOpen: false,

  navigate: (view) => set({ activeView: view }),

  setStatusFilter: (filter) => set({ statusFilter: filter }),

  addToast: (message, kind = 'info') => {
    const id = `toast-${++toastSeq}`;
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }));
    // Auto-dismiss after 4 s.
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 4000);
  },

  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  openCommandPalette: () => set({ commandPaletteOpen: true }),
  closeCommandPalette: () => set({ commandPaletteOpen: false }),
}));
