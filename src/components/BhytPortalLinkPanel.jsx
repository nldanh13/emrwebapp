// Nhập chứng từ lên Cổng BHYT qua tab cổng người dùng đã đăng nhập (cùng cách mở EMR), không cần
// start.bat hay Chrome riêng. Hồ sơ lấy từ danh sách BHXH đã nhập ở tab Nghỉ ốm; kết quả nhập, lỗi và
// số liệu bổ sung tay (Số KCB...) lưu trong trạng thái nghỉ ốm trên máy chủ. Xem src/utils/bhytPortal.js.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { C, FS } from '../tokens.js';
import { Badge, Btn, Spinner } from './shared.jsx';
import {
  DOC_LABELS, REQUIRED_FIELDS, buildPortalRecords, createPortalLink, portalBookmarkletUrl,
} from '../utils/bhytPortal.js';
import doctorConfig from '../../config/bhyt_portal_doctors.json';

const PHASES = {
  closed: { text: 'Chưa mở cổng', bg: C.surface2, color: C.text2 },
  waiting: { text: 'Đăng nhập trên tab cổng rồi bấm nút Nhập BHYT', bg: C.amberBg, color: C.amber },
  logged_out: { text: 'Cổng chưa đăng nhập', bg: C.redBg, color: C.red },
  lost: { text: 'Mất nối tab cổng: bấm lại nút Nhập BHYT trên tab cổng', bg: C.redBg, color: C.red },
  ready: { text: 'Đã nối cổng BHYT ✓', bg: C.greenBg, color: C.green },
};

const STATUS = {
  previewed: { text: 'Đã điền thử', bg: C.blueBg, color: C.blue },
  error: { text: 'Lỗi', bg: C.redBg, color: C.red },
  running: { text: 'Đang nhập', bg: C.amberBg, color: C.amber },
};

const INPUT = { padding: '3px 6px', fontSize: FS.xs, border: `1px solid ${C.border}`, borderRadius: 5, width: 130 };

function MissingInputs({ record, onSave }) {
  const [draft, setDraft] = useState({});
  const timer = useRef(null);
  const labels = REQUIRED_FIELDS[record.doc_type] || {};
  // Tự lưu ~1 giây sau lần gõ cuối (UX_RULES 2.1).
  const change = (k, v) => {
    const next = { ...draft, [k]: v };
    setDraft(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onSave(next), 900);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
      {record.editable.map(k => (
        <input key={k} placeholder={`Bổ sung ${labels[k] || k}`} value={draft[k] ?? record.fields[k] ?? ''}
          title={labels[k] || k}
          onChange={e => change(k, e.target.value)} onBlur={() => { clearTimeout(timer.current); if (Object.keys(draft).length) onSave(draft); }}
          style={INPUT} />
      ))}
    </div>
  );
}

