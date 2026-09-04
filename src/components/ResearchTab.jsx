import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { C, FONT_MONO } from '../tokens.js';
import { Btn, Spinner } from './shared.jsx';
import * as api from '../api.js';

const ARCHIVE_SCOPE = '__archive__';
const ARCHIVE_API_SCOPE = 'du_lieu_goc';
const ARCHIVE_DEFAULT_TABLE = 'initial_list';
const STUDY_DEFAULT_TABLE = 'cohort';
const ARCHIVE_TABLES = [
  ['initial_list',   'Dữ liệu ban đầu'],
  ['research_source','Nguồn chuẩn'],
  ['deep_source',    'Dữ liệu gốc sâu'],
  ['patient_master', 'BN chuẩn'],
  ['encounters',     'Đợt điều trị'],
  ['analysis_ready', 'Bảng phân tích'],
  ['analysis_selected', 'Biến đã chọn'],
  ['analysis_final', 'Dataset cuối'],
  ['analysis_ready_encoded', 'Phân tích encoded'],
  ['analysis_selected_encoded', 'Biến đã chọn encoded'],
  ['lab_results_encoded', 'XN encoded'],
  ['lab_dictionary', 'Dict XN'],
  ['imaging_results_encoded', 'CĐHA encoded'],
  ['imaging_dictionary', 'Dict CĐHA'],
  ['medication_orders_encoded', 'Y lệnh encoded'],
  ['drug_dictionary', 'Dict thuốc'],
  ['route_dictionary', 'Dict đường dùng'],
  ['diagnoses_encoded', 'Chẩn đoán encoded'],
  ['diagnosis_dictionary', 'Dict chẩn đoán'],
  ['surgery_results_encoded', 'PT/TT encoded'],
  ['procedure_dictionary', 'Dict PT/TT'],
  ['anesthesia_dictionary', 'Dict vô cảm'],
  ['diagnoses',      'Chẩn đoán'],
  ['patient_day',    'Patient-day'],
  ['lab_results',    'XN chuẩn'],
  ['imaging_results','CĐHA chuẩn'],
  ['surgery_results','PT/TT'],
  ['medication_orders','Y lệnh thuốc'],
  ['clinical_notes', 'Diễn biến'],
  ['patient_extra',  'Thông tin khác'],
  ['extract_status', 'Tiến độ'],
  ['errors',         'Lỗi'],
];
const STUDY_TABLES = [
  ['cohort',         'Danh sách mẫu'],
  ['research_source','Nguồn chuẩn'],
  ['patient_master', 'BN chuẩn'],
  ['encounters',     'Đợt điều trị'],
  ['analysis_ready', 'Bảng phân tích'],
  ['analysis_selected', 'Biến đã chọn'],
  ['analysis_final', 'Dataset cuối'],
  ['analysis_ready_encoded', 'Phân tích encoded'],
  ['analysis_selected_encoded', 'Biến đã chọn encoded'],
  ['lab_results_encoded', 'XN encoded'],
  ['lab_dictionary', 'Dict XN'],
  ['imaging_results_encoded', 'CĐHA encoded'],
  ['imaging_dictionary', 'Dict CĐHA'],
  ['medication_orders_encoded', 'Y lệnh encoded'],
  ['drug_dictionary', 'Dict thuốc'],
  ['route_dictionary', 'Dict đường dùng'],
  ['diagnoses_encoded', 'Chẩn đoán encoded'],
  ['diagnosis_dictionary', 'Dict chẩn đoán'],
  ['surgery_results_encoded', 'PT/TT encoded'],
  ['procedure_dictionary', 'Dict PT/TT'],
  ['anesthesia_dictionary', 'Dict vô cảm'],
  ['diagnoses',      'Chẩn đoán'],
  ['patient_day',    'Patient-day'],
  ['lab_results',    'XN chuẩn'],
  ['imaging_results','CĐHA chuẩn'],
  ['surgery_results','PT/TT'],
  ['medication_orders','Y lệnh thuốc'],
  ['clinical_notes', 'Diễn biến'],
  ['patient_extra',  'Thông tin khác'],
  ['extract_status', 'Tiến độ'],
  ['errors',         'Lỗi'],
  ['patients',       'Raw mẫu'],
  ['xn',             'Raw XN'],
  ['cdha',           'Raw CĐHA'],
];
const TABLES = [...ARCHIVE_TABLES, ...STUDY_TABLES.filter(([id]) => !ARCHIVE_TABLES.some(([a]) => a === id))];
const SENSITIVE_COLUMNS = new Set([
  'Họ tên','Mã BN','Số bệnh án','Mã vào viện','Mã điều trị','Điện thoại','Số CMND','Số CMT','CCCD',
  'patient_name','patient_code','birth_date','address','phone_number','citizen_id','insurance_card','insurance_subject','insurance_type','insurance_valid_from','insurance_valid_to','emr_admission_id','emr_treatment_id',
  'Địa chỉ','Ngày sinh','Số thẻ','Số thẻ BHYT','BHYT','Raw JSON',
]);

const VARIABLE_FRIENDLY_LABELS = {
  research_code: 'Mã nghiên cứu',
  patient_key: 'Khóa người bệnh',
  patient_code: 'Mã người bệnh',
  patient_codes: 'Các mã người bệnh',
  patient_name: 'Họ tên người bệnh',
  sex: 'Giới tính',
  birth_year: 'Năm sinh',
  age: 'Tuổi',
  age_group: 'Nhóm tuổi',
  encounter_key: 'Khóa đợt điều trị',
  admission_date: 'Ngày vào viện',
  admission_datetime: 'Thời gian vào viện',
  discharge_date: 'Ngày ra viện',
  discharge_datetime: 'Thời gian ra viện',
  surgery_date: 'Ngày phẫu thuật',
  surgery_datetime: 'Thời gian phẫu thuật',
  hospital_stay_days: 'Số ngày điều trị',
  department: 'Khoa điều trị',
  ward: 'Buồng/khoa/phòng',
  bed: 'Giường',
  primary_diagnosis: 'Chẩn đoán chính',
  discharge_diagnosis: 'Chẩn đoán ra viện',
  diagnosis_text: 'Nội dung chẩn đoán',
  diagnosis_type: 'Loại chẩn đoán',
  icd10_code: 'Mã ICD-10',
  hb: 'Hemoglobin (Hb)',
  hct: 'Hematocrit (Hct)',
  neutrophil: 'Bạch cầu trung tính',
  lymphocyte: 'Lymphocyte',
  monocyte: 'Monocyte',
  rdw: 'RDW',
  plt: 'Tiểu cầu (PLT)',
  wbc: 'Bạch cầu (WBC)',
  rbc: 'Hồng cầu (RBC)',
  creatinine: 'Creatinine',
  egfr: 'Mức lọc cầu thận eGFR',
  urea: 'Ure',
  ast: 'AST (GOT)',
  alt: 'ALT (GPT)',
  glucose: 'Glucose máu',
  crp: 'CRP',
  lab_datetime: 'Thời gian xét nghiệm',
  test_name_raw: 'Tên xét nghiệm',
  test_name_norm: 'Tên xét nghiệm chuẩn hóa',
  test_group: 'Nhóm xét nghiệm',
  result_raw: 'Kết quả xét nghiệm gốc',
  result_num: 'Kết quả xét nghiệm dạng số',
  result_text: 'Kết quả xét nghiệm dạng chữ',
  unit: 'Đơn vị xét nghiệm',
  reference_range: 'Khoảng tham chiếu',
  flag_raw: 'Cờ bất thường gốc',
  flag_norm: 'Cờ bất thường chuẩn hóa',
  ordered_at: 'Thời gian chỉ định',
  performed_at: 'Thời gian thực hiện',
  service_name_raw: 'Tên dịch vụ CĐHA',
  service_name_norm: 'Tên dịch vụ CĐHA chuẩn hóa',
  modality: 'Loại CĐHA',
  body_part: 'Vùng khảo sát',
  conclusion_text: 'Kết luận CĐHA',
  drug_name_raw: 'Tên thuốc/y lệnh',
  drug_name_norm: 'Tên thuốc chuẩn hóa',
  drug_group_guess: 'Nhóm thuốc dự đoán',
  dose_raw: 'Liều dùng',
  route_raw: 'Đường dùng',
  route_norm: 'Đường dùng chuẩn hóa',
  frequency_raw: 'Tần suất dùng',
  order_datetime: 'Thời gian y lệnh',
  postop_day_index: 'Ngày hậu phẫu',
  postop_day_label: 'Nhãn ngày hậu phẫu',
  is_postop_day_1_3: 'Có trong hậu phẫu ngày 1–3',
  surgery_name: 'Tên phẫu thuật/thủ thuật',
  surgery_method: 'Phương pháp phẫu thuật',
  anesthesia_method: 'Phương pháp vô cảm',
  analysis_preset: 'Preset phân tích',
  ready_for_analysis: 'Đủ điều kiện phân tích',
  needs_manual_review: 'Cần kiểm tra tay',
  encounter_match_ambiguous: 'Ghép đợt điều trị chưa chắc chắn',
  overall_status: 'Trạng thái tổng hợp',
  source_table: 'Bảng nguồn',
  source_row_id: 'ID dòng nguồn',
  row_hash: 'Mã kiểm tra dòng',
};
const VARIABLE_TECHNICAL_RE = /(^row_|_hash$|hash|source_|raw_row|debug|internal|session|cookie|token|password|secret|(^|_)id$|encounter_id|lab_result_id|imaging_id|med_order_id|diagnosis_id|surgery_id)/i;
const VARIABLE_IDENTITY_RE = /(patient_name|patient_code|patient_codes|phone|citizen|cccd|cmnd|address|dia_chi|bhyt|insurance|research_code|emr_admission_id|emr_treatment_id|so_benh_an|medical_record)/i;
const VARIABLE_RECOMMENDED_TABLES = new Set(['analysis_ready', 'encounters', 'lab_results', 'imaging_results', 'medication_orders', 'diagnoses', 'surgery_results']);
function humanizeVariableName(name) {
  const raw = text(name);
  const key = raw.toLowerCase();
  if (VARIABLE_FRIENDLY_LABELS[key]) return VARIABLE_FRIENDLY_LABELS[key];
  return raw
    .replace(/_/g, ' ')
    .replace(/\b\w/g, ch => ch.toUpperCase())
    .replace(/\bId\b/g, 'ID')
    .replace(/\bBn\b/g, 'BN')
    .replace(/\bCdha\b/g, 'CĐHA')
    .replace(/\bXn\b/g, 'XN');
}
function variableTypeLabel(type) {
  if (type === 'number') return 'Số';
  if (type === 'date') return 'Ngày/giờ';
  if (type === 'category') return 'Phân loại';
  return 'Văn bản';
}
function variableTypeTone(type) {
  if (type === 'number') return { color: C.blue, bg: C.blueBg, border: C.blueBorder };
  if (type === 'date') return { color: C.purple || '#7c3aed', bg: '#f3e8ff', border: '#ddd6fe' };
  if (type === 'category') return { color: C.green, bg: C.greenBg, border: C.greenBorder };
  return { color: C.text2, bg: C.surface2, border: C.border2 };
}
function variableCompletenessLabel(rate) {
  const n = Number(rate || 0);
  if (n >= 95) return 'Rất đủ';
  if (n >= 70) return 'Khá đủ';
  if (n >= 30) return 'Thiếu nhiều';
  if (n > 0) return 'Rất thiếu';
  return 'Không có dữ liệu';
}
function variableCompletenessTone(rate) {
  const n = Number(rate || 0);
  if (n >= 95) return 'ok';
  if (n >= 70) return 'info';
  if (n >= 30) return 'warn';
  return 'danger';
}
function variableRole(variable) {
  const name = lower(variable?.name || '');
  const id = lower(variable?.id || '');
  const table = lower(variable?.table || '');
  if (VARIABLE_TECHNICAL_RE.test(name) || VARIABLE_TECHNICAL_RE.test(id)) return 'technical';
  if (VARIABLE_IDENTITY_RE.test(name) || VARIABLE_IDENTITY_RE.test(id)) return 'identity';
  if (/date|datetime|time|day|ngày|thời gian/.test(name)) return 'time';
  if (/lab|test|result|xn|xet_nghiem|hemoglobin|creatin|crp|wbc|rbc|hb\b|hct|plt|rdw|neutrophil|lymphocyte|monocyte|ast|alt|glucose|urea|egfr/.test(name) || table === 'lab_results') return 'lab';
  if (/drug|medication|dose|route|frequency|thuốc|y_lệnh/.test(name) || table === 'medication_orders') return 'medication';
  if (/diagnosis|icd|chẩn đoán/.test(name) || table === 'diagnoses') return 'diagnosis';
  if (/surgery|procedure|anesthesia|phẫu thuật|thủ thuật/.test(name) || table === 'surgery_results') return 'procedure';
  if (/imaging|modality|cdha|xray|ct|mri|siêu âm/.test(name) || table === 'imaging_results') return 'imaging';
  if (/age|sex|birth|department|hospital|stay|ward|bed/.test(name)) return 'baseline';
  return 'other';
}

const VARIABLE_CLINICAL_GROUPS = [
  { key: 'admin', label: 'Hành chánh', hint: 'Giới tính, tuổi, năm sinh, thông tin nền người bệnh.', order: 10 },
  { key: 'encounter', label: 'Đợt điều trị', hint: 'Ngày giờ nhập viện/ra viện, khoa phòng, số ngày điều trị.', order: 20 },
  { key: 'diagnosis', label: 'Chẩn đoán', hint: 'Chẩn đoán vào viện, ra viện, ICD, bệnh kèm.', order: 30 },
  { key: 'lab', label: 'Xét nghiệm', hint: 'Cận lâm sàng xét nghiệm: huyết học, sinh hóa, miễn dịch, nước tiểu...', order: 40 },
  { key: 'imaging', label: 'CĐHA', hint: 'X-quang, CT, MRI, siêu âm, điện tim và kết luận hình ảnh.', order: 50 },
  { key: 'medication', label: 'Thuốc/y lệnh', hint: 'Tên thuốc, nhóm thuốc, liều, đường dùng, thời điểm y lệnh.', order: 60 },
  { key: 'surgery', label: 'Phẫu thuật/thủ thuật', hint: 'Ngày mổ, tên/phương pháp phẫu thuật, vô cảm.', order: 70 },
  { key: 'quality', label: 'Kiểm tra dữ liệu', hint: 'Cờ đủ dữ liệu, cần kiểm tra tay, trạng thái trích xuất.', order: 80 },
  { key: 'technical', label: 'Kỹ thuật/định danh', hint: 'Mã nguồn, khóa, định danh và biến debug; mặc định ẩn.', order: 90 },
  { key: 'other', label: 'Khác', hint: 'Các biến chưa phân loại.', order: 99 },
];
const CLINICAL_GROUP_BY_KEY = new Map(VARIABLE_CLINICAL_GROUPS.map(g => [g.key, g]));
function labSubgroupFromName(name) {
  const n = lower(name);
  if (/hb\b|hemoglobin|hct|wbc|rbc|plt|platelet|rdw|neutrophil|lymphocyte|monocyte|eosinophil|basophil|mcv|mch|mchc/.test(n)) return 'Xét nghiệm · Huyết học';
  if (/creatin|egfr|ure|urea|ast|alt|got|gpt|bilirubin|albumin|protein|glucose|na\b|k\b|cl\b|calci|canxi|mg\b|phosph|cholesterol|triglycerid|ldl|hdl/.test(n)) return 'Xét nghiệm · Sinh hóa';
  if (/pt\b|aptt|inr|fibrinogen|d.?dimer|dong mau|đông máu/.test(n)) return 'Xét nghiệm · Đông máu';
  if (/crp|pct|procalcitonin|esr|vs\b|ferritin|miễn dịch|mien dich/.test(n)) return 'Xét nghiệm · Viêm/miễn dịch';
  if (/urine|nước tiểu|nuoc tieu|protein niệu|hồng cầu niệu|bach cau nieu/.test(n)) return 'Xét nghiệm · Nước tiểu';
  if (/culture|cấy|vi sinh|kháng sinh đồ|khang sinh do/.test(n)) return 'Xét nghiệm · Vi sinh';
  return 'Xét nghiệm · Khác';
}
function imagingSubgroupFromName(name) {
  const n = lower(name);
  if (/ct|cat lop|cắt lớp/.test(n)) return 'CĐHA · CT';
  if (/mri|cộng hưởng từ|cong huong tu/.test(n)) return 'CĐHA · MRI';
  if (/x.?quang|xray|x ray/.test(n)) return 'CĐHA · X-quang';
  if (/siêu âm|sieu am/.test(n)) return 'CĐHA · Siêu âm';
  if (/điện tim|dien tim|ecg/.test(n)) return 'CĐHA · Điện tim/khác';
  return 'CĐHA · Khác';
}
function clinicalInfoForVariable(variable) {
  const name = lower(variable?.name || '');
  const id = lower(variable?.id || '');
  const table = lower(variable?.table || '');
  const label = lower(variable?.label || variable?.name || '');
  const textAll = `${name} ${id} ${table} ${label}`;
  const role = variableRole(variable);
  if (role === 'technical' || role === 'identity') return { key: 'technical', section: 'Kỹ thuật/định danh', order: 900 };
  if (/ready_for_analysis|needs_manual_review|overall_status|source_status|encounter_match_ambiguous/.test(textAll)) return { key: 'quality', section: 'Kiểm tra dữ liệu', order: 800 };
  if (table === 'patients' || /sex|birth|age|tuổi|giới|insurance|address/.test(textAll)) return { key: 'admin', section: 'Thông tin hành chánh', order: 100 };
  if (table === 'encounters' || /admission|discharge|hospital_stay|treatment_duration|department|ward|bed|khoa|phòng|giường/.test(textAll)) return { key: 'encounter', section: 'Đợt điều trị / nhập viện', order: 200 };
  if (table === 'diagnoses' || /diagnosis|icd|chẩn đoán|chan doan|comorbidity|complication/.test(textAll)) return { key: 'diagnosis', section: 'Chẩn đoán và bệnh kèm', order: 300 };
  if (table === 'surgery_results' || /surgery|procedure|anesthesia|phẫu thuật|thuật|vô cảm|time_to_surgery/.test(textAll)) return { key: 'surgery', section: 'Phẫu thuật / thủ thuật', order: 700 };
  if (table === 'lab_results' || role === 'lab') return { key: 'lab', section: labSubgroupFromName(textAll), order: 400 };
  if (table === 'imaging_results' || role === 'imaging') return { key: 'imaging', section: imagingSubgroupFromName(textAll), order: 500 };
  if (table === 'medication_orders' || role === 'medication') return { key: 'medication', section: 'Thuốc / y lệnh', order: 600 };
  return { key: 'other', section: 'Biến khác', order: 990 };
}
function groupVariablesBySection(variables) {
  const map = new Map();
  for (const v of variables) {
    const key = v.clinical_section || 'Khác';
    if (!map.has(key)) map.set(key, { label: key, order: Number(v.clinical_order || 999), variables: [] });
    map.get(key).variables.push(v);
  }
  return [...map.values()]
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
    .map(section => ({ ...section, variables: section.variables.sort((a, b) => Number(b.recommended || 0) - Number(a.recommended || 0) || Number(b.fill_rate || 0) - Number(a.fill_rate || 0) || String(a.display_label).localeCompare(String(b.display_label))) }));
}

function variableDescription(variable) {
  const role = variableRole(variable);
  const label = humanizeVariableName(variable?.name || '');
  const table = variable?.table_label || variable?.table || '';
  const map = {
    baseline: 'Biến nền/hành chánh thường dùng để mô tả dân số nghiên cứu.',
    time: 'Biến thời gian; có thể dùng để lọc theo khoảng ngày hoặc tính mốc điều trị.',
    lab: 'Biến xét nghiệm; thường dùng cùng điều kiện kết quả số hoặc cờ bất thường.',
    imaging: 'Biến CĐHA; dùng để lọc loại khảo sát, vùng khảo sát hoặc kết luận.',
    medication: 'Biến thuốc/y lệnh; dùng để lọc thuốc, nhóm thuốc, đường dùng hoặc thời điểm.',
    diagnosis: 'Biến chẩn đoán; dùng để lọc ICD/chẩn đoán chính/phụ.',
    procedure: 'Biến phẫu thuật/thủ thuật; dùng để lọc tên mổ, ngày mổ, phương pháp vô cảm.',
    identity: 'Biến định danh/tra cứu. Không nên đưa vào dataset nghiên cứu chia sẻ.',
    technical: 'Biến kỹ thuật để debug/đối chiếu. Thường không dùng làm biến nghiên cứu.',
    other: `Biến từ bảng ${table}.`,
  };
  if (/ready_for_analysis/i.test(variable?.name || '')) return 'Cờ cho biết dòng này đã đủ điều kiện dùng cho phân tích.';
  if (/needs_manual_review|ambiguous/i.test(variable?.name || '')) return 'Cờ cảnh báo cần kiểm tra tay trước khi chốt dữ liệu.';
  return map[role] || `${label} từ bảng ${table}.`;
}
function enhanceCatalogVariable(variable, group) {
  const role = variableRole(variable);
  const clinical = clinicalInfoForVariable(variable);
  const technicalOrIdentity = role === 'technical' || role === 'identity' || clinical.key === 'technical';
  const recommended = !technicalOrIdentity && VARIABLE_RECOMMENDED_TABLES.has(String(variable?.table || ''));
  const groupMeta = CLINICAL_GROUP_BY_KEY.get(clinical.key) || CLINICAL_GROUP_BY_KEY.get('other');
  return {
    ...variable,
    source_group_label: group?.label || variable?.table_label || variable?.table || '',
    source_group_key: group?.key || variable?.table || '',
    group_label: groupMeta?.label || 'Khác',
    group_key: clinical.key || 'other',
    clinical_group_label: groupMeta?.label || 'Khác',
    clinical_group_key: clinical.key || 'other',
    clinical_group_hint: groupMeta?.hint || '',
    clinical_section: clinical.section || groupMeta?.label || 'Khác',
    clinical_order: clinical.order || groupMeta?.order || 999,
    display_label: humanizeVariableName(variable?.label || variable?.name || ''),
    raw_name: variable?.name || '',
    description: variableDescription(variable),
    role,
    recommended,
    technical_or_identity: technicalOrIdentity,
  };
}
function variableRoleLabel(role) {
  return ({
    baseline: 'Nền', time: 'Thời gian', lab: 'XN', imaging: 'CĐHA', medication: 'Thuốc', diagnosis: 'Chẩn đoán', procedure: 'PT/TT', identity: 'Định danh', technical: 'Kỹ thuật', other: 'Khác',
  })[role] || 'Khác';
}
function operatorLabel(op) {
  return ({
    contains: 'chứa', '=': '=', '!=': 'khác', '>': '>', '>=': '≥', '<': '<', '<=': '≤', between: 'trong khoảng', in: 'thuộc danh sách', not_empty: 'có dữ liệu', empty: 'trống',
  })[op] || op;
}
const VARIABLE_AGGREGATIONS = [
  ['list', 'Liệt kê giá trị'],
  ['first', 'Giá trị đầu tiên'],
  ['last', 'Giá trị cuối cùng'],
  ['min', 'Nhỏ nhất'],
  ['max', 'Lớn nhất'],
  ['mean', 'Trung bình'],
  ['count', 'Số lần xuất hiện'],
  ['any', 'Có / không'],
  ['closest_before_surgery', 'Gần trước mổ nhất'],
  ['closest_after_surgery', 'Gần sau mổ nhất'],
];
function aggregationLabel(value) {
  return VARIABLE_AGGREGATIONS.find(([key]) => key === value)?.[1] || 'Liệt kê giá trị';
}
function sampleText(values, max = 4) {
  const arr = Array.isArray(values) ? values : [];
  const raw = arr.slice(0, max).map(x => String(x?.value ?? x ?? '').trim()).filter(Boolean).join(' · ');
  if (!raw) return 'Chưa có giá trị mẫu';
  return raw.length > 180 ? `${raw.slice(0, 180)}…` : raw;
}

// ── helpers ──────────────────────────────────────────────────────────────────
function text(v) { return String(v ?? '').trim(); }
function lower(v) { return text(v).toLowerCase(); }
function pick(row, keys, fb = '') {
  for (const k of keys) if (text(row?.[k])) return text(row[k]);
  return fb;
}
function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
}
function downloadCsv(filename, columns, rows) {
  const csv = `\ufeff${columns.map(csvEscape).join(',')}\n${rows.map(r => columns.map(c => csvEscape(r?.[c] ?? '')).join(',')).join('\n')}`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
function saveBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
function parseDate(v) {
  const s = text(v);
  let m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return new Date(+m[3], +m[2]-1, +m[1]);
  m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(+m[1], +m[2]-1, +m[3]);
  return null;
}
function parseDateTime(v) {
  const s = text(v);
  let m = s.match(/(\d{1,2}):(\d{2})\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return new Date(+m[5], +m[4]-1, +m[3], +m[1], +m[2]);
  m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (m) return new Date(+m[3], +m[2]-1, +m[1], +m[4], +m[5]);
  m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]+(\d{1,2}):(\d{2}))?/);
  if (m) return new Date(+m[1], +m[2]-1, +m[3], +(m[4] || 0), +(m[5] || 0));
  return parseDate(s);
}
function sortRowsForDisplay(tableKey, inputRows) {
  if (!['initial_list', 'deep_source', 'patients', 'cohort'].includes(String(tableKey || ''))) return inputRows;
  if (!Array.isArray(inputRows) || inputRows.length < 2) return inputRows || [];
  const dateKeys = ['T/G vào','TG vào','Tg vào','Thời gian vào','Thoi gian vao','Ngày vào viện','Ngay vao vien','Ngày nhập viện','Ngay nhap vien','admission_time','admission_datetime','admission_date'];
  return [...inputRows].sort((a, b) => {
    const da = parseDateTime(pick(a, dateKeys));
    const db = parseDateTime(pick(b, dateKeys));
    const ta = da ? da.getTime() : -Infinity;
    const tb = db ? db.getTime() : -Infinity;
    if (tb !== ta) return tb - ta;
    return pick(b, ['Mã BN','Ma BN','MABN','patient_code']).localeCompare(pick(a, ['Mã BN','Ma BN','MABN','patient_code']));
  });
}
function rowInDateRange(row, columns, from, to) {
  if (!from && !to) return true;
  const dateCols = columns.filter(c => /ngày|ngay|tg |thời gian|thoi gian|date|time/i.test(c));
  for (const c of (dateCols.length ? dateCols : columns)) {
    const d = parseDate(row?.[c]);
    if (!d) continue;
    if (from && d < from) continue;
    if (to && d > to) continue;
    return true;
  }
  return false;
}
function compactNumber(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n.toLocaleString('vi-VN') : String(v || 0);
}

