import { useEffect, useState } from 'react';
import { useRepoStore } from '../stores/repoStore';
import { useUiStore } from '../stores/uiStore';
import AppBar, { AppBtn } from '../components/AppBar';
import ConfirmDialog from '../components/ConfirmDialog';
import { getBranches, repoCleanupPreview, repoCleanup, deleteBranches } from '../lib/invoke';
import type { BranchInfo } from '../types';

// Composite key: uses null byte as separator (safe on all OS — never appears in paths or branch names)
const SEP = '\x00';
const makeKey = (repoPath: string, name: string) => `${repoPath}${SEP}${name}`;

type ConfirmType = 'dsx' | 'delete' | null;

export default function Cleanup() {
  const { repos, selectedRepo } = useRepoStore();
  const { addToast, setDsxRunning } = useUiStore();

  const [mergedBranches, setMergedBranches]     = useState<(BranchInfo & { _repoName: string; _repoPath: string })[]>([]);
  const [staleBranches, setStaleBranches]       = useState<(BranchInfo & { _repoName: string; _repoPath: string })[]>([]);
  const [selected, setSelected]                 = useState<Set<string>>(new Set());
  const [confirmType, setConfirmType]           = useState<ConfirmType>(null);
  const [previewOut, setPreviewOut]             = useState('');
  const [loading, setLoading]                   = useState(false);

  const staleThreshold = 14 * 86400;
  const nowSec = Math.floor(Date.now() / 1000);

  // Load branches — scoped to selectedRepo if set, otherwise all repos.
  useEffect(() => {
    const targets = selectedRepo ? repos.filter((r) => r.path === selectedRepo.path) : repos;
    if (targets.length === 0) {
      setMergedBranches([]);
      setStaleBranches([]);
      return;
    }
    setLoading(true);
    Promise.all(
      targets.map((r) =>
        getBranches(r.path).then((branches) =>
          branches.map((b) => ({ ...b, _repoName: r.name, _repoPath: r.path }))
        )
      )
    )
      .then((allBranches) => {
        const flat = allBranches.flat();
        setMergedBranches(flat.filter((b) => (b.is_merged || b.is_squash_merged) && !b.is_current));
        setStaleBranches(flat.filter(
          (b) => !b.is_merged && !b.is_squash_merged && !b.is_current
            && nowSec - b.last_commit_ts > staleThreshold
        ));
      })
      .catch((e) => addToast(String(e), 'error'))
      .finally(() => setLoading(false));
  }, [repos, selectedRepo]);

  const toggleSelect = (repoPath: string, name: string) =>
    setSelected((s) => {
      const key = makeKey(repoPath, name);
      const n = new Set(s);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });

  const handleDsxPreviewAndConfirm = async () => {
    if (!selectedRepo) {
      addToast('Select a repository first', 'error');
      return;
    }
    try {
      const out = await repoCleanupPreview(selectedRepo.path);
      setPreviewOut(out.stdout || '(no output)');
      setConfirmType('dsx');
    } catch (e) {
      addToast(String(e), 'error');
    }
  };

  const handleDeleteSelectedWithConfirm = () => {
    const branchNames = [...selected].map((k) => k.slice(k.indexOf(SEP) + 1));
    setPreviewOut(branchNames.join('\n'));
    setConfirmType('delete');
  };

  const handleExecute = async () => {
    if (confirmType === 'dsx') {
      if (!selectedRepo) return;
      setConfirmType(null);
      setDsxRunning(true);
      try {
        await repoCleanup(selectedRepo.path);
        addToast('Cleanup complete', 'success');
      } catch (e) {
        addToast(String(e), 'error');
      } finally {
        setDsxRunning(false);
      }
    } else if (confirmType === 'delete') {
      setConfirmType(null);
      setDsxRunning(true);
      try {
        // Group selected branches by repo path.
        const byRepo = new Map<string, string[]>();
        for (const key of selected) {
          const sep = key.indexOf(SEP);
          const repoPath = key.slice(0, sep);
          const branchName = key.slice(sep + 1);
          if (!byRepo.has(repoPath)) byRepo.set(repoPath, []);
          byRepo.get(repoPath)!.push(branchName);
        }
        let totalFailed = 0;
        for (const [repoPath, branchNames] of byRepo) {
          const results = await deleteBranches(repoPath, branchNames);
          totalFailed += results.filter((r) => !r.success).length;
        }
        if (totalFailed > 0) {
          addToast(`${totalFailed} branch(es) failed to delete`, 'error');
        } else {
          addToast(`${selected.size} branch(es) deleted`, 'success');
        }
        setSelected(new Set());
        // Reload branch lists (same scope as the initial load).
        const targets = selectedRepo ? repos.filter((r) => r.path === selectedRepo.path) : repos;
        const updated = await Promise.all(
          targets.map((r) =>
            getBranches(r.path).then((branches) =>
              branches.map((b) => ({ ...b, _repoName: r.name, _repoPath: r.path }))
            )
          )
        );
        const flat = updated.flat();
        setMergedBranches(flat.filter((b) => (b.is_merged || b.is_squash_merged) && !b.is_current));
        setStaleBranches(flat.filter(
          (b) => !b.is_merged && !b.is_squash_merged && !b.is_current
            && nowSec - b.last_commit_ts > staleThreshold
        ));
      } catch (e) {
        addToast(String(e), 'error');
      } finally {
        setDsxRunning(false);
      }
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
              <AppBtn variant="danger" onClick={handleDeleteSelectedWithConfirm}>
                Delete selected ({selected.size})
              </AppBtn>
            )}
            <AppBtn variant="danger" onClick={handleDsxPreviewAndConfirm}>
              dsx cleanup{selectedRepo ? ` (${selectedRepo.name})` : ''}
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
          {mergedBranches.map((b) => (
            <CleanupItem
              key={makeKey(b._repoPath, b.name)}
              name={b.name}
              info={`${b._repoName} · merged ${formatAge(b.last_commit_ts)} ago`}
              nameColor="var(--green)"
              checked={selected.has(makeKey(b._repoPath, b.name))}
              onToggle={() => toggleSelect(b._repoPath, b.name)}
              checkAccent="var(--red)"
            />
          ))}
        </CleanupSection>

        {/* Stale branches */}
        <CleanupSection
          title={`STALE BRANCHES (> 14 days)`}
          count={staleBranches.length}
          countColor="var(--amber)"
        >
          {staleBranches.map((b) => {
            const ageDays = Math.floor((nowSec - b.last_commit_ts) / 86400);
            return (
              <CleanupItem
                key={makeKey(b._repoPath, b.name)}
                name={b.name}
                info={`${b._repoName} · ${ageDays}d stale · -${b.behind} behind main`}
                nameColor="var(--amber)"
                checked={selected.has(makeKey(b._repoPath, b.name))}
                onToggle={() => toggleSelect(b._repoPath, b.name)}
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

      {confirmType !== null && (
        <ConfirmDialog
          title={confirmType === 'dsx' ? 'dsx repo cleanup — confirm' : `Delete ${selected.size} branch(es)?`}
          message={
            confirmType === 'dsx'
              ? `Preview output:\n\n${previewOut}\n\nProceed?`
              : `Following branches will be deleted:\n\n${previewOut}\n\nProceed?`
          }
          confirmLabel={confirmType === 'dsx' ? 'Execute cleanup' : 'Delete branches'}
          onConfirm={handleExecute}
          onCancel={() => setConfirmType(null)}
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
  onToggle: () => void;
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
        onChange={onToggle}
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
