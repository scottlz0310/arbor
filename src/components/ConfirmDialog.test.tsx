import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { act } from 'react';
import ConfirmDialog from './ConfirmDialog';

function renderDialog(overrides?: Partial<Parameters<typeof ConfirmDialog>[0]>) {
  const props = {
    title: 'Delete branch',
    message: 'Are you sure?',
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  const { unmount } = render(<ConfirmDialog {...props} />);
  return { ...props, unmount };
}

describe('ConfirmDialog', () => {
  it('renders title and message', () => {
    renderDialog();
    expect(screen.getByText('Delete branch')).toBeInTheDocument();
    expect(screen.getByText('Are you sure?')).toBeInTheDocument();
  });

  it('shows default confirm label', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
  });

  it('shows custom confirm label', () => {
    renderDialog({ confirmLabel: 'Delete' });
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('calls onConfirm when confirm button clicked', async () => {
    const { onConfirm } = renderDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when cancel button clicked', async () => {
    const { onCancel } = renderDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not call onCancel when confirm is clicked', async () => {
    const { onCancel } = renderDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe('ConfirmDialog — アクセシビリティ', () => {
  it('role="dialog" と aria-modal="true" が設定されている', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('aria-labelledby がタイトル要素を参照している', () => {
    renderDialog({ title: 'Test Title' });
    const dialog = screen.getByRole('dialog');
    const labelId = dialog.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    const titleEl = document.getElementById(labelId!);
    expect(titleEl?.textContent).toBe('Test Title');
  });

  it('マウント時に最初のボタン（Cancel）へフォーカスが当たる', () => {
    renderDialog();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('Escape キーで onCancel が呼ばれる', async () => {
    const { onCancel } = renderDialog();
    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Tab キーでフォーカスが Cancel → Confirm → Cancel と循環する', async () => {
    renderDialog();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    // 初期フォーカスは Cancel
    expect(document.activeElement).toBe(cancel);
    // Tab → Confirm へ移動
    await userEvent.keyboard('{Tab}');
    expect(document.activeElement).toBe(confirm);
    // Tab → Cancel へ循環
    await userEvent.keyboard('{Tab}');
    expect(document.activeElement).toBe(cancel);
  });

  it('Shift+Tab キーで逆順に循環する', async () => {
    renderDialog();
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    // 初期フォーカスは Cancel → Shift+Tab で末尾（Confirm）へ循環
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
    expect(document.activeElement).toBe(confirm);
  });

  it('アンマウント時に呼び出し元へフォーカスが復帰する', () => {
    // ダイアログ呼び出し前にフォーカスを当てるトリガーボタンを作成する
    const trigger = document.createElement('button');
    trigger.textContent = 'Open Dialog';
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = renderDialog();
    // ダイアログが開いた後は Cancel にフォーカスが移る
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));

    act(() => { unmount(); });
    // アンマウント後はトリガーへ復帰
    expect(document.activeElement).toBe(trigger);
    document.body.removeChild(trigger);
  });
});
