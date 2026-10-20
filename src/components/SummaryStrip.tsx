import type { CSSProperties } from 'react';
import type { RunReport } from '../types';
import { dailyRefreshBlockReason, shortVersion } from '../lib/dsxActions';
import { countRemote, remoteNote, statusesFor } from '../lib/remoteStatus';
import { countRepos } from '../lib/repoStatus';
import { countsLabel, reportTone } from '../lib/runReport';
import { useCleanupStore } from '../stores/cleanupStore';
import { useEnvStore } from '../stores/envStore';
import { useRemoteStore } from '../stores/remoteStore';
import { useReportStore } from '../stores/reportStore';
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

/** dsx 環境の総合状態。Daily Refresh を実行できる状態かで決める。 */
function dsxEnvironment(
  dsx: ReturnType<typeof useEnvStore.getState>['dsx'],
  blockReason: string | null,
): { value: string; color: string; tag: string; title: string } {
  if (!dsx) return { value: '確認中', color: 'var(--text3)', tag: '', title: 'dsx の状態を確認しています' };
  if (!dsx.available) return { value: 'Missing', color: 'var(--red)', tag: 'dsx 未検出', title: blockReason ?? '' };
  const tag = shortVersion(dsx.version) ?? '';
  if (blockReason !== null) return { value: 'Attention', color: 'var(--amber)', tag, title: blockReason };
  return { value: 'Ready', color: 'var(--green)', tag, title: 'Daily Refresh を実行できます' };
}

const LAST_RUN_TONE = {
  ok: { value: 'OK', color: 'var(--green)' },
  attention: { value: 'Attention', color: 'var(--amber)' },
  error: { value: 'Failed', color: 'var(--red)' },
} as const;

/** 直近の dsx の実行の判定。失敗・スキップ・警告の件数を出し、内訳は Tools タブに出す。 */
function LastRunCard({ report, onClick }: { report: RunReport; onClick: () => void }) {
  const tone = LAST_RUN_TONE[reportTone(report)];
  const counts = countsLabel(report);
  return (
    <Card
      label="LAST RUN"
      value={tone.value}
      valueColor={tone.color}
      tag={counts ?? `dsx ${report.command}`}
      tagColor={counts ? tone.color : 'var(--text3)'}
      title={`直近の dsx ${report.command} の結果です。内訳（理由）は Tools タブに表示します`}
      onClick={onClick}
    />
  );
}

export default function SummaryStrip() {
  const repos = useRepoStore((s) => s.repos);
  const { dsx, workspace } = useEnvStore();
  const candidateCount = useCleanupStore((s) => s.candidateCount);
  const remoteStatuses = useRemoteStore((s) => s.statuses);
  const report = useReportStore((s) => s.report);
  const { navigate, setStatusFilter } = useUiStore();

  const counts = countRepos(repos);
  const env = dsxEnvironment(dsx, dailyRefreshBlockReason(dsx, workspace));

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
      {report && <LastRunCard report={report} onClick={() => navigate('tools')} />}
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
