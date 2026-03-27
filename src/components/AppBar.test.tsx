import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import AppBar, { AppBtn } from './AppBar';

describe('AppBar', () => {
  it('renders path content', () => {
    render(<AppBar path="repo/main" />);
    expect(screen.getByText('repo/main')).toBeInTheDocument();
  });

  it('renders actions slot when provided', () => {
    render(<AppBar path="x" actions={<button>Fetch</button>} />);
    expect(screen.getByRole('button', { name: 'Fetch' })).toBeInTheDocument();
  });

  it('renders without actions slot', () => {
    const { container } = render(<AppBar path="x" />);
    // Only the path span is present, no extra buttons
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });
});

describe('AppBtn', () => {
  it('renders children', () => {
    render(<AppBtn>Click me</AppBtn>);
    expect(screen.getByRole('button', { name: 'Click me' })).toBeInTheDocument();
  });

  it('calls onClick when clicked', async () => {
    const onClick = vi.fn();
    render(<AppBtn onClick={onClick}>Go</AppBtn>);
    await userEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('forwards disabled attribute', () => {
    render(<AppBtn disabled>Disabled</AppBtn>);
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