export default function BhytPortalLinkPanel({ toast, outpatient, inpatient, entries, hasIssue, onUpdateEntry }) {
  const [link, setLink] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [running, setRunning] = useState(null); // { save, current, done, total }
  const [confirmText, setConfirmText] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [showHow, setShowHow] = useState(false);
  const stopRef = useRef(false);
  const linkRef = useRef(null);
  const code = portalBookmarkletUrl(typeof window !== 'undefined' ? window.location.origin : '');

  const portal = useMemo(() => createPortalLink({
    openWindow: (url, name) => window.open(url, name),
    onState: setLink,
  }), []);

  useEffect(() => {
    const onMessage = (e) => portal.onMessage(e);
    window.addEventListener('message', onMessage);
    // Chỉ kiểm tab cổng còn chào không (không gọi máy chủ).
    const t = window.setInterval(() => portal.tick(), 5000);
    return () => { window.removeEventListener('message', onMessage); window.clearInterval(t); };
  }, [portal]);

  // React chặn href "javascript:" trong JSX — gắn trực tiếp để kéo lên thanh dấu trang.
  useEffect(() => { if (linkRef.current) linkRef.current.setAttribute('href', code); }, [code, showHow]);

  const { records, stats } = useMemo(() => buildPortalRecords({
    outpatient, inpatient, entries, doctors: doctorConfig.doctors || [], hasIssue,
  }), [outpatient, inpatient, entries, hasIssue]);

  useEffect(() => {
    setSelected(prev => {
      const keys = new Set(records.map(r => r.key));
      const next = new Set([...prev].filter(k => keys.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [records]);

  const ready = (r) => r.missing.length === 0;
  const chosen = records.filter(r => selected.has(r.key));
  const phase = PHASES[link?.phase || 'closed'] || PHASES.closed;
  const connected = link?.phase === 'ready';

  const openPortal = () => {
    if (!portal.open()) toast?.('Trình duyệt chặn cửa sổ mới. Cho phép cửa sổ bật lên cho Data Hub rồi bấm lại.', 'error');
  };

  const saveFields = useCallback((record, patch) => {
    const clean = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, String(v || '').trim()]).filter(([, v]) => v));
    if (!Object.keys(clean).length) return;
    onUpdateEntry(record.key, prev => ({ ...prev, bhyt_fields: { ...(prev.bhyt_fields || {}), ...clean } }));
  }, [onUpdateEntry]);

  const runBatch = async (list, save) => {
    stopRef.current = false;
    setRunning({ save, done: 0, total: list.length, current: '' });
    let ok = 0;
    let failed = 0;
    for (const record of list) {
      if (stopRef.current) break;
      setRunning(r => ({ ...r, current: record.patient_name }));
      try {
        const message = await portal.fill(record, { save });
        if (save) {
          ok += 1;
          onUpdateEntry(record.key, prev => ({ ...prev, submitted: true, bhyt_status: 'success', bhyt_message: message, bhyt_at: new Date().toISOString() }));
        } else {
          onUpdateEntry(record.key, prev => ({ ...prev, bhyt_status: 'previewed', bhyt_message: message, bhyt_at: new Date().toISOString() }));
        }
      } catch (e) {
        failed += 1;
        onUpdateEntry(record.key, prev => ({ ...prev, bhyt_status: 'error', bhyt_message: String(e?.message || e), bhyt_at: new Date().toISOString() }));
        // Mất nối tab cổng thì dừng cả lô, không thử tiếp từng hồ sơ.
        if (portal.getState().phase !== 'ready') break;
      }
      setRunning(r => ({ ...r, done: r.done + 1 }));
      if (save) await new Promise(res => setTimeout(res, 1000));
    }
    setRunning(null);
    if (save) toast?.(`Nhập thật xong: ${ok} hồ sơ đã lưu lên cổng${failed ? `, ${failed} hồ sơ lỗi (xem cột trạng thái)` : ''}.`, failed ? 'error' : 'ok');
    else if (!failed) toast?.('Đã điền thử trên tab cổng BHYT, chưa bấm Lưu. Kiểm tra từng ô trên tab cổng.', 'ok');
    else toast?.('Điền thử bị lỗi, xem cột trạng thái.', 'error');
  };

  const preview = () => {
    if (chosen.length !== 1) { toast?.('Chọn đúng một hồ sơ để điền thử.', 'error'); return; }
    if (!ready(chosen[0])) { toast?.('Hồ sơ còn thiếu thông tin, bổ sung trước khi điền.', 'error'); return; }
    runBatch(chosen, false);
  };

  const startReal = () => {
    setConfirming(false);
    setConfirmText('');
    runBatch(chosen.filter(ready), true);
  };

  const toggle = (key) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const allChosen = records.length > 0 && records.every(r => selected.has(r.key));

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Btn variant="primary" onClick={openPortal} style={{ padding: '6px 12px', fontSize: FS.sm }}>Mở cổng BHYT</Btn>
        <Badge text={phase.text} bg={phase.bg} color={phase.color} size={FS.xs} />
        <button type="button" onClick={() => setShowHow(v => !v)} style={{ border: 'none', background: 'none', color: C.blue, cursor: 'pointer', fontSize: FS.xs, padding: 0, marginLeft: 'auto' }}>
          {showHow ? 'Ẩn hướng dẫn' : 'Lần đầu trên máy này?'}
        </button>
      </div>
      <div style={{ fontSize: FS.xs, color: C.text3, lineHeight: 1.6 }}>
        Bấm <b>Mở cổng BHYT</b>, đăng nhập trên tab cổng (Mã cơ sở KCB, tài khoản, CAPTCHA, OTP), rồi bấm nút
        dấu trang <b>Nhập BHYT</b> trên tab cổng. Data Hub không giữ mật khẩu cổng.
      </div>
      {showHow && (
        <div style={{ fontSize: FS.xs, lineHeight: 1.6, padding: '8px 10px', borderRadius: 7, background: C.surface2, border: `1px solid ${C.border2}` }}>
          Kéo nút dưới đây lên thanh dấu trang (Ctrl + Shift + B để hiện thanh). Chỉ cần làm một lần trên mỗi máy.
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
            <a ref={linkRef} onClick={(e) => e.preventDefault()} draggable="true" title="Kéo nút này lên thanh dấu trang"
              style={{ display: 'inline-block', padding: '4px 12px', borderRadius: 6, background: C.blue, color: '#fff', fontWeight: 600, textDecoration: 'none', cursor: 'grab' }}>
              Nhập BHYT
            </a>
            <Btn onClick={() => navigator.clipboard?.writeText(code).then(() => toast?.('Đã chép mã nút.', 'ok')).catch(() => {})} style={{ height: 26 }}>Chép mã nút</Btn>
          </div>
        </div>
      )}

      <div style={{ fontSize: FS.xs, color: C.text3 }}>
        {records.length} hồ sơ chờ nhập
        {stats.submitted ? ` · ${stats.submitted} đã nộp` : ''}
        {stats.flagged ? ` · ${stats.flagged} đang cần sửa (bỏ qua)` : ''}
        {stats.other_doctor ? ` · ${stats.other_doctor} của bác sĩ ngoài khoa (bỏ qua)` : ''}
      </div>

      {records.length > 0 && (
        <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'auto', maxHeight: 420 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: FS.xs }}>
            <thead><tr style={{ background: C.surface2, textAlign: 'left' }}>
              <th style={{ padding: 6 }}><input type="checkbox" checked={allChosen} onChange={e => setSelected(e.target.checked ? new Set(records.map(r => r.key)) : new Set())} aria-label="Chọn tất cả" /></th>
              <th style={{ padding: 6 }}>Họ tên</th><th style={{ padding: 6 }}>Loại</th><th style={{ padding: 6 }}>Bác sĩ</th><th style={{ padding: 6 }}>Trạng thái</th>
            </tr></thead>
            <tbody>
              {records.map(r => {
                const st = STATUS[r.status];
                return (
                  <tr key={r.key} style={{ borderTop: `1px solid ${C.border2}`, verticalAlign: 'top' }}>
                    <td style={{ padding: 6 }}><input type="checkbox" checked={selected.has(r.key)} onChange={() => toggle(r.key)} aria-label={`Chọn ${r.patient_name}`} /></td>
                    <td style={{ padding: 6 }}>
                      <div style={{ fontWeight: 600, color: C.text }}>{r.patient_name || '—'}</div>
                      {r.editable.length > 0 && <MissingInputs record={r} onSave={(patch) => saveFields(r, patch)} />}
                    </td>
                    <td style={{ padding: 6 }}>{DOC_LABELS[r.doc_type]}</td>
                    <td style={{ padding: 6 }}>{r.doctor_name || '—'}</td>
                    <td style={{ padding: 6, maxWidth: 280 }}>
                      {r.missing.length > 0
                        ? <span style={{ color: C.amber }}>Thiếu {r.missing.length} thông tin</span>
                        : st ? <Badge text={st.text} bg={st.bg} color={st.color} size={FS.xs} /> : <span style={{ color: C.green }}>Sẵn sàng</span>}
                      {r.message && r.status === 'error' && <div style={{ color: C.red, marginTop: 3 }}>{r.message}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Btn onClick={preview} disabled={!connected || Boolean(running) || chosen.length !== 1}>Điền thử 1 hồ sơ</Btn>
        <Btn variant="primary" onClick={() => setConfirming(true)} disabled={!connected || Boolean(running) || !chosen.some(ready)}>
          Nhập thật {chosen.filter(ready).length || ''} hồ sơ
        </Btn>
        {running && <>
          <Spinner size={12} />
          <span style={{ fontSize: FS.xs, color: C.text2 }}>{running.save ? 'Nhập thật' : 'Điền thử'} {running.done}/{running.total}{running.current ? `: ${running.current}` : ''}</span>
          {running.save && <Btn onClick={() => { stopRef.current = true; }} style={{ height: 26 }}>Dừng sau hồ sơ này</Btn>}
        </>}
      </div>

      {confirming && (
        <div style={{ padding: 10, borderRadius: 8, border: `1px solid ${C.redBorder}`, background: C.redBg, fontSize: FS.sm, lineHeight: 1.6 }}>
          Data Hub sẽ bấm <b>Lưu</b> trên cổng BHYT cho {chosen.filter(ready).length} hồ sơ đã chọn và tick "Đã nộp" khi cổng nhận.
          Gõ chính xác <b>NHẬP THẬT</b> để tiếp tục.
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <input value={confirmText} onChange={e => setConfirmText(e.target.value)} style={{ ...INPUT, width: 160 }} aria-label="Xác nhận nhập thật" />
            <Btn variant="primary" disabled={confirmText.trim() !== 'NHẬP THẬT'} onClick={startReal}>Nhập thật</Btn>
            <Btn onClick={() => { setConfirming(false); setConfirmText(''); }}>Huỷ</Btn>
          </div>
        </div>
      )}
    </div>
  );
}
