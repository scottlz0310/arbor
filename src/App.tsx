import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import Sidebar from './components/Sidebar';
import ToastContainer from './components/Toast';
import ErrorBoundary from './components/ErrorBoundary';
import CommandPalette from './components/CommandPalette';
import Overview from './views/Overview';
import Branches from './views/Branches';
import Graph from './views/Graph';
import PullRequests from './views/PullRequests';
import Cleanup from './views/Cleanup';
import Stash from './views/Stash';
import Settings from './views/Settings';
import { useRepoStore } from './stores/repoStore';
import { useUiStore } from './stores/uiStore';
import { dsxCheck } from './lib/invoke';

export default function App() {
  const { loadRepos } = useRepoStore();
  const { activeView, navigate, appendDsxLine, addToast, commandPaletteOpen, openCommandPalette, closeCommandPalette } = useUiStore();

  // 起動時の初期化（一度だけ実行）
  useEffect(() => {
    loadRepos();

    let cancelled = false;

    dsxCheck().then((status) => {
      if (cancelled) return;
      if (!status.available) {
        navigate('settings');
        addToast('dsx CLI が見つかりません。Settings からインストール手順を確認してください。', 'error');
      }
    }).catch(() => {
      if (cancelled) return;
      navigate('settings');
      addToast('dsx CLI の確認に失敗しました。Settings を確認してください。', 'error');
    });

    const unlisten = listen<string>('dsx_progress', (e) => {
      appendDsxLine(e.payload);
    });

    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
    };
  }, []);

  // Ctrl/Cmd+K でコマンドパレットを開閉する
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.ctrlKey || e.metaKey)) {
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
    <div className="app-shell">
      <Sidebar />
      <main className="main-content">
        {activeView === 'overview' && (
          <ErrorBoundary key="overview" viewName="Overview"><Overview /></ErrorBoundary>
        )}
        {activeView === 'branches' && (
          <ErrorBoundary key="branches" viewName="Branches"><Branches /></ErrorBoundary>
        )}
        {activeView === 'graph'   && (
          <ErrorBoundary key="graph" viewName="Commit Graph"><Graph /></ErrorBoundary>
        )}
        {activeView === 'prs'     && (
          <ErrorBoundary key="prs" viewName="PR / Issues"><PullRequests /></ErrorBoundary>
        )}
        {activeView === 'cleanup' && (
          <ErrorBoundary key="cleanup" viewName="Cleanup"><Cleanup /></ErrorBoundary>
        )}
        {activeView === 'stash' && (
          <ErrorBoundary key="stash" viewName="Stash Manager"><Stash /></ErrorBoundary>
        )}
        {activeView === 'settings' && (
          <ErrorBoundary key="settings" viewName="Settings"><Settings /></ErrorBoundary>
        )}
      </main>
      <ToastContainer />
      {commandPaletteOpen && <CommandPalette />}
    </div>
  );
}
