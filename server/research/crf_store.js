'use strict';

// Phiếu nhập tay (CRF) của nghiên cứu: các biến không có trên EMR (phỏng vấn, đo tại giường,
// gọi điện/theo dõi...). Lưu trong thư mục nghiên cứu:
//   crf_form.json     thiết kế phiếu: trường (field) và mốc theo dõi (timepoint)
//   crf_entries.json  dữ liệu đã nhập theo Mã NC (gồm cả trường định danh như số điện thoại)
//   crf_data.csv      bản xuất để phân tích: mỗi Mã NC một dòng, KHÔNG có trường định danh
// Ghi kiểu đọc–sửa–ghi đồng bộ (fs *Sync) nên các request không chen nhau trong một tiến trình.

const fs = require('fs');
const path = require('path');
const { readJsonSafe, writeJsonAtomic } = require('../utils/file');
const { studyDir, cohortPath } = require('./store_paths');
const { readCsvTable, writeCsv } = require('./table_io');
const { researchCode } = require('./variable_selection');

const FORM_FILE = 'crf_form.json';
const ENTRIES_FILE = 'crf_entries.json';
const DATA_FILE = 'crf_data.csv';
const FIELD_TYPES = new Set(['number', 'text', 'choice', 'yesno', 'date', 'datetime']);
const TIMEPOINT_STATUSES = new Set(['pending', 'done', 'unreachable']);
const MAX_FIELDS = 400;
const MAX_TIMEPOINTS = 20;

const HADS_A_IDS = ['hads_a1', 'hads_a3', 'hads_a5', 'hads_a7', 'hads_a9', 'hads_a11', 'hads_a13'];
const HADS_D_IDS = ['hads_d2', 'hads_d4', 'hads_d6', 'hads_d8', 'hads_d10', 'hads_d12', 'hads_d14'];
const AIS_IDS = ['ais_1', 'ais_2', 'ais_3', 'ais_4', 'ais_5'];

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

const slug = (value, max = 40) => String(value || '').trim().toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd')
  .replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max);
const tpSlug = value => String(value || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20);
const str = (value, max) => String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

function sanitizeForm(input) {
  const src = input && typeof input === 'object' ? input : {};
  const timepoints = [];
  const tpIds = new Set();
  for (const tp of Array.isArray(src.timepoints) ? src.timepoints.slice(0, MAX_TIMEPOINTS) : []) {
    const id = tpSlug(tp?.id || tp?.label);
    if (!id || tpIds.has(id)) continue;
    const hours = Number(tp?.offset_hours);
    if (!Number.isFinite(hours) || hours < 0 || hours > 24 * 365) throw badRequest(`Mốc theo dõi "${tp?.label || id}" cần số giờ sau mốc hợp lệ.`);
    tpIds.add(id);
    timepoints.push({ id, label: str(tp?.label || id, 60), offset_hours: Math.round(hours * 10) / 10 });
  }
  const fields = [];
  const fieldIds = new Set();
  for (const f of Array.isArray(src.fields) ? src.fields.slice(0, MAX_FIELDS) : []) {
    const label = str(f?.label, 200);
    if (!label) continue;
    let id = slug(f?.id || label);
    if (!id) continue;
    const timepoint = f?.timepoint && tpIds.has(String(f.timepoint)) ? String(f.timepoint) : '';
    for (let i = 2; fieldIds.has(`${timepoint}:${id}`); i += 1) id = `${slug(f?.id || label, 36)}_${i}`;
    const type = FIELD_TYPES.has(String(f?.type)) ? String(f.type) : 'text';
    const field = { id, label, type, section: str(f?.section, 120), timepoint };
    if (type === 'choice') {
      const options = [...new Set((Array.isArray(f?.options) ? f.options : String(f?.options || '').split(/[;\n]/)).map(o => str(o, 120)).filter(Boolean))].slice(0, 30);
      if (options.length < 2) throw badRequest(`Trường "${label}" kiểu lựa chọn cần ít nhất 2 lựa chọn.`);
      field.options = options;
    }
    if (type === 'number') {
      const min = Number(f?.min); const max = Number(f?.max);
      if (String(f?.min ?? '').trim() !== '' && Number.isFinite(min)) field.min = min;
      if (String(f?.max ?? '').trim() !== '' && Number.isFinite(max)) field.max = max;
    }
    const unit = str(f?.unit, 30);
    if (unit) field.unit = unit;
    if (f?.identifier) field.identifier = true;
    fieldIds.add(`${timepoint}:${id}`);
    fields.push(field);
  }
  return { version: 1, fields, timepoints };
}

const formPath = studyId => path.join(studyDir(studyId), FORM_FILE);
const entriesPath = studyId => path.join(studyDir(studyId), ENTRIES_FILE);
const dataPath = studyId => path.join(studyDir(studyId), DATA_FILE);

function readForm(studyId) {
  const raw = readJsonSafe(formPath(studyId), null);
  if (!raw) return { version: 1, fields: [], timepoints: [], updated_at: '' };
  return { ...sanitizeForm(raw), updated_at: String(raw.updated_at || '') };
}

