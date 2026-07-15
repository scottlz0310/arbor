import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CleanupCandidate } from '../types';
import { cleanupExecute, cleanupPreview } from './invoke';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

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

const mockedTauriInvoke = vi.mocked(tauriInvoke);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Cleanup IPC wrappers', () => {
  it.each([
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
  ])('$name は型付き引数を Tauri command へ委譲する', async ({ call, expectedCall }) => {
    await call();

    expect(mockedTauriInvoke).toHaveBeenCalledTimes(1);
    expect(mockedTauriInvoke.mock.calls[0]).toEqual(expectedCall);
  });
});
