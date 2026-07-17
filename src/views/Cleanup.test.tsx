import { act } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';
import * as invoke from '../lib/invoke';
import { useUiStore } from '../stores/uiStore';
import type {
  CleanupCandidate,
  CleanupExecutionItemResult,
  CleanupPreview,
  RepoCleanupPreview,
} from '../types';
import Cleanup from './Cleanup';

const mockCleanupPreview = spyOn(invoke, 'cleanupPreview');
const mockCleanupExecute = spyOn(invoke, 'cleanupExecute');

// module export への spy をファイル外へ漏らさない
afterAll(() => {
  mock.restore();
});

function makeCandidate(overrides: Partial<CleanupCandidate> = {}): CleanupCandidate {
  return {
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
    ...overrides,
  };
}

function makeRepo(
  repoPath: string,
  repoName: string,
  candidates: CleanupCandidate[],
  overrides: Partial<RepoCleanupPreview> = {},
): RepoCleanupPreview {
  return {
    repo_path: repoPath,
    repo_name: repoName,
    candidates,
    remote_errors: [],
    error: null,
    ...overrides,
  };
}

function makePreview(repos: RepoCleanupPreview[]): CleanupPreview {
  return { repos, generated_at: 1_700_000_100 };
}

function defaultPreview(): CleanupPreview {
  const repoAMerged = makeCandidate();
  const repoAStale = makeCandidate({
    ref_name: 'feature/stale',
    kind: 'stale',
    is_merged: false,
    stale_days: 45,
  });
  const repoABlocked = makeCandidate({
    ref_name: 'feature/current',
    blocked: ['current_branch'],
  });
  const repoARemote = makeCandidate({
    ref_name: 'origin/removed',
    operation: 'prune_remote_tracking_ref',
    kind: 'stale_remote_tracking',
    remote_name: 'origin',
    is_merged: false,
  });
  const repoBMerged = makeCandidate({
    repo_path: '/work/clone-b/a',
    repo_name: 'repo-b',
  });
  const repoBRemote = makeCandidate({
    repo_path: '/work/clone-b/a',
    repo_name: 'repo-b',
    ref_name: 'fork/removed',
    operation: 'prune_remote_tracking_ref',
    kind: 'stale_remote_tracking',
    remote_name: 'fork',
    is_merged: false,
  });
  return makePreview([
    makeRepo('/repos/a', 'repo-a', [repoAMerged, repoAStale, repoABlocked, repoARemote]),
    makeRepo('/work/clone-b/a', 'repo-b', [repoBMerged, repoBRemote]),
  ]);
}

function resultItem(
  candidate: CleanupCandidate,
  overrides: Partial<CleanupExecutionItemResult> = {},
): CleanupExecutionItemResult {
  return {
    repo_path: candidate.repo_path,
    repo_name: candidate.repo_name,
    ref_name: candidate.ref_name,
    operation: candidate.operation,
    status: 'success',
    reason: null,
    error: null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  act(() => {
    useUiStore.setState({ toasts: [], dsxProgress: [], dsxRunning: false });
  });
  mockCleanupPreview.mockResolvedValue(defaultPreview());
  mockCleanupExecute.mockResolvedValue({ items: [], completed_at: 1_700_000_200 });
});

