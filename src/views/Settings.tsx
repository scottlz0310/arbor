import { useEffect, useState } from 'react';
import { useUiStore } from '../stores/uiStore';
import { useRepoStore } from '../stores/repoStore';
import AppBar, { AppBtn } from '../components/AppBar';
import { getConfig, addRepository, removeRepository, dsxCheck, hasGithubPat, setGithubPat, deleteGithubPat } from '../lib/invoke';
import { open } from '@tauri-apps/plugin-dialog';
import type { AppConfig, DsxStatus } from '../types';

export default function Settings() {
  const { addToast } = useUiStore();
  const { loadRepos } = useRepoStore();
  const [config, setConfig]       = useState<AppConfig | null>(null);
  const [dsxStatus, setDsxStatus] = useState<DsxStatus | null>(null);
  const [patStored, setPatStored] = useState<boolean | null>(null);
  const [patInput, setPatInput]   = useState('');
  const [patLoading, setPatLoading] = useState(false);

  useEffect(() => {
    getConfig().then(setConfig).catch((e) => addToast(String(e), 'error'));
    dsxCheck().then(setDsxStatus).catch(() => setDsxStatus({ available: false, version: null, path: null }));
    hasGithubPat().then(setPatStored).catch(() => setPatStored(false));
  }, []);

  const handleAddRepo = async () => {
    const selected = await open({ directory: true, multiple: false, title: 'Select git repository' });
    if (!selected) return;
    const path = typeof selected === 'string' ? selected : selected[0];
    const name = path.split(/[\\/]/).pop() ?? path;
    try {
      const updated = await addRepository({ path, name });
      setConfig(updated);
      await loadRepos();
      addToast(`Added: ${name}`, 'success');
    } catch (e) {
      addToast(String(e), 'error');
    }
  };

  const handleSavePat = async () => {
    const trimmed = patInput.trim();
    if (!trimmed) return;
    setPatLoading(true);
    try {
      await setGithubPat(trimmed);
      setPatStored(true);
      setPatInput('');
      addToast('GitHub PAT を保存しました', 'success');
    } catch (e) {
      addToast(String(e), 'error');
    } finally {
      setPatLoading(false);
    }
  };

  const handleClearPat = async () => {
    setPatLoading(true);
    try {
      await deleteGithubPat();
      setPatStored(false);
      addToast('GitHub PAT を削除しました', 'success');
    } catch (e) {
      addToast(String(e), 'error');
    } finally {
      setPatLoading(false);
    }
  };

  const handleRemoveRepo = async (path: string) => {
    try {
      const updated = await removeRepository(path);
      setConfig(updated);
      await loadRepos();
      addToast('Repository removed', 'success');
    } catch (e) {
      addToast(String(e), 'error');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <AppBar
        path={<span style={{ color: 'var(--text2)' }}>Settings</span>}
        actions={<AppBtn variant="primary" onClick={handleAddRepo}>+ Add Repository</AppBtn>}
      />

      <div style={{ flex: 1, overflowY: 'auto', padding: 24, maxWidth: 680 }}>

        {/* dsx status */}
        <section style={{ marginBottom: 32 }}>
          <SectionTitle>dsx CLI</SectionTitle>
          {dsxStatus ? (
            dsxStatus.available ? (
              <div style={{ fontSize: 12, color: 'var(--green)' }}>
                ✓ dsx {dsxStatus.version} &nbsp;·&nbsp;
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text3)' }}>
                  {dsxStatus.path}
                </span>
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

        {/* GitHub PAT */}
        <section style={{ marginBottom: 32 }}>
          <SectionTitle>GitHub</SectionTitle>
          <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10, lineHeight: 1.65 }}>
            Personal Access Token (PAT) を OS キーチェーンに保存します。
            PR / Issue 連携は Phase 2 で有効になります。
          </div>
          {patStored && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              marginBottom: 10, fontSize: 12, color: 'var(--green)',
            }}>
              <span>✓ PAT が保存されています</span>
              <AppBtn variant="danger" onClick={handleClearPat} disabled={patLoading}>
                Clear
              </AppBtn>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="password"
              placeholder={patStored ? '新しい PAT で上書き…' : 'ghp_xxxxxxxxxxxx'}
              value={patInput}
              onChange={(e) => setPatInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSavePat()}
              style={{
                flex: 1,
                background: 'var(--bg3)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r)',
                color: 'var(--text1)',
                fontSize: 12,
                fontFamily: 'var(--font-mono)',
                padding: '6px 10px',
                outline: 'none',
              }}
            />
            <AppBtn variant="primary" onClick={handleSavePat} disabled={patLoading || !patInput.trim()}>
              Save
            </AppBtn>
          </div>
        </section>

        {/* Repositories */}
        <section style={{ marginBottom: 32 }}>
          <SectionTitle>Repositories</SectionTitle>
          {config?.repositories.map((r) => (
            <div
              key={r.path}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '10px 14px', background: 'var(--bg3)',
                border: '1px solid var(--border)', borderRadius: 'var(--r)',
                marginBottom: 6,
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text1)' }}>{r.name}</div>
                <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>
                  {r.path}
                </div>
              </div>
              <AppBtn variant="danger" onClick={() => handleRemoveRepo(r.path)}>Remove</AppBtn>
            </div>
          ))}
          {config?.repositories.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text3)' }}>
              No repositories registered. Click "+ Add Repository" to get started.
            </div>
          )}
        </section>

        {/* AI config summary */}
        <section>
          <SectionTitle>AI Engine (Phase 3)</SectionTitle>
          <div style={{ fontSize: 12, color: 'var(--text3)', lineHeight: 1.75 }}>
            <div>Provider &nbsp;— {config?.ai.provider ?? '—'}</div>
            <div>Model &nbsp;&nbsp;&nbsp;&nbsp;— <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--indigo-l)' }}>{config?.ai.model ?? '—'}</span></div>
            <div>URL &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;— <span style={{ fontFamily: 'var(--font-mono)' }}>{config?.ai.ollama_url ?? '—'}</span></div>
            <div style={{ marginTop: 8, color: 'var(--text4)' }}>Full AI settings UI is available in Phase 3.</div>
          </div>
        </section>

      </div>
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
