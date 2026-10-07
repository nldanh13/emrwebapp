// Đối chiếu tự động với EMR: máy chọn một đợt đã lấy đủ và đã chuẩn hóa, lấy lại đúng người bệnh đó
// từ EMR vào thư mục riêng (không ghi đè kho), rồi so từng dòng với kho. Tiến độ do máy chủ báo (dải
// "đang chạy" đầu trang + kênh sự kiện); màn hình này chỉ hiện kết quả.
import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../../api.js';
import { C, FS } from '../../tokens.js';
import { Btn } from '../shared.jsx';
import { SkeletonLines } from '../Skeleton.jsx';
import { useRealtimeConnected, useResearchEvents } from '../../hooks/useRealtimeStatus.js';
import { useOnTabReturn, useTabActive } from '../../hooks/useTabActivity.js';
import { formatAccuracy, formatRate, liveDiffText, liveIsActive, liveStatusLabel } from './auditSampleModel.js';

function errorText(e) {
  return String(e?.message || e || 'Không kết nối được máy chủ. Hãy thử lại.');
}

const cell = { padding: '6px 8px' };

function LiveSummaryTable({ summary }) {
  const kinds = (summary?.kinds || []).filter(k => k.compared);
  if (!kinds.length) return null;
  return (
    <div style={{ border: `1px solid ${C.border2}`, borderRadius: 8, overflow: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: FS.xs }}>
        <thead style={{ background: C.surface2 }}>
          <tr>{['Loại dữ liệu', 'Đã so', 'Khớp', 'Lệch', 'Kho thiếu', 'Kho thừa', 'Tỉ lệ khớp (KTC 95%)'].map(h => (
            <th key={h} style={{ ...cell, textAlign: 'left', color: C.text3, whiteSpace: 'nowrap' }}>{h}</th>
          ))}</tr>
        </thead>
        <tbody>
          {kinds.map(k => (
            <tr key={k.kind} style={{ borderTop: `1px solid ${C.border2}` }}>
              <td style={{ ...cell, color: C.text, fontWeight: 600 }}>{k.label}</td>
              <td style={cell}>{k.compared}</td>
              <td style={{ ...cell, color: C.green }}>{k.matched}</td>
              <td style={{ ...cell, color: k.mismatched ? C.red : C.text3 }}>{k.mismatched}</td>
              <td style={{ ...cell, color: k.emr_only ? C.red : C.text3 }}>{k.emr_only}</td>
              <td style={{ ...cell, color: k.archive_only ? C.amber : C.text3 }}>{k.archive_only}</td>
              <td style={{ ...cell, fontWeight: 700 }}>{formatAccuracy(k)}</td>
            </tr>
          ))}
          <tr style={{ borderTop: `2px solid ${C.border2}`, background: C.surface2 }}>
            <td style={{ ...cell, fontWeight: 700 }}>Tất cả</td>
            <td style={cell}>{summary.overall.compared}</td>
            <td style={{ ...cell, color: C.green }}>{summary.overall.matched}</td>
            <td style={cell} colSpan={3} />
            <td style={{ ...cell, fontWeight: 700 }}>{formatAccuracy(summary.overall)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function DiffList({ title, color, items, render }) {
  if (!items?.length) return null;
  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ fontSize: FS.xs, fontWeight: 700, color }}>{title}</div>
      {items.map((x, i) => <div key={i} style={{ fontSize: FS.xs, color: C.text2, paddingLeft: 8 }}>{render(x)}</div>)}
    </div>
  );
}

function LiveAuditDetail({ audit }) {
  if (!audit) return null;
  const kinds = audit.result?.kinds || [];
  return (
    <div style={{ border: `1px solid ${C.border2}`, borderRadius: 8, padding: 10, background: C.bg }}>
      <div style={{ fontSize: FS.sm, fontWeight: 700, color: C.text }}>
        Mã BN <span style={{ userSelect: 'all' }}>{audit.patient_code}</span> · Đợt {audit.admission_date || '—'} → {audit.discharge_date || 'chưa ra viện'}
      </div>
      <div style={{ fontSize: FS.xs, color: C.text2, marginTop: 2 }}>
        {liveStatusLabel(audit.status)}{audit.step ? ` — ${audit.step}` : ''}
        {audit.result ? ` · khớp ${formatRate(audit.result.overall?.match_rate)}` : ''}
      </div>
      {audit.message && <div role="alert" style={{ fontSize: FS.xs, color: audit.status === 'done' ? C.amber : C.red, marginTop: 4 }}>{audit.message}</div>}
      {kinds.map(k => (
        <div key={k.kind} style={{ marginTop: 8, paddingTop: 6, borderTop: `1px solid ${C.border2}` }}>
          <div style={{ fontSize: FS.xs, fontWeight: 700, color: C.text }}>
            {k.label}: <span style={{ color: k.compared === k.matched ? C.green : C.red }}>{liveDiffText(k)}</span>
            <span style={{ color: C.text3, fontWeight: 400 }}> · kho {k.archive_count} dòng, EMR {k.emr_count} dòng</span>
          </div>
          <DiffList title="Lệch (kho → EMR hôm nay)" color={C.red} items={k.examples?.mismatched}
            render={x => <>{x.label}: <b>{x.archive || '(trống)'}</b> → <b>{x.emr || '(trống)'}</b></>} />
          <DiffList title="Kho thiếu (EMR có, kho không có)" color={C.red} items={k.examples?.emr_only}
            render={x => <>{x.label}{x.value ? `: ${x.value}` : ''}</>} />
          <DiffList title="Kho thừa (kho có, EMR không còn)" color={C.amber} items={k.examples?.archive_only}
            render={x => <>{x.label}{x.value ? `: ${x.value}` : ''}</>} />
        </div>
      ))}
    </div>
  );
}

