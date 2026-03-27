import { useState } from 'react';
import { useQuery, useQueries } from '@tanstack/react-query';
import { useRepoStore } from '../stores/repoStore';
import { useUiStore } from '../stores/uiStore';
import AppBar, { AppBtn } from '../components/AppBar';
import { getPullRequests, getIssues, getCheckRuns, hasGithubPat } from '../lib/invoke';
import type { CheckRun, Issue, PullRequest } from '../types';

const STALE_MS = 5 * 60 * 1000;

type Tab = 'prs' | 'issues';

export default function PullRequests() {
  const { selectedRepo } = useRepoStore();
  const { navigate } = useUiStore();
  const [tab, setTab] = useState<Tab>('prs');

  const { data: hasPat, isLoading: patLoading, isError: patError } = useQuery({
    queryKey: ['has_pat'],
    queryFn: hasGithubPat,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const owner = selectedRepo?.github_owner ?? null;
  const repo = selectedRepo?.github_repo ?? null;
  const apiEnabled = !!hasPat && !!owner && !!repo;

  const { data: prs = [], isLoading: prsLoading, error: prsError } = useQuery({
    queryKey: ['prs', owner, repo],
    queryFn: () => getPullRequests(owner!, repo!),
    enabled: apiEnabled,
    staleTime: STALE_MS,
    refetchInterval: STALE_MS,
  });

  const { data: issues = [], isLoading: issuesLoading, error: issuesError } = useQuery({
    queryKey: ['issues', owner, repo],
    queryFn: () => getIssues(owner!, repo!),
    enabled: apiEnabled && tab === 'issues',
    staleTime: STALE_MS,
    refetchInterval: STALE_MS,
  });

  // CI status for each open PR — keyed by PR number to avoid cache collisions
  // (e.g. forks with identically-named branches). head_ref is used as the API ref.
  const checkResults = useQueries({
    queries: prs.map((pr) => ({
      queryKey: ['checks', owner, repo, pr.number],
      queryFn: () => getCheckRuns(owner!, repo!, pr.head_ref),
      enabled: apiEnabled && tab === 'prs',
      staleTime: STALE_MS,
      refetchInterval: STALE_MS,
    })),
  });

  const checkMap = new Map<number, CiStatus>();
  prs.forEach((pr, i) => {
    const runs: CheckRun[] = checkResults[i]?.data ?? [];
    checkMap.set(pr.number, deriveCheckStatus(runs));
  });

  // ─── Guards ────────────────────────────────────────────────────────────────

  if (!selectedRepo) {
    return <EmptyCard message="リポジトリを選択してください" />;
  }

  if (patLoading) {
    return <LoadingCard />;
  }

  if (patError) {
    return (
      <EmptyCard
        message="OS キーチェーンの読み取りに失敗しました"
        action="Settings を確認する"
        onAction={() => navigate('settings')}
      />
    );
  }

  if (!hasPat) {
    return (
      <EmptyCard
        message="GitHub PAT が設定されていません"
        action="Settings で設定する"
        onAction={() => navigate('settings')}
      />
    );
  }

  if (!owner || !repo) {
    return (
      <EmptyCard
        message="このリポジトリに GitHub Owner / Repo が設定されていません"
        action="Settings で設定する"
        onAction={() => navigate('settings')}
      />
    );
  }

  const loading = tab === 'prs' ? prsLoading : issuesLoading;
  const error = tab === 'prs' ? prsError : issuesError;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <AppBar
        path={
          <><span style={{ color: 'var(--text2)' }}>{owner}/{repo}</span></>
        }
        actions={
          <>
            <AppBtn
              variant={tab === 'prs' ? 'primary' : 'default'}
              onClick={() => setTab('prs')}
            >
              {prs.length > 0 ? `PRs (${prs.length})` : 'PRs'}
            </AppBtn>
            <AppBtn
              variant={tab === 'issues' ? 'primary' : 'default'}
              onClick={() => setTab('issues')}
            >
              Issues
            </AppBtn>
          </>
        }
      />

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 16px' }}>
        {loading && (
          <div style={{ padding: 24, color: 'var(--text3)', fontSize: 12 }}>読み込み中…</div>
        )}
        {!loading && error && (
          <div style={{ padding: 24, color: 'var(--red)', fontSize: 12 }}>{String(error)}</div>
        )}
        {!loading && !error && tab === 'prs' && (
          <PrTable prs={prs} checkMap={checkMap} />
        )}
        {!loading && !error && tab === 'issues' && (
          <IssueTable issues={issues} />
        )}
      </div>
    </div>
  );
}

// ─── Guard cards ──────────────────────────────────────────────────────────────

function EmptyCard({
  message,
  action,
  onAction,
}: {
  message: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: '100%', gap: 12,
    }}>
      <div style={{ color: 'var(--text2)', fontSize: 14 }}>{message}</div>
      {action && onAction && (
        <button
          type="button"
          onClick={onAction}
          style={{
            padding: '6px 16px', borderRadius: 'var(--r)',
            background: 'var(--indigo-bg2)', color: 'var(--indigo)',
            border: '1px solid var(--indigo-d)', fontSize: 12,
          }}
        >
          {action}
        </button>
      )}
    </div>
  );
}

function LoadingCard() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
      <div style={{ color: 'var(--text3)', fontSize: 12 }}>読み込み中…</div>
    </div>
  );
}

// ─── PR table ─────────────────────────────────────────────────────────────────

