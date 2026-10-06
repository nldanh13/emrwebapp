// Kiểm tra quy tắc pha thuốc: gõ tên thuốc như trong EMR → xem bước xử lý dữ liệu sẽ làm gì.
// Kết quả do máy chủ chạy ĐÚNG hàm xử lý của worker (worker/dilution_check.py), không đoán ở đây.
import { useState } from 'react';
import { IconChevronDown, IconChevronUp } from '@tabler/icons-react';
import { C, FS } from '../tokens.js';
import { Btn } from './shared.jsx';
import * as api from '../api.js';
import { describeCheck, dilutionSummary } from '../utils/dilutionRule.js';
import { SkeletonLines } from './Skeleton.jsx';

const INPUT = {
  width: '100%', padding: '6px 10px', borderRadius: 6, background: C.surface,
  border: `1px solid ${C.border}`, color: C.text, fontSize: FS.md, boxSizing: 'border-box', fontFamily: 'inherit',
};
const FORMS = ['Lọ', 'Ống', 'Chai', 'Túi', 'Bột pha tiêm'];

export default function DilutionCheckPanel({ builtin = [] }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ ten_thuoc: '', dang: 'Lọ', duong_dung_goc: '', so_luong: '', gio_dung: '' });
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const set = key => e => setForm(prev => ({ ...prev, [key]: e.target.value }));

  const run = async () => {
    setError('');
    if (!form.ten_thuoc.trim()) { setError('Nhập tên thuốc như trong y lệnh EMR.'); return; }
    setChecking(true);
    try {
      const data = await api.checkMedicationDilution({ items: [form] });
      setResult(data.items?.[0] || null);
    } catch (e) {
      setError(String(e.message || e));
      setResult(null);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div style={{ marginBottom: 14, border: `1px solid ${C.border2}`, borderRadius: 7, background: C.surface }}>
      <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open} style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 6, padding: '9px 12px', background: 'none',
        border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: FS.sm, fontWeight: 600, color: C.text, textAlign: 'left',
      }}>
        {open ? <IconChevronUp size={15} stroke={1.9} aria-hidden="true" /> : <IconChevronDown size={15} stroke={1.9} aria-hidden="true" />}
        Kiểm tra quy tắc pha thuốc
        <span style={{ fontWeight: 400, color: C.text3 }}>— gõ tên thuốc, xem bước xử lý dữ liệu sẽ pha thế nào</span>
      </button>
      {open && (
        <div style={{ padding: '0 12px 12px', display: 'grid', gap: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
            <label style={{ fontSize: FS.xs, color: C.text2 }}>Tên thuốc (như trong EMR)
              <input value={form.ten_thuoc} onChange={set('ten_thuoc')} onKeyDown={e => e.key === 'Enter' && run()}
                placeholder="VD: VANCOMYCIN 1G" style={{ ...INPUT, marginTop: 3 }} />
            </label>
            <label style={{ fontSize: FS.xs, color: C.text2 }}>Dạng
              <select value={form.dang} onChange={set('dang')} style={{ ...INPUT, marginTop: 3 }}>
                {FORMS.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
            </label>
            <label style={{ fontSize: FS.xs, color: C.text2 }}>Cách dùng trong y lệnh (tuỳ chọn)
              <input value={form.duong_dung_goc} onChange={set('duong_dung_goc')} onKeyDown={e => e.key === 'Enter' && run()}
                placeholder="VD: Tiêm truyền TM 30 giọt/phút" style={{ ...INPUT, marginTop: 3 }} />
            </label>
            <label style={{ fontSize: FS.xs, color: C.text2 }}>Số lọ/ống cả ngày (để tính liều mỗi lần)
              <input value={form.so_luong} onChange={set('so_luong')} inputMode="decimal" placeholder="VD: 2" style={{ ...INPUT, marginTop: 3 }} />
            </label>
            <label style={{ fontSize: FS.xs, color: C.text2 }}>Giờ dùng
              <input value={form.gio_dung} onChange={set('gio_dung')} placeholder="VD: 8 giờ, 20 giờ" style={{ ...INPUT, marginTop: 3 }} />
            </label>
          </div>
          <div><Btn variant="primary" disabled={checking} onClick={run}>Kiểm tra</Btn></div>
          {error && <div role="alert" style={{ color: C.red, fontSize: FS.sm }}>{error}</div>}
          {checking && <div role="status" aria-busy="true" aria-label="Đang kiểm tra"><SkeletonLines lines={2} /></div>}
          {!checking && result && (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: FS.sm, color: C.text, lineHeight: 1.6 }}>
              {describeCheck(result).map((line, i) => <li key={i}>{line}</li>)}
            </ul>
          )}
          {builtin.length > 0 && (
            <details style={{ fontSize: FS.xs, color: C.text2 }}>
              <summary style={{ cursor: 'pointer' }}>Luật sẵn có ({builtin.length}) — áp dụng khi Danh mục thuốc chưa đặt quy tắc</summary>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, lineHeight: 1.6 }}>
                {builtin.map(r => (
                  <li key={r.keyword}><b>{r.keyword}</b>: {dilutionSummary(r)}{r.note ? ` — ${r.note}` : ''}</li>
                ))}
              </ul>
              <div style={{ marginTop: 6 }}>Muốn đổi: thêm (hoặc sửa) thuốc trong danh mục và đặt "Quy tắc pha thuốc". Quy tắc trong danh mục luôn được ưu tiên hơn luật sẵn có.</div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
