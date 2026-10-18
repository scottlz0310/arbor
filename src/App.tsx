import { useEffect, useRef } from 'react';
import ToastContainer from './components/Toast';
import ErrorBoundary from './components/ErrorBoundary';
import CommandPalette from './components/CommandPalette';
import Header from './components/Header';
import SummaryStrip from './components/SummaryStrip';
import TabBar from './components/TabBar';
import LogConsole from './components/LogConsole';
import Status from './views/Status';
import Cleanup from './views/Cleanup';
import Tools from './views/Tools';
import Settings from './views/Settings';
import { useRepoStore } from './stores/repoStore';
import { useUiStore } from './stores/uiStore';
import { useEnvStore } from './stores/envStore';
import { subscribeProcessEvents } from './lib/processEvents';
import { subscribeRescanAfterRun } from './lib/rescanAfterRun';

export default function App() {
  const { loadRepos } = useRepoStore();
  const { activeView, navigate, addToast, commandPaletteOpen, openCommandPalette, closeCommandPalette } = useUiStore();

  // 起動時の初期化（一度だけ実行）
  useEffect(() => {
    loadRepos();

    let cancelled = false;

    useEnvStore.getState().refresh().then(() => {
      if (cancelled) return;
      if (!useEnvStore.getState().dsx?.available) {
        navigate('settings');
        addToast('dsx CLI が見つかりません。Settings からインストール手順を確認してください。', 'error');
      }
    });

    const unsubscribeRescan = subscribeRescanAfterRun();

    const unsubscribe = subscribeProcessEvents().catch((e) => {
      addToast(`実行ログの購読に失敗しました: ${String(e)}`, 'error');
      return () => {};
    });

    return () => {
      cancelled = true;
      unsubscribeRescan();
      unsubscribe.then((fn) => fn());
    };
  }, []);

  // Ctrl/Cmd+K でコマンドパレットを開閉する
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // e.code は物理キーに対応するため IME / 非 QWERTY レイアウトでも動作する。
      // フォーム入力中を含む全コンテキストで優先して開く（一般的なコマンドパレット挙動）。
      if (e.code === 'KeyK' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        commandPaletteOpen ? closeCommandPalette() : openCommandPalette();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [commandPaletteOpen, openCommandPalette, closeCommandPalette]);

  // 初回の読み込みが終わってもリポジトリが 0 件なら、Settings へ誘導する（読み込み前の空の一覧では判定しない）。
  // 誘導は 1 回だけ。以後は、0 件のままでも Status へ戻れるようにする。
  const { repos, loaded } = useRepoStore();
  const guided = useRef(false);
  useEffect(() => {
    if (!loaded || guided.current) return;
    guided.current = true;
    if (repos.length === 0 && activeView === 'status') navigate('settings');
  }, [loaded, repos.length, activeView, navigate]);

  return (
    <div className="app-root">
      <Header />
      {activeView !== 'settings' && (
        <>
          <SummaryStrip />
          <TabBar />
        </>
      )}
      <main className="main-content">
        <div style={{ flex: 1, minHeight: 0 }}>
          {activeView === 'status' && (
            <ErrorBoundary key="status" viewName="Status"><Status /></ErrorBoundary>
          )}
          {activeView === 'cleanup' && (
            <ErrorBoundary key="cleanup" viewName="Cleanup"><Cleanup /></ErrorBoundary>
          )}
          {activeView === 'tools' && (
            <ErrorBoundary key="tools" viewName="dsx Tools"><Tools /></ErrorBoundary>
          )}
          {activeView === 'settings' && (
            <ErrorBoundary key="settings" viewName="Settings"><Settings /></ErrorBoundary>
          )}
        </div>
        <LogConsole />
      </main>
      <ToastContainer />
      {commandPaletteOpen && <CommandPalette />}
    </div>
  );
}
