import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Settings from './Settings';
import ToastContainer from '../components/Toast';
import * as invoke from '../lib/invoke';
import { useUiStore } from '../stores/uiStore';

// デフォルトの invoke モックを設定する
const mockDsxCheck = vi.spyOn(invoke, 'dsxCheck');
const mockGetConfig = vi.spyOn(invoke, 'getConfig');
const mockHasGithubPat = vi.spyOn(invoke, 'hasGithubPat');
const mockSysUpdate = vi.spyOn(invoke, 'sysUpdate');
const mockDetectGithubRemote = vi.spyOn(invoke, 'detectGithubRemote');
const mockUpdateRepositoryGithub = vi.spyOn(invoke, 'updateRepositoryGithub');

const availableDsxStatus = { available: true, version: 'v0.2.3', path: '/usr/local/bin/dsx' };
const unavailableDsxStatus = { available: false, version: null, path: null };

const mockConfig = {
  repositories: [],
  settings: { stale_threshold_days: 30, fetch_on_startup: false },
  ai: { provider: 'ollama', model: 'qwen3.5:latest', ollama_url: 'http://localhost:11434' },
  github_keychain_key: 'arbor_github_pat',
};

const mockConfigWithRepos = {
  repositories: [
    { path: '/repo/arbor', name: 'arbor', github_owner: 'scott', github_repo: 'arbor-repo' },
  ],
  settings: { stale_threshold_days: 30, fetch_on_startup: false, github_keychain_key: 'arbor_github_pat' },
  ai: { provider: 'ollama', model: 'qwen3.5:latest', ollama_url: 'http://localhost:11434' },
};

function renderSettings(withToast = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Settings />
      {withToast && <ToastContainer />}
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  act(() => { useUiStore.setState({ toasts: [] }); });
  mockGetConfig.mockResolvedValue(mockConfig as never);
  mockHasGithubPat.mockResolvedValue(false as never);
  mockDsxCheck.mockResolvedValue(availableDsxStatus as never);
  mockSysUpdate.mockResolvedValue({ stdout: '', stderr: '', exit_code: 0 } as never);
  mockDetectGithubRemote.mockResolvedValue([null, null] as never);
  mockUpdateRepositoryGithub.mockResolvedValue(mockConfig as never);
});

describe('Settings — Repositories section', () => {
  it('+ Add Repository ボタンが AppBar ではなく Repositories セクション内に表示される', async () => {
    renderSettings();
    // REPOSITORIES 見出しを基点に親 section を取得してスコープを絞る
    const heading = await screen.findByText('REPOSITORIES');
    const repoSection = heading.closest('section')!;
    expect(within(repoSection).getByRole('button', { name: '+ Add Repository' })).toBeInTheDocument();
    // AppBar 内（section 外）には存在しないことも確認
    const allBtns = screen.getAllByRole('button', { name: '+ Add Repository' });
    expect(allBtns).toHaveLength(1);
  });
});

describe('Settings — dsx CLI section', () => {
  it('dsx が利用可能な場合にバージョンを表示する', async () => {
    renderSettings();
    await screen.findByText(/v0\.2\.3/);
    expect(screen.getByText(/v0\.2\.3/)).toBeInTheDocument();
  });

  it('dsx が利用可能な場合に Update ボタンを表示する', async () => {
    renderSettings();
    await screen.findByRole('button', { name: 'Update' });
    expect(screen.getByRole('button', { name: 'Update' })).toBeInTheDocument();
  });

  it('dsx が利用不可の場合に Update ボタンを表示しない', async () => {
    mockDsxCheck.mockResolvedValue(unavailableDsxStatus as never);
    renderSettings();
    // インストール案内テキストが出るまで待つ
    await screen.findByText(/dsx が見つかりません/);
    expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument();
  });

  it('Update ボタンをクリックすると sysUpdate が呼ばれる', async () => {
    renderSettings();
    const btn = await screen.findByRole('button', { name: 'Update' });
    await userEvent.click(btn);
    expect(mockSysUpdate).toHaveBeenCalledTimes(1);
  });

  it('sysUpdate 完了後に dsxCheck を再呼び出しする', async () => {
    renderSettings();
    const btn = await screen.findByRole('button', { name: 'Update' });
    await userEvent.click(btn);
    await waitFor(() => {
      // 初回 mount + update 後の再チェックで計 2 回呼ばれる
      expect(mockDsxCheck).toHaveBeenCalledTimes(2);
    });
  });

  it('sysUpdate が失敗した場合にエラートーストを表示する', async () => {
    mockSysUpdate.mockRejectedValue(new Error('network error') as never);
    renderSettings(true);
    const btn = await screen.findByRole('button', { name: 'Update' });
    await userEvent.click(btn);
    // Toast に error メッセージが表示される（String(Error) → "Error: network error"）
    await screen.findByText('Error: network error');
  });
});

describe('Settings — GitHub PAT section', () => {
  it('PAT 確認中は Checking… を表示する', async () => {
    mockHasGithubPat.mockImplementation(() => new Promise(() => {}));
    renderSettings();
    // dsx セクションが読み込まれた後は PAT の Checking… のみ残る
    await screen.findByText(/v0\.2\.3/);
    expect(screen.getByText('Checking…')).toBeInTheDocument();
  });

  it('PAT 未設定時に警告テキストを表示する', async () => {
    renderSettings();
    await screen.findByText(/PAT が設定されていません/);
  });

  it('PAT 設定済み時に保存済みテキストと Clear ボタンを表示する', async () => {
    mockHasGithubPat.mockResolvedValue(true as never);
    renderSettings();
    await screen.findByText(/PAT が保存されています/);
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
  });
});

describe('Settings — RepoCard', () => {
  it('登録済みリポジトリの owner と repo が入力欄に表示される', async () => {
    mockGetConfig.mockResolvedValue(mockConfigWithRepos as never);
    renderSettings();
    expect(await screen.findByDisplayValue('scott')).toBeInTheDocument();
    expect(screen.getByDisplayValue('arbor-repo')).toBeInTheDocument();
  });

  it('owner と repo が変更されていない時は RepoCard の Save ボタンが disabled', async () => {
    mockGetConfig.mockResolvedValue(mockConfigWithRepos as never);
    renderSettings();
    await screen.findByDisplayValue('scott');
    // PAT Save と RepoCard Save の 2 つが存在するため getAllByRole で取得
    const saveBtns = screen.getAllByRole('button', { name: 'Save' });
    // どちらも disabled（PAT 入力欄は空、RepoCard は未変更）
    saveBtns.forEach((btn) => expect(btn).toBeDisabled());
  });

  it('Detect ボタンが表示される', async () => {
    mockGetConfig.mockResolvedValue(mockConfigWithRepos as never);
    renderSettings();
    await screen.findByRole('button', { name: 'Detect' });
  });

  it('Detect ボタンをクリックすると detectGithubRemote がリポジトリのパスで呼ばれる', async () => {
    mockGetConfig.mockResolvedValue(mockConfigWithRepos as never);
    mockDetectGithubRemote.mockResolvedValue(['scott', 'arbor-repo'] as never);
    renderSettings();
    const btn = await screen.findByRole('button', { name: 'Detect' });
    await userEvent.click(btn);
    expect(mockDetectGithubRemote).toHaveBeenCalledWith('/repo/arbor');
  });
});