export function LiveAuditPanel() {
  const [summary, setSummary] = useState(null);
  const [detail, setDetail] = useState(null);
  const detailRef = useRef(null);
  detailRef.current = detail;
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const realtimeConnected = useRealtimeConnected();
  const tabActive = useTabActive();

  const load = useCallback(async () => {
    try {
      const s = await api.getResearchLiveAuditSummary();
      setSummary(s);
      setError('');
      // Đang mở một lượt: lượt đó đổi trạng thái/bước thì tải lại chi tiết.
      const prev = detailRef.current;
      const row = prev && (s.recent || []).find(a => a.id === prev.id);
      if (row && (row.status !== prev.status || (row.step || '') !== (prev.step || ''))) {
        try { setDetail((await api.getResearchLiveAudit(prev.id)).audit); } catch (_) { /* giữ bản đang xem */ }
      }
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useOnTabReturn(load);
  useResearchEvents(useCallback((ev) => {
    if (ev.kind === 'running' || (ev.kind === 'data' && ev.scope === 'archive')) load();
  }, [load]));

  const running = summary?.running || null;
  // ux-rules: polling-ok — chỉ khi đang có lượt đối chiếu chạy; kênh sự kiện nối được thì hỏi thưa (30 giây),
  // mất nối mới hỏi 5 giây. Tab ẩn thì thôi hỏi.
  useEffect(() => {
    if (!running || !tabActive) return undefined;
    const tid = setInterval(load, realtimeConnected ? 30000 : 5000);
    return () => clearInterval(tid);
  }, [running, tabActive, realtimeConnected, load]);

  const start = async () => {
    setStarting(true);
    setError('');
    try {
      const r = await api.startResearchLiveAudit();
      setDetail(r.audit);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setStarting(false);
    }
  };

  const open = async (id) => {
    try { setDetail((await api.getResearchLiveAudit(id)).audit); setError(''); } catch (e) { setError(errorText(e)); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <div style={{ fontSize: FS.lg, fontWeight: 700, color: C.text }}>Đối chiếu tự động với EMR</div>
        <div style={{ fontSize: FS.xs, color: C.text2, marginTop: 3 }}>
          Máy tự chọn một đợt đã lấy đủ và đã chuẩn hóa, mở EMR lấy lại đúng người bệnh đó vào thư mục riêng (không ghi đè kho),
          rồi so từng dòng: <b>khớp</b>, <b>lệch</b> (cùng mốc, khác giá trị), <b>kho thiếu</b> (EMR có, kho không có),
          {' '}<b>kho thừa</b> (kho có, EMR không còn). Hai bên dùng chung bước chuẩn hóa, nên cách này tìm lỗi lấy dữ liệu;
          lỗi ghép đợt dùng chung cần kiểm bằng tay ở phần dưới.
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Btn variant="solidPrimary" onClick={start} loading={starting} disabled={Boolean(running)}>
            {running ? 'Đang đối chiếu…' : 'Chọn ca và đối chiếu với EMR'}
          </Btn>
          {summary && (
            <span style={{ fontSize: FS.xs, color: C.text3 }}>
              Đã so {summary.case_count} ca, {summary.all_match_count} ca khớp hoàn toàn.
            </span>
          )}
        </div>
        {running && (
          <div style={{ marginTop: 6, fontSize: FS.xs, color: C.blue }}>
            Mã BN {running.patient_code}: {running.step || liveStatusLabel(running.status)}. Dừng ở dải "đang chạy" trên cùng.
          </div>
        )}
        {error && <div role="alert" style={{ marginTop: 6, fontSize: FS.sm, color: C.red }}>{error}</div>}
      </div>

      {!summary && !error && <SkeletonLines lines={4} />}
      {summary && <LiveSummaryTable summary={summary} />}
      {detail && <LiveAuditDetail audit={detail} />}

      {!!summary?.recent?.length && (
        <div>
          <div style={{ fontSize: FS.sm, fontWeight: 700, color: C.text, marginBottom: 6 }}>Các lượt đối chiếu gần đây</div>
          <div style={{ display: 'grid', gap: 4 }}>
            {summary.recent.map(a => (
              <button key={a.id} type="button" onClick={() => open(a.id)}
                style={{ textAlign: 'left', border: `1px solid ${C.border2}`, background: detail?.id === a.id ? C.blueBg : C.surface, borderRadius: 6, padding: '6px 8px', cursor: 'pointer', fontSize: FS.xs, color: C.text2 }}>
                Mã BN {a.patient_code} · {a.admission_date || '—'} → {a.discharge_date || '—'} · {liveStatusLabel(a.status)}
                {a.status === 'done' && (
                  <b style={{ color: a.all_match ? C.green : C.red }}> · khớp {formatRate(a.match_rate)}</b>
                )}
                {liveIsActive(a) && a.step ? ` · ${a.step}` : ''}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
