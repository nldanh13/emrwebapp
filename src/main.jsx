import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import AppErrorBoundary from './components/AppErrorBoundary.jsx';
import LoginScreen from './components/LoginScreen.jsx';
import { AuthProvider, useAuth } from './hooks/useAuth.jsx';
import { C, FONT_UI } from './tokens.js';
import { Spinner } from './components/shared.jsx';
import './styles/app.css';

function AuthGate() {
  const { status } = useAuth();
  if (status === 'loading') {
    return (
      <div style={{ fontFamily: FONT_UI, background: C.bg, height: '100vh', display: 'grid', placeItems: 'center', color: C.text3 }}>
        <Spinner size={20} />
      </div>
    );
  }
  if (status === 'unauthenticated') return <LoginScreen />;
  return <App />;
}

const rootElement = document.getElementById('root');

createRoot(rootElement).render(
  <StrictMode>
    <AppErrorBoundary>
      <AuthProvider>
        <AuthGate />
      </AuthProvider>
    </AppErrorBoundary>
  </StrictMode>
);

window.__EMR_APP_MOUNTED__ = true;
if (window.__EMR_BOOTSTRAP_TIMER__) window.clearTimeout(window.__EMR_BOOTSTRAP_TIMER__);
