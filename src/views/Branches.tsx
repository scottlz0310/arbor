import { useEffect, useState } from 'react';
import { useRepoStore } from '../stores/repoStore';
import { useUiStore } from '../stores/uiStore';
import AppBar, { AppBtn } from '../components/AppBar';
import ConfirmDialog from '../components/ConfirmDialog';
import { getBranches, deleteBranches } from '../lib/invoke';
import type { BranchInfo } from '../types';

type Filter = 'all' | 'merged' | 'stale';

export default function Branches() {
  const { selectedRepo, loadRepos } = useRepoStore();
  const { addToast } = useUiStore();

  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>('all');
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    if (!selectedRepo) return;
    setLoading(true);
    setSelected(new Set());
    getBranches(selectedRepo.path)
      .then(setBranches)
      .catch((e) => addToast(String(e), 'error'))
      .finally(() => setLoading(false));
  }, [selectedRepo]);

  const nowSec = Math.floor(Date.now() / 1000);
  const staleThreshold = 14 * 86400;

  const filtered = branches.filter((b) => {
    if (filter === 'merged') return b.is_merged || b.is_squash_merged;
    if (filter === 'stale')  return nowSec - b.last_commit_ts > staleThreshold && !b.is_current;
    return true;
  });

  const toggleSelect = (name: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name); else n.add(name);
      return n;
    });

  const handleDeleteSelected = async () => {
    if (!selectedRepo || selected.size === 0) return;
    setConfirmOpen(false);
    try {
      const results = await deleteBranches(selectedRepo.path, [...selected]);
      const failed = results.filter((r) => !r.success);
      if (failed.length > 0) {
        addToast(`${failed.length} branch(es) failed to delete`, 'error');
      } else {
        addToast(`${selected.size} branch(es) deleted`, 'success');
      }
      setSelected(new Set());
      const updated = await getBranches(selectedRepo.path);
      setBranches(updated);
      await loadRepos();
    } catch (e) {
      addToast(String(e), 'error');
    }
  };

  const formatAge = (ts: number) => {
    const diff = nowSec - ts;
    if (diff < 3600)   return `${Math.floor(diff / 60)}m`;
    if (diff < 86400)  return `${Math.floor(diff / 3600)}h`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d`;
    return `${Math.floor(diff / 604800)}w`;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <AppBar
        path={selectedRepo
          ? <><span style={{ color: 'var(--text2)' }}>{selectedRepo.name}</span> · {filtered.length} branches</>
          : 'No repository selected'
        }
        actions={
          <>
            {(['all', 'merged', 'stale'] as Filter[]).map((f) => (
              <AppBtn
                key={f}
                variant={filter === f ? 'primary' : 'default'}
                onClick={() => setFilter(f)}
                style={{ textTransform: 'capitalize' }}
              >
                {f}
              </AppBtn>
            ))}
            {selected.size > 0 && (
              <AppBtn variant="danger" onClick={() => setConfirmOpen(true)}>
                Delete selected ({selected.size})
              </AppBtn>
            )}
          </>
        }
      />

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 16px' }}>
        {loading ? (
          <div style={{ padding: 24, color: 'var(--text3)', fontSize: 12 }}>Loading…</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['', 'BRANCH', 'STATUS', '↑↓', 'LAST COMMIT', 'AGE'].map((h) => (
                  <th key={h} style={{
                    fontSize: 10, fontWeight: 600, color: 'var(--text3)',
                    letterSpacing: '.08em', textAlign: 'left',
                    padding: '10px 8px', borderBottom: '1px solid var(--border2)',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((b) => (
                <BranchRow
                  key={b.name}
                  branch={b}
                  checked={selected.has(b.name)}
                  onToggle={toggleSelect}
                  formatAge={formatAge}
                />
              ))}
            </tbody>
          </table>
        )}

        {selected.size > 0 && (
          <div style={{ marginTop: 10, fontSize: 10, color: 'var(--text3)' }}>
            {selected.size} selected &nbsp;·&nbsp;
            <span style={{ color: 'var(--red)' }}>削除前に確認ダイアログが表示されます</span>
          </div>
        )}
      </div>

      {confirmOpen && (
        <ConfirmDialog
          title={`Delete ${selected.size} branch(es)?`}
          message={`Following branches will be permanently deleted:\n${[...selected].join(', ')}`}
          confirmLabel="Delete"
          onConfirm={handleDeleteSelected}
          onCancel={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}

function BranchRow({
  branch: b,
  checked,
  onToggle,
  formatAge,
}: {
  branch: BranchInfo;
  checked: boolean;
  onToggle: (name: string) => void;
  formatAge: (ts: number) => string;
}) {
  const merged = b.is_merged || b.is_squash_merged;
  const color = b.is_current ? 'var(--green)' : merged ? 'var(--text3)' : 'var(--text1)';

  let badgeLabel = '';
  let badgeStyle: React.CSSProperties = {};
  if (b.is_current) {
    if (b.ahead > 0 && b.behind > 0) {
      badgeLabel = '⇕ diverged';
      badgeStyle = { background: 'var(--red-bg)', color: 'var(--red)' };
    } else if (b.ahead > 0) {
      badgeLabel = `↑ ahead ${b.ahead}`;
      badgeStyle = { background: 'var(--green-bg)', color: 'var(--green)' };
    } else if (b.behind > 0) {
      badgeLabel = `↓ behind ${b.behind}`;
      badgeStyle = { background: 'var(--purple-bg)', color: 'var(--purple)' };
    } else {
      badgeLabel = 'HEAD';
      badgeStyle = { background: '#1e2336', color: 'var(--green)' };
    }
  } else if (merged) {
    badgeLabel = '✓ merged';
    badgeStyle = { background: 'var(--green-bg)', color: 'var(--green)' };
  } else if (b.ahead > 0 && b.behind > 0) {
    badgeLabel = '⇕ diverged';
    badgeStyle = { background: 'var(--red-bg)', color: 'var(--red)' };
  } else if (b.ahead > 0) {
    badgeLabel = `↑ ahead ${b.ahead}`;
    badgeStyle = { background: 'var(--green-bg)', color: 'var(--green)' };
  } else if (b.behind > 0) {
    badgeLabel = `↓ behind ${b.behind}`;
    badgeStyle = { background: 'var(--purple-bg)', color: 'var(--purple)' };
  } else {
    badgeLabel = 'clean';
    badgeStyle = { background: '#1e2336', color: 'var(--text3)' };
  }

  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}>
      <td style={{ padding: '8px' }}>
        {!b.is_current && (
          <input
            type="checkbox"
            checked={checked}
            onChange={() => onToggle(b.name)}
            style={{ accentColor: 'var(--red)', cursor: 'pointer' }}
          />
        )}
      </td>
      <td style={{ padding: '8px' }}>
        <span style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color,
          opacity: merged && !b.is_current ? 0.55 : 1,
        }}>
          {b.name}
        </span>
        {b.is_current && (
          <span style={{
            fontSize: 9,
            background: 'var(--bg4)',
            color: 'var(--text3)',
            padding: '1px 6px',
            borderRadius: 3,
            marginLeft: 6,
            fontFamily: 'var(--font-mono)',
          }}>HEAD</span>
        )}
      </td>
      <td style={{ padding: '8px' }}>
        <span style={{
          fontSize: 10, fontWeight: 500, padding: '2px 8px',
          borderRadius: 4, display: 'inline-block', ...badgeStyle,
        }}>
          {badgeLabel}
        </span>
      </td>
      <td style={{
        padding: '8px',
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: b.ahead > 0 ? 'var(--green)' : b.behind > 0 ? 'var(--purple)' : 'var(--text3)',
      }}>
        {b.ahead > 0 ? `+${b.ahead}` : b.behind > 0 ? `-${b.behind}` : '—'}
      </td>
      <td style={{ padding: '8px', fontSize: 11, color: merged ? 'var(--text3)' : 'var(--text2)',
        maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {b.last_commit_msg}
      </td>
      <td style={{ padding: '8px', fontSize: 10, color: 'var(--text3)' }}>
        {formatAge(b.last_commit_ts)}
      </td>
    </tr>
  );
}
