// src/components/ClinicAdmissionCare.jsx — TH3 Nhập viện: nhập chăm sóc cho người bệnh
// chuyển từ Khoa Khám Bệnh. Tìm trong Danh sách điều trị nội trú (Khoa chuyển đến = Khoa
// Khám Bệnh, T/G vào đúng ngày chọn), gợi ý vị trí đau từ y lệnh đầu tiên, cho sửa diễn
// biến từng người rồi mới nhập. Người lập lấy theo Lịch Phòng khám ở Lịch điều dưỡng.
import { useState } from 'react';
import { IconClipboardPlus, IconSearch } from '@tabler/icons-react';
import { C, FS } from '../tokens.js';
import { Btn } from './shared.jsx';
import { clinicLoginPayload, hasClinicLogin } from './ClinicAccountPicker.jsx';
import * as api from '../api.js';

const DEFAULT_CARE_CONTENT = 'Hoàn tất hồ sơ nhập viện + Kính chuyển Khoa Ngoại Chấn Thương Chỉnh Hình và Thần Kinh + Hồ sơ';
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

export function rowKey(r) {
  return `${r.ma_bn}::${r.care_time_str}`;
}

function resultFor(result, r) {
  if (!result) return null;
  const key = rowKey(r);
  if ((result.succeeded || []).includes(key)) return { tone: C.green, text: 'Đã có phiếu chăm sóc hoàn tất' };
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

  const base = () => ({
    ...clinicLoginPayload(creds),
    loginUrl: creds.loginUrl,
    headless: creds.headless,
    careDate,
    careContent: DEFAULT_CARE_CONTENT,
    dienBien: DEFAULT_DIEN_BIEN,
    needsVitals: false,
  });

  const find = async () => {
    setBusy('find');
    setResult(null);
    try {
      const r = await api.runClinicCarePreview(base());
      if (r.status !== 'ok') throw new Error(r.message);
      const found = (r.rows || []).map(row => ({ ...row, dien_bien: DEFAULT_DIEN_BIEN, pain_note: '' }));
      setPreview(r);
      setRows(found);
      toast?.(r.message, 'ok');
      const withHistory = found.filter(row => row.can_input);
      if (withHistory.length) {
        setBusy('seeds');
        const s = await api.runClinicCareOrderSeeds({ ...base(), rows: withHistory.map(row => ({ ...row, client_key: rowKey(row) })) });
        const byKey = new Map((s.results || []).map(item => [item.row_key, item]));
        setRows(prev => prev.map(row => {
          const item = byKey.get(rowKey(row));
          if (!item) return row;
          if (item.suggestion_available) return { ...row, dien_bien: item.suggested_dien_bien, pain_note: `Vị trí đau từ y lệnh đầu: ${item.pain_location}` };
          return { ...row, pain_note: item.error || 'Chưa nhận diện được vị trí đau, đang dùng mẫu chung.' };
        }));
        if (s.message) toast?.(s.message, s.status === 'ok' ? 'ok' : 'info');
      }
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setBusy('');
    }
  };

  const inputRows = rows.filter(r => r.can_input && String(r.dien_bien || '').trim());

  const input = async () => {
    const n = inputRows.length;
    if (!window.confirm(`Nhập phiếu chăm sóc cho ${n} người bệnh nhập viện trên EMR?\n\nThời gian lập = đúng T/G vào của từng người, người lập theo Lịch Phòng khám. Phiếu đã đúng sẽ được giữ nguyên.`)) return;
    setBusy('input');
    try {
      const r = await api.runClinicInputCare({
        ...base(),
        precheck_token: preview?.precheck_token,
        rows: inputRows.map(row => ({ ...row, saved_for_input: true })),
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

  const setDienBien = (key, value) => setRows(prev => prev.map(r => (rowKey(r) === key ? { ...r, dien_bien: value } : r)));
  const hasCreds = Boolean(hasClinicLogin(creds) && creds.loginUrl);

  return (
    <section style={{ border: `1px solid ${C.border2}`, borderRadius: 8, background: C.surface, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'end', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px' }}>
          <div style={{ fontSize: FS.md, fontWeight: 700 }}>Nhập viện · nhập chăm sóc</div>
          <div style={{ fontSize: FS.sm, color: C.text2 }}>
            Tìm người bệnh có Khoa chuyển đến = Khoa Khám Bệnh và T/G vào đúng ngày chọn. Không nhập sinh hiệu.
          </div>
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: FS.sm, color: C.text2, fontWeight: 600 }}>
          Ngày T/G vào
          <input type="date" value={careDate} onChange={e => setCareDate(e.target.value)} disabled={Boolean(busy)}
            style={{ height: 32, padding: '0 8px', border: `1px solid ${C.border}`, borderRadius: 5, fontFamily: 'inherit', fontSize: FS.md }} />
        </label>
        <Btn icon={IconSearch} loading={busy === 'find' || busy === 'seeds'} disabled={!hasCreds || Boolean(busy) || !careDate} onClick={find}>
          {busy === 'seeds' ? 'Đang đọc y lệnh đầu…' : 'Tìm người nhập viện'}
        </Btn>
        <Btn variant="primary" icon={IconClipboardPlus} loading={busy === 'input'}
          disabled={!inputRows.length || !preview?.precheck_token || Boolean(busy)} onClick={input}>
          {`Nhập chăm sóc ${inputRows.length} người bệnh`}
        </Btn>
      </div>
      {!hasCreds && <div style={{ fontSize: FS.sm, color: C.amber }}>Chọn bác sĩ (hoặc nhập tài khoản, mật khẩu) và URL đăng nhập ở phía trên trước.</div>}

      {preview && (
        <div style={{ overflow: 'auto', border: `1px solid ${C.border2}`, borderRadius: 6 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: FS.md }}>
            <thead>
              <tr style={{ background: C.surface2 }}>
                {['Mã BN', 'Họ tên', 'T/G vào', 'Người lập', 'Diễn biến', 'Kết quả'].map(h => (
                  <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontSize: FS.xs, color: C.text2, fontWeight: 700, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const key = rowKey(r);
                const res = resultFor(result, r);
                return (
                  <tr key={key} style={{ borderBottom: `1px solid ${C.border2}`, verticalAlign: 'top' }}>
                    <td style={{ padding: '8px 10px', fontVariantNumeric: 'tabular-nums' }}>{r.ma_bn}</td>
                    <td style={{ padding: '8px 10px', fontWeight: 600 }}>{r.ho_ten}</td>
                    <td style={{ padding: '8px 10px', whiteSpace: 'nowrap', color: C.text2 }}>{r.care_time_str}</td>
                    <td style={{ padding: '8px 10px' }}>{r.dieu_duong || <span style={{ color: C.red }}>Chưa có lịch</span>}</td>
                    <td style={{ padding: '8px 10px', minWidth: 280 }}>
                      {r.can_input ? (
                        <>
                          <textarea value={r.dien_bien} onChange={e => setDienBien(key, e.target.value)} rows={8} disabled={Boolean(busy)}
                            aria-label={`Diễn biến của ${r.ho_ten}`}
                            style={{ width: '100%', boxSizing: 'border-box', padding: 6, border: `1px solid ${C.border}`, borderRadius: 5, fontFamily: 'inherit', fontSize: FS.sm }} />
                          {r.pain_note && <div style={{ fontSize: FS.xs, color: C.text2 }}>{r.pain_note}</div>}
                        </>
                      ) : (
                        <span style={{ color: C.amber, fontSize: FS.sm }}>
                          {!r.has_nursing_link ? 'Không có liên kết hồ sơ điều dưỡng' : 'Chưa xác định được người lập'}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '8px 10px', fontSize: FS.sm, color: res?.tone || C.text3 }}>{res?.text || '—'}</td>
                  </tr>
                );
              })}
              {!rows.length && (
                <tr><td colSpan={6} style={{ padding: 16, textAlign: 'center', color: C.text2 }}>Không có người bệnh nhập viện từ Khoa Khám Bệnh trong ngày này.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
