import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeEach, describe, expect, it, jest, mock, spyOn, type Mock } from 'bun:test';
import { act } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import Settings from './Settings';
import ToastContainer from '../components/Toast';
import * as invoke from '../lib/invoke';
import { useRepoStore } from '../stores/repoStore';
import { useUiStore } from '../stores/uiStore';

// @tauri-apps/plugin-dialog は preload (src/test/setup.ts) でモック済み
const mockOpen = open as Mock<typeof open>;

// デフォルトの invoke モックを設定する
const mockDsxCheck = spyOn(invoke, 'dsxCheck');
const mockDsxLatestVersion = spyOn(invoke, 'dsxLatestVersion');
const mockGetConfig = spyOn(invoke, 'getConfig');
const mockSysUpdate = spyOn(invoke, 'sysUpdate');
const mockScanMissingRepositories = spyOn(invoke, 'scanMissingRepositories');
const mockRemoveRepository = spyOn(invoke, 'removeRepository');
const mockUpdateSettings = spyOn(invoke, 'updateSettings');
const mockLoadRepos = mock(() => Promise.resolve());

// module export への spy をファイル外へ漏らさない
afterAll(() => {
  mock.restore();
});

const availableDsxStatus = { available: true, version: 'v0.2.3', path: '/usr/local/bin/dsx' };
const unavailableDsxStatus = { available: false, version: null, path: null, supports_run_root: false };

const mockConfig = {
  repositories: [],
  workspace: { root: 'C:/src' },
  settings: { stale_threshold_days: 30, fetch_on_startup: false },
};

const workspaceRepo = { path: 'C:/src/arbor', name: 'arbor', source: 'workspace' };
const manualRepo = { path: 'D:/other/tool', name: 'tool', source: 'manual' };

function setRepos(repos: unknown[]) {
  act(() => {
    useRepoStore.setState({ repos: repos as never, loadRepos: mockLoadRepos });
  });
}

function renderSettings(withToast = false) {
  return render(
    <>
      <Settings />
      {withToast && <ToastContainer />}
    </>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  act(() => { useUiStore.setState({ toasts: [] }); });
  mockGetConfig.mockResolvedValue(mockConfig as never);
  mockDsxCheck.mockResolvedValue(availableDsxStatus as never);
  mockDsxLatestVersion.mockResolvedValue(null as never);
  mockSysUpdate.mockResolvedValue({ stdout: '', stderr: '', exit_code: 0 } as never);
  mockScanMissingRepositories.mockResolvedValue([] as never);
  mockRemoveRepository.mockResolvedValue(mockConfig as never);
  mockUpdateSettings.mockResolvedValue(mockConfig as never);
});

