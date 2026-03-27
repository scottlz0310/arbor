import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import ToastContainer from './Toast';
import { useUiStore } from '../stores/uiStore';

beforeEach(() => {
  // Use fake timers to prevent the 4 s auto-dismiss setTimeout from leaking.
  vi.useFakeTimers();
  act(() => {
    useUiStore.setState({ toasts: [] });
  });
});

afterEach(() => {
  vi.useRealTimers();
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
