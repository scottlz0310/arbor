import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach } from 'vitest';
import { act } from 'react';
import ToastContainer from './Toast';
import { useUiStore } from '../stores/uiStore';

// Reset Zustand store state before each test.
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

  it('dismisses a toast when clicked', async () => {
    act(() => {
      useUiStore.getState().addToast('Dismiss me', 'info');
    });
    render(<ToastContainer />);
    await userEvent.click(screen.getByText('Dismiss me'));
    expect(screen.queryByText('Dismiss me')).not.toBeInTheDocument();
  });
});
