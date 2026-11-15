// Mô hình cho trình sửa "Biến tự định nghĩa": danh sách kiểu, biến trống theo kiểu, cột nguồn chọn được,
// chép bộ biến từ nghiên cứu khác. Máy chủ (server/research/derived_variables.js) mới là nơi tính giá trị.

export const DERIVED_KINDS = [
  ['date_diff', 'Hiệu hai mốc thời gian', 'Vd. số ngày từ vào viện tới mổ, thời gian mổ (phút)'],
  ['formula', 'Công thức', 'Vd. BMI = can_nang / (chieu_cao/100)^2'],
  ['cut', 'Chia nhóm theo ngưỡng', 'Vd. nhóm tuổi <60 / ≥60, phân loại BMI'],
  ['keyword_group', 'Gom nhóm theo từ khóa/mã ICD', 'Vd. vùng phẫu thuật, loại phẫu thuật, nhóm chẩn đoán'],
  ['note_number', 'Số trong tờ điều trị', 'Vd. VAS ngày 1 sau mổ, lượng máu mất'],
];

export const kindLabel = (kind) => (DERIVED_KINDS.find(([k]) => k === kind) || [])[1] || kind;

// Cột chung của lượt có thể dùng làm nguồn (không gồm định danh).
export const BASE_SOURCE_COLUMNS = [
  ['age', 'Tuổi'],
  ['sex', 'Giới'],
  ['birth_year', 'Năm sinh'],
  ['admission_date', 'Ngày vào viện'],
  ['discharge_date', 'Ngày ra viện'],
  ['hospital_stay_days', 'Số ngày nằm viện'],
  ['diagnosis_raw', 'Chẩn đoán (nguyên văn EMR)'],
];

export function emptyDerived(kind, index = 1) {
  const base = { name: `bien_moi_${index}`, label: `Biến mới ${index}`, kind };
  if (kind === 'date_diff') return { ...base, params: { from: 'admission_date', to: '', unit: 'days' } };
  if (kind === 'formula') return { ...base, params: { expression: '', digits: 2 } };
  if (kind === 'cut') return { ...base, params: { source: '', breaks: '', labels: '' } };
  if (kind === 'keyword_group') return { ...base, params: { sources: [], rules: [{ code: '1', label: '', keywords: '' }], fallback: '' } };
  if (kind === 'note_number') return { ...base, params: { keyword: '', day_ref: 'surgery', day: 1, pick: 'max' } };
  return base;
}

// Định nghĩa đã lưu (ngưỡng/nhãn dạng mảng) → dạng sửa được trong ô nhập (chuỗi "a; b").
export function toDraft(d) {
  const p = { ...(d?.params || {}) };
  if (d?.kind === 'cut') {
    if (Array.isArray(p.breaks)) p.breaks = p.breaks.join('; ');
    if (Array.isArray(p.labels)) p.labels = p.labels.join('; ');
  }
  if (d?.kind === 'keyword_group') {
    p.sources = Array.isArray(p.sources) ? p.sources : [];
    p.rules = Array.isArray(p.rules) && p.rules.length ? p.rules : [{ code: '1', label: '', keywords: '' }];
  }
  return { name: d?.name || '', label: d?.label || '', kind: d?.kind || 'formula', params: p };
}

export function savedDerived(study) {
  const sel = study?.variable_selection || study?.analysis_config?.variable_selection || null;
  return Array.isArray(sel?.derived_variables) ? sel.derived_variables : [];
}

// Cột nguồn chọn được cho biến thứ `index`: cột chung + cột của biến đã chọn + biến tự định nghĩa đứng trước.
export function sourceColumnOptions(statsVariables = [], drafts = [], index = drafts.length) {
  const out = BASE_SOURCE_COLUMNS.map(([value, label]) => ({ value, label }));
  const seen = new Set(out.map(o => o.value));
  for (const v of statsVariables || []) {
    const col = v?.output_column;
    if (!col || seen.has(col) || String(v?.id || '').startsWith('derived:')) continue;
    seen.add(col);
    out.push({ value: col, label: v.survey_label || v.source_label || col });
  }
  for (const d of drafts.slice(0, index)) {
    if (!d?.name || seen.has(d.name)) continue;
    seen.add(d.name);
    out.push({ value: d.name, label: `${d.label || d.name} (tự định nghĩa)` });
  }
  return out;
}

// Chép bộ biến từ nghiên cứu khác: nối vào sau, bỏ biến trùng tên đã có.
export function mergeCopiedDerived(current = [], copied = []) {
  const names = new Set(current.map(d => d.name));
  const added = copied.filter(d => d?.name && !names.has(d.name)).map(toDraft);
  return { list: [...current, ...added], added: added.length, skipped: copied.length - added.length };
}

export const draftKey = (list) => JSON.stringify((list || []).map(toDraft));
