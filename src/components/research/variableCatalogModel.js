// Mô hình danh mục biến: nhãn dễ đọc, nhóm lâm sàng, mức đủ dữ liệu, gộp biến chung của các bảng rộng.
import { text, lower } from './researchFormat.js';
import { C } from '../../tokens.js';

const VARIABLE_FRIENDLY_LABELS = {
  research_code: 'Mã nghiên cứu',
  patient_key: 'Mã người bệnh giả danh',
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
  diagnosis_raw: 'Chẩn đoán',
  admission_diagnosis: 'Chẩn đoán vào viện',
  comorbidity_text: 'Bệnh kèm',
  complication_text: 'Biến chứng',
  encounter_count: 'Số đợt điều trị',
  time_to_surgery_hours: 'Số giờ chờ mổ',
  days_from_admission: 'Số ngày từ lúc vào viện',
  days_from_surgery: 'Số ngày từ lúc phẫu thuật',
  days_from_discharge: 'Số ngày từ lúc ra viện',
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
  active_ingredient: 'Hoạt chất (ghi trong y lệnh)',
  active_ingredient_source: 'Nguồn xác định hoạt chất',
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

const VARIABLE_TECHNICAL_RE = /(^row_|_hash$|hash|source_|raw_row|debug|internal|session|cookie|token|password|secret|(^|_)id$|patient_key|encounter_id|lab_result_id|imaging_id|med_order_id|diagnosis_id|surgery_id)/i;

const VARIABLE_IDENTITY_RE = /(patient_name|patient_code|patient_codes|phone|citizen|cccd|cmnd|address|dia_chi|bhyt|insurance|research_code|emr_admission_id|emr_treatment_id|so_benh_an|medical_record)/i;

const VARIABLE_RECOMMENDED_TABLES = new Set(['analysis_ready', 'encounters', 'lab_results', 'imaging_results', 'medication_orders', 'diagnoses', 'surgery_results']);

function humanizeVariableName(name) {
  const raw = text(name);
  const key = raw.toLowerCase();
  if (VARIABLE_FRIENDLY_LABELS[key]) return VARIABLE_FRIENDLY_LABELS[key];
  // Nhãn đã là chữ thường dùng (có dấu cách/dấu tiếng Việt, vd. "Dùng thuốc: zoledronic acid"):
  // chỉ viết hoa chữ đầu. \b\w của JS coi chữ có dấu là ngắt từ nên sẽ ra "DùNg ThuốC".
  if (!/^[a-z0-9_]+$/i.test(raw)) return raw.charAt(0).toUpperCase() + raw.slice(1);
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

// Bảng tổng quát, Đợt điều trị và Người bệnh đều là bảng rộng có chung nhiều cột
// (sex, age, birth_year, admission_date...). Cùng tên cột ở các bảng này là cùng một
// biến: chỉ hiện một lần, ưu tiên Bảng tổng quát (mỗi dòng một đợt, là nền của dataset).
// Bảng dài (XN, CĐHA, thuốc...) không gộp: cùng tên cột nhưng khác nghĩa theo bảng.
const VARIABLE_WIDE_TABLE_PRIORITY = ['analysis_ready', 'encounters', 'patients'];

function dedupeWideTableVariables(variables) {
  const keep = new Map();
  for (const table of VARIABLE_WIDE_TABLE_PRIORITY) {
    for (const v of variables) {
      if (v.table !== table || v.virtual_kind) continue;
      const key = lower(v.name);
      const first = keep.get(key);
      if (!first) keep.set(key, { ...v, also_in: [] });
      else if (!first.also_in.includes(v.source_group_label)) first.also_in.push(v.source_group_label);
    }
  }
  const out = [];
  for (const v of variables) {
    if (!VARIABLE_WIDE_TABLE_PRIORITY.includes(v.table) || v.virtual_kind) { out.push(v); continue; }
    const kept = keep.get(lower(v.name));
    if (kept && kept.id === v.id) out.push(kept);
  }
  return out;
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
  ['closest_before_anchor', 'Gần trước mốc nhất'],
  ['closest_after_anchor', 'Gần sau mốc nhất'],
];

// Cách lấy theo mốc chỉ có nghĩa khi nghiên cứu đã đặt mốc thời gian.
const ANCHOR_AGGREGATIONS = new Set(['closest_before_anchor', 'closest_after_anchor']);

// Biến dẫn xuất kiểu "có/không" (dùng hoạt chất/thuốc/nhóm thuốc, có CĐHA, có phẫu thuật): mặc định
// xuất Có (1) / Không (0) cho mỗi lượt. Liệt kê giá trị sẽ ra tên thuốc/dịch vụ, và lượt không dùng bị
// tính là "thiếu dữ liệu".
const PRESENCE_VIRTUAL_KINDS = new Set(['active_ingredient', 'drug_item', 'drug_group', 'imaging_modality', 'procedure_item']);

function isPresenceVariable(variable) {
  return PRESENCE_VIRTUAL_KINDS.has(String(variable?.virtual_kind || ''));
}

function defaultAggregationFor(variable) {
  return isPresenceVariable(variable) ? 'any' : 'list';
}

function aggregationLabel(value) {
  return VARIABLE_AGGREGATIONS.find(([key]) => key === value)?.[1] || 'Liệt kê giá trị';
}

// ── Ghép dòng trên phiếu khảo sát với biến trong kho ──────────────────────────
const plain = (value) => String(value ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, ' ').trim();
// Bỏ phần chú thích/đơn vị trên phiếu: "Chiều cao: ....... (cm)" → "chieu cao".
// Phần sau dấu ":" là chỗ điền/ô lựa chọn nên bỏ; không có ":" thì bỏ chú thích trong ngoặc tròn.
const surveyKey = (line) => {
  const text = String(line).replace(/^\s*\d+[.)]\s*/, '');
  const head = text.includes(':') ? text.split(':')[0] : text.replace(/\((?:[^()]*)\)\s*$/g, ' ');
  return plain(head.replace(/[.…_☐]+/g, ' '));
};
// Từ chung chung trên phiếu/danh mục, không giúp phân biệt biến.
const STOP_WORDS = new Set(['va', 'cua', 'trong', 'co', 'khong', 'la', 'cac', 'nhung', 'so', 'muc', 'do', 'ty', 'le', 'ngay', 'gio',
  'su', 'dung', 'nhom', 'thuoc', 'luong', 'nong', 'chi', 'xet', 'nghiem', 'ket', 'qua', 'benh', 'tien', 'tinh', 'trang']);
const words = (text) => plain(text).split(' ').filter(w => w.length >= 2 && !STOP_WORDS.has(w));

function matchScore(key, variable) {
  const label = plain(variable.display_label);
  const raw = plain(variable.raw_name);
  if (!key) return 0;
  if (key === label || key === raw) return 100;
  let score = 0;
  if (label.length >= 3 && (label.includes(key) || key.includes(label))) score = 70 - Math.abs(label.length - key.length) / 4;
  const a = new Set(words(key));
  const b = new Set([...words(variable.display_label), ...words(variable.raw_name)]);
  if (a.size && b.size) {
    // Khớp cả một phần từ (≥ 4 ký tự): "statin" ↔ "atorvastatin".
    const common = [...a].reduce((n, w) => n + (b.has(w) ? 1 : (w.length >= 4 && [...b].some(x => x.length >= 4 && (x.includes(w) || w.includes(x))) ? 0.8 : 0)), 0);
    score = Math.max(score, (common / a.size) * 55 * (common / Math.max(b.size, 1)) ** 0.3);
  }
  if (!score) return 0;
  return score + (variable.recommended ? 4 : 0) + Number(variable.fill_rate || 0) / 25;
}

// Chữ viết tắt trong ngoặc trên phiếu thường là tên xét nghiệm: "Số lượng Bạch cầu (WBC)" → "wbc".
const surveyKeys = (line) => {
  const head = String(line).includes(':') ? String(line).split(':')[0] : String(line);
  const inner = [...head.matchAll(/[([]([^()[\]]{2,30})[)\]]/g)].map(m => plain(m[1])).filter(k => k.length >= 2);
  return [surveyKey(line), ...inner].filter(Boolean);
};

// Mỗi dòng trên phiếu → tối đa 6 biến ứng viên, biến tốt nhất đứng đầu (điểm ≥ 30 mới coi là khớp).
function matchSurveyLines(lines, variables) {
  return lines.map(line => {
    const keys = surveyKeys(line);
    const candidates = variables
      .map(v => ({ v, score: Math.max(...keys.map(key => matchScore(key, v))) }))
      .filter(x => x.score > 0)
      .sort((x, y) => y.score - x.score)
      .slice(0, 6);
    return { line, candidates: candidates.map(x => x.v), best: candidates[0]?.score >= 30 ? candidates[0].v : null };
  });
}

function catalogSearchTokens(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .match(/[a-z0-9]+/g) || [];
}

function matchesCatalogQuery(variable, query) {
  const terms = catalogSearchTokens(query);
  if (!terms.length) return true;
  const searchable = [
    variable?.clinical_group_label,
    variable?.clinical_section,
    variable?.source_group_label,
    variable?.display_label,
    variable?.raw_name,
    variable?.description,
  ].filter(Boolean).join(' ');
  const words = new Set(catalogSearchTokens(searchable));
  return terms.every(term => [...words].some(word => word.startsWith(term)));
}

export {
  matchSurveyLines,
  matchesCatalogQuery,
  surveyKey,
  ANCHOR_AGGREGATIONS,
  VARIABLE_FRIENDLY_LABELS,
  VARIABLE_TECHNICAL_RE,
  VARIABLE_IDENTITY_RE,
  VARIABLE_RECOMMENDED_TABLES,
  humanizeVariableName,
  variableTypeLabel,
  variableTypeTone,
  variableCompletenessLabel,
  variableCompletenessTone,
  variableRole,
  VARIABLE_CLINICAL_GROUPS,
  CLINICAL_GROUP_BY_KEY,
  labSubgroupFromName,
  imagingSubgroupFromName,
  clinicalInfoForVariable,
  groupVariablesBySection,
  variableDescription,
  enhanceCatalogVariable,
  VARIABLE_WIDE_TABLE_PRIORITY,
  dedupeWideTableVariables,
  variableRoleLabel,
  operatorLabel,
  VARIABLE_AGGREGATIONS,
  aggregationLabel,
  PRESENCE_VIRTUAL_KINDS,
  isPresenceVariable,
  defaultAggregationFor,
};
