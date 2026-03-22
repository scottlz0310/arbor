import { useRepoStore } from '../stores/repoStore';
import { useUiStore } from '../stores/uiStore';
import type { RepoInfo, ViewId } from '../types';

const NAV_ITEMS: { id: ViewId; icon: string; label: string }[] = [
  { id: 'overview',  icon: '◈', label: 'Overview' },
  { id: 'branches',  icon: '⌥', label: 'Branches' },
  { id: 'graph',     icon: '⧖', label: 'Graph' },
  { id: 'prs',       icon: '⇄', label: 'PR / Issues' },
  { id: 'cleanup',   icon: '✦', label: 'Cleanup' },
  { id: 'settings',  icon: '⚙', label: 'Settings' },
];

function repoDot(repo: RepoInfo): string {
  if (repo.ahead > 0 && repo.behind > 0) return 'var(--red)';
  if (repo.modified_count > 0) return 'var(--amber)';
  return 'var(--green)';
}

export default function Sidebar() {
  const { repos, selectedRepo, selectRepo } = useRepoStore();
  const { activeView, navigate } = useUiStore();

  return (
    <aside style={{
      width: 'var(--sidebar-w)',
      background: '#0a0c12',
      borderRight: '1px solid var(--border)',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
      height: '100%',
    }}>
      {/* Logo */}
      <div style={{
        padding: '14px 16px 10px',
        borderBottom: '1px solid var(--border)',
      }}>
        <div style={{
          fontFamily: 'var(--font-display)',
          fontSize: 13,
          fontWeight: 700,
          color: 'var(--indigo)',
        }}>arbor</div>
        <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>
          {repos.length} repositories
        </div>
      </div>

      {/* Repository list */}
      <div style={{ padding: '8px', borderBottom: '1px solid var(--border)' }}>
        {repos.map((repo) => (
          <button
            key={repo.path}
            onClick={() => selectRepo(repo)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 8px',
              borderRadius: 'var(--r)',
              width: '100%',
              background: selectedRepo?.path === repo.path ? 'var(--bg3)' : 'none',
              border: 'none',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <span style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              flexShrink: 0,
              background: repoDot(repo),
            }} />
            <span style={{
              fontSize: 11,
              color: selectedRepo?.path === repo.path ? 'var(--indigo-l)' : 'var(--text2)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
            }}>
              {repo.name}
            </span>
            {repo.ahead > 0 && (
              <span style={{
                fontSize: 9,
                padding: '1px 5px',
                borderRadius: 3,
                background: 'var(--green-bg)',
                color: 'var(--green)',
              }}>↑{repo.ahead}</span>
            )}
            {repo.behind > 0 && !repo.ahead && (
              <span style={{
                fontSize: 9,
                padding: '1px 5px',
                borderRadius: 3,
                background: 'var(--purple-bg)',
                color: 'var(--purple)',
              }}>↓{repo.behind}</span>
            )}
          </button>
        ))}
      </div>

      {/* Navigation */}
      <nav style={{ padding: '8px', flex: 1 }}>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            onClick={() => navigate(item.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              padding: '6px 8px',
              borderRadius: 'var(--r)',
              width: '100%',
              background: activeView === item.id ? 'var(--bg3)' : 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: 11,
              color: activeView === item.id ? 'var(--indigo-l)' : 'var(--text3)',
              textAlign: 'left',
            }}
          >
            <span style={{ width: 14, textAlign: 'center', fontSize: 13 }}>
              {item.icon}
            </span>
            {item.label}
          </button>
        ))}
      </nav>
    </aside>
  );
}
