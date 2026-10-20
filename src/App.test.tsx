import { render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';
import { act } from 'react';
import App from './App';
import * as invoke from './lib/invoke';
import { useUiStore } from './stores/uiStore';
import { useUpdateStore } from './stores/updateStore';
import type { RepoInfo } from './types';

const mockListRepositories = spyOn(invoke, 'listRepositories');
const mockDsxCheck = spyOn(invoke, 'dsxCheck');
const mockGetWorkspaceStatus = spyOn(invoke, 'getWorkspaceStatus');
const mockGetConfig = spyOn(invoke, 'getConfig');
const mockScanMissing = spyOn(invoke, 'scanMissingRepositories');
const mockUpdaterCheck = spyOn(invoke, 'updaterCheck');

// module export への spy をファイル外へ漏らさない
afterAll(() => {
  mock.restore();
});

const repo: RepoInfo = {
  path: '/src/arbor',
  name: 'arbor',
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
};

beforeEach(() => {
  jest.clearAllMocks();
  mockDsxCheck.mockResolvedValue({
    available: true,
    version: 'dsx version 0.12.0',
    path: '/bin/dsx',
    supports_daily_refresh: true,
  });
  mockGetWorkspaceStatus.mockResolvedValue({ root: '/src', root_error: null, workspace_count: 1, manual_count: 0 });
  mockGetConfig.mockResolvedValue({
    settings: { stale_threshold_days: 14, fetch_on_startup: false, protected_branches: [] },
    workspace: { root: '/src' },
    repositories: [],
  } as never);
  mockScanMissing.mockResolvedValue([]);
  mockUpdaterCheck.mockResolvedValue({ kind: 'up_to_date', current_version: '0.5.0' });
  act(() => useUiStore.setState({ activeView: 'status' }));
});

describe('App — 起動時の画面', () => {
  it('リポジトリがあれば、読み込みの前後を通して Status のまま（Settings へ飛ばない）', async () => {
    mockListRepositories.mockResolvedValue([repo]);

    render(<App />);

    expect(await screen.findByRole('group', { name: 'arbor' })).toBeTruthy();
    expect(useUiStore.getState().activeView).toBe('status');
    expect(screen.getByRole('tab', { name: /Repository Status/ })).toBeTruthy();
  });

  it('読み込みが終わってもリポジトリが 0 件なら、Settings へ誘導する', async () => {
    mockListRepositories.mockResolvedValue([]);

    render(<App />);

    await waitFor(() => expect(useUiStore.getState().activeView).toBe('settings'));
    // Settings では Summary と タブを出さない
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('一覧の読み込みに失敗しても、0 件として Settings へ誘導する', async () => {
    mockListRepositories.mockRejectedValue(new Error('scan failed'));

    render(<App />);

    await waitFor(() => expect(useUiStore.getState().activeView).toBe('settings'));
  });

  it('誘導は 1 回だけ。0 件のままでも、Status へ戻れる', async () => {
    mockListRepositories.mockResolvedValue([]);
    render(<App />);
    await waitFor(() => expect(useUiStore.getState().activeView).toBe('settings'));

    act(() => useUiStore.getState().navigate('status'));

    // 戻した後に、再び Settings へ押し戻されない
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(useUiStore.getState().activeView).toBe('status');
    expect(screen.getByRole('tablist')).toBeTruthy();
    expect(screen.getByText(/Settings で workspace root を設定/)).toBeTruthy();
  });

  it('dsx が見つからないときは、dsx Tools タブへ誘導する（インストール手順はそこにある）', async () => {
    mockListRepositories.mockResolvedValue([repo]);
    mockDsxCheck.mockResolvedValue({ available: false, version: null, path: null, supports_daily_refresh: false });

    render(<App />);

    await waitFor(() => expect(useUiStore.getState().activeView).toBe('tools'));
    expect(await screen.findByText(/go install github.com\/scottlz0310\/dsx@latest/)).toBeTruthy();
    expect(useUiStore.getState().toasts.some((t) => t.message.includes('dsx Tools タブ'))).toBe(true);
  });
});

describe('App — 起動時の更新の確認', () => {
  it('新しい版があれば Toast で知らせるだけで、適用はしない', async () => {
    mockListRepositories.mockResolvedValue([repo]);
    mockUpdaterCheck.mockResolvedValue({ kind: 'available', current_version: '0.5.0', version: '0.6.0', notes: null });

    render(<App />);

    await waitFor(() =>
      expect(useUiStore.getState().toasts.some((t) => t.message === 'Arbor v0.6.0 が利用できます。Tools タブから更新できます。')).toBe(true),
    );
    expect(useUiStore.getState().activeView).toBe('status');
  });

  it.each([
    { name: '最新版', result: { kind: 'up_to_date', current_version: '0.5.0' } },
    { name: '対応していない環境', result: { kind: 'unsupported', reason: 'deb です' } },
  ] as const)(' のときは、何も知らせない', async ({ result }) => {
    mockListRepositories.mockResolvedValue([repo]);
    mockUpdaterCheck.mockResolvedValue(result);

    render(<App />);

    await waitFor(() => expect(useUpdateStore.getState().status.state).toBe('done'));
    expect(useUiStore.getState().toasts).toEqual([]);
  });

  it('確認に失敗しても Toast では騒がず、Tools タブに表示する状態にする', async () => {
    mockListRepositories.mockResolvedValue([repo]);
    mockUpdaterCheck.mockRejectedValue('更新の確認に失敗しました: offline');

    render(<App />);

    await waitFor(() => expect(useUpdateStore.getState().status.state).toBe('error'));
    expect(useUiStore.getState().toasts).toEqual([]);
  });
});
