'use strict';

// Parser cho lịch sử y lệnh/diễn biến thực tế của EMR.
// Mục tiêu: chỉ sinh biến có bằng chứng rõ trong text, giữ source_text để truy ngược,
// và không biến "không thấy nhắc" thành phủ định.

const { normalizeDrugName, normalizeRoute } = require('./value_normalizers');

function cleanText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function comparableText(value) {
  return cleanText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9.,%]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstCell(row, keys) {
  for (const key of keys) {
    const value = cleanText(row?.[key]);
    if (value) return value;
  }
  return '';
}

function dedupeOrderFields(row) {
  const clinical = firstCell(row, ['Diễn biến', 'Dien bien', 'clinical_text']);
  const orderName = firstCell(row, ['Tên y lệnh', 'Ten y lenh', 'order_name']);
  const orderOther = firstCell(row, ['Y lệnh khác', 'Y lenh khac', 'order_other']);
  const clinicalKey = comparableText(clinical);
  const seen = new Set();
  if (clinicalKey) seen.add(clinicalKey);

  const orderBlocks = [];
  for (const [sourceField, text] of [['order_name', orderName], ['order_other', orderOther]]) {
    const key = comparableText(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    orderBlocks.push({ source_field: sourceField, text });
  }
  return { clinical_text: clinical, order_blocks: orderBlocks };
}

function splitOrderLines(blocks) {
  const out = [];
  const seen = new Set();
  for (const block of blocks || []) {
    for (const raw of cleanText(block.text).split(/\n+/)) {
      const line = cleanText(raw);
      const key = comparableText(line);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ source_field: block.source_field || 'order', text: line });
    }
  }
  return out;
}

const PLACEHOLDER_RE = /^(?:thuc hien\s+)?y lenh thuoc da co\.?$|^thuoc da co\.?$/i;
const STOP_RE = /^(?:ngung|dung)\s+(?:y lenh\s+)?(?:thuoc\s+)?/i;
const CONTINUE_RE = /^(?:duy tri|tiep tuc)\s+(?:y lenh\s+)?/i;
const CARE_RE = /\b(?:rut dan luu|thay bang|cat chi|tap van dong|cham soc|theo doi|xuat vien|tai kham)\b/i;
const MED_HINT_RE = /(?:^|\s)(?:tt|cs)(?:\s|$)|\b\d+(?:[.,]\d+)?\s*(?:mg|mcg|g|ml|iu|ui|dv)\b|\b\d+\s*(?:v|vien|ong|chai|lo|goi)\b|\bx\s*\d+\b|\b(?:u|t|uong|tiem|truyen|ttm|tdt|tdd|xit|hit|bom|boi)\b/i;

function classifyOrderLine(line) {
  const raw = cleanText(line);
  const norm = comparableText(raw);
  if (!norm) return { kind: 'empty', action: '', confidence: 'high' };
  if (PLACEHOLDER_RE.test(norm)) return { kind: 'medication_reference', action: 'reference', confidence: 'high' };
  if (STOP_RE.test(norm)) return { kind: 'medication', action: 'stop', confidence: MED_HINT_RE.test(norm) ? 'high' : 'medium' };
  if (CONTINUE_RE.test(norm)) {
    return MED_HINT_RE.test(norm)
      ? { kind: 'medication', action: 'continue', confidence: 'medium' }
      : { kind: 'medication_reference', action: 'continue', confidence: 'medium' };
  }
  if (CARE_RE.test(norm) && !MED_HINT_RE.test(norm)) return { kind: 'care_order', action: '', confidence: 'high' };
  if (MED_HINT_RE.test(norm)) return { kind: 'medication', action: 'order', confidence: 'high' };
  if (/\bthuoc\b/i.test(norm)) return { kind: 'medication_reference', action: 'reference', confidence: 'low' };
  return { kind: 'other', action: '', confidence: 'low' };
}

function parseStrength(text) {
  const m = cleanText(text).match(/\b(\d+(?:[.,]\d+)?)\s*(mg|mcg|g|ml|iu|ui|đv|dv)\b/i);
  return m ? `${m[1].replace(',', '.')} ${m[2]}` : '';
}

