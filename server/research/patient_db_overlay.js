'use strict';

// Dùng Kho người bệnh (SQLite dùng chung) để bổ sung hành chánh và XN/CĐHA cho run nghiên cứu, và ngược lại đồng bộ XN/CĐHA đã lấy sang Kho người bệnh.

const { isoDate, firstNonEmpty } = require('./encounter_context');
const patientDb = require('../services/patient_db');
const { patientCode } = require('./table_io');
const { uniqueResearchHchanhRows, researchHchanhMeta, hchanhFetchOutputToRows, removeResearchSourceKey } = require('./research_source');
const fs = require('fs');
const { RESEARCH_STORE_DIR } = require('../constants');
const { runsDir, nowIso } = require('./store_paths');
const path = require('path');
const { readCsvFileRows } = require('./csv_reader');
const { readJsonSafe } = require('../utils/file');

// ── Kho người bệnh → dữ liệu hành chánh của nghiên cứu ───────────────────────
// Khi chuẩn hoá, phần hành chánh (profile, ra viện, phẫu thuật, y lệnh) của mỗi ca được đối chiếu
// với Kho người bệnh (kho chung của Hành chánh / Kiểm hồ sơ / Kho nghiên cứu):
//   - ca chưa có dữ liệu trong lần quét này → lấy từ kho (ghi rõ gốc hay tạm thời);
//   - ca đang dùng dữ liệu tạm thời mà kho đã có dữ liệu gốc → thay bằng dữ liệu gốc;
//   - còn lại giữ nguyên dữ liệu của lần quét.
// File CSV thô của lần quét KHÔNG bị sửa; kết quả ghi vào kho_nguoi_benh_overlay.json.
const KHO_OVERLAY_FILE = 'kho_nguoi_benh_overlay.json';

const KHO_OVERLAY_PARTS = [
  ['profile', 'profileRows'],
  ['discharge', 'dischargeRows'],
  ['surgery', 'surgeryRows'],
  ['order_history', 'orderRows'],
];

// XN / CĐHA: ghi kết quả của lần quét vào Kho người bệnh (dữ liệu gốc), rồi với ca CHƯA có kết quả nào
// trong lần quét này thì lấy từ kho (vd nghiên cứu khác / kho gốc đã lấy) theo khoảng ngày của ca.
// Ca đã có kết quả trong lần quét giữ nguyên. CSV thô của lần quét không bị sửa.
function caseDayRange(meta) {
  const from = isoDate(meta.date_from || '') || isoDate(meta.admission_raw || '');
  let to = isoDate(meta.date_to || '') || isoDate(meta.discharge_raw || '');
  if (from && !to) {
    try { to = patientDb.findStay(meta.ma_bn, from, [])?.to || ''; } catch (_) { to = ''; }
  }
  return from && to && from <= to ? { from, to } : null;
}

function resultDay(row) {
  return isoDate(firstNonEmpty(row, ['TG chỉ định', 'TG xét nghiệm', 'Ngày chỉ định', 'Ngày xét nghiệm', 'Thời gian']));
}

// Chỉ mục Mã BN -> các ngày đã có kết quả. Một lần chuẩn hoá thực tế có thể có
// hàng chục nghìn dòng XN/CĐHA; không được quét toàn bộ bảng cho từng lượt điều trị.
function buildResultDayIndex(rows) {
  const index = new Map();
  for (const row of rows || []) {
    const code = patientCode(row);
    const day = resultDay(row);
    if (!code || !day) continue;
    if (!index.has(code)) index.set(code, new Set());
    index.get(code).add(day);
  }
  return index;
}

function resultDayIndexHasRange(index, code, from, to) {
  const days = index.get(code);
  if (!days) return false;
  for (const day of days) if (day >= from && day <= to) return true;
  return false;
}

function addRowsToResultDayIndex(index, rows) {
  for (const row of rows || []) {
    const code = patientCode(row);
    const day = resultDay(row);
    if (!code || !day) continue;
    if (!index.has(code)) index.set(code, new Set());
    index.get(code).add(day);
  }
}

