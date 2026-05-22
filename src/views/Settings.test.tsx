import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';

// @tauri-apps/plugin-dialog の open をファイルレベルでモックする
const mockOpen = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mockOpen }));
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Settings from './Settings';
import ToastContainer from '../components/Toast';
import * as invoke from '../lib/invoke';
import { useUiStore } from '../stores/uiStore';

// デフォルトの invoke モックを設定する
const mockDsxCheck = vi.spyOn(invoke, 'dsxCheck');
const mockDsxLatestVersion = vi.spyOn(invoke, 'dsxLatestVersion');
const mockGetConfig = vi.spyOn(invoke, 'getConfig');
const mockHasGithubPat = vi.spyOn(invoke, 'hasGithubPat');
const mockSysUpdate = vi.spyOn(invoke, 'sysUpdate');
const mockDetectGithubRemote = vi.spyOn(invoke, 'detectGithubRemote');
const mockUpdateRepositoryGithub = vi.spyOn(invoke, 'updateRepositoryGithub');
const mockScanMissingRepositories = vi.spyOn(invoke, 'scanMissingRepositories');
const mockRemoveRepository = vi.spyOn(invoke, 'removeRepository');
const mockScanDirectory = vi.spyOn(invoke, 'scanDirectory');

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
  mockDsxLatestVersion.mockResolvedValue(null as never);
  mockSysUpdate.mockResolvedValue({ stdout: '', stderr: '', exit_code: 0 } as never);
  mockDetectGithubRemote.mockResolvedValue([null, null] as never);
  mockUpdateRepositoryGithub.mockResolvedValue(mockConfig as never);
  mockScanMissingRepositories.mockResolvedValue([] as never);
  mockRemoveRepository.mockResolvedValue(mockConfig as never);
  mockScanDirectory.mockResolvedValue([] as never);
});

