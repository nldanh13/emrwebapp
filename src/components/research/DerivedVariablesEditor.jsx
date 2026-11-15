// Biến tự định nghĩa của nghiên cứu: tạo cột mới từ cột đã có (hiệu ngày, công thức, chia nhóm,
// gom nhóm theo từ khóa/ICD, số trong tờ điều trị). Không mở EMR, không đổi kho; chỉ tính lại file
// "Biến đã chọn" của nghiên cứu. Xem trước và lưu dùng chung hàm tính ở máy chủ.
import { useEffect, useMemo, useState } from 'react';
import * as api from '../../api.js';
import { C, FS } from '../../tokens.js';
import { Btn } from '../shared.jsx';
import { currentStudyVariables } from './StudyVariableEditor.jsx';
import {
  DERIVED_KINDS, draftKey, emptyDerived, kindLabel, mergeCopiedDerived, savedDerived, sourceColumnOptions, toDraft,
} from './derivedVariablesModel.js';

const input = { height: 28, borderRadius: 5, border: `1px solid ${C.border}`, padding: '0 8px', fontSize: FS.sm, fontFamily: 'inherit', color: C.text, background: C.surface, minWidth: 0 };
const fieldLabel = { display: 'grid', gap: 3, fontSize: FS.xs, color: C.text2 };

function ColumnSelect({ value, onChange, options, label }) {
  return (
    <label style={fieldLabel}>{label}
      <select value={value || ''} onChange={e => onChange(e.target.value)} style={input} aria-label={label}>
        <option value="">— chọn cột —</option>
        {options.map(o => <option key={o.value} value={o.value}>{o.label} · {o.value}</option>)}
      </select>
    </label>
  );
}

