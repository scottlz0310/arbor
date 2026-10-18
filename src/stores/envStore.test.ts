import { afterAll, beforeEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';
import { useEnvStore } from './envStore';
import * as invoke from '../lib/invoke';
import type { DsxStatus, WorkspaceStatus } from '../types';

const mockDsxCheck = spyOn(invoke, 'dsxCheck');
const mockBitwardenStatus = spyOn(invoke, 'bitwardenStatus');
const mockGetWorkspaceStatus = spyOn(invoke, 'getWorkspaceStatus');

afterAll(() => {
  mock.restore();
});

const dsx: DsxStatus = {
  available: true,
  version: 'dsx version 0.11.0',
  path: '/bin/dsx',
  supports_run_root: true,
};
const workspace: WorkspaceStatus = {
  root: '/home/src',
  root_error: null,
  workspace_count: 5,
  manual_count: 1,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockDsxCheck.mockResolvedValue(dsx);
  mockBitwardenStatus.mockResolvedValue('unlocked');
  mockGetWorkspaceStatus.mockResolvedValue(workspace);
});

describe('envStore.refresh', () => {
  it('起動前は未確認（null）', () => {
    expect(useEnvStore.getState()).toMatchObject({ dsx: null, bitwarden: null, workspace: null });
  });

  it('dsx・Bitwarden・workspace の状態を取り込む', async () => {
    await useEnvStore.getState().refresh();

    expect(useEnvStore.getState()).toMatchObject({ dsx, bitwarden: 'unlocked', workspace });
  });

  it('失敗した項目だけ「確認できない」状態にし、他は取り込む', async () => {
    mockDsxCheck.mockRejectedValue(new Error('ipc failed'));
    mockBitwardenStatus.mockRejectedValue(new Error('ipc failed'));
    mockGetWorkspaceStatus.mockRejectedValue(new Error('ipc failed'));

    await useEnvStore.getState().refresh();

    expect(useEnvStore.getState().dsx).toEqual({
      available: false,
      version: null,
      path: null,
      supports_run_root: false,
    });
    expect(useEnvStore.getState().bitwarden).toBe('unavailable');
    expect(useEnvStore.getState().workspace).toBeNull();
  });

  it('一部だけ失敗しても、成功した項目は更新される', async () => {
    mockBitwardenStatus.mockResolvedValue('not_unlocked');
    mockGetWorkspaceStatus.mockRejectedValue(new Error('ipc failed'));

    await useEnvStore.getState().refresh();

    expect(useEnvStore.getState()).toMatchObject({ dsx, bitwarden: 'not_unlocked', workspace: null });
  });
});
