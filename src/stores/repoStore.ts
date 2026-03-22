import { create } from 'zustand';
import { listRepositories, getRepoStatus } from '../lib/invoke';
import type { RepoInfo } from '../types';

interface RepoStore {
  repos: RepoInfo[];
  selectedRepo: RepoInfo | null;
  loading: boolean;
  error: string | null;

  loadRepos: () => Promise<void>;
  refreshRepo: (path: string) => Promise<void>;
  selectRepo: (repo: RepoInfo) => void;
}

export const useRepoStore = create<RepoStore>((set, get) => ({
  repos: [],
  selectedRepo: null,
  loading: false,
  error: null,

  loadRepos: async () => {
    set({ loading: true, error: null });
    try {
      const repos = await listRepositories();
      const selected = get().selectedRepo;
      set({
        repos,
        loading: false,
        // Keep selection if repo still exists, else pick first.
        selectedRepo:
          repos.find((r) => r.path === selected?.path) ?? repos[0] ?? null,
      });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  refreshRepo: async (path: string) => {
    try {
      const updated = await getRepoStatus(path);
      set((s) => ({
        repos: s.repos.map((r) => (r.path === path ? updated : r)),
        selectedRepo:
          s.selectedRepo?.path === path ? updated : s.selectedRepo,
      }));
    } catch (e) {
      console.error('refreshRepo failed:', e);
    }
  },

  selectRepo: (repo) => set({ selectedRepo: repo }),
}));
