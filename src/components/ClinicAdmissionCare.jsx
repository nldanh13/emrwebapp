// src/components/ClinicAdmissionCare.jsx — TH3 Nhập viện: nhập chăm sóc cho người bệnh
// chuyển từ Khoa Khám Bệnh. Tìm trong Danh sách điều trị nội trú (Khoa chuyển đến = Khoa
// Khám Bệnh, T/G vào đúng ngày chọn), gợi ý vị trí đau từ y lệnh đầu tiên, xem phiếu đã có.
// Mỗi người 2 phiếu (Khoa Khám Bệnh chuyển, Khoa nhận có sinh hiệu); ca đã đủ 2 phiếu thì bỏ ra.
// Người lập lấy theo Lịch Phòng khám ở Lịch điều dưỡng.
// Danh sách đã tìm và nội dung đã sửa tự lưu theo ngày (máy chủ); tìm lại thì giữ nội dung đã sửa,
// không đọc lại y lệnh đầu của người đã có.
import { useEffect, useRef, useState } from 'react';
import { IconClipboardPlus, IconSearch } from '@tabler/icons-react';
import { C, FS } from '../tokens.js';
import { Btn } from './shared.jsx';
import { clinicLoginPayload, hasClinicLogin } from './ClinicAccountPicker.jsx';
import * as api from '../api.js';
import { useOnTabReturn } from '../hooks/useTabActivity.js';
import {
  bothDone, CLINIC_CARE, inputPayloadRows, mergeSaved, rowKey, rowProblems, rowsToInput, setClinicDienBien, VITAL_FIELDS, WARD_NAME, withSheetDefaults,
} from './clinic/careSheets.js';

export { rowKey };
const SAVE_DELAY_MS = 800;
const hhmm = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const DEFAULT_DIEN_BIEN = [
  'Phòng khám Chấn thương chỉnh hình - Thần kinh nhận',
  'Người bệnh tỉnh',
  'Tiếp xúc tốt',
  'Da niêm hồng',
  'Mạch rõ, chi ấm',
  'Đau vùng tổn thương',
  'Vận động hạn chế',
  'Tiền sử dị ứng thuốc chưa ghi nhận',
].join('\n');

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function resultFor(result, r) {
  if (!result) return null;
  const key = rowKey(r);
  if ((result.succeeded || []).includes(key)) return { tone: C.green, text: 'Đã có đủ 2 phiếu chăm sóc hoàn tất' };
  if (result.failed?.[key]) return { tone: C.red, text: result.failed[key] };
  if (result.skipped && typeof result.skipped === 'object' && result.skipped[key]) return { tone: C.text2, text: `Bỏ qua: ${result.skipped[key]}` };
  return null;
}

