import React from 'react';

interface State {
  error: Error | null;
}

/**
 * Catches render errors below it and shows the message instead of letting
 * React unmount the whole tree (which reads as a dead white popup). The error
 * stays loud and visible — this exists to surface failures, not swallow them.
 */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[Auto-Wallet] Page render crashed:', error, info.componentStack);
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="stack stack-sm" style={{ padding: 8 }}>
          <p className="page-title" style={{ color: 'var(--danger)' }}>Something went wrong</p>
          <p className="error-text" style={{ wordBreak: 'break-word' }}>
            {this.state.error.message}
          </p>
          <button className="btn-secondary" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
