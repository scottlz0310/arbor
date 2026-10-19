import type { CSSProperties } from 'react';
import { dailyRefreshBlockReason, shortVersion } from '../lib/dsxActions';
import { countRemote, remoteNote, statusesFor } from '../lib/remoteStatus';
import { countRepos } from '../lib/repoStatus';
import { useCleanupStore } from '../stores/cleanupStore';
import { useEnvStore } from '../stores/envStore';
import { useRemoteStore } from '../stores/remoteStore';
import { useRepoStore } from '../stores/repoStore';
import { useUiStore } from '../stores/uiStore';

interface CardProps {
  label: string;
  value: string | number;
  valueColor: string;
  tag: string;
  tagColor: string;
  /** 値の下に添える、注意を促す 1 行（無ければ表示しない）。 */
  note?: string | null;
  title: string;
  onClick: () => void;
}

function Card({ label, value, valueColor, tag, tagColor, note, title, onClick }: CardProps) {
  const style: CSSProperties = {
    flex: 1,
    minWidth: 150,
    background: 'var(--bg3)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--r)',
    padding: '10px 14px',
    textAlign: 'left',
    cursor: 'pointer',
  };
  return (
    <button onClick={onClick} title={title} style={style}>
      <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text3)', letterSpacing: '.1em', marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 22, fontWeight: 600, fontFamily: 'var(--font-display)', lineHeight: 1, color: valueColor }}>
          {value}
        </span>
        <span style={{ fontSize: 10, color: tagColor }}>{tag}</span>
      </div>
      {note && <div style={{ fontSize: 10, color: 'var(--amber)', marginTop: 4 }}>{note}</div>}
    </button>
  );
}

/** dsx 環境の総合状態。Daily Refresh を実行できる状態か、Bitwarden が解錠されているかで決める。 */
function dsxEnvironment(
  dsx: ReturnType<typeof useEnvStore.getState>['dsx'],
  bitwarden: ReturnType<typeof useEnvStore.getState>['bitwarden'],
  blockReason: string | null,
): { value: string; color: string; tag: string; title: string } {
  if (!dsx) return { value: '確認中', color: 'var(--text3)', tag: '', title: 'dsx の状態を確認しています' };
  if (!dsx.available) return { value: 'Missing', color: 'var(--red)', tag: 'dsx 未検出', title: blockReason ?? '' };
  const tag = shortVersion(dsx.version) ?? '';
  if (blockReason !== null) return { value: 'Attention', color: 'var(--amber)', tag, title: blockReason };
  if (bitwarden === 'not_unlocked') {
    return { value: 'Attention', color: 'var(--amber)', tag, title: 'Bitwarden が解錠されていません' };
  }
  return { value: 'Ready', color: 'var(--green)', tag, title: 'Daily Refresh を実行できます' };
}

export default function SummaryStrip() {
  const repos = useRepoStore((s) => s.repos);
  const { dsx, bitwarden, workspace } = useEnvStore();
  const candidateCount = useCleanupStore((s) => s.candidateCount);
  const remoteStatuses = useRemoteStore((s) => s.statuses);
  const { navigate, setStatusFilter } = useUiStore();

  const counts = countRepos(repos);
  const env = dsxEnvironment(dsx, bitwarden, dailyRefreshBlockReason(dsx, workspace));

  const showStatus = (filter: 'all' | 'attention') => {
    setStatusFilter(filter);
    navigate('status');
  };

  return (
    <div style={{ display: 'flex', gap: 8, padding: '12px 16px 0', flexWrap: 'wrap', flexShrink: 0 }}>
      <Card
        label="TOTAL REPOSITORIES"
        value={counts.all}
        valueColor="var(--text1)"
        tag={`${counts.clean} Clean`}
        tagColor="var(--green)"
        note={remoteNote(countRemote(statusesFor(repos, remoteStatuses)))}
        title="すべてのリポジトリを表示"
        onClick={() => showStatus('all')}
      />
      <Card
        label="NEEDS ACTION"
        value={counts.attention}
        valueColor={counts.attention > 0 ? 'var(--amber)' : 'var(--green)'}
        tag={counts.attention > 0 ? 'Action Needed' : 'All clear'}
        tagColor={counts.attention > 0 ? 'var(--amber)' : 'var(--text3)'}
        title="要対応のリポジトリを表示"
        onClick={() => showStatus('attention')}
      />
      <Card
        label="CLEANUP CANDIDATES"
        value={candidateCount ?? '—'}
        valueColor={candidateCount ? 'var(--indigo-l)' : 'var(--text3)'}
        tag={candidateCount === null ? 'Cleanup を開くと集計' : 'Prune / Delete'}
        tagColor="var(--text3)"
        title="Cleanup の候補は、全リポジトリの remote へ接続して集計するため、Cleanup を開いたときだけ読み込みます"
        onClick={() => navigate('cleanup')}
      />
      <Card
        label="DSX ENVIRONMENT"
        value={env.value}
        valueColor={env.color}
        tag={env.tag}
        tagColor="var(--text3)"
        title={env.title}
        onClick={() => navigate('tools')}
      />
    </div>
  );
}
