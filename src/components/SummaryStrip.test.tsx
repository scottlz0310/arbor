import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'bun:test';
import { act } from 'react';
import SummaryStrip from './SummaryStrip';
import { useCleanupStore } from '../stores/cleanupStore';
import { useEnvStore } from '../stores/envStore';
import { useRemoteStore } from '../stores/remoteStore';
import { useReportStore } from '../stores/reportStore';
import { useRepoStore } from '../stores/repoStore';
import { useUiStore } from '../stores/uiStore';
import { gemSkipped, runReport } from '../test/runReportFixtures';
import type { DsxStatus, RemoteStatus, RepoInfo, WorkspaceStatus } from '../types';

function repo(name: string, overrides: Partial<RepoInfo> = {}): RepoInfo {
  return {
    path: `/src/${name}`,
    name,
    current_branch: 'main',
    ahead: 0,
    behind: 0,
    modified_count: 0,
    untracked_count: 0,
    stash_count: 0,
    is_detached: false,
    has_upstream: true,
    source: 'workspace',
    last_fetched_at: null,
    ...overrides,
  };
}

const dsxReady: DsxStatus = {
  available: true,
  version: 'dsx version 0.12.0',
  path: '/bin/dsx',
  supports_daily_refresh: true,
};
const workspaceOk: WorkspaceStatus = { root: '/src', root_error: null, workspace_count: 3, manual_count: 0 };

function setEnv(dsx: DsxStatus | null, workspace: WorkspaceStatus | null) {
  act(() => useEnvStore.setState({ dsx, workspace }));
}

const card = (label: RegExp) => screen.getByRole('button', { name: label });

beforeEach(() => {
  act(() => {
    useRepoStore.setState({
      repos: [repo('a'), repo('b', { modified_count: 1 }), repo('c'), repo('d', { behind: 2 })],
    });
    useUiStore.setState({ activeView: 'cleanup', statusFilter: 'clean' });
  });
  setEnv(dsxReady, workspaceOk);
});

describe('SummaryStrip — 件数', () => {
  it('全体の件数と、要対応・クリーンの内訳を出す', () => {
    render(<SummaryStrip />);

    expect(card(/TOTAL REPOSITORIES/).textContent).toContain('4');
    expect(card(/TOTAL REPOSITORIES/).textContent).toContain('2 Clean');
    expect(card(/NEEDS ACTION/).textContent).toContain('2');
    expect(card(/NEEDS ACTION/).textContent).toContain('Action Needed');
  });

  it('要対応が無ければ All clear', () => {
    act(() => useRepoStore.setState({ repos: [repo('a')] }));

    render(<SummaryStrip />);

    expect(card(/NEEDS ACTION/).textContent).toContain('All clear');
  });

  it.each([
    { name: '未集計', count: null, shown: '—', tag: 'Cleanup を開くと集計' },
    { name: '候補なし', count: 0, shown: '0', tag: 'Prune / Delete' },
    { name: '候補あり', count: 7, shown: '7', tag: 'Prune / Delete' },
  ])('Cleanup 候補は $name', ({ count, shown, tag }) => {
    act(() => useCleanupStore.setState({ candidateCount: count }));

    render(<SummaryStrip />);

    expect(card(/CLEANUP CANDIDATES/).textContent).toContain(shown);
    expect(card(/CLEANUP CANDIDATES/).textContent).toContain(tag);
  });
});

describe('SummaryStrip — dsx 環境', () => {
  it.each([
    { name: '確認前', dsx: null, ws: null, value: '確認中' },
    { name: '準備完了', dsx: dsxReady, ws: workspaceOk, value: 'Ready' },
    {
      name: 'dsx が古い',
      dsx: { ...dsxReady, version: 'dsx version 0.11.0', supports_daily_refresh: false },
      ws: workspaceOk,
      value: 'Attention',
    },
    { name: 'root が未設定', dsx: dsxReady, ws: { ...workspaceOk, root: null }, value: 'Attention' },
    {
      name: 'dsx が無い',
      dsx: { available: false, version: null, path: null, supports_daily_refresh: false },
      ws: workspaceOk,
      value: 'Missing',
    },
  ])('$name → $value', ({ dsx, ws, value }) => {
    setEnv(dsx, ws);

    render(<SummaryStrip />);

    expect(card(/DSX ENVIRONMENT/).textContent).toContain(value);
  });

  it('準備完了のときは版を出す', () => {
    render(<SummaryStrip />);

    expect(card(/DSX ENVIRONMENT/).textContent).toContain('v0.12.0');
  });
});

