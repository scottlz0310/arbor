import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, type Mock } from 'bun:test';
import type { CleanupCandidate } from '../types';
import {
  cancelRun,
  cleanupExecute,
  cleanupPreview,
  dsxDoctor,
  fetchRepositories,
  openRepoFolder,
  sysUpdate,
  sysUpdateDryRun,
  takeRunReport,
} from './invoke';

const candidate: CleanupCandidate = {
  repo_path: '/repos/a',
  repo_name: 'repo-a',
  ref_name: 'feature/done',
  operation: 'delete_local_branch',
  kind: 'merged',
  remote_name: null,
  oid: '0123456789abcdef0123456789abcdef01234567',
  last_commit_ts: 1_700_000_000,
  is_merged: true,
  upstream: 'none',
  stale_days: null,
  blocked: [],
};

// preload (src/test/setup.ts) の mock.module 済み invoke を Mock として扱う
const mockedTauriInvoke = tauriInvoke as Mock<typeof tauriInvoke>;

beforeEach(() => {
  mockedTauriInvoke.mockClear();
});

describe('Process IPC wrappers', () => {
  it('cancelRun は runId を cancel_run へ委譲する', async () => {
    await cancelRun(7);

    expect(mockedTauriInvoke).toHaveBeenCalledTimes(1);
    expect(mockedTauriInvoke.mock.calls[0]).toEqual(['cancel_run', { runId: 7 }]);
  });

  it('fetchRepositories は引数なしで fetch_repositories を呼ぶ', async () => {
    await fetchRepositories();

    expect(mockedTauriInvoke.mock.calls[0]).toEqual(['fetch_repositories']);
  });

  it('openRepoFolder は repoPath を open_repo_folder へ委譲する', async () => {
    await openRepoFolder('/repos/a');

    expect(mockedTauriInvoke.mock.calls[0]).toEqual(['open_repo_folder', { repoPath: '/repos/a' }]);
  });

  it.each([
    { name: 'sysUpdate', call: sysUpdate, command: 'sys_update' },
    { name: 'sysUpdateDryRun', call: sysUpdateDryRun, command: 'sys_update_dry_run' },
    { name: 'dsxDoctor', call: dsxDoctor, command: 'dsx_doctor' },
    { name: 'takeRunReport', call: takeRunReport, command: 'take_run_report' },
  ])('$name は引数なしで $command を呼ぶ', async ({ call, command }) => {
    await call();

    expect(mockedTauriInvoke).toHaveBeenCalledTimes(1);
    expect(mockedTauriInvoke.mock.calls[0]).toEqual([command]);
  });
});

describe('Cleanup IPC wrappers', () => {
  const cases: { name: string; call: () => Promise<unknown>; expectedCall: Parameters<typeof tauriInvoke> }[] = [
    {
      name: 'preview',
      call: () => cleanupPreview(),
      expectedCall: ['cleanup_preview'],
    },
    {
      name: 'execute',
      call: () => cleanupExecute([candidate]),
      expectedCall: ['cleanup_execute', { request: { candidates: [candidate] } }],
    },
  ];
  it.each(cases)('$name は型付き引数を Tauri command へ委譲する', async ({ call, expectedCall }) => {
    await call();

    expect(mockedTauriInvoke).toHaveBeenCalledTimes(1);
    expect(mockedTauriInvoke.mock.calls[0]).toEqual(expectedCall);
  });
});