function KindFields({ d, setParams, options }) {
  const p = d.params || {};
  if (d.kind === 'date_diff') {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
        <ColumnSelect label="Từ mốc" value={p.from} onChange={v => setParams({ from: v })} options={options} />
        <ColumnSelect label="Đến mốc" value={p.to} onChange={v => setParams({ to: v })} options={options} />
        <label style={fieldLabel}>Đơn vị
          <select value={p.unit || 'days'} onChange={e => setParams({ unit: e.target.value })} style={input}>
            <option value="days">Ngày (theo ngày lịch)</option>
            <option value="hours">Giờ (cần giờ ở cả hai mốc)</option>
            <option value="minutes">Phút (cần giờ ở cả hai mốc)</option>
          </select>
        </label>
      </div>
    );
  }
  if (d.kind === 'formula') {
    return (
      <div style={{ display: 'grid', gap: 6 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 110px', gap: 8 }}>
          <label style={fieldLabel}>Công thức (dùng tên cột, + − * / ^ và ngoặc)
            <input value={p.expression || ''} onChange={e => setParams({ expression: e.target.value })} placeholder="can_nang / (chieu_cao/100)^2" style={{ ...input, fontFamily: 'monospace' }} />
          </label>
          <label style={fieldLabel}>Số lẻ
            <input type="number" min={0} max={6} value={p.digits ?? 2} onChange={e => setParams({ digits: e.target.value })} style={input} />
          </label>
        </div>
        <div style={{ fontSize: FS.xs, color: C.text3 }}>
          Cột dùng được: {options.map(o => o.value).join(', ')}
        </div>
      </div>
    );
  }
  if (d.kind === 'cut') {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
        <ColumnSelect label="Cột số cần chia" value={p.source} onChange={v => setParams({ source: v })} options={options} />
        <label style={fieldLabel}>Ngưỡng (cách nhau bằng ;)
          <input value={p.breaks || ''} onChange={e => setParams({ breaks: e.target.value })} placeholder="18.5; 23; 25" style={input} />
        </label>
        <label style={fieldLabel}>Tên nhóm (nhiều hơn ngưỡng 1 nhóm; bỏ trống = 1, 2, 3…)
          <input value={p.labels || ''} onChange={e => setParams({ labels: e.target.value })} placeholder="Gầy; Bình thường; Thừa cân; Béo phì" style={input} />
        </label>
        <div style={{ gridColumn: '1 / -1', fontSize: FS.xs, color: C.text3 }}>Giá trị bằng ngưỡng thuộc nhóm phía trên (vd. ngưỡng 60: 60 tuổi vào nhóm ≥60).</div>
      </div>
    );
  }
  if (d.kind === 'keyword_group') {
    const rules = p.rules || [];
    const setRule = (i, patch) => setParams({ rules: rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
    const sources = p.sources || [];
    return (
      <div style={{ display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'end' }}>
          <ColumnSelect label="Tìm trong cột" value="" onChange={v => v && !sources.includes(v) && setParams({ sources: [...sources, v] })} options={options.filter(o => !sources.includes(o.value))} />
          {sources.map(s => (
            <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 4px 2px 8px', borderRadius: 999, background: C.surface3, fontSize: FS.xs }}>
              {s}
              <button type="button" aria-label={`Bỏ cột ${s}`} onClick={() => setParams({ sources: sources.filter(x => x !== s) })} style={{ border: 0, background: 'transparent', cursor: 'pointer', color: C.text2 }}>×</button>
            </span>
          ))}
        </div>
        <div style={{ display: 'grid', gap: 4 }}>
          <div style={{ fontSize: FS.xs, color: C.text3 }}>Mỗi dòng một nhóm; từ khóa cách nhau bằng ; (không phân biệt dấu, hoa thường). Nhóm nào khớp trước thì lấy nhóm đó.</div>
          {rules.map((r, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '64px minmax(100px, 1fr) minmax(160px, 2fr) 28px', gap: 6 }}>
              <input value={r.code || ''} onChange={e => setRule(i, { code: e.target.value })} placeholder="Mã" aria-label={`Mã nhóm ${i + 1}`} style={input} />
              <input value={r.label || ''} onChange={e => setRule(i, { label: e.target.value })} placeholder="Tên nhóm" aria-label={`Tên nhóm ${i + 1}`} style={input} />
              <input value={r.keywords || ''} onChange={e => setRule(i, { keywords: e.target.value })} placeholder="xương đùi; S72; khớp háng" aria-label={`Từ khóa nhóm ${i + 1}`} style={input} />
              <button type="button" aria-label={`Bỏ nhóm ${i + 1}`} onClick={() => setParams({ rules: rules.filter((_, j) => j !== i) })} style={{ border: `1px solid ${C.border}`, borderRadius: 5, background: C.surface, cursor: 'pointer', color: C.text2 }}>×</button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Btn onClick={() => setParams({ rules: [...rules, { code: String(rules.length + 1), label: '', keywords: '' }] })} style={{ height: 26, fontSize: FS.xs }}>+ Nhóm</Btn>
            <label style={{ ...fieldLabel, gridAutoFlow: 'column', alignItems: 'center' }}>Không khớp nhóm nào thì ghi
              <input value={p.fallback || ''} onChange={e => setParams({ fallback: e.target.value })} placeholder="(để trống)" style={{ ...input, width: 120 }} />
            </label>
          </div>
        </div>
      </div>
    );
  }
  if (d.kind === 'note_number') {
    return (
      <div style={{ display: 'grid', gap: 6 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
          <label style={fieldLabel}>Từ khóa đứng trước con số
            <input value={p.keyword || ''} onChange={e => setParams({ keyword: e.target.value })} placeholder="VAS" style={input} />
          </label>
          <label style={fieldLabel}>Ngày thứ (0 = cùng ngày)
            <input type="number" min={-30} max={365} value={p.day ?? 1} onChange={e => setParams({ day: e.target.value })} style={input} />
          </label>
          <label style={fieldLabel}>So với
            <select value={p.day_ref || 'surgery'} onChange={e => setParams({ day_ref: e.target.value })} style={input}>
              <option value="surgery">Ngày mổ</option>
              <option value="admission">Ngày vào viện</option>
            </select>
          </label>
          <label style={fieldLabel}>Có nhiều số trong ngày thì lấy
            <select value={p.pick || 'max'} onChange={e => setParams({ pick: e.target.value })} style={input}>
              <option value="max">Lớn nhất</option>
              <option value="min">Nhỏ nhất</option>
              <option value="first">Lần đầu</option>
              <option value="last">Lần cuối</option>
            </select>
          </label>
        </div>
        <div style={{ fontSize: FS.xs, color: C.text3 }}>Tìm trong Diễn biến và Y lệnh của tờ điều trị: số đầu tiên sau từ khóa (vd. “VAS: 3/10” → 3). Không thấy thì để trống.</div>
      </div>
    );
  }
  return null;
}

function PreviewLine({ v, total }) {
  if (!v) return null;
  const s = v.stats || {};
  let detail = '';
  if (s.kind === 'number' && s.n_numeric) detail = `trung vị ${s.median}, nhỏ nhất ${s.min}, lớn nhất ${s.max}`;
  else if (s.kind === 'category' && s.top?.length) detail = s.top.map(t => `${t.value}: ${t.count}`).join(' · ');
  return (
    <div style={{ fontSize: FS.xs, color: v.filled ? C.green : C.amber }}>
      Xem trước: có giá trị {v.filled}/{total} lượt{detail ? ` — ${detail}` : ''}{!v.filled ? '. Kiểm lại cột nguồn hoặc từ khóa.' : ''}
    </div>
  );
}

export function DerivedVariablesEditor({ study, statsVariables, toast, onSaved }) {
  const saved = useMemo(() => savedDerived(study).map(toDraft), [study]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState(null);
  const [newKind, setNewKind] = useState('date_diff');
  const [studies, setStudies] = useState(null);
  const [copyFrom, setCopyFrom] = useState('');

  useEffect(() => { setDraft(saved); setPreview(null); }, [saved]);
  useEffect(() => {
    if (!open || studies) return;
    let alive = true;
    api.listResearchStudies()
      .then(r => { if (alive) setStudies((r?.studies || []).filter(s => s.id !== study?.id && savedDerived(s).length)); })
      .catch(() => { if (alive) setStudies([]); });
    return () => { alive = false; };
  }, [open, studies, study?.id]);

  const dirty = draftKey(draft) !== draftKey(saved);
  const update = (i, patch) => { setPreview(null); setDraft(list => list.map((d, j) => (j === i ? { ...d, ...patch } : d))); };
  const setParams = (i, patch) => { setPreview(null); setDraft(list => list.map((d, j) => (j === i ? { ...d, params: { ...d.params, ...patch } } : d))); };
  const move = (i, dir) => setDraft(list => {
    const j = i + dir;
    if (j < 0 || j >= list.length) return list;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  const runPreview = async () => {
    setPreviewing(true);
    try { setPreview(await api.previewResearchStudyDerived(study.id, draft)); }
    catch (e) { toast?.(String(e.message || e), 'error'); }
    finally { setPreviewing(false); }
  };

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.updateResearchStudyVariables(study.id, currentStudyVariables(study), draft);
      toast?.(r?.message || 'Đã lưu biến tự định nghĩa.', 'ok');
      setPreview(null);
      await onSaved?.();
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setSaving(false);
    }
  };

  const copy = () => {
    const src = (studies || []).find(s => s.id === copyFrom);
    if (!src) return;
    const r = mergeCopiedDerived(draft, savedDerived(src));
    setDraft(r.list);
    setPreview(null);
    toast?.(`Đã chép ${r.added} biến từ “${src.name || src.id}”${r.skipped ? `, bỏ ${r.skipped} biến trùng tên` : ''}. Bấm Lưu để áp dụng.`, 'ok');
  };

  if (!open) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <Btn onClick={() => setOpen(true)} style={{ height: 28 }}>Biến tự định nghĩa{saved.length ? ` (${saved.length})` : ''}</Btn>
      </span>
    );
  }

  const previewByName = new Map((preview?.variables || []).map(v => [v.output_column, v]));
  return (
    <div style={{ border: `1px solid ${C.purpleBorder}`, background: C.surface, borderRadius: 8, padding: '10px 12px', display: 'grid', gap: 10, width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <b style={{ fontSize: FS.sm, color: C.text }}>Biến tự định nghĩa ({draft.length})</b>
        {dirty && <span style={{ fontSize: FS.xs, color: C.amber, fontWeight: 600 }}>Chưa lưu</span>}
        <span style={{ fontSize: FS.xs, color: C.text3 }}>Tạo cột mới từ cột đã có. Thiếu dữ liệu nguồn thì để trống, không đoán. Biến sau dùng được biến trước.</span>
      </div>

      {draft.map((d, i) => {
        const options = sourceColumnOptions(statsVariables, draft, i);
        return (
          <div key={i} style={{ border: `1px solid ${C.border2}`, borderRadius: 6, padding: '8px 10px', display: 'grid', gap: 8, background: C.surface2 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 2fr) minmax(120px, 1fr) auto', gap: 8, alignItems: 'end' }}>
              <label style={fieldLabel}>Nhãn biến
                <input value={d.label} onChange={e => update(i, { label: e.target.value })} style={input} />
              </label>
              <label style={fieldLabel}>Tên cột (không dấu, không khoảng trắng)
                <input value={d.name} onChange={e => update(i, { name: e.target.value.replace(/[^A-Za-z0-9_]/g, '_') })} style={{ ...input, fontFamily: 'monospace' }} />
              </label>
              <span style={{ display: 'inline-flex', gap: 4 }}>
                <Btn onClick={() => move(i, -1)} disabled={i === 0} aria-label="Lên trên" style={{ height: 28, padding: '0 8px' }}>↑</Btn>
                <Btn onClick={() => move(i, 1)} disabled={i === draft.length - 1} aria-label="Xuống dưới" style={{ height: 28, padding: '0 8px' }}>↓</Btn>
                <Btn variant="danger" onClick={() => { setPreview(null); setDraft(list => list.filter((_, j) => j !== i)); }} aria-label={`Xóa biến ${d.label}`} style={{ height: 28 }}>Xóa</Btn>
              </span>
            </div>
            <div style={{ fontSize: FS.xs, color: C.purple, fontWeight: 600 }}>{kindLabel(d.kind)}</div>
            <KindFields d={d} setParams={patch => setParams(i, patch)} options={options} />
            <PreviewLine v={previewByName.get(d.name)} total={preview?.total || 0} />
          </div>
        );
      })}

      {preview && !preview.ok && (
        <div role="alert" style={{ fontSize: FS.xs, color: C.red, display: 'grid', gap: 2 }}>
          {preview.errors.map((e, i) => <span key={i}>{e}</span>)}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', borderTop: `1px solid ${C.border2}`, paddingTop: 8 }}>
        <select value={newKind} onChange={e => setNewKind(e.target.value)} aria-label="Kiểu biến mới" style={input}>
          {DERIVED_KINDS.map(([k, label, hint]) => <option key={k} value={k}>{label} — {hint}</option>)}
        </select>
        <Btn onClick={() => { setPreview(null); setDraft(list => [...list, emptyDerived(newKind, list.length + 1)]); }} style={{ height: 28 }}>+ Thêm biến</Btn>
        {!!studies?.length && (
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', marginLeft: 'auto' }}>
            <select value={copyFrom} onChange={e => setCopyFrom(e.target.value)} aria-label="Chép biến tự định nghĩa từ nghiên cứu khác" style={input}>
              <option value="">Chép từ nghiên cứu khác…</option>
              {studies.map(s => <option key={s.id} value={s.id}>{s.name || s.id} ({savedDerived(s).length} biến)</option>)}
            </select>
            <Btn onClick={copy} disabled={!copyFrom} style={{ height: 28 }}>Chép</Btn>
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <Btn onClick={() => { setDraft(saved); setPreview(null); setOpen(false); }} disabled={saving}>{dirty ? 'Hủy thay đổi' : 'Đóng'}</Btn>
        <Btn onClick={runPreview} disabled={!draft.length || previewing || saving} loading={previewing}>Xem trước</Btn>
        <Btn variant="solidPrimary" onClick={save} disabled={!dirty || saving} loading={saving}>Lưu biến tự định nghĩa</Btn>
      </div>
    </div>
  );
}