function readEntries(studyId) {
  const raw = readJsonSafe(entriesPath(studyId), null);
  return raw && typeof raw.entries === 'object' && raw.entries ? raw.entries : {};
}

function cohortCodes(studyId) {
  const table = readCsvTable(cohortPath(studyId), Number.MAX_SAFE_INTEGER);
  return [...new Set((table.rows || []).map(row => researchCode(row)).filter(Boolean))];
}

function cleanValue(field, value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (field.type === 'number') {
    const n = Number(raw.replace(',', '.'));
    if (!Number.isFinite(n)) throw badRequest(`"${field.label}" phải là số.`);
    if (field.min != null && n < field.min) throw badRequest(`"${field.label}" nhỏ hơn ${field.min}.`);
    if (field.max != null && n > field.max) throw badRequest(`"${field.label}" lớn hơn ${field.max}.`);
    return String(n);
  }
  if (field.type === 'choice' && !field.options.includes(raw)) throw badRequest(`"${field.label}": "${raw}" không có trong danh sách lựa chọn.`);
  if (field.type === 'yesno' && !['0', '1'].includes(raw)) throw badRequest(`"${field.label}" chỉ nhận Có/Không.`);
  if (field.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw badRequest(`"${field.label}" cần ngày dạng YYYY-MM-DD.`);
  if (field.type === 'datetime' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) throw badRequest(`"${field.label}" cần ngày giờ dạng YYYY-MM-DDTHH:mm.`);
  return raw.slice(0, 1000);
}

function mergeValues(fields, current, incoming) {
  const out = { ...(current || {}) };
  for (const field of fields) {
    if (!incoming || !Object.prototype.hasOwnProperty.call(incoming, field.id)) continue;
    const v = cleanValue(field, incoming[field.id]);
    if (v === '') delete out[field.id]; else out[field.id] = v;
  }
  return out;
}

function completeNumericSum(values, ids) {
  const nums = ids.map(id => {
    const raw = values?.[id];
    if (raw === '' || raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  });
  return nums.every(n => n != null) ? nums.reduce((a, b) => a + b, 0) : '';
}

function hadsClass(score) {
  if (!Number.isFinite(Number(score))) return '';
  const n = Number(score);
  if (n <= 7) return 'Bình thường';
  if (n <= 10) return 'Nguy cơ';
  return 'Có rối loạn';
}

function derivedValues(values = {}) {
  const out = {};
  const hadsA = completeNumericSum(values, HADS_A_IDS);
  const hadsD = completeNumericSum(values, HADS_D_IDS);
  const ais = completeNumericSum(values, AIS_IDS);
  if (hadsA !== '') { out.hads_a_total = hadsA; out.hads_a_class = hadsClass(hadsA); }
  if (hadsD !== '') { out.hads_d_total = hadsD; out.hads_d_class = hadsClass(hadsD); }
  if (ais !== '') { out.ais_total = ais; out.ais_class = Number(ais) <= 4 ? 'Bình thường' : 'Rối loạn giấc ngủ'; }
  const psqi = values.psqi_total;
  if (psqi !== '' && psqi != null && Number.isFinite(Number(psqi))) {
    out.psqi_class = Number(psqi) <= 5 ? 'Giấc ngủ tốt' : 'Rối loạn giấc ngủ';
  }
  return out;
}

function derivedColumnsForForm(form) {
  const ids = new Set((form.fields || []).filter(f => !f.timepoint).map(f => f.id));
  const cols = [];
  if (HADS_A_IDS.some(id => ids.has(id))) cols.push('hads_a_total', 'hads_a_class');
  if (HADS_D_IDS.some(id => ids.has(id))) cols.push('hads_d_total', 'hads_d_class');
  if (AIS_IDS.some(id => ids.has(id))) cols.push('ais_total', 'ais_class');
  if (ids.has('psqi_total')) cols.push('psqi_class');
  return cols;
}

function writeDataCsv(studyId, form, entries) {
  const baseFields = form.fields.filter(f => !f.timepoint && !f.identifier);
  const derivedColumns = derivedColumnsForForm(form);
  const columns = ['research_code', 'anchor_at', ...baseFields.map(f => f.id), ...derivedColumns];
  for (const tp of form.timepoints) {
    columns.push(`${tp.id}_status`);
    for (const f of form.fields.filter(x => x.timepoint === tp.id && !x.identifier)) columns.push(`${tp.id}_${f.id}`);
  }
  const rows = Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)).map(([code, entry]) => {
    const row = { research_code: code, anchor_at: entry.anchor_at || '' };
    for (const f of baseFields) row[f.id] = entry.values?.[f.id] ?? '';
    Object.assign(row, derivedValues(entry.values || {}));
    for (const tp of form.timepoints) {
      const t = entry.timepoints?.[tp.id] || {};
      row[`${tp.id}_status`] = t.status || '';
      for (const f of form.fields.filter(x => x.timepoint === tp.id && !x.identifier)) row[`${tp.id}_${f.id}`] = t.values?.[f.id] ?? '';
    }
    return row;
  });
  writeCsv(dataPath(studyId), columns, rows);
  return rows.length;
}

