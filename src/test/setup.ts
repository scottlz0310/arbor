import { afterEach, expect, mock } from 'bun:test';
import * as matchers from '@testing-library/jest-dom/matchers';
import { cleanup } from '@testing-library/react';

expect.extend(matchers);

// bun test はプロセスを全テストファイルで共有するため、明示的に unmount する
afterEach(cleanup);

// ── Tauri IPC 境界のグローバルモック ─────────────────────────────────────────
// bun の mock.module はモジュールレジストリを書き換え、ファイル間で共有される。
// 個別テストでの上書きは spyOn / mockImplementation で行い、
// mock.module の再呼び出しはモック汚染を招くため preload に集約する。
mock.module('@tauri-apps/api/core', () => ({
  invoke: mock(() => Promise.resolve(undefined)),
}));

mock.module('@tauri-apps/api/event', () => ({
  listen: mock(() => Promise.resolve(() => {})),
}));

mock.module('@tauri-apps/plugin-dialog', () => ({
  open: mock(() => Promise.resolve(null)),
}));

// ── zustand ストアのテスト間リセット ─────────────────────────────────────────
// bun test は全ファイルを 1 プロセスで実行するため、テストが setState で注入した
// モック関数や状態が後続ファイルへ漏れる。毎テスト後に初期状態へ完全置換する。
// （store は Tauri API を import するため、mock.module 登録後に動的 import する）
const { useRepoStore } = await import('../stores/repoStore');
const { useUiStore } = await import('../stores/uiStore');

const initialRepoState = useRepoStore.getInitialState();
const initialUiState = useUiStore.getInitialState();

afterEach(() => {
  useRepoStore.setState(initialRepoState, true);
  useUiStore.setState(initialUiState, true);
});
