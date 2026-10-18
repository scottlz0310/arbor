import { useEffect, useState } from 'react';
import { useUiStore } from '../stores/uiStore';
import { useRepoStore } from '../stores/repoStore';
import AppBar, { AppBtn } from '../components/AppBar';
import ConfirmDialog from '../components/ConfirmDialog';
import { getConfig, addRepository, removeRepository, scanMissingRepositories, updateSettings, dsxCheck, dsxLatestVersion, dsxSelfUpdate, sysUpdate } from '../lib/invoke';
import { open } from '@tauri-apps/plugin-dialog';
import { rescan } from '../lib/rescanAfterRun';
import type { AppConfig, DsxStatus, RepoConfig, RepoSource } from '../types';

export default function Settings() {
  const { addToast } = useUiStore();
  const { repos } = useRepoStore();
  const [config, setConfig]       = useState<AppConfig | null>(null);
  const [dsxStatus, setDsxStatus] = useState<DsxStatus | null>(null);
  const [sysUpdating, setSysUpdating] = useState(false);
  const [showSysUpdateConfirm, setShowSysUpdateConfirm] = useState(false);
  const [selfUpdating, setSelfUpdating] = useState(false);
  const [showSelfUpdateConfirm, setShowSelfUpdateConfirm] = useState(false);
  const [dsxUpdateState, setDsxUpdateState] = useState<'idle' | 'checking' | 'done' | 'error'>('idle');
  const [latestDsxVersion, setLatestDsxVersion] = useState<string | null>(null);

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
    dsxCheck().then(setDsxStatus).catch(() => setDsxStatus({ available: false, version: null, path: null, supports_run_root: false }));
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

  const handleCheckDsxUpdate = async () => {
    setDsxUpdateState('checking');
    setLatestDsxVersion(null);
    try {
      const latest = await dsxLatestVersion();
      setLatestDsxVersion(latest);
      setDsxUpdateState('done');
    } catch {
      setDsxUpdateState('error');
    }
  };

  const handleSysUpdate = async () => {
    setSysUpdating(true);
    try {
      await sysUpdate();
      addToast('dsx sys update 完了', 'success');
      // バージョンを再取得して表示を更新し、古い確認結果をリセットする
      const status = await dsxCheck();
      setDsxStatus(status);
      setDsxUpdateState('idle');
      setLatestDsxVersion(null);
    } catch (e) {
      addToast(String(e), 'error');
    } finally {
      setSysUpdating(false);
    }
  };

  const handleDsxSelfUpdate = async () => {
    setSelfUpdating(true);
    try {
      await dsxSelfUpdate();
      addToast('dsx self-update 完了', 'success');
      const status = await dsxCheck();
      setDsxStatus(status);
      setDsxUpdateState('idle');
      setLatestDsxVersion(null);
    } catch (e) {
      addToast(String(e), 'error');
    } finally {
      setSelfUpdating(false);
    }
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

      <div style={{ flex: 1, overflowY: 'auto', padding: 24, maxWidth: 680 }}>

        {/* dsx status */}
        <section style={{ marginBottom: 32 }}>
          <SectionTitle>dsx CLI</SectionTitle>
          {dsxStatus ? (
            dsxStatus.available ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ fontSize: 12, color: 'var(--green)', flex: 1 }}>
                    ✓ dsx {dsxStatus.version} &nbsp;·&nbsp;
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text3)' }}>
                      {dsxStatus.path}
                    </span>
                  </div>
                  <AppBtn
                    onClick={handleCheckDsxUpdate}
                    disabled={dsxUpdateState === 'checking'}
                  >
                    {dsxUpdateState === 'checking' ? '確認中…' : 'バージョン確認'}
                  </AppBtn>
                  <AppBtn
                    onClick={() => setShowSysUpdateConfirm(true)}
                    disabled={sysUpdating}
                    title="dsx sys update — dsx が管理するツール群を一括更新"
                  >
                    {sysUpdating ? 'Updating…' : 'Sys Update'}
                  </AppBtn>
                </div>
                {dsxUpdateState === 'done' && (
                  <DsxUpdateResult
                    current={dsxStatus.version ?? ''}
                    latest={latestDsxVersion}
                    selfUpdating={selfUpdating}
                    onSelfUpdate={() => setShowSelfUpdateConfirm(true)}
                  />
                )}
                {dsxUpdateState === 'error' && (
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                    バージョン情報を取得できませんでした
                  </div>
                )}
              </div>
            ) : (
              <div style={{
                padding: '12px 16px',
                background: 'var(--amber-bg)',
                border: '1px solid #fbbf2425',
                borderRadius: 'var(--r)',
                fontSize: 12,
                color: 'var(--amber)',
                lineHeight: 1.65,
              }}>
                ⚡ dsx が見つかりません。以下のコマンドでインストールしてください:<br />
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--indigo-l)', display: 'block', marginTop: 8 }}>
                  go install github.com/scottlz0310/dsx@latest
                </span>
                インストール後、Arbor を再起動してください。
              </div>
            )
          ) : (
            <div style={{ fontSize: 12, color: 'var(--text3)' }}>Checking…</div>
          )}
        </section>

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

      {showSelfUpdateConfirm && (
        <ConfirmDialog
          title="dsx self-update を実行しますか？"
          message={'dsx CLI 自体を最新版に更新します。\n完了まで少し時間がかかることがあります。'}
          confirmLabel="実行"
          onConfirm={() => { setShowSelfUpdateConfirm(false); handleDsxSelfUpdate(); }}
          onCancel={() => setShowSelfUpdateConfirm(false)}
        />
      )}

      {showSysUpdateConfirm && (
        <ConfirmDialog
          title="dsx sys update — システム全体の更新"
          message={'dsx が管理するすべてのツールを最新版に更新します（dsx CLI 自体の更新ではありません）。\n完了まで数分かかることがあります。'}
          confirmLabel="実行"
          onConfirm={() => { setShowSysUpdateConfirm(false); handleSysUpdate(); }}
          onCancel={() => setShowSysUpdateConfirm(false)}
        />
      )}

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

