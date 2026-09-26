import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import AppErrorBoundary from './components/AppErrorBoundary.jsx';
import LoginScreen from './components/LoginScreen.jsx';
import { AuthProvider, useAuth } from './hooks/useAuth.jsx';
import { C, FONT_UI } from './tokens.js';
import { Spinner } from './components/shared.jsx';
import { loadRouteCustomizations } from './config/routes.js';
import { getRouteTable } from './api.js';
import './styles/app.css';

// Nạp phần đường dùng tự cài (tab Đường dùng) trước khi hiện app; tối đa 3 giây,
// lỗi thì vẫn chạy với bảng chuẩn.
function RouteModelGate({ children }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let done = false;
    const finish = () => { if (!done) { done = true; setReady(true); } };
    const timer = window.setTimeout(finish, 3000);
    loadRouteCustomizations(getRouteTable).finally(() => { window.clearTimeout(timer); finish(); });
    return () => window.clearTimeout(timer);
  }, []);
  if (!ready) {
    return (
      <div style={{ fontFamily: FONT_UI, background: C.bg, height: '100vh', display: 'grid', placeItems: 'center', color: C.text3 }}>
        <Spinner size={20} />
      </div>
    );
  }
  return children;
}

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
  return <RouteModelGate><App /></RouteModelGate>;
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
