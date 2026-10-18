import { useState } from 'react';
import type { CSSProperties } from 'react';
import ConfirmDialog from './ConfirmDialog';
import { AppBtn } from './AppBar';
import { dailyRefreshBlockReason, runDailyRefresh, runSysUpdate, shortVersion } from '../lib/dsxActions';
import { fetchAllRepositories } from '../lib/fetchRepositories';
import { rescan } from '../lib/rescanAfterRun';
import { useConsoleStore } from '../stores/consoleStore';
import { useEnvStore } from '../stores/envStore';
import type { BitwardenState, DsxStatus, WorkspaceStatus } from '../types';

type Tone = 'ok' | 'warn' | 'error' | 'neutral';

const TONE_COLORS: Record<Tone, { color: string; bg: string }> = {
  ok: { color: 'var(--green)', bg: 'var(--green-bg)' },
  warn: { color: 'var(--amber)', bg: 'var(--amber-bg)' },
  error: { color: 'var(--red)', bg: 'var(--red-bg)' },
  neutral: { color: 'var(--text3)', bg: 'transparent' },
};

interface Pill {
  label: string;
  tone: Tone;
  title: string;
}

function dsxPill(dsx: DsxStatus | null): Pill {
  if (!dsx) return { label: 'dsx: 確認中', tone: 'neutral', title: 'dsx を確認しています' };
  if (!dsx.available) {
    return { label: 'dsx: 未検出', tone: 'error', title: 'dsx が PATH にありません。Settings を確認してください' };
  }
  const version = shortVersion(dsx.version) ?? '版不明';
  return dsx.supports_run_root
    ? { label: `dsx ${version}`, tone: 'ok', title: dsx.path ?? 'dsx' }
    : { label: `dsx ${version}（要更新）`, tone: 'warn', title: 'Daily Refresh には dsx v0.11.0 以上が必要です' };
}

function bitwardenPill(state: BitwardenState | null): Pill {
  switch (state) {
    case 'unlocked':
      return { label: 'Bitwarden: 解錠済み', tone: 'ok', title: 'Bitwarden のセッションは解錠されています' };
    case 'not_unlocked':
      return {
        label: 'Bitwarden: 未解錠',
        tone: 'warn',
        title: 'ターミナルで解錠してください。Arbor ではマスターパスワードを扱いません',
      };
    case 'unavailable':
      return { label: 'Bitwarden: 不明', tone: 'neutral', title: 'dsx を起動できないため確認できません' };
    default:
      return { label: 'Bitwarden: 確認中', tone: 'neutral', title: 'Bitwarden を確認しています' };
  }
}

function rootPill(workspace: WorkspaceStatus | null): Pill {
  if (!workspace) return { label: 'Root: 確認中', tone: 'neutral', title: 'workspace を確認しています' };
  if (workspace.root === null) {
    return { label: 'Root: 未設定', tone: 'warn', title: 'Settings で workspace root を設定してください' };
  }
  const total = workspace.workspace_count + workspace.manual_count;
  if (workspace.root_error !== null) {
    return { label: `Root: 読み取れません (${workspace.root})`, tone: 'error', title: workspace.root_error };
  }
  return { label: `Root: ${workspace.root} (${total} repos)`, tone: 'ok', title: workspace.root };
}

function StatusPill({ pill }: { pill: Pill }) {
  const { color, bg } = TONE_COLORS[pill.tone];
  const style: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '2px 10px',
    border: `1px solid ${pill.tone === 'neutral' ? 'var(--border2)' : color}`,
    borderRadius: 999,
    background: bg,
    color,
    fontSize: 10,
    fontFamily: 'var(--font-mono)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: 360,
  };
  return <span style={style} title={pill.title}>{pill.label}</span>;
}

export default function Header() {
  const { dsx, bitwarden, workspace } = useEnvStore();
  // 実行枠は 1 つだけ。実行中は backend が拒否するので、押せないようにしておく。
  const busy = useConsoleStore((s) => s.run?.status === 'running');
  const [confirmingRefresh, setConfirmingRefresh] = useState(false);

  const blockReason = dailyRefreshBlockReason(dsx, workspace);
  const bitwardenLocked = bitwarden === 'not_unlocked';

  const handleDailyRefresh = () => {
    if (bitwardenLocked) {
      setConfirmingRefresh(true);
      return;
    }
    void runDailyRefresh();
  };

  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '8px 16px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg2)',
        flexShrink: 0,
        flexWrap: 'wrap',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
        <StatusPill pill={dsxPill(dsx)} />
        <StatusPill pill={bitwardenPill(bitwarden)} />
        <StatusPill pill={rootPill(workspace)} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <AppBtn onClick={() => void rescan()} title="リポジトリの状態と環境を読み直します（ネットワークには接続しません）">
          ⟳ Scan
        </AppBtn>
        <AppBtn onClick={() => void fetchAllRepositories()} disabled={busy}>
          ⇣ Fetch All
        </AppBtn>
        <AppBtn onClick={() => void runSysUpdate()} disabled={busy || !dsx?.available}>
          dsx sys update
        </AppBtn>
        <AppBtn
          variant="primary"
          onClick={handleDailyRefresh}
          disabled={busy || blockReason !== null}
          title={blockReason ?? 'dsx run --root: Bitwarden 解錠 → 環境変数 → システム更新 → リポジトリ更新'}
        >
          ▶ Daily Refresh
        </AppBtn>
      </div>

      {confirmingRefresh && (
        <ConfirmDialog
          title="Bitwarden が解錠されていません"
          message="Daily Refresh は Bitwarden の解錠が必要な処理を含みます。Arbor からは解錠できないため、解錠できないまま実行すると、その処理は失敗するか、警告つきで省略される場合があります。ターミナルで解錠してから実行することを勧めます。このまま実行しますか？"
          confirmLabel="実行する"
          onConfirm={() => {
            setConfirmingRefresh(false);
            void runDailyRefresh();
          }}
          onCancel={() => setConfirmingRefresh(false)}
        />
      )}
    </header>
  );
}
