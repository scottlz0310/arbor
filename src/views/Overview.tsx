import { useMemo } from 'react';
import { useRepoStore } from '../stores/repoStore';
import { useUiStore } from '../stores/uiStore';
import AppBar, { AppBtn } from '../components/AppBar';
import { fetchAll, repoUpdate } from '../lib/invoke';
import { generateInsights } from '../lib/ruleEngine';
import type { Insight, RepoInfo } from '../types';

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
  const { addToast } = useUiStore();

  const insights = useMemo(() => generateInsights(repos), [repos]);

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
    try {
      await repoUpdate(repo.path);
      await refreshRepo(repo.path);
      addToast('Update complete', 'success');
    } catch (e) {
      addToast(String(e), 'error');
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

      <div style={{ flex: 1, padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
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

        {/* Recommended Actions パネル */}
        {insights.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', letterSpacing: '.1em', marginBottom: 8 }}>
              RECOMMENDED ACTIONS
            </div>
            {insights.slice(0, 5).map((ins, i) => <InsightCard key={i} insight={ins} />)}
          </div>
        )}

      </div>
    </div>
  );
}

const INSIGHT_STYLE: Record<Insight['type'], { bg: string; border: string; icon: string; color: string }> = {
  risk:       { bg: 'var(--red-bg)',    border: '#f8717128', icon: '⚠', color: 'var(--red)' },
  prioritize: { bg: 'var(--amber-bg)', border: '#fbbf2428', icon: '↑', color: 'var(--amber)' },
};

const PRIORITY_COLOR: Record<Insight['priority'], string> = {
  high:   'var(--red)',
  medium: 'var(--amber)',
  low:    'var(--text3)',
};

function InsightCard({ insight }: { insight: Insight }) {
  const s = INSIGHT_STYLE[insight.type];
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10,
      padding: '8px 10px', background: s.bg,
      border: `1px solid ${s.border}`, borderRadius: 'var(--r)',
      marginBottom: 4,
    }}>
      <span style={{ color: s.color, fontSize: 12, lineHeight: 1.5, flexShrink: 0 }}>{s.icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text1)', marginBottom: 2 }}>
          {insight.target}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text2)', lineHeight: 1.5 }}>
          {insight.reason}
        </div>
      </div>
      <span style={{
        fontSize: 9, padding: '2px 6px', borderRadius: 4, flexShrink: 0,
        background: `${PRIORITY_COLOR[insight.priority]}18`,
        color: PRIORITY_COLOR[insight.priority],
        fontWeight: 600,
      }}>
        {insight.priority}
      </span>
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
