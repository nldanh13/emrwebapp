// Tính cỡ mẫu tối thiểu và so sánh với số lượt đạt điều kiện trong mẫu hiện tại.
import { C, FS } from '../../tokens.js';
import { compactNumber } from './researchFormat.js';
import { inp } from './researchUi.jsx';
import { SAMPLE_SIZE_DEFAULTS, SAMPLE_SIZE_DESIGNS, SAMPLE_SIZE_FIELDS, computeSampleSize } from './sampleSize.js';

const card = { border: `1px solid ${C.border2}`, borderRadius: 8, background: C.surface, padding: '12px 14px' };
const hint = { fontSize: FS.xs, color: C.text3, marginTop: 3, lineHeight: 1.45 };
const fmt = (n, digits = 2) => Number(n).toLocaleString('vi-VN', { maximumFractionDigits: digits });

// Số liệu hiện có để so với cỡ mẫu cần: tổng lượt, lượt có dữ liệu kết cục chính, các nhóm của biến độc lập.
export function availableForSampleSize(summary) {
  const total = Number(summary?.total || 0);
  return { total, usable: total };
}

export function SampleSizePanel({ sampleSize, setSampleSize, summary }) {
  const params = { ...SAMPLE_SIZE_DEFAULTS, ...sampleSize };
  const design = SAMPLE_SIZE_DESIGNS.find(d => d.key === params.design) || null;
  const result = design ? computeSampleSize(params) : null;
  const available = availableForSampleSize(summary);
  const set = (patch) => setSampleSize(prev => ({ ...SAMPLE_SIZE_DEFAULTS, ...prev, ...patch }));

  const enough = result?.n ? available.usable >= result.n : null;
  return (
    <section style={{ ...card, display: 'grid', gap: 10 }}>
      <div>
        <div style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>Cỡ mẫu</div>
        <div style={hint}>Chọn thiết kế, nhập thông số theo đề cương hoặc y văn; app tính cỡ mẫu tối thiểu và so với số lượt đạt điều kiện.</div>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ flex: '1 1 280px', fontSize: FS.xs, color: C.text2, fontWeight: 600 }}>
          Thiết kế / mục tiêu
          <select value={params.design || ''} onChange={e => set({ design: e.target.value })} aria-label="Thiết kế tính cỡ mẫu"
            style={{ ...inp, display: 'block', width: '100%', height: 32, marginTop: 3 }}>
            <option value="">— Chọn cách tính cỡ mẫu —</option>
            {[...new Set(SAMPLE_SIZE_DESIGNS.map(d => d.group))].map(group => (
              <optgroup key={group} label={group}>
                {SAMPLE_SIZE_DESIGNS.filter(d => d.group === group).map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        {design && (
          <>
            <label style={{ fontSize: FS.xs, color: C.text2, fontWeight: 600 }}>
              Mức ý nghĩa α
              <select value={params.alpha} onChange={e => set({ alpha: Number(e.target.value) })} aria-label="Mức ý nghĩa"
                style={{ ...inp, display: 'block', height: 32, marginTop: 3 }}>
                {[0.1, 0.05, 0.01].map(a => <option key={a} value={a}>{fmt(a)} (tin cậy {fmt((1 - a) * 100, 0)}%)</option>)}
              </select>
            </label>
            <label style={{ fontSize: FS.xs, color: C.text2, fontWeight: 600 }}>
              Dự trù hao hụt (%)
              <input type="number" min={0} max={50} value={params.dropout} onChange={e => set({ dropout: e.target.value })} aria-label="Dự trù hao hụt"
                style={{ ...inp, display: 'block', width: 90, height: 32, marginTop: 3 }} />
            </label>
          </>
        )}
      </div>
      {design && <div style={{ ...hint, marginTop: -4 }}>Ví dụ: {design.example}.</div>}
      {design && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 10 }}>
          {design.fields.map(field => {
            const meta = SAMPLE_SIZE_FIELDS[field];
            return (
              <label key={field} style={{ fontSize: FS.xs, color: C.text2, fontWeight: 600 }}>
                {meta.label}
                <input type="number" step={meta.step} min={meta.min} max={meta.max} value={params[field] ?? ''} aria-label={meta.label}
                  onChange={e => set({ [field]: e.target.value })} style={{ ...inp, display: 'block', width: '100%', height: 32, marginTop: 3 }} />
                <span style={{ display: 'block', ...hint, fontWeight: 400 }}>{meta.hint}</span>
              </label>
            );
          })}
        </div>
      )}
      {result?.error && <div style={{ fontSize: FS.sm, color: C.amber }}>{result.error}</div>}
      {result?.n && (
        <div style={{ display: 'grid', gap: 8, borderTop: `1px solid ${C.border2}`, paddingTop: 10 }}>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <div>
              <div style={{ fontSize: FS.xs, color: C.text3, fontWeight: 600 }}>Cỡ mẫu tối thiểu</div>
              <div style={{ fontSize: FS.stat, fontWeight: 700, color: C.text, fontVariantNumeric: 'tabular-nums' }}>{compactNumber(result.n)}</div>
              <div style={hint}>
                {result.groups ? `${compactNumber(result.groups[0])} nhóm 1 + ${compactNumber(result.groups[1])} nhóm 2 · ` : ''}
                {compactNumber(result.raw)} theo công thức, cộng {fmt(params.dropout, 0)}% hao hụt
              </div>
            </div>
            <div>
              <div style={{ fontSize: FS.xs, color: C.text3, fontWeight: 600 }}>Số lượt trong mẫu</div>
              <div style={{ fontSize: FS.stat, fontWeight: 700, color: enough ? C.green : C.red, fontVariantNumeric: 'tabular-nums' }}>{compactNumber(available.usable)}</div>
              <div style={hint}>lượt đạt điều kiện chọn mẫu</div>
            </div>
            <div style={{ flex: '1 1 220px', fontSize: FS.sm, fontWeight: 700, color: enough ? C.green : C.red }}>
              {enough
                ? `✓ Đủ cỡ mẫu (dư ${compactNumber(available.usable - result.n)})`
                : `✗ Thiếu ${compactNumber(result.n - available.usable)} lượt: mở rộng thời gian nghiên cứu, nới tiêu chuẩn, hoặc thu thập thêm từ EMR.`}
            </div>
          </div>
          <div style={{ ...hint, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{result.formula}</div>
        </div>
      )}
    </section>
  );
}