afterEach(() => {
  jest.clearAllMocks();
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
    await screen.findByRole('button', { name: 'Sys Update' });
    expect(screen.getByRole('button', { name: 'Sys Update' })).toBeInTheDocument();
  });

  it('dsx が利用不可の場合に Update ボタンを表示しない', async () => {
    mockDsxCheck.mockResolvedValue(unavailableDsxStatus as never);
    renderSettings();
    // インストール案内テキストが出るまで待つ
    await screen.findByText(/dsx が見つかりません/);
    expect(screen.queryByRole('button', { name: 'Sys Update' })).not.toBeInTheDocument();
  });

  it('Update ボタンをクリックすると確認ダイアログが表示される', async () => {
    renderSettings();
    const btn = await screen.findByRole('button', { name: 'Sys Update' });
    await userEvent.click(btn);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(mockSysUpdate).not.toHaveBeenCalled();
  });

  it('確認ダイアログで「実行」をクリックすると sysUpdate が呼ばれる', async () => {
    renderSettings();
    const btn = await screen.findByRole('button', { name: 'Sys Update' });
    await userEvent.click(btn);
    await userEvent.click(screen.getByRole('button', { name: '実行' }));
    expect(mockSysUpdate).toHaveBeenCalledTimes(1);
  });

  it('確認ダイアログでキャンセルすると sysUpdate が呼ばれない', async () => {
    renderSettings();
    const btn = await screen.findByRole('button', { name: 'Sys Update' });
    await userEvent.click(btn);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockSysUpdate).not.toHaveBeenCalled();
  });

  it('sysUpdate 完了後に dsxCheck を再呼び出しする', async () => {
    renderSettings();
    const btn = await screen.findByRole('button', { name: 'Sys Update' });
    await userEvent.click(btn);
    await userEvent.click(screen.getByRole('button', { name: '実行' }));
    await waitFor(() => {
      // 初回 mount + update 後の再チェックで計 2 回呼ばれる
      expect(mockDsxCheck).toHaveBeenCalledTimes(2);
    });
  });

  it('sysUpdate が失敗した場合にエラートーストを表示する', async () => {
    mockSysUpdate.mockRejectedValue(new Error('network error') as never);
    renderSettings(true);
    const btn = await screen.findByRole('button', { name: 'Sys Update' });
    await userEvent.click(btn);
    await userEvent.click(screen.getByRole('button', { name: '実行' }));
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
    expect(mockDsxLatestVersion).toHaveBeenCalledTimes(1);
  });

  it('最新版のとき「最新版です」を表示する', async () => {
    mockDsxLatestVersion.mockResolvedValue('v0.2.3' as never);
    renderSettings();
    const btn = await screen.findByRole('button', { name: 'バージョン確認' });
    await userEvent.click(btn);
    await screen.findByText(/最新版です/);
  });

  it('新バージョンがあるとき「利用可能」と「Self Update」ボタンを表示する', async () => {
    mockDsxLatestVersion.mockResolvedValue('v0.9.9' as never);
    renderSettings();
    const btn = await screen.findByRole('button', { name: 'バージョン確認' });
    await userEvent.click(btn);
    await screen.findByText(/v0\.9\.9 が利用可能/);
    expect(screen.getByRole('button', { name: 'Self Update' })).toBeInTheDocument();
  });

  it('「Self Update」クリックで確認ダイアログが表示される', async () => {
    const mockDsxSelfUpdate = spyOn(invoke, 'dsxSelfUpdate').mockResolvedValue({} as never);
    mockDsxLatestVersion.mockResolvedValue('v0.9.9' as never);
    renderSettings();
    await userEvent.click(await screen.findByRole('button', { name: 'バージョン確認' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Self Update' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(mockDsxSelfUpdate).not.toHaveBeenCalled();
  });

  it('「Self Update」確認後に dsxSelfUpdate が呼ばれる', async () => {
    const mockDsxSelfUpdate = spyOn(invoke, 'dsxSelfUpdate').mockResolvedValue({} as never);
    mockDsxLatestVersion.mockResolvedValue('v0.9.9' as never);
    renderSettings();
    await userEvent.click(await screen.findByRole('button', { name: 'バージョン確認' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Self Update' }));
    await userEvent.click(screen.getByRole('button', { name: '実行' }));
    expect(mockDsxSelfUpdate).toHaveBeenCalledTimes(1);
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

describe('Settings — RepoCard', () => {
  it('自動検出と手動追加のリポジトリを、名前・パス・種別つきで表示する', async () => {
    setRepos([workspaceRepo, manualRepo]);
    renderSettings();

    expect(await screen.findByText('arbor')).toBeInTheDocument();
    expect(screen.getByText('C:/src/arbor')).toBeInTheDocument();
    expect(screen.getByText('tool')).toBeInTheDocument();
    expect(screen.getByText('D:/other/tool')).toBeInTheDocument();
    expect(screen.getByText('auto')).toBeInTheDocument();
    expect(screen.getByText('manual')).toBeInTheDocument();
  });

  it('Remove は手動追加のリポジトリにだけ表示し、そのパスで removeRepository を呼ぶ', async () => {
    setRepos([workspaceRepo, manualRepo]);
    renderSettings();

    const removeButtons = await screen.findAllByRole('button', { name: 'Remove' });
    expect(removeButtons).toHaveLength(1);
    await userEvent.click(removeButtons[0]);

    expect(mockRemoveRepository).toHaveBeenCalledWith('D:/other/tool');
  });

  it('リポジトリが無いときは、設定を促すメッセージを表示する', async () => {
    setRepos([]);
    renderSettings();

    expect(await screen.findByText(/No repositories found/)).toBeInTheDocument();
  });
});

describe('Settings — Workspace section', () => {
  it('設定済みの root を表示し、Disable を出す', async () => {
    renderSettings();

    expect(await screen.findByText('C:/src')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disable' })).toBeInTheDocument();
  });

  it('root が空（無効）のときは、その旨を表示し、Disable を出さない', async () => {
    mockGetConfig.mockResolvedValue({ ...mockConfig, workspace: { root: '' } } as never);
    renderSettings();

    expect(await screen.findByText('（自動検出は無効）')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument();
  });

  it('Change… で選んだフォルダを root として保存し、一覧を再読み込みする', async () => {
    mockOpen.mockResolvedValue('/new/root');
    mockUpdateSettings.mockResolvedValue({ ...mockConfig, workspace: { root: '/new/root' } } as never);
    setRepos([]);
    renderSettings(true);

    await userEvent.click(await screen.findByRole('button', { name: 'Change…' }));

    await waitFor(() => expect(mockUpdateSettings).toHaveBeenCalledWith({ workspaceRoot: '/new/root' }));
    expect(mockLoadRepos).toHaveBeenCalled();
    expect(await screen.findByText('/new/root')).toBeInTheDocument();
    expect(await screen.findByText('Workspace root を更新しました')).toBeInTheDocument();
  });

  it('フォルダ選択を取り消したら、何も保存しない', async () => {
    mockOpen.mockResolvedValue(null);
    renderSettings();

    await userEvent.click(await screen.findByRole('button', { name: 'Change…' }));

    expect(mockUpdateSettings).not.toHaveBeenCalled();
  });

  it('Disable は空文字列を保存して自動検出を無効にする', async () => {
    mockUpdateSettings.mockResolvedValue({ ...mockConfig, workspace: { root: '' } } as never);
    setRepos([]);
    renderSettings(true);

    await userEvent.click(await screen.findByRole('button', { name: 'Disable' }));

    await waitFor(() => expect(mockUpdateSettings).toHaveBeenCalledWith({ workspaceRoot: '' }));
    expect(await screen.findByText('自動検出を無効にしました')).toBeInTheDocument();
  });

  it('保存に失敗したらエラーを通知し、表示中の root を変えない', async () => {
    mockOpen.mockResolvedValue('/not/a/dir');
    mockUpdateSettings.mockRejectedValue('workspace root がディレクトリではありません: /not/a/dir' as never);
    renderSettings(true);

    await userEvent.click(await screen.findByRole('button', { name: 'Change…' }));

    expect(await screen.findByText(/ディレクトリではありません/)).toBeInTheDocument();
    expect(screen.getByText('C:/src')).toBeInTheDocument();
  });
});

describe('Settings — 削除済みの設定項目', () => {
  it.each(['GitHub', 'AI Engine'])('%s セクションは表示されない', async (title) => {
    renderSettings();
    await screen.findByText('REPOSITORIES');
    expect(screen.queryByText(title)).toBeNull();
  });
});

const missingRepo = { path: '/missing/repo', name: 'missing-repo' };

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
    const mockLoadRepos = mock();
    const { useRepoStore } = await import('../stores/repoStore');
    spyOn(useRepoStore, 'getState').mockReturnValue({ loadRepos: mockLoadRepos } as never);

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

});
