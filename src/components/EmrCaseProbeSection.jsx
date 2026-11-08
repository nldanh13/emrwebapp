// src/components/EmrCaseProbeSection.jsx
// "Dò theo ca": người dùng nhập 1–3 Mã BN, máy chủ chạy đúng worker lấy dữ liệu (chỉ đọc EMR) qua
// mọi màn hình, đếm dữ liệu đọc được ở từng màn hình rồi so với kho. Trạng thái và báo cáo lấy từ
// máy chủ (GET /api/emr-case-probe), nên rời tab hay tải lại trang vẫn thấy đúng.

import { useState, useCallback, useEffect } from 'react';
import { C, FS } from '../tokens.js';
import { Btn, Spinner } from './shared.jsx';
import { useOnTabReturn, useTabActive } from '../hooks/useTabActivity.js';
import * as api from '../api.js';

const MAX_CASES = 3;
const POLL_MS = 5000;

export const VERDICTS = {
  ok:       { label: 'Đọc được',        color: C.green, bg: C.greenBg },
  partial:  { label: 'Đọc được một phần', color: C.amber, bg: C.amberBg },
  empty:    { label: 'Không có dữ liệu', color: C.text2, bg: C.surface2 },
  suspect:  { label: 'Nghi hỏng',        color: C.orange, bg: C.orangeBg },
  broken:   { label: 'Hỏng',             color: C.red,   bg: C.redBg },
  not_run:  { label: 'Chưa chạy tới',    color: C.text3, bg: C.surface2 },
};

const CASE_STATES = { queued: 'Đang chờ', running: 'Đang đọc', done: 'Đã đọc xong', partial: 'Đã đọc xong', error: 'Lỗi' };

function emptyRow() { return { ma_bn: '', discharged: false, admission: '', discharge: '' }; }

function ago(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'vừa xong';
  if (mins < 60) return `${mins} phút trước`;
  const hours = Math.floor(mins / 60);
  return `${hours} giờ ${mins % 60} phút trước`;
}

