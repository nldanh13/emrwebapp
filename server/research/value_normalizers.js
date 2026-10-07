'use strict';

// Chuẩn hóa giá trị lâm sàng: giới, năm sinh, tên XN, kết quả số/toán tử/cờ, loại CĐHA, thuốc và đường dùng.

const { normalizeSimple, normalizeToken } = require('./encounter_context');
const routeModel = require('../utils/routeModel');

function normalizeSex(value) {
  const s = normalizeSimple(value);
  if (!s) return '';
  if (s.startsWith('nam') || s === 'm' || s === 'male') return 'Nam';
  if (s.startsWith('nu') || s === 'f' || s === 'female') return 'Nữ';
  return String(value || '').trim();
}

function extractBirthYear(value) {
  const m = String(value || '').match(/\b(19\d{2}|20\d{2})\b/);
  return m ? m[1] : '';
}

function normalizeLabName(value) {
  const s = normalizeSimple(value);
  const rules = [
    [/creatinin|creatinine/, 'creatinine'],
    [/egfr|muc loc cau than|loc cau than/, 'egfr'],
    [/bach cau|wbc|white blood/, 'wbc'],
    [/crp|c reactive/, 'crp'],
    [/hemoglobin|hgb|hb\b/, 'hemoglobin'],
    [/hematocrit|hct|dung tich hong cau/, 'hct'],
    [/neutrophil|bach cau trung tinh|neu\b|neut\b/, 'neutrophil'],
    [/lymphocyte|lympho|lym\b/, 'lymphocyte'],
    [/monocyte|mono\b/, 'monocyte'],
    [/rdw/, 'rdw'],
    [/tieu cau|plt|platelet/, 'platelet'],
    [/ure|urea/, 'urea'],
    [/ast|got/, 'ast'],
    [/alt|gpt/, 'alt'],
    [/duong mau|glucose/, 'glucose'],
  ];
  for (const [re, key] of rules) if (re.test(s)) return key;
  return normalizeToken(value);
}

function resultOperator(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(<=|>=|<|>|≤|≥|=)/);
  if (!m) return '';
  return m[1].replace('≤', '<=').replace('≥', '>=');
}

function parseNumeric(value) {
  const s = String(value || '').replace(',', '.');
  const m = s.match(/[-+]?\d+(?:\.\d+)?/);
  return m ? m[0] : '';
}

function resultText(value) {
  const n = parseNumeric(value);
  if (!n) return String(value || '').trim();
  const stripped = String(value || '').replace(',', '.').replace(n, '').trim();
  return stripped && !/^[<>≤≥=\s.]+$/.test(stripped) ? String(value || '').trim() : '';
}

// T-score from a DXA/DEXA report. Return a plain decimal string so it can be
// summarized as a numeric variable; leave Z-scores and unrelated measurements untouched.
const TSCORE_SITES = [
  { key: 'neck_left', label: 'Neck Left', pattern: 'Neck\s+Left' },
  { key: 'neck_right', label: 'Neck Right', pattern: 'Neck\s+Right' },
  { key: 'total_left', label: 'Total Left', pattern: 'Total\s+Left' },
  { key: 'total_right', label: 'Total Right', pattern: 'Total\s+Right' },
  { key: 'l1', label: 'L1', pattern: 'L\s*1' },
  { key: 'l2', label: 'L2', pattern: 'L\s*2' },
  { key: 'l3', label: 'L3', pattern: 'L\s*3' },
  { key: 'l4', label: 'L4', pattern: 'L\s*4' },
];

function extractTScoresBySite(value) {
  const raw = String(value || '');
  const match = raw.match(/\bT\s*[-–—]?\s*score\b\s*[:=]?\s*([\s\S]*?)(?=\bZ\s*[-–—]?\s*score\b|$)/i);
  if (!match) return [];
  const section = match[1];
  const out = [];
  for (const site of TSCORE_SITES) {
    const re = new RegExp('(?:^|[\r\n;,])\\s*[\\\\+*•\\-]*\\s*(' + site.pattern + ')\\s*[:=]\\s*([-+]?\\d+(?:[.,]\\d+)?)', 'i');
    const found = section.match(re);
    if (!found) continue;
    const n = Number(found[2].replace(',', '.'));
    if (Number.isFinite(n)) out.push({ site: site.key, label: site.label, value: String(n) });
  }
  return out;
}

