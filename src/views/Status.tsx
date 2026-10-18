import { useMemo } from 'react';
import { AppBtn } from '../components/AppBar';
import { countRepos, filterRepos, statusBadge } from '../lib/repoStatus';
import { fetchAll, openRepoFolder } from '../lib/invoke';
import { generateInsights } from '../lib/ruleEngine';
import { useRepoStore } from '../stores/repoStore';
import { useUiStore } from '../stores/uiStore';
import type { Insight, RepoInfo, StatusFilter } from '../types';

const FILTERS: { id: StatusFilter; label: string; color: string }[] = [
  { id: 'all', label: 'All Repositories', color: 'var(--text2)' },
  { id: 'attention', label: 'Needs Action', color: 'var(--amber)' },
  { id: 'clean', label: 'Clean / Up-to-date', color: 'var(--green)' },
];

export default function Status() {
  const { repos, selectedRepo, selectRepo, refreshRepo } = useRepoStore();
  const { addToast, statusFilter, setStatusFilter } = useUiStore();

  const insights = useMemo(() => generateInsights(repos), [repos]);
  const counts = useMemo(() => countRepos(repos), [repos]);
  const visible = useMemo(() => filterRepos(repos, statusFilter), [repos, statusFilter]);

  const handleFetch = async (repo: RepoInfo) => {
    try {
      await fetchAll(repo.path);
      await refreshRepo(repo.path);
      addToast(`${repo.name}: fetch 完了`, 'success');
    } catch (e) {
      addToast(`${repo.name}: ${String(e)}`, 'error');
    }
  };

  const handleOpenFolder = async (repo: RepoInfo) => {
    try {
      await openRepoFolder(repo.path);
    } catch (e) {
      addToast(String(e), 'error');
    }
  };

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column' }}>
      <div role="group" aria-label="状態で絞り込み" style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        {FILTERS.map((filter) => {
          const active = statusFilter === filter.id;
          return (
            <button
              key={filter.id}
              aria-pressed={active}
              onClick={() => setStatusFilter(filter.id)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 12px',
                borderRadius: 999,
                border: `1px solid ${active ? filter.color : 'var(--border2)'}`,
                background: active ? 'var(--bg3)' : 'none',
                color: active ? filter.color : 'var(--text3)',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              {filter.label}
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>{counts[filter.id]}</span>
            </button>
          );
        })}
      </div>

      {visible.length === 0 && (
        <div style={{ fontSize: 11, color: 'var(--text3)', padding: '24px 0', textAlign: 'center' }}>
          {repos.length === 0 ? 'リポジトリがありません。Settings で workspace root を設定してください。' : '該当するリポジトリはありません。'}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {visible.map((r) => (
          <RepoCard
            key={r.path}
            repo={r}
            selected={selectedRepo?.path === r.path}
            onSelect={() => selectRepo(r)}
            onFetch={() => void handleFetch(r)}
            onOpenFolder={() => void handleOpenFolder(r)}
          />
        ))}
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
  );
}

interface RepoCardProps {
  repo: RepoInfo;
  selected: boolean;
  onSelect: () => void;
  onFetch: () => void;
  onOpenFolder: () => void;
}

function RepoCard({ repo, selected, onSelect, onFetch, onOpenFolder }: RepoCardProps) {
  const badge = statusBadge(repo);
  const dirty = repo.modified_count + repo.untracked_count;
  const edge = selected ? '#818cf850' : 'var(--border)';
  return (
    // カード全体のクリックは選択（コマンドパレットの Fetch の対象）。操作はボタンで行うため、キー操作は不要。
    <div
      role="group"
      aria-label={repo.name}
      onClick={onSelect}
      style={{
        background: selected ? 'var(--indigo-bg)' : 'var(--bg3)',
        // shorthand の border と borderLeft を混ぜると、再描画で borderLeft が上書きされるため、辺ごとに指定する。
        borderTop: `1px solid ${edge}`,
        borderRight: `1px solid ${edge}`,
        borderBottom: `1px solid ${edge}`,
        borderLeft: `3px solid ${badge.color}`,
        borderRadius: 'var(--r2)',
        padding: '12px 14px',
        cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 6 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--indigo-l)' }}>{repo.name}</div>
          <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>{repo.current_branch}</div>
        </div>
        <span style={{
          fontSize: 10,
          fontWeight: 500,
          padding: '2px 8px',
          borderRadius: 4,
          background: badge.bg,
          color: badge.color,
          flexShrink: 0,
        }}>
          {badge.label}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 10, marginTop: 8 }}>
        <span style={{ color: 'var(--green)' }}>↑ {repo.ahead}</span>
        <span style={{ color: 'var(--purple)' }}>↓ {repo.behind}</span>
        {dirty > 0 && <span style={{ color: 'var(--amber)' }}>~ {dirty}</span>}
        <span style={{ flex: 1 }} />
        <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex', gap: 6 }}>
          <AppBtn onClick={onFetch} aria-label={`Fetch ${repo.name}`}>↓ Fetch</AppBtn>
          <AppBtn onClick={onOpenFolder} aria-label={`${repo.name} のフォルダを開く`}>📁 Open</AppBtn>
        </span>
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