export default function ClinicAdmissionCare({ creds, toast }) {
  const [careDate, setCareDate] = useState(todayIso);
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState(null);
  const [rows, setRows] = useState([]);
  const [result, setResult] = useState(null);
  const [save, setSave] = useState({ state: '', at: '' }); // '' | 'pending' | 'saved' | 'error'
  const pending = useRef(null); // { day, rows } chờ tự lưu
  const timer = useRef(null);

  const flush = async () => {
    clearTimeout(timer.current);
    const job = pending.current;
    pending.current = null;
    if (!job) return;
    try {
      const r = await api.saveClinicAdmissionCare(job.day, job.rows);
      setSave({ state: 'saved', at: r.saved_at || new Date().toISOString() });
    } catch (e) {
      setSave({ state: 'error', at: '' });
      toast?.(`Chưa lưu được nội dung nhập chăm sóc: ${e.message || e}. Sửa tiếp sẽ thử lưu lại.`, 'error');
    }
  };

  // Mọi thay đổi danh sách/nội dung: lưu sau ~0,8 giây kể từ lần sửa cuối.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const changeRows = (fn) => {
    const next = typeof fn === 'function' ? fn(rowsRef.current) : fn;
    rowsRef.current = next;
    setRows(next);
    pending.current = { day: careDate, rows: next };
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DELAY_MS);
    setSave(s => ({ ...s, state: 'pending' }));
  };

  const loadSaved = async (day) => {
    try {
      const r = await api.getClinicAdmissionCare(day);
      const saved = r.saved?.rows || [];
      rowsRef.current = saved;
      setRows(saved);
      setPreview(null);
      setResult(null);
      setSave({ state: saved.length ? 'saved' : '', at: r.saved?.saved_at || '' });
    } catch (e) {
      toast?.(`Không tải được nội dung đã lưu: ${e.message || e}`, 'error');
    }
  };

  // Đổi ngày: lưu ngay phần đang chờ của ngày cũ rồi mở bản đã lưu của ngày mới.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await flush();
      if (!cancelled) await loadSaved(careDate);
    })();
    return () => { cancelled = true; };
  }, [careDate]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { flush(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Quay lại tab: lấy bản mới nhất (máy khác có thể đã sửa), trừ khi đang chạy hoặc đang chờ lưu/nhập.
  useOnTabReturn(() => {
    if (!busy && !pending.current && !preview?.precheck_token) loadSaved(careDate);
  });

  const base = () => ({
    ...clinicLoginPayload(creds),
    loginUrl: creds.loginUrl,
    headless: creds.headless,
    careDate,
    careContent: CLINIC_CARE,
    dienBien: DEFAULT_DIEN_BIEN,
    needsVitals: false,
  });

  const find = async () => {
    setBusy('find');
    setResult(null);
    try {
      const r = await api.runClinicCarePreview(base());
      if (r.status !== 'ok') throw new Error(r.message);
      // Người đã có nội dung lưu: giữ nội dung đã sửa; thông tin EMR lấy theo lần quét này.
      const found = mergeSaved((r.rows || []).map(row => ({ ...withSheetDefaults(row, DEFAULT_DIEN_BIEN), pain_note: '' })), rows);
      setPreview(r);
      changeRows(found);
      toast?.(r.message, 'ok');
      const withHistory = found.filter(row => row.can_input);
      if (withHistory.length) {
        setBusy('seeds');
        const s = await api.runClinicCareOrderSeeds({ ...base(), rows: withHistory.map(row => ({ ...row, client_key: rowKey(row), skip_seed: Boolean(row.restored) })) });
        const byKey = new Map((s.results || []).map(item => [item.row_key, item]));
        changeRows(prev => prev.map(row => {
          const item = byKey.get(rowKey(row));
          if (!item) return row;
          let next = { ...row, sheets_done: item.sheets_done || null, sheets_error: item.sheets_error || '' };
          if (row.restored || item.seed_skipped) {
            // nội dung đã lưu: không ghi đè
          } else if (item.suggestion_available) {
            next = { ...setClinicDienBien(next, item.suggested_dien_bien), pain_note: `Vị trí đau từ y lệnh đầu: ${item.pain_location}` };
          } else {
            next.pain_note = item.error || 'Chưa nhận diện được vị trí đau, đang dùng mẫu chung.';
          }
          return next;
        }));
        if (s.message) toast?.(s.message, s.status === 'ok' ? 'ok' : 'info');
      }
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setBusy('');
    }
  };

  const inputRows = rowsToInput(rows);
  const doneRows = rows.filter(bothDone);
  const shownRows = rows.filter(r => !bothDone(r));

  const input = async () => {
    const n = inputRows.length;
    if (!window.confirm(`Nhập phiếu chăm sóc cho ${n} người bệnh nhập viện trên EMR?\n\nMỗi người 2 phiếu: Khoa Khám Bệnh chuyển (đúng T/G vào, người lập theo Lịch Phòng khám) và ${WARD_NAME} nhận (giờ như đã nhập, người lập là người trực theo Lịch điều dưỡng). Sinh hiệu phiếu 2: ô đã gõ dùng số đó, ô trống điền như phiếu chăm sóc thường. Phiếu đã Hoàn tất thì giữ nguyên.`)) return;
    setBusy('input');
    try {
      const r = await api.runClinicInputCare({
        ...base(),
        precheck_token: preview?.precheck_token,
        rows: inputPayloadRows(rows),
      });
      setResult(r.result || null);
      toast?.(r.message, r.status === 'ok' ? 'ok' : 'error');
      // Mã kiểm tra trước chỉ dùng được một lần; muốn nhập lại phải tìm lại.
      setPreview(prev => (prev ? { ...prev, precheck_token: '' } : prev));
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setBusy('');
    }
  };

  const update = (key, fn) => changeRows(prev => prev.map(r => (rowKey(r) === key ? fn(r) : r)));
  const hasCreds = Boolean(hasClinicLogin(creds) && creds.hasEmrUrl);

  return (
    <section style={{ border: `1px solid ${C.border2}`, borderRadius: 8, background: C.surface, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'end', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px' }}>
          <div style={{ fontSize: FS.md, fontWeight: 700 }}>Nhập viện · nhập chăm sóc</div>
          <div style={{ fontSize: FS.sm, color: C.text2 }}>
            Tìm người bệnh có Khoa chuyển đến = Khoa Khám Bệnh và T/G vào đúng ngày chọn. Mỗi người 2 phiếu:
            Khoa Khám Bệnh chuyển và {WARD_NAME} nhận (có sinh hiệu như phiếu chăm sóc thường). Ca đã đủ 2 phiếu thì không cần nhập.
          </div>
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: FS.sm, color: C.text2, fontWeight: 600 }}>
          Ngày T/G vào
          <input type="date" value={careDate} onChange={e => setCareDate(e.target.value)} disabled={Boolean(busy)}
            style={{ height: 32, padding: '0 8px', border: `1px solid ${C.border}`, borderRadius: 5, fontFamily: 'inherit', fontSize: FS.md }} />
        </label>
        <Btn icon={IconSearch} loading={busy === 'find' || busy === 'seeds'} disabled={!hasCreds || Boolean(busy) || !careDate} onClick={find}>
          {busy === 'seeds' ? 'Đang đọc y lệnh đầu và phiếu đã có…' : 'Tìm người nhập viện'}
        </Btn>
        <Btn variant="primary" icon={IconClipboardPlus} loading={busy === 'input'}
          disabled={!inputRows.length || !preview?.precheck_token || Boolean(busy)} onClick={input}>
          {`Nhập chăm sóc ${inputRows.length} người bệnh`}
        </Btn>
      </div>
      {rows.length > 0 && (
        <div style={{ fontSize: FS.sm, color: save.state === 'error' ? C.red : C.text2 }}>
          {save.state === 'pending' ? 'Có thay đổi, đang chờ tự lưu…'
            : save.state === 'error' ? 'Chưa lưu được, sửa tiếp sẽ thử lưu lại.'
              : save.at ? `Đã tự lưu lúc ${hhmm(save.at)}.` : ''}
          {!preview?.precheck_token && ' Bấm "Tìm người nhập viện" để kiểm tra lại EMR trước khi nhập; nội dung đã sửa được giữ, không đọc lại y lệnh đầu.'}
        </div>
      )}
      {!hasCreds && <div style={{ fontSize: FS.sm, color: C.amber }}>Chọn bác sĩ (hoặc nhập tài khoản, mật khẩu) ở phía trên trước.</div>}

      {(preview || rows.length > 0) && (
        // Khung cuộn riêng: nhiều người nhập viện không kéo dài cả trang.
        <div style={{ overflow: 'auto', maxHeight: '70vh', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {shownRows.map(r => (
            <PatientCard key={rowKey(r)} row={r} res={resultFor(result, r)} disabled={Boolean(busy)}
              onChange={fn => update(rowKey(r), fn)} />
          ))}
          {preview && !rows.length && <div style={{ padding: 16, textAlign: 'center', color: C.text2 }}>Không có người bệnh nhập viện từ Khoa Khám Bệnh trong ngày này.</div>}
          {doneRows.length > 0 && (
            <details style={{ fontSize: FS.sm, color: C.text2 }}>
              <summary style={{ cursor: 'pointer' }}>Đã đủ 2 phiếu Hoàn tất, không cần nhập ({doneRows.length})</summary>
              {doneRows.map(r => <div key={rowKey(r)} style={{ padding: '4px 0' }}>{r.ho_ten} · {r.ma_bn} · {r.care_time_str}</div>)}
            </details>
          )}
        </div>
      )}
    </section>
  );
}

const boxStyle = { width: '100%', boxSizing: 'border-box', padding: 6, border: `1px solid ${C.border}`, borderRadius: 5, fontFamily: 'inherit', fontSize: FS.sm, resize: 'vertical' };
const labelStyle = { display: 'flex', flexDirection: 'column', gap: 2, fontSize: FS.xs, color: C.text2, fontWeight: 600 };

function SheetBox({ title, done, children }) {
  return (
    <div style={{ flex: '1 1 300px', minWidth: 0, border: `1px solid ${C.border2}`, borderRadius: 6, padding: 8, display: 'flex', flexDirection: 'column', gap: 6, background: C.surface2 }}>
      <div style={{ fontSize: FS.sm, fontWeight: 700, color: C.text, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>{title}</div>
      {done ? <div style={{ fontSize: FS.sm, color: C.green }}>Đã có phiếu Hoàn tất trên EMR, không nhập lại.</div> : children}
    </div>
  );
}

function PatientCard({ row: r, res, disabled, onChange }) {
  const done = r.sheets_done || {};
  const problems = r.can_input && !r.skip ? rowProblems(r) : [];
  const set = key => e => onChange(row => ({ ...row, [key]: e.target.value }));
  const noAccount = name => name && (r.thieu_tai_khoan || []).includes(name)
    ? <span style={{ color: C.red }}> · chưa có tài khoản EMR (Cài đặt → Thiết lập tài khoản)</span> : null;
  const setVital = key => e => onChange(row => ({ ...row, vitals: { ...row.vitals, [key]: e.target.value } }));
  return (
    <div style={{ border: `1px solid ${C.border2}`, borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 8, opacity: r.skip ? 0.6 : 1 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', fontSize: FS.sm }}>
        {r.can_input && (
          <label style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
            <input type="checkbox" checked={!r.skip} disabled={disabled} onChange={e => onChange(row => ({ ...row, skip: !e.target.checked }))} />
            Nhập
          </label>
        )}
        <b style={{ fontSize: FS.md }}>{r.ho_ten}</b>
        <span style={{ color: C.text2, fontVariantNumeric: 'tabular-nums' }}>{r.ma_bn}</span>
        <span style={{ color: C.text2 }}>T/G vào {r.care_time_str}</span>
        <span>Người lập phiếu 1: {r.dieu_duong || <span style={{ color: C.red }}>Chưa có lịch</span>}{noAccount(r.dieu_duong)}</span>
        <span>Người nhận (trực): {r.nguoi_nhan || <span style={{ color: C.red }}>Chưa có lịch trực</span>}{noAccount(r.nguoi_nhan)}</span>
        {res && <span style={{ marginLeft: 'auto', color: res.tone, fontWeight: 600 }}>{res.text}</span>}
      </div>
      {!r.can_input ? (
        <div style={{ color: C.amber, fontSize: FS.sm }}>{!r.has_nursing_link ? 'Không có liên kết hồ sơ điều dưỡng' : 'Chưa xác định được người lập'}</div>
      ) : !r.skip && (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <SheetBox title={`1 · Khoa Khám Bệnh chuyển · ${r.care_time_str}`} done={done.kham}>
              <label style={labelStyle}>Diễn biến
                <textarea value={r.dien_bien} onChange={e => onChange(row => setClinicDienBien(row, e.target.value))} rows={5} disabled={disabled}
                  aria-label={`Diễn biến phiếu 1 của ${r.ho_ten}`} style={boxStyle} />
              </label>
              {r.pain_note && <div style={{ fontSize: FS.xs, color: C.text2 }}>{r.pain_note}</div>}
              <label style={labelStyle}>Chăm sóc
                <textarea value={r.cham_soc} onChange={set('cham_soc')} rows={2} disabled={disabled} aria-label={`Chăm sóc phiếu 1 của ${r.ho_ten}`} style={boxStyle} />
              </label>
            </SheetBox>
            <SheetBox done={done.khoa} title={(
              <>
                <span>2 · {WARD_NAME} nhận</span>
                {!done.khoa && (
                  <input value={r.khoa_time_str} onChange={set('khoa_time_str')} disabled={disabled} aria-label={`Giờ phiếu 2 của ${r.ho_ten}`}
                    placeholder="HH:mm dd/mm/yyyy" style={{ width: 130, height: 26, padding: '0 6px', border: `1px solid ${C.border}`, borderRadius: 5, fontFamily: 'inherit', fontSize: FS.sm }} />
                )}
              </>
            )}>
              <label style={labelStyle}>Diễn biến
                <textarea value={r.dien_bien_khoa} onChange={set('dien_bien_khoa')} rows={5} disabled={disabled} aria-label={`Diễn biến phiếu 2 của ${r.ho_ten}`} style={boxStyle} />
              </label>
              <label style={labelStyle}>Chăm sóc
                <textarea value={r.cham_soc_khoa} onChange={set('cham_soc_khoa')} rows={5} disabled={disabled} aria-label={`Chăm sóc phiếu 2 của ${r.ho_ten}`} style={boxStyle} />
              </label>
              <div style={{ fontSize: FS.xs, color: C.text2 }}>Sinh hiệu: để trống thì điền như phiếu chăm sóc thường; gõ số nếu đã đo khác.</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {VITAL_FIELDS.map(([key, label, unit]) => (
                  <label key={key} style={{ ...labelStyle, flex: '1 1 80px' }}>{`${label} (${unit})`}
                    <input value={r.vitals?.[key] || ''} onChange={setVital(key)} disabled={disabled} inputMode={key === 'huyet_ap' ? 'text' : 'decimal'}
                      placeholder="tự điền" aria-label={`${label} của ${r.ho_ten}`}
                      style={{ height: 28, padding: '0 6px', border: `1px solid ${C.border}`, borderRadius: 5, fontFamily: 'inherit', fontSize: FS.sm }} />
                  </label>
                ))}
              </div>
            </SheetBox>
          </div>
          {r.sheets_error && <div style={{ fontSize: FS.xs, color: C.amber }}>{r.sheets_error} Phiếu đã có sẽ được kiểm tra lại lúc nhập.</div>}
          {problems.length > 0 && <div style={{ fontSize: FS.sm, color: C.amber }}>Còn thiếu: {problems.join(', ')}.</div>}
        </>
      )}
    </div>
  );
}
