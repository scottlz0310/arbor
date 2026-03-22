import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import Sidebar from './components/Sidebar';
import ToastContainer from './components/Toast';
import Overview from './views/Overview';
import Branches from './views/Branches';
import Cleanup from './views/Cleanup';
import Settings from './views/Settings';
import { useRepoStore } from './stores/repoStore';
import { useUiStore } from './stores/uiStore';

export default function App() {
  const { loadRepos } = useRepoStore();
  const { activeView, navigate, appendDsxLine } = useUiStore();

  useEffect(() => {
    loadRepos();

    // Subscribe to dsx progress events emitted from Rust.
    const unlisten = listen<string>('dsx_progress', (e) => {
      appendDsxLine(e.payload);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Navigate to Settings if no repos are configured yet.
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
        {activeView === 'overview'  && <Overview />}
        {activeView === 'branches'  && <Branches />}
        {activeView === 'graph'     && <PlaceholderView label="Commit Graph" note="Implemented in Phase 2" />}
        {activeView === 'prs'       && <PlaceholderView label="PR / Issues"  note="Implemented in Phase 2" />}
        {activeView === 'cleanup'   && <Cleanup />}
        {activeView === 'settings'  && <Settings />}
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
