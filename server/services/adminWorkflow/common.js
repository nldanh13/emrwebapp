'use strict';

const crypto = require('crypto');

function normText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9:/\-.\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function uniq(values) {
  return [...new Set(safeArray(values).map(x => String(x || '').trim()).filter(Boolean))];
}

function stableHash(value, len = 12) {
  return crypto.createHash('sha1').update(JSON.stringify(value ?? '')).digest('hex').slice(0, len);
}

function getFirstValue(source, keys) {
  const obj = asObject(source);
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}

function getPatientId(row) {
  return String(getFirstValue(row, ['patientId', 'ma_bn', 'Mã BN', 'Mã YT', 'ma_yt', 'MaBN', 'Ma_BN', 'mabn', 'id', 'benh_nhan_id', 'patient_id'])).trim();
}

function getPatientName(row) {
  return String(getFirstValue(row, ['patientName', 'ho_ten', 'name', 'Họ tên', 'ten_bn', 'ten_nguoi_benh', 'full_name'])).trim();
}

function getRoom(row) {
  return String(getFirstValue(row, ['room', 'so_phong', 'Vi_Tri', 'phong_giuong', 'Phòng', 'Vị trí', 'phong', 'bed_room'])).trim();
}

function getDoctor(row) {
  return String(getFirstValue(row, ['doctor', 'bac_si', 'Bác sĩ', 'bac_si_dieu_tri', 'bs_dieu_tri', 'bs', 'doctor_name', 'nguoi_chi_dinh'])).trim();
}

function getDiagnosis(row) {
  return String(getFirstValue(row, ['diagnosis', 'chan_doan', 'chuan_doan', 'Chẩn đoán', 'chan_doan_chinh', 'diagnosis_text'])).trim();
}

function parseVNDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const s = String(value || '').trim();
  if (!s) return null;
  let m = s.match(/(\d{1,2})\s*[\/\-]\s*(\d{1,2})\s*[\/\-]\s*(\d{2,4})(?:\s+(\d{1,2}):(\d{1,2}))?/);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    return new Date(y, Number(m[2]) - 1, Number(m[1]), Number(m[4] || 12), Number(m[5] || 0));
  }
  m = s.match(/(\d{4})\s*[\/\-]\s*(\d{1,2})\s*[\/\-]\s*(\d{1,2})(?:[T\s]+(\d{1,2}):(\d{1,2}))?/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 12), Number(m[5] || 0));
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

function dateSortAsc(a, b) {
  return (parseVNDate(a)?.getTime() || 0) - (parseVNDate(b)?.getTime() || 0);
}

function dateSortDesc(a, b) {
  return -dateSortAsc(a, b);
}

function getRecordDate(record) {
  return String(getFirstValue(record, ['ngay_lam', 'date', 'ngay', 'work_date', 'Ngay', 'ngay_y_lenh', 'order_date'])).trim();
}

function collectDrugsFromSource(source) {
  const src = asObject(source);
  const meds = asObject(src.thuoc || src.medications || src.drugs);
  const rows = [];
  const add = (items, routeLabel, category) => {
    for (const item of safeArray(items)) {
      if (!item) continue;
      if (typeof item === 'string') {
        const name = item.trim();
        if (name) rows.push({ routeLabel, category, name, raw: item });
      } else if (typeof item === 'object') {
        const name = String(item.ten_hien_thi || item.ten_thuoc || item.name || item.label || item.raw_text || item.raw || '').trim();
        if (name) rows.push({ ...item, routeLabel: item.routeLabel || routeLabel, category: item.category || category, name });
      }
    }
  };
  add(meds.dich_truyen || meds.infusions, 'DT', 'dich_truyen');
  add(meds.thuoc_tiem || meds.injections, 'TM', 'thuoc_tiem');
  add(meds.thuoc_uong || meds.oral, 'U', 'thuoc_uong');
  add(meds.thuoc_hit_xit || meds.inhaled, 'Hít/Xịt', 'thuoc_hit_xit');
  add(meds.thuoc_boi || meds.topical, 'Bôi', 'thuoc_boi');
  add(meds.thuoc_nho || meds.drops, 'Nhỏ', 'thuoc_nho');
  add(meds.thuoc_dat || meds.suppository, 'Đặt', 'thuoc_dat');
  add(meds.thuoc_tra || meds.returns, 'Trả', 'thuoc_tra');
  add(meds.khac || meds.other, 'Khác', 'khac');
  return rows.map(x => ({ ...x, date: getRecordDate(src) }));
}

