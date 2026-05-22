import { useEffect, useRef, useState } from 'react';
import { useRepoStore } from '../stores/repoStore';
import { useUiStore } from '../stores/uiStore';
import type { ViewId } from '../types';

interface Command {
  id: string;
  icon: string;
  label: string;
  description: string;
  action: () => void;
}

const VIEW_COMMANDS: { id: ViewId; icon: string; label: string }[] = [
  { id: 'overview',  icon: '◈', label: 'Overview' },
  { id: 'branches',  icon: '⌥', label: 'Branches' },
  { id: 'graph',     icon: '⧖', label: 'Graph' },
  { id: 'prs',       icon: '⇄', label: 'PR / Issues' },
  { id: 'cleanup',   icon: '✦', label: 'Cleanup' },
  { id: 'stash',     icon: '⊟', label: 'Stash' },
  { id: 'settings',  icon: '⚙', label: 'Settings' },
];

export default function CommandPalette() {
  const { repos, selectRepo } = useRepoStore();
  const { navigate, closeCommandPalette } = useUiStore();

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // フォーカスをインプットに当てる
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const commands: Command[] = [
    ...VIEW_COMMANDS.map((v) => ({
      id: `view:${v.id}`,
      icon: v.icon,
      label: `${v.label} へ移動`,
      description: 'ビュー',
      action: () => { navigate(v.id); closeCommandPalette(); },
    })),
    ...repos.map((r) => ({
      id: `repo:${r.path}`,
      icon: '⬡',
      label: r.name,
      description: r.path,
      action: () => { selectRepo(r); closeCommandPalette(); },
    })),
  ];

  const filtered = query.trim() === ''
    ? commands
    : commands.filter((c) =>
        `${c.label} ${c.description}`.toLowerCase().includes(query.toLowerCase()),
      );

  // query 変更時にカーソルを先頭に戻す
  useEffect(() => { setActiveIndex(0); }, [query]);

  // アクティブ項目をスクロールして表示（jsdom では scrollIntoView が未実装のため存在確認）
  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      filtered[activeIndex]?.action();
    } else if (e.key === 'Escape') {
      closeCommandPalette();
    }
  };

  return (
    <div
      role="dialog"
      aria-label="コマンドパレット"
      aria-modal="true"
      onClick={closeCommandPalette}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(0,0,0,.6)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: '15vh',
        zIndex: 2000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg2)',
          border: '1px solid var(--border2)',
          borderRadius: 'var(--r2)',
          width: 560,
          maxWidth: '90vw',
          overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(0,0,0,.5)',
        }}
      >
        {/* 検索インプット */}
        <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontSize: 14, color: 'var(--text3)', marginRight: 10 }}>⌕</span>
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded={filtered.length > 0}
            aria-controls="command-palette-list"
            aria-activedescendant={filtered[activeIndex] ? `cmd-${filtered[activeIndex].id}` : undefined}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="コマンドを検索…"
            style={{
              flex: 1, background: 'none', border: 'none', outline: 'none',
              fontSize: 14, color: 'var(--text1)',
            }}
          />
          <kbd style={{
            fontSize: 10, padding: '2px 6px', borderRadius: 4,
            background: 'var(--bg4)', color: 'var(--text3)',
            border: '1px solid var(--border2)',
          }}>Esc</kbd>
        </div>

        {/* コマンドリスト */}
        <ul
          id="command-palette-list"
          ref={listRef}
          role="listbox"
          style={{
            listStyle: 'none', margin: 0, padding: '4px 0',
            maxHeight: 360, overflowY: 'auto',
          }}
        >
          {filtered.length === 0 ? (
            <li style={{ padding: '16px', fontSize: 12, color: 'var(--text3)', textAlign: 'center' }}>
              一致するコマンドが見つかりません
            </li>
          ) : filtered.map((cmd, i) => (
            <li
              key={cmd.id}
              id={`cmd-${cmd.id}`}
              role="option"
              aria-selected={i === activeIndex}
              onClick={cmd.action}
              onMouseEnter={() => setActiveIndex(i)}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '8px 16px', cursor: 'pointer',
                background: i === activeIndex ? 'var(--bg3)' : 'transparent',
              }}
            >
              <span style={{ fontSize: 13, width: 18, textAlign: 'center', color: 'var(--text3)', flexShrink: 0 }}>
                {cmd.icon}
              </span>
              <span style={{ flex: 1, fontSize: 13, color: 'var(--text1)' }}>
                {cmd.label}
              </span>
              <span style={{
                fontSize: 10, color: 'var(--text3)',
                maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {cmd.description}
              </span>
            </li>
          ))}
        </ul>

        {/* フッター */}
        <div style={{
          display: 'flex', gap: 16, padding: '8px 16px',
          borderTop: '1px solid var(--border)',
          fontSize: 10, color: 'var(--text3)',
        }}>
          {[['↑↓', '移動'], ['Enter', '実行'], ['Esc', '閉じる']].map(([key, desc]) => (
            <span key={key}>
              <kbd style={{
                padding: '1px 5px', borderRadius: 3,
                background: 'var(--bg4)', border: '1px solid var(--border2)',
                marginRight: 4,
              }}>{key}</kbd>
              {desc}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