function saveForm(studyId, input) {
  const form = { ...sanitizeForm(input), updated_at: new Date().toISOString() };
  writeJsonAtomic(formPath(studyId), form);
  const entries = readEntries(studyId);
  const count = writeDataCsv(studyId, form, entries);
  return { form, entry_count: count };
}

function saveEntry(studyId, code, input, actor = '') {
  const researchCodeValue = str(code, 60);
  if (!researchCodeValue || !cohortCodes(studyId).includes(researchCodeValue)) throw badRequest('Mã NC không có trong danh sách mẫu của nghiên cứu.');
  const form = readForm(studyId);
  if (!form.fields.length) throw badRequest('Nghiên cứu chưa có thiết kế phiếu.');
  const entries = readEntries(studyId);
  const current = entries[researchCodeValue] || { values: {}, timepoints: {} };
  const src = input && typeof input === 'object' ? input : {};
  const next = {
    values: mergeValues(form.fields.filter(f => !f.timepoint), current.values, src.values),
    timepoints: { ...(current.timepoints || {}) },
    anchor_at: Object.prototype.hasOwnProperty.call(src, 'anchor_at')
      ? cleanValue({ label: 'Thời điểm mốc', type: 'datetime' }, src.anchor_at)
      : (current.anchor_at || ''),
    updated_at: new Date().toISOString(),
    updated_by: str(actor, 80),
  };
  for (const tp of form.timepoints) {
    const incoming = src.timepoints?.[tp.id];
    if (!incoming || typeof incoming !== 'object') continue;
    const prev = next.timepoints[tp.id] || { status: 'pending', values: {} };
    const status = TIMEPOINT_STATUSES.has(String(incoming.status)) ? String(incoming.status) : prev.status || 'pending';
    next.timepoints[tp.id] = {
      status,
      values: mergeValues(form.fields.filter(f => f.timepoint === tp.id), prev.values, incoming.values),
      note: Object.prototype.hasOwnProperty.call(incoming, 'note') ? str(incoming.note, 500) : (prev.note || ''),
      done_at: status === 'pending' ? '' : (prev.status === status && prev.done_at ? prev.done_at : new Date().toISOString()),
      attempts: Number(prev.attempts || 0) + (status === 'unreachable' && prev.status !== 'unreachable' ? 1 : 0),
    };
  }
  entries[researchCodeValue] = next;
  writeJsonAtomic(entriesPath(studyId), { version: 1, entries });
  const count = writeDataCsv(studyId, form, entries);
  return { entry: next, entry_count: count };
}

function normalizedAnchor(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00`;
  return s.replace(' ', 'T').slice(0, 16);
}

// Mốc CRF: ưu tiên anchor_datetime của dataset chọn biến; nếu nghiên cứu không khai báo
// anchor riêng thì tự dùng ngày/giờ phẫu thuật. Đây là nền để N1/N2/N3 không phải nhập mốc tay.
function computedAnchors(runDir) {
  if (!runDir) return {};
  const out = {};
  const ingest = (file, candidates) => {
    if (!fs.existsSync(file)) return;
    for (const row of readCsvTable(file, Number.MAX_SAFE_INTEGER).rows || []) {
      const code = researchCode(row);
      if (!code || out[code]) continue;
      for (const key of candidates) {
        const value = normalizedAnchor(row[key]);
        if (value) { out[code] = value; break; }
      }
    }
  };
  ingest(path.join(runDir, 'analysis_selected.csv'), ['anchor_datetime', 'surgery_datetime', 'surgery_date']);
  ingest(path.join(runDir, 'analysis_ready.csv'), ['anchor_datetime', 'surgery_datetime', 'surgery_date']);
  ingest(path.join(runDir, 'surgery_results.csv'), ['surgery_datetime', 'surgery_date']);
  return out;
}

function readCrfView(studyId, { runDir = '', includeIdentifiers = false } = {}) {
  const form = readForm(studyId);
  const entries = readEntries(studyId);
  const auto = computedAnchors(runDir);
  const hidden = new Set(form.fields.filter(f => f.identifier).map(f => f.id));
  const strip = values => {
    if (includeIdentifiers || !hidden.size) return values || {};
    const out = {};
    for (const [k, v] of Object.entries(values || {})) if (!hidden.has(k)) out[k] = v;
    return out;
  };
  const samples = cohortCodes(studyId).map(code => {
    const entry = entries[code] || null;
    return {
      research_code: code,
      anchor_at: entry?.anchor_at || '',
      anchor_auto: auto[code] || '',
      values: strip(entry?.values),
      derived_values: derivedValues(entry?.values || {}),
      identifiers_saved: entry ? [...hidden].filter(id => entry.values?.[id]) : [],
      timepoints: Object.fromEntries(Object.entries(entry?.timepoints || {}).map(([tp, t]) => [tp, { ...t, values: strip(t.values) }])),
      updated_at: entry?.updated_at || '',
    };
  });
  return { form, samples, identifiers_visible: includeIdentifiers };
}

module.exports = { sanitizeForm, readForm, saveForm, saveEntry, readCrfView, derivedValues, DATA_FILE };
