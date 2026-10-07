'use strict';

const { extractTScoresBySite } = require('./value_normalizers');

function stripMarks(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeText(value) {
  return stripMarks(value).toLowerCase().replace(/đ/g, 'd').replace(/\s+/g, ' ').trim();
}

// Ghi nhớ kết quả chuẩn hoá chuỗi: tên cột và tên thuốc/XN lặp lại rất nhiều lần khi quét
// hàng trăm nghìn dòng, chuẩn hoá Unicode mỗi lần là phần tốn thời gian nhất.
function memoizeText(fn, limit = 50000) {
  const cache = new Map();
  return value => {
    const key = String(value ?? '');
    let out = cache.get(key);
    if (out === undefined) {
      if (cache.size >= limit) cache.clear();
      out = fn(key);
      cache.set(key, out);
    }
    return out;
  };
}

const normalizedKey = memoizeText(value => normalizeText(value).replace(/[^a-z0-9]+/g, ''));

function safeSegment(value, fallback = '') {
  const s = stripMarks(value)
    .replace(/đ/g, 'd')
    .replace(/[^a-zA-Z0-9_.:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return s || fallback;
}

function getCell(row, names) {
  if (!row) return '';
  const list = Array.isArray(names) ? names : [names];
  const byKey = new Map(Object.keys(row || {}).map(key => [normalizedKey(key), row[key]]));
  for (const name of list) {
    const v = byKey.get(normalizedKey(name));
    if (String(v ?? '').trim()) return String(v ?? '').trim();
  }
  return '';
}

function patientCode(row) {
  return getCell(row, [
    'Mã BN', 'Ma BN', 'MABN', 'Mã bệnh nhân', 'Ma benh nhan',
    'patient_code', 'patientCode', 'code', 'ma_bn', 'maBN', 'Mã YT', 'Ma YT',
  ]);
}

function researchCode(row) {
  return getCell(row, ['Mã NC', 'Ma NC', 'research_code', 'researchCode', 'first_research_code']);
}

function encounterId(row) {
  return getCell(row, ['encounter_id', 'visit_id']);
}

function isValidDateParts(year, month, day, hour = 0, minute = 0) {
  if (![year, month, day, hour, minute].every(Number.isInteger)) return false;
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return false;
  const d = new Date(year, month - 1, day, hour, minute);
  return d.getFullYear() === year
    && d.getMonth() === month - 1
    && d.getDate() === day
    && d.getHours() === hour
    && d.getMinutes() === minute;
}

function parseComparableDate(raw) {
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2}))?$/);
  if (iso) {
    const parts = [Number(iso[1]), Number(iso[2]), Number(iso[3]), Number(iso[4] || 0), Number(iso[5] || 0)];
    return isValidDateParts(...parts) ? new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4]).getTime() : NaN;
  }
  const dmy = raw.match(/^(?:(\d{1,2}):(\d{1,2})\s+)?(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:\s+(\d{1,2}):(\d{1,2}))?$/);
  if (dmy) {
    const hour = Number(dmy[1] || dmy[6] || 0);
    const minute = Number(dmy[2] || dmy[7] || 0);
    const parts = [Number(dmy[5]), Number(dmy[4]), Number(dmy[3]), hour, minute];
    return isValidDateParts(...parts) ? new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4]).getTime() : NaN;
  }
  return NaN;
}

function coerceComparable(value, type = '') {
  const raw = String(value ?? '').trim();
  if (!raw) return { raw, text: '', num: NaN, time: NaN };
  const num = Number(raw.replace(',', '.').replace(/[^0-9.+-]/g, ''));
  const normalizedType = String(type || '').trim().toLowerCase();
  const numericType = /^(number|numeric|integer|float|double|decimal)$/.test(normalizedType);
  const dateType = /^(date|datetime|timestamp|time)$/.test(normalizedType);
  // Không dùng Date.parse() cho dữ liệu nghiên cứu: các chuỗi số như "5.6"
  // có thể bị JavaScript diễn giải thành ngày, làm sai điều kiện lọc số.
  const time = numericType ? NaN : parseComparableDate(raw);
  return { raw, text: normalizeText(raw), num, time, type: normalizedType, numericType, dateType };
}

function compareScalar(actual, operator, value, value2, type = '') {
  const op = String(operator || '').trim() || (String(value ?? '').trim() ? 'contains' : 'not_empty');
  const a = coerceComparable(actual, type);
  const b = coerceComparable(value, type);
  const c = coerceComparable(value2, type);
  if (op === 'not_empty') return Boolean(a.raw);
  if (op === 'empty') return !a.raw;
  if (!a.raw && !['!=', 'empty'].includes(op)) return false;
  if (['>', '>=', '<', '<=', 'between'].includes(op)) {
    const normalizedType = String(type || '').trim().toLowerCase();
    const useDate = /^(date|datetime|timestamp|time)$/.test(normalizedType)
      || (!/^(number|numeric|integer|float|double|decimal)$/.test(normalizedType)
        && Number.isFinite(a.time) && (Number.isFinite(b.time) || Number.isFinite(c.time)));
    const av = useDate ? a.time : a.num;
    const bv = useDate ? b.time : b.num;
    const cv = useDate ? c.time : c.num;
    if (!Number.isFinite(av)) return false;
    if (op === 'between') return Number.isFinite(bv) && Number.isFinite(cv) && av >= Math.min(bv, cv) && av <= Math.max(bv, cv);
    if (!Number.isFinite(bv)) return false;
    if (op === '>') return av > bv;
    if (op === '>=') return av >= bv;
    if (op === '<') return av < bv;
    if (op === '<=') return av <= bv;
  }
  if (op === '=' || op === '==' || op === '!=') {
    const normalizedType = String(type || '').trim().toLowerCase();
    let equal;
    if (/^(number|numeric|integer|float|double|decimal)$/.test(normalizedType)) {
      equal = Number.isFinite(a.num) && Number.isFinite(b.num) && a.num === b.num;
    } else if (/^(date|datetime|timestamp|time)$/.test(normalizedType)) {
      equal = Number.isFinite(a.time) && Number.isFinite(b.time) && a.time === b.time;
    } else {
      equal = a.text === b.text;
    }
    return op === '!=' ? !equal : equal;
  }
  if (op === 'in') {
    const choices = String(value || '').split(/[;,\n]/).map(normalizeText).filter(Boolean);
    return choices.includes(a.text);
  }
  if (op === 'starts_with') return a.text.startsWith(b.text);
  if (op === 'ends_with') return a.text.endsWith(b.text);
  return a.text.includes(b.text);
}

