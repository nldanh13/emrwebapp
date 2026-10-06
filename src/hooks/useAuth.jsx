import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import * as api from '../api.js';

const AuthContext = createContext(null);

// Thiết bị tin cậy thì nhớ đăng nhập (mở lại không phải nhập); bị thu hồi thì quên ngay.
async function syncRememberedLogin() {
  try {
    const r = await api.getDeviceStatus();
    api.rememberAuthOnTrustedDevice(Boolean(r?.trusted) && !r?.local_only);
  } catch (_) { /* không biết thì để nguyên */ }
}

const INITIAL_STATE = { status: 'loading', user: null, authMode: null };

export function AuthProvider({ children }) {
  const [state, setState] = useState(INITIAL_STATE);

  const checkAuth = useCallback(async () => {
    const result = await api.getAuthMe();
    if (result.ok && result.data?.user) {
      setState({ status: 'authenticated', user: result.data.user, authMode: result.data.auth_mode });
      syncRememberedLogin();
    } else {
      setState({ status: 'unauthenticated', user: null, authMode: result.data?.auth_mode || null });
    }
  }, []);

  useEffect(() => { checkAuth(); }, [checkAuth]);

  useEffect(() => {
    const handler = () => setState({ status: 'unauthenticated', user: null, authMode: null });
    window.addEventListener('emr:auth-required', handler);
    return () => window.removeEventListener('emr:auth-required', handler);
  }, []);

  const login = useCallback(async (token) => {
    api.setAuthToken(token);
    const result = await api.getAuthMe();
    if (result.ok && result.data?.user) {
      setState({ status: 'authenticated', user: result.data.user, authMode: result.data.auth_mode });
      syncRememberedLogin();
      return { ok: true };
    }
    api.clearAuthToken();
    return { ok: false, message: result.data?.message || 'Mã truy cập không hợp lệ.' };
  }, []);

  const logout = useCallback(() => {
    api.clearAuthToken();
    setState({ status: 'unauthenticated', user: null, authMode: null });
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth phải được gọi bên trong AuthProvider');
  return ctx;
}