// Compatibility helper for unlabelled/simple single-score reports.
function extractTScore(value) {
  return extractTScoresBySite(value)[0]?.value || '';
}

function normalizeUnitToken(value) {
  return String(value || '').trim().toLowerCase().replace(/μ/g, 'µ').replace(/\s+/g, '');
}

function normalizeLabMeasurement(testNameNorm, resultNum, unitRaw) {
  const n = Number(String(resultNum ?? '').replace(',', '.'));
  const unitToken = normalizeUnitToken(unitRaw);
  if (!Number.isFinite(n)) return { result_num_norm: '', unit_norm: '', unit_conversion_status: 'non_numeric' };
  const same = unitNorm => ({ result_num_norm: String(Number(n.toFixed(6))), unit_norm: unitNorm, unit_conversion_status: 'same_unit' });
  const converted = (value, unitNorm) => ({ result_num_norm: String(Number(value.toFixed(6))), unit_norm: unitNorm, unit_conversion_status: 'converted' });

  if (testNameNorm === 'creatinine') {
    if (unitToken === 'µmol/l' || unitToken === 'umol/l') return same('µmol/L');
    if (unitToken === 'mg/dl') return converted(n * 88.4, 'µmol/L');
  }
  if (testNameNorm === 'glucose') {
    if (unitToken === 'mmol/l') return same('mmol/L');
    if (unitToken === 'mg/dl') return converted(n / 18, 'mmol/L');
  }
  if (testNameNorm === 'hemoglobin') {
    if (unitToken === 'g/l') return same('g/L');
    if (unitToken === 'g/dl') return converted(n * 10, 'g/L');
  }
  return { result_num_norm: '', unit_norm: '', unit_conversion_status: unitToken ? 'not_converted' : 'missing_unit' };
}

function normalizeFlag(value) {
  const s = normalizeSimple(value);
  if (!s) return '';
  if (/bat thuong|abnormal|\*/.test(s)) return 'abnormal';
  const high = /cao|high|tang|\bh\b/.test(s);
  const low = /thap|low|giam|\bl\b/.test(s);
  if (high && low) return 'abnormal';
  if (high) return 'high';
  if (low) return 'low';
  if (/bt|binh thuong|normal/.test(s)) return 'normal';
  return 'unknown';
}

function modalityFromService(value) {
  const s = normalizeSimple(value);
  if (/\bct\b|cat lop|scanner/.test(s)) return 'CT';
  if (/mri|cong huong tu/.test(s)) return 'MRI';
  if (/sieu am/.test(s)) return 'Siêu âm';
  if (/x quang|xquang|x ray|xray|\bxq\b/.test(s)) return 'X-quang';
  if (/mat do xuong|dexa/.test(s)) return 'DEXA';
  if (/dien tim|ecg/.test(s)) return 'Điện tim';
  return 'Khác';
}

function bodyRegionFromService(value) {
  const s = normalizeSimple(value);
  const regions = [
    [/nguc|phoi/, 'Ngực/phổi'],
    [/bung|o bung|gan|mat|tuy|than/, 'Bụng'],
    [/tim|mach/, 'Tim mạch'],
    [/cot song|that lung|co lung/, 'Cột sống'],
    [/goi/, 'Gối'],
    [/hang|khung chau|chau/, 'Há/khu chậu'],
    [/so nao|dau/, 'Sọ não'],
    [/co|tuyen giap/, 'Cổ'],
  ];
  for (const [re, label] of regions) if (re.test(s)) return label;
  return '';
}

