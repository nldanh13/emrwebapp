import { useState } from 'react';
import { C, FONT_UI } from '../tokens.js';
import { useAuth } from '../hooks/useAuth.jsx';
import { Btn, Spinner } from './shared.jsx';

export default function LoginScreen() {
  const { login } = useAuth();
  const [token, setToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    const cleaned = token.trim();
    if (!cleaned) { setError('Nhập mã truy cập được cấp.'); return; }
    setSubmitting(true);
    setError('');
    const result = await login(cleaned);
    if (!result.ok) {
      setError(result.message || 'Mã truy cập không hợp lệ.');
      setSubmitting(false);
    }
  };

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
          <div style={{ width: 36, height: 36, borderRadius: 8, background: C.blue, display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 750, fontSize: 17 }}>E</div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 750, letterSpacing: '-0.02em' }}>Data Hub</div>
            <div style={{ fontSize: 11, color: C.text3, marginTop: 2 }}>Đăng nhập để tiếp tục</div>
          </div>
        </div>

        <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: C.text2, marginBottom: 5 }}>
          Mã truy cập
        </label>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={token}
          onChange={e => { setToken(e.target.value); if (error) setError(''); }}
          placeholder="Mã được cấp cho bạn"
          style={{
            width: '100%', boxSizing: 'border-box', padding: '9px 10px', borderRadius: 6,
            border: `1px solid ${error ? C.redBorder : C.border}`, fontSize: 13, fontFamily: 'inherit',
            color: C.text, background: C.surface2, marginBottom: 6,
          }}
        />
        {error && <div style={{ fontSize: 11.5, color: C.red, marginBottom: 10 }}>{error}</div>}

        <Btn type="submit" variant="solidPrimary" disabled={submitting} style={{ width: '100%', marginTop: 10, padding: '9px 0' }}>
          {submitting ? <><Spinner size={12} /> Đang kiểm tra...</> : 'Đăng nhập'}
        </Btn>

        <div style={{ fontSize: 10.5, color: C.text3, marginTop: 14, lineHeight: 1.5 }}>
          Chưa có mã truy cập? Liên hệ quản trị hệ thống để được cấp.
        </div>
      </form>
    </div>
  );
}
