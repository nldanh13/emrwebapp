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
