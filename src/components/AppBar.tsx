import type { ReactNode } from 'react';

interface AppBarProps {
  path: ReactNode;
  actions?: ReactNode;
}

export default function AppBar({ path, actions }: AppBarProps) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      padding: '8px 16px',
      borderBottom: '1px solid var(--border)',
      background: 'var(--bg2)',
      gap: 8,
      minHeight: 40,
      flexShrink: 0,
    }}>
      <span style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: 'var(--text3)',
        flex: 1,
      }}>
        {path}
      </span>
      {actions}
    </div>
  );
}

interface AppBtnProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger';
}

export function AppBtn({ variant = 'default', children, style, ...rest }: AppBtnProps) {
  const color = variant === 'primary'
    ? 'var(--indigo-l)'
    : variant === 'danger'
    ? 'var(--red)'
    : 'var(--text2)';
  const borderColor = variant === 'primary'
    ? '#818cf850'
    : variant === 'danger'
    ? '#f8717140'
    : 'var(--border2)';

  return (
    <button
      {...rest}
      style={{
        fontSize: 10,
        fontWeight: 500,
        padding: '4px 10px',
        border: `1px solid ${borderColor}`,
        borderRadius: 'var(--r)',
        background: 'none',
        color,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </button>
  );
}
