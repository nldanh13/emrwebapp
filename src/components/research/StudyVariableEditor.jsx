// Thêm / bớt biến của nghiên cứu riêng. Chỉ đổi danh sách biến trên dữ liệu đã có của nghiên cứu
// (không đổi mẫu, không mở EMR, không đụng kho chung). Lưu xong thì Đo lường và "Biến đã chọn"
// tính lại ngay.
import { useEffect, useMemo, useState } from 'react';
import * as api from '../../api.js';
import { C, FS } from '../../tokens.js';
import { Btn } from '../shared.jsx';
import { SkeletonLines } from '../Skeleton.jsx';
import { ANCHOR_AGGREGATIONS, VARIABLE_AGGREGATIONS, dedupeWideTableVariables, enhanceCatalogVariable, isPresenceVariable } from './variableCatalogModel.js';

const lower = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');

export function currentStudyVariables(study) {
  const sel = study?.variable_selection || study?.analysis_config?.variable_selection || null;
  return Array.isArray(sel?.selected_variables) ? sel.selected_variables : [];
}

// Bảng một dòng mỗi lượt: chỉ có một giá trị, không cần chọn cách lấy.
const SINGLE_ROW_TABLES = new Set(['analysis_ready', 'encounters', 'patients', 'cohort', 'initial_list']);
export const needsAggregationChoice = (v) => !SINGLE_ROW_TABLES.has(String(v?.table || '')) && !isPresenceVariable(v);

// Mặc định để phân tích được ngay (một số mỗi lượt): có mốc → gần trước mốc nhất; không → đầu tiên.
export function defaultAggregationForStudy(v, hasAnchor) {
  if (isPresenceVariable(v)) return 'any';
  if (!needsAggregationChoice(v)) return 'list';
  return hasAnchor ? 'closest_before_anchor' : 'first';
}

export function aggregationOptions(hasAnchor) {
  return VARIABLE_AGGREGATIONS.filter(([key]) => key !== 'any' && (hasAnchor || !ANCHOR_AGGREGATIONS.has(key)));
}

const variableKey = (v) => `${v.id}:${v.aggregation || ''}`;

// Biến trong danh mục kho → biến của nghiên cứu (cùng dạng lúc Tạo nghiên cứu).
export function catalogVariableToSpec(v, hasAnchor = false) {
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
    aggregation: defaultAggregationForStudy(v, hasAnchor),
  };
}

export function StudyVariableEditor({ study, toast, onSaved }) {
  const saved = useMemo(() => currentStudyVariables(study), [study]);
  const selection = study?.variable_selection || study?.analysis_config?.variable_selection || null;
  const hasAnchor = Boolean(selection?.anchor);
  const options = aggregationOptions(hasAnchor);
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
  const dirty = draft.map(variableKey).join('|') !== saved.map(variableKey).join('|');
  const setAggregation = (id, aggregation) => setDraft(d => d.map(v => (v.id === id ? { ...v, aggregation } : v)));
  // Biến bảng dài đang "liệt kê" nhiều giá trị → không phân tích số được; nhắc chọn một giá trị.
  const listing = draft.filter(v => needsAggregationChoice(v) && String(v.aggregation || 'list') === 'list');

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
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Btn onClick={() => setOpen(true)} style={{ height: 28 }}>Thêm / bớt biến</Btn>
        {!!listing.length && (
          <span style={{ fontSize: FS.xs, color: C.amber }}>
            {listing.length} biến đang liệt kê nhiều giá trị/lượt — bấm Thêm / bớt biến để chọn cách lấy một giá trị.
          </span>
        )}
      </span>
    );
  }

  return (
    <div style={{ border: `1px solid ${C.blueBorder}`, background: C.surface, borderRadius: 8, padding: '10px 12px', display: 'grid', gap: 10, width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <b style={{ fontSize: FS.sm, color: C.text }}>Biến của nghiên cứu ({draft.length})</b>
        {dirty && <span style={{ fontSize: FS.xs, color: C.amber, fontWeight: 600 }}>Chưa lưu</span>}
        <span style={{ fontSize: FS.xs, color: C.text3 }}>Chỉ tính lại trên dữ liệu đã có — không đổi mẫu, không mở EMR, không ảnh hưởng kho chung.</span>
      </div>
      {!!listing.length && (
        <div style={{ fontSize: FS.xs, color: C.amber }}>
          Biến xét nghiệm/thuốc có thể có nhiều kết quả trong một lượt. Chọn cách lấy <b>một giá trị</b>
          {hasAnchor ? ' (vd. "Gần trước mốc nhất")' : ' (vd. "Giá trị đầu tiên")'} để file xuất là số, phân tích được ngay.
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {draft.map(v => (
          <span key={v.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 4px 3px 10px', borderRadius: 999, background: C.surface3, border: `1px solid ${C.blueBorder}`, fontSize: FS.sm, color: C.text }}>
            {v.label || v.name}
            {needsAggregationChoice(v) && (
              <select value={v.aggregation || 'list'} onChange={e => setAggregation(v.id, e.target.value)} aria-label={`Cách lấy giá trị: ${v.label || v.name}`}
                title="Cách lấy giá trị khi một lượt có nhiều kết quả"
                style={{ height: 22, borderRadius: 4, border: `1px solid ${String(v.aggregation || 'list') === 'list' ? C.amberBorder : C.border}`, background: C.surface, color: C.text2, fontSize: FS.xs, fontFamily: 'inherit' }}>
                {options.map(([key, text]) => <option key={key} value={key}>{text}</option>)}
              </select>
            )}
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
                <Btn onClick={() => setDraft(d => [...d, catalogVariableToSpec(v, hasAnchor)])} style={{ height: 24, fontSize: FS.xs }}>+ Thêm</Btn>
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
