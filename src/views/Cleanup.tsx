import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import AppBar, { AppBtn } from '../components/AppBar';
import ConfirmDialog from '../components/ConfirmDialog';
import { cleanupExecute, cleanupPreview } from '../lib/invoke';
import { useUiStore } from '../stores/uiStore';
import type {
  CandidateKind,
  CleanupCandidate,
  CleanupExecutionItemResult,
  CleanupExecutionResult,
  CleanupOperation,
  CleanupPreview,
  RepoCleanupPreview,
  SafetyBlock,
  UpstreamState,
} from '../types';

const SEP = '\x00';

const operationLabels: Record<CleanupOperation, string> = {
  delete_local_branch: 'Delete local branch',
  prune_remote_tracking_ref: 'Prune remote-tracking ref',
};

const kindLabels: Record<CandidateKind, string> = {
  merged: 'Merged into default branch',
  stale: 'Stale local branch',
  upstream_gone: 'Upstream is gone',
  stale_remote_tracking: 'Remote branch no longer exists',
};

const upstreamLabels: Record<UpstreamState, string> = {
  none: 'No upstream',
  tracked: 'Upstream tracked',
  gone: 'Upstream gone',
};

const safetyBlockLabels: Record<SafetyBlock, string> = {
  current_branch: 'currently checked out',
  default_branch: 'default branch',
  protected_branch: 'protected branch',
  worktree_checked_out: 'checked out in a worktree',
};

const candidateKey = (candidate: CleanupCandidate) =>
  [candidate.repo_path, candidate.operation, candidate.ref_name].join(SEP);

const allCandidates = (preview: CleanupPreview | null) =>
  preview?.repos.flatMap((repo) => repo.candidates) ?? [];

const initialSelection = (preview: CleanupPreview) =>
  new Set(
    allCandidates(preview)
      .filter(
        (candidate) =>
          candidate.operation === 'delete_local_branch'
          && candidate.kind === 'merged'
          && candidate.blocked.length === 0,
      )
      .map(candidateKey),
  );

