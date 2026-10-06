// Dòng trạng thái "Máy BV: đang nối" + nút "Data Hub" để kéo lên thanh dấu trang ở máy bệnh viện.
// Chỉ hiện khi máy chủ bật chế độ cầu nối (EMR_BRIDGE_MODE=1, Data Hub chạy trên cloud).
// Trạng thái cập nhật qua kênh sự kiện (máy chủ phát 'bridge'), không hẹn giờ hỏi lại.
import { useEffect, useRef, useState } from 'react';
import { C, FS } from '../tokens.js';
import { Btn } from './shared.jsx';
import * as api from '../api.js';
import { bridgeBookmarkletUrl } from '../utils/emrBridgeBookmarklet.js';

const fmtTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
};

export default function EmrBridgeStatus() {
  const [bridge, setBridge] = useState(null);
  const [copied, setCopied] = useState(false);
  const linkRef = useRef(null);
  const code = bridgeBookmarkletUrl(typeof window !== 'undefined' ? window.location.origin : '');

  useEffect(() => {
    let alive = true;
    const load = () => api.getEmrBridgeStatus().then(r => { if (alive) setBridge(r?.bridge || null); }).catch(() => {});
    load();
    const onBridge = (e) => setBridge(prev => ({ ...(prev || {}), ...(e.detail || {}) }));
    const onRealtime = (e) => { if (e.detail?.connected) load(); };
    window.addEventListener('emr:bridge-status', onBridge);
    window.addEventListener('emr:realtime-status', onRealtime);
    return () => {
      alive = false;
      window.removeEventListener('emr:bridge-status', onBridge);
      window.removeEventListener('emr:realtime-status', onRealtime);
    };
  }, []);

  // React chặn href "javascript:" trong JSX — gắn trực tiếp vào thẻ để kéo lên thanh dấu trang.
  useEffect(() => {
    if (linkRef.current) linkRef.current.setAttribute('href', code);
  }, [code, bridge?.enabled, bridge?.connected]);

  if (!bridge?.enabled) return null;

  const ok = bridge.connected && bridge.emr_logged_in !== false;
  const loggedOut = bridge.connected && bridge.emr_logged_in === false;
  const tone = ok ? { c: C.green, bg: C.greenBg, b: C.greenBorder } : loggedOut ? { c: C.red, bg: C.redBg, b: C.redBorder } : { c: C.amber, bg: C.amberBg, b: C.amberBorder };

  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true); } catch (_) { setCopied(false); }
  };

  return (
    <div role="status" aria-live="polite" style={{ border: `1px solid ${tone.b}`, background: tone.bg, borderRadius: 8, padding: '10px 12px', display: 'grid', gap: 6, fontSize: FS.sm }}>
      <div style={{ color: tone.c, fontWeight: 600 }}>
        {ok && <>Máy BV: đang nối ✓ <span style={{ color: C.text2, fontWeight: 400 }}>— EMR {bridge.emr_origin}{bridge.user?.name ? `, nối bởi ${bridge.user.name}` : ''}{bridge.connected_at ? ` từ ${fmtTime(bridge.connected_at)}` : ''}</span></>}
        {loggedOut && 'Máy BV: EMR đã đăng xuất — đăng nhập lại EMR trên máy bệnh viện rồi bấm lại nút "Data Hub".'}
        {!bridge.connected && <>Chưa nối tab EMR{bridge.last_seen_at ? ` (mất nối từ ${fmtTime(bridge.last_seen_at)})` : ''} — chưa thu thập được từ EMR.</>}
      </div>
      {!ok && (
        <div style={{ color: C.text2, lineHeight: 1.6 }}>
          Trên một máy trong bệnh viện: mở EMR và đăng nhập → bấm nút <b>Data Hub</b> trên thanh dấu trang → để yên hai tab.
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
            <a
              ref={linkRef}
              onClick={(e) => e.preventDefault()}
              draggable="true"
              title="Kéo nút này lên thanh dấu trang (lần đầu dùng một máy bệnh viện)"
              style={{ display: 'inline-block', padding: '4px 12px', borderRadius: 6, background: C.blue, color: '#fff', fontWeight: 600, textDecoration: 'none', cursor: 'grab' }}
            >
              Data Hub
            </a>
            <span style={{ color: C.text3 }}>← lần đầu ở một máy: kéo nút này lên thanh dấu trang (Ctrl + Shift + B để hiện thanh)</span>
            <Btn onClick={copy} style={{ height: 26 }}>{copied ? 'Đã chép mã' : 'Chép mã nút'}</Btn>
          </div>
        </div>
      )}
    </div>
  );
}
