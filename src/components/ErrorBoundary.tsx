import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** ビュー名を渡すとエラーメッセージに表示される */
  viewName?: string;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', this.props.viewName ?? 'unknown', error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          height: '100%', gap: 16, padding: 24,
        }}>
          <div style={{ fontSize: 32 }}>⚠</div>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, color: 'var(--text1)' }}>
            {this.props.viewName ? `${this.props.viewName} でエラーが発生しました` : 'エラーが発生しました'}
          </div>
          <pre style={{
            maxWidth: 600, fontSize: 11,
            color: 'var(--text3)', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            background: '#0d0f16', padding: 12, borderRadius: 6,
          }}>
            {this.state.error.message}
          </pre>
          <button
            type="button"
            onClick={this.reset}
            style={{
              padding: '6px 18px', borderRadius: 6, border: 'none',
              background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontSize: 13,
            }}
          >
            再試行
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
