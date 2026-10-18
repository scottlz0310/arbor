import { useEffect } from 'react';
import Sidebar from './components/Sidebar';
import ToastContainer from './components/Toast';
import ErrorBoundary from './components/ErrorBoundary';
import CommandPalette from './components/CommandPalette';
import Header from './components/Header';
import LogConsole from './components/LogConsole';
import Overview from './views/Overview';
import Cleanup from './views/Cleanup';
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

  // リポジトリが未登録なら Settings へ遷移する。
  const { repos } = useRepoStore();
  useEffect(() => {
    if (repos.length === 0 && activeView === 'overview') {
      navigate('settings');
    }
  }, [repos.length, activeView, navigate]);

  return (
    <div className="app-root">
      <Header />
      <div className="app-shell">
        <Sidebar />
        <main className="main-content">
          <div style={{ flex: 1, minHeight: 0 }}>
            {activeView === 'overview' && (
              <ErrorBoundary key="overview" viewName="Overview"><Overview /></ErrorBoundary>
            )}
            {activeView === 'cleanup' && (
              <ErrorBoundary key="cleanup" viewName="Cleanup"><Cleanup /></ErrorBoundary>
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
    </div>
  );
}
