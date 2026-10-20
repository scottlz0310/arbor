import { afterAll, beforeEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';
import { useUpdateStore } from './updateStore';
import * as invoke from '../lib/invoke';
import type { UpdateCheck } from '../types';

const mockUpdaterCheck = spyOn(invoke, 'updaterCheck');
const mockUpdaterInstall = spyOn(invoke, 'updaterInstall');

afterAll(() => {
  mock.restore();
});

const available: UpdateCheck = { kind: 'available', current_version: '0.5.0', version: '0.6.0', notes: 'notes' };

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdaterCheck.mockResolvedValue(available);
  mockUpdaterInstall.mockResolvedValue(undefined);
});

describe('updateStore.check', () => {
  it('起動前は未確認（idle）', () => {
    expect(useUpdateStore.getState().status).toEqual({ state: 'idle' });
  });

  it.each([
    { name: '新しい版がある', result: available },
    { name: '最新版', result: { kind: 'up_to_date', current_version: '0.5.0' } as UpdateCheck },
    { name: '対応していない環境', result: { kind: 'unsupported', reason: 'deb です' } as UpdateCheck },
  ])('$name → 結果を取り込む', async ({ result }) => {
    mockUpdaterCheck.mockResolvedValue(result);

    await useUpdateStore.getState().check();

    expect(useUpdateStore.getState().status).toEqual({ state: 'done', result });
  });

  it('確認中の状態を経由する', async () => {
    let resolve: (value: UpdateCheck) => void = () => {};
    mockUpdaterCheck.mockReturnValue(new Promise<UpdateCheck>((r) => (resolve = r)));

    const pending = useUpdateStore.getState().check();
    expect(useUpdateStore.getState().status).toEqual({ state: 'checking' });

    resolve(available);
    await pending;
    expect(useUpdateStore.getState().status.state).toBe('done');
  });

  it.each([
    { name: 'Error', error: new Error('ネットワークに接続できません'), message: 'ネットワークに接続できません' },
    { name: '文字列', error: '更新の確認に失敗しました: timeout', message: '更新の確認に失敗しました: timeout' },
  ])('失敗（$name）は error の状態にして、例外は投げない', async ({ error, message }) => {
    mockUpdaterCheck.mockRejectedValue(error);

    await useUpdateStore.getState().check();

    expect(useUpdateStore.getState().status).toEqual({ state: 'error', message });
  });

  it('確認中・適用中は、重ねて確認しない', async () => {
    useUpdateStore.setState({ status: { state: 'checking' } });
    await useUpdateStore.getState().check();

    useUpdateStore.setState({ status: { state: 'installing', version: '0.6.0' } });
    await useUpdateStore.getState().check();

    expect(mockUpdaterCheck).not.toHaveBeenCalled();
  });
});

describe('updateStore.install', () => {
  it('新しい版があるときだけ適用する（成功すると再起動するので、状態は適用中のまま）', async () => {
    useUpdateStore.setState({ status: { state: 'done', result: available } });

    await useUpdateStore.getState().install();

    expect(mockUpdaterInstall).toHaveBeenCalledTimes(1);
    expect(useUpdateStore.getState().status).toEqual({ state: 'installing', version: '0.6.0' });
  });

  it.each([
    { name: '未確認', status: { state: 'idle' } as const },
    { name: '最新版', status: { state: 'done', result: { kind: 'up_to_date', current_version: '0.5.0' } } as const },
    { name: '対応していない環境', status: { state: 'done', result: { kind: 'unsupported', reason: 'x' } } as const },
    { name: '適用中', status: { state: 'installing', version: '0.6.0' } as const },
  ])('$name のときは適用しない', async ({ status }) => {
    useUpdateStore.setState({ status });

    await useUpdateStore.getState().install();

    expect(mockUpdaterInstall).not.toHaveBeenCalled();
  });

  it('適用に失敗したら error の状態にする', async () => {
    useUpdateStore.setState({ status: { state: 'done', result: available } });
    mockUpdaterInstall.mockRejectedValue('更新のダウンロードと適用に失敗しました: disk full');

    await useUpdateStore.getState().install();

    expect(useUpdateStore.getState().status).toEqual({
      state: 'error',
      message: '更新のダウンロードと適用に失敗しました: disk full',
    });
  });
});
