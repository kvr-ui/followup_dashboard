import React from 'react';

/**
 * Catches render/lifecycle errors in the subtree so one bad record or a null-access
 * bug shows a recoverable message instead of white-screening the whole dashboard.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('UI crashed:', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="card" style={{ padding: '20px', margin: '24px auto', maxWidth: 520 }}>
          <h2 style={{ marginTop: 0 }}>Something went wrong</h2>
          <p className="subtle">
            This view hit an error and stopped. The rest of the app is fine — reload to try again.
          </p>
          <button className="btn" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
