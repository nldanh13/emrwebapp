// Máy góp sức lấy dữ liệu: mỗi người mở EMR trên máy mình (đăng nhập bằng tài khoản của họ) rồi bấm nút
// dấu trang "Góp sức lấy dữ liệu". Khi bấm Lấy chi tiết, máy chủ giao từng lô người bệnh cho các máy
// này (server/services/details_parallel.js). Dòng này cho biết ai đang góp sức và đã làm bao nhiêu ca.
// Trạng thái cập nhật qua kênh sự kiện (máy chủ phát 'bridge'), không hẹn giờ hỏi lại.
import { useCallback, useEffect, useRef, useState } from 'react';
import { C, FS } from '../tokens.js';
import { Btn } from './shared.jsx';
import * as api from '../api.js';
import { bridgeBookmarkletUrl } from '../utils/emrBridgeBookmarklet.js';
import { useOnTabReturn } from '../hooks/useTabActivity.js';

export default function HelpersPanel() {
  const [bridge, setBridge] = useState(null);
  const [showHow, setShowHow] = useState(false);
  const [copied, setCopied] = useState(false);
  const linkRef = useRef(null);
  const code = bridgeBookmarkletUrl(typeof window !== 'undefined' ? window.location.origin : '', { helper: true });

  const load = useCallback(() => api.getEmrBridgeStatus().then(r => setBridge(r?.bridge || null)).catch(() => {}), []);

  useEffect(() => {
    load();
    const onBridge = (e) => setBridge(prev => ({ ...(prev || {}), ...(e.detail || {}) }));
    window.addEventListener('emr:bridge-status', onBridge);
    return () => window.removeEventListener('emr:bridge-status', onBridge);
  }, [load]);
  useOnTabReturn(() => load());

  // React chặn href "javascript:" trong JSX — gắn trực tiếp vào thẻ để kéo lên thanh dấu trang.
  useEffect(() => {
    if (linkRef.current) linkRef.current.setAttribute('href', code);
  }, [code, showHow]);

  // Chế độ cầu nối (Data Hub trên cloud) chỉ có một phiên trình duyệt: không chia cho máy góp sức.
  if (!bridge || bridge.enabled) return null;
  const helpers = Array.isArray(bridge.helpers) ? bridge.helpers.filter(h => h.connected) : [];

  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true); } catch (_) { setCopied(false); }
  };

  return (
    <div style={{ display: 'grid', gap: 6, fontSize: FS.sm, color: C.text2 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span>Máy góp sức:</span>
        {helpers.length === 0 && <span style={{ color: C.text3 }}>chưa có máy nào, chỉ máy chủ lấy.</span>}
        {helpers.map(h => (
          <span key={h.key} style={{
            padding: '2px 8px', borderRadius: 999, border: `1px solid ${h.emr_logged_in ? C.greenBorder : C.redBorder}`,
            background: h.emr_logged_in ? C.greenBg : C.redBg, color: h.emr_logged_in ? C.green : C.red,
          }}>
            {h.user?.name || 'Máy góp sức'}
            {!h.emr_logged_in ? ' · EMR đã đăng xuất' : h.busy ? ' · đang lấy' : h.patients_done ? ` · ${h.patients_done} ca` : ' · sẵn sàng'}
          </span>
        ))}
        <button type="button" onClick={() => setShowHow(v => !v)} style={{
          border: 'none', background: 'none', color: C.blue, cursor: 'pointer', fontSize: FS.sm, padding: 0,
        }}>{showHow ? 'Ẩn hướng dẫn' : 'Thêm máy góp sức'}</button>
      </div>
      {showHow && (
        <div style={{ lineHeight: 1.6, padding: '8px 10px', borderRadius: 7, background: C.surface2, border: `1px solid ${C.border2}` }}>
          Trên mỗi máy trong bệnh viện: mở EMR, đăng nhập bằng tài khoản của người dùng máy đó, rồi bấm nút
          <b> Góp sức lấy dữ liệu</b> trên thanh dấu trang và để yên hai tab. Khi bấm <b>Lấy chi tiết</b>, mỗi máy tự nhận
          một phần người bệnh; máy nào tắt giữa chừng thì phần đó chuyển cho máy khác. EMR ghi nhận tài khoản của từng
          người đã xem hồ sơ nào.
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
            <a
              ref={linkRef}
              onClick={(e) => e.preventDefault()}
              draggable="true"
              title="Kéo nút này lên thanh dấu trang (lần đầu dùng một máy)"
              style={{ display: 'inline-block', padding: '4px 12px', borderRadius: 6, background: C.blue, color: '#fff', fontWeight: 600, textDecoration: 'none', cursor: 'grab' }}
            >
              Góp sức lấy dữ liệu
            </a>
            <span style={{ color: C.text3 }}>← lần đầu ở một máy: kéo nút này lên thanh dấu trang (Ctrl + Shift + B để hiện thanh)</span>
            <Btn onClick={copy} style={{ height: 26 }}>{copied ? 'Đã chép mã' : 'Chép mã nút'}</Btn>
          </div>
        </div>
      )}
    </div>
  );
}
