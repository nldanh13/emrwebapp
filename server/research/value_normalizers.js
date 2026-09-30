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

function normalizeDrugName(value) {
  return normalizeToken(String(value || '').replace(/\([^)]*\)/g, ''));
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
  normalizeFlag,
  modalityFromService,
  bodyRegionFromService,
  normalizeDrugName,
  normalizeRoute,
  classifyDrugGroup,
};
