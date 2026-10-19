import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeEach, describe, expect, it, jest, mock, spyOn, type Mock } from 'bun:test';
import { act } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import Settings from './Settings';
import ToastContainer from '../components/Toast';
import * as invoke from '../lib/invoke';
import { useEnvStore } from '../stores/envStore';
import { useRepoStore } from '../stores/repoStore';
import { useUiStore } from '../stores/uiStore';

// @tauri-apps/plugin-dialog は preload (src/test/setup.ts) でモック済み
const mockOpen = open as Mock<typeof open>;

// デフォルトの invoke モックを設定する
const mockGetConfig = spyOn(invoke, 'getConfig');
const mockScanMissingRepositories = spyOn(invoke, 'scanMissingRepositories');
const mockRemoveRepository = spyOn(invoke, 'removeRepository');
const mockUpdateSettings = spyOn(invoke, 'updateSettings');
const mockLoadRepos = mock(() => Promise.resolve());
const mockEnvRefresh = mock(() => Promise.resolve());
const mockAddRepository = spyOn(invoke, 'addRepository');

// module export への spy をファイル外へ漏らさない
afterAll(() => {
  mock.restore();
});


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
  act(() => {
    useUiStore.setState({ toasts: [] });
    // Header の pill が使う環境の状態。Settings での変更後に読み直されることを確かめる。
    useEnvStore.setState({ refresh: mockEnvRefresh });
  });
  mockGetConfig.mockResolvedValue(mockConfig as never);
  mockScanMissingRepositories.mockResolvedValue([] as never);
  mockRemoveRepository.mockResolvedValue(mockConfig as never);
  mockAddRepository.mockResolvedValue(mockConfig as never);
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

  it('+ Add Repository で選んだフォルダを登録し、一覧と環境の状態を読み直す', async () => {
    mockOpen.mockResolvedValue('D:/other/new-tool');
    setRepos([]);
    renderSettings();

    await userEvent.click(await screen.findByRole('button', { name: '+ Add Repository' }));

    await waitFor(() => expect(mockAddRepository).toHaveBeenCalledWith({ path: 'D:/other/new-tool', name: 'new-tool' }));
    await waitFor(() => expect(mockLoadRepos).toHaveBeenCalled());
    expect(mockEnvRefresh).toHaveBeenCalled();
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
    await waitFor(() => expect(mockEnvRefresh).toHaveBeenCalled());
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
    expect(mockEnvRefresh).toHaveBeenCalled();
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
    expect(mockEnvRefresh).toHaveBeenCalled();
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
  // dsx の管理（版の確認・Sys Update・Self Update）は、dsx Tools タブへ移した。
  it.each(['GitHub', 'AI Engine', 'dsx CLI'])('%s セクションは表示されない', async (title) => {
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

  it('登録解除確認後に removeRepository が呼ばれ、一覧と環境の状態を読み直す', async () => {
    setRepos([]);
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
    await waitFor(() => expect(mockEnvRefresh).toHaveBeenCalled());
    expect(mockLoadRepos).toHaveBeenCalled();
  });

});