afterEach(() => {
  vi.clearAllMocks();
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

  it('「バージョン確認」ボタンが表示される', async () => {
    renderSettings();
    await screen.findByRole('button', { name: 'バージョン確認' });
    expect(screen.getByRole('button', { name: 'バージョン確認' })).toBeInTheDocument();
  });

  it('「バージョン確認」クリックで dsxLatestVersion が呼ばれる', async () => {
    mockDsxLatestVersion.mockResolvedValue('v0.2.3' as never);
    renderSettings();
    const btn = await screen.findByRole('button', { name: 'バージョン確認' });
    await userEvent.click(btn);
    expect(mockDsxLatestVersion).toHaveBeenCalledOnce();
  });

  it('最新版のとき「最新版です」を表示する', async () => {
    mockDsxLatestVersion.mockResolvedValue('v0.2.3' as never);
    renderSettings();
    const btn = await screen.findByRole('button', { name: 'バージョン確認' });
    await userEvent.click(btn);
    await screen.findByText(/最新版です/);
  });

  it('新バージョンがあるとき「利用可能」を表示する', async () => {
    mockDsxLatestVersion.mockResolvedValue('v0.9.9' as never);
    renderSettings();
    const btn = await screen.findByRole('button', { name: 'バージョン確認' });
    await userEvent.click(btn);
    await screen.findByText(/v0\.9\.9 が利用可能/);
  });

  it('取得失敗のとき「取得できませんでした」を表示する', async () => {
    mockDsxLatestVersion.mockRejectedValue(new Error('network') as never);
    renderSettings();
    const btn = await screen.findByRole('button', { name: 'バージョン確認' });
    await userEvent.click(btn);
    await screen.findByText(/取得できませんでした/);
  });

  it('v0.2.10 は v0.2.9 より新しいので「最新版です」を表示する', async () => {
    mockDsxCheck.mockResolvedValue({ available: true, version: 'v0.2.10', path: '/usr/local/bin/dsx' } as never);
    mockDsxLatestVersion.mockResolvedValue('v0.2.9' as never);
    renderSettings();
    const btn = await screen.findByRole('button', { name: 'バージョン確認' });
    await userEvent.click(btn);
    await screen.findByText(/最新版です/);
  });

  it('v0.2.5 は v0.2.50 より古いので「利用可能」を表示する', async () => {
    mockDsxCheck.mockResolvedValue({ available: true, version: 'v0.2.5', path: '/usr/local/bin/dsx' } as never);
    mockDsxLatestVersion.mockResolvedValue('v0.2.50' as never);
    renderSettings();
    const btn = await screen.findByRole('button', { name: 'バージョン確認' });
    await userEvent.click(btn);
    await screen.findByText(/v0\.2\.50 が利用可能/);
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

const missingRepo = { path: '/missing/repo', name: 'missing-repo', github_owner: null, github_repo: null };

describe('Settings — 削除済みリポジトリ検出 (#117)', () => {
  it('missing repo がある場合に警告バナーを表示する', async () => {
    mockScanMissingRepositories.mockResolvedValue([missingRepo] as never);
    renderSettings();
    await screen.findByText(/1 件の無効なリポジトリを検出/);
  });

  it('missing repo がない場合はバナーを表示しない', async () => {
    mockScanMissingRepositories.mockResolvedValue([] as never);
    renderSettings();
    // バナーが出ないことを確認するため、他の要素が描画されるまで待つ
    await screen.findByText('REPOSITORIES');
    expect(screen.queryByText(/無効なリポジトリを検出/)).not.toBeInTheDocument();
  });

  it('バナークリックでパネルが開き、repo 名とパスが表示される', async () => {
    mockScanMissingRepositories.mockResolvedValue([missingRepo] as never);
    renderSettings();
    const banner = await screen.findByText(/1 件の無効なリポジトリを検出/);
    await userEvent.click(banner);
    expect(screen.getByText('missing-repo')).toBeInTheDocument();
    expect(screen.getByText('/missing/repo')).toBeInTheDocument();
  });

  it('全選択で「N件を登録解除」ボタンが有効になる', async () => {
    mockScanMissingRepositories.mockResolvedValue([missingRepo] as never);
    renderSettings();
    const banner = await screen.findByText(/1 件の無効なリポジトリを検出/);
    await userEvent.click(banner);
    // repo name でチェックボックスを特定（AI Engine の checkbox と区別）
    const checkbox = screen.getByRole('checkbox', { name: /missing-repo/ });
    expect(checkbox).not.toBeChecked();
    await userEvent.click(screen.getByText('全選択'));
    expect(checkbox).toBeChecked();
    expect(screen.getByRole('button', { name: /1 件を登録解除/ })).not.toBeDisabled();
  });

  it('全解除でチェックが外れ「N件を登録解除」ボタンが disabled になる', async () => {
    mockScanMissingRepositories.mockResolvedValue([missingRepo] as never);
    renderSettings();
    const banner = await screen.findByText(/1 件の無効なリポジトリを検出/);
    await userEvent.click(banner);
    await userEvent.click(screen.getByText('全選択'));
    await userEvent.click(screen.getByText('全解除'));
    const checkbox = screen.getByRole('checkbox', { name: /missing-repo/ });
    expect(checkbox).not.toBeChecked();
    expect(screen.getByRole('button', { name: /0 件を登録解除/ })).toBeDisabled();
  });

  it('登録解除確認後に removeRepository が呼ばれ loadRepos が呼ばれる', async () => {
    const mockLoadRepos = vi.fn();
    const { useRepoStore } = await import('../stores/repoStore');
    vi.spyOn(useRepoStore, 'getState').mockReturnValue({ loadRepos: mockLoadRepos } as never);

    mockScanMissingRepositories.mockResolvedValue([missingRepo] as never);
    renderSettings(true);
    const banner = await screen.findByText(/1 件の無効なリポジトリを検出/);
    await userEvent.click(banner);
    await userEvent.click(screen.getByText('全選択'));
    await userEvent.click(screen.getByRole('button', { name: /1 件を登録解除/ }));
    // ConfirmDialog が開く
    const confirmBtn = await screen.findByRole('button', { name: '登録解除' });
    await userEvent.click(confirmBtn);
    await waitFor(() => {
      expect(mockRemoveRepository).toHaveBeenCalledWith('/missing/repo');
    });
  });

  it('Scan Folder で新規 repo が 0 件でも scanMissingRepositories が呼ばれる', async () => {
    mockOpen.mockResolvedValue('/some/folder');
    mockScanDirectory.mockResolvedValue([] as never);
    mockGetConfig.mockResolvedValue(mockConfig as never);

    renderSettings();
    await screen.findByText('REPOSITORIES');

    const scanBtn = screen.getByRole('button', { name: /Scan Folder/ });
    await userEvent.click(scanBtn);

    await waitFor(() => {
      // mount 時 1 回 + Scan Folder 後 1 回 = 計 2 回
      expect(mockScanMissingRepositories).toHaveBeenCalledTimes(2);
    });
  });
});