function overviewStatusReady(row) {
  return statusIsDone(row?.overall_status) || String(row?.ready_for_analysis || '') === '1';
}
function overviewDone(row, fields = []) {
  return fields.some(field => statusIsDone(row?.[field]));
}
function overviewDateLabel(value) {
  const d = parseDateTime(value);
  if (!d || Number.isNaN(d.getTime())) return text(value);
  return d.toLocaleDateString('vi-VN');
}
function buildGeneralOverviewModel({
  patientRows = [],
  encounterRows = [],
  statusRows = [],
  coverage = null,
  progressSnapshot = null,
  source = null,
  isArchive = true,
  limited = false,
  patientCount = 0,
  encounterCount = 0,
}) {
  const people = new Map();
  const patientList = Array.isArray(patientRows) ? patientRows : [];
  const encounterList = Array.isArray(encounterRows) ? encounterRows : [];
  const statusList = Array.isArray(statusRows) ? statusRows : [];
  const hasStatusRows = statusList.length > 0;

  const overviewKey = (seed = {}, idx = 0) => {
    const encounterId = pick(seed, ['encounter_id', 'encounter_key']);
    const researchCode = pick(seed, ['research_code', 'Mã NC', 'Ma NC', 'first_research_code']);
    const patientCode = pick(seed, ['patient_code', 'Mã BN', 'Ma BN', 'MABN', 'ma_bn']);
    const patientName = pick(seed, ['patient_name', 'Họ tên', 'Ho ten', 'Tên BN', 'Ten BN', 'ho_ten']);
    const rowHash = pick(seed, ['row_hash']);
    return encounterId || researchCode || patientCode || rowHash || `${patientName || 'row'}_${idx}`;
  };

  const ensure = (seed = {}, idx = 0, allowCreate = true) => {
    const researchCode = pick(seed, ['research_code', 'Mã NC', 'Ma NC', 'first_research_code']);
    const patientCode = pick(seed, ['patient_code', 'Mã BN', 'Ma BN', 'MABN', 'ma_bn']);
    const patientName = pick(seed, ['patient_name', 'Họ tên', 'Ho ten', 'Tên BN', 'Ten BN', 'ho_ten']);
    const key = overviewKey(seed, idx);
    if (!people.has(key)) {
      if (!allowCreate) return null;
      people.set(key, {
        key,
        research_code: researchCode,
        patient_code: patientCode,
        patient_name: patientName,
        encounter_count: 0,
        admissions: [],
        discharges: [],
        diagnoses: [],
        lab_count: 0,
        imaging_count: 0,
        surgery_count: 0,
        medication_count: 0,
        profile_done: false,
        discharge_done: false,
        surgery_done: false,
        order_done: false,
        xn_done: false,
        cdha_done: false,
        ready_count: 0,
        status_count: 0,
        missing: new Set(),
        last_error: '',
      });
    }
    const item = people.get(key);
    if (!item.research_code) item.research_code = researchCode;
    if (!item.patient_code) item.patient_code = patientCode;
    if (!item.patient_name) item.patient_name = patientName;
    return item;
  };

  const applyEncounter = (row, idx, allowCreate = true) => {
    const item = ensure(row, idx, allowCreate);
    if (!item) return;
    item.encounter_count += 1;
    const admission = pick(row, ['admission_datetime', 'admission_date', 'Ngày vào viện', 'Ngày nhập viện', 'T/G vào', 'tg_vao']);
    const discharge = pick(row, ['discharge_datetime', 'discharge_date', 'Ngày ra viện', 'ngay_ra_vien']);
    const diagnosis = pick(row, ['diagnosis_raw', 'primary_diagnosis', 'discharge_diagnosis', 'Chẩn đoán', 'chan_doan']);
    if (admission) item.admissions.push(admission);
    if (discharge) item.discharges.push(discharge);
    if (diagnosis && !item.diagnoses.includes(diagnosis)) item.diagnoses.push(diagnosis);
  };

  const applyStatus = (row, idx) => {
    const item = ensure(row, idx, true);
    if (!item) return;
    item.status_count += 1;
    if (overviewStatusReady(row)) item.ready_count += 1;
    item.lab_count += Number(row?.lab_count || 0);
    item.imaging_count += Number(row?.imaging_count || 0);
    item.surgery_count += Number(row?.surgery_count || 0);
    item.medication_count += Number(row?.medication_count || 0);
    item.profile_done = item.profile_done || overviewDone(row, ['profile_status']);
    item.discharge_done = item.discharge_done || overviewDone(row, ['discharge_status']);
    item.surgery_done = item.surgery_done || overviewDone(row, ['surgery_status']) || Number(row?.surgery_count || 0) > 0;
    item.order_done = item.order_done || overviewDone(row, ['order_history_status']) || Number(row?.medication_count || 0) > 0;
    item.xn_done = item.xn_done || overviewDone(row, ['xn_status', 'popup_status']) || Number(row?.lab_count || 0) > 0;
    item.cdha_done = item.cdha_done || overviewDone(row, ['cdha_status', 'popup_status']) || Number(row?.imaging_count || 0) > 0;
    for (const label of missingLabelsForStatusRow(row)) item.missing.add(label);
    const err = pick(row, ['last_error', 'Lỗi cuối', 'error']);
    if (err) item.last_error = err;
  };

  // Bảng phía dưới là bảng theo dõi tiến độ, vì vậy extract_status là nguồn gốc.
  // Chỉ dùng encounters để bổ sung ngày/chẩn đoán cho đúng cùng encounter_id/Mã NC;
  // không union toàn bộ patients + encounters + progress vì khi ẩn định danh các
  // khóa patient_code bị loại, làm một người/lượt bị đếm thành nhiều dòng.
  if (hasStatusRows) {
    statusList.forEach(applyStatus);
    encounterList.forEach((row, idx) => applyEncounter(row, idx, false));
  } else if (encounterList.length) {
    encounterList.forEach((row, idx) => applyEncounter(row, idx, true));
  } else {
    patientList.forEach((row, idx) => ensure(row, idx, true));
  }

  const sortDates = values => [...values].sort((a, b) => {
    const da = parseDateTime(a);
    const db = parseDateTime(b);
    return (db?.getTime?.() || 0) - (da?.getTime?.() || 0);
  });

  const rows = [...people.values()].map(item => {
    const admissions = sortDates(item.admissions);
    const discharges = sortDates(item.discharges);
    const missing = [...item.missing];
    const ready = item.status_count > 0 && item.ready_count === item.status_count && !missing.length && !item.last_error;
    return {
      ...item,
      admission_date: overviewDateLabel(admissions[0] || ''),
      discharge_date: overviewDateLabel(discharges[0] || ''),
      diagnosis: item.diagnoses[0] || '',
      missing_text: missing.join(', '),
      status_label: item.last_error ? 'Lỗi/cần xem' : ready ? 'Đủ dữ liệu' : missing.length ? 'Còn thiếu' : item.status_count ? 'Đang hoàn thiện' : 'Chưa có tiến độ',
      status_tone: item.last_error ? 'danger' : ready ? 'ok' : missing.length ? 'warn' : 'neutral',
      ready,
    };
  }).sort((a, b) => {
    const da = parseDateTime(a.admission_date);
    const db = parseDateTime(b.admission_date);
    return (db?.getTime?.() || 0) - (da?.getTime?.() || 0);
  });

  const allDates = [];
  for (const row of encounterRows || []) {
    for (const value of [
      pick(row, ['admission_datetime', 'admission_date', 'Ngày vào viện', 'T/G vào']),
      pick(row, ['discharge_datetime', 'discharge_date', 'Ngày ra viện']),
    ]) {
      const d = parseDateTime(value);
      if (d && !Number.isNaN(d.getTime())) allDates.push(d);
    }
  }
  allDates.sort((a, b) => a - b);

  // "Mức độ đầy đủ" phải phản ánh đúng đợt thu thập hiện tại.
  // Progress endpoint còn chứa cả các lượt đang chờ/đang lỗi chưa kịp ghi vào extract_status.csv,
  // nên không dùng số dòng extract_status làm mẫu số cho dashboard tổng quát.
  const statusSummary = progressSnapshot?.total
    ? progressSnapshot
    : summarizeStatusRows(statusRows, source, coverage, isArchive);
  const counts = coverage?.counts || {};
  const countOr = (...values) => {
    for (const value of values) {
      if (value === '' || value == null) continue;
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return 0;
  };
  const runFrom = source?.latest_run?.from_date || source?.scan_from_date || '';
  const runTo = source?.latest_run?.to_date || source?.scan_to_date || '';
  const runFromLabel = overviewDateLabel(runFrom);
  const runToLabel = overviewDateLabel(runTo);
  return {
    rows,
    row_kind: hasStatusRows ? 'monitor' : encounterList.length ? 'encounter' : 'patient',
    row_unit: hasStatusRows ? 'lượt' : encounterList.length ? 'đợt' : 'BN',
    statusSummary,
    counts: {
      // Tất cả card lấy từ cùng snapshot count của backend. Không dùng rows.length
      // vì rows là dữ liệu hiển thị/redacted và có thể bị giới hạn hoặc mất khóa join.
      patients: countOr(counts.patient_master, patientCount, patientList.length),
      encounters: countOr(counts.encounters, encounterCount, encounterList.length),
      patient_days: countOr(counts.patient_day),
      labs: countOr(counts.lab_results),
      imaging: countOr(counts.imaging_results),
      surgeries: countOr(counts.surgery_results),
      medications: countOr(counts.medication_orders),
      final_rows: countOr(counts.analysis_final, counts.analysis_ready),
    },
    date_from: runFromLabel || (allDates.length ? allDates[0].toLocaleDateString('vi-VN') : ''),
    date_to: runToLabel || (allDates.length ? allDates[allDates.length - 1].toLocaleDateString('vi-VN') : ''),
    run_id: progressSnapshot?.run_id || source?.latest_run?.id || '',
    limited: Boolean(limited),
  };
}

const RESEARCH_DATA_PARTS = [
  { key: 'xn_cdha', label: 'XN & CĐHA', fields: ['popup_status', 'xn_status', 'cdha_status'], countKeys: ['lab_count', 'imaging_count'] },
  { key: 'profile', label: 'Hồ sơ nền', fields: ['profile_status'], countKeys: [] },
  { key: 'discharge', label: 'Ra viện', fields: ['discharge_status'], countKeys: [] },
  { key: 'surgery', label: 'Phẫu thuật', fields: ['surgery_status'], countKeys: ['surgery_count'] },
  { key: 'order_history', label: 'Y lệnh', fields: ['order_history_status'], countKeys: ['medication_count'] },
];
const RESEARCH_STATUS_COMPARE_FIELDS = [
  'overall_status', 'completion_level', 'ready_for_analysis', 'missing_required', 'last_error',
  ...RESEARCH_DATA_PARTS.flatMap(part => [...part.fields, ...part.countKeys]),
];

function statusIsDone(v) {
  const s = lower(v);
  return s === 'done' || s === 'ok' || s === 'success' || s === '1' || s === 'true';
}
function statusIsMissing(v) {
  const s = lower(v);
  return !s || ['pending', 'error', 'failed', 'no_url', 'missing', 'incomplete', 'partial'].some(x => s.includes(x));
}
function patientStatusKey(row, idx = 0) {
  return pick(row, ['research_code', 'Mã NC', 'Ma NC'])
    || `${pick(row, ['patient_code', 'Mã BN', 'Ma BN', 'MABN']) || 'row'}_${idx}`;
}
function patientStatusLabel(row) {
  return pick(row, ['research_code', 'Mã NC', 'Ma NC']) || pick(row, ['patient_code', 'Mã BN', 'Ma BN', 'MABN']) || '—';
}
function patientStatusName(row) {
  return pick(row, ['patient_name', 'Họ tên', 'Ho ten', 'Tên BN', 'Ten BN']) || '—';
}
function missingLabelsForStatusRow(row) {
  if (!row) return [];
  const labels = [];
  const missingRaw = lower(row.missing_required || row['missing_required']);
  for (const part of RESEARCH_DATA_PARTS) {
    const firstWord = lower(part.label).split(' ')[0];
    const explicitMissing = Boolean(missingRaw && (missingRaw.includes(part.key) || missingRaw.includes(firstWord)));
    const partDone = part.fields.every(f => statusIsDone(row[f]));
    const partMissing = part.fields.some(f => statusIsMissing(row[f]));
    if (explicitMissing || (!partDone && partMissing)) labels.push(part.label);
  }
  return Array.from(new Set(labels));
}
function summarizeStatusRows(rows = [], source = null, coverage = null, isArchive = false) {
  const arr = Array.isArray(rows) ? rows : [];
  const total = arr.length || Number(coverage?.extract?.total || 0) || datasetCount(source, isArchive ? 'initial_list' : 'cohort', isArchive) || 0;
  const ready = arr.length
    ? arr.filter(r => statusIsDone(r.overall_status) || String(r.ready_for_analysis || '') === '1').length
    : Number(coverage?.extract?.ready || 0);
  const modules = RESEARCH_DATA_PARTS.map(part => {
    const done = arr.length
      ? arr.filter(r => part.fields.every(f => statusIsDone(r[f]))).length
      : Number(coverage?.extract?.file_done?.[part.key] || 0);
    return { ...part, done, missing: Math.max(0, total - done) };
  });
  const monitorRows = arr.map((row, idx) => {
    const missing = missingLabelsForStatusRow(row);
    const hasError = Boolean(pick(row, ['last_error', 'Lỗi cuối', 'error']));
    const isReady = statusIsDone(row.overall_status) || String(row.ready_for_analysis || '') === '1';
    const state = isReady ? 'done' : hasError ? 'error' : missing.length ? 'missing' : 'waiting';
    return {
      key: patientStatusKey(row, idx),
      sample: patientStatusLabel(row),
      patient_code: pick(row, ['patient_code', 'Mã BN', 'Ma BN', 'MABN']),
      patient_name: patientStatusName(row),
      state,
      state_label: isReady ? 'Đủ dữ liệu' : hasError ? 'Lỗi/cần xem' : missing.length ? 'Còn thiếu' : 'Chưa lấy đủ',
      missing: missing.join(', '),
      xn_cdha: missing.includes('XN & CĐHA') ? 'Chưa lấy' : 'Đã lấy',
      profile: missing.includes('Hồ sơ nền') ? 'Chưa lấy' : 'Đã lấy',
      discharge: missing.includes('Ra viện') ? 'Chưa lấy' : 'Đã lấy',
      surgery: missing.includes('Phẫu thuật') ? 'Chưa lấy' : 'Đã lấy',
      order_history: missing.includes('Y lệnh') ? 'Chưa lấy' : 'Đã lấy',
      last_error: pick(row, ['last_error', 'Lỗi cuối', 'error']),
      updated_at: pick(row, ['updated_at', 'finished_at', 'started_at']),
    };
  });
  const missingRows = monitorRows.filter(r => text(r.missing) || text(r.last_error)).slice(0, 200);
  return {
    total,
    ready,
    missingCount: Math.max(0, total - ready),
    manualReview: Number(coverage?.extract?.manual_review || 0),
    modules,
    missingRows,
    rows: monitorRows.slice(0, 500),
    counts: {
      running: monitorRows.filter(r => r.state === 'running').length,
      error: monitorRows.filter(r => r.state === 'error').length,
      missing: monitorRows.filter(r => r.state === 'missing').length,
      waiting: monitorRows.filter(r => r.state === 'waiting').length,
      done: monitorRows.filter(r => r.state === 'done').length,
    },
  };
}
function diffStatusRows(beforeRows = [], afterRows = [], title = 'Cập nhật dữ liệu') {
  const beforeMap = new Map((Array.isArray(beforeRows) ? beforeRows : []).map((row, idx) => [patientStatusKey(row, idx), row]));
  const outRows = [];
  for (const [idx, row] of (Array.isArray(afterRows) ? afterRows : []).entries()) {
    const key = patientStatusKey(row, idx);
    const old = beforeMap.get(key);
    const changedFields = RESEARCH_STATUS_COMPARE_FIELDS.filter(f => text(old?.[f]) !== text(row?.[f]));
    if (!changedFields.length && old) continue;
    const updatedParts = RESEARCH_DATA_PARTS.filter(part => {
      const partChanged = part.fields.concat(part.countKeys).some(f => changedFields.includes(f));
      const nowDone = part.fields.every(f => statusIsDone(row[f]));
      return partChanged || (!old && nowDone);
    }).map(part => part.label);
    outRows.push({
      key,
      sample: patientStatusLabel(row),
      patient_code: pick(row, ['patient_code', 'Mã BN', 'Ma BN', 'MABN']),
      patient_name: patientStatusName(row),
      updated: updatedParts.length ? Array.from(new Set(updatedParts)).join(', ') : 'Trạng thái mẫu',
      missing: missingLabelsForStatusRow(row).join(', '),
      result: statusIsDone(row.overall_status) || String(row.ready_for_analysis || '') === '1' ? 'Đủ dữ liệu' : (pick(row, ['overall_status', 'completion_level']) || 'Đã cập nhật'),
    });
  }
  return { title, at: new Date().toLocaleString('vi-VN'), totalChanged: outRows.length, rows: outRows.slice(0, 120) };
}

function diffProgressSnapshots(before = null, after = null, title = 'Cập nhật dữ liệu') {
  const beforeKeys = new Set((before?.recentUpdates || []).map(row => `${row.key || row.sample}|${row.updated}|${row.updated_at || ''}`));
  let rows = (after?.recentUpdates || []).filter(row => !beforeKeys.has(`${row.key || row.sample}|${row.updated}|${row.updated_at || ''}`));
  if (!rows.length) rows = (after?.recentUpdates || []).slice(0, 20);
  return { title, at: new Date().toLocaleString('vi-VN'), totalChanged: rows.length, rows: rows.slice(0, 120) };
}

function statusToneForMonitor(value, state = '') {
  const raw = lower(value || state);
  if (raw.includes('đang') || raw.includes('running')) return { c: C.blue, bg: C.blueBg, b: C.blueBorder };
  if (raw.includes('lỗi') || raw.includes('error') || raw.includes('fail') || raw.includes('timeout')) return { c: C.red, bg: C.redBg, b: C.redBorder };
  if (raw.includes('một phần') || raw.includes('partial') || raw.includes('thiếu') || raw.includes('chưa')) return { c: C.amber, bg: C.amberBg, b: C.amberBorder };
  if (raw.includes('đã lấy') || raw.includes('đủ') || raw.includes('done') || raw.includes('ok')) return { c: C.green, bg: C.greenBg, b: C.greenBorder };
  return { c: C.text3, bg: C.surface2, b: C.border2 };
}

function StatusPill({ value, state = '', wide = false }) {
  const v = text(value) || '—';
  const raw = lower(v || state);
  const isRunning = raw.includes('đang') || raw.includes('running');
  const isError = raw.includes('lỗi') || raw.includes('error') || raw.includes('fail') || raw.includes('timeout');
  const isMissing = raw.includes('một phần') || raw.includes('partial') || raw.includes('thiếu') || raw.includes('chưa');
  const isDone = raw.includes('đã lấy') || raw.includes('đủ') || raw.includes('done') || raw === 'ok';
  const color = isError ? C.red : isMissing ? C.amber : isDone ? C.green : isRunning ? C.blue : C.text3;
  const symbol = isError ? '!' : isMissing ? '–' : isDone ? '✓' : isRunning ? '…' : '·';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
      minWidth: wide ? 72 : 50, height: 19, padding: '0 6px', borderRadius: 4,
      border: `1px solid ${C.border2}`, background: C.surface, color,
      fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap', lineHeight: 1,
    }}><b style={{ fontSize: 10 }}>{symbol}</b>{v}</span>
  );
}

function statusDotTone(state) {
  if (state === 'running') return { bg: C.blue, soft: C.blueBg, border: C.blueBorder, text: C.blue };
  if (state === 'error') return { bg: C.red, soft: C.redBg, border: C.redBorder, text: C.red };
  if (state === 'missing' || state === 'waiting') return { bg: C.amber, soft: C.amberBg, border: C.amberBorder, text: C.amber };
  if (state === 'done') return { bg: C.green, soft: C.greenBg, border: C.greenBorder, text: C.green };
  return { bg: C.text3, soft: C.surface2, border: C.border2, text: C.text3 };
}