function parseTimesPerDay(text) {
  const m = comparableText(text).match(/\bx\s*(\d{1,2})\b/);
  return m ? m[1] : '';
}

function parseSchedule(text) {
  const raw = cleanText(text);
  const values = [];
  const add = (hourRaw, minuteRaw = '0') => {
    const hour = Number(hourRaw);
    const minute = Number(minuteRaw || 0);
    if (hour > 23 || minute > 59) return;
    const value = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    if (!values.includes(value)) values.push(value);
  };
  for (const m of raw.matchAll(/(?<!\d)(\d{1,2})\s*h(?:\s*(\d{2}))?(?!\d)/gi)) add(m[1], m[2]);
  for (const m of raw.matchAll(/(?<!\d)(\d{1,2}):(\d{2})(?!\d)/g)) add(m[1], m[2]);
  return values;
}

function stripMedicationPrefix(line, action) {
  let text = cleanText(line).replace(/^\((?:TT|CS)\)\s*/i, '');
  if (action === 'stop') text = text.replace(/^(?:Ngưng|Dung|Dừng)\s+(?:y lệnh\s+)?(?:thuốc\s+)?/i, '');
  if (action === 'continue') text = text.replace(/^(?:Duy trì|Tiếp tục)\s+(?:y lệnh\s+)?/i, '');
  return text.trim();
}

function parseDrugName(line, action = 'order') {
  const text = stripMedicationPrefix(line, action);
  // Cắt trước thông tin liều/số lượng/tần suất/đường dùng. Không cố đoán nếu chỉ là câu tham chiếu.
  const cut = text.search(/\s+(?=\d+(?:[.,]\d+)?\s*(?:mg|mcg|g|ml|iu|ui|đv|dv)\b|\d+\s*(?:v|vien|ong|chai|lo|goi)\b|x\s*\d+\b|\((?:u|t|ttm|tdt|tdd)\)|\b(?:uong|tiem|truyen|ttm|tdt|tdd)\b)/i);
  const candidate = (cut >= 0 ? text.slice(0, cut) : text).replace(/[,:;\-]+$/g, '').trim();
  if (!candidate || /^(?:y lenh|thuoc|khang sinh)$/i.test(comparableText(candidate))) return '';
  return candidate.slice(0, 180);
}

function parseMedicationLine(line, sourceField = 'order') {
  const cls = classifyOrderLine(line);
  if (cls.kind !== 'medication') return null;
  const drugName = parseDrugName(line, cls.action);
  // Continue mơ hồ kiểu "Duy trì y lệnh kháng sinh..." không được tự dựng tên thuốc.
  if (!drugName && cls.action !== 'stop') return null;
  const schedule = parseSchedule(line);
  const routeRaw = cleanText(line).match(/\((u|t|ttm|tdt|tdd)\)|\b(uống|uong|tiêm|tiem|truyền|truyen|ttm|tdt|tdd)\b/i)?.[0] || '';
  return {
    raw_line: cleanText(line),
    source_field: sourceField,
    order_action: cls.action,
    parser_confidence: cls.confidence,
    drug_name_raw: drugName,
    drug_name_norm: normalizeDrugName(drugName),
    strength_raw: parseStrength(line),
    route_raw: routeRaw,
    route_norm: normalizeRoute(routeRaw || line),
    times_per_day: parseTimesPerDay(line),
    schedule: schedule.join(';'),
  };
}

function medicationRowsFromOrderRow(row) {
  const { order_blocks: blocks } = dedupeOrderFields(row);
  const rows = [];
  for (const item of splitOrderLines(blocks)) {
    const parsed = parseMedicationLine(item.text, item.source_field);
    // Stop event cần được giữ để timeline biết thuốc đã ngưng; các câu reference không tạo thuốc giả.
    if (parsed) rows.push({ ...row, ...parsed });
  }
  return rows;
}

