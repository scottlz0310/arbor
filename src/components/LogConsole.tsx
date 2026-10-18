import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { parseAnsi, stripAnsi } from '../lib/ansi';
import { cancelRun } from '../lib/invoke';
import { useConsoleStore, type ConsoleLine, type ConsoleRun, type LineKind } from '../stores/consoleStore';
import { useUiStore } from '../stores/uiStore';
import { AppBtn } from './AppBar';
import ConfirmDialog from './ConfirmDialog';

const DOCK_HEIGHT = 260;
/** 末尾からこの距離（px）以内なら「最下部にいる」とみなす。 */
const BOTTOM_THRESHOLD = 24;

const KIND_COLOR: Record<LineKind, string> = {
  stdout: 'var(--text2)',
  stderr: 'var(--amber)',
  system: 'var(--indigo-l)',
};

function runSummary(run: ConsoleRun | null): { text: string; color: string } {
  if (!run) return { text: 'Ready', color: 'var(--text3)' };
  switch (run.status) {
    case 'running':
      return { text: `実行中: ${run.label}`, color: 'var(--indigo-l)' };
    case 'succeeded':
      return { text: `完了: ${run.label}`, color: 'var(--green)' };
    case 'failed':
      return { text: `失敗 (exit ${run.exitCode ?? '不明'}): ${run.label}`, color: 'var(--red)' };
    case 'cancelled':
      return { text: `キャンセル: ${run.label}`, color: 'var(--amber)' };
  }
}

const LogLine = memo(function LogLine({ line }: { line: ConsoleLine }) {
  return (
    <div
      data-kind={line.kind}
      style={{ color: KIND_COLOR[line.kind], whiteSpace: 'pre-wrap', wordBreak: 'break-all', minHeight: '1.6em' }}
    >
      {parseAnsi(line.text).map((segment, i) => (
        <span
          key={i}
          style={{
            color: segment.style.color,
            fontWeight: segment.style.bold ? 600 : undefined,
            opacity: segment.style.dim ? 0.6 : undefined,
          }}
        >
          {segment.text}
        </span>
      ))}
    </div>
  );
});

const inputStyle: React.CSSProperties = {
  background: 'var(--bg3)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r)',
  color: 'var(--text1)',
  fontSize: 11,
  padding: '3px 8px',
  outline: 'none',
  width: 150,
};

export default function LogConsole() {
  const lines = useConsoleStore((s) => s.lines);
  const run = useConsoleStore((s) => s.run);
  const open = useConsoleStore((s) => s.open);
  const setOpen = useConsoleStore((s) => s.setOpen);
  const clear = useConsoleStore((s) => s.clear);
  const addToast = useUiStore((s) => s.addToast);

  const [filter, setFilter] = useState('');
  const [follow, setFollow] = useState(true);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return query ? lines.filter((l) => stripAnsi(l.text).toLowerCase().includes(query)) : lines;
  }, [lines, filter]);

  const running = run?.status === 'running';
  const summary = runSummary(run);

  // 追従中は、行が増えるたびに最下部へ寄せる。
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (open && follow && el) el.scrollTop = el.scrollHeight;
  }, [visible, follow, open]);

  const handleScroll = () => {
    const el = viewportRef.current;
    if (!el) return;
    // 上へスクロールしたら追従を解除し、最下部へ戻ったら再開する。
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(visible.map((l) => stripAnsi(l.text)).join('\n'));
      addToast('ログをコピーしました', 'success');
    } catch (e) {
      addToast(`コピーに失敗しました: ${String(e)}`, 'error');
    }
  };

  const handleCancel = async () => {
    setConfirmingCancel(false);
    if (!run) return;
    try {
      await cancelRun(run.runId);
    } catch (e) {
      addToast(String(e), 'error');
    }
  };

  return (
    <section
      aria-label="実行コンソール"
      style={{
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        height: open ? DOCK_HEIGHT : undefined,
        borderTop: '1px solid var(--border)',
        background: '#080a0f',
      }}
    >
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        background: 'var(--bg2)',
        borderBottom: open ? '1px solid var(--border)' : undefined,
        flexShrink: 0,
      }}>
        <span
          aria-hidden="true"
          className={running ? 'console-pulse' : undefined}
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            flexShrink: 0,
            background: running ? 'var(--green)' : 'var(--text3)',
          }}
        />
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text1)' }}>Execution Console</span>
        <span
          style={{
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            color: summary.color,
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {summary.text}
        </span>

        {open && (
          <>
            <input
              type="text"
              aria-label="ログを絞り込む"
              placeholder="Filter…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={inputStyle}
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text2)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={follow}
                onChange={(e) => setFollow(e.target.checked)}
                style={{ accentColor: 'var(--indigo-l)' }}
              />
              追従
            </label>
            <AppBtn onClick={handleCopy} disabled={visible.length === 0}>Copy</AppBtn>
            <AppBtn onClick={clear} disabled={lines.length === 0}>Clear</AppBtn>
          </>
        )}
        {running && (
          <AppBtn variant="danger" onClick={() => setConfirmingCancel(true)}>キャンセル</AppBtn>
        )}
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? 'コンソールを閉じる' : 'コンソールを開く'}
          onClick={() => setOpen(!open)}
          style={{ background: 'none', border: 'none', color: 'var(--text2)', fontSize: 12, padding: '0 4px' }}
        >
          {open ? '▾' : '▴'}
        </button>
      </div>

      {open && (
        <div
          ref={viewportRef}
          role="log"
          aria-label="実行ログ"
          aria-live="off"
          onScroll={handleScroll}
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            padding: '8px 12px',
            fontFamily: 'var(--font-mono)',
            fontSize: 11.5,
            lineHeight: 1.6,
          }}
        >
          {lines.length === 0 ? (
            <div style={{ color: 'var(--text3)' }}>dsx などの実行ログがここに表示されます。</div>
          ) : (
            visible.map((line) => <LogLine key={line.id} line={line} />)
          )}
          {lines.length > 0 && visible.length === 0 && (
            <div style={{ color: 'var(--text3)' }}>条件に一致する行がありません。</div>
          )}
        </div>
      )}

      {confirmingCancel && run && (
        <ConfirmDialog
          title="実行中のコマンドを強制終了しますか？"
          message={`「${run.label}」を強制終了します。リポジトリの更新やパッケージの更新が途中で止まり、元に戻らない場合があります。`}
          confirmLabel="強制終了"
          onConfirm={handleCancel}
          onCancel={() => setConfirmingCancel(false)}
        />
      )}
    </section>
  );
}