function collectServicesFromRecord(record) {
  const src = asObject(record);
  const rows = [];
  const add = (item, source) => {
    if (!item) return;
    if (typeof item === 'string') {
      const name = item.trim();
      if (name) rows.push({ name, source, date: getRecordDate(src) });
      return;
    }
    if (typeof item === 'object') {
      const name = String(item.ten || item.name || item.ten_dich_vu || item.service_name || item.noi_dung || item.label || item.raw || item.raw_text || '').trim();
      if (name) rows.push({ ...item, name, source: item.source || source, date: item.date || getRecordDate(src) });
    }
  };
  for (const item of safeArray(src.chi_dinh_dvkt)) add(item, 'DVKT');
  for (const item of safeArray(src.can_lam_sang)) add(item, 'CLS');
  for (const item of safeArray(src.lich_su_xn)) add(item, 'XN');
  for (const item of safeArray(src.lich_su_cdha)) add(item, 'CĐHA');
  for (const item of safeArray(src.thu_thuat)) add(item, 'Thủ thuật');
  for (const item of safeArray(src.cham_soc)) add(item, 'Chăm sóc');
  const other = asObject(src.chi_dinh_khac);
  for (const value of Object.values(other)) {
    if (Array.isArray(value)) value.forEach(x => add(x, 'Chỉ định khác'));
    else add(value, 'Chỉ định khác');
  }
  return rows;
}

function collectCareOrders(record) {
  const src = asObject(record);
  const rows = [];
  const add = (item, source = 'Chăm sóc') => {
    if (!item) return;
    if (typeof item === 'string') {
      const name = item.trim();
      if (name) rows.push({ name, source, date: getRecordDate(src) });
      return;
    }
    if (typeof item === 'object') {
      const name = String(item.ten || item.name || item.noi_dung || item.label || item.raw || item.raw_text || '').trim();
      if (name) rows.push({ ...item, name, source: item.source || source, date: item.date || getRecordDate(src) });
    }
  };
  for (const key of ['cham_soc', 'care', 'orders_care', 'dieu_duong']) {
    const value = src[key];
    if (Array.isArray(value)) value.forEach(x => add(x));
  }
  return rows;
}

function getServiceDateText(service) {
  return String(service?.date || service?.gio || service?.time || service?.ngay || service?.ngay_thuc_hien || service?.thoi_gian || service?.thoi_gian_chi_dinh || service?.created_at || '').trim();
}

function isSurgicalServiceName(value) {
  const text = normText(value);
  if (!text) return false;
  if (/dinh luong|dien tim|x quang|xquang|sieu am|ct|scanner|mri|cong huong tu|xet nghiem|tong phan tich|prothrombin|aptt|ure|creatinin|glucose|dien giai|ast|alt|crp|hba1c|mau lang/.test(text)) return false;
  return /phau thuat|pttt|thu thuat|ket hop xuong|co dinh cot song|han khop|thay khop|noi soi khop|mo ket hop|mo nep|nep vit|dat nep|bat vit|dinh noi tuy|giai ep|cat loc|tai tao day chang|khau noi gan|nan chinh|cat cut|mo xuong|lay dung cu ket hop xuong|thao dung cu|bom xi mang/.test(text);
}

function collectVtytPlan(record) {
  const src = asObject(record);
  const v = asObject(src.vtyt || src.vat_tu || src.supplies);
  if (!Object.keys(v).length) return [];
  const candidates = [v.plan, v.required, v.items, v.vat_tu, v.declared_items, v.entered_items, v.ke_khai_items, v.jobs];
  const rows = [];
  for (const list of candidates) {
    for (const item of safeArray(list)) {
      if (typeof item === 'string') {
        const label = item.trim();
        if (label) rows.push({ label, qty: 1, note: 'Nguồn EMR/worker', category: 'required', alert: true, date: getRecordDate(src) });
      } else if (item && typeof item === 'object') {
        const label = String(item.label || item.name || item.ten || item.ten_vat_tu || item.item_name || '').trim();
        if (label) rows.push({ ...item, label, qty: item.qty ?? item.quantity ?? item.so_luong ?? item.required_quantity ?? 1, category: item.category || 'required', alert: item.alert !== false, date: item.date || getRecordDate(src) });
      }
    }
  }
  return rows;
}

