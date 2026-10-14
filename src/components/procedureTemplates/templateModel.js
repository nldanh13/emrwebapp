// Mẫu thủ thuật – phẫu thuật: dữ liệu và kiểm tra dùng chung cho tab quản lý mẫu.
// Cùng quy tắc khớp với worker/procedure_templates.py (từ khoá không dấu, không phân biệt hoa thường).

export const KIND_OPTIONS = [
  { value: 'thu_thuat', label: 'Thủ thuật' },
  { value: 'phau_thuat', label: 'Phẫu thuật' },
];
export const PERFORMER_OPTIONS = [
  { value: 'dieu_duong', label: 'Điều dưỡng' },
  { value: 'bac_si', label: 'Bác sĩ' },
];
export const SCOPE_OPTIONS = [
  { value: 'all', label: 'BHYT và viện phí' },
  { value: 'bhyt', label: 'Chỉ BHYT' },
  { value: 'vien_phi', label: 'Chỉ viện phí' },
];

export function foldText(value) {
  return String(value ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

export function newTemplate(kind, id = `tpl-${Date.now().toString(36)}`) {
  const pt = kind === 'phau_thuat';
  return {
    id, kind, name: '', keywords: [''],
    performer: pt ? 'bac_si' : 'dieu_duong',
    minutes: pt ? 15 : 10,
    anesthesia: pt ? 'Gây Tê Tại Chỗ' : 'Không',
    position: pt ? 'Nằm ngửa' : '',
    emr_template: '', phuong_phap: '', mo_ta: '', report: '', dan_do: '',
    applies_to: 'all', auto: true, enabled: true, note: '',
  };
}

export function cleanKeywords(template) {
  return (template.keywords || []).map(k => String(k ?? '').trim()).filter(Boolean);
}

// Từ khoá trùng với mẫu khác cùng loại (đang dùng): worker sẽ chọn mẫu có từ khoá dài hơn / đứng trước.
export function keywordConflicts(templates, template) {
  const mine = new Map(cleanKeywords(template).map(k => [foldText(k), k]));
  const out = [];
  for (const other of templates) {
    if (other.id === template.id || other.kind !== template.kind || other.enabled === false) continue;
    for (const k of cleanKeywords(other)) {
      if (mine.has(foldText(k))) out.push({ keyword: mine.get(foldText(k)), other: other.name || '(chưa đặt tên)' });
    }
  }
  return out;
}

// Mẫu mặc định (không từ khoá) đang dùng của một loại; có hơn một thì chỉ cái đầu tiên được dùng.
export function defaultTemplates(templates, kind) {
  return templates.filter(t => t.kind === kind && t.enabled !== false && !cleanKeywords(t).length);
}

export function summary(template) {
  const keys = cleanKeywords(template);
  return keys.length ? keys.join(', ') : 'Mặc định: mọi DVKT chưa có mẫu riêng';
}

// DVKT Phòng khám đã bỏ qua vì chưa có mẫu, trừ những DVKT nay đã khớp một mẫu (có từ khoá) đang dùng.
export function uncoveredMissing(missing = [], templates = []) {
  return missing.filter(m => !templates.some(t => t.kind === m.kind && t.enabled !== false
    && cleanKeywords(t).some(k => foldText(m.name).includes(foldText(k)))));
}

export function templateFromMissing(missing, id) {
  return { ...newTemplate(missing.kind, id), name: missing.name, keywords: [missing.name] };
}


// Suggested CTCH – Neurology catalog never modifies active templates by itself.
// Catalog match is exact on the normalized complete EMR DVKT name, not substrings.
export function catalogAlreadyAdded(templates, suggestion) {
  return (templates || []).some(t => t.catalog_code === suggestion.code ||
    (t.kind === suggestion.kind && (
      foldText(t.name) === foldText(suggestion.name) ||
      cleanKeywords(t).some(k => foldText(k) === foldText(suggestion.name))
    )));
}

export function catalogDraft(suggestion) {
  const kind = suggestion.kind === 'phau_thuat' ? 'phau_thuat' : 'thu_thuat';
  return {
    ...newTemplate(kind, `ctch-${String(suggestion.code).replace(/[^a-zA-Z0-9]+/g, '-')}`),
    name: suggestion.name,
    keywords: [suggestion.name],
    performer: 'bac_si', // Chờ xác nhận BS/điều dưỡng phụ trách.
    anesthesia: '',
    position: '',
    minutes: kind === 'phau_thuat' ? 15 : 10,
    emr_template: '',
    phuong_phap: '',
    report: '',
    auto: false,
    enabled: false,
    catalog_code: String(suggestion.code),
    reviewed: false,
    note: `[Danh mục CTCH – Thần kinh · mã ${suggestion.code}] ${suggestion.note || 'Chờ đối chiếu DVKT tại EMR và phê duyệt kỹ thuật.'}`,
  };
}

export function catalogReviewIssues(template) {
  if (!template?.catalog_code) return [];
  const problems = [];
  if (!cleanKeywords(template).length ||
      cleanKeywords(template).some(k => foldText(k) !== foldText(template.name))) {
    problems.push('Từ khóa phải là tên DVKT đầy đủ, không dùng từ khóa bao trùm.');
  }
  if (!String(template.report || '').trim()) problems.push('Chưa có nội dung tường trình đã duyệt.');
  if (template.kind === 'thu_thuat' && !String(template.emr_template || '').trim()) {
    problems.push('Chưa chọn mẫu tường trình tương ứng trên EMR.');
  }
  if (template.kind === 'phau_thuat' && !String(template.phuong_phap || '').trim()) {
    problems.push('Chưa xác nhận phương pháp phẫu thuật.');
  }
  return problems;
}
