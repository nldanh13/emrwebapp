// Thêm / bớt biến của nghiên cứu riêng. Chỉ đổi danh sách biến trên dữ liệu đã có của nghiên cứu
// (không đổi mẫu, không mở EMR, không đụng kho chung). Lưu xong thì Đo lường và "Biến đã chọn"
// tính lại ngay.
import { useEffect, useMemo, useState } from 'react';
import * as api from '../../api.js';
import { C, FS } from '../../tokens.js';
import { Btn } from '../shared.jsx';
import { SkeletonLines } from '../Skeleton.jsx';
import { defaultAggregationFor, dedupeWideTableVariables, enhanceCatalogVariable } from './variableCatalogModel.js';

const lower = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');

export function currentStudyVariables(study) {
  const sel = study?.variable_selection || study?.analysis_config?.variable_selection || null;
  return Array.isArray(sel?.selected_variables) ? sel.selected_variables : [];
}

// Biến trong danh mục kho → biến của nghiên cứu (cùng dạng lúc Tạo nghiên cứu).
export function catalogVariableToSpec(v) {
  return {
    id: v.id,
    table: v.table,
    table_label: v.group_label || v.table_label || '',
    name: v.name,
    label: v.display_label || v.label || v.name,
    survey_label: v.display_label || v.label || v.name,
    type: v.type,
    role: '',
    virtual_kind: v.virtual_kind || '',
    source_filter: v.source_filter || null,
    aggregation: defaultAggregationFor(v),
  };
}

export function StudyVariableEditor({ study, toast, onSaved }) {
  const saved = useMemo(() => currentStudyVariables(study), [study]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(saved);
  const [catalog, setCatalog] = useState(null);
  const [catalogError, setCatalogError] = useState('');
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { setDraft(saved); }, [saved]);

  useEffect(() => {
    if (!open || catalog) return;
    let alive = true;
    api.getResearchArchiveVariableCatalog()
      .then(r => { if (alive) setCatalog(r?.catalog || { groups: [] }); })
      .catch(e => { if (alive) setCatalogError(String(e.message || e)); });
    return () => { alive = false; };
  }, [open, catalog]);

  const browse = useMemo(() => {
    const all = (catalog?.groups || []).flatMap(g => (g.variables || []).map(v => enhanceCatalogVariable(v, g)));
    return dedupeWideTableVariables(all).filter(v => !v.technical_or_identity);
  }, [catalog]);

  const chosen = new Set(draft.map(v => v.id));
  const q = lower(query.trim());
  const results = q
    ? browse.filter(v => !chosen.has(v.id) && lower(`${v.display_label} ${v.clinical_group_label} ${v.raw_name}`).includes(q)).slice(0, 40)
    : [];
  const dirty = draft.map(v => v.id).join('|') !== saved.map(v => v.id).join('|');

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.updateResearchStudyVariables(study.id, draft);
      toast?.(r?.message || 'Đã lưu danh sách biến.', 'ok');
      setQuery('');
      await onSaved?.();
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return <Btn onClick={() => setOpen(true)} style={{ height: 28 }}>Thêm / bớt biến</Btn>;
  }

  return (
    <div style={{ border: `1px solid ${C.blueBorder}`, background: C.surface, borderRadius: 8, padding: '10px 12px', display: 'grid', gap: 10, width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <b style={{ fontSize: FS.sm, color: C.text }}>Biến của nghiên cứu ({draft.length})</b>
        {dirty && <span style={{ fontSize: FS.xs, color: C.amber, fontWeight: 600 }}>Chưa lưu</span>}
        <span style={{ fontSize: FS.xs, color: C.text3 }}>Chỉ tính lại trên dữ liệu đã có — không đổi mẫu, không mở EMR, không ảnh hưởng kho chung.</span>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {draft.map(v => (
          <span key={v.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 4px 3px 10px', borderRadius: 999, background: C.surface3, border: `1px solid ${C.blueBorder}`, fontSize: FS.sm, color: C.text }}>
            {v.label || v.name}
            <button type="button" aria-label={`Bỏ biến ${v.label || v.name}`} title={draft.length <= 1 ? 'Nghiên cứu cần ít nhất 1 biến' : 'Bỏ biến'}
              disabled={draft.length <= 1} onClick={() => setDraft(d => d.filter(x => x.id !== v.id))}
              style={{ border: 0, background: 'transparent', color: C.text2, cursor: draft.length <= 1 ? 'default' : 'pointer', fontSize: FS.md, lineHeight: 1, padding: '0 4px' }}>×</button>
          </span>
        ))}
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Tìm biến để thêm: canxi, creatinin, paracetamol, chẩn đoán…" aria-label="Tìm biến để thêm"
          style={{ height: 30, borderRadius: 6, border: `1px solid ${C.border}`, padding: '0 10px', fontSize: FS.sm, fontFamily: 'inherit', color: C.text, background: C.surface }} />
        {catalogError && <div role="alert" style={{ fontSize: FS.xs, color: C.red }}>Không tải được danh mục biến: {catalogError}</div>}
        {open && !catalog && !catalogError && <div role="status" aria-busy="true" aria-label="Đang tải danh mục biến"><SkeletonLines lines={3} /></div>}
        {q && catalog && !results.length && <div style={{ fontSize: FS.xs, color: C.text3 }}>Không thấy biến phù hợp trong kho.</div>}
        {!!results.length && (
          <div style={{ maxHeight: 240, overflow: 'auto', border: `1px solid ${C.border2}`, borderRadius: 6 }}>
            {results.map(v => (
              <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderBottom: `1px solid ${C.border2}`, fontSize: FS.sm }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ color: C.text }}>{v.display_label}</span>
                  <span style={{ color: C.text3, fontSize: FS.xs }}> · {v.clinical_group_label}{Number.isFinite(Number(v.nonempty)) ? ` · có dữ liệu ${Number(v.nonempty).toLocaleString('vi-VN')} dòng trong kho` : ''}</span>
                </span>
                <Btn onClick={() => setDraft(d => [...d, catalogVariableToSpec(v)])} style={{ height: 24, fontSize: FS.xs }}>+ Thêm</Btn>
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Btn onClick={() => { setDraft(saved); setQuery(''); setOpen(false); }} disabled={saving}>{dirty ? 'Hủy thay đổi' : 'Đóng'}</Btn>
        <Btn variant="solidPrimary" onClick={save} disabled={!dirty || saving} loading={saving}>Lưu danh sách biến</Btn>
      </div>
    </div>
  );
}