function fmtDateTime(iso) {
  const d = new Date(iso || '');
  if (Number.isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())} ${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function countText(rows, fields) {
  if (rows == null && fields == null) return '—';
  if (rows) return `${rows} dòng`;
  if (fields) return `${fields} ô`;
  return '0';
}

function VerdictBadge({ verdict }) {
  const v = VERDICTS[verdict] || { label: verdict || '—', color: C.text3, bg: C.surface2 };
  return (
    <span style={{ display: 'inline-block', padding: '1px 8px', borderRadius: 10, background: v.bg, color: v.color, fontWeight: 700, fontSize: FS.xs, whiteSpace: 'nowrap' }}>
      {v.label}
    </span>
  );
}

function CaseResult({ item }) {
  const [showLog, setShowLog] = useState(false);
  const cell = { padding: '6px 8px', borderBottom: `1px solid ${C.border2}`, verticalAlign: 'top', fontSize: FS.sm };
  return (
    <div style={{ marginBottom: 14, border: `1px solid ${C.border2}`, borderRadius: 6, background: C.surface }}>
      <div style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border2}`, display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <b style={{ fontSize: FS.md, color: C.text }}>Mã BN {item.ma_bn}</b>
        <span style={{ fontSize: FS.xs, color: C.text3 }}>
          {item.discharged ? 'Đã ra viện' : 'Đang nằm viện'} · {item.compared_with_store ? 'đã so với kho' : 'kho chưa có đợt này để so'}
        </span>
      </div>
      {item.headline && (
        <div style={{ margin: '8px 12px 0', padding: '6px 10px', background: C.redBg, border: `1px solid ${C.redBorder}`, borderRadius: 4, color: C.red, fontSize: FS.sm }}>
          {item.headline}
        </div>
      )}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 4 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: C.text3, fontSize: FS.xs }}>
              <th style={cell}>Màn hình</th><th style={cell}>Kết quả</th><th style={cell}>Lần này đọc được</th><th style={cell}>Trong kho</th><th style={cell}>Cần làm</th>
            </tr>
          </thead>
          <tbody>
            {(item.screens || []).map(s => (
              <tr key={s.key}>
                <td style={cell}>
                  <div style={{ color: C.text, fontWeight: 600 }}>{s.label}</div>
                  <div style={{ color: C.text3, fontSize: FS.xs }}>{s.where}</div>
                </td>
                <td style={cell}><VerdictBadge verdict={s.verdict} /></td>
                <td style={cell} title={Object.entries(s.lists || {}).map(([k, v]) => `${k}: ${v}`).join('\n')}>{countText(s.rows, s.fields)}</td>
                <td style={cell}>{countText(s.stored_rows, s.stored_fields)}</td>
                <td style={{ ...cell, color: C.text2 }}>{s.message || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(item.problems || []).length > 0 && (
        <div style={{ padding: '6px 12px 10px' }}>
          <button type="button" onClick={() => setShowLog(v => !v)} style={{
            background: 'none', border: `1px solid ${C.border}`, borderRadius: 4, padding: '2px 8px',
            cursor: 'pointer', fontSize: FS.xs, color: C.text2, fontFamily: 'inherit',
          }}>{showLog ? 'Ẩn nhật ký lỗi' : `Xem nhật ký lỗi của worker (${item.problems.length})`}</button>
          {showLog && (
            <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: FS.xs, color: C.text2 }}>
              {item.problems.map((p, i) => <li key={i}><b>{p.tag}</b> · {p.step}{p.screen ? ` · ${p.screen}` : ''}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default function EmrCaseProbeSection() {
  const [rows, setRows] = useState([emptyRow()]);
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const active = useTabActive();
  const running = report?.status === 'running';

  const load = useCallback(async () => {
    try {
      const r = await api.getEmrCaseProbe();
      setReport(r.report || null);
    } catch (e) {
      setError(String(e.message || e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useOnTabReturn(load);

  // ux-rules: polling-ok — chỉ hỏi lại khi máy chủ đang dò và tab đang mở.
  // ux-rules: no-realtime — báo cáo dò theo ca chỉ ghi ra file, chưa phát qua kênh sự kiện.
  useEffect(() => {
    if (!running || !active) return undefined;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [running, active, load]);

  const setRow = (i, patch) => setRows(list => list.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const filled = rows.filter(r => r.ma_bn.trim());

  const start = useCallback(async () => {
    setError('');
    setStarting(true);
    try {
      const cases = rows.filter(r => r.ma_bn.trim()).map(r => ({
        ma_bn: r.ma_bn.trim(), discharged: r.discharged, admission: r.admission, discharge: r.discharged ? r.discharge : '',
      }));
      const r = await api.runEmrCaseProbe(cases);
      setReport(r.report || null);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setStarting(false);
    }
  }, [rows]);

  const stop = useCallback(async () => {
    try { await api.cancelTask(); } catch (e) { setError(String(e.message || e)); }
    load();
  }, [load]);

  const input = { height: 30, borderRadius: 5, border: `1px solid ${C.border}`, background: C.bg, color: C.text, padding: '0 8px', fontSize: FS.sm, fontFamily: 'inherit' };
  const totals = report?.totals || {};

  return (
    <div style={{ marginBottom: 20, padding: 12, background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 6 }}>
      <div style={{ fontSize: FS.md, fontWeight: 700, color: C.text, marginBottom: 4 }}>Dò theo ca</div>
      <div style={{ fontSize: FS.xs, color: C.text3, marginBottom: 10 }}>
        Chọn 1 đến {MAX_CASES} người bệnh. Máy chủ mở EMR (chỉ đọc), đi qua từng màn hình mà app dùng để lấy dữ liệu
        (hồ sơ, ra viện, bảng kê, ngày giường, y lệnh, phẫu thuật, cận lâm sàng, giấy tờ), đếm dữ liệu đọc được rồi so
        với kho. Không ghi gì vào kho và không sửa gì trên EMR. Mỗi ca mất vài phút.
      </div>

      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
          <input aria-label={`Mã BN ca ${i + 1}`} placeholder="Mã BN" value={r.ma_bn} disabled={running}
            onChange={e => setRow(i, { ma_bn: e.target.value })} style={{ ...input, width: 140 }} />
          <label style={{ fontSize: FS.sm, color: C.text2, display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={r.discharged} disabled={running} onChange={e => setRow(i, { discharged: e.target.checked })} />
            Đã ra viện
          </label>
          <label style={{ fontSize: FS.sm, color: C.text2 }}>
            Ngày vào{' '}
            <input type="date" value={r.admission} disabled={running} onChange={e => setRow(i, { admission: e.target.value })} style={input} />
          </label>
          {r.discharged && (
            <label style={{ fontSize: FS.sm, color: C.text2 }}>
              Ngày ra{' '}
              <input type="date" value={r.discharge} disabled={running} onChange={e => setRow(i, { discharge: e.target.value })} style={input} />
            </label>
          )}
          {rows.length > 1 && !running && (
            <button type="button" onClick={() => setRows(list => list.filter((_, idx) => idx !== i))}
              style={{ background: 'none', border: 'none', color: C.text3, cursor: 'pointer', fontSize: FS.sm, fontFamily: 'inherit' }}>
              Bỏ ca này
            </button>
          )}
        </div>
      ))}

      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        {rows.length < MAX_CASES && !running && (
          <Btn onClick={() => setRows(list => [...list, emptyRow()])}>+ Thêm ca</Btn>
        )}
        {!running && (
          <Btn variant="primary" onClick={start} disabled={starting || !filled.length}>
            {starting ? <><Spinner size={11} /> Đang gửi...</> : (filled.length ? `Dò ${filled.length} ca` : 'Dò theo ca')}
          </Btn>
        )}
        {running && <Btn onClick={stop}>Dừng</Btn>}
      </div>

      {error && (
        <div style={{ marginTop: 10, padding: '8px 12px', background: C.redBg, border: `1px solid ${C.redBorder}`, borderRadius: 6, color: C.red, fontSize: FS.sm }}>
          {error}
        </div>
      )}

      {running && (
        <div style={{ marginTop: 12, padding: '8px 12px', background: C.blueBg, border: `1px solid ${C.blueBorder}`, borderRadius: 6, color: C.blue, fontSize: FS.sm }}>
          <Spinner size={11} /> {report.message || 'Đang dò.'} Bắt đầu {fmtDateTime(report.started_at)} ({ago(report.started_at)}).
          <div style={{ marginTop: 4, color: C.text2 }}>
            {(report.cases || []).map(c => `Mã BN ${c.ma_bn}: ${CASE_STATES[c.state] || c.state || 'Đang chờ'}`).join(' · ')}
          </div>
        </div>
      )}

      {report && !running && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: FS.sm, color: C.text2, marginBottom: 8 }}>
            Lần dò {fmtDateTime(report.finished_at || report.started_at)}
            {report.status !== 'done' && report.message ? ` · ${report.message}` : ''}
          </div>
          {report.totals && (
            <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
              {Object.entries(VERDICTS).filter(([k]) => totals[k]).map(([k, v]) => (
                <div key={k} style={{ padding: '4px 16px 5px 0', borderRight: `1px solid ${C.border2}` }}>
                  <div style={{ fontSize: FS.stat, fontWeight: 700, color: v.color }}>{totals[k]}</div>
                  <div style={{ fontSize: FS.xs, color: C.text3 }}>{v.label}</div>
                </div>
              ))}
            </div>
          )}
          {(report.cases || []).filter(c => Array.isArray(c.screens)).map(c => <CaseResult key={c.ma_bn} item={c} />)}
        </div>
      )}
    </div>
  );
}