function PrTable({
  prs,
  checkMap,
}: {
  prs: PullRequest[];
  checkMap: Map<number, CiStatus>;
}) {
  if (prs.length === 0) {
    return (
      <div style={{ padding: 24, color: 'var(--text3)', fontSize: 12 }}>
        オープンな PR はありません
      </div>
    );
  }

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          {['CI', '#', 'TITLE', 'AUTHOR', 'BRANCH', 'UPDATED'].map((h) => (
            <th
              key={h}
              style={{
                fontSize: 10, fontWeight: 600, color: 'var(--text3)',
                letterSpacing: '.08em', textAlign: 'left',
                padding: '10px 8px', borderBottom: '1px solid var(--border2)',
              }}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {prs.map((pr) => (
          <PrRow
            key={pr.number}
            pr={pr}
            ciStatus={checkMap.get(pr.number) ?? null}
          />
        ))}
      </tbody>
    </table>
  );
}

function PrRow({ pr, ciStatus }: { pr: PullRequest; ciStatus: CiStatus }) {
  const dotColor =
    ciStatus === 'success' ? 'var(--green)'
    : ciStatus === 'failure' ? 'var(--red)'
    : ciStatus === 'pending' ? 'var(--amber)'
    : 'var(--text3)';

  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}>
      <td style={{ padding: '8px' }}>
        <span
          style={{
            display: 'inline-block', width: 8, height: 8,
            borderRadius: '50%', background: dotColor,
          }}
          title={ciStatus ?? 'unknown'}
        />
      </td>
      <td style={{
        padding: '8px',
        fontFamily: 'var(--font-mono)', fontSize: 11,
        color: 'var(--text3)',
      }}>
        #{pr.number}
      </td>
      <td style={{
        padding: '8px', fontSize: 12,
        color: pr.draft ? 'var(--text2)' : 'var(--text1)',
        maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {pr.draft && (
          <span style={{
            fontSize: 9, background: 'var(--bg4)', color: 'var(--text3)',
            padding: '1px 5px', borderRadius: 3, marginRight: 6,
          }}>
            Draft
          </span>
        )}
        {pr.title}
      </td>
      <td style={{ padding: '8px', fontSize: 11, color: 'var(--text2)' }}>
        {pr.user_login}
      </td>
      <td style={{
        padding: '8px',
        fontFamily: 'var(--font-mono)', fontSize: 10,
        color: 'var(--indigo)',
        maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {pr.head_ref}
      </td>
      <td style={{ padding: '8px', fontSize: 10, color: 'var(--text3)' }}>
        {relativeDate(pr.updated_at)}
      </td>
    </tr>
  );
}

// ─── Issue table ──────────────────────────────────────────────────────────────

function IssueTable({ issues }: { issues: Issue[] }) {
  if (issues.length === 0) {
    return (
      <div style={{ padding: 24, color: 'var(--text3)', fontSize: 12 }}>
        オープンな Issue はありません
      </div>
    );
  }

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          {['#', 'TITLE', 'LABELS', 'AUTHOR', 'UPDATED'].map((h) => (
            <th
              key={h}
              style={{
                fontSize: 10, fontWeight: 600, color: 'var(--text3)',
                letterSpacing: '.08em', textAlign: 'left',
                padding: '10px 8px', borderBottom: '1px solid var(--border2)',
              }}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {issues.map((issue) => (
          <IssueRow key={issue.number} issue={issue} />
        ))}
      </tbody>
    </table>
  );
}

function IssueRow({ issue }: { issue: Issue }) {
  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}>
      <td style={{
        padding: '8px',
        fontFamily: 'var(--font-mono)', fontSize: 11,
        color: 'var(--text3)',
      }}>
        #{issue.number}
      </td>
      <td style={{
        padding: '8px', fontSize: 12, color: 'var(--text1)',
        maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {issue.title}
      </td>
      <td style={{ padding: '8px' }}>
        {issue.labels.map((l) => (
          <span
            key={l}
            style={{
              fontSize: 9, background: 'var(--bg4)', color: 'var(--text2)',
              padding: '1px 5px', borderRadius: 3, marginRight: 3,
            }}
          >
            {l}
          </span>
        ))}
      </td>
      <td style={{ padding: '8px', fontSize: 11, color: 'var(--text2)' }}>
        {issue.user_login}
      </td>
      <td style={{ padding: '8px', fontSize: 10, color: 'var(--text3)' }}>
        {relativeDate(issue.updated_at)}
      </td>
    </tr>
  );
}

// ─── Utilities ────────────────────────────────────────────────────────────────

type CiStatus = 'success' | 'failure' | 'pending' | null;

function deriveCheckStatus(runs: CheckRun[]): CiStatus {
  if (runs.length === 0) return null;
  if (runs.some((r) => r.status === 'in_progress' || r.status === 'queued')) return 'pending';
  if (runs.some((r) =>
    r.conclusion === 'failure' ||
    r.conclusion === 'timed_out' ||
    r.conclusion === 'action_required'
  )) return 'failure';
  if (runs.every((r) =>
    r.conclusion === 'success' ||
    r.conclusion === 'skipped' ||
    r.conclusion === 'neutral' ||
    r.conclusion === 'cancelled'
  )) return 'success';
  return null;
}

function relativeDate(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86_400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 604_800) return `${Math.floor(diff / 86_400)}d`;
  return `${Math.floor(diff / 604_800)}w`;
}
