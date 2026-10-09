// Trang /emr-bridge — "cánh tay" ở bệnh viện. Mở bằng nút dấu trang "Data Hub" trên tab EMR.
// Để yên tab EMR và trang này; Data Hub (trên cloud) sẽ xin trang EMR qua đây khi thu thập.
import { useEffect, useMemo, useRef, useState } from 'react';
import { C, FONT_UI, FS } from '../tokens.js';
import { Btn } from './shared.jsx';
import * as api from '../api.js';
import { createBridgeClient } from '../utils/emrBridgeClient.js';

const PHASE = {
  waiting: { color: C.amber, bg: C.amberBg, border: C.amberBorder, title: 'Đang chờ tab EMR…', hint: 'Trang này phải được mở bằng nút "Data Hub" trên tab EMR (sau khi đăng nhập EMR).' },
  connected: { color: C.green, bg: C.greenBg, border: C.greenBorder, title: 'Đang nối EMR ✓', hint: 'Để yên tab EMR và trang này. Có thể khóa màn hình (Windows + L) — vẫn chạy. Đóng tab là ngừng.' },
  emr_logged_out: { color: C.red, bg: C.redBg, border: C.redBorder, title: 'EMR đã đăng xuất', hint: 'Sang tab EMR, đăng nhập lại rồi bấm lại nút "Data Hub".' },
  emr_lost: { color: C.red, bg: C.redBg, border: C.redBorder, title: 'Mất nối với tab EMR', hint: 'Tab EMR đã đóng, tải lại hoặc chuyển trang. Mở lại EMR rồi bấm lại nút "Data Hub".' },
  stopped: { color: C.text2, bg: C.surface2, border: C.border, title: 'Đã ngừng cầu nối', hint: 'Bấm lại nút "Data Hub" trên tab EMR để nối lại.' },
};

// Máy góp sức (nút "Góp sức lấy dữ liệu"): cùng trang, khác lời hướng dẫn.
const HELPER_PHASE = {
  waiting: { title: 'Đang chờ tab EMR…', hint: 'Trang này phải được mở bằng nút "Góp sức lấy dữ liệu" trên tab EMR (sau khi đăng nhập EMR).' },
  connected: { title: 'Đang góp sức lấy dữ liệu ✓', hint: 'Để yên tab EMR và trang này, không nhập liệu EMR trong cửa sổ này (máy chủ đang mở hồ sơ khác qua phiên này). Khi có người bấm Lấy chi tiết, máy này tự nhận một phần người bệnh. Đóng tab là ngừng góp sức; phần đang làm tự chuyển cho máy khác.' },
  emr_logged_out: { hint: 'Sang tab EMR, đăng nhập lại rồi bấm lại nút "Góp sức lấy dữ liệu".' },
  emr_lost: { hint: 'Tab EMR đã đóng, tải lại hoặc chuyển trang. Mở lại EMR rồi bấm lại nút "Góp sức lấy dữ liệu".' },
  stopped: { title: 'Đã ngừng góp sức', hint: 'Bấm lại nút "Góp sức lấy dữ liệu" trên tab EMR để góp sức tiếp.' },
};

const fmtTime = (ms) => (ms ? new Date(ms).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '—');

export default function EmrBridgePage() {
  const [state, setState] = useState(null);
  const clientRef = useRef(null);
  const hasOpener = typeof window !== 'undefined' && Boolean(window.opener);
  const isHelper = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('vai') === 'gop-suc';

  const client = useMemo(() => createBridgeClient({
    api,
    getOpener: () => window.opener,
    role: isHelper ? 'helper' : '',
    onState: setState,
  }), [isHelper]);
  clientRef.current = client;

  useEffect(() => {
    const onMessage = (e) => clientRef.current.onMessage(e);
    window.addEventListener('message', onMessage);
    client.start();
    setState(client.getState());
    const timer = window.setInterval(() => { clientRef.current.tick(); }, 10 * 1000);
    document.title = isHelper ? 'Góp sức lấy dữ liệu — Data Hub' : 'Cầu nối EMR — Data Hub';
    return () => {
      window.removeEventListener('message', onMessage);
      window.clearInterval(timer);
      client.stop();
    };
  }, [client, isHelper]);

  const s = state || client.getState();
  const basePhase = PHASE[s.phase] || PHASE.waiting;
  const phase = isHelper ? { ...basePhase, ...(HELPER_PHASE[s.phase] || {}) } : basePhase;
  const button = isHelper ? 'Góp sức lấy dữ liệu' : 'Data Hub';

  return (
    <div style={{ fontFamily: FONT_UI, background: C.bg, color: C.text, minHeight: '100vh', padding: 16, display: 'grid', placeItems: 'center' }}>
      <main style={{ width: '100%', maxWidth: 560, display: 'grid', gap: 12 }}>
        <h1 style={{ margin: 0, fontSize: FS.xl }}>{isHelper ? 'Góp sức lấy dữ liệu' : 'Cầu nối EMR'}</h1>
        <section role="status" aria-live="polite" style={{ border: `1px solid ${phase.border}`, background: phase.bg, borderRadius: 10, padding: 16 }}>
          <div style={{ fontSize: FS.lg, fontWeight: 700, color: phase.color }}>{phase.title}</div>
          <div style={{ fontSize: FS.sm, color: C.text2, marginTop: 6, lineHeight: 1.5 }}>
            {!hasOpener && s.phase === 'waiting'
              ? `Trang này chưa được mở từ tab EMR. Trên tab EMR (đã đăng nhập), bấm nút "${button}" ở thanh dấu trang.`
              : phase.hint}
          </div>
        </section>
        <section style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, fontSize: FS.sm, lineHeight: 1.7 }}>
          <div>EMR: <b>{s.emrOrigin || 'chưa nối'}</b></div>
          <div>Đã chuyển: <b>{s.served}</b> trang{s.failed ? <> · lỗi: <b style={{ color: C.red }}>{s.failed}</b></> : null}</div>
          <div>Lần cuối tab EMR trả lời: <b>{fmtTime(s.lastHelloAt)}</b></div>
          {s.lastError ? <div style={{ color: C.red }}>Lỗi gần nhất: {s.lastError}</div> : null}
        </section>
        <div style={{ fontSize: FS.sm, color: C.text3, lineHeight: 1.5 }}>
          {isHelper
            ? 'Máy này đọc hồ sơ EMR bằng phiên đăng nhập của bạn và gửi về máy chủ Data Hub; máy này không giữ lại gì. EMR ghi nhận tài khoản của bạn đã xem các hồ sơ này.'
            : 'Thu thập dữ liệu: mở Data Hub ở tab khác hoặc máy khác (kể cả ở nhà) → Kho nghiên cứu → Thu thập. Dữ liệu lưu trên máy chủ Data Hub, máy này không giữ lại gì.'}
        </div>
        <div><Btn onClick={() => window.open('/', '_blank', 'noopener')}>Mở Data Hub ở tab mới</Btn></div>
      </main>
    </div>
  );
}
