// "Thuốc mới": thuốc có trong dữ liệu (phiên + Kho nghiên cứu) nhưng chưa có trong Danh mục thuốc.
// Máy chủ khớp bằng đúng hàm tra danh mục của bước xử lý (worker/catalog_gaps.py). "Thiết lập" mở form
// thêm thuốc điền sẵn từ dữ liệu; "Bỏ qua" ẩn thuốc khỏi danh sách (không sửa danh mục).
import { useState } from 'react';
import { C, FS } from '../tokens.js';
import { Btn } from './shared.jsx';
import * as api from '../api.js';
import { newDrugSummary, prefillFromNewDrug } from '../utils/newDrugs.js';
import { SkeletonLines } from './Skeleton.jsx';

const SOURCE = { du_lieu_phien: 'dữ liệu đang xử lý', kho_nghien_cuu: 'Kho nghiên cứu' };

export default function NewDrugsPanel({ data, error, onSetup, onChanged }) {
  const [showIgnored, setShowIgnored] = useState(false);
  const [busyKey, setBusyKey] = useState('');
  const [q, setQ] = useState('');
  if (error) return <div role="alert" style={{ padding: 14, color: C.red, fontSize: FS.sm }}>{error}</div>;
  if (!data) return <div role="status" aria-busy="true" aria-label="Đang tìm thuốc mới" style={{ padding: 14 }}><SkeletonLines lines={6} /></div>;

  const needle = q.trim().toLowerCase();
  const list = (data.drugs || [])
    .filter(d => showIgnored || !d.ignored)
    .filter(d => !needle || `${d.name} ${d.ingredient || ''}`.toLowerCase().includes(needle));
  const toggleIgnore = async d => {
    setBusyKey(d.key);
    try { await api.ignoreNewDrug(d.key, !d.ignored); await onChanged?.(); } finally { setBusyKey(''); }
  };

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ padding: '9px 12px', borderRadius: 7, background: C.blueBg, border: `1px solid ${C.blueBorder}`, fontSize: FS.sm, color: C.text2, lineHeight: 1.5 }}>
        Thuốc đã gặp trong y lệnh nhưng <b>chưa có trong Danh mục</b>, xếp theo số lần gặp. Bấm <b>Thiết lập</b> để thêm (điền sẵn tên, hoạt chất,
        đường dùng, thể tích theo dữ liệu — kiểm tra lại rồi lưu). Thuốc không cần khai báo thì <b>Bỏ qua</b>. Danh sách tự cập nhật khi có dữ liệu mới
        hoặc khi bạn thêm thuốc.
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Tìm tên thuốc, hoạt chất..."
          style={{ padding: '6px 10px', borderRadius: 6, border: `1px solid ${C.border}`, background: C.surface, color: C.text, fontSize: FS.md, maxWidth: 360, width: '100%' }} />
        <label style={{ fontSize: FS.sm, color: C.text2, display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={showIgnored} onChange={e => setShowIgnored(e.target.checked)} /> Hiện cả thuốc đã bỏ qua
        </label>
      </div>
      {!list.length && (
        <div style={{ color: C.text3, padding: 16, textAlign: 'center', fontSize: FS.sm }}>
          {(data.drugs || []).length ? 'Không còn thuốc mới nào cần thiết lập.' : 'Chưa thấy thuốc nào ngoài danh mục trong dữ liệu đã có.'}
        </div>
      )}
      {list.map(d => (
        <div key={d.key} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '8px 12px',
          border: `1px solid ${C.border2}`, borderRadius: 7, background: C.surface, opacity: d.ignored ? 0.6 : 1 }}>
          <div style={{ flex: '1 1 300px', minWidth: 0 }}>
            <div style={{ fontSize: FS.md, fontWeight: 600, color: C.text }}>{d.name}</div>
            <div style={{ fontSize: FS.xs, color: C.text2 }}>{newDrugSummary(d)} · nguồn: {(d.sources || []).map(s => SOURCE[s] || s).join(', ')}</div>
            {(d.variants || []).length > 1 && <div style={{ fontSize: FS.xs, color: C.text3 }}>Cách viết khác: {d.variants.filter(v => v !== d.name).join(', ')}</div>}
          </div>
          {!d.ignored && <Btn variant="primary" onClick={() => onSetup?.(prefillFromNewDrug(d))} style={{ fontSize: FS.xs, padding: '2px 12px' }}>Thiết lập</Btn>}
          <Btn variant="default" disabled={busyKey === d.key} onClick={() => toggleIgnore(d)} style={{ fontSize: FS.xs, padding: '2px 10px' }}>
            {d.ignored ? 'Hiện lại' : 'Bỏ qua'}
          </Btn>
        </div>
      ))}
    </div>
  );
}