function ModuleProgressCard({ part }) {
  const total = Number(part.total || 0);
  const done = Number(part.done || 0);
  const running = Number(part.running || 0);
  const error = Number(part.error || 0);
  const waiting = Number(part.waiting || 0);
  const missing = Math.max(0, Number(part.missing || 0) + waiting);
  const pct = total ? Math.max(0, Math.min(100, Math.round(done * 100 / total))) : 0;
  const fill = error ? C.red : running ? C.blue : missing ? C.amber : C.green;
  return (
    <div style={{ background: 'transparent', padding: '6px 2px 7px', minWidth: 145 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
        <div style={{ fontSize: 11, color: C.text, fontWeight: 750 }}>{part.label}</div>
        <div style={{ fontSize: 10, color: C.text3, fontWeight: 700 }}>{compactNumber(done)}/{compactNumber(total)}</div>
      </div>
      <div style={{ height: 4, borderRadius: 2, background: C.surface2, marginTop: 7, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: fill, borderRadius: 2 }} />
      </div>
      <div style={{ marginTop: 6, minHeight: 15, fontSize: 10, color: C.text3, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <span>{pct}%</span>
        {!!running && <span style={{ color: C.blue }}>{compactNumber(running)} đang chạy</span>}
        {!!missing && <span style={{ color: C.amber }}>{compactNumber(missing)} thiếu</span>}
        {!!error && <span style={{ color: C.red }}>{compactNumber(error)} lỗi</span>}
      </div>
    </div>
  );
}

function MiniPartStatus({ label, value }) {
  const raw = lower(value);
  const done = statusIsDone(value);
  const error = raw.includes('lỗi') || raw.includes('error') || raw.includes('fail') || raw.includes('timeout');
  const running = raw.includes('đang') || raw.includes('running');
  const color = error ? C.red : done ? C.green : running ? C.blue : C.amber;
  const symbol = error ? '!' : done ? '✓' : running ? '…' : '–';
  return (
    <span title={`${label}: ${text(value) || 'Chưa lấy'}`} style={{
      display: 'inline-flex', alignItems: 'center', gap: 3, color,
      fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap',
    }}><b>{symbol}</b>{label}</span>
  );
}

function ResearchMonitorTable({ rows = [], max = 80, filter = 'need', query = '' }) {
  const q = text(query).toLowerCase();
  const filtered = (Array.isArray(rows) ? rows : []).filter(row => {
    if (filter === 'running' && row.state !== 'running') return false;
    if (filter === 'need' && !['running','error','missing','waiting'].includes(row.state)) return false;
    if (filter === 'error' && row.state !== 'error') return false;
    if (filter === 'done' && row.state !== 'done') return false;
    if (q) {
      const hay = [row.sample, row.research_code, row.patient_code, row.patient_name, row.missing, row.last_error].map(text).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const shown = filtered.slice(0, max);
  if (!shown.length) {
    return (
      <div style={{ padding: 16, border: `1px solid ${C.border2}`, borderRadius: 8, background: C.surface, fontSize: 11, color: C.text3, textAlign: 'center' }}>
        Không có dữ liệu phù hợp.
      </div>
    );
  }
  return (
    <div style={{ border: `1px solid ${C.border2}`, borderRadius: 8, overflow: 'hidden', background: C.surface }}>
      <div style={{ maxHeight: 500, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead style={{ position: 'sticky', top: 0, background: C.surface2, zIndex: 1 }}>
            <tr>
              {['Người bệnh / mẫu','Tiến độ','Trạng thái','Thiếu hoặc lỗi','Cập nhật'].map(label => (
                <th key={label} style={{ textAlign: 'left', padding: '8px 10px', color: C.text3, whiteSpace: 'nowrap', fontWeight: 750, borderBottom: `1px solid ${C.border2}` }}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, idx) => (
              <tr key={row.key || `${row.sample}_${idx}`} style={{ borderBottom: `1px solid ${C.border2}` }}>
                <td style={{ padding: '8px 10px', minWidth: 210 }}>
                  <div style={{ color: C.text, fontWeight: 750, fontSize: 11.5 }}>{text(row.patient_name) || '—'}</div>
                  <div style={{ marginTop: 2, color: C.text3, fontSize: 10 }}>
                    BN {text(row.patient_code) || '—'} · NC {text(row.sample) || '—'}
                  </div>
                </td>
                <td style={{ padding: '8px 10px', minWidth: 245 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                    <MiniPartStatus label="XN" value={row.xn_cdha} />
                    <MiniPartStatus label="HS" value={row.profile} />
                    <MiniPartStatus label="RV" value={row.discharge} />
                    <MiniPartStatus label="PT" value={row.surgery} />
                    <MiniPartStatus label="YL" value={row.order_history} />
                  </div>
                </td>
                <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                  <StatusPill value={row.state_label} state={row.state} wide />
                </td>
                <td title={[text(row.missing), text(row.last_error)].filter(Boolean).join(' — ')} style={{ padding: '8px 10px', minWidth: 190, maxWidth: 360 }}>
                  <div style={{ color: row.last_error ? C.red : row.missing ? C.amber : C.text3, fontWeight: row.last_error || row.missing ? 700 : 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {text(row.last_error) || text(row.missing) || '—'}
                  </div>
                </td>
                <td style={{ padding: '8px 10px', color: C.text3, whiteSpace: 'nowrap', fontSize: 10 }}>{text(row.updated_at) || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ padding: '7px 10px', fontSize: 10, color: C.text3, borderTop: `1px solid ${C.border2}` }}>
        {compactNumber(shown.length)}/{compactNumber(filtered.length)} dòng
      </div>
    </div>
  );
}

function EncounterHistoryCard({ enc, index }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div style={{ border: `1px solid ${C.border2}`, borderRadius: 8, background: C.bg, padding: 9 }}>
      <button type="button" onClick={() => setExpanded(v => !v)} style={{
        width: '100%', border: 0, background: 'transparent', padding: 0, cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, textAlign: 'left',
      }}>
        <span style={{ fontSize: 11.5, fontWeight: 850, color: C.blue }}>
          Đợt {index + 1}: {enc.admission_date || '—'} → {enc.discharge_date || '—'}
        </span>
        <span style={{ fontSize: 10, color: C.text3 }}>{expanded ? 'Thu gọn' : 'Xem chi tiết'}</span>
      </button>
      <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 10.5, color: C.text2, flex: '1 1 280px' }}>{enc.diagnosis_raw || 'Chưa có chẩn đoán'}</span>
        <StatBadge label="XN" value={enc.counts?.labs || 0} tone="neutral" />
        <StatBadge label="CĐHA" value={enc.counts?.imaging || 0} tone="neutral" />
        <StatBadge label="Thuốc" value={enc.counts?.medications || 0} tone="neutral" />
        <StatBadge label="PT/TT" value={enc.counts?.surgeries || 0} tone="neutral" />
      </div>
      {expanded && (
        <div style={{ marginTop: 9, display: 'grid', gap: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 6, fontSize: 10.5, color: C.text2 }}>
            <div><b>Khoa/phòng:</b> {[enc.department, enc.room_bed].filter(Boolean).join(' · ') || '—'}</div>
            <div><b>Ngày mổ:</b> {enc.surgery_date || '—'}</div>
            <div><b>Số ngày điều trị:</b> {enc.treatment_duration || '—'}</div>
            <div><b>Mã NC:</b> {enc.research_code || '—'}</div>
          </div>
          <details><summary style={{ cursor: 'pointer', fontSize: 10.5, fontWeight: 800, color: C.text2 }}>Xét nghiệm ({enc.counts?.labs || 0})</summary><SmallRowsTable max={120} rows={enc.labs || []} columns={[{key:'lab_datetime',label:'Thời gian'}, {key:'test_name_raw',label:'Tên XN'}, {key:'result_raw',label:'KQ'}, {key:'unit',label:'Đơn vị'}]} /></details>
          <details><summary style={{ cursor: 'pointer', fontSize: 10.5, fontWeight: 800, color: C.text2 }}>CĐHA ({enc.counts?.imaging || 0})</summary><SmallRowsTable max={80} rows={enc.imaging || []} columns={[{key:'ordered_at',label:'Thời gian'}, {key:'service_name_raw',label:'Dịch vụ'}, {key:'conclusion_text',label:'Kết luận', long:true}]} /></details>
          <details><summary style={{ cursor: 'pointer', fontSize: 10.5, fontWeight: 800, color: C.text2 }}>Thuốc / y lệnh ({enc.counts?.medications || 0})</summary><SmallRowsTable max={120} rows={enc.medications || []} columns={[{key:'order_datetime',label:'Thời gian'}, {key:'drug_name_raw',label:'Thuốc'}, {key:'dose_raw',label:'Liều'}, {key:'route_raw',label:'Đường'}]} /></details>
          <details><summary style={{ cursor: 'pointer', fontSize: 10.5, fontWeight: 800, color: C.text2 }}>Phẫu thuật / thủ thuật ({enc.counts?.surgeries || 0})</summary><SmallRowsTable max={60} rows={enc.surgeries || []} columns={[{key:'surgery_datetime',label:'Thời gian'}, {key:'surgery_name',label:'Tên PT/TT'}, {key:'surgery_method',label:'Phương pháp'}, {key:'anesthesia_method',label:'Vô cảm'}]} /></details>
        </div>
      )}
    </div>
  );
}

function ResearchOperationDashboard({ snapshot, lastUpdate, loading = false, onRefresh }) {
  const [filter, setFilter] = useState('need');
  const [query, setQuery] = useState('');
  const [showRows, setShowRows] = useState(false);
  const snap = snapshot || summarizeStatusRows([]);
  const rows = Array.isArray(snap.rows) ? snap.rows : [];
  const counts = snap.counts || {
    running: rows.filter(r => r.state === 'running').length,
    error: rows.filter(r => r.state === 'error').length,
    missing: rows.filter(r => r.state === 'missing').length,
    waiting: rows.filter(r => r.state === 'waiting').length,
    done: rows.filter(r => r.state === 'done').length,
  };
  const total = Number(snap.total || rows.length || 0);
  const need = Number(counts.running || 0) + Number(counts.error || 0) + Number(counts.missing || 0) + Number(counts.waiting || 0);
  const generatedAt = snap.generated_at ? new Date(snap.generated_at).toLocaleString('vi-VN') : '';
  const updateBlock = lastUpdate || (Array.isArray(snap.recentUpdates) && snap.recentUpdates.length
    ? { title: 'Mới cập nhật', at: generatedAt, totalChanged: snap.recentUpdates.length, rows: snap.recentUpdates }
    : null);
  const filterButtons = [
    ['need', `Cần xử lý ${compactNumber(need)}`],
    ['running', `Đang chạy ${compactNumber(counts.running || 0)}`],
    ['error', `Lỗi ${compactNumber(counts.error || 0)}`],
    ['done', `Đã đủ ${compactNumber(counts.done || snap.ready || 0)}`],
    ['all', `Tất cả ${compactNumber(rows.length || total)}`],
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <section style={{ borderTop: `1px solid ${C.border2}`, borderBottom: `1px solid ${C.border2}`, background: C.surface, padding: '10px 2px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 800, color: C.text }}>Giám sát dữ liệu</span>
            {loading && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: C.text3, fontSize: 10 }}><Spinner size={8} /> đang cập nhật</span>}
            <StatBadge label="tổng" value={total || rows.length} tone="neutral" />
            <StatBadge label="đủ" value={counts.done || snap.ready || 0} tone="ok" />
            <StatBadge label="thiếu" value={(counts.missing || 0) + (counts.waiting || 0)} tone={(counts.missing || counts.waiting) ? 'warn' : 'neutral'} />
            <StatBadge label="lỗi" value={counts.error || 0} tone={counts.error ? 'danger' : 'neutral'} />
          </div>
          <div style={{ display: 'flex', gap: 5 }}>
            <Btn onClick={() => setShowRows(v => !v)} style={{ height: 26, padding: '0 9px', fontSize: 10 }}>
              {showRows ? 'Ẩn danh sách' : `Xem ca thiếu/lỗi (${compactNumber(need)})`}
            </Btn>
            {onRefresh && (
              <Btn onClick={onRefresh} disabled={loading} style={{ height: 26, padding: '0 9px', fontSize: 10 }}>
                {loading ? <Spinner size={8} /> : '↻'}
              </Btn>
            )}
          </div>
        </div>

        {snap.active_task && (
          <div style={{ marginTop: 9, borderTop: `1px solid ${C.border2}`, paddingTop: 8, fontSize: 10.5, color: C.text2, display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            <Spinner size={9} />
            <b>{snap.active_task.status === 'queued' ? 'Đang chờ' : 'Đang chạy'}:</b>
            <span>{snap.active_task.label || 'Tác vụ nghiên cứu'}</span>
            {snap.active_task.message && <span style={{ color: C.text3 }}>— {snap.active_task.message}</span>}
          </div>
        )}

        {snap.stopped && (
          <div style={{ marginTop: 9, borderLeft: `3px solid ${C.amber}`, background: C.surface2, color: C.text2, padding: '7px 9px', fontSize: 10.5 }}>
            Tác vụ đã dừng giữa chừng. Bấm <b>Cập nhật</b> để tiếp tục phần còn thiếu.
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', columnGap: 18, rowGap: 2, marginTop: 8 }}>
          {(snap.modules || []).map(part => <ModuleProgressCard key={part.key} part={part} />)}
        </div>
      </section>

      {showRows && (
        <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {filterButtons.map(([id, label]) => {
            const active = filter === id;
            return (
              <button key={id} type="button" onClick={() => setFilter(id)} style={{
                height: 26, padding: '0 9px', borderRadius: 5, cursor: 'pointer',
                border: `1px solid ${active ? C.text3 : C.border2}`,
                background: active ? C.surface2 : C.surface,
                color: active ? C.text : C.text2,
                fontSize: 10.5, fontWeight: active ? 750 : 600,
              }}>{label}</button>
            );
          })}
        </div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Mã BN, mã NC, tên hoặc lỗi" style={{ ...inp, width: 235, marginLeft: 'auto', background: C.surface, fontSize: 11 }} />
        {generatedAt && <span style={{ fontSize: 9.5, color: C.text3 }}>{generatedAt}</span>}
      </div>

      <ResearchMonitorTable rows={rows} max={90} filter={filter} query={query} />

      {updateBlock?.rows?.length ? (
        <details style={{ border: `1px solid ${C.border2}`, borderRadius: 8, background: C.surface, padding: '8px 10px' }}>
          <summary style={{ cursor: 'pointer', color: C.text2, fontSize: 10.5, fontWeight: 750 }}>
            {updateBlock.title} · {compactNumber(updateBlock.totalChanged)} mẫu
          </summary>
          <div style={{ marginTop: 8 }}>
            <SmallRowsTable max={8} rows={updateBlock.rows} columns={[
              { key: 'sample', label: 'Mẫu' },
              { key: 'patient_code', label: 'Mã BN' },
              { key: 'patient_name', label: 'Họ tên' },
              { key: 'updated', label: 'Đã cập nhật' },
              { key: 'result', label: 'Kết quả' },
              { key: 'missing', label: 'Còn thiếu' },
            ]} />
          </div>
        </details>
      ) : null}
        </>
      )}
    </div>
  );
}

function todayInputDate() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
function tablesForScope(isArchive) { return isArchive ? ARCHIVE_TABLES : STUDY_TABLES; }
function tableIdsForScope(isArchive) { return tablesForScope(isArchive).map(([id]) => id); }
function defaultTableForScope(isArchive) { return isArchive ? ARCHIVE_DEFAULT_TABLE : STUDY_DEFAULT_TABLE; }
function tableLabel(id, isArchive) {
  return tablesForScope(isArchive).find(([k]) => k === id)?.[1]
      || TABLES.find(([k]) => k === id)?.[1] || 'Bảng';
}
function primaryTableAfterRun(_isArchive = false) { return 'analysis_ready'; }
function datasetCount(source, id, isArchive = false) {
  if (isArchive && id === 'initial_list') return source?.latest_run?.outputs?.initial_list || source?.source_count || 0;
  if (isArchive && id === 'deep_source')  return source?.latest_run?.outputs?.deep_source  || source?.latest_run?.outputs?.patients || 0;
  if (isArchive && id === 'patients')     return source?.latest_run?.outputs?.patients || 0;
  if (id === 'cohort') return isArchive ? source?.source_count || 0 : source?.cohort_count || 0;
  return source?.latest_run?.outputs?.[id] || 0;
}

// ── tiny primitives ───────────────────────────────────────────────────────────
const inp = {
  height: 28, borderRadius: 5, border: `1px solid ${C.border}`,
  background: C.bg, color: C.text, padding: '0 8px',
  fontSize: 12, fontFamily: 'inherit', outline: 'none',
  transition: 'border-color 0.15s',
};
const wizInp = { ...inp, width: '100%' };

function StatBadge({ label, value, tone = 'neutral' }) {
  const colors = {
    ok:      { c: C.green,  bg: C.greenBg,  b: C.greenBorder  },
    info:    { c: C.blue,   bg: C.blueBg,   b: C.blueBorder   },
    warn:    { c: C.amber,  bg: C.amberBg,  b: C.amberBorder  },
    danger:  { c: C.red,    bg: C.redBg,    b: C.redBorder    },
    neutral: { c: C.text3,  bg: C.surface2, b: C.border2      },
  };
  const s = colors[tone] || colors.neutral;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      height: 20, padding: '0 7px', borderRadius: 5,
      border: `1px solid ${s.b}`, background: s.bg,
      fontSize: 10, fontWeight: 700, color: s.c, whiteSpace: 'nowrap',
    }}>
      <span style={{ color: C.text3, fontWeight: 600 }}>{label}</span>
      <span>{compactNumber(value)}</span>
    </span>
  );
}

function CoveragePanel({ coverage }) {
  if (!coverage?.exists) return null;
  const ex = coverage.extract || {};
  const total = Number(ex.total || 0);
  const ready = Number(ex.ready || 0);
  const missing = Math.max(0, total - ready);
  return (
    <div style={{
      padding: '7px 12px', borderBottom: `1px solid ${missing ? C.amberBorder : C.greenBorder}`,
      background: missing ? C.amberBg : C.greenBg,
      display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', flexShrink: 0,
    }}>
      <span style={{ fontSize: 11, fontWeight: 850, color: missing ? C.amber : C.green }}>Tiến độ dữ liệu</span>
      <StatBadge label="đủ" value={`${ready}/${total || 0}`} tone={missing ? 'warn' : 'ok'} />
      <StatBadge label="thiếu" value={missing} tone={missing ? 'warn' : 'ok'} />
      <StatBadge label="xem tay" value={ex.manual_review || 0} tone={ex.manual_review ? 'danger' : 'ok'} />
      {coverage.final_dataset_ready && <span style={{ fontSize: 10, color: C.green }}>Đã đủ điều kiện tạo dataset cuối.</span>}
    </div>
  );
}


const actionBtn = { height: 28, padding: '0 10px', fontSize: 11, whiteSpace: 'nowrap' };

function ActionGroup({ title, subtitle, tone = 'neutral', children, style = {} }) {
  const colors = {
    neutral: { bg: C.surface, border: C.border, title: C.text },
    info:    { bg: C.blueBg, border: C.blueBorder, title: C.blue },
    warn:    { bg: C.amberBg, border: C.amberBorder, title: C.amber },
    ok:      { bg: C.greenBg, border: C.greenBorder, title: C.green },
  };
  const t = colors[tone] || colors.neutral;
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 5,
      minWidth: 150, padding: '7px 8px', borderRadius: 6,
      border: `1px solid ${t.border}`, background: t.bg,
      ...style,
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span style={{ fontSize: 10, fontWeight: 850, color: t.title, letterSpacing: '0.03em', textTransform: 'uppercase' }}>{title}</span>
        {subtitle && <span style={{ fontSize: 9, color: C.text3, lineHeight: 1.25 }}>{subtitle}</span>}
      </div>
      <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>{children}</div>
    </div>
  );
}

function AdvancedActions({ label = 'Tác vụ phụ', children }) {
  return (
    <details style={{
      border: `1px solid ${C.border2}`, borderRadius: 6,
      background: C.surface2, padding: '6px 8px', alignSelf: 'stretch', minWidth: 180,
    }}>
      <summary style={{ cursor: 'pointer', fontSize: 11, fontWeight: 750, color: C.text2, listStylePosition: 'inside' }}>
        {label}
      </summary>
      <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap', marginTop: 7 }}>
        {children}
      </div>
    </details>
  );
}


function ModeButton({ active, title, hint, onClick }) {
  return (
    <button type="button" onClick={onClick}
      title={hint || title}
      style={{
        minWidth: 0, textAlign: 'center', cursor: 'pointer', height: 34,
        border: 0, borderBottom: `2px solid ${active ? C.blue : 'transparent'}`,
        background: 'transparent', color: active ? C.text : C.text3,
        padding: '0 12px', fontFamily: 'inherit',
      }}>
      <span style={{ fontSize: 11.5, fontWeight: active ? 800 : 650, whiteSpace: 'nowrap' }}>{title}</span>
    </button>
  );
}

function SimpleCard({ title, value, hint, tone = 'neutral' }) {
  const colors = {
    neutral: { b: C.border2, bg: C.surface, c: C.text },
    info: { b: C.blueBorder, bg: C.blueBg, c: C.blue },
    ok: { b: C.greenBorder, bg: C.greenBg, c: C.green },
    warn: { b: C.amberBorder, bg: C.amberBg, c: C.amber },
  };
  const t = colors[tone] || colors.neutral;
  return (
    <div style={{ border: `1px solid ${t.b}`, background: t.bg, borderRadius: 7, padding: 12, minWidth: 160, flex: '1 1 180px' }}>
      <div style={{ fontSize: 11, color: C.text3, fontWeight: 750 }}>{title}</div>
      <div style={{ fontSize: 22, color: t.c, fontWeight: 850, marginTop: 3 }}>{value}</div>
      {hint && <div style={{ fontSize: 11, color: C.text3, marginTop: 5, lineHeight: 1.4 }}>{hint}</div>}
    </div>
  );
}

function SmallRowsTable({ columns = [], rows = [], max = 8 }) {
  const shown = rows.slice(0, max);
  if (!shown.length) return <div style={{ fontSize: 11, color: C.text3, padding: '6px 0' }}>Không có dữ liệu.</div>;
  return (
    <div style={{ overflowX: 'auto', border: `1px solid ${C.border2}`, borderRadius: 8 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
        <thead style={{ background: C.surface2 }}>
          <tr>{columns.map(c => <th key={c.key} style={{ textAlign: 'left', padding: '6px 8px', color: C.text3, borderBottom: `1px solid ${C.border2}`, whiteSpace: 'nowrap' }}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {shown.map((row, idx) => (
            <tr key={idx} style={{ borderTop: `1px solid ${C.border2}` }}>
              {columns.map(c => <td key={c.key} style={{ padding: '6px 8px', color: C.text2, verticalAlign: 'top', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: c.long ? 'pre-wrap' : 'nowrap' }}>{text(row?.[c.key]) || '—'}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > max && <div style={{ padding: '5px 8px', fontSize: 10, color: C.text3, borderTop: `1px solid ${C.border2}` }}>Hiển thị {max}/{rows.length} dòng đầu.</div>}
    </div>
  );
}

function SideItem({ label, sub, badge, active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'block', width: '100%', textAlign: 'left',
        border: 0, borderBottom: `1px solid ${C.border2}`,
        background: active ? `${C.blueBg}` : 'transparent',
        cursor: 'pointer', padding: '9px 12px',
        borderLeft: `2px solid ${active ? C.blue : 'transparent'}`,
        transition: 'background 0.1s, border-color 0.1s',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
        <span style={{
          fontSize: 12, fontWeight: 750, color: active ? C.blue : C.text,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{label}</span>
        {badge}
      </div>
      {sub && <div style={{ marginTop: 3, fontSize: 10, color: C.text3, fontFamily: FONT_MONO }}>{sub}</div>}
      {children && <div style={{ marginTop: 5 }}>{children}</div>}
    </button>
  );
}

function SectionHead({ children }) {
  return (
    <div style={{
      padding: '8px 12px 5px',
      fontSize: 9, fontWeight: 850, letterSpacing: '0.10em',
      textTransform: 'uppercase', color: C.text3,
      borderBottom: `1px solid ${C.border2}`,
    }}>{children}</div>
  );
}

function EmptyState({ title, hint }) {
  return (
    <div style={{ padding: '40px 24px', textAlign: 'center' }}>
      <div style={{ fontSize: 13, fontWeight: 800, color: C.text }}>{title}</div>
      <div style={{ fontSize: 11, color: C.text3, marginTop: 6, lineHeight: 1.5 }}>{hint}</div>
    </div>
  );
}

function WizLabel({ children }) {
  return <div style={{ fontSize: 10, fontWeight: 700, color: C.text3, textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 4 }}>{children}</div>;
}
function WizField({ label, value, onChange, type = 'text', placeholder = '' }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <WizLabel>{label}</WizLabel>
      <input type={type} value={value} placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        style={{ height: 28, borderRadius: 6, border: `1px solid ${C.border}`, background: C.bg, color: C.text, padding: '0 8px', fontSize: 12, fontFamily: 'inherit', outline: 'none' }} />
    </label>
  );
}
function WizSelect({ label, value, onChange, options = [] }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <WizLabel>{label}</WizLabel>
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{ height: 28, borderRadius: 6, border: `1px solid ${C.border}`, background: C.bg, color: C.text, padding: '0 8px', fontSize: 12, fontFamily: 'inherit', outline: 'none' }}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

// ── main component ────────────────────────────────────────────────────────────
export default function ResearchTab({ toast }) {
  const [archive, setArchive]         = useState(null);
  const [studies, setStudies]         = useState([]);
  const [selectedId, setSelectedId]   = useState(ARCHIVE_SCOPE);
  const [study, setStudy]             = useState(null);
  const [table, setTable]             = useState(ARCHIVE_DEFAULT_TABLE);
  const [rows, setRows]               = useState([]);
  const [columns, setColumns]         = useState([]);
  const [loading, setLoading]           = useState(false);
  const [initialLoading, setInitialLoading] = useState(true); // chỉ true lần đầu load trang
  const [tableLoading, setTableLoading] = useState(false);
  const [busy, setBusy]                 = useState(false);
  const [showWizard, setShowWizard]         = useState(false);
  const [wizardStep, setWizardStep]         = useState(1); // 1=info, 2=filter+preview, 3=review
  const [analysisPresets, setAnalysisPresets] = useState([]);
  const [wizardForm, setWizardForm]         = useState({ name: '', description: '', analysis_config: { preset: 'general', custom_fields: [] } });
  const [wizardFilters, setWizardFilters]   = useState({
    tuoiMin: '', tuoiMax: '', gioi: '',
    xnList: [],    // [{ ten, min, max }]
    cdhaList: [],  // [string]
    chanDoan: '',
  });
  const [wizardRows, setWizardRows]         = useState([]); // preview rows từ archive
  const [wizardCols, setWizardCols]         = useState([]);
  const [wizardLoadingPreview, setWizardLoadingPreview] = useState(false);
  const [wizardExcluded, setWizardExcluded] = useState(new Set()); // Mã NC bị loại
  const [editMode, setEditMode]             = useState(false); // chế độ sửa danh sách mẫu
  const [deleteConfirm, setDeleteConfirm]   = useState(null); // studyId cần xác nhận xóa
  const [filters, setFilters]         = useState({ q: '', patient: '', from: '', to: '', hideSensitive: true });
  const [archiveOptions, setArchiveOptions] = useState(() => ({ headless: true, fromDate: '2026-01-01', toDate: todayInputDate() }));
  const [studyOptions, setStudyOptions]     = useState({ headless: true });
  const [showLog, setShowLog]               = useState(false);
  const [logLines, setLogLines]             = useState([]);
  const [caseTraces, setCaseTraces]         = useState([]);
  const [caseTraceRedact, setCaseTraceRedact] = useState(true);
  const [logLoading, setLogLoading]         = useState(false);
  const [coverage, setCoverage]             = useState(null);
  const [statusRows, setStatusRows]         = useState([]);
  const [progressSnapshot, setProgressSnapshot] = useState(null);
  const [statusLoading, setStatusLoading]   = useState(false);
  const [lastUpdateSummary, setLastUpdateSummary] = useState(null);
  const [archiveMode, setArchiveMode]       = useState('overview'); // overview | update | patient | variables
  const [generalOverview, setGeneralOverview] = useState(null);
  const [generalOverviewLoading, setGeneralOverviewLoading] = useState(false);
  const [generalOverviewQuery, setGeneralOverviewQuery] = useState('');
  const [generalOverviewMissingOnly, setGeneralOverviewMissingOnly] = useState(false);
  const [researchError, setResearchError] = useState('');
  const [patientHistoryError, setPatientHistoryError] = useState('');
  const [patientHistoryMeta, setPatientHistoryMeta] = useState(null);
  const [automationRun, setAutomationRun] = useState({ kind: '', status: 'idle', current: '', steps: [], error: '', warning: '' });
  const [patientQuery, setPatientQuery]     = useState('');
  const [patientHistory, setPatientHistory] = useState(null);
  const [patientHistoryLoading, setPatientHistoryLoading] = useState(false);
  const [variableCatalog, setVariableCatalog] = useState(null);
  const [variableCatalogLoading, setVariableCatalogLoading] = useState(false);
  const [variableCatalogError, setVariableCatalogError] = useState('');
  const [variableQuery, setVariableQuery]   = useState('');
  const [variableGroupFilter, setVariableGroupFilter] = useState('admin');
  const [variableTypeFilter, setVariableTypeFilter] = useState('all');
  const [variableFillFilter, setVariableFillFilter] = useState('all');
  const [showTechnicalVariables, setShowTechnicalVariables] = useState(false);
  const [selectedVariableIds, setSelectedVariableIds] = useState(() => new Set());
  const [variableAggregations, setVariableAggregations] = useState({});
  const [variableConditions, setVariableConditions] = useState([]);
  const [variableStudyDraft, setVariableStudyDraft] = useState({ name: '', description: '' });

  // Dùng ref cho toast để tránh callback recreation mỗi khi parent re-render
  const toastRef = useRef(toast);
  const summaryPollRef = useRef(0);
  const errorToastRef = useRef({ message: '', at: 0 });
  const variableCatalogAutoKeyRef = useRef('');
  useEffect(() => { toastRef.current = toast; }, [toast]);
  const t = useCallback((msg, type) => toastRef.current?.(msg, type), []);
  const showErrorOnce = useCallback((err, cooldownMs = 8000) => {
    const msg = String(err?.message || err || 'Có lỗi không xác định.');
    const now = Date.now();
    if (errorToastRef.current.message === msg && now - errorToastRef.current.at < cooldownMs) return;
    errorToastRef.current = { message: msg, at: now };
    setResearchError(msg);
    t(msg, 'error');
  }, [t]);

  const isArchive = selectedId === ARCHIVE_SCOPE;

  // ── api calls ─────────────────────────────────────────────────────────────
  // loadSummary: cập nhật sidebar/metadata, KHÔNG set loading (không xóa bảng)
  const loadSummary = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    try {
      const [archiveRes, studiesRes] = await Promise.all([
        api.getResearchArchive(),
        api.listResearchStudies(),
      ]);
      const list = Array.isArray(studiesRes.studies) ? studiesRes.studies : [];
      setArchive(archiveRes.archive || null);
      if (archiveRes.archive) {
        const today = todayInputDate();
        const savedToDate = text(archiveRes.archive.scan_to_date);
        setArchiveOptions(prev => ({
          ...prev,
          fromDate: archiveRes.archive.scan_from_date || prev.fromDate || '2026-01-01',
          // Khoảng quét mặc định luôn mở rộng tới hôm nay; metadata cũ không được kéo lùi về ngày cũ.
          toDate:   savedToDate && savedToDate > today ? savedToDate : today,
        }));
      }
      setStudies(list);
      if (selectedId !== ARCHIVE_SCOPE && !list.some(s => s.id === selectedId)) setSelectedId(ARCHIVE_SCOPE);
    } catch (e) { showErrorOnce(e); }
    finally { if (showSpinner) setLoading(false); }
  }, [selectedId, showErrorOnce]);

  // loadTable: load dữ liệu bảng — giữ rows cũ trong lúc chờ, chỉ fade nhẹ
  const loadTable = useCallback(async (scopeId = selectedId, tableKey = table) => {
    setTableLoading(true);
    try {
      if (scopeId === ARCHIVE_SCOPE) {
        const r = await api.getResearchArchiveData({ table: tableKey, runId: 'latest', redact: filters.hideSensitive });
        setArchive(r.archive || null); setStudy(null);
        setRows(sortRowsForDisplay(tableKey, Array.isArray(r.rows) ? r.rows : []));
        setColumns(Array.isArray(r.columns) ? r.columns : []);
      } else {
        const r = await api.getResearchData(scopeId, { table: tableKey, runId: 'latest', redact: filters.hideSensitive });
        setStudy(r.study || null);
        setRows(sortRowsForDisplay(tableKey, Array.isArray(r.rows) ? r.rows : []));
        setColumns(Array.isArray(r.columns) ? r.columns : []);
      }
    } catch (e) {
      showErrorOnce(e);
      setRows([]); setColumns([]);
    } finally {
      setTableLoading(false);
      setInitialLoading(false); // sau lần load đầu tiên, không bao giờ xóa trắng nữa
    }
  }, [selectedId, table, filters.hideSensitive, showErrorOnce]);

  const loadCoverage = useCallback(async (scopeId = selectedId) => {
    try {
      const r = scopeId === ARCHIVE_SCOPE
        ? await api.getResearchArchiveCoverage({ runId: 'latest' })
        : await api.getResearchStudyCoverage(scopeId, { runId: 'latest' });
      setCoverage(r.coverage || null);
    } catch (_) {
      setCoverage(null);
    }
  }, [selectedId]);

  const loadGeneralOverview = useCallback(async (scopeId = selectedId, { silent = false } = {}) => {
    if (!silent) setGeneralOverviewLoading(true);
    try {
      const fetchTable = tableKey => (
        scopeId === ARCHIVE_SCOPE
          ? api.getResearchArchiveData({ table: tableKey, runId: 'latest', redact: filters.hideSensitive })
          : api.getResearchData(scopeId, { table: tableKey, runId: 'latest', redact: filters.hideSensitive })
      );
      const fetchProgress = () => (
        scopeId === ARCHIVE_SCOPE
          ? api.getResearchArchiveProgress({ runId: 'latest' })
          : api.getResearchStudyProgress(scopeId, { runId: 'latest' })
      );
      const fetchCoverage = () => (
        scopeId === ARCHIVE_SCOPE
          ? api.getResearchArchiveCoverage({ runId: 'latest' })
          : api.getResearchStudyCoverage(scopeId, { runId: 'latest' })
      );

      // Dùng cùng một snapshot backend cho số lượng và dùng extract_status đầy đủ
      // cho bảng theo dõi. Không trộn rows.length của dữ liệu đã redact với metadata.
      const [patientRes0, encounterRes, statusRes, progressRes, coverageRes] = await Promise.all([
        fetchTable('patient_master'),
        fetchTable('encounters'),
        fetchTable('extract_status'),
        fetchProgress(),
        fetchCoverage(),
      ]);
      let patientRes = patientRes0;
      if (!Array.isArray(patientRes?.rows) || !patientRes.rows.length) {
        patientRes = await fetchTable(scopeId === ARCHIVE_SCOPE ? 'initial_list' : 'cohort');
      }

      const nextProgress = progressRes?.progress || null;
      const nextCoverage = coverageRes?.coverage || null;
      const sourceMeta = scopeId === ARCHIVE_SCOPE ? archive : study;
      setProgressSnapshot(nextProgress);
      setCoverage(nextCoverage);
      setGeneralOverview(buildGeneralOverviewModel({
        patientRows: Array.isArray(patientRes?.rows) ? patientRes.rows : [],
        encounterRows: Array.isArray(encounterRes?.rows) ? encounterRes.rows : [],
        statusRows: Array.isArray(statusRes?.rows) ? statusRes.rows : [],
        coverage: nextCoverage,
        progressSnapshot: nextProgress,
        source: sourceMeta,
        isArchive: scopeId === ARCHIVE_SCOPE,
        limited: Boolean(patientRes?.limited || encounterRes?.limited || statusRes?.limited),
        patientCount: Number(patientRes?.count || 0),
        encounterCount: Number(encounterRes?.count || 0),
      }));
    } catch (e) {
      setGeneralOverview(null);
      showErrorOnce(e);
    } finally {
      if (!silent) setGeneralOverviewLoading(false);
    }
  }, [selectedId, filters.hideSensitive, archive, study, showErrorOnce]);

  const loadStatusRows = useCallback(async (scopeId = selectedId, { silent = false } = {}) => {
    if (!silent) setStatusLoading(true);
    try {
      const r = scopeId === ARCHIVE_SCOPE
        ? await api.getResearchArchiveData({ table: 'extract_status', runId: 'latest' })
        : await api.getResearchData(scopeId, { table: 'extract_status', runId: 'latest' });
      const nextRows = Array.isArray(r.rows) ? r.rows : [];
      setStatusRows(nextRows);
      return nextRows;
    } catch (_) {
      setStatusRows([]);
      return [];
    } finally {
      if (!silent) setStatusLoading(false);
    }
  }, [selectedId]);

  const loadProgressSnapshot = useCallback(async (scopeId = selectedId, { silent = false } = {}) => {
    if (!silent) setStatusLoading(true);
    try {
      const r = scopeId === ARCHIVE_SCOPE
        ? await api.getResearchArchiveProgress({ runId: 'latest' })
        : await api.getResearchStudyProgress(scopeId, { runId: 'latest' });
      const next = r.progress || null;
      setProgressSnapshot(next);
      return next;
    } catch (e) {
      setProgressSnapshot(null);
      if (!silent) showErrorOnce(e);
      return null;
    } finally {
      if (!silent) setStatusLoading(false);
    }
  }, [selectedId]);

  const reloadCurrentView = useCallback(async () => {
    await loadSummary(true);
    await loadProgressSnapshot(selectedId, { silent: true });
    if (selectedId === ARCHIVE_SCOPE) {
      if (archiveMode === 'overview') await loadGeneralOverview(selectedId);
      return;
    }
    await Promise.all([loadTable(selectedId, table), loadCoverage(selectedId)]);
  }, [loadSummary, loadTable, loadCoverage, loadGeneralOverview, loadProgressSnapshot, selectedId, table, archiveMode]);

  const loadPatientHistory = useCallback(async (queryOverride = '') => {
    const q = typeof queryOverride === 'string' && text(queryOverride) ? text(queryOverride) : text(patientQuery);
    if (!q) { showErrorOnce('Nhập tên, mã BN, mã NC hoặc chẩn đoán để tra cứu.'); return; }
    if (q.length < 2) { showErrorOnce('Từ khóa tra cứu quá ngắn. Nhập ít nhất 2 ký tự.'); return; }
    setPatientHistoryLoading(true);
    setPatientHistoryError('');
    setResearchError('');
    const started = Date.now();
    try {
      const request = api.getResearchArchivePatientHistory({ q, runId: 'latest' });
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Tra cứu quá 20 giây. Hãy thử bằng mã BN/mã NC cụ thể; nếu vẫn chậm, xem Log.')), 20000));
      const r = await Promise.race([request, timeout]);
      setPatientHistory(r);
      setPatientHistoryMeta({
        elapsedMs: Number(r?.request_ms || r?.elapsed_ms || (Date.now() - started)),
        source: r?.data_source || '',
        truncated: Boolean(r?.truncated),
        matched: Number(r?.matched_before_limit || r?.total_matches || 0),
      });
      if (r?.selection_required) {
        setPatientHistoryError('');
      } else if (!r?.patients?.length) {
        const msg = 'Không tìm thấy người bệnh trong kho hiện tại.';
        setPatientHistoryError(msg);
      }
    } catch (e) {
      const msg = String(e?.message || e || 'Tra cứu thất bại.');
      setPatientHistoryError(msg);
      showErrorOnce(msg);
    } finally { setPatientHistoryLoading(false); }
  }, [patientQuery, showErrorOnce]);

  const loadVariableCatalog = useCallback(async (options = {}) => {
    const silentError = Boolean(options?.silentError);
    setVariableCatalogLoading(true);
    setVariableCatalogError('');
    try {
      const r = await api.getResearchArchiveVariableCatalog({ runId: 'latest' });
      setVariableCatalog(r.catalog || null);
      setVariableCatalogError('');
    } catch (e) {
      const msg = String(e?.message || e || 'Không tải được danh mục biến.');
      setVariableCatalog(null);
      setVariableCatalogError(msg);
      if (!silentError) showErrorOnce(e);
    }
    finally { setVariableCatalogLoading(false); }
  }, [showErrorOnce]);

  useEffect(() => {
    if (!(isArchive && archiveMode === 'variables')) return;
    const runKey = `archive:${archive?.latest_run?.id || 'latest'}`;
    if (variableCatalogAutoKeyRef.current === runKey) return;
    if (!variableCatalogLoading) {
      variableCatalogAutoKeyRef.current = runKey;
      loadVariableCatalog({ silentError: true });
    }
  }, [isArchive, archiveMode, archive?.latest_run?.id, variableCatalogLoading, loadVariableCatalog]);


  useEffect(() => { loadSummary(true); }, []); // eslint-disable-line
  useEffect(() => {
    const ids = tableIdsForScope(selectedId === ARCHIVE_SCOPE);
    if (!ids.includes(table)) { setTable(defaultTableForScope(selectedId === ARCHIVE_SCOPE)); return; }
    loadProgressSnapshot(selectedId, { silent: true });
    if (selectedId === ARCHIVE_SCOPE) {
      setTableLoading(false);
      setInitialLoading(false);
      return;
    }
    loadTable(selectedId, table);
    loadCoverage(selectedId);
  }, [selectedId, table, archiveMode]); // eslint-disable-line

  useEffect(() => {
    if (!(isArchive && archiveMode === 'overview')) return;
    loadGeneralOverview(ARCHIVE_SCOPE, { silent: true });
    // Chỉ tự tải khi đổi run hoặc đổi chế độ ẩn định danh.
    // Không phụ thuộc identity của callback để tránh vòng tải lại khi summary auto-poll cập nhật object archive.
  }, [isArchive, archiveMode, archive?.latest_run?.id, filters.hideSensitive]); // eslint-disable-line

  // Auto-poll: progress cần realtime, summary thì chậm hơn để không tự tạo 429 khi task dài.
  useEffect(() => {
    const runIsActive = archive?.latest_run?.id && (
      archive?.latest_run?.done_patients < archive?.latest_run?.patients_count ||
      archive?.latest_run?.patients_count === 0
    );
    const taskIsActive = Boolean(progressSnapshot?.active_task && ['queued', 'running'].includes(String(progressSnapshot.active_task.status || '').toLowerCase()));
    const active = busy || runIsActive || taskIsActive;
    const intervalMs = active ? 2500 : 15000;
    const tid = setInterval(() => {
      loadProgressSnapshot(selectedId, { silent: true });
      const now = Date.now();
      if (active && now - summaryPollRef.current > 10000) {
        summaryPollRef.current = now;
        loadSummary(false);
      }
    }, intervalMs);
    return () => clearInterval(tid);
  }, [busy, archive, progressSnapshot?.active_task?.status, selectedId, loadSummary, loadProgressSnapshot]);

  const activeStudy  = useMemo(() => studies.find(s => s.id === selectedId) || study, [studies, selectedId, study]);
  const activeSource = isArchive ? archive : activeStudy;
  const latest       = activeSource?.latest_run || null;
  const operationSnapshot = useMemo(
    () => progressSnapshot || summarizeStatusRows(statusRows, activeSource, coverage, isArchive),
    [progressSnapshot, statusRows, activeSource, coverage, isArchive]
  );
  const remoteTaskActive = Boolean(operationSnapshot?.active_task && ['queued', 'running'].includes(String(operationSnapshot.active_task.status || '').toLowerCase()));
  const uiBusy = busy || remoteTaskActive;

  const filteredRows = useMemo(() => {
    const q       = lower(filters.q);
    const patient = lower(filters.patient);
    const from    = filters.from ? new Date(`${filters.from}T00:00:00`) : null;
    const to      = filters.to   ? new Date(`${filters.to}T23:59:59`)   : null;
    return rows.filter(row => {
      if (q && !lower(columns.map(c => row?.[c]).join(' ')).includes(q)) return false;
      if (patient) {
        const codes = lower([pick(row, ['Mã NC','Ma NC','research_code']), pick(row, ['Mã BN','Ma BN','MABN','patient_code'])].join(' '));
        if (!codes.includes(patient)) return false;
      }
      return rowInDateRange(row, columns, from, to);
    });
  }, [rows, columns, filters]);

  const visibleColumns = useMemo(
    () => filters.hideSensitive ? columns.filter(c => !SENSITIVE_COLUMNS.has(c)) : columns,
    [columns, filters.hideSensitive]
  );

  // ── Wizard helpers ────────────────────────────────────────────────────────
  const openWizard = () => {
    setWizardStep(1);
    setWizardForm({ name: '', description: '', analysis_config: { preset: 'general', custom_fields: [] } });
    setWizardFilters({ tuoiMin:'', tuoiMax:'', gioi:'', xnList:[], cdhaList:[], chanDoan:'' });
    setWizardRows([]); setWizardCols([]); setWizardExcluded(new Set());
    setShowWizard(true);
    // Load presets nếu chưa có
    if (!analysisPresets.length) {
      api.getAnalysisPresets().then(r => { if (r.presets) setAnalysisPresets(r.presets); }).catch(() => {});
    }
  };

  const loadWizardPreview = useCallback(async () => {
    setWizardLoadingPreview(true);
    try {
      // Dùng bảng phân tích đã chuẩn hóa làm nguồn chính để tạo nghiên cứu mới.
      // Bảng này đã gộp: BN + đợt điều trị + XN + CĐHA + phẫu thuật + hành chánh nếu đã nhập.
      let r = await api.getResearchArchiveData({ table: 'analysis_ready', runId: 'latest' });
      let merged = Array.isArray(r.rows) ? r.rows : [];
      if (!merged.length) {
        // Fallback khi kho chưa chuẩn hóa schema mới: dùng đợt điều trị + BN chuẩn.
        const enc = await api.getResearchArchiveData({ table: 'encounters', runId: 'latest' });
        const pat = await api.getResearchArchiveData({ table: 'patient_master', runId: 'latest' });
        const pMap = new Map((pat.rows || []).map(x => [x.patient_code || x['Mã BN'] || '', x]));
        merged = (enc.rows || []).map(row => ({ ...(pMap.get(row.patient_code || row['Mã BN'] || '') || {}), ...row }));
      }
      setWizardRows(merged);
      const colSet = new Set();
      for (const row of merged.slice(0, 200)) Object.keys(row || {}).forEach(k => colSet.add(k));
      setWizardCols(Array.from(colSet));
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setWizardLoadingPreview(false); }
  }, [t]);

  function wizardText(row, keys) {
    return keys.map(k => text(row?.[k])).filter(Boolean).join(' ');
  }
  function wizardNumber(row, keys) {
    for (const k of keys) {
      const raw = String(row?.[k] ?? '').replace(',', '.');
      const m = raw.match(/[-+]?\d+(?:\.\d+)?/);
      if (m) return Number(m[0]);
    }
    return NaN;
  }

  // Lọc wizard rows theo wizardFilters (lọc trên bảng phân tích đã gộp)
  const wizardFiltered = useMemo(() => {
    const f = wizardFilters;
    return wizardRows.filter(row => {
      const tuoi = wizardNumber(row, ['age', 'Tuổi', 'tuoi']);
      if (f.tuoiMin && (Number.isNaN(tuoi) || tuoi < Number(f.tuoiMin))) return false;
      if (f.tuoiMax && (Number.isNaN(tuoi) || tuoi > Number(f.tuoiMax))) return false;

      if (f.gioi) {
        const g = lower(wizardText(row, ['sex', 'GT', 'Giới', 'Giới tính']));
        if (!g.includes(lower(f.gioi))) return false;
      }

      if (f.chanDoan) {
        const cd = lower(wizardText(row, [
          'diagnosis_raw', 'admission_diagnosis', 'discharge_diagnosis', 'comorbidity_text', 'complication_text',
          'Chẩn đoán', 'Chan doan', 'chan_doan', 'diagnosis', 'imaging_summary',
        ]));
        if (!cd.includes(lower(f.chanDoan))) return false;
      }

      for (const xn of (f.xnList || [])) {
        if (!xn.ten) continue;
        const wanted = lower(xn.ten);
        const aliases = {
          hb: ['hb', 'hemoglobin', 'hgb'],
          hct: ['hct', 'hematocrit'],
          neutrophil: ['neutrophil', 'neu'],
          lymphocyte: ['lymphocyte', 'lym'],
          monocyte: ['monocyte', 'mono'],
          rdw: ['rdw'],
          plt: ['plt', 'platelet', 'tiểu cầu'],
        };
        const aliasList = aliases[wanted] || [wanted];
        const colKey = Object.keys(row).find(k => aliasList.some(a => lower(k).includes(lower(a))));
        const val = colKey ? wizardNumber(row, [colKey]) : NaN;
        if (xn.min && (Number.isNaN(val) || val < Number(xn.min))) return false;
        if (xn.max && (Number.isNaN(val) || val > Number(xn.max))) return false;
        if (!xn.min && !xn.max && Number.isNaN(val)) return false;
      }

      for (const cdha of (f.cdhaList || [])) {
        if (!cdha) continue;
        const cdhaText = lower(wizardText(row, ['imaging_summary', 'CĐHA', 'cdha', 'service_name_raw', 'conclusion_text', 'result_text']));
        if (!cdhaText.includes(lower(cdha))) return false;
      }
      return true;
    });
  }, [wizardRows, wizardFilters]);

  const wizardFinalRows = useMemo(
    () => wizardFiltered.filter(r => !wizardExcluded.has(r.encounter_id || r.research_code || r.patient_code || r['Mã NC'] || r['Mã BN'] || '')),
    [wizardFiltered, wizardExcluded]
  );

  const createStudyFromWizard = useCallback(async () => {
    const name = text(wizardForm.name);
    if (!name) { t('Cần nhập tên nghiên cứu.', 'error'); return; }
    if (!wizardFinalRows.length) { t('Danh sách mẫu rỗng.', 'error'); return; }
    setBusy(true);
    try {
      const r = await api.createResearchStudy({ name, description: wizardForm.description, analysis_config: wizardForm.analysis_config });
      const studyId = r.study?.id;
      if (!studyId) throw new Error('Không lấy được ID nghiên cứu.');
      await api.saveCohortFromFiltered(studyId, wizardFinalRows);
      await loadSummary();
      await loadCoverage(ARCHIVE_SCOPE);
      setSelectedId(studyId);
      setTable('cohort');
      setShowWizard(false);
      t(`Đã tạo nghiên cứu "${name}" với ${wizardFinalRows.length} BN.`, 'ok');
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [wizardForm, wizardFinalRows, loadSummary, toast]);

  const deleteStudy = useCallback(async (studyId) => {
    setBusy(true);
    try {
      const r = await api.deleteResearchStudy(studyId);
      t(r.message || 'Đã xóa nghiên cứu.', 'ok');
      await loadSummary();
      if (selectedId === studyId) { setSelectedId(ARCHIVE_SCOPE); setTable(ARCHIVE_DEFAULT_TABLE); setArchiveMode('overview'); }
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); setDeleteConfirm(null); }
  }, [selectedId, loadSummary, toast]);

  // Lưu cohort sau khi chỉnh sửa thủ công (editMode)
  const saveEditedCohort = useCallback(async () => {
    if (!activeStudy?.id) return;
    setBusy(true);
    try {
      await api.saveCohortFromFiltered(activeStudy.id, filteredRows);
      t('Đã lưu danh sách mẫu.', 'ok');
      setEditMode(false);
      await loadTable(activeStudy.id, 'cohort');
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [activeStudy, filteredRows, loadTable, toast]);

  const runArchive = useCallback(async (resume = true) => {
    setBusy(true);
    try {
      const today = todayInputDate();
      const options = { ...archiveOptions, toDate: archiveOptions.toDate || today };
      const r = await api.runResearchArchive({ ...options, resume, mode: 'initial' });
      t(r.message || 'Đã quét danh sách ban đầu.', 'ok');
      await loadSummary();
      setSelectedId(ARCHIVE_SCOPE); setArchiveMode('update');
      await loadProgressSnapshot(ARCHIVE_SCOPE, { silent: true });
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [archiveOptions, loadSummary, loadProgressSnapshot, t]);

  const runArchiveDeep = useCallback(async () => {
    setBusy(true);
    const beforeProgress = await loadProgressSnapshot(ARCHIVE_SCOPE, { silent: true });
    try {
      const today = todayInputDate();
      const options = { ...archiveOptions, toDate: archiveOptions.toDate || today };
      const r = await api.runResearchArchive({ ...options, resume: true, mode: 'deep', deep: true });
      t(r.message || 'Đã cập nhật dữ liệu gốc.', 'ok');
      await loadSummary();
      setSelectedId(ARCHIVE_SCOPE); setArchiveMode('update');
      const afterProgress = await loadProgressSnapshot(ARCHIVE_SCOPE, { silent: true });
      setLastUpdateSummary(diffProgressSnapshots(beforeProgress, afterProgress, 'Cập nhật XN & CĐHA'));
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [archiveOptions, loadSummary, loadTable, loadProgressSnapshot, toast]);

  const runPatientInfo = useCallback(async () => {
    setBusy(true);
    try {
      const options = isArchive
        ? { headless: archiveOptions.headless, fromDate: archiveOptions.fromDate, toDate: archiveOptions.toDate || todayInputDate() }
        : { headless: studyOptions.headless, fromDate: studyOptions.fromDate || archiveOptions.fromDate, toDate: studyOptions.toDate || archiveOptions.toDate || todayInputDate() };
      const r = isArchive
        ? await api.runResearchArchivePatientInfo(options)
        : await api.runResearchStudyPatientInfo(selectedId, options);
      t(r.message || 'Đã lấy thông tin khác.', 'ok');
      await loadSummary();
      await loadProgressSnapshot(selectedId, { silent: true });
      if (!isArchive) {
        setTable('patient_extra');
        await loadTable(selectedId, 'patient_extra');
      }
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [isArchive, selectedId, archiveOptions.headless, archiveOptions.fromDate, archiveOptions.toDate, studyOptions.headless, studyOptions.fromDate, studyOptions.toDate, loadSummary, loadTable, loadProgressSnapshot, t]);

  const runHchanhAuto = useCallback(async () => {
    setBusy(true);
    const scopeForStatus = isArchive ? ARCHIVE_SCOPE : selectedId;
    const beforeProgress = await loadProgressSnapshot(scopeForStatus, { silent: true });
    try {
      const options = isArchive
        ? { headless: archiveOptions.headless, fromDate: archiveOptions.fromDate, toDate: archiveOptions.toDate || todayInputDate(), files: ['profile', 'discharge', 'surgery'] }
        : { headless: studyOptions.headless, fromDate: studyOptions.fromDate || archiveOptions.fromDate, toDate: studyOptions.toDate || archiveOptions.toDate || todayInputDate(), files: ['profile', 'discharge', 'surgery'] };
      const r = isArchive
        ? await api.fetchHchanhForResearchArchive(options)
        : await api.fetchHchanhForResearchStudy(selectedId, options);
      t(r.message || 'Đã tự động lấy hành chánh từ EMR.', 'ok');
      await loadSummary();
      const afterProgress = await loadProgressSnapshot(scopeForStatus, { silent: true });
      setLastUpdateSummary(diffProgressSnapshots(beforeProgress, afterProgress, 'Cập nhật hồ sơ'));
      if (!isArchive) {
        setTable('analysis_ready');
        await loadTable(selectedId, 'analysis_ready');
      }
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [isArchive, selectedId, archiveOptions.headless, archiveOptions.fromDate, archiveOptions.toDate, studyOptions.headless, studyOptions.fromDate, studyOptions.toDate, loadSummary, loadTable, loadProgressSnapshot, t]);

  const runOrderHistoryAuto = useCallback(async () => {
    setBusy(true);
    const scopeForStatus = isArchive ? ARCHIVE_SCOPE : selectedId;
    const beforeProgress = await loadProgressSnapshot(scopeForStatus, { silent: true });
    try {
      const options = isArchive
        ? { headless: archiveOptions.headless, fromDate: archiveOptions.fromDate, toDate: archiveOptions.toDate || todayInputDate(), files: ['order_history'] }
        : { headless: studyOptions.headless, fromDate: studyOptions.fromDate || archiveOptions.fromDate, toDate: studyOptions.toDate || archiveOptions.toDate || todayInputDate(), files: ['order_history'] };
      const r = isArchive
        ? await api.fetchOrderHistoryForResearchArchive(options)
        : await api.fetchOrderHistoryForResearchStudy(selectedId, options);
      t(r.message || 'Đã tự động lấy lịch sử y lệnh từ EMR.', 'ok');
      await loadSummary();
      const afterProgress = await loadProgressSnapshot(scopeForStatus, { silent: true });
      setLastUpdateSummary(diffProgressSnapshots(beforeProgress, afterProgress, 'Cập nhật y lệnh'));
      if (!isArchive) {
        setTable('medication_orders');
        await loadTable(selectedId, 'medication_orders');
      }
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [isArchive, selectedId, archiveOptions.headless, archiveOptions.fromDate, archiveOptions.toDate, studyOptions.headless, studyOptions.fromDate, studyOptions.toDate, loadSummary, loadTable, loadProgressSnapshot, t]);

  // Gộp hành chánh + y lệnh thành 1 lần fetch
  const runHchanhAll = useCallback(async () => {
    setBusy(true);
    const scopeForStatus = isArchive ? ARCHIVE_SCOPE : selectedId;
    const beforeProgress = await loadProgressSnapshot(scopeForStatus, { silent: true });
    try {
      const r = isArchive
        ? await api.fetchHchanhAllForResearchArchive({ headless: archiveOptions.headless, fromDate: archiveOptions.fromDate, toDate: archiveOptions.toDate || todayInputDate() })
        : await api.fetchHchanhAllForResearchStudy(selectedId, { headless: studyOptions.headless, fromDate: studyOptions.fromDate || archiveOptions.fromDate, toDate: studyOptions.toDate || archiveOptions.toDate || todayInputDate() });
      t(r.message || 'Đã lấy hành chánh + y lệnh.', 'ok');
      await loadSummary();
      const afterProgress = await loadProgressSnapshot(scopeForStatus, { silent: true });
      setLastUpdateSummary(diffProgressSnapshots(beforeProgress, afterProgress, 'Cập nhật hồ sơ + y lệnh'));
      if (!isArchive) {
        setTable('analysis_ready');
        await loadTable(selectedId, 'analysis_ready');
      }
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [isArchive, selectedId, archiveOptions.headless, archiveOptions.fromDate, archiveOptions.toDate, studyOptions.headless, studyOptions.fromDate, studyOptions.toDate, loadSummary, loadTable, loadProgressSnapshot, t]);



  // Bổ sung phần thiếu — đọc extract_status, chỉ xử lý BN còn pending/error
  const [showMissingPanel, setShowMissingPanel] = useState(false);
  const [missingTypes, setMissingTypes] = useState(['profile', 'discharge', 'surgery', 'order_history', 'xn_cdha']);

  // Panel sửa analysis config cho study đang chọn
  const [showConfigPanel, setShowConfigPanel] = useState(false);
  const [editConfig, setEditConfig] = useState({ preset: 'general', custom_fields: [] });
  const openConfigPanel = useCallback(() => {
    const cur = activeStudy?.analysis_config || { preset: 'general', custom_fields: [] };
    setEditConfig({ preset: cur.preset || 'general', custom_fields: Array.isArray(cur.custom_fields) ? [...cur.custom_fields] : [] });
    if (!analysisPresets.length) {
      api.getAnalysisPresets().then(r => { if (r.presets) setAnalysisPresets(r.presets); }).catch(() => {});
    }
    setShowConfigPanel(true);
  }, [activeStudy, analysisPresets]);
  const saveAnalysisConfig = useCallback(async () => {
    if (!selectedId || isArchive) return;
    setBusy(true);
    try {
      const r = await api.updateStudyAnalysisConfig(selectedId, editConfig);
      t(r.message || 'Đã cập nhật cấu hình phân tích.', 'ok');
      setShowConfigPanel(false);
      await loadSummary();
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [selectedId, isArchive, editConfig, loadSummary, toast]);
  const runRefetchMissing = useCallback(async () => {
    if (!missingTypes.length) { t('Chọn ít nhất 1 loại dữ liệu cần lấy lại.', 'error'); return; }
    setBusy(true);
    const scopeForStatus = isArchive ? ARCHIVE_SCOPE : selectedId;
    const beforeProgress = await loadProgressSnapshot(scopeForStatus, { silent: true });
    try {
      const scope = isArchive ? ARCHIVE_API_SCOPE : selectedId;
      const options = isArchive
        ? { scope, missingTypes, headless: archiveOptions.headless, fromDate: archiveOptions.fromDate, toDate: archiveOptions.toDate || todayInputDate() }
        : { scope, missingTypes, headless: studyOptions.headless, fromDate: studyOptions.fromDate || archiveOptions.fromDate, toDate: studyOptions.toDate || archiveOptions.toDate || todayInputDate() };
      const r = await api.refetchMissingResearch(options);
      t(r.message || 'Đã lấy lại chỗ thiếu.', 'ok');
      setShowMissingPanel(false);
      await loadSummary();
      const afterProgress = await loadProgressSnapshot(scopeForStatus, { silent: true });
      setLastUpdateSummary(diffProgressSnapshots(beforeProgress, afterProgress, 'Bổ sung phần thiếu'));
      if (!isArchive) {
        setTable(primaryTableAfterRun(isArchive));
        await loadTable(selectedId, primaryTableAfterRun(isArchive));
      }
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [isArchive, selectedId, missingTypes, archiveOptions.headless, archiveOptions.fromDate, archiveOptions.toDate, studyOptions.headless, studyOptions.fromDate, studyOptions.toDate, loadSummary, loadTable, loadProgressSnapshot, t]);

  const runStudyData = useCallback(async (resume = true) => {
    if (isArchive || !selectedId) return;
    setBusy(true);
    const beforeProgress = await loadProgressSnapshot(selectedId, { silent: true });
    try {
      const r = await api.runResearchStudy(selectedId, { ...studyOptions, resume });
      t(r.message || 'Đã lấy XN/CĐHA cho nghiên cứu.', 'ok');
      await loadSummary();
      setTable('analysis_ready');
      await loadTable(selectedId, 'analysis_ready');
      const afterProgress = await loadProgressSnapshot(selectedId, { silent: true });
      setLastUpdateSummary(diffProgressSnapshots(beforeProgress, afterProgress, 'Cập nhật XN & CĐHA'));
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [isArchive, selectedId, studyOptions, loadSummary, loadTable, loadProgressSnapshot, t]);

  const updateAutomationStep = useCallback((index, patch) => {
    setAutomationRun(prev => ({
      ...prev,
      steps: prev.steps.map((step, i) => i === index ? { ...step, ...patch } : step),
    }));
  }, []);

  const runAutomaticWorkflow = useCallback(async ({ kind, steps, successMessage }) => {
    setBusy(true);
    setResearchError('');
    setAutomationRun({
      kind,
      status: 'running',
      current: steps[0]?.label || '',
      steps: steps.map(step => ({ label: step.label, status: 'pending', detail: '' })),
      error: '',
      warning: '',
    });
    const warnings = [];
    try {
      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index];
        setAutomationRun(prev => ({ ...prev, current: step.label }));
        updateAutomationStep(index, { status: 'running', detail: '' });
        try {
          const result = await step.run();
          const wasCancelled = Boolean(result?.cancelled || result?.stopped);
          updateAutomationStep(index, {
            status: wasCancelled ? 'cancelled' : 'done',
            detail: text(result?.message || result?.summary?.message || ''),
          });
          if (wasCancelled) {
            const message = text(result?.message || 'Đã dừng theo yêu cầu. Có thể bấm Lấy dữ liệu/Cập nhật để chạy tiếp phần còn thiếu.');
            setAutomationRun(prev => ({
              ...prev,
              status: 'cancelled',
              current: '',
              warning: message,
            }));
            t(message, 'info');
            return;
          }
        } catch (error) {
          const message = String(error?.message || error || 'Không rõ lỗi');
          if (step.optional) {
            warnings.push(`${step.label}: ${message}`);
            updateAutomationStep(index, { status: 'warning', detail: message });
            continue;
          }
          updateAutomationStep(index, { status: 'error', detail: message });
          throw new Error(`${step.label}: ${message}`);
        }
      }
      setAutomationRun(prev => ({
        ...prev,
        status: warnings.length ? 'warning' : 'done',
        current: '',
        warning: warnings.join(' | '),
      }));
      t(warnings.length ? `${successMessage} Có ${warnings.length} cảnh báo cần xem.` : successMessage, warnings.length ? 'info' : 'ok');
    } catch (error) {
      const message = String(error?.message || error || 'Không rõ lỗi');
      setAutomationRun(prev => ({ ...prev, status: 'error', current: '', error: message }));
      setResearchError(message);
      t(message, 'error');
    } finally {
      await Promise.all([loadSummary(), loadProgressSnapshot(selectedId, { silent: true })]);
      if (selectedId !== ARCHIVE_SCOPE) await loadCoverage(selectedId);
      setBusy(false);
    }
  }, [loadCoverage, loadProgressSnapshot, loadSummary, selectedId, t, updateAutomationStep]);

  const runSimpleListScan = useCallback(async () => {
    if (!isArchive) {
      t('Quét danh sách chỉ thực hiện tại Kho dữ liệu gốc.', 'error');
      return;
    }
    const today = todayInputDate();
    const options = { ...archiveOptions, toDate: archiveOptions.toDate || today };
    await runAutomaticWorkflow({
      kind: 'scan',
      successMessage: 'Đã quét danh sách và cập nhật cơ sở dữ liệu.',
      steps: [
        {
          label: 'Quét danh sách người bệnh trên EMR',
          run: () => api.runResearchArchive({ ...options, resume: true, mode: 'initial' }),
        },
        {
          label: 'Chuẩn hóa danh sách và cập nhật SQLite',
          run: () => api.normalizeResearchArchive(),
        },
      ],
    });
    setSelectedId(ARCHIVE_SCOPE);
    setArchiveMode('update');
  }, [archiveOptions, isArchive, runAutomaticWorkflow, t]);

  const runSimpleDataCollection = useCallback(async () => {
    const today = todayInputDate();
    const scope = isArchive ? ARCHIVE_API_SCOPE : selectedId;
    const fromDate = isArchive ? archiveOptions.fromDate : (studyOptions.fromDate || archiveOptions.fromDate);
    const toDate = isArchive ? (archiveOptions.toDate || today) : (studyOptions.toDate || archiveOptions.toDate || today);
    const headless = isArchive ? archiveOptions.headless : studyOptions.headless;

    if (isArchive && !archive?.latest_run?.id) { showErrorOnce('Cần bấm Quét danh sách trước khi lấy dữ liệu.'); return; }
    if (!isArchive && !activeStudy?.has_cohort) { showErrorOnce('Nghiên cứu chưa có danh sách mẫu.'); return; }

    setResearchError('');
    const beforeProgress = await loadProgressSnapshot(selectedId, { silent: true });
    const moduleMap = new Map((beforeProgress?.modules || []).map(m => [m.key, m]));
    const missingTypes = ['xn_cdha', 'profile', 'discharge', 'surgery', 'order_history'].filter(key => {
      const m = moduleMap.get(key);
      if (!m) return true;
      return Number(m.done || 0) < Number(m.total || beforeProgress?.total || 0) || Number(m.error || 0) > 0 || Number(m.missing || 0) > 0 || Number(m.waiting || 0) > 0;
    });
    const hasProgress = Number(beforeProgress?.total || 0) > 0 && (Number(beforeProgress?.counts?.done || 0) + Number(beforeProgress?.counts?.error || 0) + Number(beforeProgress?.counts?.missing || 0) > 0);

    let steps = [];
    if (hasProgress) {
      if (missingTypes.length) {
        const labelMap = { xn_cdha: 'XN/CĐHA', profile: 'Hồ sơ nền', discharge: 'Ra viện', surgery: 'Phẫu thuật', order_history: 'Y lệnh' };
        steps.push({
          label: `Chỉ lấy phần còn thiếu: ${missingTypes.map(x => labelMap[x] || x).join(', ')}`,
          run: () => api.refetchMissingResearch({ scope, missingTypes, headless, fromDate, toDate }),
        });
      }
    } else if (isArchive) {
      steps.push(
        { label: 'Lấy XN và CĐHA', run: () => api.runResearchArchive({ headless, fromDate, toDate, resume: true, mode: 'deep', deep: true }) },
        { label: 'Lấy hồ sơ, ra viện, phẫu thuật và y lệnh', run: () => api.fetchHchanhAllForResearchArchive({ headless, fromDate, toDate }) },
        { label: 'Bổ sung thông tin hành chánh', run: () => api.runResearchArchivePatientInfo({ headless, fromDate, toDate }), optional: true },
      );
    } else {
      steps.push(
        { label: 'Lấy XN và CĐHA', run: () => api.runResearchStudy(selectedId, { ...studyOptions, headless, fromDate, toDate, resume: true }) },
        { label: 'Lấy hồ sơ, ra viện, phẫu thuật và y lệnh', run: () => api.fetchHchanhAllForResearchStudy(selectedId, { headless, fromDate, toDate }) },
        { label: 'Bổ sung thông tin hành chánh', run: () => api.runResearchStudyPatientInfo(selectedId, { headless, fromDate, toDate }), optional: true },
      );
    }

    // Nếu mọi module đã đủ, không mở Selenium. Chỉ bảo đảm SQLite/dataset hiện hành.
    steps.push(
      { label: 'Chuẩn hóa và cập nhật SQLite', run: () => isArchive ? api.normalizeResearchArchive() : api.normalizeResearchStudy(selectedId) },
      { label: 'Cập nhật mã danh mục phân tích', run: () => isArchive ? api.buildResearchArchiveEncodedDataset() : api.buildResearchStudyEncodedDataset(selectedId) },
      { label: 'Cập nhật dataset cuối', run: () => isArchive ? api.finalizeResearchArchiveDataset() : api.finalizeResearchStudyDataset(selectedId), optional: true },
    );

    await runAutomaticWorkflow({
      kind: 'collect',
      steps,
      successMessage: missingTypes.length && hasProgress
        ? 'Đã bổ sung phần còn thiếu và cập nhật SQLite.'
        : hasProgress
          ? 'Dữ liệu đã đủ; chỉ cập nhật SQLite và dataset.'
          : 'Đã lấy dữ liệu và cập nhật SQLite.',
    });
    const afterProgress = await loadProgressSnapshot(selectedId, { silent: true });
    setLastUpdateSummary(diffProgressSnapshots(beforeProgress, afterProgress, 'Lấy dữ liệu'));
  }, [
    activeStudy?.has_cohort, archive?.latest_run?.id, archiveOptions, isArchive,
    loadProgressSnapshot, runAutomaticWorkflow, selectedId, showErrorOnce, studyOptions,
  ]);

  const normalizeCurrent = useCallback(async () => {
    setBusy(true);
    try {
      const r = isArchive ? await api.normalizeResearchArchive() : await api.normalizeResearchStudy(selectedId);
      t(r.message || 'Đã chuẩn hóa dữ liệu.', 'ok');
      await loadSummary();
      await loadCoverage(selectedId);
      const next = primaryTableAfterRun(isArchive);
      await loadProgressSnapshot(selectedId, { silent: true });
      if (!isArchive) {
        setTable(next);
        await loadTable(selectedId, next);
      }
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [isArchive, selectedId, loadSummary, loadCoverage, loadTable, loadProgressSnapshot, t]);

  const finalizeDataset = useCallback(async () => {
    setBusy(true);
    try {
      const r = isArchive
        ? await api.finalizeResearchArchiveDataset()
        : await api.finalizeResearchStudyDataset(selectedId);
      t(r.message || 'Đã tạo dataset cuối.', 'ok');
      await loadSummary();
      await loadCoverage(selectedId);
      setTable('analysis_final');
      await loadTable(selectedId, 'analysis_final');
    } catch (e) {
      t(String(e.message || e), 'error');
      if (e?.coverage) setCoverage(e.coverage);
    } finally { setBusy(false); }
  }, [isArchive, selectedId, loadSummary, loadCoverage, loadTable, t]);


  const buildEncodedDataset = useCallback(async () => {
    setBusy(true);
    try {
      const r = isArchive
        ? await api.buildResearchArchiveEncodedDataset()
        : await api.buildResearchStudyEncodedDataset(selectedId);
      const added = r?.new_entries
        ? Object.values(r.new_entries).reduce((sum, n) => sum + Number(n || 0), 0)
        : 0;
      t(r.message || `Đã tạo dữ liệu encoded${added ? `, thêm ${added} mã mới vào dictionary.` : '.'}`, 'ok');
      await loadSummary();
      setTable('analysis_ready_encoded');
      await loadTable(selectedId, 'analysis_ready_encoded');
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [isArchive, selectedId, loadSummary, loadTable, t]);


  const cleanGeneratedData = useCallback(async () => {
    const ok = window.confirm('Dọn file phụ có thể tạo lại: encoded/, file debug hành chánh/y lệnh và log phụ. Dữ liệu gốc và dữ liệu chuẩn hóa sẽ được giữ nguyên. Tiếp tục?');
    if (!ok) return;
    setBusy(true);
    try {
      const r = isArchive
        ? await api.cleanResearchArchiveGenerated({ encoded: true, debug: true, derived: false })
        : await api.cleanResearchStudyGenerated(selectedId, { encoded: true, debug: true, derived: false });
      const mb = Number(r?.removed_bytes || 0) / 1024 / 1024;
      t(r.message || `Đã dọn file phụ${mb ? `, giảm khoảng ${mb.toFixed(1)} MB.` : '.'}`, 'ok');
      await loadSummary();
      const next = primaryTableAfterRun(isArchive);
      setTable(next);
      await loadTable(selectedId, next);
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [isArchive, selectedId, loadSummary, loadTable, t]);

  const loadLog = useCallback(async () => {
    setLogLoading(true);
    try {
      const [r, trace] = await Promise.all([
        isArchive
          ? api.getResearchArchiveLog({ runId: 'latest', lines: 800 })
          : api.getResearchStudyLog(selectedId, { runId: 'latest', lines: 800 }),
        isArchive
          ? api.getResearchArchiveCaseTrace({ runId: 'latest', limit: 10, redact: caseTraceRedact })
          : api.getResearchStudyCaseTrace(selectedId, { runId: 'latest', limit: 10, redact: caseTraceRedact }),
      ]);
      setLogLines(Array.isArray(r.lines) ? r.lines : []);
      setCaseTraces(Array.isArray(trace.cases) ? trace.cases : []);
    } catch (e) {
      setLogLines([`Lỗi: ${e.message}`]);
      setCaseTraces([]);
    }
    finally { setLogLoading(false); }
  }, [isArchive, selectedId, caseTraceRedact]);

  const exportCurrent = useCallback(async () => {
    if (!visibleColumns.length) { t('Không có dữ liệu để xuất.', 'error'); return; }
    const hasClientFilters = Boolean(filters.q || filters.patient || filters.from || filters.to);
    const safe = (isArchive ? 'du_lieu_goc' : selectedId || 'nghien_cuu').replace(/[^a-zA-Z0-9_-]+/g,'_');
    if (!filters.hideSensitive && hasClientFilters) {
      t('Không xuất dữ liệu định danh bằng bộ lọc phía trình duyệt vì thao tác đó không tạo audit đầy đủ. Hãy bỏ bộ lọc hoặc bật ẩn thông tin nhạy cảm.', 'error');
      return;
    }
    if (!hasClientFilters) {
      try {
        const r = isArchive
          ? await api.downloadResearchArchiveCsv({ table, runId: 'latest', redact: filters.hideSensitive })
          : await api.downloadResearchStudyCsv(selectedId, { table, runId: 'latest', redact: filters.hideSensitive });
        saveBlob(r.filename || `${safe}_${table}.csv`, r.blob);
        t(filters.hideSensitive ? 'Đã xuất toàn bộ CSV đã ẩn định danh.' : 'Đã xuất toàn bộ CSV từ server.', 'ok');
        return;
      } catch (e) {
        t(String(e.message || e), 'error');
        return;
      }
    }
    if (!filteredRows.length) { t('Không có dữ liệu để xuất.', 'error'); return; }
    downloadCsv(`${safe}_${table}_${new Date().toISOString().slice(0,10)}.csv`, visibleColumns, filteredRows);
    t(`Đã xuất ${compactNumber(filteredRows.length)} dòng đang lọc trên UI.`, 'ok');
  }, [filteredRows, visibleColumns, filters, isArchive, selectedId, table, t]);

  const dismissAlert = useCallback(async () => {
    try { await api.dismissFatalAlert(); await loadSummary(false); } catch (e) { t(String(e), 'error'); }
  }, [loadSummary]);

  const resetFilters = () => setFilters({ q: '', patient: '', from: '', to: '', hideSensitive: true });

  // ── derived counts for sidebar ────────────────────────────────────────────
  const archiveInitial = datasetCount(archive, 'initial_list', true);
  const archiveDeep    = datasetCount(archive, 'deep_source', true);

  const archiveAnalysis = datasetCount(archive, 'analysis_ready', true);
  const archiveEncounters = datasetCount(archive, 'encounters', true);
  const archivePatients = datasetCount(archive, 'patient_master', true);
  const allCatalogVariables = useMemo(() => (
    variableCatalog?.groups || []
  ).flatMap(g => (g.variables || []).map(v => enhanceCatalogVariable(v, g))), [variableCatalog]);
  const catalogGroupOptions = useMemo(() => {
    const counts = new Map();
    for (const v of allCatalogVariables) {
      if (!showTechnicalVariables && v.technical_or_identity) continue;
      const key = v.clinical_group_key || v.group_key || 'other';
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return VARIABLE_CLINICAL_GROUPS
      .map(g => ({ ...g, count: counts.get(g.key) || 0 }))
      .filter(g => g.count > 0 && (showTechnicalVariables || g.key !== 'technical'));
  }, [allCatalogVariables, showTechnicalVariables]);
  const filteredCatalogVariables = useMemo(() => {
    const q = lower(variableQuery);
    return allCatalogVariables.filter(v => {
      if (!showTechnicalVariables && v.technical_or_identity) return false;
      if (variableGroupFilter !== 'all' && v.clinical_group_key !== variableGroupFilter) return false;
      if (variableTypeFilter !== 'all' && v.type !== variableTypeFilter) return false;
      if (variableFillFilter === 'high' && Number(v.fill_rate || 0) < 80) return false;
      if (variableFillFilter === 'medium' && (Number(v.fill_rate || 0) < 30 || Number(v.fill_rate || 0) >= 80)) return false;
      if (variableFillFilter === 'low' && Number(v.fill_rate || 0) >= 30) return false;
      if (!q) return true;
      return lower(`${v.clinical_group_label} ${v.clinical_section} ${v.source_group_label} ${v.display_label} ${v.raw_name} ${v.description} ${v.type} ${v.role} ${v.sample_values?.map(x => x.value).join(' ')}`).includes(q);
    });
  }, [allCatalogVariables, variableQuery, variableGroupFilter, variableTypeFilter, variableFillFilter, showTechnicalVariables]);
  const filteredVariableSections = useMemo(() => groupVariablesBySection(filteredCatalogVariables), [filteredCatalogVariables]);
  const selectedVariables = useMemo(() => allCatalogVariables.filter(v => selectedVariableIds.has(v.id)), [allCatalogVariables, selectedVariableIds]);
  const selectedVariablesByGroup = useMemo(() => {
    const map = new Map();
    for (const v of selectedVariables) {
      const key = v.clinical_group_key || v.group_key || 'other';
      if (!map.has(key)) map.set(key, { label: v.clinical_group_label || v.group_label || 'Khác', variables: [] });
      map.get(key).variables.push(v);
    }
    return [...map.values()];
  }, [selectedVariables]);
  const toggleVariable = useCallback((id) => {
    setSelectedVariableIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const addConditionForVariable = useCallback((variable) => {
    if (!variable) return;
    setVariableConditions(prev => [...prev, { id: `${Date.now()}_${prev.length}`, variable_id: variable.id, label: `${variable.group_label || variable.table_label}.${variable.display_label || variable.name}`, operator: variable.operators?.[0] || 'contains', value: '', value2: '' }]);
    setSelectedVariableIds(prev => new Set([...prev, variable.id]));
  }, []);
  const buildVariableSpec = useCallback(() => ({
    schema_version: 1,
    source: 'research_archive',
    created_at: new Date().toISOString(),
    run_id: variableCatalog?.run_id || latest?.id || '',
    selected_variables: selectedVariables.map(v => ({
      id: v.id,
      table: v.table,
      table_label: v.group_label || v.table_label || '',
      name: v.name,
      label: v.display_label || v.name,
      type: v.type,
      role: v.role,
      virtual_kind: v.virtual_kind || '',
      source_filter: v.source_filter || null,
      aggregation: variableAggregations[v.id] || 'list',
    })),
    conditions: variableConditions.map(cond => {
      const variable = allCatalogVariables.find(v => v.id === cond.variable_id);
      return {
        ...cond,
        table: variable?.table || cond.table || '',
        name: variable?.name || cond.name || '',
        label: variable?.display_label || cond.label || '',
        type: variable?.type || cond.type || '',
        virtual_kind: variable?.virtual_kind || cond.virtual_kind || '',
        source_filter: variable?.source_filter || cond.source_filter || null,
      };
    }),
  }), [selectedVariables, variableAggregations, variableConditions, variableCatalog, latest, allCatalogVariables]);

  const exportVariableSpec = useCallback(() => {
    const spec = buildVariableSpec();
    const blob = new Blob([JSON.stringify(spec, null, 2)], { type: 'application/json;charset=utf-8' });
    saveBlob(`research_variable_spec_${new Date().toISOString().slice(0,10)}.json`, blob);
    t('Đã xuất danh sách biến và điều kiện dạng JSON.', 'ok');
  }, [buildVariableSpec, t]);

  const createStudyFromVariableSelection = useCallback(async () => {
    const name = text(variableStudyDraft.name);
    if (!name) { t('Nhập tên nghiên cứu trước khi tạo.', 'error'); return; }
    if (!selectedVariables.length) { t('Chọn ít nhất 1 biến cần lấy.', 'error'); return; }
    setBusy(true);
    try {
      const spec = buildVariableSpec();
      const payload = {
        name,
        description: variableStudyDraft.description,
        analysis_config: {
          preset: 'general',
          custom_fields: [],
          variable_selection: spec,
        },
        variable_selection: spec,
      };
      const r = await api.createResearchStudy(payload);
      const studyId = r.study?.id;
      if (!studyId) throw new Error('Không lấy được ID nghiên cứu.');
      let imported = 0;
      try {
        const imp = await api.importResearchFromArchive(studyId, {});
        imported = Number(imp?.count || 0);
      } catch (importErr) {
        t(`Đã tạo nghiên cứu, nhưng chưa nạp được danh sách mẫu: ${String(importErr.message || importErr)}`, 'error');
      }
      await loadSummary();
      setSelectedId(studyId);
      setTable('cohort');
      setArchiveMode('update');
      t(imported
        ? `Đã tạo nghiên cứu "${name}" và nạp ${compactNumber(imported)} dòng từ kho hiện tại.`
        : `Đã tạo nghiên cứu "${name}".`, 'ok');
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [variableStudyDraft, selectedVariables.length, buildVariableSpec, loadSummary, t]);


  // ── TABLE TAB GROUPS ──────────────────────────────────────────────────────
  const tabGroups = isArchive
    ? [
        { label: 'Kho gốc',  ids: ['initial_list','research_source','deep_source','patient_master','encounters','analysis_ready','analysis_selected','analysis_final'] },
        { label: 'Lâm sàng', ids: ['diagnoses','patient_day','lab_results','imaging_results','surgery_results'] },
        { label: 'Khác',     ids: ['medication_orders','clinical_notes','patient_extra'] },
      ]
    : [
        { label: 'Mẫu NC',    ids: ['cohort','research_source','patient_master','encounters','analysis_ready','analysis_selected','analysis_final'] },
        { label: 'Lâm sàng',  ids: ['diagnoses','patient_day','lab_results','imaging_results','surgery_results'] },
        { label: 'Khác',      ids: ['medication_orders','clinical_notes','patient_extra'] },
      ];

  const renderArchiveHome = () => (
    <div style={{ padding: '8px 12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <ResearchOperationDashboard
        snapshot={operationSnapshot}
        lastUpdate={lastUpdateSummary}
        loading={statusLoading}
        onRefresh={() => loadProgressSnapshot(selectedId, { silent: false })}
      />
    </div>
  );


  const overviewRows = useMemo(() => {
    const sourceRows = Array.isArray(generalOverview?.rows) ? generalOverview.rows : [];
    const q = lower(generalOverviewQuery);
    return sourceRows.filter(row => {
      if (generalOverviewMissingOnly && row.ready) return false;
      if (!q) return true;
      return [
        row.research_code, row.patient_code, row.patient_name, row.diagnosis,
        row.admission_date, row.discharge_date, row.status_label, row.missing_text,
      ].some(v => lower(v).includes(q));
    });
  }, [generalOverview, generalOverviewQuery, generalOverviewMissingOnly]);

  const renderGeneralOverview = () => {
    const ov = generalOverview;
    const summary = ov?.statusSummary || { total: 0, ready: 0, missingCount: 0, manualReview: 0, modules: [] };
    const counts = ov?.counts || {};
    const overviewCard = (label, value, sub = '') => (
      <div style={{ padding: '5px 14px 6px 0', minWidth: 120, borderRight: `1px solid ${C.border2}` }}>
        <div style={{ fontSize: 10, color: C.text3, fontWeight: 700 }}>{label}</div>
        <div style={{ marginTop: 1, fontSize: 21, lineHeight: 1.1, color: C.text, fontWeight: 850, letterSpacing: '-0.02em' }}>{compactNumber(value || 0)}</div>
        {sub && <div style={{ marginTop: 2, fontSize: 9.5, color: C.text3 }}>{sub}</div>}
      </div>
    );
    const miniStatus = (label, done, total) => {
      const pct = total ? Math.round(Number(done || 0) * 100 / Number(total || 1)) : 0;
      return (
        <div key={label} style={{ background: 'transparent', padding: '6px 0 7px', minWidth: 145 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: 11, color: C.text, fontWeight: 750 }}>{label}</span>
            <span style={{ fontSize: 10, color: pct >= 95 ? C.green : pct >= 70 ? C.blue : C.amber, fontWeight: 800 }}>{pct}%</span>
          </div>
          <div style={{ height: 4, marginTop: 7, background: C.surface2, borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.max(0, Math.min(100, pct))}%`, background: pct >= 95 ? C.green : pct >= 70 ? C.blue : C.amber }} />
          </div>
          <div style={{ marginTop: 5, fontSize: 10, color: C.text3 }}>{compactNumber(done)}/{compactNumber(total)} lượt đã đủ</div>
        </div>
      );
    };

    return (
      <div style={{ padding: '8px 12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ background: C.surface, padding: '8px 0 10px', borderBottom: `1px solid ${C.border2}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 850, color: C.text }}>Dữ liệu tổng quát</div>
              <div style={{ marginTop: 3, fontSize: 10.5, color: C.text3 }}>
                Chỉ đọc dữ liệu đã thu thập và chuẩn hóa; không chạy lại EMR.
                {ov?.date_from || ov?.date_to ? ` · Khoảng dữ liệu: ${ov?.date_from || '—'} → ${ov?.date_to || '—'}` : ''}
              </div>
            </div>
          </div>

          {!ov && generalOverviewLoading && (
            <div style={{ padding: '22px 0 8px', color: C.text2 }}><Spinner size={12} /> Đang tổng hợp dữ liệu...</div>
          )}
          {!ov && !generalOverviewLoading && (
            <EmptyState title="Chưa có dữ liệu tổng quát" hint="Bấm Quét danh sách, sau đó Lấy dữ liệu. Màn hình này sẽ tự đọc lại dữ liệu đã có." />
          )}

          {ov && (
            <>
              <div style={{ marginTop: 10, display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: C.text }}>Kho dữ liệu chuẩn hóa</div>
                <div style={{ fontSize: 10, color: C.text3 }}>Các số dưới đây được đếm từ cùng snapshot file hiện tại; không quét lại EMR.</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'stretch', gap: 14, flexWrap: 'wrap', marginTop: 6 }}>
                {overviewCard('Người bệnh', counts.patients, 'BN trong kho')}
                {overviewCard('Đợt điều trị', counts.encounters, 'lượt nhập viện')}
                {overviewCard('Xét nghiệm', counts.labs, 'kết quả')}
                {overviewCard('CĐHA', counts.imaging, 'kết quả')}
                {overviewCard('Dataset phân tích', counts.final_rows, 'dòng sẵn sàng')}
              </div>

              <div style={{ marginTop: 10 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexWrap: 'wrap', marginBottom: 6 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: C.text }}>Mức độ đầy đủ — đợt thu thập hiện tại</div>
                  <div style={{ fontSize: 10, color: C.text3 }}>
                    {generalOverview?.run_id ? `run ${generalOverview.run_id}` : ''} · mẫu số {compactNumber(summary.total || 0)} lượt
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', columnGap: 18, rowGap: 2 }}>
                  {(summary.modules || []).map(part => miniStatus(part.label, part.done, summary.total))}
                </div>
              </div>

              <div style={{ marginTop: 9, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <StatBadge label="Đủ dữ liệu" value={summary.counts?.done || summary.ready || 0} tone="ok" />
                <StatBadge label="Còn thiếu" value={summary.missingCount || 0} tone={(summary.missingCount || 0) ? 'warn' : 'neutral'} />
                <StatBadge label="Lỗi" value={summary.counts?.error || 0} tone={(summary.counts?.error || 0) ? 'danger' : 'neutral'} />
                <StatBadge label="Cần xem tay" value={summary.manualReview || 0} tone={(summary.manualReview || 0) ? 'danger' : 'neutral'} />
                {ov.limited && <span style={{ fontSize: 10, color: C.amber }}>Một số bảng lớn chỉ tải phần hiển thị; số tổng lấy từ metadata.</span>}
              </div>
            </>
          )}
        </div>

        {ov && (
          <div style={{ background: C.surface, borderTop: `1px solid ${C.border2}`, overflow: 'hidden' }}>
            <div style={{ padding: '8px 9px', borderBottom: `1px solid ${C.border2}`, display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 12, fontWeight: 850, color: C.text, marginRight: 5 }}>
                {ov.row_kind === 'monitor' ? 'Danh sách lượt đang theo dõi' : ov.row_kind === 'encounter' ? 'Danh sách đợt điều trị' : 'Danh sách người bệnh trong kho'}
              </div>
              <input
                value={generalOverviewQuery}
                onChange={e => setGeneralOverviewQuery(e.target.value)}
                placeholder="Tìm mã NC, mã BN, họ tên, chẩn đoán..."
                style={{ ...inp, flex: '1 1 260px' }}
              />
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: C.text2, whiteSpace: 'nowrap' }}>
                <input type="checkbox" checked={generalOverviewMissingOnly} onChange={e => setGeneralOverviewMissingOnly(e.target.checked)} />
                Chỉ xem còn thiếu/lỗi
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: C.text2, whiteSpace: 'nowrap' }}>
                <input type="checkbox" checked={filters.hideSensitive}
                  onChange={e => setFilters(p => ({ ...p, hideSensitive: e.target.checked }))} />
                Ẩn định danh
              </label>
              <span style={{ fontSize: 10, color: C.text3 }}>{compactNumber(overviewRows.length)}/{compactNumber(ov.rows?.length || 0)} {ov.row_unit || 'lượt'}</span>
            </div>

            <div style={{ maxHeight: 'calc(100vh - 430px)', overflow: 'auto' }}>
              {!overviewRows.length && <EmptyState title="Không có người bệnh phù hợp" hint="Thử bỏ bộ lọc hoặc tắt “Chỉ xem còn thiếu/lỗi”." />}
              {!!overviewRows.length && (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, tableLayout: 'fixed' }}>
                  <thead style={{ position: 'sticky', top: 0, background: C.surface2, zIndex: 2 }}>
                    <tr>
                      {[
                        ['Mã NC', 90], ['Mã BN', 90], ['Họ tên', 170], ['Ngày vào', 85], ['Ngày ra', 85],
                        ['Chẩn đoán', 260], ['XN', 52], ['CĐHA', 52], ['PT/TT', 52], ['YL', 52], ['Trạng thái', 120],
                      ].map(([label, width]) => (
                        <th key={label} style={{ width, textAlign: 'left', padding: '7px 8px', borderBottom: `1px solid ${C.border}`, color: C.text2, fontSize: 10.5, fontWeight: 800 }}>{label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {overviewRows.slice(0, 1000).map(row => {
                      const q = row.patient_code || row.research_code || row.patient_name;
                      return (
                        <tr key={row.key}
                          onClick={() => {
                            if (!q) return;
                            setPatientQuery(q);
                            setArchiveMode('patient');
                            loadPatientHistory(q);
                          }}
                          title={q ? 'Bấm để xem toàn bộ quá trình điều trị' : ''}
                          style={{ borderBottom: `1px solid ${C.border2}`, cursor: q ? 'pointer' : 'default' }}
                          onMouseEnter={e => { if (q) e.currentTarget.style.background = C.surface2; }}
                          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                        >
                          <td style={{ padding: '7px 8px', color: C.blue, fontWeight: 750, overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.research_code || '—'}</td>
                          <td style={{ padding: '7px 8px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.patient_code || '—'}</td>
                          <td style={{ padding: '7px 8px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.patient_name || '—'}</td>
                          <td style={{ padding: '7px 8px' }}>{row.admission_date || '—'}</td>
                          <td style={{ padding: '7px 8px' }}>{row.discharge_date || '—'}</td>
                          <td style={{ padding: '7px 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.diagnosis}>{row.diagnosis || '—'}</td>
                          <td style={{ padding: '7px 8px' }}>{row.lab_count ? compactNumber(row.lab_count) : (row.xn_done ? '✓' : '—')}</td>
                          <td style={{ padding: '7px 8px' }}>{row.imaging_count ? compactNumber(row.imaging_count) : (row.cdha_done ? '✓' : '—')}</td>
                          <td style={{ padding: '7px 8px' }}>{row.surgery_count ? compactNumber(row.surgery_count) : (row.surgery_done ? '✓' : '—')}</td>
                          <td style={{ padding: '7px 8px' }}>{row.medication_count ? compactNumber(row.medication_count) : (row.order_done ? '✓' : '—')}</td>
                          <td style={{ padding: '7px 8px' }}>
                            <span style={{
                              display: 'inline-flex', alignItems: 'center', height: 20, padding: '0 6px', borderRadius: 4,
                              fontSize: 10, fontWeight: 750,
                              color: row.status_tone === 'ok' ? C.green : row.status_tone === 'danger' ? C.red : row.status_tone === 'warn' ? C.amber : C.text3,
                              background: C.surface2, border: `1px solid ${C.border2}`,
                            }}>{row.status_label}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
            {overviewRows.length > 1000 && (
              <div style={{ padding: '7px 10px', fontSize: 10, color: C.text3, borderTop: `1px solid ${C.border2}` }}>
                Hiển thị 1.000 người bệnh đầu tiên sau lọc.
              </div>
            )}
          </div>
        )}
      </div>
    );
  };


  const renderPatientLookup = () => (
    <div style={{ padding: '10px 12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ background: C.surface, padding: '2px 0 10px', borderBottom: `1px solid ${C.border2}` }}>
        <div style={{ fontSize: 14, fontWeight: 850, color: C.text }}>Tra cứu người bệnh</div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <input value={patientQuery} onChange={e => setPatientQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') loadPatientHistory(); }} placeholder="Mã BN, họ tên, mã NC hoặc chẩn đoán" style={{ ...inp, flex: '1 1 320px' }} />
          <Btn variant="primary" onClick={() => loadPatientHistory()} disabled={patientHistoryLoading || !text(patientQuery)} style={{ height: 28 }}>
            {patientHistoryLoading ? <><Spinner size={9} /> Đang tìm</> : 'Tìm'}
          </Btn>
        </div>
        {patientHistoryMeta && !patientHistoryLoading && (
          <div style={{ marginTop: 6, fontSize: 9.5, color: C.text3 }}>
            {patientHistoryMeta.source ? `Nguồn: ${patientHistoryMeta.source.toUpperCase()} · ` : ''}{(patientHistoryMeta.elapsedMs / 1000).toFixed(2)} giây
            {patientHistory?.selection_required ? ` · Tìm thấy ${patientHistoryMeta.matched} kết quả; chọn đúng người bệnh để mở chi tiết.` : ''}
            {patientHistoryMeta.truncated ? ` · Hiển thị ${Math.min(30, patientHistoryMeta.matched)} kết quả đầu.` : ''}
          </div>
        )}
      </div>

      {patientHistoryError && (
        <div style={{ border: `1px solid ${C.redBorder}`, background: C.redBg, color: C.red, borderRadius: 7, padding: '8px 10px', fontSize: 10.5 }}>
          <b>Không tra cứu được:</b> {patientHistoryError}
        </div>
      )}
      {!patientHistoryLoading && patientHistory?.selection_required && !!patientHistory?.candidates?.length && (
        <div style={{ borderTop: `1px solid ${C.border2}`, borderBottom: `1px solid ${C.border2}`, background: C.surface, overflow: 'hidden' }}>
          <div style={{ padding: '8px 10px', borderBottom: `1px solid ${C.border2}` }}>
            <div style={{ fontSize: 11.5, fontWeight: 850, color: C.text }}>Chọn người bệnh</div>
            <div style={{ marginTop: 2, fontSize: 10, color: C.text3 }}>
              Từ khóa khớp nhiều hồ sơ. Chỉ khi chọn một BN hệ thống mới tải XN/CĐHA/thuốc/PT chi tiết.
            </div>
          </div>
          <div style={{ maxHeight: 420, overflow: 'auto' }}>
            {(patientHistory.candidates || []).map((cand, ci) => {
              const exactQuery = cand.patient_code || cand.research_code;
              return (
                <button
                  key={`${cand.patient_code || cand.research_code}_${ci}`}
                  type="button"
                  onClick={() => {
                    if (!exactQuery) return;
                    setPatientQuery(exactQuery);
                    loadPatientHistory(exactQuery);
                  }}
                  style={{
                    width: '100%', border: 0, borderBottom: `1px solid ${C.border2}`,
                    background: C.surface, padding: '9px 11px', textAlign: 'left',
                    cursor: 'pointer', display: 'flex', alignItems: 'center',
                    justifyContent: 'space-between', gap: 10,
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = C.surface2; }}
                  onMouseLeave={e => { e.currentTarget.style.background = C.surface; }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 11.5, fontWeight: 850, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {cand.patient_name || 'Chưa rõ họ tên'}
                    </div>
                    <div style={{ marginTop: 2, fontSize: 10, color: C.text3 }}>
                      BN {cand.patient_code || '—'}{cand.research_code ? ` · NC ${cand.research_code}` : ''}
                      {cand.sex ? ` · ${cand.sex}` : ''}{cand.age ? ` · ${cand.age} tuổi` : ''}
                    </div>
                  </div>
                  <span style={{ fontSize: 10, color: C.blue, fontWeight: 800, whiteSpace: 'nowrap' }}>
                    {cand.encounter_count || 0} đợt · Xem
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {patientHistoryLoading && patientHistory?.patients?.length ? (
        <div style={{ fontSize: 10, color: C.blue }}><Spinner size={9} /> Đang cập nhật kết quả; dữ liệu cũ vẫn được giữ để xem.</div>
      ) : null}
      {patientHistoryLoading && !patientHistory?.patients?.length && <div style={{ padding: 14, color: C.text2 }}><Spinner size={11} /> Đang tra cứu...</div>}
      {!patientHistoryLoading && patientHistory && !patientHistory.selection_required && !patientHistory.patients?.length && !patientHistoryError && <EmptyState title="Không tìm thấy" hint="Thử mã BN/mã NC hoặc họ tên chính xác hơn." />}

      {patientHistory?.patients?.map((p, pi) => (
        <div key={`${p.patient_code}_${pi}`} style={{ borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}`, background: C.surface, overflow: 'hidden' }}>
          <div style={{ padding: '9px 11px', borderBottom: `1px solid ${C.border2}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 850, color: C.text }}>{p.patient_name || 'Người bệnh'} <span style={{ color: C.text3, fontWeight: 650 }}>· BN {(p.patient_codes?.length ? p.patient_codes.join(', ') : p.patient_code) || '—'}</span></div>
              <div style={{ marginTop: 2, fontSize: 10, color: C.text3 }}>{p.sex || '—'} · {p.age ? `${p.age} tuổi` : 'chưa rõ tuổi'}{p.first_research_code ? ` · NC ${p.first_research_code}` : ''}</div>
            </div>
            <StatBadge label="Đợt" value={p.encounter_count || 0} tone="info" />
          </div>
          <div style={{ display: 'grid', gap: 7, padding: 9 }}>
            {(p.encounters || []).map((enc, ei) => <EncounterHistoryCard key={`${enc.encounter_id}_${ei}`} enc={enc} index={ei} />)}
          </div>
        </div>
      ))}
    </div>
  );

  const renderVariableCatalog = () => {
    const activeGroup = catalogGroupOptions.find(g => g.key === variableGroupFilter);
    const totalVisible = filteredCatalogVariables.length;
    const typeOptions = [
      ['all', 'Tất cả loại'], ['number', 'Số'], ['date', 'Ngày/giờ'], ['category', 'Phân loại'], ['text', 'Văn bản'],
    ];
    const fillOptions = [
      ['all', 'Tất cả mức đủ'], ['high', '≥ 80% đủ'], ['medium', '30–79% đủ'], ['low', '< 30% đủ'],
    ];
    const groupButtonStyle = (active) => ({
      height: 30, borderRadius: 5, border: 0,
      borderBottom: `2px solid ${active ? C.blue : 'transparent'}`,
      background: 'transparent', color: active ? C.text : C.text3,
      padding: '0 8px', fontSize: 11, fontWeight: active ? 850 : 650, cursor: 'pointer',
      display: 'inline-flex', alignItems: 'center', gap: 5,
    });
    const pill = (label, tone = 'neutral') => {
      const map = {
        ok: { bg: C.greenBg, color: C.green, border: C.greenBorder },
        info: { bg: C.blueBg, color: C.blue, border: C.blueBorder },
        warn: { bg: C.amberBg, color: C.amber, border: C.amberBorder },
        danger: { bg: C.redBg, color: C.red, border: C.redBorder },
        neutral: { bg: C.surface2, color: C.text2, border: C.border2 },
      };
      const c = map[tone] || map.neutral;
      return <span style={{ display: 'inline-flex', alignItems: 'center', border: `1px solid ${c.border}`, background: c.bg, color: c.color, borderRadius: 999, padding: '1px 7px', fontSize: 10, fontWeight: 800 }}>{label}</span>;
    };
    const renderVariableCard = (v) => {
      const typeTone = variableTypeTone(v.type);
      const selected = selectedVariableIds.has(v.id);
      const completenessTone = variableCompletenessTone(v.fill_rate);
      return (
        <div key={v.id} style={{ borderBottom: `1px solid ${C.border2}`, background: selected ? C.blueBg : C.surface, padding: '9px 8px', display: 'grid', gridTemplateColumns: '22px minmax(0, 1fr) auto', gap: 9, alignItems: 'start' }}>
          <input type="checkbox" checked={selected} onChange={() => toggleVariable(v.id)} style={{ marginTop: 3 }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
              <div style={{ fontSize: 13, fontWeight: 850, color: C.text }}>{v.display_label}</div>
              <span style={{ border: `1px solid ${typeTone.border}`, background: typeTone.bg, color: typeTone.color, borderRadius: 999, padding: '1px 7px', fontSize: 10, fontWeight: 850 }}>{variableTypeLabel(v.type)}</span>
              {pill(variableRoleLabel(v.role), v.role === 'identity' || v.role === 'technical' ? 'warn' : 'neutral')}
              {!v.recommended && pill('Ít dùng', 'warn')}
            </div>
            <div style={{ marginTop: 4, color: C.text3, fontSize: 10 }}>
              <span style={{ fontWeight: 750 }}>{v.clinical_group_label}</span>
              <span> · nguồn: {v.source_group_label}</span>
              <span> · cột gốc: </span>
              <code style={{ fontSize: 10, color: C.text2 }}>{v.raw_name}</code>
            </div>
            <div style={{ marginTop: 7, color: C.text2, fontSize: 11, lineHeight: 1.45 }}>{v.description}</div>
            <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              {pill(`${v.fill_rate}% có dữ liệu · ${variableCompletenessLabel(v.fill_rate)}`, completenessTone)}
              {pill(`${compactNumber(v.distinct_count)} giá trị khác nhau`, 'neutral')}
              <span style={{ color: C.text3, fontSize: 10 }}>Mẫu: {sampleText(v.sample_values)}</span>
            </div>
          </div>
          <Btn onClick={() => addConditionForVariable(v)} style={{ height: 26, padding: '0 9px', fontSize: 10 }}>+ Điều kiện</Btn>
        </div>
      );
    };
    return (
      <div style={{ padding: '10px 12px 16px', display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, flex: '1 1 720px' }}>
          <div style={{ background: C.surface, overflow: 'hidden' }}>
            <div style={{ padding: '4px 0 10px', borderBottom: `1px solid ${C.border2}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 850, color: C.text }}>Chọn biến nghiên cứu</div>
                  <div style={{ fontSize: 11, color: C.text3, marginTop: 4, lineHeight: 1.45 }}>
                    Tìm và chọn biến cần dùng; thêm điều kiện lọc khi cần.
                  </div>
                </div>
                <Btn onClick={() => loadVariableCatalog()} disabled={variableCatalogLoading} style={{ height: 30 }}>{variableCatalogLoading ? <><Spinner size={9} /> Đang tải</> : 'Tải lại danh mục'}</Btn>
              </div>
              <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) 140px 140px', gap: 7 }}>
                <input value={variableQuery} onChange={e => setVariableQuery(e.target.value)} placeholder="Tìm biến: tuổi, giới, ngày nhập viện, Hb, creatinine, X-quang, CT, MRI, kháng sinh..." style={inp} />
                <select value={variableTypeFilter} onChange={e => setVariableTypeFilter(e.target.value)} style={inp}>
                  {typeOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                <select value={variableFillFilter} onChange={e => setVariableFillFilter(e.target.value)} style={inp}>
                  {fillOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </div>
              <label style={{ marginTop: 9, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: C.text2 }}>
                <input type="checkbox" checked={showTechnicalVariables} onChange={e => setShowTechnicalVariables(e.target.checked)} />
                Hiện cả biến định danh/kỹ thuật
              </label>
            </div>

            {variableCatalogLoading && <div style={{ padding: 20, color: C.text2 }}><Spinner size={12} /> Đang lập danh mục biến...</div>}
            {!variableCatalogLoading && !variableCatalog && (
              <EmptyState
                title={variableCatalogError ? 'Chưa tải được danh mục biến' : 'Chưa có danh mục biến'}
                hint={variableCatalogError ? `${variableCatalogError}. Bấm Tải lại danh mục sau vài giây nếu vừa chuyển tab/tải lại trang.` : 'Bấm Chuẩn hóa trước, sau đó vào lại mục này để xem biến.'}
              />
            )}
            {!variableCatalogLoading && variableCatalog && (
              <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button type="button" onClick={() => setVariableGroupFilter('all')} style={groupButtonStyle(variableGroupFilter === 'all')}>Tất cả <span style={{ color: C.text3 }}>{catalogGroupOptions.reduce((sum, g) => sum + Number(g.count || 0), 0)}</span></button>
                  {catalogGroupOptions.map(g => (
                    <button key={g.key} type="button" onClick={() => setVariableGroupFilter(g.key)} style={groupButtonStyle(variableGroupFilter === g.key)}>
                      {g.label} <span style={{ color: C.text3 }}>{g.count}</span>
                    </button>
                  ))}
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'baseline', padding: '2px 0' }}>
                  <div style={{ fontSize: 12, fontWeight: 850, color: C.text }}>{variableGroupFilter === 'all' ? 'Biến phù hợp' : activeGroup?.label || 'Nhóm biến'}</div>
                  <div style={{ fontSize: 10, color: C.text3 }}>
                    {compactNumber(totalVisible)} biến{!showTechnicalVariables ? ' · đã ẩn định danh/kỹ thuật' : ''}
                  </div>
                </div>

                {!filteredCatalogVariables.length && <EmptyState title="Không có biến phù hợp" hint="Thử bỏ lọc loại biến/mức đầy đủ hoặc bật hiển thị biến định danh/kỹ thuật." />}
                {!!filteredCatalogVariables.length && (
                  <div style={{ maxHeight: 'calc(100vh - 385px)', overflow: 'auto', display: 'grid', gap: 10, paddingRight: 3 }}>
                    {filteredVariableSections.map(section => (
                      <div key={section.label} style={{ background: C.surface, overflow: 'hidden', borderTop: `1px solid ${C.border2}` }}>
                        <div style={{ padding: '9px 11px', borderBottom: `1px solid ${C.border2}`, display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                          <div style={{ fontSize: 12, fontWeight: 850, color: C.text }}>{section.label}</div>
                          {pill(`${section.variables.length} biến`, 'neutral')}
                        </div>
                        <div style={{ display: 'grid', gap: 0 }}>
                          {section.variables.map(renderVariableCard)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div style={{ background: C.surface, padding: '4px 0 12px 14px', position: 'sticky', top: 10, flex: '0 1 330px', minWidth: 300, borderLeft: `1px solid ${C.border2}` }}>
          <div style={{ fontSize: 13, fontWeight: 850, color: C.text }}>Tạo nghiên cứu từ biến đã chọn</div>
          <div style={{ fontSize: 11, color: C.text3, marginTop: 4 }}>{selectedVariables.length} biến · {variableConditions.length} điều kiện</div>

          <div style={{ marginTop: 10, padding: '10px 0', display: 'grid', gap: 8, borderTop: `1px solid ${C.border2}`, borderBottom: `1px solid ${C.border2}` }}>
            <div style={{ fontSize: 11, fontWeight: 850, color: C.text }}>Thông tin nghiên cứu</div>
            <input value={variableStudyDraft.name} onChange={e => setVariableStudyDraft(p => ({ ...p, name: e.target.value }))} placeholder="Tên nghiên cứu, VD: Gãy cổ xương đùi 2026" style={inp} />
            <textarea value={variableStudyDraft.description} onChange={e => setVariableStudyDraft(p => ({ ...p, description: e.target.value }))} placeholder="Mô tả ngắn / mục tiêu nghiên cứu" rows={2} style={{ ...inp, height: 'auto', paddingTop: 7, paddingBottom: 7, resize: 'vertical' }} />
            <Btn variant="primary" onClick={createStudyFromVariableSelection} disabled={busy || !selectedVariables.length || !text(variableStudyDraft.name)} style={{ height: 30 }}>
              {busy ? <><Spinner size={9} /> Đang tạo</> : '＋ Tạo nghiên cứu'}
            </Btn>
            <div style={{ fontSize: 10, color: C.text3, lineHeight: 1.4 }}>Tạo nghiên cứu từ biến và điều kiện đã chọn.</div>
          </div>

          <div style={{ marginTop: 12, fontSize: 12, fontWeight: 850, color: C.text }}>Biến sẽ lấy</div>
          <div style={{ marginTop: 8, maxHeight: 190, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {!selectedVariables.length && <div style={{ border: `1px dashed ${C.border}`, borderRadius: 6, padding: 10, fontSize: 11, color: C.text3, lineHeight: 1.45 }}>Chưa chọn biến. Nên bắt đầu từ <b>Hành chánh</b> và <b>Đợt điều trị</b>, sau đó thêm Xét nghiệm/CĐHA/Phẫu thuật theo mục tiêu nghiên cứu.</div>}
            {selectedVariablesByGroup.map(group => (
              <div key={group.label} style={{ border: `1px solid ${C.border2}`, borderRadius: 6, overflow: 'hidden' }}>
                <div style={{ padding: '6px 8px', background: C.surface2, fontSize: 11, fontWeight: 850, color: C.text2 }}>{group.label}</div>
                {group.variables.map(v => {
                  const isRepeatedTable = !['analysis_ready', 'encounters', 'patients', 'cohort', 'research_source'].includes(String(v.table || ''));
                  return (
                  <div key={v.id} style={{ padding: '7px 8px', borderTop: `1px solid ${C.border2}`, display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 8, alignItems: 'center' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 11, fontWeight: 800, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.display_label}</div>
                      <div style={{ fontSize: 10, color: C.text3 }}>{v.raw_name}</div>
                      {isRepeatedTable && (
                        <select
                          value={variableAggregations[v.id] || 'list'}
                          onChange={e => setVariableAggregations(prev => ({ ...prev, [v.id]: e.target.value }))}
                          title="Cách tổng hợp khi một lượt có nhiều dòng dữ liệu"
                          style={{ ...inp, height: 26, marginTop: 5, fontSize: 10, padding: '2px 6px' }}
                        >
                          {VARIABLE_AGGREGATIONS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                        </select>
                      )}
                    </div>
                    <button type="button" onClick={() => toggleVariable(v.id)} style={{ border: 0, background: 'transparent', color: C.red, cursor: 'pointer', fontSize: 13 }}>✕</button>
                  </div>
                  );
                })}
              </div>
            ))}
          </div>

          <div style={{ marginTop: 14, fontSize: 13, fontWeight: 850, color: C.text }}>Điều kiện lọc</div>
          <div style={{ fontSize: 10, color: C.text3, marginTop: 3 }}>Điều kiện dùng để lọc đối tượng nghiên cứu, ví dụ: tuổi ≥ 60, Hb &lt; 90, có phẫu thuật.</div>
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 300, overflow: 'auto' }}>
            {!variableConditions.length && <div style={{ border: `1px dashed ${C.border}`, borderRadius: 6, padding: 10, fontSize: 11, color: C.text3 }}>Bấm <b>+ Điều kiện</b> ở biến cần ràng buộc.</div>}
            {variableConditions.map((cond, i) => {
              const variable = allCatalogVariables.find(v => v.id === cond.variable_id);
              return (
                <div key={cond.id} style={{ border: `1px solid ${C.border2}`, borderRadius: 6, padding: 9, display: 'grid', gap: 7 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 11, fontWeight: 850, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{variable?.display_label || cond.label}</div>
                      <div style={{ fontSize: 10, color: C.text3 }}>{variable?.clinical_group_label || variable?.group_label || ''}</div>
                    </div>
                    <button type="button" onClick={() => setVariableConditions(prev => prev.filter((_, j) => j !== i))} style={{ border: 0, background: 'transparent', color: C.red, cursor: 'pointer' }}>✕</button>
                  </div>
                  <select value={cond.operator} onChange={e => setVariableConditions(prev => prev.map((x, j) => j === i ? { ...x, operator: e.target.value } : x))} style={inp}>
                    {(variable?.operators || ['contains', '=']).map(op => <option key={op} value={op}>{operatorLabel(op)}</option>)}
                  </select>
                  <input value={cond.value} onChange={e => setVariableConditions(prev => prev.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} placeholder="Giá trị điều kiện" style={inp} />
                  {cond.operator === 'between' && <input value={cond.value2} onChange={e => setVariableConditions(prev => prev.map((x, j) => j === i ? { ...x, value2: e.target.value } : x))} placeholder="Giá trị đến" style={inp} />}
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <Btn variant="success" onClick={exportVariableSpec} disabled={!selectedVariables.length && !variableConditions.length} style={{ height: 28 }}>Tải cấu hình JSON</Btn>
            <Btn onClick={() => { setSelectedVariableIds(new Set()); setVariableAggregations({}); setVariableConditions([]); }} style={{ height: 28 }}>Xóa chọn</Btn>
          </div>
        </div>
      </div>
    );
  };

  const renderArchiveWorkspace = () => {
    if (archiveMode === 'overview') return renderGeneralOverview();
    if (archiveMode === 'patient') return renderPatientLookup();
    if (archiveMode === 'variables') return renderVariableCatalog();
    if (archiveMode === 'update') return renderArchiveHome();
    return null;
  };

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden', background: C.bg, fontFamily: '\"Segoe UI Variable\",\"Aptos\",\"Segoe UI\",sans-serif', fontSize: 12 }}>

      {/* ── Top bar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
        padding: '0 12px', height: 34, flexShrink: 0,
        borderBottom: `1px solid ${C.border2}`, background: C.surface,
      }}>
        <Btn
          onClick={reloadCurrentView}
          disabled={loading || tableLoading || busy}
          title="Tải lại dữ liệu đang xem"
          style={{ height: 26, padding: '0 9px', fontSize: 10.5 }}
        >
          {(loading || tableLoading) ? <><Spinner size={8} /> Đang tải</> : '↻ Tải lại'}
        </Btn>
      </div>


      {/* ── Delete confirm ── */}
      {deleteConfirm && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
        }}>
          <div style={{
            background: C.surface, border: `1px solid ${C.redBorder}`,
            borderRadius: 6, padding: '24px 28px', maxWidth: 380, width: '90%',
          }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: C.text, marginBottom: 8 }}>Xóa nghiên cứu?</div>
            <div style={{ fontSize: 12, color: C.text2, marginBottom: 20, lineHeight: 1.6 }}>
              Toàn bộ dữ liệu của nghiên cứu <b style={{ color: C.text }}>{studies.find(s => s.id === deleteConfirm)?.name || deleteConfirm}</b> sẽ bị xóa vĩnh viễn, bao gồm cohort và tất cả dữ liệu đã lấy.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn onClick={() => setDeleteConfirm(null)} style={{ height: 30, padding: '0 14px', fontSize: 12 }}>Huỷ</Btn>
              <Btn variant="danger" onClick={() => deleteStudy(deleteConfirm)} disabled={uiBusy} style={{ height: 30, padding: '0 14px', fontSize: 12, background: C.redBg, borderColor: C.redBorder, color: C.red }}>
                {busy ? <><Spinner size={9} /> Đang xóa</> : 'Xóa'}
              </Btn>
            </div>
          </div>
        </div>
      )}

      {/* ── Wizard tạo nghiên cứu ── */}
      {showWizard && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
          zIndex: 99, overflowY: 'auto', padding: '40px 16px',
        }}>
          <div style={{
            background: C.surface, border: `1px solid ${C.border}`,
            borderRadius: 7, width: '100%', maxWidth: 860,
            display: 'flex', flexDirection: 'column', gap: 0,
          }}>
            {/* Wizard header */}
            <div style={{ padding: '16px 20px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 14, fontWeight: 850, color: C.text }}>Tạo nghiên cứu mới</span>
              <div style={{ display: 'flex', gap: 6, marginLeft: 8 }}>
                {[['1','Thông tin'], ['2','Lọc mẫu'], ['3','Xác nhận']].map(([s, label]) => (
                  <span key={s} style={{
                    fontSize: 10, fontWeight: 700, padding: '2px 9px', borderRadius: 20,
                    background: wizardStep === Number(s) ? C.blueBg : C.surface2,
                    color: wizardStep === Number(s) ? C.blue : C.text3,
                    border: `1px solid ${wizardStep === Number(s) ? C.blueBorder : C.border2}`,
                  }}>{s}. {label}</span>
                ))}
              </div>
              <Btn onClick={() => setShowWizard(false)} style={{ marginLeft: 'auto', height: 26, padding: '0 8px', fontSize: 11 }}>✕</Btn>
            </div>

            {/* Step 1: Thông tin cơ bản */}
            {wizardStep === 1 && (
              <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
                <WizLabel>Tên nghiên cứu *</WizLabel>
                <input value={wizardForm.name}
                  onChange={e => setWizardForm(p => ({ ...p, name: e.target.value }))}
                  placeholder="VD: Khảo sát nồng độ calci huyết sau truyền Aclasta"
                  style={{ ...inp, width: '100%' }} autoFocus />
                <WizLabel>Mô tả / Tiêu chí</WizLabel>
                <input value={wizardForm.description}
                  onChange={e => setWizardForm(p => ({ ...p, description: e.target.value }))}
                  placeholder="VD: BN > 50 tuổi, có chỉ định truyền Aclasta, lấy XN calci T0, T24h, T48h"
                  style={{ ...inp, width: '100%' }} />

                {/* Cấu hình phân tích */}
                <div style={{ borderTop: `1px solid ${C.border2}`, paddingTop: 12 }}>
                  <WizLabel>Loại phân tích (preset)</WizLabel>
                  <select
                    value={wizardForm.analysis_config.preset}
                    onChange={e => setWizardForm(p => ({ ...p, analysis_config: { ...p.analysis_config, preset: e.target.value } }))}
                    style={{ ...inp, width: '100%', marginTop: 4 }}>
                    {(analysisPresets.length ? analysisPresets : [
                      { id: 'ortho_fracture', label: 'Chấn thương chỉnh hình — Gãy xương' },
                      { id: 'ortho_joint',    label: 'Chấn thương chỉnh hình — Khớp / Thay khớp' },
                      { id: 'neuro_spine',    label: 'Thần kinh — Cột sống / Tủy sống' },
                      { id: 'neuro_brain',    label: 'Thần kinh — Sọ não / Đột quỵ' },
                      { id: 'general',        label: 'Tổng quát (không inference)' },
                    ]).map(p => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                  {analysisPresets.length > 0 && (() => {
                    const chosen = analysisPresets.find(p => p.id === wizardForm.analysis_config.preset);
                    return chosen?.inference_fields?.length ? (
                      <div style={{ fontSize: 10, color: C.text3, marginTop: 4 }}>
                        Sẽ tự suy luận: {chosen.inference_fields.map(f => f.label).join(' · ')}
                      </div>
                    ) : null;
                  })()}
                </div>

                {/* Custom fields */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <WizLabel>Trường tuỳ chỉnh (regex từ chẩn đoán)</WizLabel>
                    <button type="button"
                      onClick={() => setWizardForm(p => ({ ...p, analysis_config: { ...p.analysis_config, custom_fields: [...(p.analysis_config.custom_fields || []), { name: '', pattern: '', label: '' }] } }))}
                      style={{ background: C.blueBg, border: `1px solid ${C.blueBorder}`, color: C.blue, borderRadius: 5, padding: '2px 8px', fontSize: 11, cursor: 'pointer' }}>
                      + Thêm
                    </button>
                  </div>
                  {(wizardForm.analysis_config.custom_fields || []).length === 0 && (
                    <div style={{ fontSize: 10, color: C.text3, fontStyle: 'italic' }}>VD: tên="diabetes", pattern="đái tháo đường|type 2" → cột diabetes = 1/0</div>
                  )}
                  {(wizardForm.analysis_config.custom_fields || []).map((cf, i) => (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 28px', gap: 6, marginTop: 6 }}>
                      <input value={cf.name}
                        onChange={e => setWizardForm(p => { const cfs = [...p.analysis_config.custom_fields]; cfs[i] = { ...cfs[i], name: e.target.value }; return { ...p, analysis_config: { ...p.analysis_config, custom_fields: cfs } }; })}
                        placeholder="Tên cột (VD: diabetes)" style={inp} />
                      <input value={cf.pattern}
                        onChange={e => setWizardForm(p => { const cfs = [...p.analysis_config.custom_fields]; cfs[i] = { ...cfs[i], pattern: e.target.value }; return { ...p, analysis_config: { ...p.analysis_config, custom_fields: cfs } }; })}
                        placeholder="Regex (VD: đái tháo đường|type 2)" style={inp} />
                      <button type="button"
                        onClick={() => setWizardForm(p => { const cfs = p.analysis_config.custom_fields.filter((_, j) => j !== i); return { ...p, analysis_config: { ...p.analysis_config, custom_fields: cfs } }; })}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.text3, fontSize: 16 }}>✕</button>
                    </div>
                  ))}
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
                  <Btn onClick={() => setShowWizard(false)} style={{ height: 30, padding: '0 14px', fontSize: 12 }}>Huỷ</Btn>
                  <Btn variant="primary" onClick={() => { if (!text(wizardForm.name)) { t('Cần nhập tên nghiên cứu.', 'error'); return; } setWizardStep(2); loadWizardPreview(); }} style={{ height: 30, padding: '0 14px', fontSize: 12 }}>
                    Tiếp theo →
                  </Btn>
                </div>
              </div>
            )}

            {/* Step 2: Lọc mẫu */}
            {wizardStep === 2 && (
              <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 18 }}>

                {/* Tuổi + Giới */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                  <WizField label="Tuổi từ" type="number" placeholder="VD: 18"
                    value={wizardFilters.tuoiMin} onChange={v => setWizardFilters(p => ({ ...p, tuoiMin: v }))} />
                  <WizField label="Tuổi đến" type="number" placeholder="VD: 80"
                    value={wizardFilters.tuoiMax} onChange={v => setWizardFilters(p => ({ ...p, tuoiMax: v }))} />
                  <WizSelect label="Giới tính" value={wizardFilters.gioi}
                    onChange={v => setWizardFilters(p => ({ ...p, gioi: v }))}
                    options={[['','Tất cả'],['Nam','Nam'],['Nữ','Nữ']]} />
                </div>

                {/* Chẩn đoán */}
                <div>
                  <WizLabel>Chẩn đoán chứa</WizLabel>
                  <input value={wizardFilters.chanDoan}
                    onChange={e => setWizardFilters(p => ({ ...p, chanDoan: e.target.value }))}
                    placeholder="VD: loãng xương, gãy cổ xương đùi, đái tháo đường..."
                    style={{ ...wizInp, width: '100%' }} />
                </div>

                {/* Xét nghiệm — danh sách điều kiện */}
                <div style={{ borderTop: `1px solid ${C.border2}`, paddingTop: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                    <WizLabel>Xét nghiệm — bệnh nhân phải có</WizLabel>
                    <button type="button"
                      onClick={() => setWizardFilters(p => ({ ...p, xnList: [...p.xnList, { ten: '', min: '', max: '' }] }))}
                      style={{ background: C.blueBg, border: `1px solid ${C.blueBorder}`, color: C.blue, borderRadius: 5, padding: '2px 10px', fontSize: 11, cursor: 'pointer' }}>
                      + Thêm XN
                    </button>
                  </div>
                  {wizardFilters.xnList.length === 0 && (
                    <div style={{ fontSize: 11, color: C.text3, fontStyle: 'italic' }}>Chưa có điều kiện XN nào — bấm "+ Thêm XN" để thêm</div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {wizardFilters.xnList.map((xn, i) => (
                      <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 120px 120px 28px', gap: 8, alignItems: 'end' }}>
                        <div>
                          {i === 0 && <WizLabel>Tên chỉ số</WizLabel>}
                          <input value={xn.ten}
                            onChange={e => setWizardFilters(p => { const l = [...p.xnList]; l[i] = { ...l[i], ten: e.target.value }; return { ...p, xnList: l }; })}
                            placeholder="VD: creatinine, wbc, crp, calci..."
                            style={wizInp} />
                        </div>
                        <div>
                          {i === 0 && <WizLabel>Tối thiểu</WizLabel>}
                          <input type="number" value={xn.min}
                            onChange={e => setWizardFilters(p => { const l = [...p.xnList]; l[i] = { ...l[i], min: e.target.value }; return { ...p, xnList: l }; })}
                            placeholder="Bỏ trống = không giới hạn"
                            style={wizInp} />
                        </div>
                        <div>
                          {i === 0 && <WizLabel>Tối đa</WizLabel>}
                          <input type="number" value={xn.max}
                            onChange={e => setWizardFilters(p => { const l = [...p.xnList]; l[i] = { ...l[i], max: e.target.value }; return { ...p, xnList: l }; })}
                            placeholder="Bỏ trống = không giới hạn"
                            style={wizInp} />
                        </div>
                        <button type="button"
                          onClick={() => setWizardFilters(p => ({ ...p, xnList: p.xnList.filter((_, j) => j !== i) }))}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.text3, fontSize: 16, marginTop: i === 0 ? 18 : 0 }}>✕</button>
                      </div>
                    ))}
                  </div>
                </div>

                {/* CĐHA — danh sách từ khóa */}
                <div style={{ borderTop: `1px solid ${C.border2}`, paddingTop: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                    <WizLabel>CĐHA — bệnh nhân phải có</WizLabel>
                    <button type="button"
                      onClick={() => setWizardFilters(p => ({ ...p, cdhaList: [...p.cdhaList, ''] }))}
                      style={{ background: C.blueBg, border: `1px solid ${C.blueBorder}`, color: C.blue, borderRadius: 5, padding: '2px 10px', fontSize: 11, cursor: 'pointer' }}>
                      + Thêm CĐHA
                    </button>
                  </div>
                  {wizardFilters.cdhaList.length === 0 && (
                    <div style={{ fontSize: 11, color: C.text3, fontStyle: 'italic' }}>Chưa có điều kiện CĐHA nào — bấm "+ Thêm CĐHA" để thêm</div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {wizardFilters.cdhaList.map((cdha, i) => (
                      <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 28px', gap: 8, alignItems: 'center' }}>
                        <input value={cdha}
                          onChange={e => setWizardFilters(p => { const l = [...p.cdhaList]; l[i] = e.target.value; return { ...p, cdhaList: l }; })}
                          placeholder="VD: X-quang cột sống, siêu âm ổ bụng, đo mật độ xương..."
                          style={wizInp} />
                        <button type="button"
                          onClick={() => setWizardFilters(p => ({ ...p, cdhaList: p.cdhaList.filter((_, j) => j !== i) }))}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.text3, fontSize: 16 }}>✕</button>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Preview count — chỉ số, không có bảng */}
                <div style={{
                  padding: '12px 16px', borderRadius: 8,
                  background: wizardFiltered.length > 0 ? C.blueBg : C.surface2,
                  border: `1px solid ${wizardFiltered.length > 0 ? C.blueBorder : C.border2}`,
                  display: 'flex', alignItems: 'center', gap: 12,
                }}>
                  {wizardLoadingPreview
                    ? <><Spinner size={10} /><span style={{ fontSize: 12, color: C.text2 }}>Đang tải dữ liệu kho gốc...</span></>
                    : <>
                        <span style={{ fontSize: 28, fontWeight: 850, color: wizardFiltered.length > 0 ? C.blue : C.text3, lineHeight: 1 }}>
                          {compactNumber(wizardFiltered.length)}
                        </span>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: wizardFiltered.length > 0 ? C.text : C.text2 }}>
                            BN phù hợp tiêu chí
                          </div>
                          <div style={{ fontSize: 11, color: C.text3 }}>
                            {wizardRows.length
                              ? `trên tổng ${compactNumber(wizardRows.length)} BN trong kho gốc`
                              : <span style={{ color: C.amber }}>Kho gốc chưa có dữ liệu Bước 2</span>
                            }
                          </div>
                        </div>
                      </>
                  }
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <Btn onClick={() => setWizardStep(1)} style={{ height: 30, padding: '0 14px', fontSize: 12 }}>← Quay lại</Btn>
                  <Btn variant="primary"
                    onClick={() => { setWizardExcluded(new Set()); setWizardStep(3); }}
                    disabled={wizardFiltered.length === 0 || wizardLoadingPreview}
                    style={{ height: 30, padding: '0 14px', fontSize: 12 }}>
                    Xem danh sách →
                  </Btn>
                </div>
              </div>
            )}

            {/* Step 3: Xác nhận & loại bỏ thủ công */}
            {wizardStep === 3 && (
              <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 13, fontWeight: 800, color: C.text }}>
                    {compactNumber(wizardFinalRows.length)} BN sẽ vào danh sách mẫu
                  </span>
                  {wizardExcluded.size > 0 && (
                    <span style={{ fontSize: 11, color: C.amber }}>({compactNumber(wizardExcluded.size)} đã loại)</span>
                  )}
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: C.text3 }}>Bấm ✕ để loại BN không đạt tiêu chí</span>
                </div>

                <div style={{ maxHeight: 340, overflow: 'auto', borderRadius: 6, border: `1px solid ${C.border}` }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                    <thead style={{ position: 'sticky', top: 0, background: C.surface2 }}>
                      <tr>
                        <th style={{ width: 32 }} />
                        {['patient_code','Họ tên','Tuổi','GT','Ngày vào viện','Ngày ra viện'].map(col => (
                          <th key={col} style={{ padding: '6px 8px', textAlign: 'left', color: C.text3, fontWeight: 700, whiteSpace: 'nowrap', borderBottom: `1px solid ${C.border}` }}>{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {wizardFiltered.map((row, i) => {
                        const code = row.encounter_id || row.research_code || row.patient_code || row['Mã NC'] || row['Mã BN'] || String(i);
                        const excluded = wizardExcluded.has(code);
                        return (
                          <tr key={code} style={{ borderBottom: `1px solid ${C.border2}`, opacity: excluded ? 0.35 : 1, background: excluded ? C.redBg : 'transparent' }}>
                            <td style={{ padding: '4px 6px', textAlign: 'center' }}>
                              {excluded
                                ? <button type="button" onClick={() => setWizardExcluded(s => { const n = new Set(s); n.delete(code); return n; })}
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.green, fontSize: 13, lineHeight: 1 }}>↩</button>
                                : <button type="button" onClick={() => setWizardExcluded(s => new Set([...s, code]))}
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.red, fontSize: 15, lineHeight: 1 }}>✕</button>
                              }
                            </td>
                            {['patient_code','Họ tên','Tuổi','GT','Ngày vào viện','Ngày ra viện'].map(col => (
                              <td key={col} style={{ padding: '5px 8px', color: col === 'patient_code' ? C.blue : C.text2, whiteSpace: 'nowrap' }}>
                                {text(row[col] || row[col.toLowerCase()]) || '—'}
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <Btn onClick={() => setWizardStep(2)} style={{ height: 30, padding: '0 14px', fontSize: 12 }}>← Sửa bộ lọc</Btn>
                  <Btn variant="success" onClick={createStudyFromWizard} disabled={busy || wizardFinalRows.length === 0} style={{ height: 30, padding: '0 18px', fontSize: 12 }}>
                    {busy ? <><Spinner size={9} /> Đang tạo...</> : `✓ Tạo nghiên cứu (${compactNumber(wizardFinalRows.length)} BN)`}
                  </Btn>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Log panel ── */}
      {showLog && (
        <div style={{
          borderBottom: `1px solid ${C.border}`, background: '#0a0f14',
          display: 'flex', flexDirection: 'column', flexShrink: 0,
          height: 220,
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px',
            borderBottom: `1px solid ${C.border2}`, background: C.surface,
          }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: C.blue }}>📋 action_log.txt</span>
            <span style={{ fontSize: 10, color: C.text3 }}>{caseTraces.length ? `${caseTraces.length} ca gần nhất · ` : ''}{logLines.length} dòng cuối</span>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: C.text3 }}>
              <input type="checkbox" checked={caseTraceRedact} onChange={e => setCaseTraceRedact(e.target.checked)} />
              Ẩn thông tin nhạy cảm
            </label>
            <Btn onClick={loadLog} disabled={logLoading} style={{ height: 22, padding: '0 7px', fontSize: 10, marginLeft: 'auto' }}>
              {logLoading ? <><Spinner size={8} /> Đang tải</> : '↻'}
            </Btn>
            <Btn onClick={() => setShowLog(false)} style={{ height: 22, padding: '0 7px', fontSize: 10 }}>✕</Btn>
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: '6px 12px', fontFamily: FONT_MONO, fontSize: 11 }}>
            {logLoading && <div style={{ color: C.text3 }}>Đang tải log...</div>}
            {!logLoading && !logLines.length && !caseTraces.length && (
              <div style={{ color: C.text3 }}>Chưa có log. Bấm Bước 2 — Lấy XN & CĐHA hoặc lấy Hành chánh/Y lệnh để bắt đầu. Log chi tiết 10 ca gần nhất sẽ ghi vào <b>research_case_trace_recent.json</b>.</div>
            )}
            {!logLoading && !!caseTraces.length && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
                <div style={{ color: '#58a6ff', fontWeight: 800 }}>[CASE_TRACE] 10 ca gần nhất — tag ở đầu mỗi bước</div>
                {caseTraces.map((c, ci) => (
                  <details key={c.case_id || ci} open={ci === 0} style={{ border: '1px solid #263442', borderRadius: 8, padding: '6px 8px', background: '#0d141b' }}>
                    <summary style={{ cursor: 'pointer', color: '#d1d7e0', fontWeight: 700 }}>
                      [{c.status || '—'}] {c.index || '?'} / {c.total || '?'} · BN {c.ma_bn || '—'} · NC {c.research_code || '—'} · {c.date_from || '—'} → {c.date_to || '—'}
                    </summary>
                    <div style={{ marginTop: 6, display: 'grid', gap: 3 }}>
                      {(c.events || []).map((ev, ei) => (
                        <div key={ei} style={{ color: ev.tag?.startsWith('ERROR') ? '#f85149' : ev.tag === 'WARN' ? '#d29922' : ev.tag?.startsWith('OUTPUT') ? '#3fb950' : '#8b949e', lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>
                          [{ev.tag || 'TAG'}] {ev.step || ''}
                          {ev.screen ? ` | vào=${ev.screen}` : ''}
                          {ev.sees ? ` | thấy=${ev.sees}` : ''}
                          {ev.takes ? ` | lấy=${ev.takes}` : ''}
                          {ev.writes ? ` | ghi=${ev.writes}` : ''}
                          {ev.target ? ` | đích=${ev.target}` : ''}
                        </div>
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            )}
            {logLines.map((line, i) => {
              const isError = /ERROR|❌|lỗi/i.test(line);
              const isWarn  = /WARN|⚠/i.test(line);
              const isOk    = /OK   |✅|Commit xong|Tab.*xong/i.test(line);
              const isClick = /CLICK/.test(line);
              const isStep  = /STEP /.test(line);
              const color   = isError ? '#f85149' : isWarn ? '#d29922' : isOk ? '#3fb950' : isClick ? '#58a6ff' : isStep ? '#bc8cff' : '#8b949e';
              return (
                <div key={i} style={{ color, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{line}</div>
              );
            })}
          </div>
        </div>
      )}

      {researchError && (
        <div style={{ padding: '7px 12px', background: C.redBg, borderBottom: `1px solid ${C.redBorder}`, color: C.red, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 10.5 }}>
          <b>Lỗi:</b><span style={{ flex: 1 }}>{researchError}</span>
          <Btn onClick={() => { setShowLog(true); loadLog(); }} style={{ height: 24, fontSize: 10 }}>Xem log</Btn>
          <Btn onClick={() => setResearchError('')} style={{ height: 24, fontSize: 10 }}>Đóng</Btn>
        </div>
      )}

      {/* ── Body: sidebar + content ── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>

        {/* ── SIDEBAR ── */}
        <div style={{
          width: 194, flexShrink: 0, display: 'flex', flexDirection: 'column',
          borderRight: `1px solid ${C.border}`, background: C.surface, overflowY: 'auto',
        }}>
          {/* Kho gốc */}
          <SectionHead>Kho dữ liệu gốc</SectionHead>
          <SideItem
            label="Danh sách ban đầu"
            sub={archive?.latest_run
              ? `${compactNumber(archiveInitial)} dòng danh sách${operationSnapshot?.total ? ` · ${compactNumber(operationSnapshot.total)} lượt theo dõi` : ''}`
              : 'Chưa quét dữ liệu'}
            active={isArchive}
            onClick={() => { setSelectedId(ARCHIVE_SCOPE); setTable(ARCHIVE_DEFAULT_TABLE); setArchiveMode('overview'); }}
            badge={
              archive?.latest_run
                ? <span style={{ width: 7, height: 7, borderRadius: '50%', background: C.green, flexShrink: 0 }} />
                : <span style={{ width: 7, height: 7, borderRadius: '50%', background: C.text3, flexShrink: 0 }} />
            }
          >
            {archive?.latest_run && (
              <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                <StatBadge label="Dòng" value={archiveInitial || 0} tone="info" />
                {!!operationSnapshot?.total && <StatBadge label="Theo dõi" value={operationSnapshot.total} tone="neutral" />}
                {!!operationSnapshot?.counts?.error && <StatBadge label="Lỗi" value={operationSnapshot.counts.error} tone="danger" />}
              </div>
            )}
          </SideItem>

          {/* Nghiên cứu riêng */}
          <SectionHead>
            Nghiên cứu riêng
            {studies.length > 0 && (
              <span style={{
                marginLeft: 6, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 16, height: 16, borderRadius: '50%',
                background: C.surface2, color: C.text2, fontSize: 9, fontWeight: 800,
              }}>{studies.length}</span>
            )}
          </SectionHead>

          {studies.length === 0 && (
            <div style={{ padding: '10px 12px 14px', fontSize: 10.5, color: C.text3, lineHeight: 1.45 }}>
              Chưa có nghiên cứu riêng.
            </div>
          )}

          {studies.map(item => {
            const active = item.id === selectedId;
            return (
              <SideItem
                key={item.id}
                label={item.name}
                sub={item.id}
                active={active}
                onClick={() => { setSelectedId(item.id); setTable(primaryTableAfterRun(false)); }}
                badge={
                  item.latest_run
                    ? <span style={{ width: 7, height: 7, borderRadius: '50%', background: C.green, flexShrink: 0 }} />
                    : <span style={{ width: 7, height: 7, borderRadius: '50%', background: C.text3, flexShrink: 0 }} />
                }
              >
                <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
                  <StatBadge label="Mẫu" value={item.cohort_count || 0} tone="info" />
                  {item.latest_run && (
                    <StatBadge label="Lỗi" value={datasetCount(item,'errors',false)} tone={datasetCount(item,'errors',false) ? 'danger' : 'neutral'} />
                  )}
                  <button type="button" onClick={e => { e.stopPropagation(); setDeleteConfirm(item.id); }}
                    title="Xóa nghiên cứu"
                    style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: C.text3, fontSize: 13, lineHeight: 1, padding: '0 2px' }}>🗑</button>
                </div>
              </SideItem>
            );
          })}
        </div>

        {/* ── MAIN CONTENT ── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

          {/* ── Action strip ── */}
          <div style={{
            padding: '6px 12px 0', borderBottom: `1px solid ${C.border}`,
            background: C.surface, flexShrink: 0,
          }}>
            {/* Title row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, minHeight: 26 }}>
              <span style={{ fontSize: 13, fontWeight: 800, color: C.text }}>
                {isArchive ? 'Dữ liệu gốc' : (activeStudy?.name || selectedId)}
              </span>
              {latest?.id && (
                <span style={{ fontSize: 10, color: C.text3, fontFamily: FONT_MONO }}>
                  đợt {latest.id}
                </span>
              )}
              {!isArchive && activeStudy?.description && (
                <span style={{ fontSize: 11, color: C.text2 }}> — {activeStudy.description}</span>
              )}
              {!isArchive && activeStudy?.analysis_config?.preset && (() => {
                const presetLabel = analysisPresets.find(p => p.id === activeStudy.analysis_config.preset)?.label
                  || activeStudy.analysis_config.preset;
                return (
                  <span style={{ fontSize: 10, color: C.blue, background: C.blueBg, border: `1px solid ${C.blueBorder}`, borderRadius: 4, padding: '1px 6px', marginLeft: 4 }}>
                    {presetLabel}
                  </span>
                );
              })()}
            </div>

            {isArchive && (
              <div style={{ display: 'flex', gap: 0, flexWrap: 'wrap', marginTop: 2 }}>
                <ModeButton active={archiveMode === 'overview'} title="Dữ liệu tổng quát" hint="Số lượng, độ đầy đủ và danh sách người bệnh" onClick={() => setArchiveMode('overview')} />
                <ModeButton active={archiveMode === 'update'} title="Thu thập dữ liệu" hint="Quét, lấy dữ liệu và kiểm soát lỗi" onClick={() => setArchiveMode('update')} />
                <ModeButton active={archiveMode === 'patient'} title="Tra cứu người bệnh" hint="Xem toàn bộ các lần điều trị" onClick={() => setArchiveMode('patient')} />
                <ModeButton active={archiveMode === 'variables'} title="Tạo nghiên cứu" hint="Chọn biến và tạo bộ nghiên cứu" onClick={() => setArchiveMode('variables')} />
              </div>
            )}

            {(isArchive ? archiveMode === 'update' : true) && (
              <div style={{ display: 'grid', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                  {isArchive && (
                    <button
                      type="button"
                      onClick={runSimpleListScan}
                      disabled={uiBusy}
                      style={{
                        height: 34, padding: '0 14px', borderRadius: 6, cursor: uiBusy ? 'not-allowed' : 'pointer',
                        border: `1px solid ${C.border}`, background: C.surface, color: C.text,
                        fontFamily: 'inherit', fontSize: 11.5, fontWeight: 750, opacity: uiBusy ? 0.6 : 1,
                      }}
                    >
                      {uiBusy && automationRun.kind === 'scan' ? 'Đang quét…' : '1. Quét danh sách'}
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={runSimpleDataCollection}
                    disabled={uiBusy || (isArchive ? !archive?.latest_run?.id : !activeStudy?.has_cohort)}
                    style={{
                      height: 34, padding: '0 16px', borderRadius: 6,
                      cursor: uiBusy ? 'not-allowed' : 'pointer',
                      border: `1px solid ${C.blue}`, background: C.blue, color: '#fff',
                      fontFamily: 'inherit', fontSize: 11.5, fontWeight: 750,
                      opacity: (uiBusy || (isArchive ? !archive?.latest_run?.id : !activeStudy?.has_cohort)) ? 0.55 : 1,
                    }}
                  >
                    {uiBusy && automationRun.kind === 'collect' ? 'Đang lấy…' : `${isArchive ? '2. ' : ''}Lấy dữ liệu`}
                  </button>
                  <span style={{ fontSize: 10.5, color: C.text3 }}>
                    Chuẩn hóa và cập nhật kho chạy tự động.
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {isArchive && (
                    <>
                      <span style={{ fontSize: 10, color: C.text3, fontWeight: 850 }}>KHOẢNG QUÉT</span>
                      <input type="date" value={archiveOptions.fromDate}
                        onChange={e => setArchiveOptions(p => ({ ...p, fromDate: e.target.value }))}
                        disabled={uiBusy} style={{ ...inp, width: 128 }} />
                      <span style={{ color: C.text3 }}>—</span>
                      <input type="date" value={archiveOptions.toDate}
                        onChange={e => setArchiveOptions(p => ({ ...p, toDate: e.target.value }))}
                        disabled={uiBusy} style={{ ...inp, width: 128 }} />
                      <Btn onClick={() => setArchiveOptions(p => ({ ...p, toDate: todayInputDate() }))} disabled={uiBusy} style={actionBtn}>Hôm nay</Btn>
                    </>
                  )}
                  <details style={{ marginLeft: isArchive ? 'auto' : 0 }}>
                    <summary style={{ cursor: 'pointer', fontSize: 11, color: C.text3, fontWeight: 800 }}>Cài đặt chạy</summary>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 7, fontSize: 11, color: C.text2 }}>
                      <input type="checkbox"
                        checked={isArchive ? archiveOptions.headless : studyOptions.headless}
                        onChange={e => isArchive
                          ? setArchiveOptions(p => ({ ...p, headless: e.target.checked }))
                          : setStudyOptions(p => ({ ...p, headless: e.target.checked }))}
                        disabled={uiBusy}
                      />
                      Chạy ẩn, không mở cửa sổ Chrome
                    </label>
                  </details>
                  {!isArchive && table === 'cohort' && (
                    editMode
                      ? <>
                          <Btn variant="success" onClick={saveEditedCohort} disabled={uiBusy} style={actionBtn}>Lưu danh sách mẫu</Btn>
                          <Btn onClick={() => setEditMode(false)} disabled={uiBusy} style={actionBtn}>Huỷ</Btn>
                        </>
                      : <Btn onClick={() => setEditMode(true)} disabled={uiBusy} style={actionBtn}>Sửa danh sách mẫu</Btn>
                  )}
                </div>

                {automationRun.status !== 'idle' && (
                  <div style={{ border: `1px solid ${C.border2}`, background: C.surface2, borderRadius: 7, padding: '8px 10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 10.5, fontWeight: 750, color: automationRun.status === 'error' ? C.red : ['warning', 'cancelled'].includes(automationRun.status) ? C.amber : automationRun.status === 'done' ? C.green : C.text }}>
                      {automationRun.status === 'running' && <Spinner size={8} />}
                      {automationRun.status === 'running' ? automationRun.current : automationRun.status === 'done' ? 'Đã hoàn tất' : automationRun.status === 'warning' ? 'Hoàn tất, có cảnh báo' : automationRun.status === 'cancelled' ? 'Đã dừng theo yêu cầu' : 'Đã dừng do lỗi'}
                    </div>
                    {(automationRun.steps.length > 0 || automationRun.error || automationRun.warning) && (
                      <details style={{ marginTop: 5 }}>
                        <summary style={{ cursor: 'pointer', fontSize: 10, color: C.text3 }}>Chi tiết quy trình</summary>
                        <div style={{ display: 'grid', gap: 4, marginTop: 6 }}>
                          {automationRun.steps.map((step, index) => {
                            const tone = step.status === 'error' ? C.red : ['warning', 'cancelled'].includes(step.status) ? C.amber : step.status === 'done' ? C.green : step.status === 'running' ? C.blue : C.text3;
                            const symbol = step.status === 'done' ? '✓' : step.status === 'error' ? '!' : step.status === 'warning' ? '!' : step.status === 'cancelled' ? '■' : step.status === 'running' ? '…' : '·';
                            return <div key={`${step.label}_${index}`} style={{ fontSize: 10, color: tone }}>{symbol} {step.label}{step.detail ? ` — ${step.detail}` : ''}</div>;
                          })}
                          {automationRun.error && <div style={{ fontSize: 10, color: C.red }}>Lỗi: {automationRun.error}</div>}
                          {automationRun.warning && <div style={{ fontSize: 10, color: C.amber }}>{automationRun.warning}</div>}
                        </div>
                      </details>
                    )}
                  </div>
                )}

                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                  padding: '7px 0', borderTop: `1px solid ${C.border2}`, background: C.surface,
                }}>
                  <span style={{ fontSize: 10.5, color: C.text3 }}>Tiến độ được lưu tự động.</span>
                  <Btn onClick={() => loadProgressSnapshot(selectedId, { silent: false })} disabled={statusLoading || uiBusy} style={{ ...actionBtn, marginLeft: 'auto' }}>
                    {statusLoading ? <Spinner size={8} /> : 'Cập nhật'}
                  </Btn>
                  <Btn onClick={() => { setShowLog(true); loadLog(); }} disabled={logLoading} style={actionBtn}>Log</Btn>
                </div>
              </div>
            )}
          </div>

          {/* ── Panel lấy lại chỗ thiếu ── */}
          {showMissingPanel && (
            <div style={{ padding: '10px 14px', borderBottom: `1px solid ${C.amberBorder}`, background: C.amberBg, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, fontWeight: 650, color: C.amber }}>Bổ sung phần thiếu:</span>
              {[
                { id: 'profile',       label: 'Hồ sơ nền' },
                { id: 'discharge',     label: 'Ra viện' },
                { id: 'surgery',       label: 'Phẫu thuật' },
                { id: 'order_history', label: 'Y lệnh' },
                { id: 'xn_cdha',       label: 'XN & CĐHA' },
              ].map(({ id, label }) => (
                <label key={id} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: C.text2, cursor: 'pointer' }}>
                  <input type="checkbox"
                    checked={missingTypes.includes(id)}
                    onChange={e => setMissingTypes(prev => e.target.checked ? [...prev, id] : prev.filter(x => x !== id))}
                  />
                  {label}
                </label>
              ))}
              <Btn variant="solidWarn" onClick={runRefetchMissing} disabled={uiBusy || !missingTypes.length} style={{ height: 26, padding: '0 12px', fontSize: 11 }}>
                {uiBusy ? <><Spinner size={9} /> Đang lấy lại</> : 'Chạy'}
              </Btn>
              <span style={{ fontSize: 10, color: C.amber }}>Chỉ xử lý BN/lượt còn thiếu hoặc lỗi, bỏ qua dòng đã đủ.</span>
              {missingTypes.includes('xn_cdha') && (
                <span style={{ fontSize: 10, color: C.text3 }}>XN/CĐHA: chạy lấy lại ngay trên danh sách BN/lượt còn thiếu.</span>
              )}
            </div>
          )}

          {/* ── Panel cấu hình phân tích (chỉ hiện khi chọn study riêng) ── */}
          {showConfigPanel && !isArchive && (
            <div style={{ padding: '12px 14px', borderBottom: `1px solid ${C.blueBorder}`, background: C.blueBg, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: C.blue }}>Cấu hình phân tích:</span>
                <select value={editConfig.preset}
                  onChange={e => setEditConfig(p => ({ ...p, preset: e.target.value }))}
                  style={{ fontSize: 11, padding: '3px 8px', borderRadius: 6, border: `1px solid ${C.border}`, background: C.surface, color: C.text }}>
                  {(analysisPresets.length ? analysisPresets : [
                    { id: 'ortho_fracture', label: 'Chấn thương chỉnh hình — Gãy xương' },
                    { id: 'ortho_joint',    label: 'Chấn thương chỉnh hình — Khớp / Thay khớp' },
                    { id: 'neuro_spine',    label: 'Thần kinh — Cột sống / Tủy sống' },
                    { id: 'neuro_brain',    label: 'Thần kinh — Sọ não / Đột quỵ' },
                    { id: 'general',        label: 'Tổng quát (không inference)' },
                  ]).map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
                <button type="button"
                  onClick={() => setEditConfig(p => ({ ...p, custom_fields: [...(p.custom_fields || []), { name: '', pattern: '', label: '' }] }))}
                  style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.text2, borderRadius: 5, padding: '2px 8px', fontSize: 11, cursor: 'pointer' }}>
                  + Trường tuỳ chỉnh
                </button>
              </div>
              {(editConfig.custom_fields || []).map((cf, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '160px 1fr 28px', gap: 6, alignItems: 'center' }}>
                  <input value={cf.name}
                    onChange={e => setEditConfig(p => { const cfs = [...p.custom_fields]; cfs[i] = { ...cfs[i], name: e.target.value }; return { ...p, custom_fields: cfs }; })}
                    placeholder="Tên cột" style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, border: `1px solid ${C.border}`, background: C.surface, color: C.text }} />
                  <input value={cf.pattern}
                    onChange={e => setEditConfig(p => { const cfs = [...p.custom_fields]; cfs[i] = { ...cfs[i], pattern: e.target.value }; return { ...p, custom_fields: cfs }; })}
                    placeholder="Regex (VD: đái tháo đường|diabetes)" style={{ fontSize: 11, padding: '3px 8px', borderRadius: 5, border: `1px solid ${C.border}`, background: C.surface, color: C.text }} />
                  <button type="button" onClick={() => setEditConfig(p => ({ ...p, custom_fields: p.custom_fields.filter((_, j) => j !== i) }))}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.text3, fontSize: 16 }}>✕</button>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8 }}>
                <Btn variant="primary" onClick={saveAnalysisConfig} disabled={uiBusy} style={{ height: 26, padding: '0 12px', fontSize: 11 }}>
                  {busy ? <><Spinner size={9} /> Lưu</> : '✓ Lưu & đóng'}
                </Btn>
                <Btn onClick={() => setShowConfigPanel(false)} style={{ height: 26, padding: '0 10px', fontSize: 11 }}>Huỷ</Btn>
                <span style={{ fontSize: 10, color: C.text3, alignSelf: 'center' }}>Sau khi lưu, bấm "Chuẩn hóa" để sinh lại analysis_ready với cấu hình mới.</span>
              </div>
            </div>
          )}

          {!isArchive && (
            <div style={{ padding: 10, borderBottom: `1px solid ${C.border}`, background: C.bg, flexShrink: 0 }}>
              <ResearchOperationDashboard
                snapshot={operationSnapshot}
                lastUpdate={lastUpdateSummary}
                loading={statusLoading}
                onRefresh={() => loadProgressSnapshot(selectedId, { silent: false })}
              />
            </div>
          )}

          {isArchive ? (
            <div style={{ flex: 1, overflow: 'auto', minHeight: 0, background: C.bg }}>
              {renderArchiveWorkspace()}
            </div>
          ) : (
            <>
          {/* ── Tab bar ── */}
          <div style={{
            display: 'flex', alignItems: 'stretch', gap: 0,
            padding: '0 12px', flexShrink: 0, minHeight: 36,
            borderBottom: `1px solid ${C.border}`, background: C.bg,
            overflowX: 'auto', overflowY: 'hidden',
          }}>
            {tabGroups.map((group, gi) => (
              <div key={gi} style={{ display: 'flex', alignItems: 'stretch', gap: 0, flexShrink: 0 }}>
                {gi > 0 && <div style={{ width: 1, background: C.border2, margin: '8px 4px', flexShrink: 0 }} />}
                {group.ids.map(id => {
                  const label = tableLabel(id, isArchive);
                  const cnt   = datasetCount(activeSource, id, isArchive);
                  const active = table === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setTable(id)}
                      style={{
                        height: 32, padding: '0 9px',
                        border: 0, borderBottom: `2px solid ${active ? C.blue : 'transparent'}`,
                        background: 'transparent',
                        color: active ? C.blue : C.text2,
                        cursor: 'pointer', fontSize: 11, fontWeight: active ? 800 : 600,
                        whiteSpace: 'nowrap',
                        transition: 'color 0.12s, border-color 0.12s',
                      }}
                    >
                      {label}
                      {cnt > 0 && (
                        <span style={{
                          marginLeft: 5, fontSize: 9, fontWeight: 700,
                          color: active ? C.blue : C.text3,
                          background: active ? C.blueBg : C.surface2,
                          border: `1px solid ${active ? C.blueBorder : C.border2}`,
                          borderRadius: 3, padding: '0 4px',
                        }}>{compactNumber(cnt)}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {/* ── Filter bar ── */}
          <div style={{
            padding: '6px 12px', borderBottom: `1px solid ${C.border2}`,
            background: C.surface, flexShrink: 0,
            display: 'grid', gap: 5,
          }}>
            {/* Row 1: inputs */}
            <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                value={filters.q}
                onChange={e => setFilters(p => ({ ...p, q: e.target.value }))}
                placeholder={isArchive ? 'Họ tên, Mã BN, xét nghiệm...' : 'Tên xét nghiệm, chẩn đoán...'}
                style={{ ...inp, flex: '1 1 200px', minWidth: 0 }}
              />
              <input
                value={filters.patient}
                onChange={e => setFilters(p => ({ ...p, patient: e.target.value }))}
                placeholder="Mã NC / BN..."
                style={{ ...inp, width: 130, flexShrink: 0 }}
              />
              <input type="date" value={filters.from}
                onChange={e => setFilters(p => ({ ...p, from: e.target.value }))}
                style={{ ...inp, width: 126, flexShrink: 0 }} />
              <input type="date" value={filters.to}
                onChange={e => setFilters(p => ({ ...p, to: e.target.value }))}
                style={{ ...inp, width: 126, flexShrink: 0 }} />
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: C.text2, whiteSpace: 'nowrap' }}>
                <input type="checkbox" checked={filters.hideSensitive}
                  onChange={e => setFilters(p => ({ ...p, hideSensitive: e.target.checked }))} />
                Ẩn định danh
              </label>
              {(filters.q || filters.patient || filters.from || filters.to || !filters.hideSensitive) && (
                <Btn onClick={resetFilters} style={{ height: 28, padding: '0 8px', fontSize: 11 }}>✕ Xoá lọc</Btn>
              )}
            </div>
            {/* Row 2: count + actions — luôn hiển thị đủ */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 10, color: C.text3 }}>
                {compactNumber(filteredRows.length)}/{compactNumber(rows.length)} dòng
              </span>
              <Btn onClick={() => loadTable(selectedId, table)} disabled={tableLoading || busy} style={{ height: 26, padding: '0 8px', fontSize: 11 }}>
                {tableLoading ? <><Spinner size={9} /> Đang tải</> : '↻ Tải lại'}
              </Btn>
              <Btn variant="success" onClick={exportCurrent} disabled={!filteredRows.length} style={{ height: 26, padding: '0 10px', fontSize: 11 }}>
                ⬇ Xuất CSV
              </Btn>
            </div>
          </div>

          {/* ── Table ── */}
          <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
            {initialLoading && (
              <div style={{ padding: 24, color: C.text2, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Spinner size={12} /> Đang tải dữ liệu...
              </div>
            )}
            {!initialLoading && !tableLoading && !rows.length && (
              <EmptyState
                title="Chưa có dữ liệu"
                hint={isArchive
                  ? 'Bấm Bước 1 — Quét danh sách để tạo danh sách ban đầu, sau đó Bước 2 — Lấy XN & CĐHA để lấy dữ liệu lâm sàng.'
                  : 'Nghiên cứu riêng sẽ được thiết lập từ dữ liệu gốc ở phần khác.'}
              />
            )}
            {rows.length > 0 && (
              <div style={{ opacity: tableLoading ? 0.5 : 1, transition: 'opacity 0.2s' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, tableLayout: 'fixed' }}>
                <thead style={{ position: 'sticky', top: 0, background: C.surface2, zIndex: 2 }}>
                  <tr>
                    {editMode && <th style={{ width: 28, borderBottom: `1px solid ${C.border}` }} />}
                    {visibleColumns.map((col, ci) => {
                      const isLong = /thuốc|chi tiết|chẩn đoán|mô tả|kết luận|dòng/i.test(col);
                      const isLast = ci === visibleColumns.length - 1;
                      const w = isLast ? undefined : isLong ? 320 : /họ tên|ho ten|patient_name/i.test(col) ? 200 : /t\/g|ngày|thời gian/i.test(col) ? 140 : /mã bn|mã nc|mã vào/i.test(col) ? 110 : /tuổi|age/i.test(col) ? 60 : /gt|giới/i.test(col) ? 60 : 130;
                      return (
                        <th key={col} style={{
                          textAlign: 'left', padding: '7px 10px',
                          borderBottom: `1px solid ${C.border}`,
                          color: C.text2, fontWeight: 800, fontSize: 11,
                          whiteSpace: 'nowrap', letterSpacing: '0.02em',
                          width: w, overflow: 'hidden',
                        }}>{col}</th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.slice(0, 1000).map((row, idx) => (
                    <tr key={idx} style={{ borderBottom: `1px solid ${C.border2}` }}
                      onMouseEnter={e => e.currentTarget.style.background = C.surface2}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      {editMode && (
                        <td style={{ padding: '0 6px', width: 28, textAlign: 'center' }}>
                          <button type="button"
                            onClick={() => setRows(prev => prev.filter((_, i) => i !== idx))}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.red, fontSize: 15, lineHeight: 1 }}>✕</button>
                        </td>
                      )}
                      {visibleColumns.map((col, ci) => {
                        const isCode = col === 'Mã NC';
                        const isLong = /thuốc|chi tiết|chẩn đoán|mô tả|kết luận|dòng/i.test(col);
                        const isLast = ci === visibleColumns.length - 1;
                        return (
                          <td key={col} style={{
                            padding: '7px 10px',
                            color: isCode ? C.blue : C.text2,
                            fontWeight: isCode ? 800 : 500,
                            verticalAlign: 'top',
                            whiteSpace: isLong ? 'pre-wrap' : 'nowrap',
                            overflow: 'hidden',
                            textOverflow: isLast ? 'clip' : 'ellipsis',
                          }}>{text(row?.[col]) || <span style={{ color: C.text3 }}>—</span>}</td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
            {tableLoading && rows.length > 0 && (
              <div style={{ padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 6, borderTop: `1px solid ${C.border2}` }}>
                <Spinner size={9} /><span style={{ fontSize: 11, color: C.text3 }}>Đang cập nhật...</span>
              </div>
            )}
            {!loading && !tableLoading && filteredRows.length > 1000 && (
              <div style={{ padding: '8px 12px', color: C.text3, fontSize: 11, borderTop: `1px solid ${C.border2}` }}>
                Hiển thị 1.000 dòng đầu · Xuất CSV để lấy toàn bộ {compactNumber(filteredRows.length)} dòng.
              </div>
            )}
          </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