function mergeByKey(rows, keyFn, mergeFn) {
  const out = [];
  const seen = new Map();
  for (const row of safeArray(rows)) {
    const key = String(keyFn(row) || '').trim();
    if (!key) continue;
    if (!seen.has(key)) {
      const copy = { ...row };
      seen.set(key, copy);
      out.push(copy);
    } else if (mergeFn) {
      mergeFn(seen.get(key), row);
    }
  }
  return out;
}

function toNumber(value, fallback = 1) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const s = String(value ?? '').replace(',', '.');
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return fallback;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : fallback;
}

function aggregateSupplyPlan(rows) {
  const map = new Map();
  for (const row of safeArray(rows)) {
    const label = String(row?.label || row?.name || '').trim();
    if (!label) continue;
    const key = normText(label);
    const qty = toNumber(row.qty ?? row.quantity ?? row.required_quantity ?? row.so_luong, 1);
    if (!map.has(key)) {
      map.set(key, {
        key,
        label,
        qty,
        note: row.note || row.reason || row.sourceOrder || '',
        category: row.category || 'required',
        alert: row.alert !== false,
        routine: Boolean(row.routine || row.category === 'routine'),
        required: row.required !== false && row.category !== 'routine',
        source: row.source || '',
        date: row.date || '',
        sources: uniq([row.sourceOrder || row.source || row.note || '']),
      });
    } else {
      const existing = map.get(key);
      existing.qty += qty;
      existing.note = uniq([existing.note, row.note || row.reason || row.sourceOrder || '']).join(' · ');
      existing.alert = Boolean(existing.alert || row.alert !== false);
      existing.routine = Boolean(existing.routine && (row.routine || row.category === 'routine'));
      if (existing.category === 'routine' && row.category && row.category !== 'routine') existing.category = row.category;
      existing.required = Boolean(existing.required || (row.required !== false && row.category !== 'routine'));
      existing.sources = uniq([...(existing.sources || []), row.sourceOrder || row.source || row.note || '']);
    }
  }
  return [...map.values()].map(x => ({ ...x, qty: Number.isInteger(x.qty) ? x.qty : Number(x.qty.toFixed(2)) }));
}

function hasHourInText(value, hour) {
  const h = String(hour).padStart(2, '0');
  const s = normText(value).replace(/\s+/g, ' ');
  if (!s) return false;
  return [
    new RegExp(`(^|[^0-9])0?${hour}\\s*(h|gio)(?![0-9])`),
    new RegExp(`(^|[^0-9])${h}:00(?![0-9])`),
    new RegExp(`(^|[^0-9])0?${hour}:00(?![0-9])`),
  ].some(re => re.test(s));
}

function hasMedicationAtHour(drugs, hour) {
  return safeArray(drugs).some(drug => hasHourInText([drug.gio_dung, drug.time, drug.tg_bat_dau, drug.duong_dung_goc, drug.raw_text, drug.raw, drug.name].join(' '), hour));
}

function buildPatientGroups(records) {
  const map = new Map();
  for (const record of safeArray(records)) {
    const id = getPatientId(record);
    if (!id) continue;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(record);
  }
  return map;
}

function latestRecord(records) {
  const list = safeArray(records);
  return [...list].sort((a, b) => dateSortDesc(getRecordDate(a), getRecordDate(b)))[0] || list[0] || {};
}

function makeIssue({ group, category, severity = 'warn', title, detail = '', action = '', evidence = '', source = 'workflow', code = '', meta = {} }) {
  return {
    id: stableHash([group || category, severity, title, detail, action, evidence, code], 14),
    code: String(code || '').trim(),
    group: String(group || category || 'GENERAL'),
    category: String(category || group || 'GENERAL'),
    severity: severity === 'error' ? 'error' : severity === 'info' ? 'info' : 'warn',
    title: String(title || '').trim(),
    detail: String(detail || '').trim(),
    action: String(action || '').trim(),
    evidence: String(evidence || '').trim(),
    source,
    meta: asObject(meta),
  };
}

module.exports = {
  normText,
  safeArray,
  asObject,
  uniq,
  stableHash,
  getFirstValue,
  getPatientId,
  getPatientName,
  getRoom,
  getDoctor,
  getDiagnosis,
  parseVNDate,
  dateSortAsc,
  dateSortDesc,
  getRecordDate,
  collectDrugsFromSource,
  collectServicesFromRecord,
  collectCareOrders,
  getServiceDateText,
  isSurgicalServiceName,
  collectVtytPlan,
  mergeByKey,
  toNumber,
  aggregateSupplyPlan,
  hasHourInText,
  hasMedicationAtHour,
  buildPatientGroups,
  latestRecord,
  makeIssue,
};
