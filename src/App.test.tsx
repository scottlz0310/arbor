import { render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';
import { act } from 'react';
import App from './App';
import * as invoke from './lib/invoke';
import { useUiStore } from './stores/uiStore';
import type { RepoInfo } from './types';

const mockListRepositories = spyOn(invoke, 'listRepositories');
const mockDsxCheck = spyOn(invoke, 'dsxCheck');
const mockBitwardenStatus = spyOn(invoke, 'bitwardenStatus');
const mockGetWorkspaceStatus = spyOn(invoke, 'getWorkspaceStatus');
const mockGetConfig = spyOn(invoke, 'getConfig');
const mockScanMissing = spyOn(invoke, 'scanMissingRepositories');

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
    version: 'dsx version 0.11.0',
    path: '/bin/dsx',
    supports_run_root: true,
  });
  mockBitwardenStatus.mockResolvedValue('unlocked');
  mockGetWorkspaceStatus.mockResolvedValue({ root: '/src', root_error: null, workspace_count: 1, manual_count: 0 });
  mockGetConfig.mockResolvedValue({
    settings: { stale_threshold_days: 14, fetch_on_startup: false, protected_branches: [] },
    workspace: { root: '/src' },
    repositories: [],
  } as never);
  mockScanMissing.mockResolvedValue([]);
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
});
