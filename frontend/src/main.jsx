import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/components.css';
import './styles/views/legacy.css';
import './styles/views/login.css';
import './styles/views/drawer.css';
import './styles/views/calls.css';
import './styles/views/lead.css';
import './styles/views/marketing.css';
import './styles/views/apidocs.css';
import './styles/views/agent.css';
import './styles/views/vsl.css';
import './styles/views/funnel.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