describe('SummaryStrip — 移動', () => {
  it.each([
    { label: /TOTAL REPOSITORIES/, view: 'status', filter: 'all' },
    { label: /NEEDS ACTION/, view: 'status', filter: 'attention' },
  ])('$label を押すと Status を $filter で開く', async ({ label, view, filter }) => {
    render(<SummaryStrip />);

    await userEvent.click(card(label));

    expect(useUiStore.getState().activeView).toBe(view);
    expect(useUiStore.getState().statusFilter).toBe(filter);
  });

  it.each([
    { label: /CLEANUP CANDIDATES/, view: 'cleanup' },
    { label: /DSX ENVIRONMENT/, view: 'tools' },
  ])('$label を押すと $view を開く', async ({ label, view }) => {
    act(() => useUiStore.setState({ activeView: 'status' }));
    render(<SummaryStrip />);

    await userEvent.click(card(label));

    expect(useUiStore.getState().activeView).toBe(view);
  });
});

describe('SummaryStrip — リモートの状態', () => {
  const remote = (name: string, state: RemoteStatus['state'], moved_to: string | null = null): RemoteStatus => ({
    path: `/src/${name}`,
    name,
    state,
    moved_to,
  });

  it('確認前は、注意の 1 行を出さない', () => {
    render(<SummaryStrip />);

    expect(card(/TOTAL REPOSITORIES/).textContent).not.toMatch(/Archived|remote なし|移転/);
  });

  it('アーカイブ済み・見つからない・移転を、TOTAL のカードに添える（要対応の数には混ぜない）', () => {
    const statuses = Object.fromEntries(
      [
        remote('a', { kind: 'archived' }),
        remote('b', { kind: 'not_found' }),
        remote('c', { kind: 'active' }, 'me/c'),
      ].map((s) => [s.path, s]),
    );
    act(() => useRemoteStore.setState({ statuses }));

    render(<SummaryStrip />);

    expect(card(/TOTAL REPOSITORIES/).textContent).toContain('1 Archived · 1 remote なし · 1 移転');
    // 要対応の数は、リポジトリの状態だけで決まる（b: dirty、d: behind の 2 件）。
    expect(card(/NEEDS ACTION/).textContent).toContain('2');
  });
});

describe('SummaryStrip — 管理対象から外れたリポジトリ', () => {
  it('確認の後に管理対象から外れたリポジトリの結果は、再確認するまで残っていても、数えない', () => {
    const stale: RemoteStatus = { path: '/src/removed', name: 'removed', state: { kind: 'archived' }, moved_to: 'me/removed' };
    const kept: RemoteStatus = { path: '/src/a', name: 'a', state: { kind: 'not_found' }, moved_to: null };
    act(() => useRemoteStore.setState({ statuses: { [stale.path]: stale, [kept.path]: kept } }));

    render(<SummaryStrip />);

    const text = card(/TOTAL REPOSITORIES/).textContent ?? '';
    expect(text).toContain('1 remote なし');
    expect(text).not.toMatch(/Archived|移転/);
  });

  it('管理対象の一覧が変わると、注意の 1 行も追従する', () => {
    const status: RemoteStatus = { path: '/src/a', name: 'a', state: { kind: 'archived' }, moved_to: null };
    act(() => useRemoteStore.setState({ statuses: { [status.path]: status } }));
    render(<SummaryStrip />);
    expect(card(/TOTAL REPOSITORIES/).textContent).toContain('1 Archived');

    act(() => useRepoStore.setState({ repos: [repo('b')] }));

    expect(card(/TOTAL REPOSITORIES/).textContent).not.toMatch(/Archived/);
  });
});

describe('SummaryStrip — LAST RUN', () => {
  const setReport = (report: ReturnType<typeof runReport>) => act(() => useReportStore.getState().setReport(report));

  it('報告が無ければカードを出さない', () => {
    render(<SummaryStrip />);

    expect(screen.queryByRole('button', { name: /LAST RUN/ })).not.toBeInTheDocument();
  });

  it.each([
    { name: '問題なし', report: runReport(), value: 'OK', tag: 'dsx run' },
    {
      name: 'スキップと警告（終了コード 0）は気づけるように出す',
      report: runReport({ jobs: { success: 4, failed: 0, skipped: 1 }, warnings: 1, issues: [gemSkipped] }),
      value: 'Attention',
      tag: 'スキップ 1・警告 1',
    },
    {
      name: '失敗',
      report: runReport({ ok: false, jobs: { success: 3, failed: 2, skipped: 0 } }),
      value: 'Failed',
      tag: '失敗 2',
    },
  ])('$name', ({ report, value, tag }) => {
    setReport(report);

    render(<SummaryStrip />);

    expect(card(/LAST RUN/).textContent).toContain(value);
    expect(card(/LAST RUN/).textContent).toContain(tag);
  });

  it('クリックで内訳のある Tools タブへ移る', async () => {
    setReport(runReport());
    render(<SummaryStrip />);

    await userEvent.click(card(/LAST RUN/));

    expect(useUiStore.getState().activeView).toBe('tools');
  });
});
