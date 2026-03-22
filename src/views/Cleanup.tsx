import { useEffect, useState } from 'react';
import { useRepoStore } from '../stores/repoStore';
import { useUiStore } from '../stores/uiStore';
import AppBar, { AppBtn } from '../components/AppBar';
import ConfirmDialog from '../components/ConfirmDialog';
import { getBranches, repoCleanupPreview, repoCleanup } from '../lib/invoke';
import type { BranchInfo } from '../types';

export default function Cleanup() {
  const { repos, selectedRepo } = useRepoStore();
  const { addToast, setDsxRunning } = useUiStore();

  const [mergedBranches, setMergedBranches]     = useState<BranchInfo[]>([]);
  const [staleBranches, setStaleBranches]       = useState<BranchInfo[]>([]);
  const [selected, setSelected]                 = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen]           = useState(false);
  const [previewOut, setPreviewOut]             = useState('');
  const [loading, setLoading]                   = useState(false);

  const staleThreshold = 14 * 86400;
  const nowSec = Math.floor(Date.now() / 1000);

  // Load branches for ALL repos.
  useEffect(() => {
    setLoading(true);
    Promise.all(
      repos.map((r) =>
        getBranches(r.path).then((branches) =>
          branches.map((b) => ({ ...b, _repoName: r.name, _repoPath: r.path }))
        )
      )
    )
      .then((allBranches) => {
        const flat = allBranches.flat() as (BranchInfo & { _repoName: string; _repoPath: string })[];
        setMergedBranches(flat.filter((b) => (b.is_merged || b.is_squash_merged) && !b.is_current));
        setStaleBranches(flat.filter(
          (b) => !b.is_merged && !b.is_squash_merged && !b.is_current
            && nowSec - b.last_commit_ts > staleThreshold
        ));
      })
      .catch((e) => addToast(String(e), 'error'))
      .finally(() => setLoading(false));
  }, [repos]);

  const toggleSelect = (name: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name); else n.add(name);
      return n;
    });

  const handlePreviewAndConfirm = async () => {
    if (!selectedRepo) {
      addToast('Select a repository first', 'error');
      return;
    }
    try {
      const out = await repoCleanupPreview(selectedRepo.path);
      setPreviewOut(out.stdout || '(no output)');
      setConfirmOpen(true);
    } catch (e) {
      addToast(String(e), 'error');
    }
  };

  const handleExecute = async () => {
    if (!selectedRepo) return;
    setConfirmOpen(false);
    setDsxRunning(true);
    try {
      await repoCleanup(selectedRepo.path);
      addToast('Cleanup complete', 'success');
    } catch (e) {
      addToast(String(e), 'error');
    } finally {
      setDsxRunning(false);
    }
  };

  const formatAge = (ts: number) => {
    const diff = nowSec - ts;
    if (diff < 86400)  return `${Math.floor(diff / 3600)}h`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
    return `${Math.floor(diff / 604800)}w`;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <AppBar
        path={<span style={{ color: 'var(--text2)' }}>Cleanup Wizard</span>}
        actions={
          <>
            {selected.size > 0 && (
              <AppBtn variant="danger" onClick={handlePreviewAndConfirm}>
                Execute selected ({selected.size})
              </AppBtn>
            )}
            <AppBtn variant="danger" onClick={handlePreviewAndConfirm}>
              dsx cleanup (preview)
            </AppBtn>
          </>
        }
      />

      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        {loading && (
          <div style={{ color: 'var(--text3)', fontSize: 12, marginBottom: 16 }}>Loading…</div>
        )}

        {/* Merged branches */}
        <CleanupSection
          title="MERGED BRANCHES"
          count={mergedBranches.length}
          countColor="var(--green)"
        >
          {mergedBranches.map((b) => {
            const bb = b as BranchInfo & { _repoName?: string };
            return (
              <CleanupItem
                key={`${bb._repoName}/${b.name}`}
                name={b.name}
                info={`${bb._repoName ?? ''} · merged ${formatAge(b.last_commit_ts)} ago`}
                nameColor="var(--green)"
                checked={selected.has(b.name)}
                onToggle={toggleSelect}
                checkAccent="var(--red)"
              />
            );
          })}
        </CleanupSection>

        {/* Stale branches */}
        <CleanupSection
          title={`STALE BRANCHES (> 14 days)`}
          count={staleBranches.length}
          countColor="var(--amber)"
        >
          {staleBranches.map((b) => {
            const bb = b as BranchInfo & { _repoName?: string };
            const ageDays = Math.floor((nowSec - b.last_commit_ts) / 86400);
            return (
              <CleanupItem
                key={`${bb._repoName}/${b.name}`}
                name={b.name}
                info={`${bb._repoName ?? ''} · ${ageDays}d stale · -${b.behind} behind main`}
                nameColor="var(--amber)"
                checked={selected.has(b.name)}
                onToggle={toggleSelect}
                checkAccent="var(--indigo)"
              />
            );
          })}
        </CleanupSection>

        {/* Git maintenance suggestions */}
        <CleanupSection title="GIT MAINTENANCE" count={0} countColor="var(--indigo-l)" label="suggested">
          <CleanupItem
            name="git gc --auto"
            info="all repos · pack objects & prune loose refs"
            nameColor="var(--indigo-l)"
            checked={false}
            onToggle={() => {}}
            checkAccent="var(--indigo)"
          />
          <CleanupItem
            name="git remote prune origin"
            info="all repos · remove stale remote-tracking refs"
            nameColor="var(--indigo-l)"
            checked={false}
            onToggle={() => {}}
            checkAccent="var(--indigo)"
          />
        </CleanupSection>

        <div style={{
          padding: '9px 12px',
          background: 'var(--red-bg)',
          border: '1px solid #f8717128',
          borderRadius: 'var(--r)',
          fontSize: 11,
          color: 'var(--red)',
          marginTop: 8,
        }}>
          ⚠ 削除操作は確認ダイアログ後に実行。マージ済みブランチは reflog 経由で 30 日間復元可能。
        </div>
      </div>

      {confirmOpen && (
        <ConfirmDialog
          title="dsx repo cleanup — confirm"
          message={`Preview output:\n\n${previewOut}\n\nProceed?`}
          confirmLabel="Execute cleanup"
          onConfirm={handleExecute}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}

function CleanupSection({
  title,
  count,
  countColor,
  label,
  children,
}: {
  title: string;
  count: number;
  countColor: string;
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', letterSpacing: '.08em' }}>
          {title}
        </span>
        <span style={{
          fontSize: 10, padding: '2px 8px', borderRadius: 10,
          background: `${countColor}18`, color: countColor,
        }}>
          {label ?? `${count} branches`}
        </span>
      </div>
      {children}
    </div>
  );
}

function CleanupItem({
  name,
  info,
  nameColor,
  checked,
  onToggle,
  checkAccent,
}: {
  name: string;
  info: string;
  nameColor: string;
  checked: boolean;
  onToggle: (name: string) => void;
  checkAccent: string;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '7px 10px', background: 'var(--bg3)',
      border: '1px solid var(--border)', borderRadius: 'var(--r)',
      marginBottom: 4,
    }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={() => onToggle(name)}
        style={{ accentColor: checkAccent, cursor: 'pointer', width: 13, height: 13 }}
      />
      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: 11, flex: 1,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        color: nameColor,
      }}>
        {name}
      </span>
      <span style={{ fontSize: 10, color: 'var(--text3)', flexShrink: 0 }}>{info}</span>
    </div>
  );
}
