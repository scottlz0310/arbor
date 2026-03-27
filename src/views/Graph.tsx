import { useQuery } from '@tanstack/react-query';
import { useRepoStore } from '../stores/repoStore';
import AppBar from '../components/AppBar';
import { getCommitGraph } from '../lib/invoke';
import type { CommitNode } from '../types';

// ─── Layout constants ─────────────────────────────────────────────────────────

const ROW_H = 26;
const LANE_W = 16;
const DOT_R = 4;

// Hardcoded hex values matching design tokens (CSS vars don't resolve in SVG attrs)
const LANE_COLORS = ['#818cf8', '#4ade80', '#fbbf24', '#f87171', '#c084fc'];

function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}
function dotX(lane: number): number { return lane * LANE_W + LANE_W / 2; }
function dotY(row: number): number  { return row  * ROW_H  + ROW_H  / 2; }

// ─── Main component ───────────────────────────────────────────────────────────

export default function Graph() {
  const { selectedRepo } = useRepoStore();

  const { data: commits = [], isLoading, error } = useQuery({
    queryKey: ['graph', selectedRepo?.path],
    queryFn: () => getCommitGraph(selectedRepo!.path),
    enabled: !!selectedRepo,
    staleTime: 30_000,
  });

  if (!selectedRepo) {
    return <CenteredMsg>リポジトリを選択してください</CenteredMsg>;
  }
  if (isLoading) {
    return <CenteredMsg muted>読み込み中…</CenteredMsg>;
  }
  if (error) {
    return <CenteredMsg color="#f87171">{String(error)}</CenteredMsg>;
  }
  if (commits.length === 0) {
    return <CenteredMsg muted>コミットがありません</CenteredMsg>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <AppBar
        path={
          <>
            <span style={{ color: 'var(--text2)' }}>{selectedRepo.name}</span>
            {' '}· {commits.length} commits
          </>
        }
      />
      <div style={{ flex: 1, overflow: 'auto' }}>
        <CommitGraph commits={commits} />
      </div>
    </div>
  );
}

// ─── SVG graph ────────────────────────────────────────────────────────────────

function CommitGraph({ commits }: { commits: CommitNode[] }) {
  const maxLane  = commits.reduce((m, c) => Math.max(m, c.lane), 0);
  const laneAreaW = (maxLane + 1) * LANE_W;
  const textX     = laneAreaW + 12;
  const svgW      = textX + 560;
  const svgH      = commits.length * ROW_H + 8;

  // Pre-compute row index for each OID so we can draw edges to parents.
  const rowOf = new Map(commits.map((c, i) => [c.oid, i]));

  return (
    <svg
      width={svgW}
      height={svgH}
      style={{ display: 'block', fontFamily: 'var(--font-mono)' }}
    >
      {/* ── Edges (drawn first, behind dots) ─────────────────────────────── */}
      {commits.map((commit, row) =>
        commit.parent_oids.map((parentOid) => {
          const parentRow = rowOf.get(parentOid);
          if (parentRow === undefined) return null;
          const parent = commits[parentRow];
          const x1 = dotX(commit.lane), y1 = dotY(row);
          const x2 = dotX(parent.lane),  y2 = dotY(parentRow);
          const mid = (y1 + y2) / 2;
          return (
            <path
              key={`${commit.oid}-${parentOid}`}
              d={`M ${x1} ${y1} C ${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`}
              fill="none"
              stroke={laneColor(commit.lane)}
              strokeWidth={1.5}
              opacity={0.45}
            />
          );
        })
      )}

      {/* ── Dots + text ───────────────────────────────────────────────────── */}
      {commits.map((commit, row) => (
        <CommitRow
          key={commit.oid}
          commit={commit}
          row={row}
          textX={textX}
          svgW={svgW}
        />
      ))}
    </svg>
  );
}

// ─── Single commit row ────────────────────────────────────────────────────────

function CommitRow({
  commit,
  row,
  textX,
  svgW,
}: {
  commit: CommitNode;
  row: number;
  textX: number;
  svgW: number;
}) {
  const cx = dotX(commit.lane);
  const cy = dotY(row);
  const color = laneColor(commit.lane);

  const date = new Date(commit.timestamp * 1000);
  const dateStr = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;

  // Text columns (relative to textX):
  //   0      : short SHA (7 chars ≈ 54px)
  //   62     : refs + summary
  //   440    : date
  const shaX     = textX;
  const summaryX = textX + 62;
  const dateX    = svgW - 80;

  // Truncate summary so it doesn't overflow into the date column.
  const maxSummaryChars = 55;
  const summary = commit.summary.length > maxSummaryChars
    ? commit.summary.slice(0, maxSummaryChars - 1) + '…'
    : commit.summary;

  return (
    <g>
      {/* Lane dot */}
      <circle cx={cx} cy={cy} r={DOT_R} fill={color} />

      {/* Short SHA */}
      <text x={shaX} y={cy + 4} fontSize={10} fill="#4a5568">
        {commit.short_oid}
      </text>

      {/* Ref badges (one tspan each) then summary */}
      <text x={summaryX} y={cy + 4} fontSize={11}>
        {commit.refs.map((r, idx) => (
          <tspan key={`${r}-${idx}`} fill="#818cf8">[{r}] </tspan>
        ))}
        <tspan fill="#e2e8f0">{summary}</tspan>
      </text>

      {/* Date */}
      <text x={dateX} y={cy + 4} fontSize={10} fill="#4a5568">
        {dateStr}
      </text>
    </g>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function CenteredMsg({
  children,
  color = '#94a3b8',
  muted,
}: {
  children: React.ReactNode;
  color?: string;
  muted?: boolean;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100%', fontSize: 14,
      color: muted ? 'var(--text3)' : color,
    }}>
      {children}
    </div>
  );
}