function event(eventType, valueNorm, sourceText, options = {}) {
  return {
    event_type: eventType,
    event_subtype: options.event_subtype || '',
    value_raw: options.value_raw == null ? sourceText : String(options.value_raw),
    value_norm: String(valueNorm),
    negated: options.negated ? '1' : '0',
    certainty: options.certainty || 'observed',
    source_text: cleanText(sourceText),
    parser_rule: options.parser_rule || eventType,
    confidence: options.confidence || 'high',
  };
}

function extractClinicalEvents(text) {
  const events = [];
  const lines = cleanText(text).split(/\n+/).map(x => x.trim()).filter(Boolean);
  for (const line of lines) {
    const norm = comparableText(line);
    if (!norm) continue;

    const vas = norm.match(/\bvas\s*[:=]?\s*(\d{1,2})(?:\s*\/\s*10)?\b/);
    if (vas && Number(vas[1]) <= 10) events.push(event('pain_vas', vas[1], line, { value_raw: vas[1], parser_rule: 'vas_numeric' }));

    if (/^(?:benh nhan\s+)?tinh(?: tao)?\b/.test(norm)) events.push(event('consciousness', 'alert', line, { parser_rule: 'conscious_alert' }));
    if (/\btiep xuc tot\b/.test(norm)) events.push(event('contact', 'good', line, { parser_rule: 'contact_good' }));
    if (/\bsinh hieu on\b/.test(norm)) events.push(event('vital_status', 'stable', line, { parser_rule: 'vitals_stable' }));
    if (/\bda niem hong\b/.test(norm)) events.push(event('skin_mucosa', 'pink', line, { parser_rule: 'skin_pink' }));
    if (/\bvet mo kho\b/.test(norm)) events.push(event('wound_status', 'dry', line, { parser_rule: 'wound_dry' }));
    if (/\bvet mo\b.*\bri(?:\s+it)?\s+dich\b/.test(norm)) events.push(event('wound_drainage', /\bri it dich\b/.test(norm) ? 'small' : 'present', line, { parser_rule: 'wound_drainage' }));
    if (/\bquanh vet mo\b.*\bkhong sung do\b/.test(norm)) events.push(event('wound_inflammation', 'absent', line, { negated: true, parser_rule: 'wound_no_inflammation' }));
    if (/\bkhong (?:non|non oi|buon non)\b/.test(norm)) events.push(event('nausea_vomiting', 'absent', line, { negated: true, parser_rule: 'no_nausea_vomiting' }));
    else if (/\b(?:buon non|non oi|non)\b/.test(norm)) events.push(event('nausea_vomiting', 'present', line, { parser_rule: 'nausea_vomiting_present' }));

    if (/\bdau vet mo it\b|\bit dau vet mo\b/.test(norm)) events.push(event('postop_pain', 'mild', line, { parser_rule: 'postop_pain_mild' }));
    else if (/\bgiam dau vet mo\b/.test(norm)) events.push(event('postop_pain', 'improving', line, { parser_rule: 'postop_pain_improving' }));
    else if (/\bdau vet mo\b/.test(norm)) events.push(event('postop_pain', 'present', line, { parser_rule: 'postop_pain_present' }));

    if (/\bdi lai duoc\b|\btu di lai\b/.test(norm)) events.push(event('mobility', 'ambulatory', line, { parser_rule: 'mobility_ambulatory' }));
    else if (/\bvan dong han che\b|\bhan che van dong\b/.test(norm)) events.push(event('mobility', 'limited', line, { parser_rule: 'mobility_limited' }));

    if (/\bxuat vien\b/.test(norm) && !/\bdu kien\b/.test(norm)) events.push(event('discharge_event', 'discharged', line, { parser_rule: 'discharge_actual' }));
    if (/\bdu kien\b.*\bxuat vien\b/.test(norm)) events.push(event('discharge_plan', 'planned', line, { parser_rule: 'discharge_planned' }));
  }
  return events;
}

module.exports = {
  cleanText,
  comparableText,
  dedupeOrderFields,
  splitOrderLines,
  classifyOrderLine,
  parseMedicationLine,
  medicationRowsFromOrderRow,
  extractClinicalEvents,
};
