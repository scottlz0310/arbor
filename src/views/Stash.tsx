import { useEffect, useState } from 'react';
import { useRepoStore } from '../stores/repoStore';
import { useUiStore } from '../stores/uiStore';
import AppBar from '../components/AppBar';
import ConfirmDialog from '../components/ConfirmDialog';
import { listStashes, applyStash, dropStash } from '../lib/invoke';
import type { StashInfo } from '../types';

export default function Stash() {
  const { selectedRepo, loadRepos } = useRepoStore();
  const { addToast } = useUiStore();

  const [stashes, setStashes] = useState<StashInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [dropTarget, setDropTarget] = useState<StashInfo | null>(null);
  const [dropping, setDropping] = useState(false);
  const [applyingIndex, setApplyingIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!selectedRepo) {
      setStashes([]);
      return;
    }
    let cancelled = false;
    const repoPath = selectedRepo.path;
    setLoading(true);
    listStashes(repoPath)
      .then((items) => { if (!cancelled) setStashes(items); })
      .catch((e) => { if (!cancelled) addToast(String(e), 'error'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selectedRepo?.path]);

  const handleApply = async (stash: StashInfo) => {
    if (!selectedRepo || applyingIndex !== null) return;
    setApplyingIndex(stash.index);
    try {
      await applyStash(selectedRepo.path, stash.index);
      addToast(`stash@{${stash.index}} を適用しました`, 'success');
      const [items] = await Promise.all([
        listStashes(selectedRepo.path),
        loadRepos(),
      ]);
      setStashes(items);
    } catch (e) {
      addToast(String(e), 'error');
    } finally {
      setApplyingIndex(null);
    }
  };

  const handleDrop = async () => {
    if (!selectedRepo || !dropTarget || dropping) return;
    setDropping(true);
    const target = dropTarget;
    try {
      await dropStash(selectedRepo.path, target.index);
      addToast(`stash@{${target.index}} を削除しました`, 'success');
      const [items] = await Promise.all([
        listStashes(selectedRepo.path),
        loadRepos(),
      ]);
      setStashes(items);
    } catch (e) {
      addToast(String(e), 'error');
    } finally {
      setDropping(false);
      setDropTarget(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <AppBar
        path={selectedRepo
          ? <><span style={{ color: 'var(--text2)' }}>{selectedRepo.name}</span> · {stashes.length} stash{stashes.length !== 1 ? 'es' : ''}</>
          : 'No repository selected'
        }
      />

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 16px' }}>
        {!selectedRepo ? (
          <div style={{ padding: 24, color: 'var(--text3)', fontSize: 12 }}>
            サイドバーからリポジトリを選択してください
          </div>
        ) : loading ? (
          <div style={{ padding: 24, color: 'var(--text3)', fontSize: 12 }}>Loading…</div>
        ) : stashes.length === 0 ? (
          <div style={{ padding: 24, color: 'var(--text3)', fontSize: 12 }}>
            スタッシュはありません
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['INDEX', 'MESSAGE', 'COMMIT', ''].map((h) => (
                  <th key={h} style={{
                    fontSize: 10, fontWeight: 600, color: 'var(--text3)',
                    letterSpacing: '.08em', textAlign: 'left',
                    padding: '10px 8px', borderBottom: '1px solid var(--border2)',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stashes.map((s) => (
                <StashRow
                  key={s.index}
                  stash={s}
                  applying={applyingIndex === s.index}
                  anyApplying={applyingIndex !== null}
                  onApply={handleApply}
                  onDrop={setDropTarget}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {dropTarget && (
        <ConfirmDialog
          title="スタッシュを削除しますか？"
          message={`stash@{${dropTarget.index}}: ${dropTarget.message}\n\nこの操作は取り消せません。`}
          confirmLabel="削除"
          confirmDisabled={dropping}
          onConfirm={handleDrop}
          onCancel={() => !dropping && setDropTarget(null)}
        />
      )}
    </div>
  );
}

function StashRow({
  stash,
  applying,
  anyApplying,
  onApply,
  onDrop,
}: {
  stash: StashInfo;
  applying: boolean;
  anyApplying: boolean;
  onApply: (s: StashInfo) => void;
  onDrop: (s: StashInfo) => void;
}) {
  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}>
      <td style={{ padding: '8px', width: 60 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text3)' }}>
          stash@{'{'}{ stash.index}{'}'}
        </span>
      </td>
      <td style={{ padding: '8px', fontSize: 12, color: 'var(--text1)', maxWidth: 360,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {stash.message}
      </td>
      <td style={{ padding: '8px' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text3)' }}>
          {stash.commit_id.slice(0, 7)}
        </span>
      </td>
      <td style={{ padding: '8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
        <button
          onClick={() => onApply(stash)}
          disabled={anyApplying}
          style={{
            fontSize: 10, padding: '3px 10px', borderRadius: 4,
            cursor: anyApplying ? 'not-allowed' : 'pointer',
            background: 'var(--green-bg)', color: 'var(--green)',
            border: '1px solid var(--green)', marginRight: 6,
            opacity: anyApplying ? 0.5 : 1,
          }}
        >
          {applying ? '…' : 'Apply'}
        </button>
        <button
          onClick={() => onDrop(stash)}
          disabled={anyApplying}
          style={{
            fontSize: 10, padding: '3px 10px', borderRadius: 4,
            cursor: anyApplying ? 'not-allowed' : 'pointer',
            background: 'var(--red-bg)', color: 'var(--red)',
            border: '1px solid var(--red)',
            opacity: anyApplying ? 0.5 : 1,
          }}
        >
          Drop
        </button>
      </td>
    </tr>
  );
}
