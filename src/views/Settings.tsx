import { useEffect, useState } from 'react';
import { useUiStore } from '../stores/uiStore';
import { useRepoStore } from '../stores/repoStore';
import AppBar, { AppBtn } from '../components/AppBar';
import ConfirmDialog from '../components/ConfirmDialog';
import { getConfig, addRepository, removeRepository, scanMissingRepositories, updateSettings } from '../lib/invoke';
import { open } from '@tauri-apps/plugin-dialog';
import { rescan } from '../lib/rescanAfterRun';
import type { AppConfig, RepoConfig, RepoSource } from '../types';

export default function Settings() {
  const { addToast } = useUiStore();
  const { repos } = useRepoStore();
  const [config, setConfig]       = useState<AppConfig | null>(null);

  // 削除済みリポジトリ検出
  const [missingRepos, setMissingRepos] = useState<RepoConfig[]>([]);
  const [missingSelected, setMissingSelected] = useState<Set<string>>(new Set());
  const [missingPanelOpen, setMissingPanelOpen] = useState(false);
  const [confirmDeregister, setConfirmDeregister] = useState(false);
  const [deregistering, setDeregistering] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getConfig().then((cfg) => {
      if (cancelled) return;
      setConfig(cfg);
    }).catch((e) => addToast(String(e), 'error'));
    scanMissingRepositories()
      .then((missing) => { if (!cancelled) setMissingRepos(missing); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const handleAddRepo = async () => {
    const selected = await open({ directory: true, multiple: false, title: 'Select git repository' });
    if (!selected) return;
    const path = typeof selected === 'string' ? selected : selected[0];
    const name = path.split(/[\\/]/).pop() ?? path;
    try {
      const updated = await addRepository({ path, name });
      setConfig(updated);
      await rescan();
      addToast(`Added: ${name}`, 'success');
    } catch (e) {
      addToast(String(e), 'error');
    }
  };

  const saveWorkspaceRoot = async (root: string) => {
    try {
      const updated = await updateSettings({ workspaceRoot: root });
      setConfig(updated);
      await rescan();
      addToast(root ? 'Workspace root を更新しました' : '自動検出を無効にしました', 'success');
    } catch (e) {
      addToast(String(e), 'error');
    }
  };

  const handleChangeWorkspaceRoot = async () => {
    const selected = await open({ directory: true, multiple: false, title: 'Workspace のルートフォルダを選択' });
    if (!selected) return;
    await saveWorkspaceRoot(typeof selected === 'string' ? selected : selected[0]);
  };

  const handleRemoveRepo = async (path: string) => {
    try {
      const updated = await removeRepository(path);
      setConfig(updated);
      setMissingRepos((prev) => prev.filter((r) => r.path !== path));
      await rescan();
      addToast('Repository removed', 'success');
    } catch (e) {
      addToast(String(e), 'error');
    }
  };

  const handleBulkDeregister = async () => {
    if (deregistering) return;
    setDeregistering(true);
    const paths = [...missingSelected];
    const removedPaths = new Set<string>();
    let lastConfig: AppConfig | null = null;
    for (const path of paths) {
      try {
        lastConfig = await removeRepository(path);
        removedPaths.add(path);
      } catch (e) {
        addToast(String(e), 'error');
      }
    }
    if (lastConfig) setConfig(lastConfig);
    // 成功した path のみ missingRepos から除外する（失敗分は残す）
    setMissingRepos((prev) => prev.filter((r) => !removedPaths.has(r.path)));
    setMissingSelected(new Set());
    setMissingPanelOpen(false);
    setConfirmDeregister(false);
    setDeregistering(false);
    await rescan();
    if (removedPaths.size > 0) addToast(`${removedPaths.size} 件のリポジトリを登録解除しました`, 'success');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <AppBar
        path={<span style={{ color: 'var(--text2)' }}>Settings</span>}
      />

      <div style={{ flex: 1, overflowY: 'auto' }}>
      <div style={{ padding: 24, maxWidth: 680 }}>

        {/* Workspace */}
        <section style={{ marginBottom: 32 }}>
          <SectionTitle>Workspace</SectionTitle>
          <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10, lineHeight: 1.65 }}>
            root 直下（深さ 1）の git リポジトリを、自動で一覧に加えます。dsx の repo.root と同じ規則です。
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              flex: 1,
              minWidth: 0,
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: config?.workspace.root ? 'var(--text1)' : 'var(--text3)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {config?.workspace.root || '（自動検出は無効）'}
            </span>
            <AppBtn onClick={handleChangeWorkspaceRoot}>Change…</AppBtn>
            {config?.workspace.root && (
              <AppBtn onClick={() => saveWorkspaceRoot('')}>Disable</AppBtn>
            )}
          </div>
        </section>

        {/* Repositories */}
        <section style={{ marginBottom: 32 }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', letterSpacing: '.12em', flex: 1 }}>
              REPOSITORIES
            </div>
            <AppBtn variant="primary" onClick={handleAddRepo} title="Workspace root の外にあるリポジトリを追加します">+ Add Repository</AppBtn>
          </div>

          {/* 削除済みリポジトリ検出バナー (#117) */}
          {missingRepos.length > 0 && (
            <div
              role="button"
              tabIndex={0}
              onClick={() => setMissingPanelOpen((v) => !v)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setMissingPanelOpen((v) => !v)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 14px',
                background: 'var(--amber-bg)',
                border: '1px solid #fbbf2425',
                borderRadius: 'var(--r)',
                marginBottom: 10,
                cursor: 'pointer',
              }}
            >
              <span style={{ fontSize: 12, color: 'var(--amber)', flex: 1 }}>
                ⚠ {missingRepos.length} 件の無効なリポジトリを検出
              </span>
              <span style={{ fontSize: 11, color: 'var(--text3)' }}>
                {missingPanelOpen ? '▲' : '▼'}
              </span>
            </div>
          )}

          {/* 削除済みリポジトリ選択パネル */}
          {missingPanelOpen && missingRepos.length > 0 && (
            <div style={{
              background: 'var(--bg3)',
              border: '1px solid var(--border2)',
              borderRadius: 'var(--r2)',
              padding: '14px 16px',
              marginBottom: 12,
            }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text1)', marginBottom: 4 }}>
                ディスク上に存在しないリポジトリ
              </div>
              <div style={{ fontSize: 10, color: 'var(--text3)', marginBottom: 10 }}>
                config から削除するリポジトリを選択してください。ディスク上のファイルは削除されません。
              </div>
              <div style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
                <button
                  style={{ fontSize: 11, color: 'var(--text3)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                  onClick={() => setMissingSelected(new Set(missingRepos.map((r) => r.path)))}
                >
                  全選択
                </button>
                <button
                  style={{ fontSize: 11, color: 'var(--text3)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                  onClick={() => setMissingSelected(new Set())}
                >
                  全解除
                </button>
              </div>
              <div style={{ maxHeight: 200, overflowY: 'auto', marginBottom: 10 }}>
                {missingRepos.map((r) => {
                  const checked = missingSelected.has(r.path);
                  return (
                    <label
                      key={r.path}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 2px', cursor: 'pointer', fontSize: 12 }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          setMissingSelected((prev) => {
                            const next = new Set(prev);
                            checked ? next.delete(r.path) : next.add(r.path);
                            return next;
                          });
                        }}
                      />
                      <span style={{ color: 'var(--text1)', fontWeight: 600 }}>{r.name}</span>
                      <span style={{ flex: 1, minWidth: 0, color: 'var(--text3)', fontFamily: 'var(--font-mono)', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.path}
                      </span>
                    </label>
                  );
                })}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <AppBtn onClick={() => { setMissingPanelOpen(false); setMissingSelected(new Set()); }}>
                  Close
                </AppBtn>
                <AppBtn
                  variant="danger"
                  onClick={() => setConfirmDeregister(true)}
                  disabled={missingSelected.size === 0}
                >
                  {missingSelected.size} 件を登録解除
                </AppBtn>
              </div>
            </div>
          )}

          {repos.map((r) => (
            <RepoCard
              key={r.path}
              repo={r}
              onRemove={handleRemoveRepo}
            />
          ))}
          {repos.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text3)' }}>
              No repositories found. Workspace root を設定するか、リポジトリを追加してください。
            </div>
          )}
        </section>

      </div>
      </div>

      {confirmDeregister && (
        <ConfirmDialog
          title="リポジトリの登録解除"
          message={`以下の ${missingSelected.size} 件のリポジトリを config から削除します。\nディスク上のファイルは削除されません。\n\n${[...missingSelected].map((p) => missingRepos.find((r) => r.path === p)?.name ?? p).join('\n')}`}
          confirmLabel={deregistering ? '削除中…' : '登録解除'}
          onConfirm={handleBulkDeregister}
          onCancel={() => setConfirmDeregister(false)}
        />
      )}
    </div>
  );
}

function RepoCard({
  repo,
  onRemove,
}: {
  repo: { path: string; name: string; source: RepoSource };
  onRemove: (path: string) => void;
}) {
  const auto = repo.source === 'workspace';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 14px', background: 'var(--bg3)',
      border: '1px solid var(--border)', borderRadius: 'var(--r)',
      marginBottom: 6,
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text1)' }}>
          {repo.name}
          <span
            title={auto ? 'Workspace root から自動検出' : 'Workspace root の外から手動で追加'}
            style={{ marginLeft: 8, fontSize: 9, fontWeight: 500, color: 'var(--text3)', border: '1px solid var(--border2)', borderRadius: 4, padding: '1px 5px' }}
          >
            {auto ? 'auto' : 'manual'}
          </span>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>{repo.path}</div>
      </div>
      {!auto && (
        <AppBtn variant="danger" onClick={() => onRemove(repo.path)}>Remove</AppBtn>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 600, color: 'var(--text3)',
      letterSpacing: '.12em', marginBottom: 12,
    }}>
      {children}
    </div>
  );
}
