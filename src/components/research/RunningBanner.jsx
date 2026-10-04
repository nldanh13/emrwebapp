// Dải trạng thái "đang chạy" luôn hiện ở đầu Kho nghiên cứu: tác vụ nào, ở kho/nghiên cứu nào,
// chạy từ lúc nào, đã bao lâu, tiến độ worker ghi gần nhất và lần kiểm tra gần nhất với máy chủ.
// Lấy từ máy chủ (/research/running) nên đúng cả khi rời tab, tải lại trang hay mở máy khác.
import { useEffect, useState } from 'react';
import { C, FS } from '../../tokens.js';
import { Btn, Spinner } from '../shared.jsx';

export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h} giờ ${String(m).padStart(2, '0')} phút`;
  if (m) return `${m} phút ${String(s).padStart(2, '0')} giây`;
  return `${s} giây`;
}

const clock = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// running: [{ scope_key, kind, study_id, study_name, label, since, task }]; clockOffset: giờ máy chủ − giờ máy này.
export function RunningBanner({ running = [], checkedAt = 0, clockOffset = 0, lastFinished = null, scopeName, onOpen, onCancel, onDismissFinished }) {
  const now = useNow();
  if (!running.length && !lastFinished) return null;
  const serverNow = now + clockOffset;
  const checkedAgo = checkedAt ? Math.max(0, Math.round((now - checkedAt) / 1000)) : null;
  return (
    <div style={{ display: 'grid', gap: 0, flexShrink: 0 }}>
      {running.map(item => {
        const elapsed = serverNow - Date.parse(item.since);
        const beat = item.task?.heartbeat_at ? Math.max(0, Math.round((serverNow - Date.parse(item.task.heartbeat_at)) / 1000)) : null;
        return (
          <div key={item.scope_key} role="status" aria-live="polite"
            style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '8px 12px', background: C.blueBg, borderBottom: `1px solid ${C.blueBorder}`, fontSize: FS.sm, color: C.text2 }}>
            <Spinner size={13} />
            <div style={{ flex: '1 1 320px', minWidth: 0 }}>
              <div style={{ color: C.text }}>
                <b style={{ color: C.blue }}>Đang chạy: {item.label}</b> · {scopeName(item)}
                <span style={{ color: C.text2 }}> · bắt đầu {clock(item.since)} · đã chạy <b style={{ fontVariantNumeric: 'tabular-nums', color: C.text }}>{formatDuration(elapsed)}</b></span>
              </div>
              <div style={{ fontSize: FS.xs, color: C.text3, marginTop: 1 }}>
                {item.task?.message ? <span style={{ color: C.text2 }}>{item.task.message}{beat != null ? ` (cập nhật ${beat} giây trước)` : ''} · </span> : null}
                Máy chủ xác nhận vẫn đang chạy{checkedAgo != null ? ` · kiểm tra ${checkedAgo} giây trước` : ''}. Có thể chuyển sang màn hình khác, tác vụ vẫn chạy tiếp và app sẽ báo khi xong.
              </div>
            </div>
            <Btn onClick={() => onOpen(item)} style={{ height: 28, fontSize: FS.xs }}>Xem tiến độ</Btn>
            <Btn variant="danger" onClick={() => onCancel(item)} style={{ height: 28, fontSize: FS.xs }}>Dừng</Btn>
          </div>
        );
      })}
      {!running.length && lastFinished && (
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '7px 12px', background: C.greenBg, borderBottom: `1px solid ${C.greenBorder}`, fontSize: FS.sm, color: C.text2 }}>
          <span aria-hidden="true" style={{ color: C.green, fontWeight: 700 }}>✓</span>
          <span style={{ flex: '1 1 300px' }}>
            <b style={{ color: C.green }}>Đã kết thúc: {lastFinished.label}</b> · {scopeName(lastFinished)} · lúc {clock(lastFinished.finished_at)} · chạy {formatDuration(lastFinished.elapsed_ms)}
          </span>
          <Btn onClick={() => onOpen(lastFinished)} style={{ height: 26, fontSize: FS.xs }}>Xem kết quả</Btn>
          <Btn onClick={onDismissFinished} style={{ height: 26, fontSize: FS.xs }}>Đóng</Btn>
        </div>
      )}
    </div>
  );
}
