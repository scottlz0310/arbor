import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';
import Settings from './Settings';
import ToastContainer from '../components/Toast';
import * as invoke from '../lib/invoke';
import { useUiStore } from '../stores/uiStore';

// デフォルトの invoke モックを設定する
const mockDsxCheck = vi.spyOn(invoke, 'dsxCheck');
const mockGetConfig = vi.spyOn(invoke, 'getConfig');
const mockHasGithubPat = vi.spyOn(invoke, 'hasGithubPat');
const mockSysUpdate = vi.spyOn(invoke, 'sysUpdate');

const availableDsxStatus = { available: true, version: 'v0.2.3', path: '/usr/local/bin/dsx' };
const unavailableDsxStatus = { available: false, version: null, path: null };

const mockConfig = {
  repositories: [],
  settings: { stale_threshold_days: 30, fetch_on_startup: false },
  ai: { provider: 'ollama', model: 'qwen3.5:latest', ollama_url: 'http://localhost:11434' },
  github_keychain_key: 'arbor_github_pat',
};

function renderWithToast() {
  return render(
    <>
      <Settings />
      <ToastContainer />
    </>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  act(() => { useUiStore.setState({ toasts: [] }); });
  mockGetConfig.mockResolvedValue(mockConfig as never);
  mockHasGithubPat.mockResolvedValue(false as never);
  mockDsxCheck.mockResolvedValue(availableDsxStatus as never);
  mockSysUpdate.mockResolvedValue({ stdout: '', stderr: '', exit_code: 0 } as never);
});

describe('Settings — dsx CLI section', () => {
  it('dsx が利用可能な場合にバージョンを表示する', async () => {
    render(<Settings />);
    await screen.findByText(/v0\.2\.3/);
    expect(screen.getByText(/v0\.2\.3/)).toBeInTheDocument();
  });

  it('dsx が利用可能な場合に Update ボタンを表示する', async () => {
    render(<Settings />);
    await screen.findByRole('button', { name: 'Update' });
    expect(screen.getByRole('button', { name: 'Update' })).toBeInTheDocument();
  });

  it('dsx が利用不可の場合に Update ボタンを表示しない', async () => {
    mockDsxCheck.mockResolvedValue(unavailableDsxStatus as never);
    render(<Settings />);
    // インストール案内テキストが出るまで待つ
    await screen.findByText(/dsx が見つかりません/);
    expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument();
  });

  it('Update ボタンをクリックすると sysUpdate が呼ばれる', async () => {
    render(<Settings />);
    const btn = await screen.findByRole('button', { name: 'Update' });
    await userEvent.click(btn);
    expect(mockSysUpdate).toHaveBeenCalledTimes(1);
  });

  it('sysUpdate 完了後に dsxCheck を再呼び出しする', async () => {
    render(<Settings />);
    const btn = await screen.findByRole('button', { name: 'Update' });
    await userEvent.click(btn);
    await waitFor(() => {
      // 初回 mount + update 後の再チェックで計 2 回呼ばれる
      expect(mockDsxCheck).toHaveBeenCalledTimes(2);
    });
  });

  it('sysUpdate が失敗した場合にエラートーストを表示する', async () => {
    mockSysUpdate.mockRejectedValue(new Error('network error') as never);
    renderWithToast();
    const btn = await screen.findByRole('button', { name: 'Update' });
    await userEvent.click(btn);
    // Toast に error メッセージが表示される（String(Error) → "Error: network error"）
    await screen.findByText('Error: network error');
  });
});
