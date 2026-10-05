// Một chỗ duy nhất cho trạng thái Chuẩn hóa của kho: đang chạy (bước, thời gian), có dữ liệu mới
// chưa chuẩn hóa (nút Chuẩn hóa ngay), vừa xong (lúc nào, mất bao lâu) hoặc lỗi.
// Chuẩn hóa là quy trình riêng với Thu thập: đang chuẩn hóa vẫn thu thập được và ngược lại.
import { useEffect, useState } from 'react';
import { C, FS } from '../../tokens.js';
import { Btn, Spinner } from '../shared.jsx';
import { formatDuration } from './RunningBanner.jsx';

const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
};

function useTicking(active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

const box = (border, bg) => ({ padding: '10px 14px', borderRadius: 8, border: `1px solid ${border}`, background: bg, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' });

// running: mục /research/running của làn chuẩn hóa (hoặc null); request: { status, message, error }.
// collecting: đang Thu thập tự động trên cùng kho — xong sẽ tự chuẩn hóa, nên không giục bấm "Chuẩn hóa ngay".
export function NormalizeStatus({ pipeline, running = null, request = {}, clockOffset = 0, collecting = false, onNormalize, onDismiss }) {
  const starting = request.status === 'starting';
  const isRunning = Boolean(running) || starting;
  const now = useTicking(isRunning) + clockOffset;
  const normalize = pipeline?.normalize || {};
  const lastMs = Number(normalize.duration_ms || 0);

  if (isRunning) {
    const since = running?.since || request.started_at;
    const elapsed = since ? Math.max(0, now - Date.parse(since)) : 0;
    const st = running?.normalize || null;
    const pct = st?.stage_index ? Math.round((st.stage_index / (st.stage_total || 8)) * 100)
      : lastMs ? Math.min(95, Math.round((elapsed / lastMs) * 100)) : 0;
    return (
      <div role="status" aria-live="polite" style={box(C.blueBorder, C.blueBg)}>
        <Spinner size={13} />
        <div style={{ flex: '1 1 340px', minWidth: 0 }}>
          <div style={{ fontSize: FS.sm, color: C.text }}>
            <b style={{ color: C.blue }}>Đang chuẩn hóa</b>
            {running?.reason ? <span style={{ color: C.text2 }}> · {running.reason}</span> : null}
            {st?.stage_index ? <span> · bước {st.stage_index}/{st.stage_total || 8}: <b>{st.stage}</b></span> : <span style={{ color: C.text2 }}> · đang khởi động…</span>}
          </div>
          <div style={{ marginTop: 5, height: 6, borderRadius: 3, background: C.surface, overflow: 'hidden' }}>
            <div style={{ width: `${Math.max(3, pct)}%`, height: '100%', background: C.blue, transition: 'width 0.6s' }} />
          </div>
          <div style={{ marginTop: 3, fontSize: FS.xs, color: C.text3, fontVariantNumeric: 'tabular-nums' }}>
            Đã chạy {formatDuration(elapsed)}{lastMs ? ` · lần trước mất ${formatDuration(lastMs)}` : ''}.
            {' '}Chạy riêng, không ảnh hưởng thu thập: vẫn bấm Thu thập tự động và dùng màn hình khác bình thường.
          </div>
        </div>
      </div>
    );
  }

  if (request.status === 'error' || normalize.status === 'failed') {
    return (
      <div role="alert" style={box(C.redBorder, C.redBg)}>
        <div style={{ flex: '1 1 300px', fontSize: FS.sm, color: C.text2 }}>
          <b style={{ color: C.red }}>Chuẩn hóa lỗi</b>{normalize.at ? ` (lần gần nhất ${when(normalize.at)})` : ''}: {request.error || 'xem nhật ký để biết chi tiết'}.
          {' '}Số liệu vẫn là bản chuẩn hóa thành công trước đó.
        </div>
        {onNormalize && <Btn variant="solidPrimary" onClick={onNormalize} style={{ height: 30 }}>Chuẩn hóa lại</Btn>}
      </div>
    );
  }

  if (pipeline?.fetch?.pending_normalize && collecting) {
    // Đang thu thập: chuẩn hóa bây giờ thì vài phút sau lại cũ; thu thập xong máy tự chuẩn hóa.
    return (
      <div role="status" style={{ ...box(C.border2, C.surface), padding: '7px 12px' }}>
        <div style={{ flex: '1 1 300px', fontSize: FS.xs, color: C.text2 }}>
          Đang thu thập dữ liệu: khi xong, máy <b>tự chuẩn hóa</b> phần mới. Không cần bấm gì.
          {normalize.at ? ` Chuẩn hóa gần nhất lúc ${when(normalize.at)}.` : ''}
        </div>
      </div>
    );
  }

  if (pipeline?.fetch?.pending_normalize) {
    return (
      <div role="status" style={box(C.amberBorder, C.amberBg)}>
        <div style={{ flex: '1 1 300px' }}>
          <div style={{ fontSize: FS.sm, fontWeight: 700, color: C.text }}>Có dữ liệu mới chưa được chuẩn hóa</div>
          <div style={{ marginTop: 2, fontSize: FS.xs, color: C.text2 }}>
            Lấy dữ liệu gần nhất lúc {when(pipeline.fetch.last_at)}; chuẩn hóa gần nhất lúc {when(normalize.at) || 'chưa có'}
            {lastMs ? ` (mất ${formatDuration(lastMs)})` : ''}. Số liệu kho, bảng chuẩn và Tạo nghiên cứu chưa gồm phần mới cho tới khi chuẩn hóa.
          </div>
        </div>
        {onNormalize && <Btn variant="solidPrimary" onClick={onNormalize} style={{ height: 30 }}>Chuẩn hóa ngay</Btn>}
      </div>
    );
  }

  if (request.status === 'done') {
    return (
      <div role="status" style={box(C.greenBorder, C.greenBg)}>
        <span aria-hidden="true" style={{ color: C.green, fontWeight: 700 }}>✓</span>
        <div style={{ flex: '1 1 300px', fontSize: FS.sm, color: C.text2 }}>
          <b style={{ color: C.green }}>Đã chuẩn hóa xong</b> lúc {when(normalize.at)}{lastMs ? ` · mất ${formatDuration(lastMs)}` : ''}. Số liệu và Tạo nghiên cứu đã gồm dữ liệu mới.
          {request.message ? <div style={{ fontSize: FS.xs, color: C.text3, marginTop: 2 }}>{request.message}</div> : null}
        </div>
        {onDismiss && <Btn onClick={onDismiss} style={{ height: 26, fontSize: FS.xs }}>Đóng</Btn>}
      </div>
    );
  }
  return null;
}
