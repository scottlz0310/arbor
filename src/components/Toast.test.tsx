import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'bun:test';
import { act } from 'react';
import ToastContainer from './Toast';
import { useUiStore } from '../stores/uiStore';

// addToast の 4 s auto-dismiss setTimeout は実タイマーのまま許容する。
// 発火時点でテストは終了しており、store 更新のみで React へは影響しない
// （setTimeout の no-op 化は React のスケジューリングも壊すため不可）。
beforeEach(() => {
  act(() => {
    useUiStore.setState({ toasts: [] });
  });
});

describe('ToastContainer', () => {
  it('renders nothing when there are no toasts', () => {
    const { container } = render(<ToastContainer />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a toast message', () => {
    act(() => {
      useUiStore.getState().addToast('Build succeeded', 'success');
    });
    render(<ToastContainer />);
    expect(screen.getByText('Build succeeded')).toBeInTheDocument();
  });

  it('renders multiple toasts', () => {
    act(() => {
      useUiStore.getState().addToast('First', 'info');
      useUiStore.getState().addToast('Second', 'error');
    });
    render(<ToastContainer />);
    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
  });

  it('dismisses a toast when clicked', () => {
    act(() => {
      useUiStore.getState().addToast('Dismiss me', 'info');
    });
    render(<ToastContainer />);
    fireEvent.click(screen.getByText('Dismiss me'));
    expect(screen.queryByText('Dismiss me')).not.toBeInTheDocument();
  });
});