export default function Cleanup() {
  const { addToast } = useUiStore();
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [executionResult, setExecutionResult] = useState<CleanupExecutionResult | null>(null);

  const loadPreview = useCallback(async () => {
    setLoading(true);
    try {
      const nextPreview = await cleanupPreview();
      setPreview(nextPreview);
      setSelected(initialSelection(nextPreview));
    } catch (error) {
      setPreview(null);
      setSelected(new Set());
      setConfirmOpen(false);
      addToast(`Cleanup preview failed: ${String(error)}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  const candidates = useMemo(() => allCandidates(preview), [preview]);
  const localCandidates = candidates.filter(
    (candidate) => candidate.operation === 'delete_local_branch',
  );
  const remoteCandidates = candidates.filter(
    (candidate) => candidate.operation === 'prune_remote_tracking_ref',
  );
  const selectedCandidates = candidates.filter((candidate) => selected.has(candidateKey(candidate)));
  const blockedCandidates = candidates.filter((candidate) => candidate.blocked.length > 0);

  const toggleSelected = (candidate: CleanupCandidate) => {
    if (candidate.blocked.length > 0) return;
    setSelected((current) => {
      const next = new Set(current);
      const key = candidateKey(candidate);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const executeSelected = async () => {
    if (selectedCandidates.length === 0) return;
    setConfirmOpen(false);
    setExecuting(true);
    try {
      const result = await cleanupExecute(selectedCandidates);
      setExecutionResult(result);
      const success = result.items.filter((item) => item.status === 'success').length;
      const skipped = result.items.filter((item) => item.status === 'skipped').length;
      const failed = result.items.filter((item) => item.status === 'failed').length;
      addToast(
        `Cleanup complete: ${success} succeeded, ${skipped} skipped, ${failed} failed`,
        failed > 0 ? 'error' : 'success',
      );
      await loadPreview();
    } catch (error) {
      addToast(`Cleanup execute failed: ${String(error)}`, 'error');
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <AppBar
        path={<span style={{ color: 'var(--text2)' }}>Cleanup Wizard · All repositories</span>}
        actions={
          <>
            <AppBtn onClick={() => void loadPreview()} disabled={loading || executing}>
              {loading ? 'Scanning…' : 'Rescan'}
            </AppBtn>
            <AppBtn
              variant="danger"
              onClick={() => setConfirmOpen(true)}
              disabled={selectedCandidates.length === 0 || loading || executing}
            >
              Execute selected ({selectedCandidates.length})
            </AppBtn>
          </>
        }
      />

      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        <PreviewSummary preview={preview} loading={loading} selectedCount={selectedCandidates.length} />

        {preview && <PreviewErrors repos={preview.repos} />}

        <CandidateSection
          title="LOCAL BRANCHES"
          description="Merged branches are selected initially. Stale and upstream-gone branches require explicit selection."
          candidates={localCandidates}
          selected={selected}
          onToggle={toggleSelected}
          accent="var(--green)"
        />

        <CandidateSection
          title="REMOTE-TRACKING REFS"
          description="Only the local remote-tracking ref is pruned. The remote server branch is never deleted."
          candidates={remoteCandidates}
          selected={selected}
          onToggle={toggleSelected}
          accent="var(--indigo-l)"
        />

        {!loading && preview && candidates.length === 0 && (
          <EmptyState>No cleanup candidates were found across registered repositories.</EmptyState>
        )}

        {executionResult && <ExecutionResults result={executionResult} />}
      </div>

      {confirmOpen && (
        <ConfirmDialog
          title={`Execute ${selectedCandidates.length} cleanup operation(s)?`}
          message={
            <CleanupConfirmation
              selected={selectedCandidates}
              blocked={blockedCandidates}
            />
          }
          confirmLabel="Execute cleanup"
          confirmDisabled={executing}
          maxWidth={720}
          onConfirm={() => void executeSelected()}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}

function PreviewSummary({
  preview,
  loading,
  selectedCount,
}: {
  preview: CleanupPreview | null;
  loading: boolean;
  selectedCount: number;
}) {
  const candidates = allCandidates(preview);
  const repoErrors = preview?.repos.filter((repo) => repo.error !== null).length ?? 0;
  const remoteErrors = preview?.repos.reduce((count, repo) => count + repo.remote_errors.length, 0) ?? 0;
  const cards = [
    ['Repositories', preview?.repos.length ?? 0],
    ['Candidates', candidates.length],
    ['Selected', selectedCount],
    ['Errors', repoErrors + remoteErrors],
  ] as const;

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
        {cards.map(([label, value]) => (
          <div
            key={label}
            style={{
              padding: '10px 12px',
              background: 'var(--bg3)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--r)',
            }}
          >
            <div style={{ color: 'var(--text3)', fontSize: 10, marginBottom: 3 }}>{label}</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 16 }}>{loading ? '—' : value}</div>
          </div>
        ))}
      </div>
      {preview && (
        <div style={{ color: 'var(--text3)', fontSize: 10, marginTop: 6 }}>
          Preview generated {new Date(preview.generated_at * 1000).toLocaleString()}. Every selected item is revalidated immediately before execution.
        </div>
      )}
    </div>
  );
}

function PreviewErrors({ repos }: { repos: RepoCleanupPreview[] }) {
  const errors = repos.flatMap((repo) => [
    ...(repo.error ? [{ key: `${repo.repo_path}:repo`, repo, scope: 'repository', error: repo.error }] : []),
    ...repo.remote_errors.map((remoteError) => ({
      key: `${repo.repo_path}:remote:${remoteError.remote}`,
      repo,
      scope: `remote ${remoteError.remote}`,
      error: remoteError.error,
    })),
  ]);
  if (errors.length === 0) return null;

  return (
    <section style={{ marginBottom: 20 }} aria-labelledby="cleanup-preview-errors">
      <SectionHeading id="cleanup-preview-errors" title="PREVIEW ERRORS" count={errors.length} accent="var(--red)" />
      {errors.map(({ key, repo, scope, error }) => (
        <div key={key} style={errorBoxStyle}>
          <strong>{repo.repo_name}</strong> · {scope}: {error}
          <div style={{ color: 'var(--text3)', marginTop: 3 }}>{repo.repo_path}</div>
        </div>
      ))}
    </section>
  );
}

function CandidateSection({
  title,
  description,
  candidates,
  selected,
  onToggle,
  accent,
}: {
  title: string;
  description: string;
  candidates: CleanupCandidate[];
  selected: Set<string>;
  onToggle: (candidate: CleanupCandidate) => void;
  accent: string;
}) {
  if (candidates.length === 0) return null;
  const grouped = groupByRepo(candidates);

  return (
    <section style={{ marginBottom: 22 }} aria-label={title}>
      <SectionHeading title={title} count={candidates.length} accent={accent} />
      <div style={{ color: 'var(--text3)', fontSize: 10, margin: '-3px 0 10px' }}>{description}</div>
      {grouped.map(({ repoPath, repoName, items }) => (
        <div key={repoPath} style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 5 }}>
            <strong style={{ fontSize: 12 }}>{repoName}</strong>
            <span style={{ color: 'var(--text3)', fontFamily: 'var(--font-mono)', fontSize: 9 }}>
              {repoPath}
            </span>
          </div>
          {items.map((candidate) => (
            <CandidateRow
              key={candidateKey(candidate)}
              candidate={candidate}
              checked={selected.has(candidateKey(candidate))}
              onToggle={() => onToggle(candidate)}
            />
          ))}
        </div>
      ))}
    </section>
  );
}

function CandidateRow({
  candidate,
  checked,
  onToggle,
}: {
  candidate: CleanupCandidate;
  checked: boolean;
  onToggle: () => void;
}) {
  const blocked = candidate.blocked.length > 0;
  const reason = candidate.kind === 'stale' && candidate.stale_days !== null
    ? `${kindLabels[candidate.kind]} (${candidate.stale_days} days)`
    : kindLabels[candidate.kind];

  return (
    <label
      style={{
        display: 'block',
        padding: '9px 10px',
        background: 'var(--bg3)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r)',
        marginBottom: 5,
        opacity: blocked ? 0.65 : 1,
        cursor: blocked ? 'not-allowed' : 'pointer',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <input
          type="checkbox"
          aria-label={`Select ${candidate.repo_name} ${candidate.ref_name}`}
          checked={checked}
          disabled={blocked}
          onChange={onToggle}
          style={{ accentColor: 'var(--red)', width: 14, height: 14, flexShrink: 0 }}
        />
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, flex: 1 }}>
          {candidate.ref_name}
        </span>
        <span style={pillStyle}>{operationLabels[candidate.operation]}</span>
      </div>
      <div style={{ paddingLeft: 23, marginTop: 5, color: 'var(--text3)', fontSize: 10, lineHeight: 1.6 }}>
        {reason} · {upstreamLabels[candidate.upstream]}
        {candidate.remote_name && <> · remote <code>{candidate.remote_name}</code></>}
        {' · '}commit {new Date(candidate.last_commit_ts * 1000).toLocaleDateString()}
        {' · '}OID <code>{candidate.oid.slice(0, 8)}</code>
      </div>
      {blocked && (
        <div style={{ paddingLeft: 23, marginTop: 3, color: 'var(--red)', fontSize: 10 }}>
          Selection blocked: {candidate.blocked.map((item) => safetyBlockLabels[item]).join(', ')}
        </div>
      )}
    </label>
  );
}

function CleanupConfirmation({
  selected,
  blocked,
}: {
  selected: CleanupCandidate[];
  blocked: CleanupCandidate[];
}) {
  const grouped = groupByRepo(selected);

  return (
    <div style={{ maxHeight: '60vh', overflowY: 'auto', paddingRight: 4 }}>
      {grouped.map(({ repoPath, repoName, items }) => {
        const localCount = items.filter((item) => item.operation === 'delete_local_branch').length;
        const remoteCount = items.length - localCount;
        return (
          <div key={repoPath} style={{ marginBottom: 16 }}>
            <strong>{repoName}</strong>
            <div style={{ color: 'var(--text3)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>
              {repoPath}
            </div>
            <div style={{ margin: '5px 0', fontSize: 11 }}>
              Local deletion: {localCount} · Remote-tracking prune: {remoteCount}
            </div>
            <ul style={{ margin: '5px 0 0', paddingLeft: 18 }}>
              {items.map((candidate) => (
                <li key={candidateKey(candidate)} style={{ marginBottom: 4 }}>
                  <code>
                    {candidate.repo_name} / {candidate.remote_name ?? 'local'} / {candidate.ref_name}
                  </code>
                  <span style={{ color: 'var(--text3)' }}> — {operationLabels[candidate.operation]}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}

      {blocked.length > 0 && (
        <div style={{ ...errorBoxStyle, marginBottom: 12 }}>
          <strong>Selection blocked / skipped ({blocked.length})</strong>
          <ul style={{ margin: '5px 0 0', paddingLeft: 18 }}>
            {blocked.map((candidate) => (
              <li key={candidateKey(candidate)}>
                {candidate.repo_name} / {candidate.ref_name}: {' '}
                {candidate.blocked.map((item) => safetyBlockLabels[item]).join(', ')}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div style={{ padding: 10, background: 'var(--red-bg)', borderRadius: 'var(--r)', fontSize: 11 }}>
        Local branches may be recoverable through Git reflog for a limited time. Prune operations remove only local remote-tracking refs and never delete remote server branches. Every target will be revalidated before execution; changed targets are skipped.
      </div>
    </div>
  );
}

function ExecutionResults({ result }: { result: CleanupExecutionResult }) {
  const counts = {
    success: result.items.filter((item) => item.status === 'success').length,
    skipped: result.items.filter((item) => item.status === 'skipped').length,
    failed: result.items.filter((item) => item.status === 'failed').length,
  };

  return (
    <section style={{ marginTop: 24 }} aria-label="Cleanup execution results">
      <SectionHeading title="EXECUTION RESULTS" count={result.items.length} accent="var(--indigo-l)" />
      <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 8 }}>
        {counts.success} succeeded · {counts.skipped} skipped · {counts.failed} failed · completed {' '}
        {new Date(result.completed_at * 1000).toLocaleString()}
      </div>
      {result.items.map((item, index) => (
        <ExecutionResultRow key={`${resultItemKey(item)}${SEP}${index}`} item={item} />
      ))}
    </section>
  );
}

function ExecutionResultRow({ item }: { item: CleanupExecutionItemResult }) {
  const color = item.status === 'success'
    ? 'var(--green)'
    : item.status === 'skipped'
    ? 'var(--amber)'
    : 'var(--red)';
  return (
    <div style={{ ...resultRowStyle, borderLeft: `3px solid ${color}` }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <strong style={{ color, textTransform: 'uppercase', fontSize: 10 }}>{item.status}</strong>
        <code>{item.repo_name} / {item.ref_name}</code>
        <span style={{ color: 'var(--text3)', marginLeft: 'auto' }}>{operationLabels[item.operation]}</span>
      </div>
      {(item.reason || item.error) && (
        <div style={{ color: item.error ? 'var(--red)' : 'var(--text3)', fontSize: 10, marginTop: 4 }}>
          {item.error ?? item.reason}
        </div>
      )}
    </div>
  );
}

function SectionHeading({
  id,
  title,
  count,
  accent,
}: {
  id?: string;
  title: string;
  count: number;
  accent: string;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
      <span id={id} style={{ color: 'var(--text3)', fontSize: 11, fontWeight: 600, letterSpacing: '.08em' }}>
        {title}
      </span>
      <span style={{ ...pillStyle, color: accent, background: `color-mix(in srgb, ${accent} 12%, transparent)` }}>
        {count} items
      </span>
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)', border: '1px dashed var(--border2)' }}>
      {children}
    </div>
  );
}

function groupByRepo<T extends { repo_path: string; repo_name: string }>(items: T[]) {
  const groups = new Map<string, { repoPath: string; repoName: string; items: T[] }>();
  for (const item of items) {
    const group = groups.get(item.repo_path) ?? {
      repoPath: item.repo_path,
      repoName: item.repo_name,
      items: [],
    };
    group.items.push(item);
    groups.set(item.repo_path, group);
  }
  return [...groups.values()];
}

const resultItemKey = (item: CleanupExecutionItemResult) =>
  [item.repo_path, item.operation, item.ref_name, item.status].join(SEP);

const pillStyle = {
  padding: '2px 7px',
  borderRadius: 10,
  background: 'var(--bg2)',
  color: 'var(--text3)',
  fontSize: 9,
  whiteSpace: 'nowrap',
} as const;

const errorBoxStyle = {
  padding: '8px 10px',
  marginBottom: 5,
  background: 'var(--red-bg)',
  border: '1px solid #f8717128',
  borderRadius: 'var(--r)',
  color: 'var(--red)',
  fontSize: 10,
  lineHeight: 1.5,
} as const;

const resultRowStyle = {
  padding: '8px 10px',
  marginBottom: 5,
  background: 'var(--bg3)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r)',
  fontSize: 10,
} as const;