function sanitizeFilterObject(value, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 2) return undefined;
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    const cleanKey = safeSegment(key, '').slice(0, 80);
    if (!cleanKey || ['__proto__', 'constructor', 'prototype'].includes(cleanKey)) continue;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const nested = sanitizeFilterObject(raw, depth + 1);
      if (nested && Object.keys(nested).length) out[cleanKey] = nested;
    } else if (Array.isArray(raw)) {
      out[cleanKey] = raw.slice(0, 20).map(x => String(x ?? '').slice(0, 300));
    } else {
      out[cleanKey] = String(raw ?? '').slice(0, 500);
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function isImagingCatalogVariable(variable) {
  return String(variable?.table || '') === 'imaging_results'
    || String(variable?.virtual_kind || '').startsWith('imaging_')
    || String(variable?.name || '').startsWith('imaging:');
}

const TSCORE_SITE_ORDER = ['neck_left', 'neck_right', 'total_left', 'total_right', 'l1', 'l2', 'l3', 'l4', 'overall'];

function imagingVariableSortKey(variable) {
  const name = String(variable?.name || '');
  const kind = String(variable?.virtual_kind || '');
  const modality = String(variable?.source_filter?.modality || name.split(':')[1] || '').toLowerCase();
  if (kind === 'imaging_modality' || name.startsWith('imaging:')) return [modality, 0, 0];
  if (kind === 'imaging_t_score_site' || name.startsWith('imaging_t_score:')) {
    const site = name.split(':').slice(1).join(':');
    const rank = TSCORE_SITE_ORDER.indexOf(site);
    return [modality, 1, rank < 0 ? TSCORE_SITE_ORDER.length : rank];
  }
  return [modality, 2, 0];
}

// Giữ nguyên vị trí của các biến không phải CĐHA; gom riêng nhóm CĐHA tại vị trí xuất hiện đầu tiên.
function arrangeSelectedVariables(variables) {
  const imaging = variables.filter(isImagingCatalogVariable);
  if (imaging.length < 2) return variables;
  const originalIndex = new Map(imaging.map((variable, index) => [variable, index]));
  imaging.sort((a, b) => {
    const ka = imagingVariableSortKey(a);
    const kb = imagingVariableSortKey(b);
    return ka[0].localeCompare(kb[0]) || ka[1] - kb[1] || ka[2] - kb[2]
      || originalIndex.get(a) - originalIndex.get(b);
  });
  const out = [];
  let inserted = false;
  for (const variable of variables) {
    if (isImagingCatalogVariable(variable)) {
      if (!inserted) {
        out.push(...imaging);
        inserted = true;
      }
    } else {
      out.push(variable);
    }
  }
  return out;
}

function sanitizeVariableSelection(input) {
  const src = input && typeof input === 'object' ? input : {};
  const sanitizeVar = v => {
    const name = String(v?.name || '');
    const virtualKind = String(v?.virtual_kind || '');
    const originalLabel = String(v?.label || name);
    const isImagingResult = virtualKind === 'imaging_modality' || name.startsWith('imaging:');
    const modality = name.split(':').slice(1).join(':') || originalLabel.replace(/^Có\s+/i, '');
    const canonicalImagingLabel = `Kết quả CĐHA: ${modality}`;
    const label = isImagingResult && /^Có\s+/i.test(originalLabel) ? canonicalImagingLabel : originalLabel;
    const surveyLabel = String(v?.survey_label || originalLabel);
    const out = {
      id: String(v?.id || '').slice(0, 200),
      table: safeSegment(String(v?.table || '').slice(0, 80)),
      table_label: String(v?.table_label || '').slice(0, 120),
      name: name.slice(0, 180),
      label: label.slice(0, 220),
      survey_label: (isImagingResult && /^Có\s+/i.test(surveyLabel) ? canonicalImagingLabel : surveyLabel).slice(0, 220),
      // CĐHA được chọn để xuất phải mang báo cáo; lọc có/không vẫn dùng condition riêng.
      type: isImagingResult ? 'text' : String(v?.type || '').slice(0, 40),
      role: VARIABLE_ROLES.has(String(v?.role || '')) ? String(v.role) : '',
      virtual_kind: virtualKind.slice(0, 80),
      source_note: String(v?.source_note || '').slice(0, 500),
      aggregation: isImagingResult ? 'list' : String(v?.aggregation || 'list').slice(0, 40),
    };
    // Cửa sổ ngày so với mốc thời gian của nghiên cứu (vd. -14 → 0: trong 14 ngày trước mốc).
    const windowFrom = sanitizeWindowDays(v?.window_from_days);
    const windowTo = sanitizeWindowDays(v?.window_to_days);
    if (windowFrom != null || windowTo != null) {
      out.window_from_days = windowFrom;
      out.window_to_days = windowTo;
    }
    const sourceFilter = sanitizeFilterObject(v?.source_filter);
    if (sourceFilter) out.source_filter = sourceFilter;
    return out;
  };
  const selectedRaw = Array.isArray(src.selected_variables)
    ? src.selected_variables.slice(0, 500).map(sanitizeVar).filter(v => v.id && v.name)
    : [];
  const selected = arrangeSelectedVariables(selectedRaw);
  const byId = new Map(selected.map(v => [v.id, v]));
  const conditions = Array.isArray(src.conditions) ? src.conditions.slice(0, 300).map(c => {
    const base = byId.get(String(c?.variable_id || '')) || {};
    const out = {
      id: String(c?.id || '').slice(0, 120),
      variable_id: String(c?.variable_id || '').slice(0, 200),
      table: safeSegment(String(c?.table || base.table || '').slice(0, 80)),
      name: String(c?.name || base.name || '').slice(0, 180),
      label: String(c?.label || base.label || '').slice(0, 220),
      type: String(c?.type || base.type || '').slice(0, 40),
      operator: String(c?.operator || '').slice(0, 40),
      value: String(c?.value ?? '').slice(0, 500),
      value2: String(c?.value2 ?? '').slice(0, 500),
      virtual_kind: String(c?.virtual_kind || base.virtual_kind || '').slice(0, 80),
      // Tiêu chuẩn loại trừ: lượt khớp điều kiện này bị loại khỏi mẫu.
      exclude: c?.exclude === true || c?.exclude === 'true',
    };
    const sourceFilter = sanitizeFilterObject(c?.source_filter) || base.source_filter;
    if (sourceFilter) out.source_filter = sourceFilter;
    return out;
  }).filter(c => c.variable_id || c.name) : [];
  return {
    schema_version: Number(src.schema_version || 1) || 1,
    source: String(src.source || 'research_archive').slice(0, 80),
    run_id: safeSegment(String(src.run_id || '').slice(0, 80)),
    created_at: String(src.created_at || new Date().toISOString()).slice(0, 80),
    selected_variables: selected,
    conditions,
    ...(sanitizeAnchor(src.anchor) ? { anchor: sanitizeAnchor(src.anchor) } : {}),
    ...(sanitizePeriod(src.period) ? { period: sanitizePeriod(src.period) } : {}),
    ...(src.one_per_patient === true || src.one_per_patient === 'true' ? { one_per_patient: true } : {}),
    ...(sanitizeSampleSize(src.sample_size) ? { sample_size: sanitizeSampleSize(src.sample_size) } : {}),
  };
}

// Vai trò của biến trong nghiên cứu (đặt ở bước Ghép biến).
const VARIABLE_ROLES = new Set(['primary_outcome', 'secondary_outcome', 'exposure', 'covariate', 'descriptive']);

// Ngày lịch dạng 'YYYY-MM-DD' từ ngày ISO hoặc dd/mm/yyyy (bỏ phần giờ) để so khoảng thời gian.
function dayKey(value) {
  const raw = String(value ?? '').trim();
  let m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = raw.match(/(?:^|\s)(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}

// Thời gian nghiên cứu: lượt có ngày nhập viện trong [from, to] (theo ngày, hai đầu đều tính).
function sanitizePeriod(input) {
  if (!input || typeof input !== 'object') return null;
  const from = dayKey(input.from);
  const to = dayKey(input.to);
  if (!from && !to) return null;
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

// Thông số tính cỡ mẫu chỉ được lưu lại cùng nghiên cứu (tính ở giao diện), không ảnh hưởng lọc.
function sanitizeSampleSize(input) {
  if (!input || typeof input !== 'object') return null;
  const design = String(input.design || '').slice(0, 40);
  if (!design) return null;
  const out = { design };
  for (const [key, raw] of Object.entries(input)) {
    if (key === 'design' || Object.keys(out).length > 20) continue;
    const cleanKey = safeSegment(key, '').slice(0, 40);
    if (!cleanKey || ['__proto__', 'constructor', 'prototype'].includes(cleanKey)) continue;
    const n = Number(raw);
    if (raw !== '' && raw !== null && Number.isFinite(n)) out[cleanKey] = n;
  }
  return out;
}

function sanitizeWindowDays(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  return Math.max(-3650, Math.min(3650, Math.round(n * 100) / 100));
}

// Mốc thời gian của nghiên cứu: ngày nhập viện, ngày phẫu thuật, hoặc lần đầu dùng một thuốc
// trong đợt điều trị (vd. lần truyền Zoledronic Acid). Biến lấy "gần trước/sau mốc nhất" và
// cửa sổ ngày đều tính theo mốc này.
const ANCHOR_KINDS = new Set(['admission', 'surgery', 'drug']);
function sanitizeAnchor(input) {
  if (!input || typeof input !== 'object') return null;
  const kind = String(input.kind || '').trim();
  if (!ANCHOR_KINDS.has(kind)) return null;
  const drug = String(input.drug || '').trim().slice(0, 120);
  if (kind === 'drug' && normalizeForFilter(drug).length < 3) return null;
  const label = String(input.label || '').trim().slice(0, 160);
  return { kind, ...(kind === 'drug' ? { drug } : {}), ...(label ? { label } : {}) };
}

// Thời điểm mốc của một lượt điều trị. Thuốc: y lệnh sớm nhất trong đợt có tên/hoạt chất khớp.
function anchorForEncounter(anchor, identity, tableRowsByKey = {}) {
  if (!anchor) return { raw: '', time: NaN };
  if (anchor.kind === 'admission' || anchor.kind === 'surgery') {
    const raw = String(anchor.kind === 'admission' ? identity.admission_date : identity.surgery_date || '').trim();
    return { raw, time: coerceComparable(raw).time };
  }
  const needle = normalizeForFilter(anchor.drug);
  let best = { raw: '', time: NaN };
  for (const row of relatedRows(tableRowsByKey.medication_orders || [], identity)) {
    const hay = normalizeForFilter([getCell(row, ['drug_name_norm', 'drug_name_raw', 'Tên thuốc']), getCell(row, ['active_ingredient'])].join(' '));
    if (!hay.includes(needle)) continue;
    const raw = String(eventTime(row) || '').trim();
    const time = coerceComparable(raw).time;
    if (Number.isFinite(time) && (!Number.isFinite(best.time) || time < best.time)) best = { raw, time };
  }
  return best;
}

const DAY_MS = 86400000;
const SINGLE_ROW_TABLES = new Set(['analysis_ready', 'encounters', 'patients', 'patient_master', 'cohort', 'research_source', 'initial_list']);
function startOfDay(time) { const d = new Date(time); d.setHours(0, 0, 0, 0); return d.getTime(); }

// Giữ các giá trị nằm trong cửa sổ ngày quanh mốc. Theo ngày lịch: -14 → 0 nghĩa là từ đầu ngày
// thứ 14 trước ngày mốc đến đúng thời điểm mốc; 1 → 3 là từ đầu ngày thứ nhất sau mốc đến hết
// ngày thứ 3. Không có mốc hoặc giá trị không có thời gian thì bị loại khi đã đặt cửa sổ.
function insideAnchorWindow(time, anchorTime, fromDays, toDays) {
  if (!Number.isFinite(time) || !Number.isFinite(anchorTime)) return false;
  const day0 = startOfDay(anchorTime);
  const lower = fromDays == null ? -Infinity : day0 + fromDays * DAY_MS;
  const upper = toDays == null ? Infinity : (toDays === 0 ? anchorTime : day0 + (toDays + 1) * DAY_MS - 1);
  return time >= lower && time <= upper;
}

function hasActiveSelection(selection) {
  return Boolean(selection && typeof selection === 'object' && (
    (Array.isArray(selection.selected_variables) && selection.selected_variables.length) ||
    (Array.isArray(selection.conditions) && selection.conditions.length) ||
    selection.period || selection.one_per_patient
  ));
}

const normalizeForFilter = memoizeText(value => normalizeText(value).replace(/[^a-z0-9]+/g, ' ').trim());

function sourceFilterMatches(row, sourceFilter = {}) {
  for (const [key, expectedRaw] of Object.entries(sourceFilter || {})) {
    if (expectedRaw == null || expectedRaw === '') continue;
    if (Array.isArray(expectedRaw)) {
      const actual = normalizeForFilter(getCell(row, key));
      if (!expectedRaw.map(normalizeForFilter).some(x => x && actual.includes(x))) return false;
      continue;
    }
    if (expectedRaw && typeof expectedRaw === 'object') continue;
    const expected = normalizeForFilter(expectedRaw);
    if (!expected) continue;
    const actual = normalizeForFilter(getCell(row, key));
    if (!actual.includes(expected) && expected !== actual) return false;
  }
  return true;
}

function virtualVariableMatches(row, variable) {
  const name = String(variable?.name || '');
  const kind = String(variable?.virtual_kind || '');
  if (variable?.source_filter && !sourceFilterMatches(row, variable.source_filter)) return false;
  const valueAfterColon = name.includes(':') ? name.split(':').slice(1).join(':') : '';
  const needle = normalizeForFilter(valueAfterColon || variable?.label || '');
  if (!kind && !name.includes(':')) return true;
  if (kind === 'lab_item' || name.startsWith('lab:')) {
    const hay = normalizeForFilter([getCell(row, ['test_name_norm', 'Tên XN chuẩn']), getCell(row, ['test_name_raw', 'Tên XN', 'Tên xét nghiệm'])].join(' '));
    return !needle || hay.includes(needle) || sourceFilterMatches(row, variable.source_filter || {});
  }
  if (kind === 'imaging_t_score_site' || name.startsWith('imaging_t_score:')) {
    const site = name.split(':').slice(1).join(':');
    return extractTScoresBySite(imagingReportValue(row)).some(score => !site || score.site === site);
  }
  if (kind === 'imaging_modality' || name.startsWith('imaging_modality:') || name.startsWith('imaging:')) {
    const hay = normalizeForFilter(getCell(row, ['modality', 'Loại']));
    return !needle || hay.includes(needle);
  }
  if (kind === 'drug_group' || name.startsWith('drug_group:')) {
    const hay = normalizeForFilter(getCell(row, ['drug_group_guess', 'Nhóm thuốc dự đoán']));
    return !needle || hay.includes(needle);
  }
  if (kind === 'active_ingredient' || name.startsWith('ingredient:')) {
    // Y lệnh đã gắn hoạt chất theo Danh mục thuốc (selection_runtime): khớp đúng tên hoạt chất,
    // không lọc theo tên thuốc nên mọi tên thương mại của hoạt chất đều được tính.
    if (!needle) return false;
    return String(getCell(row, ['active_ingredient', 'Hoạt chất', 'Hoat chat']) || '').split(/[;+]/)
      .some(part => normalizeForFilter(part) === needle);
  }
  if (kind === 'drug_item' || name.startsWith('drug:')) {
    const hay = normalizeForFilter([getCell(row, ['drug_name_norm', 'drug_name_raw', 'Tên thuốc']), getCell(row, ['active_ingredient'])].join(' '));
    return !needle || hay.includes(needle);
  }
  if (kind === 'procedure_item' || name.startsWith('procedure:')) {
    const hay = normalizeForFilter([getCell(row, ['surgery_method', 'Phương pháp']), getCell(row, ['surgery_name', 'Tên phẫu thuật'])].join(' '));
    return !needle || hay.includes(needle);
  }
  return sourceFilterMatches(row, variable.source_filter || {});
}

function isVirtual(variable) {
  return Boolean(variable?.virtual_kind || String(variable?.name || '').includes(':') || variable?.source_filter);
}

function conditionMatchesRows(condition, rows) {
  const candidates = Array.isArray(rows) ? rows : [];
  const op = String(condition?.operator || '').trim();
  if (!candidates.length) return op === 'empty';
  if (isVirtual(condition)) {
    const matched = candidates.filter(row => virtualVariableMatches(row, condition));
    if (!matched.length) return op === 'empty';
    if (!op || op === 'not_empty' || op === '=') return true;
    if (op === 'empty') return false;
    const values = matched.map(row => variableValue(condition, row));
    return values.some(v => compareScalar(v, op, condition.value, condition.value2, condition.type));
  }
  if (op === 'empty') return candidates.every(row => !getCell(row, condition.name));
  if (op === 'not_empty') return candidates.some(row => Boolean(getCell(row, condition.name)));
  return candidates.some(row => compareScalar(getCell(row, condition.name), condition.operator, condition.value, condition.value2, condition.type));
}

function eventTime(row) {
  return getCell(row, [
    'lab_datetime', 'ordered_at', 'surgery_datetime', 'order_datetime', 'note_datetime',
    'lab_date', 'order_date', 'surgery_date', 'note_date', 'diagnosis_date', 'date',
    'TG chỉ định', 'TG y lệnh', 'Ngày chỉ định', 'Ngày xét nghiệm', 'Ngày phẫu thuật', 'Ngày',
  ]);
}

function timeInsideEncounter(value, admission, discharge) {
  const t = coerceComparable(value).time;
  const a = coerceComparable(admission).time;
  const d = coerceComparable(discharge).time;
  if (!Number.isFinite(t) || !Number.isFinite(a)) return false;
  const end = Number.isFinite(d) ? d : a + 60 * 86400000;
  return t >= a - 86400000 && t <= end + 86400000;
}

// Chỉ mục theo mã đợt / Mã NC / Mã BN cho từng bảng, lập một lần cho mỗi mảng dòng.
// Trước đây mỗi lượt điều trị quét lại toàn bộ bảng (XN, thuốc...), nên thời gian tăng theo
// bình phương dữ liệu: 500 lượt × 25.000 dòng XN mất ~110 giây. Có chỉ mục, mỗi lượt chỉ
// xem đúng các dòng ứng viên của nó; kết quả giữ nguyên thứ tự và quy tắc ghép như cũ.
const ROW_INDEX = new WeakMap();
function rowIndex(list) {
  let index = ROW_INDEX.get(list);
  if (index) return index;
  index = { byEid: new Map(), byRc: new Map(), noEidByRc: new Map(), noEidByPc: new Map(), noEidNoRcByPc: new Map() };
  // allowEmpty: cách ghép cũ so "Mã BN dòng === Mã BN lượt" nên cả hai cùng rỗng vẫn khớp (khi ngày nằm trong đợt).
  const push = (map, key, entry, allowEmpty = false) => { if (!key && !allowEmpty) return; const arr = map.get(key); if (arr) arr.push(entry); else map.set(key, [entry]); };
  list.forEach((row, i) => {
    const entry = { row, i, eid: encounterId(row), rc: researchCode(row), pc: patientCode(row) };
    push(index.byEid, entry.eid, entry);
    push(index.byRc, entry.rc, entry);
    if (!entry.eid) {
      push(index.noEidByRc, entry.rc, entry);
      push(index.noEidByPc, entry.pc, entry, true);
      if (!entry.rc) push(index.noEidNoRcByPc, entry.pc, entry, true);
    }
  });
  ROW_INDEX.set(list, index);
  return index;
}

function relatedRows(rows, identity) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return [];
  const pc = String(identity.patient_code || '').trim();
  const rc = String(identity.research_code || '').trim();
  const eid = String(identity.encounter_id || '').trim();
  const admission = String(identity.admission_date || '').trim();
  const discharge = String(identity.discharge_date || '').trim();
  const hasWindow = Boolean(admission || discharge);
  const index = rowIndex(list);
  const inside = entry => {
    const event = eventTime(entry.row);
    return Boolean(event && timeInsideEncounter(event, admission, discharge));
  };
  let picked = [];
  if (eid) {
    // encounter_id là khóa lượt. Nếu có Mã BN ở cả hai phía, phải trùng Mã BN;
    // dòng thiếu encounter_id chỉ ghép theo đúng Mã BN và thời gian của lượt.
    picked = (index.byEid.get(eid) || []).filter(entry => !pc || !entry.pc || entry.pc === pc);
    if (pc) {
      picked.push(...(index.noEidByPc.get(pc) || []).filter(entry => {
        if (entry.rc && rc && entry.rc === rc) return !hasWindow || !eventTime(entry.row) || inside(entry);
        return inside(entry);
      }));
    }
  } else if (pc) {
    // Mã BN là định danh người bệnh. Với dòng thiếu encounter_id, ưu tiên Mã NC
    // khớp trong cùng Mã BN; nếu mã khác thì cần bằng chứng ngày nằm trong lượt.
    // Dữ liệu legacy không có mã lượt lẫn ngày chỉ nối ở mức người bệnh.
    picked = (index.noEidByPc.get(pc) || []).filter(entry => {
      if (entry.rc && rc) return (entry.rc === rc && (!hasWindow || !eventTime(entry.row) || inside(entry))) || inside(entry);
      if (entry.rc && !rc) return inside(entry);
      return !hasWindow || inside(entry) || (!entry.rc && !eventTime(entry.row));
    });
  } else if (rc) {
    // Chỉ dùng Mã NC khi Mã BN thực sự không có và mã này không bị dùng chung
    // cho nhiều người bệnh. Khi có ngày, ngày vẫn phải nằm trong lượt.
    const candidates = [...new Map([...(index.byRc.get(rc) || []), ...(index.noEidByRc.get(rc) || [])].map(entry => [entry.i, entry])).values()];
    const patientCodes = new Set(candidates.map(entry => entry.pc).filter(Boolean));
    if (patientCodes.size <= 1) picked = candidates.filter(entry => !hasWindow || inside(entry));
  }
  return picked
    .sort((a, b) => a.i - b.i)
    .map(entry => entry.row)
    .filter(row => {
      const matchStatus = String(row?.encounter_match_status || '').trim();
      if (matchStatus && matchStatus !== 'matched') return false;
      if (row && Object.prototype.hasOwnProperty.call(row, 'is_within_encounter')) {
        if (String(row.is_within_encounter || '').trim() !== '1') return false;
      }
      return true;
    });
}

function conditionRowsForSource(sourceRow, condition, tableRowsByKey) {
  const pc = patientCode(sourceRow);
  const rc = researchCode(sourceRow);
  const eid = encounterId(sourceRow);
  const identity = {
    patient_code: pc,
    research_code: rc,
    encounter_id: eid,
    admission_date: getCell(sourceRow, ['admission_date', 'Ngày vào viện']),
    discharge_date: getCell(sourceRow, ['discharge_date', 'Ngày ra viện']),
    surgery_date: getCell(sourceRow, ['surgery_date', 'Ngày phẫu thuật']),
  };
  const table = String(condition.table || '').trim();
  if (!table || ['cohort', 'initial_list', 'research_source'].includes(table)) {
    return [sourceRow, ...relatedRows(tableRowsByKey?.[table] || [], identity)];
  }
  return relatedRows(tableRowsByKey?.[table] || [], identity);
}

function conditionPasses(condition, row, tableRowsByKey) {
  const matched = conditionMatchesRows(condition, conditionRowsForSource(row, condition, tableRowsByKey));
  return condition.exclude ? !matched : matched;
}

function filterRowsByPeriod(rows, period) {
  if (!period) return rows;
  return rows.filter(row => {
    const day = dayKey(getCell(row, ['admission_date', 'Ngày vào viện']));
    if (!day) return false;
    return (!period.from || day >= period.from) && (!period.to || day <= period.to);
  });
}

// Mỗi người bệnh chỉ giữ lượt nhập viện sớm nhất (tránh một người được tính nhiều lần).
function keepFirstEncounterPerPatient(rows) {
  const firstByPatient = new Map();
  rows.forEach((row, i) => {
    const key = String(getCell(row, ['patient_key']) || patientCode(row) || '').trim();
    if (!key) return;
    const day = dayKey(getCell(row, ['admission_date', 'Ngày vào viện'])) || '9999-99-99';
    const best = firstByPatient.get(key);
    if (!best || day < best.day) firstByPatient.set(key, { i, day });
  });
  const keep = new Set([...firstByPatient.values()].map(x => x.i));
  return rows.filter((row, i) => keep.has(i) || !String(getCell(row, ['patient_key']) || patientCode(row) || '').trim());
}

// Chọn mẫu theo thứ tự: thời gian nghiên cứu → từng tiêu chuẩn chọn/loại trừ → mỗi người một lượt.
// onStep(label, rows) được gọi sau mỗi bước để dựng sơ đồ sàng lọc.
function selectCohortRows(rows, selection, tableRowsByKey = {}, onStep = null) {
  let out = Array.isArray(rows) ? rows : [];
  if (selection.period) {
    out = filterRowsByPeriod(out, selection.period);
    if (onStep) onStep({ kind: 'period' }, out);
  }
  for (const condition of selection.conditions || []) {
    out = out.filter(row => conditionPasses(condition, row, tableRowsByKey));
    if (onStep) onStep({ kind: 'condition', condition }, out);
  }
  if (selection.one_per_patient) {
    out = keepFirstEncounterPerPatient(out);
    if (onStep) onStep({ kind: 'one_per_patient' }, out);
  }
  return out;
}

function filterCohortRowsByVariableSelection(rows, selectionInput, tableRowsByKey = {}) {
  const selection = sanitizeVariableSelection(selectionInput);
  const conditions = selection.conditions || [];
  if (!conditions.length && !selection.period && !selection.one_per_patient) {
    return { rows: Array.isArray(rows) ? rows : [], matched: Array.isArray(rows) ? rows.length : 0, conditions: [] };
  }
  const out = selectCohortRows(rows, selection, tableRowsByKey);
  return { rows: out, matched: out.length, conditions };
}

function selectedColumnName(variable, used = new Set()) {
  const base = safeSegment(`var_${variable.id || variable.table + '_' + variable.name}`, 'var_selected').replace(/[.:]+/g, '_').slice(0, 80);
  let col = base;
  let i = 2;
  while (used.has(col)) col = `${base}_${i++}`.slice(0, 90);
  used.add(col);
  return col;
}

function imagingReportValue(row) {
  const parts = [
    getCell(row, ['result_text', 'Mô tả/Kết quả', 'Kết quả']),
    getCell(row, ['conclusion_text', 'Kết luận']),
  ].map(value => String(value || '').trim()).filter(Boolean);
  return [...new Set(parts)].join(' — ');
}

function variableValue(variable, row) {
  const kind = String(variable?.virtual_kind || '');
  if (kind === 'imaging_t_score_site' || String(variable?.name || '').startsWith('imaging_t_score:')) {
    const site = String(variable?.name || '').split(':').slice(1).join(':');
    return extractTScoresBySite(imagingReportValue(row)).find(score => score.site === site)?.value || '';
  }
  if (kind === 'imaging_modality' || String(variable?.name || '').startsWith('imaging:')) return imagingReportValue(row);
  return getCell(row, variable.name)
    || getCell(row, ['result_num', 'result_raw', 'result_text', 'conclusion_text', 'drug_name_raw', 'surgery_method', 'surgery_name', 'modality', 'diagnosis_text']);
}

function summarizeVariableValue(variable, rows, identity = {}) {
  const candidates = Array.isArray(rows) ? rows : [];
  const aggregation = String(variable?.aggregation || 'list').trim().toLowerCase();
  // Bảng một dòng mỗi lượt (bảng tổng quát, đợt điều trị, người bệnh) không có "thời điểm"
  // cho từng giá trị nên không áp cửa sổ.
  const windowed = (variable?.window_from_days != null || variable?.window_to_days != null)
    && !SINGLE_ROW_TABLES.has(String(variable?.table || ''));
  let matched = isVirtual(variable)
    ? candidates.filter(row => virtualVariableMatches(row, variable))
    : candidates;
  // Cửa sổ ngày áp cho mọi cách lấy, kể cả Số lần / Có-không.
  if (windowed) {
    matched = matched.filter(row => insideAnchorWindow(coerceComparable(eventTime(row)).time, identity.anchor_time, variable.window_from_days, variable.window_to_days));
  }
  if (aggregation === 'count') return String(matched.length);
  if (aggregation === 'any') return matched.length ? '1' : '0';
  if (!matched.length) return '';

  const items = matched.map((row, index) => ({
    row,
    value: variableValue(variable, row),
    index,
    time: coerceComparable(eventTime(row)).time,
  })).filter(item => String(item.value ?? '').trim());
  if (!items.length) return '';
  return aggregateItems(variable, aggregation, items, identity);
}

function aggregateItems(variable, aggregation, items, identity) {
  if (aggregation === 'first' || aggregation === 'last') {
    const datedItems = items.filter(item => Number.isFinite(item.time));
    const ordered = datedItems.length
      ? [...datedItems].sort((a, b) => a.time - b.time || a.index - b.index)
      : [...items].sort((a, b) => a.index - b.index);
    return String((aggregation === 'first' ? ordered[0] : ordered[ordered.length - 1]).value);
  }

  if (['min', 'max', 'mean'].includes(aggregation)) {
    const nums = items.map(item => coerceComparable(item.value).num).filter(Number.isFinite);
    if (!nums.length) return '';
    if (aggregation === 'min') return String(Math.min(...nums));
    if (aggregation === 'max') return String(Math.max(...nums));
    return String(Number((nums.reduce((sum, n) => sum + n, 0) / nums.length).toFixed(6)));
  }

  const closest = {
    closest_before_surgery: ['before', coerceComparable(identity.surgery_date || '').time],
    closest_after_surgery: ['after', coerceComparable(identity.surgery_date || '').time],
    closest_before_anchor: ['before', identity.anchor_time],
    closest_after_anchor: ['after', identity.anchor_time],
  }[aggregation];
  if (closest) {
    const [side, refTime] = closest;
    if (!Number.isFinite(refTime)) return '';
    const eligible = items.filter(item => Number.isFinite(item.time) && (side === 'before' ? item.time <= refTime : item.time >= refTime));
    if (!eligible.length) return '';
    eligible.sort((a, b) => Math.abs(a.time - refTime) - Math.abs(b.time - refTime));
    return String(eligible[0].value);
  }

  // list phải giữ số lần xuất hiện. Hai lần XN cùng giá trị vẫn là hai quan sát,
  // không được âm thầm rút thành một giá trị bằng Set.
  const ordered = [...items].sort((a, b) => {
    const aTimed = Number.isFinite(a.time);
    const bTimed = Number.isFinite(b.time);
    if (aTimed && bTimed) return a.time - b.time || a.index - b.index;
    if (aTimed !== bTimed) return aTimed ? -1 : 1;
    return a.index - b.index;
  });
  return ordered.map(item => String(item.value)).join('; ');
}

function buildSelectedAnalysisDataset(analysisRows, selectionInput, tableRowsByKey = {}) {
  const selection = sanitizeVariableSelection(selectionInput);
  const selected = selection.selected_variables || [];
  // Dataset phân tích không mang Mã BN/họ tên: người bệnh được nhận diện bằng patient_key
  // (mã giả danh, bảng liên kết patient_link.csv nằm riêng ở thư mục kho).
  const baseColumns = [
    'research_code', 'encounter_id', 'patient_key', 'sex', 'birth_year', 'age',
    'admission_date', 'discharge_date', 'hospital_stay_days',
    'diagnosis_raw', 'needs_manual_review', 'source_run_id', 'row_hash',
  ];
  const anchor = selection.anchor || null;
  // Có mốc thời gian thì xuất thêm cột thời điểm mốc của từng lượt (vd. giờ truyền thuốc).
  if (anchor) baseColumns.splice(baseColumns.indexOf('discharge_date') + 1, 0, 'anchor_datetime');
  const used = new Set(baseColumns);
  const variableColumns = selected.map(variable => ({ ...variable, output_column: selectedColumnName(variable, used) }));
  const columns = [...baseColumns, ...variableColumns.map(v => v.output_column)];
  const relatedCache = new Map();
  const rows = (analysisRows || []).map(row => {
    const identity = {
      patient_code: patientCode(row),
      research_code: researchCode(row),
      encounter_id: encounterId(row),
      admission_date: getCell(row, ['admission_date', 'Ngày vào viện']),
      discharge_date: getCell(row, ['discharge_date', 'Ngày ra viện']),
      surgery_date: getCell(row, ['surgery_date', 'Ngày phẫu thuật']),
    };
    const anchorAt = anchorForEncounter(anchor, identity, tableRowsByKey);
    identity.anchor_time = anchorAt.time;
    const out = {};
    for (const col of baseColumns) out[col] = row?.[col] ?? getCell(row, col) ?? '';
    if (anchor) out.anchor_datetime = anchorAt.raw;
    for (const variable of variableColumns) {
      const table = variable.table || 'analysis_ready';
      const cacheKey = `${table}\u0000${identity.encounter_id}\u0000${identity.research_code}\u0000${identity.patient_code}\u0000${identity.admission_date}\u0000${identity.discharge_date}`;
      let rowsForVariable = [row];
      if (table !== 'analysis_ready') {
        if (!relatedCache.has(cacheKey)) relatedCache.set(cacheKey, relatedRows(tableRowsByKey?.[table] || [], identity));
        rowsForVariable = relatedCache.get(cacheKey);
      }
      out[variable.output_column] = summarizeVariableValue(variable, rowsForVariable, identity);
    }
    return out;
  });
  return {
    columns,
    rows,
    manifest: {
      schema_version: 1,
      created_at: new Date().toISOString(),
      selected_variable_count: variableColumns.length,
      condition_count: (selection.conditions || []).length,
      variables: variableColumns.map(v => ({
        id: v.id,
        table: v.table,
        name: v.name,
        label: v.label,
        survey_label: v.survey_label || v.label,
        type: v.type,
        role: v.role,
        virtual_kind: v.virtual_kind,
        source_note: v.source_note,
        source_filter: v.source_filter,
        aggregation: v.aggregation || 'list',
        ...(v.window_from_days != null || v.window_to_days != null ? { window_from_days: v.window_from_days, window_to_days: v.window_to_days } : {}),
        output_column: v.output_column,
      })),
      conditions: selection.conditions || [],
      ...(anchor ? { anchor } : {}),
    },
  };
}

// ── Thống kê mô tả cho từng biến (đo lường biến, không trả dữ liệu từng dòng) ──
const STRICT_NUMBER = /^[-+]?\d+(?:[.,]\d+)?$/;

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const round = (n, digits = 2) => (Number.isFinite(n) ? Number(n.toFixed(digits)) : null);

// Loại đo lường thực tế của cột kết quả: số (liên tục), ngày, phân loại hay văn bản tự do.
function measureKind(variable, values) {
  const aggregation = String(variable?.aggregation || 'list').toLowerCase();
  if (['count', 'min', 'max', 'mean'].includes(aggregation)) return 'number';
  if (aggregation === 'any') return 'category';
  const type = String(variable?.type || '').toLowerCase();
  if (type === 'date') return 'date';
  const numeric = values.filter(v => STRICT_NUMBER.test(v)).length;
  if (type === 'number' || (values.length && numeric / values.length >= 0.8)) return 'number';
  if (type === 'category') return 'category';
  const distinct = new Set(values).size;
  return distinct <= 20 ? 'category' : 'text';
}

function describeValues(variable, rawValues) {
  const values = rawValues.map(v => String(v ?? '').trim()).filter(Boolean);
  const kind = measureKind(variable, values);
  const out = { kind, n: values.length, distinct: new Set(values).size };
  if (kind === 'number') {
    const nums = values.filter(v => STRICT_NUMBER.test(v)).map(v => Number(v.replace(',', '.'))).sort((a, b) => a - b);
    const mean = nums.length ? nums.reduce((sum, n) => sum + n, 0) / nums.length : NaN;
    const sd = nums.length > 1 ? Math.sqrt(nums.reduce((sum, n) => sum + (n - mean) ** 2, 0) / (nums.length - 1)) : NaN;
    Object.assign(out, {
      n_numeric: nums.length,
      non_numeric: values.length - nums.length,
      mean: round(mean), sd: round(sd),
      min: round(nums[0]), q1: round(quantile(nums, 0.25)), median: round(quantile(nums, 0.5)),
      q3: round(quantile(nums, 0.75)), max: round(nums[nums.length - 1]),
    });
  } else if (kind === 'date') {
    const times = values.map(v => parseComparableDate(v)).filter(Number.isFinite).sort((a, b) => a - b);
    const fmt = t => { const d = new Date(t); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`; };
    Object.assign(out, { n_date: times.length, min: times.length ? fmt(times[0]) : '', max: times.length ? fmt(times[times.length - 1]) : '' });
  } else if (kind === 'category') {
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
    const shown = top.slice(0, 6).map(([value, count]) => ({ value, count, pct: round((count / values.length) * 100, 1) }));
    const restCount = top.slice(6).reduce((sum, [, count]) => sum + count, 0);
    out.top = shown;
    if (restCount) out.other = { groups: top.length - 6, count: restCount, pct: round((restCount / values.length) * 100, 1) };
  }
  // Văn bản tự do: chỉ số lượng và số giá trị khác nhau, không đưa giá trị ra màn hình.
  return out;
}

function describeCohort(rows) {
  const keys = new Set(rows.map(row => String(row?.patient_key || '').trim()).filter(Boolean));
  return {
    encounters: rows.length,
    patients: keys.size || null,
    age: describeValues({ type: 'number' }, rows.map(row => row?.age)),
    sex: describeValues({ type: 'category' }, rows.map(row => row?.sex)),
    hospital_stay_days: describeValues({ type: 'number' }, rows.map(row => row?.hospital_stay_days)),
  };
}

function summarizeSelectedDataset(dataset) {
  const rows = Array.isArray(dataset?.rows) ? dataset.rows : [];
  const variables = Array.isArray(dataset?.manifest?.variables) ? dataset.manifest.variables : [];
  const hasValue = value => String(value ?? '').trim() !== '';
  let complete = 0;
  let partial = 0;
  let empty = 0;
  let review = 0;
  for (const row of rows) {
    const filled = variables.reduce((count, variable) => count + (hasValue(row?.[variable.output_column]) ? 1 : 0), 0);
    if (variables.length && filled === variables.length) complete += 1;
    else if (filled > 0) partial += 1;
    else empty += 1;
    if (hasValue(row?.needs_manual_review) || !hasValue(row?.encounter_id)) review += 1;
  }
  return {
    total: rows.length,
    complete,
    partial,
    empty,
    review,
    variables: variables.map(variable => {
      const filled = rows.reduce((count, row) => count + (hasValue(row?.[variable.output_column]) ? 1 : 0), 0);
      return {
        id: variable.id,
        survey_label: variable.survey_label || variable.label || variable.name,
        source_label: variable.label || variable.name,
        output_column: variable.output_column,
        role: variable.role || '',
        filled,
        missing: rows.length - filled,
        fill_rate: rows.length ? Number(((filled / rows.length) * 100).toFixed(1)) : 0,
        aggregation: variable.aggregation || 'list',
        stats: describeValues(variable, rows.map(row => row?.[variable.output_column])),
      };
    }),
    cohort: describeCohort(rows),
    ...(dataset?.manifest?.anchor ? {
      anchor: {
        ...dataset.manifest.anchor,
        found: rows.filter(row => hasValue(row?.anchor_datetime)).length,
        missing: rows.filter(row => !hasValue(row?.anchor_datetime)).length,
      },
    } : {}),
  };
}

module.exports = {
  normalizeText,
  normalizedKey,
  getCell,
  patientCode,
  researchCode,
  sanitizeVariableSelection,
  hasActiveSelection,
  compareScalar,
  coerceComparable,
  sourceFilterMatches,
  virtualVariableMatches,
  conditionMatchesRows,
  relatedRows,
  filterCohortRowsByVariableSelection,
  selectCohortRows,
  dayKey,
  VARIABLE_ROLES,
  buildSelectedAnalysisDataset,
  summarizeSelectedDataset,
  describeValues,
  sanitizeAnchor,
  anchorForEncounter,
  insideAnchorWindow,
};
