import { useState } from 'react';
import { C, FONT_UI, FS } from '../tokens.js';
import { useAuth } from '../hooks/useAuth.jsx';
import { Btn, Spinner } from './shared.jsx';
import * as api from '../api.js';

const INPUT = (error) => ({
  width: '100%', boxSizing: 'border-box', padding: '9px 10px', borderRadius: 6,
  border: `1px solid ${error ? C.redBorder : C.border}`, fontSize: FS.md, fontFamily: 'inherit',
  color: C.text, background: C.surface2, marginBottom: 10,
});
const LABEL = { display: 'block', fontSize: FS.xs, fontWeight: 700, color: C.text2, marginBottom: 5 };

// Mặc định đăng nhập bằng tên + mật khẩu (dễ nhớ khi dùng ở máy bất kỳ trong bệnh viện);
// vẫn cho dùng mã truy cập cho tài khoản chưa đặt mật khẩu.
export default function LoginScreen() {
  const { login } = useAuth();
  const [mode, setMode] = useState('password'); // password | token
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (mode === 'password') {
      if (!username.trim() || !password) { setError('Nhập tên đăng nhập và mật khẩu.'); return; }
      setSubmitting(true);
      const r = await api.loginWithPassword(username.trim(), password);
      if (!r.ok) { setError(r.message); setSubmitting(false); return; }
      const result = await login(r.token);
      if (!result.ok) { setError(result.message || 'Không đăng nhập được.'); setSubmitting(false); }
      return;
    }
    const cleaned = token.trim();
    if (!cleaned) { setError('Nhập mã truy cập được cấp.'); return; }
    setSubmitting(true);
    const result = await login(cleaned);
    if (!result.ok) {
      setError(result.message || 'Mã truy cập không hợp lệ.');
      setSubmitting(false);
    }
  };

  const switchMode = () => { setMode(m => (m === 'password' ? 'token' : 'password')); setError(''); };

  return (
    <div style={{
      fontFamily: FONT_UI, background: C.bg, color: C.text, height: '100vh',
      display: 'grid', placeItems: 'center', padding: 16,
    }}>
      <form onSubmit={handleSubmit} style={{
        width: '100%', maxWidth: 360, background: C.surface, border: `1px solid ${C.border2}`,
        borderRadius: 10, padding: 24, boxShadow: C.shadow2,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
          <div style={{ width: 36, height: 36, borderRadius: 8, background: C.blue, display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 700, fontSize: FS.xl }}>E</div>
          <div>
            <div style={{ fontSize: FS.xl, fontWeight: 700, letterSpacing: '-0.02em' }}>Data Hub</div>
            <div style={{ fontSize: FS.xs, color: C.text3, marginTop: 2 }}>Đăng nhập để tiếp tục</div>
          </div>
        </div>

        {mode === 'password' ? (
          <>
            <label htmlFor="login-username" style={LABEL}>Tên đăng nhập</label>
            <input id="login-username" autoFocus autoComplete="username" value={username}
              onChange={e => { setUsername(e.target.value); if (error) setError(''); }} style={INPUT(error)} />
            <label htmlFor="login-password" style={LABEL}>Mật khẩu</label>
            <input id="login-password" type="password" autoComplete="current-password" value={password}
              onChange={e => { setPassword(e.target.value); if (error) setError(''); }} style={INPUT(error)} />
          </>
        ) : (
          <>
            <label htmlFor="login-token" style={LABEL}>Mã truy cập</label>
            <input id="login-token" type="password" autoFocus autoComplete="current-password" value={token}
              onChange={e => { setToken(e.target.value); if (error) setError(''); }}
              placeholder="Mã được cấp cho bạn" style={INPUT(error)} />
          </>
        )}
        {error && <div role="alert" style={{ fontSize: FS.xs, color: C.red, marginBottom: 10 }}>{error}</div>}

        <Btn type="submit" variant="solidPrimary" disabled={submitting} style={{ width: '100%', marginTop: 4, padding: '9px 0' }}>
          {submitting ? <><Spinner size={12} /> Đang kiểm tra...</> : 'Đăng nhập'}
        </Btn>

        <button type="button" onClick={switchMode} style={{
          marginTop: 12, border: 0, background: 'none', color: C.blue, cursor: 'pointer', fontSize: FS.xs, padding: 0, fontFamily: 'inherit',
        }}>
          {mode === 'password' ? 'Đăng nhập bằng mã truy cập' : 'Đăng nhập bằng tên và mật khẩu'}
        </button>

        <div style={{ fontSize: FS.xs, color: C.text3, marginTop: 10, lineHeight: 1.5 }}>
          Chưa có tài khoản hoặc quên mật khẩu? Liên hệ quản trị hệ thống.
        </div>
      </form>
    </div>
  );
}
