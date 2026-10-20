import { afterAll, beforeEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';
import { useEnvStore } from './envStore';
import * as invoke from '../lib/invoke';
import type { DsxStatus, WorkspaceStatus } from '../types';

const mockDsxCheck = spyOn(invoke, 'dsxCheck');
const mockGetWorkspaceStatus = spyOn(invoke, 'getWorkspaceStatus');

afterAll(() => {
  mock.restore();
});

const dsx: DsxStatus = {
  available: true,
  version: 'dsx version 0.12.0',
  path: '/bin/dsx',
  supports_daily_refresh: true,
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
  mockGetWorkspaceStatus.mockResolvedValue(workspace);
});

describe('envStore.refresh', () => {
  it('起動前は未確認（null）', () => {
    expect(useEnvStore.getState()).toMatchObject({ dsx: null, workspace: null });
  });

  it('dsx・workspace の状態を取り込む', async () => {
    await useEnvStore.getState().refresh();

    expect(useEnvStore.getState()).toMatchObject({ dsx, workspace });
  });

  it('失敗した項目だけ「確認できない」状態にし、他は取り込む', async () => {
    mockDsxCheck.mockRejectedValue(new Error('ipc failed'));
    mockGetWorkspaceStatus.mockRejectedValue(new Error('ipc failed'));

    await useEnvStore.getState().refresh();

    expect(useEnvStore.getState().dsx).toEqual({
      available: false,
      version: null,
      path: null,
      supports_daily_refresh: false,
    });
    expect(useEnvStore.getState().workspace).toBeNull();
  });

  it('一部だけ失敗しても、成功した項目は更新される', async () => {
    mockGetWorkspaceStatus.mockRejectedValue(new Error('ipc failed'));

    await useEnvStore.getState().refresh();

    expect(useEnvStore.getState()).toMatchObject({ dsx, workspace: null });
  });
});
