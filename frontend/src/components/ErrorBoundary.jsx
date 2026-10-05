import React from 'react';
import EmptyState from './ui/EmptyState';
import '../styles/views/reports.css';

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
        <div className="crash-wrap">
          <EmptyState title="Something went wrong">
            <p>This view hit an error and stopped. The rest of the app is fine — reload to try again.</p>
            <button onClick={() => this.setState({ error: null })}>Try again</button>
          </EmptyState>
        </div>
      );
    }
    return this.props.children;
  }
}
