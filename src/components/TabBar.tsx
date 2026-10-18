import { countRepos } from '../lib/repoStatus';
import { useCleanupStore } from '../stores/cleanupStore';
import { useRepoStore } from '../stores/repoStore';
import { useUiStore } from '../stores/uiStore';
import type { ViewId } from '../types';

const TABS: { id: Exclude<ViewId, 'settings'>; label: string }[] = [
  { id: 'status', label: 'Repository Status' },
  { id: 'cleanup', label: 'Branch Cleanup' },
  { id: 'tools', label: 'dsx Tools' },
];

export default function TabBar() {
  const { activeView, navigate } = useUiStore();
  const repos = useRepoStore((s) => s.repos);
  const candidateCount = useCleanupStore((s) => s.candidateCount);

  const attention = countRepos(repos).attention;
  const badges: Record<(typeof TABS)[number]['id'], { value: number | null; amber: boolean }> = {
    status: { value: attention, amber: attention > 0 },
    cleanup: { value: candidateCount, amber: (candidateCount ?? 0) > 0 },
    tools: { value: null, amber: false },
  };

  return (
    <div
      role="tablist"
      aria-label="ビュー"
      style={{
        display: 'flex',
        gap: 4,
        padding: '12px 16px 0',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}
    >
      {TABS.map((tab) => {
        const active = activeView === tab.id;
        const badge = badges[tab.id];
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={active}
            onClick={() => navigate(tab.id)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 14px',
              background: 'none',
              border: 'none',
              borderBottom: `2px solid ${active ? 'var(--indigo)' : 'transparent'}`,
              color: active ? 'var(--indigo-l)' : 'var(--text3)',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            {tab.label}
            {badge.value !== null && badge.value > 0 && (
              <span
                style={{
                  fontSize: 10,
                  fontFamily: 'var(--font-mono)',
                  padding: '0 6px',
                  borderRadius: 999,
                  background: badge.amber ? 'var(--amber-bg)' : 'var(--bg3)',
                  color: badge.amber ? 'var(--amber)' : 'var(--text3)',
                }}
              >
                {badge.value}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
