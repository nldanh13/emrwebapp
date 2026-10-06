// Khi máy chủ bật "chỉ thiết bị tin cậy" (EMR_REQUIRE_TRUSTED_DEVICE=1): máy chưa tin cậy chỉ thấy
// trang đăng ký thiết bị, không mở các tab (không nhận dữ liệu). Thiết bị tin cậy vào thẳng app.
import { useCallback, useEffect, useState } from 'react';
import { C, FONT_UI, FS } from '../tokens.js';
import { Btn, Spinner } from './shared.jsx';
import DeviceTrustPanel from './DeviceTrustPanel.jsx';
import { useAuth } from '../hooks/useAuth.jsx';
import * as api from '../api.js';

export default function DeviceGate({ children }) {
  const { user, logout } = useAuth();
  const [state, setState] = useState('checking'); // checking | ok | untrusted

  const check = useCallback(async () => {
    try {
      const r = await api.getDeviceStatus();
      setState(r?.require_trusted && !r?.trusted && !r?.local_only ? 'untrusted' : 'ok');
    } catch (_) {
      setState('ok'); // không kiểm được thì để máy chủ tự chặn từng yêu cầu
    }
  }, []);

  useEffect(() => { check(); }, [check]);
  useEffect(() => {
    const onUntrusted = () => setState('untrusted');
    window.addEventListener('emr:device-untrusted', onUntrusted);
    return () => window.removeEventListener('emr:device-untrusted', onUntrusted);
  }, []);

  if (state === 'checking') {
    return <div style={{ fontFamily: FONT_UI, background: C.bg, height: '100vh', display: 'grid', placeItems: 'center' }}><Spinner size={20} /></div>;
  }
  if (state === 'ok') return children;

  return (
    <div style={{ fontFamily: FONT_UI, background: C.bg, color: C.text, minHeight: '100vh', padding: 16, display: 'grid', placeItems: 'center' }}>
      <div style={{ width: '100%', maxWidth: 560, display: 'grid', gap: 12 }}>
        <div>
          <div style={{ fontSize: FS.xl, fontWeight: 700 }}>Thiết bị này chưa được tin cậy</div>
          <div style={{ fontSize: FS.sm, color: C.text2, marginTop: 4, lineHeight: 1.5 }}>
            Để bảo vệ dữ liệu người bệnh, chỉ thiết bị đã đăng ký và được duyệt mới xem được dữ liệu.
            Đăng ký thiết bị này một lần, rồi nhập mã xác nhận hoặc nhờ quản trị duyệt.
          </div>
        </div>
        <DeviceTrustPanel isAdmin={user?.role === 'admin'} onTrusted={() => window.location.reload()} />
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn onClick={check}>Kiểm tra lại</Btn>
          <Btn onClick={logout}>Đăng xuất</Btn>
        </div>
      </div>
    </div>
  );
}
