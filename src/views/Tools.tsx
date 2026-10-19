import { useState } from 'react';
import type { ReactNode } from 'react';
import { AppBtn } from '../components/AppBar';
import ConfirmDialog from '../components/ConfirmDialog';
import { compareSemverLike } from '../lib/dsxVersion';
import {
  runDoctor,
  runRepoUpdate,
  runSelfUpdate,
  runSysUpdate,
  runSysUpdateDryRun,
  shortVersion,
} from '../lib/dsxActions';
import { dsxLatestVersion } from '../lib/invoke';
import { useConsoleStore } from '../stores/consoleStore';
import { useEnvStore } from '../stores/envStore';

/** MSIX 版の dsx は `dsx self-update` では更新されない（.appinstaller による自動更新）。公式のインストーラで更新する。 */
const MSIX_UPDATE_COMMAND =
  'iex ([Text.Encoding]::UTF8.GetString((iwr -UseBasicParsing https://github.com/scottlz0310/dsx/releases/latest/download/install.ps1).Content))';

type Confirming = 'sys-update' | 'self-update' | null;
type LatestCheck =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'done'; latest: string | null }
  | { state: 'error' };

interface ToolAction {
  title: string;
  command: string;
  description: string;
  button: string;
  run: () => void;
}

export default function Tools() {
  const dsx = useEnvStore((s) => s.dsx);
  const busy = useConsoleStore((s) => s.run?.status === 'running');
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [latestCheck, setLatestCheck] = useState<LatestCheck>({ state: 'idle' });
  // self-update を実行したのに版が上がらなかった（MSIX 版など）
  const [selfUpdateStalled, setSelfUpdateStalled] = useState(false);

  const available = dsx?.available ?? false;
  const disabled = busy || !available;

  const checkLatest = async () => {
    setLatestCheck({ state: 'checking' });
    setSelfUpdateStalled(false);
    try {
      setLatestCheck({ state: 'done', latest: await dsxLatestVersion() });
    } catch {
      setLatestCheck({ state: 'error' });
    }
  };

  const selfUpdate = async () => {
    const succeeded = await runSelfUpdate();
    if (!succeeded) return;
    // 版を取り直し、上がっていなければ手順を案内する。確認済みの最新版は、更新後は古くなりうるので引き続き使う。
    await useEnvStore.getState().refresh();
    const current = useEnvStore.getState().dsx?.version ?? '';
    const latest = latestCheck.state === 'done' ? latestCheck.latest : null;
    setSelfUpdateStalled(latest !== null && (compareSemverLike(current, latest) ?? 0) < 0);
  };

  const actions: ToolAction[] = [
    {
      title: 'Update All Tools',
      command: 'dsx sys update',
      description: 'dsx が管理するツール群（パッケージマネージャ・Go ツールなど）を一括で更新します。dsx 本体は更新しません。',
      button: 'Update',
      run: () => setConfirming('sys-update'),
    },
    {
      title: 'Dry Run',
      command: 'dsx sys update -n',
      description: '実際には更新せず、何が更新されるかの計画だけを実行ログに表示します。',
      button: 'Dry Run',
      run: () => void runSysUpdateDryRun(),
    },
    {
      title: 'Update Repositories',
      command: 'dsx repo update --root <workspace root>',
      description: 'workspace root 配下のすべてのリポジトリを更新します（Arbor の root を dsx に渡します）。',
      button: 'Update',
      run: () => void runRepoUpdate(),
    },
    {
      title: 'Doctor',
      command: 'dsx doctor',
      description: 'dsx が依存するツール（git・gh・Bitwarden CLI など）と設定を診断します。',
      button: 'Run Doctor',
      run: () => void runDoctor(),
    },
  ];

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <div style={{ padding: 16, maxWidth: 760 }}>
        <SectionTitle>dsx CLI</SectionTitle>
        <section style={{ marginBottom: 28 }}>
          {!dsx ? (
            <Muted>dsx を確認しています…</Muted>
          ) : dsx.available ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ fontSize: 12, color: 'var(--green)', flex: 1 }}>
                  ✓ dsx {shortVersion(dsx.version) ?? '版不明'}
                  {dsx.path && (
                    <>
                      {' · '}
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text3)' }}>{dsx.path}</span>
                    </>
                  )}
                </div>
                <AppBtn onClick={() => void checkLatest()} disabled={latestCheck.state === 'checking'}>
                  {latestCheck.state === 'checking' ? '確認中…' : 'バージョン確認'}
                </AppBtn>
              </div>
              <LatestResult
                check={latestCheck}
                current={dsx.version ?? ''}
                disabled={disabled}
                onSelfUpdate={() => setConfirming('self-update')}
              />
              {selfUpdateStalled && <MsixHint />}
            </div>
          ) : (
            <InstallGuide />
          )}
        </section>

        <SectionTitle>ACTIONS</SectionTitle>
        <p style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 12, lineHeight: 1.6 }}>
          実行すると、出力は下の実行ログコンソールに流れます。実行できるのは 1 件ずつです。
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {actions.map((action) => (
            <div
              key={action.command}
              style={{
                background: 'var(--bg3)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r2)',
                padding: '12px 14px',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--indigo-l)' }}>{action.title}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text3)', wordBreak: 'break-all' }}>
                {action.command}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text2)', lineHeight: 1.6, flex: 1 }}>{action.description}</div>
              <div>
                <AppBtn onClick={action.run} disabled={disabled} aria-label={`${action.title}（${action.command}）`}>
                  {action.button}
                </AppBtn>
              </div>
            </div>
          ))}
        </div>
      </div>

      {confirming === 'sys-update' && (
        <ConfirmDialog
          title="dsx sys update — システム全体の更新"
          message={'dsx が管理するすべてのツールを最新版に更新します（dsx CLI 自体の更新ではありません）。\n完了まで数分かかることがあります。'}
          confirmLabel="実行"
          onConfirm={() => {
            setConfirming(null);
            void runSysUpdate();
          }}
          onCancel={() => setConfirming(null)}
        />
      )}

      {confirming === 'self-update' && (
        <ConfirmDialog
          title="dsx self-update を実行しますか？"
          message={'dsx CLI 自体を最新版に更新します。\n完了まで少し時間がかかることがあります。'}
          confirmLabel="実行"
          onConfirm={() => {
            setConfirming(null);
            void selfUpdate();
          }}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  );
}

