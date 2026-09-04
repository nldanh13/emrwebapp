import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import AppErrorBoundary from './components/AppErrorBoundary.jsx';
import './styles/app.css';

const rootElement = document.getElementById('root');

createRoot(rootElement).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>
);

window.__EMR_APP_MOUNTED__ = true;
if (window.__EMR_BOOTSTRAP_TIMER__) window.clearTimeout(window.__EMR_BOOTSTRAP_TIMER__);
