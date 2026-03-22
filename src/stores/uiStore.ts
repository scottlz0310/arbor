import { create } from 'zustand';
import type { Toast, ViewId } from '../types';

interface UiStore {
  activeView: ViewId;
  toasts: Toast[];
  dsxProgress: string[];
  dsxRunning: boolean;

  navigate: (view: ViewId) => void;
  addToast: (message: string, kind?: Toast['kind']) => void;
  dismissToast: (id: string) => void;
  appendDsxLine: (line: string) => void;
  clearDsxProgress: () => void;
  setDsxRunning: (v: boolean) => void;
}

let toastSeq = 0;

export const useUiStore = create<UiStore>((set) => ({
  activeView: 'overview',
  toasts: [],
  dsxProgress: [],
  dsxRunning: false,

  navigate: (view) => set({ activeView: view }),

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

  appendDsxLine: (line) =>
    set((s) => ({ dsxProgress: [...s.dsxProgress.slice(-99), line] })),

  clearDsxProgress: () => set({ dsxProgress: [] }),

  setDsxRunning: (v) => set({ dsxRunning: v }),
}));