function LatestResult({
  check,
  current,
  disabled,
  onSelfUpdate,
}: {
  check: LatestCheck;
  current: string;
  disabled: boolean;
  onSelfUpdate: () => void;
}) {
  if (check.state === 'idle' || check.state === 'checking') return null;
  if (check.state === 'error') return <Muted>バージョン情報を取得できませんでした</Muted>;
  if (!check.latest) {
    return <Muted>取得できませんでした。ネットワークまたは GitHub API を確認してください。</Muted>;
  }
  const cmp = compareSemverLike(current, check.latest);
  if (cmp === null) {
    return <Muted>バージョンを比較できませんでした（current: {current}, latest: {check.latest}）</Muted>;
  }
  return cmp >= 0 ? (
    <div style={{ fontSize: 11, color: 'var(--green)' }}>✓ 最新版です（{check.latest}）</div>
  ) : (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ fontSize: 11, color: 'var(--amber)' }}>↑ {check.latest} が利用可能です</div>
      <AppBtn onClick={onSelfUpdate} disabled={disabled}>
        Self Update
      </AppBtn>
    </div>
  );
}

function MsixHint() {
  return (
    <div
      style={{
        padding: '10px 14px',
        background: 'var(--amber-bg)',
        border: '1px solid #fbbf2425',
        borderRadius: 'var(--r)',
        fontSize: 11,
        color: 'var(--amber)',
        lineHeight: 1.65,
      }}
    >
      dsx の版が上がりませんでした。MSIX 版の dsx は、.appinstaller による自動更新のため、self-update では更新されません。
      PowerShell で次を実行してください:
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--indigo-l)', display: 'block', marginTop: 8, wordBreak: 'break-all' }}>
        {MSIX_UPDATE_COMMAND}
      </span>
    </div>
  );
}

function InstallGuide() {
  return (
    <div
      style={{
        padding: '12px 16px',
        background: 'var(--amber-bg)',
        border: '1px solid #fbbf2425',
        borderRadius: 'var(--r)',
        fontSize: 12,
        color: 'var(--amber)',
        lineHeight: 1.65,
      }}
    >
      ⚡ dsx が見つかりません。以下のコマンドでインストールしてください:
      <br />
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--indigo-l)', display: 'block', marginTop: 8 }}>
        go install github.com/scottlz0310/dsx@latest
      </span>
      インストール後、Arbor を再起動してください。
    </div>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 11, color: 'var(--text3)' }}>{children}</div>;
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', letterSpacing: '.12em', marginBottom: 12 }}>
      {children}
    </div>
  );
}
