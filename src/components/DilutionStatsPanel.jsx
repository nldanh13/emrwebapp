// "Thực tế trong dữ liệu": thuốc này đã được pha thế nào trong y lệnh đã có (Kho nghiên cứu + dữ liệu
// phiên), do máy chủ chạy lại đúng bước xử lý (worker/dilution_stats.py). Không mở EMR.
import { useState } from 'react';
import { C, FS } from '../tokens.js';
import { Btn } from './shared.jsx';
import * as api from '../api.js';
import { observedLabel, statsForDrug, variantFromObserved } from '../utils/dilutionRule.js';
import { SkeletonLines } from './Skeleton.jsx';

export default function DilutionStatsPanel({ drugName, setForm }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = async (refresh = false) => {
    setLoading(true); setError('');
    try { setStats(await api.getDilutionStats(refresh)); } catch (e) { setError(String(e.message || e)); } finally { setLoading(false); }
  };

  const s = stats ? statsForDrug(stats, drugName) : null;
  const useAsDefault = o => setForm(prev => ({ ...prev, dilution_solvent: o.solvent, dilution_volume_ml: o.volume_ml != null ? String(o.volume_ml) : '' }));
  const addVariant = o => setForm(prev => ({ ...prev, dilution_solvent: prev.dilution_solvent || o.solvent,
    dilution_variants: [...(prev.dilution_variants || []), variantFromObserved(o)] }));

  return (
    <div style={{ display: 'grid', gap: 6, paddingTop: 8, borderTop: `1px dashed ${C.border2}` }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <b style={{ fontSize: FS.xs, color: C.text2 }}>Thực tế trong dữ liệu</b>
        {!stats && !loading && <Btn variant="secondary" onClick={() => load(false)} style={{ fontSize: FS.xs, padding: '2px 10px' }}>Xem cách pha thực tế</Btn>}
        {stats && !loading && <Btn variant="default" onClick={() => load(true)} style={{ fontSize: FS.xs, padding: '2px 10px' }}>Tính lại</Btn>}
      </div>
      {loading && <div role="status" aria-busy="true" aria-label="Đang thống kê cách pha"><SkeletonLines lines={3} /></div>}
      {error && <div role="alert" style={{ fontSize: FS.xs, color: C.red }}>{error}</div>}
      {stats && !loading && !s && (
        <div style={{ fontSize: FS.xs, color: C.text3 }}>
          Chưa thấy thuốc "{drugName || '—'}" trong dữ liệu đã có
          {(stats.sources || []).length ? '' : ' (chưa có y lệnh trong Kho nghiên cứu hoặc dữ liệu phiên)'}.
        </div>
      )}
      {stats && !loading && s && (
        <div style={{ display: 'grid', gap: 4, fontSize: FS.xs, color: C.text2 }}>
          <div>
            {s.total} lần dùng · đường dùng: {Object.entries(s.routes || {}).map(([r, n]) => `${r} ${n}`).join(', ') || '—'}
            {s.inferred ? ` · ${s.inferred} lần hệ thống tự suy cách pha (không tính bên dưới)` : ''}
            {s.flagged ? ` · ${s.flagged} lần cần xác nhận` : ''}
          </div>
          {!s.observed?.length && <div style={{ color: C.text3 }}>Chưa có lần nào y lệnh ghi rõ dung môi/thể tích.</div>}
          {(s.observed || []).map((o, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ flex: '1 1 220px', color: C.text }}>{observedLabel(o)} — <b>{o.count}</b> lần ({Math.round((o.count / (s.observed_total || 1)) * 100)}%)</span>
              <Btn variant="default" onClick={() => useAsDefault(o)} style={{ fontSize: 11, padding: '1px 8px' }}>Đặt làm mặc định</Btn>
              <Btn variant="default" onClick={() => addVariant(o)} style={{ fontSize: 11, padding: '1px 8px' }}>Thêm thành cách pha</Btn>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
