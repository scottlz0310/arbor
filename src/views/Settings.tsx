import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useUiStore } from '../stores/uiStore';
import { useRepoStore } from '../stores/repoStore';
import AppBar, { AppBtn } from '../components/AppBar';
import { getConfig, addRepository, removeRepository, updateRepositoryGithub, detectGithubRemote, dsxCheck, hasGithubPat, setGithubPat, deleteGithubPat, sysUpdate } from '../lib/invoke';
import { open } from '@tauri-apps/plugin-dialog';
import type { AppConfig, DsxStatus, RepoConfig } from '../types';

export default function Settings() {
  const queryClient = useQueryClient();
  const { addToast } = useUiStore();
  const { loadRepos } = useRepoStore();
  const [config, setConfig]       = useState<AppConfig | null>(null);
  const [dsxStatus, setDsxStatus] = useState<DsxStatus | null>(null);
  const [patStored, setPatStored] = useState<boolean | null>(null);
  const [patInput, setPatInput]   = useState('');
  const [patLoading, setPatLoading] = useState(false);
  const [sysUpdating, setSysUpdating] = useState(false);

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
      queryClient.invalidateQueries({ queryKey: ['has_pat'] });
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
      queryClient.invalidateQueries({ queryKey: ['has_pat'] });
      addToast('GitHub PAT を削除しました', 'success');
    } catch (e) {
      addToast(String(e), 'error');
    } finally {
      setPatLoading(false);
    }
  };

  const handleSysUpdate = async () => {
    setSysUpdating(true);
    try {
      await sysUpdate();
      addToast('dsx sys update 完了', 'success');
      // バージョンを再取得して表示を更新する
      const status = await dsxCheck();
      setDsxStatus(status);
    } catch (e) {
      addToast(String(e), 'error');
    } finally {
      setSysUpdating(false);
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
      />

      <div style={{ flex: 1, overflowY: 'auto', padding: 24, maxWidth: 680 }}>

        {/* dsx status */}
        <section style={{ marginBottom: 32 }}>
          <SectionTitle>dsx CLI</SectionTitle>
          {dsxStatus ? (
            dsxStatus.available ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ fontSize: 12, color: 'var(--green)', flex: 1 }}>
                  ✓ dsx {dsxStatus.version} &nbsp;·&nbsp;
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text3)' }}>
                    {dsxStatus.path}
                  </span>
                </div>
                <AppBtn
                  onClick={handleSysUpdate}
                  disabled={sysUpdating}
                >
                  {sysUpdating ? 'Updating…' : 'Update'}
                </AppBtn>
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
            Personal Access Token (PAT) を保存します。PR / Issue 連携に使用されます。
          </div>
          {patStored === null && (
            <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10 }}>Checking…</div>
          )}
          {patStored === true && (
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
          {patStored === false && (
            <div style={{ fontSize: 12, color: 'var(--amber)', marginBottom: 10 }}>
              ⚠ PAT が設定されていません
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
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', letterSpacing: '.12em', flex: 1 }}>
              REPOSITORIES
            </div>
            <AppBtn variant="primary" onClick={handleAddRepo}>+ Add Repository</AppBtn>
          </div>
          {config?.repositories.map((r) => (
            <RepoCard
              key={r.path}
              repo={r}
              onRemove={handleRemoveRepo}
              onSaveGithub={async (path, owner, repo) => {
                try {
                  const updated = await updateRepositoryGithub({ path, githubOwner: owner || null, githubRepo: repo || null });
                  setConfig(updated);
                  addToast('GitHub 設定を保存しました', 'success');
                } catch (e) { addToast(String(e), 'error'); }
              }}
            />
          ))}
          {config?.repositories.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text3)' }}>
              No repositories registered.
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

function RepoCard({
  repo,
  onRemove,
  onSaveGithub,
}: {
  repo: RepoConfig;
  onRemove: (path: string) => void;
  onSaveGithub: (path: string, owner: string, repoName: string) => Promise<void>;
}) {
  const [owner, setOwner] = useState(repo.github_owner ?? '');
  const [repoName, setRepoName] = useState(repo.github_repo ?? '');
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);

  const dirty = owner !== (repo.github_owner ?? '') || repoName !== (repo.github_repo ?? '');

  const handleSave = async () => {
    setSaving(true);
    try { await onSaveGithub(repo.path, owner, repoName); }
    finally { setSaving(false); }
  };

  const handleDetect = async () => {
    setDetecting(true);
    try {
      const [detectedOwner, detectedRepo] = await detectGithubRemote(repo.path);
      if (detectedOwner) setOwner(detectedOwner);
      if (detectedRepo) setRepoName(detectedRepo);
    } finally {
      setDetecting(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg2)', border: '1px solid var(--border)',
    borderRadius: 'var(--r)', color: 'var(--text1)',
    fontSize: 11, fontFamily: 'var(--font-mono)',
    padding: '4px 8px', outline: 'none', width: '100%',
  };

  return (
    <div style={{
      padding: '10px 14px', background: 'var(--bg3)',
      border: '1px solid var(--border)', borderRadius: 'var(--r)',
      marginBottom: 6,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text1)' }}>{repo.name}</div>
          <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>{repo.path}</div>
        </div>
        <AppBtn onClick={handleDetect} disabled={detecting}>
          {detecting ? '…' : 'Detect'}
        </AppBtn>
        <AppBtn variant="danger" onClick={() => onRemove(repo.path)}>Remove</AppBtn>
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          style={inputStyle}
          placeholder="owner"
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && dirty && handleSave()}
        />
        <span style={{ color: 'var(--text3)', fontSize: 12 }}>/</span>
        <input
          style={inputStyle}
          placeholder="repo"
          value={repoName}
          onChange={(e) => setRepoName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && dirty && handleSave()}
        />
        <AppBtn variant="primary" onClick={handleSave} disabled={!dirty || saving}>
          {saving ? '…' : 'Save'}
        </AppBtn>
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
