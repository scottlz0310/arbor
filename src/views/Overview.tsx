import { useRepoStore } from '../stores/repoStore';
import { useUiStore } from '../stores/uiStore';
import AppBar, { AppBtn } from '../components/AppBar';
import { fetchAll, repoUpdate } from '../lib/invoke';
import type { RepoInfo } from '../types';

function statusBadge(repo: RepoInfo) {
  if (repo.ahead > 0 && repo.behind > 0)
    return { label: '⇕ diverged', bg: 'var(--red-bg)',    color: 'var(--red)' };
  if (repo.ahead > 0)
    return { label: '↑ ahead',    bg: 'var(--green-bg)',   color: 'var(--green)' };
  if (repo.behind > 0)
    return { label: '↓ behind',   bg: 'var(--purple-bg)',  color: 'var(--purple)' };
  return   { label: '✓ clean',    bg: '#1e2336',           color: 'var(--text3)' };
}

export default function Overview() {
  const { repos, selectedRepo, selectRepo, refreshRepo } = useRepoStore();
  const { addToast, setDsxRunning } = useUiStore();

  const repo = selectedRepo;

  const handleFetch = async () => {
    if (!repo) return;
    try {
      await fetchAll(repo.path);
      await refreshRepo(repo.path);
      addToast('Fetch complete', 'success');
    } catch (e) {
      addToast(String(e), 'error');
    }
  };

  const handleUpdate = async () => {
    if (!repo) return;
    setDsxRunning(true);
    try {
      await repoUpdate(repo.path);
      await refreshRepo(repo.path);
      addToast('Update complete', 'success');
    } catch (e) {
      addToast(String(e), 'error');
    } finally {
      setDsxRunning(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <AppBar
        path={
          repo
            ? <><span style={{ color: 'var(--text2)' }}>{repo.name}</span> · {repo.current_branch}</>
            : 'No repository selected'
        }
        actions={repo && (
          <>
            <AppBtn onClick={handleFetch}>↓ Fetch</AppBtn>
            <AppBtn variant="primary" onClick={handleUpdate}>⟳ Update</AppBtn>
          </>
        )}
      />

      <div style={{ flex: 1, padding: 16, overflowY: 'auto' }}>
        {/* Stat cards for selected repo */}
        {repo && (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 8,
            marginBottom: 16,
          }}>
            <StatCard value={repo.ahead}        label="AHEAD"     color="var(--green)" />
            <StatCard value={repo.behind}       label="BEHIND"    color={repo.behind > 0 ? 'var(--purple)' : 'var(--text3)'} />
            <StatCard value={repo.modified_count + repo.untracked_count} label="MODIFIED" color="var(--amber)" />
            <StatCard value={repo.stash_count}  label="STASHES"   color="var(--indigo-l)" />
          </div>
        )}

        {/* All repos grid */}
        <div style={{
          fontSize: 10,
          fontWeight: 600,
          color: 'var(--text3)',
          letterSpacing: '.1em',
          marginBottom: 8,
        }}>
          ALL REPOSITORIES
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 8,
        }}>
          {repos.map((r) => {
            const badge = statusBadge(r);
            return (
              <button
                key={r.path}
                onClick={() => selectRepo(r)}
                style={{
                  background: selectedRepo?.path === r.path ? 'var(--indigo-bg)' : 'var(--bg3)',
                  border: `1px solid ${selectedRepo?.path === r.path ? '#818cf850' : 'var(--border)'}`,
                  borderRadius: 'var(--r2)',
                  padding: '12px 14px',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 6 }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--indigo-l)' }}>{r.name}</div>
                    <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>{r.current_branch}</div>
                  </div>
                  <span style={{
                    fontSize: 10,
                    fontWeight: 500,
                    padding: '2px 8px',
                    borderRadius: 4,
                    background: badge.bg,
                    color: badge.color,
                  }}>
                    {badge.label}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 10, fontSize: 10, marginTop: 8 }}>
                  <span style={{ color: 'var(--green)' }}>↑ {r.ahead}</span>
                  <span style={{ color: 'var(--purple)' }}>↓ {r.behind}</span>
                  {(r.modified_count + r.untracked_count) > 0 && (
                    <span style={{ color: 'var(--amber)' }}>~ {r.modified_count + r.untracked_count}</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function StatCard({ value, label, color }: { value: number; label: string; color: string }) {
  return (
    <div style={{
      background: 'var(--bg3)',
      borderRadius: 'var(--r)',
      padding: '12px 14px',
    }}>
      <div style={{ fontSize: 24, fontWeight: 600, fontFamily: 'var(--font-display)', color, lineHeight: 1, marginBottom: 4 }}>
        {value}
      </div>
      <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text3)', letterSpacing: '.1em' }}>
        {label}
      </div>
    </div>
  );
}