describe('Cleanup — repo 横断 preview', () => {
  it('複数 repo・同名 branch・複数 remote を一画面で識別表示する', async () => {
    render(<Cleanup />);

    expect(await screen.findAllByText('repo-a')).not.toHaveLength(0);
    expect(screen.getAllByText('repo-b')).not.toHaveLength(0);
    expect(screen.getAllByText('feature/done')).toHaveLength(2);
    expect(screen.getByText('origin/removed')).toBeInTheDocument();
    expect(screen.getByText('fork/removed')).toBeInTheDocument();
    expect(screen.getAllByText('/repos/a')).not.toHaveLength(0);
    expect(screen.getAllByText('/work/clone-b/a')).not.toHaveLength(0);
    expect(mockCleanupPreview).toHaveBeenCalledTimes(1);
  });

  it('同名 repo・同名 branch を repo path で識別できる', async () => {
    mockCleanupPreview.mockResolvedValue(makePreview([
      makeRepo('/repos/a', 'shared-name', [makeCandidate({ repo_name: 'shared-name' })]),
      makeRepo('/work/a', 'shared-name', [makeCandidate({ repo_path: '/work/a', repo_name: 'shared-name' })]),
    ]));

    render(<Cleanup />);

    expect(await screen.findByRole('checkbox', { name: 'Select shared-name /repos/a feature/done' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select shared-name /work/a feature/done' })).toBeChecked();
  });

  it('local branch と remote-tracking ref を別カテゴリで表示する', async () => {
    render(<Cleanup />);

    const localSection = await screen.findByRole('region', { name: 'LOCAL BRANCHES' });
    const remoteSection = screen.getByRole('region', { name: 'REMOTE-TRACKING REFS' });
    expect(within(localSection).getByText('feature/stale')).toBeInTheDocument();
    expect(within(remoteSection).getByText('origin/removed')).toBeInTheDocument();
  });

  it('repo error と remote error を repo 単位で表示する', async () => {
    mockCleanupPreview.mockResolvedValue(makePreview([
      makeRepo('/repos/a', 'repo-a', [], {
        remote_errors: [{ remote: 'origin', error: 'authentication failed' }],
      }),
      makeRepo('/repos/b', 'repo-b', [], { error: 'repository not found' }),
    ]));

    render(<Cleanup />);

    expect(await screen.findByText(/remote origin: authentication failed/)).toBeInTheDocument();
    expect(screen.getByText(/repository: repository not found/)).toBeInTheDocument();
    expect(screen.getByText('/repos/a')).toBeInTheDocument();
    expect(screen.getByText('/repos/b')).toBeInTheDocument();
  });
});

describe('Cleanup — 選択と安全条件', () => {
  it('未ブロックの merged local branch だけを初期選択する', async () => {
    render(<Cleanup />);

    expect(await screen.findByRole('checkbox', { name: 'Select repo-a /repos/a feature/done' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select repo-b /work/clone-b/a feature/done' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select repo-a /repos/a feature/stale' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select repo-a /repos/a origin/removed' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Execute selected (2)' })).toBeEnabled();
  });

  it('安全条件に該当する候補は選択不可で理由を表示する', async () => {
    render(<Cleanup />);

    const blocked = await screen.findByRole('checkbox', { name: 'Select repo-a /repos/a feature/current' });
    expect(blocked).toBeDisabled();
    expect(screen.getByText(/Selection blocked: currently checked out/)).toBeInTheDocument();
  });

  it('stale と remote-tracking ref はユーザーが明示選択できる', async () => {
    const user = userEvent.setup();
    render(<Cleanup />);

    await user.click(await screen.findByRole('checkbox', { name: 'Select repo-a /repos/a feature/stale' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select repo-a /repos/a origin/removed' }));

    expect(screen.getByRole('button', { name: 'Execute selected (4)' })).toBeEnabled();
  });
});

describe('Cleanup — 確認と実行結果', () => {
  it('確認画面を repo 単位でグループ化し、repo / remote / ref / operation を表示する', async () => {
    const user = userEvent.setup();
    render(<Cleanup />);
    await user.click(await screen.findByRole('checkbox', { name: 'Select repo-a /repos/a origin/removed' }));
    await user.click(screen.getByRole('button', { name: 'Execute selected (3)' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('repo-a')).toBeInTheDocument();
    expect(within(dialog).getByText('repo-b')).toBeInTheDocument();
    expect(within(dialog).getByText('Local deletion: 1 · Remote-tracking prune: 1')).toBeInTheDocument();
    expect(within(dialog).getByText(/repo-a \/ origin \/ origin\/removed/)).toBeInTheDocument();
    expect(within(dialog).getByText(/repo-b \/ local \/ feature\/done/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Selection blocked \/ skipped \(1\)/)).toBeInTheDocument();
    expect(within(dialog).getByText(/remote server branches/)).toBeInTheDocument();
  });

  it('選択対象を一括 execute し、部分成功・skip・失敗を表示して再 preview する', async () => {
    const user = userEvent.setup();
    const preview = defaultPreview();
    mockCleanupPreview.mockResolvedValue(preview);
    const mergedA = preview.repos[0].candidates[0];
    const staleA = preview.repos[0].candidates[1];
    const mergedB = preview.repos[1].candidates[0];
    mockCleanupExecute.mockResolvedValue({
      items: [
        resultItem(mergedA),
        resultItem(staleA, { status: 'skipped', reason: 'state changed after preview' }),
        resultItem(mergedB, { status: 'failed', error: 'delete failed' }),
      ],
      completed_at: 1_700_000_200,
    });
    render(<Cleanup />);
    await user.click(await screen.findByRole('checkbox', { name: 'Select repo-a /repos/a feature/stale' }));
    await user.click(screen.getByRole('button', { name: 'Execute selected (3)' }));
    await user.click(screen.getByRole('button', { name: 'Execute cleanup' }));

    await waitFor(() => {
      expect(mockCleanupExecute).toHaveBeenCalledWith([mergedA, staleA, mergedB]);
    });
    expect(await screen.findByText('1 succeeded · 1 skipped · 1 failed · completed', { exact: false })).toBeInTheDocument();
    const results = screen.getByRole('region', { name: 'Cleanup execution results' });
    expect(within(results).getAllByText('/repos/a')).toHaveLength(2);
    expect(within(results).getByText('/work/clone-b/a')).toBeInTheDocument();
    expect(screen.getByText('state changed after preview')).toBeInTheDocument();
    expect(screen.getByText('delete failed')).toBeInTheDocument();
    expect(mockCleanupPreview).toHaveBeenCalledTimes(2);
  });

  it('再スキャンで preview を更新し、初期選択を再計算する', async () => {
    const user = userEvent.setup();
    const first = makePreview([makeRepo('/repos/a', 'repo-a', [makeCandidate()])]);
    const secondCandidate = makeCandidate({ ref_name: 'feature/new' });
    const second = makePreview([makeRepo('/repos/a', 'repo-a', [secondCandidate])]);
    mockCleanupPreview.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    render(<Cleanup />);
    expect(await screen.findByText('feature/done')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Rescan' }));

    expect(await screen.findByText('feature/new')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select repo-a /repos/a feature/new' })).toBeChecked();
    expect(screen.queryByText('feature/done')).not.toBeInTheDocument();
  });

  it('再スキャン失敗時は古い候補と選択を破棄する', async () => {
    const user = userEvent.setup();
    mockCleanupPreview
      .mockResolvedValueOnce(makePreview([makeRepo('/repos/a', 'repo-a', [makeCandidate()])]))
      .mockRejectedValueOnce(new Error('preview unavailable'));
    render(<Cleanup />);
    expect(await screen.findByText('feature/done')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Rescan' }));

    await waitFor(() => {
      expect(screen.queryByText('feature/done')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Execute selected (0)' })).toBeDisabled();
    expect(useUiStore.getState().toasts.some((toast) => toast.message.includes('preview unavailable')))
      .toBe(true);
  });
});