function overlayResultsFromPatientDb(dir, sourceRows, sourceRunId, labRaw, imagingRaw) {
  const report = { ingested: { xn: 0, cdha: 0 }, filled_cases: { xn: 0, cdha: 0 }, filled_rows: { xn: 0, cdha: 0 } };
  if (!patientDb.available()) return { labRaw, imagingRaw, report };
  report.ingested.xn = patientDb.recordResults(labRaw, { kind: 'xn', source: 'kho_nghien_cuu' }).added;
  report.ingested.cdha = patientDb.recordResults(imagingRaw, { kind: 'cdha', source: 'kho_nghien_cuu' }).added;
  const out = { xn: labRaw.slice(), cdha: imagingRaw.slice() };
  const dayIndex = { xn: buildResultDayIndex(out.xn), cdha: buildResultDayIndex(out.cdha) };
  for (const row of uniqueResearchHchanhRows(sourceRows, sourceRunId)) {
    const meta = researchHchanhMeta(row, sourceRunId);
    if (!meta.ma_bn) continue;
    const range = caseDayRange(meta);
    if (!range) continue;
    for (const kind of ['xn', 'cdha']) {
      const has = resultDayIndexHasRange(dayIndex[kind], meta.ma_bn, range.from, range.to);
      if (has) continue;
      const fromKho = patientDb.resultRows(meta.ma_bn, range.from, range.to, kind)
        .map(r => ({ ...r, 'Mã NC': meta.research_code || '' }));
      if (!fromKho.length) continue;
      out[kind] = out[kind].concat(fromKho);
      addRowsToResultDayIndex(dayIndex[kind], fromKho);
      report.filled_cases[kind] += 1;
      report.filled_rows[kind] += fromKho.length;
    }
  }
  return { labRaw: out.xn, imagingRaw: out.cdha, report };
}

/** Góp XN / CĐHA của mọi lần quét đã có (kho gốc + các nghiên cứu) vào Kho người bệnh. */
function ingestAllResearchResultsToPatientDb() {
  const stats = { runs: 0, xn: 0, cdha: 0 };
  if (!patientDb.available() || !fs.existsSync(RESEARCH_STORE_DIR)) return stats;
  const runDirs = [];
  for (const store of fs.readdirSync(RESEARCH_STORE_DIR, { withFileTypes: true })) {
    if (!store.isDirectory()) continue;
    const runsDir = path.join(RESEARCH_STORE_DIR, store.name, 'runs');
    if (!fs.existsSync(runsDir)) continue;
    for (const run of fs.readdirSync(runsDir, { withFileTypes: true })) {
      if (run.isDirectory()) runDirs.push(path.join(runsDir, run.name));
    }
  }
  // Đọc theo dòng, ghi theo lô: file lich_su_xn.csv có thể vài trăm MB.
  const ingestFile = (filePath, kind) => {
    if (!fs.existsSync(filePath)) return { rows: 0, added: 0 };
    let batch = [];
    let rows = 0;
    let added = 0;
    const flush = () => {
      if (!batch.length) return;
      added += Number(patientDb.recordResults(batch, { kind, source: 'kho_nghien_cuu' }).added || 0);
      batch = [];
    };
    readCsvFileRows(filePath, Number.MAX_SAFE_INTEGER, {
      onRow: row => { rows += 1; batch.push(row); if (batch.length >= 5000) flush(); },
    });
    flush();
    return { rows, added };
  };
  for (const dir of runDirs) {
    const xn = ingestFile(path.join(dir, 'lich_su_xn.csv'), 'xn');
    const cdha = ingestFile(path.join(dir, 'lich_su_cdha.csv'), 'cdha');
    if (!xn.rows && !cdha.rows) continue;
    stats.runs += 1;
    stats.xn += xn.added;
    stats.cdha += cdha.added;
  }
  return stats;
}

