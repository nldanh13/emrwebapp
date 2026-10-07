const LAB_GROUP_ORDER = [
  'Huyết học',
  'Đông máu',
  'Điện giải',
  'Sinh hóa',
  'Miễn dịch / dấu ấn',
  'Nước tiểu',
  'Vi sinh',
  'Nội tiết',
  'Khác',
];

const IMAGING_GROUP_ORDER = [
  'X-quang',
  'CT',
  'MRI',
  'Siêu âm',
  'DEXA',
  'Điện tim / thăm dò chức năng',
  'Khác',
];

function simple(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9+%]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function explicitLabGroup(value) {
  const s = simple(value);
  if (!s) return '';
  if (/huyet hoc|hematolog|cong thuc mau/.test(s)) return 'Huyết học';
  if (/dong mau|coag|hemosta/.test(s)) return 'Đông máu';
  if (/dien giai|electroly/.test(s)) return 'Điện giải';
  if (/sinh hoa|hoa sinh|biochem/.test(s)) return 'Sinh hóa';
  if (/mien dich|immun|dau an/.test(s)) return 'Miễn dịch / dấu ấn';
  if (/nuoc tieu|urine|urinal/.test(s)) return 'Nước tiểu';
  if (/vi sinh|microbio|cay|culture/.test(s)) return 'Vi sinh';
  if (/noi tiet|hormon|endocr/.test(s)) return 'Nội tiết';
  return '';
}

export function labGroupLabel(row = {}) {
  const explicit = explicitLabGroup(row.lab_group);
  if (explicit) return explicit;

  const s = simple([row.test_name_norm, row.test_name_raw].filter(Boolean).join(' '));

  if (/\b(wbc|rbc|hgb|hb|hemoglobin|hematocrit|hct|mcv|mch|mchc|plt|platelet|mpv|pct|pdw|rdw|neu|neut|neutrophil|lym|lymph|lymphocyte|mono|monocyte|eos|eosinophil|baso|basophil|nrbc|reticulocyte)\b/.test(s)) {
    return 'Huyết học';
  }

  if (/\b(pt|pt%|inr|aptt|a ptt|fibrinogen|d dimer|ddimer|thrombin|anti xa)\b/.test(s)) {
    return 'Đông máu';
  }

  if (/dien giai|\b(sodium|natri|na\+?|potassium|kali|k\+?|chloride|cl\-?|calcium|canxi|magnesium|magi[eê]|phosph|phosphate)\b/.test(s)) {
    return 'Điện giải';
  }

  if (/\b(creatinine|creatinin|egfr|urea|ure|glucose|ast|got|alt|gpt|bilirubin|albumin|protein|acid uric|uric|amylase|lipase|ck|ldh|lactate|cholesterol|triglyceride|hdl|ldl)\b/.test(s)) {
    return 'Sinh hóa';
  }

  if (/\b(crp|procalcitonin|pct viem|ferritin|troponin|nt probnp|probnp|hbsag|hcv|hiv|rf|ana|anti ccp)\b/.test(s)) {
    return 'Miễn dịch / dấu ấn';
  }

  if (/nuoc tieu|urine|urinal|protein nieu|hong cau nieu|bach cau nieu/.test(s)) return 'Nước tiểu';
  if (/vi sinh|culture|cay mau|cay dom|khang sinh do|gram|afb|pcr/.test(s)) return 'Vi sinh';
  if (/\b(tsh|ft4|ft3|cortisol|insulin|hba1c|pth|prolactin|testosterone|estradiol)\b/.test(s)) return 'Nội tiết';

  return 'Khác';
}

function groupRows(rows, labelFor, order) {
  const buckets = new Map();
  for (const row of rows || []) {
    const label = labelFor(row);
    if (!buckets.has(label)) buckets.set(label, []);
    buckets.get(label).push(row);
  }
  return order
    .filter(label => buckets.has(label))
    .map(label => ({ label, rows: buckets.get(label) }));
}

export function groupLabRows(rows = []) {
  return groupRows(rows, labGroupLabel, LAB_GROUP_ORDER);
}

export function imagingGroupLabel(row = {}) {
  const modality = simple(row.modality);
  const service = simple(row.service_name_raw);
  const s = `${modality} ${service}`.trim();

  if (/x quang|xquang|x ray|xray|\bxq\b/.test(s)) return 'X-quang';
  if (/\bct\b|cat lop|scanner/.test(s)) return 'CT';
  if (/\bmri\b|cong huong tu/.test(s)) return 'MRI';
  if (/sieu am|ultrasound|doppler/.test(s)) return 'Siêu âm';
  if (/dexa|mat do xuong/.test(s)) return 'DEXA';
  if (/dien tim|\becg\b|tham do chuc nang/.test(s)) return 'Điện tim / thăm dò chức năng';
  return 'Khác';
}

export function groupImagingRows(rows = []) {
  return groupRows(rows, imagingGroupLabel, IMAGING_GROUP_ORDER);
}