function extractDrugNameFromOrderText(value) {
  const raw = String(value || '').replace(/\r\n?/g, '\n').trim();
  if (!raw) return '';
  const simple = normalizeSimple(raw);
  if (/^(?:thuc hien )?y lenh thuoc da co$|^thuoc da co$/.test(simple)) return '';

  let text = raw.replace(/^\((?:TT|CS)\)\s*/i, '').trim();
  text = text
    .replace(/^(?:Ngưng|Dừng|Dung)\s+(?:y lệnh\s+)?(?:thuốc\s+)?/i, '')
    .replace(/^(?:Duy trì|Tiếp tục)\s+(?:y lệnh\s+)?/i, '')
    .trim();

  const cut = text.search(/\s+(?=\d+(?:[.,]\d+)?\s*(?:mg|mcg|g|ml|iu|ui|đv|dv)\b|\d+\s*(?:v|viên|vien|ống|ong|chai|lọ|lo|gói|goi)\b|x\s*\d+\b|\((?:u|t|ttm|tdt|tdd)\)|\b(?:uống|uong|tiêm|tiem|truyền|truyen|ttm|tdt|tdd)\b)/i);
  const candidate = (cut >= 0 ? text.slice(0, cut) : text).replace(/[,:;\-]+$/g, '').trim();
  const candidateSimple = normalizeSimple(candidate);
  if (!candidateSimple || /^(?:y lenh|thuoc|khang sinh|y lenh khang sinh)$/.test(candidateSimple)) return '';
  if (/^(?:rut dan luu|thay bang|cat chi|tap van dong|cham soc|theo doi|xuat vien|tai kham)\b/.test(candidateSimple)) return '';
  return candidate.slice(0, 180);
}

function normalizeDrugName(value) {
  const drug = extractDrugNameFromOrderText(value);
  return drug ? normalizeToken(drug.replace(/\([^)]*\)/g, '')) : '';
}

// Đường dùng chuẩn cho dữ liệu nghiên cứu: nhận diện bằng model duy nhất
// (config/routes.json), xuất giá trị nghiên cứu ("research_value") của mã tìm được.
function normalizeRoute(value) {
  const code = routeModel.detectRouteCode(value);
  if (code) return routeModel.routeInfo(code).research_value;
  const s = normalizeSimple(value);
  return s ? normalizeToken(value) : '';
}

function classifyDrugGroup(value) {
  const s = normalizeSimple(value);
  if (!s) return '';
  const groups = [];
  if (/paracetamol|acetaminophen|perfalgan|efferalgan|panadol|hapacol|tramadol|morphin|morphine|fentanyl|pethidin|nalbuphin|nefopam|ketorolac|diclofenac|meloxicam|celecoxib|etoricoxib|ibuprofen|naproxen|gabapentin|pregabalin/.test(s)) groups.push('giảm_đau');
  if (/cefazolin|cefuroxim|ceftriaxon|ceftazidim|cefepim|cefixim|cephalexin|ampicillin|amoxicillin|augmentin|piperacillin|tazobactam|meropenem|imipenem|ertapenem|vancomycin|clindamycin|metronidazol|ciprofloxacin|levofloxacin|moxifloxacin|amikacin|gentamicin|linezolid/.test(s)) groups.push('kháng_sinh');
  if (/aspirin|clopidogrel|ticagrelor|prasugrel|dipyridamol/.test(s)) groups.push('kháng_kết_tập_tiểu_cầu');
  if (/heparin|enoxaparin|lovenox|rivaroxaban|apixaban|dabigatran|warfarin|acenocoumarol/.test(s)) groups.push('kháng_đông');
  if (/omeprazol|esomeprazol|pantoprazol|lansoprazol|rabeprazol|famotidin|ranitidin/.test(s)) groups.push('dạ_dày');
  if (/insulin|metformin|gliclazid|glimepirid|sitagliptin|dapagliflozin|empagliflozin/.test(s)) groups.push('đái_tháo_đường');
  return groups.join('; ');
}

module.exports = {
  normalizeSex,
  extractBirthYear,
  normalizeLabName,
  resultOperator,
  parseNumeric,
  resultText,
  normalizeLabMeasurement,
  extractTScore,
  extractTScoresBySite,
  normalizeFlag,
  modalityFromService,
  bodyRegionFromService,
  extractDrugNameFromOrderText,
  normalizeDrugName,
  normalizeRoute,
  classifyDrugGroup,
};
