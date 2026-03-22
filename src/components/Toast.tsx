import { useUiStore } from '../stores/uiStore';
import type { Toast } from '../types';

const kindStyle: Record<Toast['kind'], { border: string; color: string; bg: string }> = {
  success: { bg: 'var(--green-bg)',  border: '#4ade8030', color: 'var(--green)' },
  error:   { bg: 'var(--red-bg)',    border: '#f8717130', color: 'var(--red)' },
  info:    { bg: 'var(--indigo-bg)', border: '#818cf830', color: 'var(--indigo-l)' },
};

export default function ToastContainer() {
  const { toasts, dismissToast } = useUiStore();

  if (toasts.length === 0) return null;

  return (
    <div style={{
      position: 'fixed', bottom: 20, right: 20,
      display: 'flex', flexDirection: 'column', gap: 8,
      zIndex: 2000,
    }}>
      {toasts.map((t) => {
        const s = kindStyle[t.kind];
        return (
          <div
            key={t.id}
            onClick={() => dismissToast(t.id)}
            style={{
              background: s.bg,
              border: `1px solid ${s.border}`,
              color: s.color,
              borderRadius: 'var(--r)',
              padding: '9px 14px',
              fontSize: 12,
              cursor: 'pointer',
              maxWidth: 340,
              lineHeight: 1.5,
            }}
          >
            {t.message}
          </div>
        );
      })}
    </div>
  );
}