// Câu báo thêm sau khi chuẩn hoá: phần hành chánh lấy từ Kho người bệnh.
function khoOverlayNote(counts) {
  const k = counts?.kho_nguoi_benh;
  if (!k || !(k.filled || k.replaced_by_goc || k.provisional || k.xn_cases || k.cdha_cases)) return '';
  const parts = [];
  if (k.filled) parts.push(`lấy ${k.filled} phần hành chánh còn thiếu từ kho người bệnh`);
  if (k.xn_cases || k.cdha_cases) parts.push(`lấy XN cho ${k.xn_cases || 0} ca, CĐHA cho ${k.cdha_cases || 0} ca từ kho người bệnh`);
  if (k.replaced_by_goc) parts.push(`thay ${k.replaced_by_goc} phần tạm thời bằng dữ liệu gốc`);
  const tail = k.provisional ? ` Còn ${k.provisional} phần là dữ liệu tạm thời (bấm "Quét lại dữ liệu tạm thời" để chốt).` : '';
  return parts.length ? ` Đã ${parts.join(', ')}.${tail}` : tail;
}

function provisionalFilesFromProgress(dir) {
  const out = new Map();
  for (const name of ['hchanh_auto_progress.json', 'order_history_auto_progress.json']) {
    const progress = readJsonSafe(path.join(dir, name), {}) || {};
    for (const [key, entry] of Object.entries(progress)) {
      const files = Array.isArray(entry?.provisional_files) ? entry.provisional_files : [];
      if (!files.length) continue;
      out.set(key, new Set([...(out.get(key) || []), ...files]));
    }
  }
  return out;
}

function overlayHchanhFromPatientDb(dir, sourceRows, sourceRunId, tables) {
  const report = {
    at: nowIso(), available: patientDb.available(), cases_in_kho: 0,
    filled: { profile: 0, discharge: 0, surgery: 0, order_history: 0 },
    replaced_by_goc: { profile: 0, discharge: 0, surgery: 0, order_history: 0 },
    provisional: [],
  };
  if (!report.available) {
    report.message = patientDb.unavailableReason();
    return { tables, report };
  }
  const out = { ...tables };
  const sourceKeysByPart = new Map(KHO_OVERLAY_PARTS.map(([fileKey]) => [
    fileKey,
    new Set((out[fileKey] || []).map(r => String(r?.['Research key'] || '')).filter(Boolean)),
  ]));
  const provisionalInRun = provisionalFilesFromProgress(dir);
  for (const row of uniqueResearchHchanhRows(sourceRows, sourceRunId)) {
    const meta = researchHchanhMeta(row, sourceRunId);
    const day = isoDate(meta.admission_raw || '') || isoDate(meta.date_from || '');
    if (!meta.ma_bn || !day) continue;
    let stay = null;
    try { stay = patientDb.findStay(meta.ma_bn, day, []); } catch (_) { stay = null; }
    if (!stay) continue;
    report.cases_in_kho += 1;
    for (const [fileKey, rowsKey] of KHO_OVERLAY_PARTS) {
      const data = stay.output?.[fileKey];
      if (!data) continue;
      const tier = stay.tiers?.[fileKey] || patientDb.TIER_TAM_THOI;
      const hasRun = sourceKeysByPart.get(fileKey).has(meta.source_key);
      const runProvisional = provisionalInRun.get(meta.source_key)?.has(fileKey);
      if (hasRun && !(runProvisional && tier === patientDb.TIER_GOC)) continue;
      const flat = hchanhFetchOutputToRows({ [fileKey]: data }, row, sourceRunId)[rowsKey] || [];
      if (!flat.length) continue;
      const tagged = flat.map(r => ({ ...r, 'Nguồn kho': `kho_nguoi_benh:${tier}` }));
      out[fileKey] = removeResearchSourceKey(out[fileKey] || [], meta.source_key).concat(tagged);
      sourceKeysByPart.get(fileKey).add(meta.source_key);
      report[hasRun ? 'replaced_by_goc' : 'filled'][fileKey] += 1;
      if (tier !== patientDb.TIER_GOC) report.provisional.push({ research_key: meta.source_key, research_code: meta.research_code || '', file: fileKey });
    }
  }
  return { tables: out, report };
}

module.exports = {
  KHO_OVERLAY_FILE,
  KHO_OVERLAY_PARTS,
  caseDayRange,
  resultDay,
  buildResultDayIndex,
  resultDayIndexHasRange,
  addRowsToResultDayIndex,
  overlayResultsFromPatientDb,
  ingestAllResearchResultsToPatientDb,
  khoOverlayNote,
  provisionalFilesFromProgress,
  overlayHchanhFromPatientDb,
};
