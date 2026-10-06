// Dọn mục "X + Natri clorid 0.9%" trong Danh mục thuốc: xem trước từng việc, chọn rồi dọn một lần.
// Máy chủ sao lưu danh mục trước khi ghi (server/services/catalog_cleanup.js).
import { useState } from 'react';
import { C, FS } from '../tokens.js';
import { Btn } from './shared.jsx';
import * as api from '../api.js';

export default function CatalogCleanupPanel({ plan = [], onDone }) {
  const [open, setOpen] = useState(false);
  const [skip, setSkip] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!plan.length) return null;
  const chosen = plan.filter(p => !skip.has(p.key));

  const run = async () => {
    if (!window.confirm(`Dọn ${chosen.length} mục? Danh mục được sao lưu trước khi sửa.`)) return;
    setBusy(true); setError('');
    try {
      const r = await api.applyCatalogCleanup(chosen.map(p => p.key));
      onDone?.(`Đã dọn ${r.applied?.length || 0} mục. Bản sao lưu: ${r.backup || '—'}. Xem "Cách pha gợi ý" trong từng thuốc để duyệt thể tích cũ.`);
      setOpen(false);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginBottom: 14, padding: '9px 12px', borderRadius: 7, background: C.amberBg, border: `1px solid ${C.amberBorder}` }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 320px', fontSize: FS.sm, color: C.text }}>
          <b>{plan.length} mục kiểu "thuốc + Natri clorid 0.9%"</b> do bản cũ tự sinh — trùng với thuốc gốc, thể tích mâu thuẫn.
          Dọn để mỗi thuốc chỉ còn một dòng; thể tích cũ được giữ thành <i>cách pha gợi ý</i> để bạn duyệt.
        </div>
        <Btn variant="secondary" onClick={() => setOpen(v => !v)} style={{ fontSize: FS.xs, padding: '2px 10px' }}>{open ? 'Ẩn' : 'Xem và dọn'}</Btn>
      </div>
      {open && (
        <div style={{ marginTop: 8, display: 'grid', gap: 4 }}>
          {plan.map(p => (
            <label key={p.key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: FS.xs, color: C.text2 }}>
              <input type="checkbox" checked={!skip.has(p.key)} onChange={e => setSkip(prev => {
                const next = new Set(prev); if (e.target.checked) next.delete(p.key); else next.add(p.key); return next;
              })} />
              <span><b style={{ color: C.text }}>{p.key}</b> — {p.note}</span>
            </label>
          ))}
          {error && <div role="alert" style={{ color: C.red, fontSize: FS.sm }}>{error}</div>}
          <div><Btn variant="primary" disabled={busy || !chosen.length} onClick={run}>{busy ? 'Đang dọn…' : `Dọn ${chosen.length} mục`}</Btn></div>
        </div>
      )}
    </div>
  );
}