// "dsx v0.2.10" や "v0.3.0" から [major, minor, patch] を抽出する。
// 解析できない場合は null を返す。
function parseSemverLike(value: string): [number, number, number] | null {
  const m = value.match(/v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// a >= b なら正数または 0、a < b なら負数、比較不能なら null を返す。
export function compareSemverLike(a: string, b: string): number | null {
  const av = parseSemverLike(a);
  const bv = parseSemverLike(b);
  if (!av || !bv) return null;
  for (let i = 0; i < 3; i++) {
    if (av[i] !== bv[i]) return av[i] - bv[i];
  }
  return 0;
}

function DsxUpdateResult({
  current,
  latest,
  selfUpdating,
  onSelfUpdate,
}: {
  current: string;
  latest: string | null;
  selfUpdating: boolean;
  onSelfUpdate: () => void;
}) {
  if (!latest) {
    return (
      <div style={{ fontSize: 11, color: 'var(--text3)' }}>
        取得できませんでした。ネットワークまたは GitHub API を確認してください。
      </div>
    );
  }
  const cmp = compareSemverLike(current, latest);
  if (cmp === null) {
    return (
      <div style={{ fontSize: 11, color: 'var(--text3)' }}>
        バージョンを比較できませんでした（current: {current}, latest: {latest}）
      </div>
    );
  }
  return cmp >= 0 ? (
    <div style={{ fontSize: 11, color: 'var(--green)' }}>
      ✓ 最新版です（{latest}）
    </div>
  ) : (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ fontSize: 11, color: 'var(--amber)' }}>
        ↑ {latest} が利用可能です
      </div>
      <AppBtn onClick={onSelfUpdate} disabled={selfUpdating}>
        {selfUpdating ? 'Updating…' : 'Self Update'}
      </AppBtn>
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
