import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import Sidebar from './components/Sidebar';
import ToastContainer from './components/Toast';
import ErrorBoundary from './components/ErrorBoundary';
import Overview from './views/Overview';
import Branches from './views/Branches';
import Cleanup from './views/Cleanup';
import Settings from './views/Settings';
import { useRepoStore } from './stores/repoStore';
import { useUiStore } from './stores/uiStore';
import { dsxCheck } from './lib/invoke';

export default function App() {
  const { loadRepos } = useRepoStore();
  const { activeView, navigate, appendDsxLine, addToast } = useUiStore();

  useEffect(() => {
    loadRepos();

    // dsx の存在確認。未検出なら Settings へ誘導してバナーを表示する。
    dsxCheck().then((status) => {
      if (!status.available) {
        navigate('settings');
        addToast('dsx CLI が見つかりません。Settings からインストール手順を確認してください。', 'error');
      }
    }).catch(() => {
      navigate('settings');
      addToast('dsx CLI の確認に失敗しました。Settings を確認してください。', 'error');
    });

    // dsx 進捗イベントを購読する。
    const unlisten = listen<string>('dsx_progress', (e) => {
      appendDsxLine(e.payload);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

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
        <ErrorBoundary viewName="Overview">
          {activeView === 'overview' && <Overview />}
        </ErrorBoundary>
        <ErrorBoundary viewName="Branches">
          {activeView === 'branches' && <Branches />}
        </ErrorBoundary>
        {activeView === 'graph' && <PlaceholderView label="Commit Graph" note="Implemented in Phase 2" />}
        {activeView === 'prs'   && <PlaceholderView label="PR / Issues"  note="Implemented in Phase 2" />}
        <ErrorBoundary viewName="Cleanup">
          {activeView === 'cleanup' && <Cleanup />}
        </ErrorBoundary>
        <ErrorBoundary viewName="Settings">
          {activeView === 'settings' && <Settings />}
        </ErrorBoundary>
      </main>
      <ToastContainer />
    </div>
  );
}

function PlaceholderView({ label, note }: { label: string; note: string }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      height: '100%', gap: 8,
    }}>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, color: 'var(--text2)' }}>
        {label}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text3)' }}>{note}</div>
    </div>
  );
}
