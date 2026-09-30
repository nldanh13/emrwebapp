// server/routes/research.js — Dữ liệu nghiên cứu tách riêng khỏi runtime/session dashboard

'use strict';

const router = require('express').Router();
const routeModel = require('../utils/routeModel');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { ROOT_DIR, RESEARCH_STORE_DIR, ALLOW_IDENTIFIED_RESEARCH_EXPORT } = require('../constants');
const { ensureDir, writeFileAtomic, writeJsonAtomic, readJsonSafe, nowFileStamp, safeFilePart } = require('../utils/file');
const { csvEscape, rowsToCsv, rowsToCsvRaw } = require('../utils/csv');
const { redactLogLine } = require('../utils/log_redact');
const { runPython, runScript, fmtPyError } = require('../services/python_runner');
const { getRuntimePaths } = require('../services/session');
const { appendActivity } = require('../services/activity_logger');
const { findStoredStay, recordHchanhFetch } = require('../services/hchanh_stay_store');
const patientDb = require('../services/patient_db');
const { appendSecurityAudit } = require('../services/security_audit');
const { hasRole } = require('../services/authz');
const { enqueueHeavy, registerCancel, unregisterCancel, isCancelRequested } = require('../services/task_queue');
const variableSelection = require('../research/variable_selection');
const collection = require('../research/collection');
const { sanitizeCustomFields, evaluateCustomFields } = require('../research/analysis_config');
const { firstSurgeryByEncounter, surgeryForMedicationContext } = require('../research/encounter_linkage');
const { strictLocalDate } = require('../research/date_utils');
const { readCsvFileRows } = require('../research/csv_reader');
const { loadPatientLink, applyPatientKeys, savePatientLink, patientLinkPath } = require('../research/patient_link');
const { DEFAULT_SENSITIVE_COLUMNS, redactCsvTable, isSensitiveColumn } = require('../research/export_utils');
const quality = require('../research/quality');
const dataDictionary = require('../research/data_dictionary');
const { databaseInfo, syncResearchDatabase, queryResearchDatabase } = require('../research/sqlite_store');
const {
  read_index: readHchanhIndex,
  read_patient_all: readHchanhPatientAll,
} = require('../hchanh_data_contract');
const { ARCHIVE_ID, ARCHIVE_LABEL, EXPORT_SENSITIVE_COLUMNS, MAX_CSV_BYTES, MAX_TABLE_ROWS, TABLES, archiveMetaPath, archiveRunsDir, archiveSourcePath, cleanStudyId, cohortPath, dateOnlyMs, ensureArchiveStore, ensureResearchStore, normalizedKey, nowIso, removeVietnameseMarks, runsDir, studyDir, studyMetaPath, todayDateInput, uniqueStudyId } = require('../research/store_paths');
const { cell, countCsvRows, getCell, parseCsv, parseDateCell, parseDateTimeCell, patientCode, readCsvTable, readRunTableRowsWhere, safeDownloadName, safeReadRunTable, writeCsv, writeCsvUnion } = require('../research/table_io');
const { buildContextMap, buildEncounterId, contextForRow, dateOffsetDays, daysBetween, encounterMatchMethod, encounterMatchStatus, eventTemporalFields, firstNonEmpty, isoDate, isoDateTime, normalizeSimple, normalizeToken, normalizedIdentity, openStayEnd, parseAnyDate, rowAdmissionTime, rowDischargeTime, rowEmrAdmissionId, rowEmrTreatmentId, rowExistingEncounterId, rowNoitruId, stableHash } = require('../research/encounter_context');
const { bodyRegionFromService, classifyDrugGroup, extractBirthYear, modalityFromService, normalizeDrugName, normalizeFlag, normalizeLabName, normalizeRoute, normalizeSex, parseNumeric, resultOperator, resultText } = require('../research/value_normalizers');
const { CASE_TRACE_RECENT_JSON, CASE_TRACE_RECENT_LIMIT, appendResearchCaseTrace, appendResearchRunLog, readCurrentCaseTrace, readCurrentHchanhCase, readResearchCaseTrace, redactCaseTracePayload } = require('../research/case_trace');
const { RESEARCH_PROCESS_INSTANCE_ID, beginResearchTask, buildCoverageSummary, buildResearchProgressSnapshot, finishResearchTask, hchanhEntryFileStatus, isRowMissingXnCdha, readProgressMapSafe, resetXnCdhaProgress, rowResearchCode, sourceRowsForXnCdhaRefetch, updateResearchTask } = require('../research/progress_snapshot');
const { NORMALIZED_COLUMNS, NORMALIZED_SCHEMA_VERSION } = require('../research/normalized_schema');
const { datasetDirFromRunDir, forceSyncDatabaseAfterDerivedOutput, publicDatabaseInfo, syncDatabaseForRun } = require('../research/research_db');
const { ANALYSIS_PRESETS, _runInference, cleanCustomFields, hoursBetween, loadAnalysisConfig } = require('../research/analysis_presets');
const { byEncounterCount, combineEncounterSources, dedupeByHash, mergeRowsPreferFilled, mergeSameStayRows } = require('../research/source_merge');
const { ENCODED_DIRNAME, cleanResearchGenerated, cleanupStaleDatasetStaging, dedupeRowsByHash, dedupeRowsByStableKey, dedupeSurgeryRows, finalizeAnalysisDataset, listDatasetSnapshots, snapshotFinalDatasetIfUnsaved, verifyAllDatasetSnapshots, verifyDatasetSnapshot, writeDatasetSnapshot } = require('../research/dataset_store');
const { buildEncodedDataset } = require('../research/encoded_dataset');
const { buildPatientHistory } = require('../research/patient_history');
const { VARIABLE_CATALOG_MAX_ROWS, buildVariableCatalog, summarizeVariableColumns } = require('../research/variable_catalog');

const SCRIPT_PATH = path.join(ROOT_DIR, 'research', 'nghien_cuu_1', 'lay_lich_su_xn_cdha.py');
const VARIABLE_PREVIEW_MAX_SOURCE_ROWS = Math.max(5000, Number(process.env.EMR_VARIABLE_PREVIEW_MAX_SOURCE_ROWS || 100000));
const VARIABLE_PREVIEW_MAX_ENCOUNTERS = Math.max(100, Number(process.env.EMR_VARIABLE_PREVIEW_MAX_ENCOUNTERS || 10000));

function researchResponseShouldRedact(req) {
  const requestedIdentified = String(req.query?.identified || '') === '1'
    || String(req.query.redact || '').toLowerCase() === '0'
    || String(req.query.redact || '').toLowerCase() === 'false';
  if (!requestedIdentified) return true;
  if (!ALLOW_IDENTIFIED_RESEARCH_EXPORT) {
    const err = new Error('Xuất dữ liệu nghiên cứu có định danh đang bị khóa. Chỉ bật EMR_ALLOW_IDENTIFIED_RESEARCH_EXPORT sau khi có phê duyệt và kiểm soát truy cập.');
    err.status = 403;
    err.code = 'IDENTIFIED_ACCESS_LOCKED';
    throw err;
  }
  if (!hasRole(req.auth, 'supervisor')) {
    const err = new Error('Chỉ supervisor/admin được xuất dữ liệu nghiên cứu có định danh.');
    err.status = 403;
    err.code = 'IDENTIFIED_ACCESS_ROLE';
    throw err;
  }
  auditIdentifiedResearchAccess(req);
  return false;
}

// Mọi request /research đã có dòng audit chung (activity_logger), nhưng lần xem/xuất
// dữ liệu CÓ ĐỊNH DANH cần một sự kiện riêng dễ lọc: ai, lúc nào, bảng/run/nghiên cứu
// nào và mục đích (tham số ?purpose=, nếu giao diện gửi). Không ghi từ khóa tra cứu.
function auditIdentifiedResearchAccess(req) {
  const q = req.query || {};
  appendSecurityAudit({
    kind: 'research.identified_access',
    actor: { id: String(req.auth?.id || ''), role: String(req.auth?.role || '') },
    method: String(req.method || ''),
    path: String(req.path || ''),
    scope: {
      study_id: String(req.params?.studyId || ''),
      table: String(q.table || ''),
      run_id: String(q.runId || ''),
      has_query: Boolean(String(q.q || '').trim()),
    },
    purpose: String(q.purpose || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200),
  });
}

// Xuất theo từng dòng ra file tạm cạnh file nguồn rồi stream về trình duyệt: bảng XN/CĐHA
// vài trăm MB không còn bị nạp trọn thành object + một chuỗi CSV khổng lồ (hết RAM).
// File tạm có thể chứa định danh (khi được phép xuất có định danh) nên đặt cạnh dữ liệu
// gốc, quyền 600, và xóa ngay khi gửi xong/ngắt kết nối.
function sendCsvFile(res, filePath, filenameBase, { redact = true } = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ status: 'error', message: 'Bảng chưa có file CSV để xuất.' });
  }
  const filename = `${safeDownloadName(filenameBase)}.csv`;
  const tmpPath = path.join(path.dirname(filePath), `.export_tmp_${process.pid}_${crypto.randomBytes(6).toString('hex')}.csv`);
  let fd = null;
  try {
    fd = fs.openSync(tmpPath, 'w', 0o600);
    let buffer = '\ufeff';
    const flush = (force = false) => {
      if (buffer.length && (force || buffer.length >= 1024 * 1024)) {
        fs.writeSync(fd, buffer, null, 'utf-8');
        buffer = '';
      }
    };
    let columns = [];
    readCsvFileRows(filePath, Number.MAX_SAFE_INTEGER, {
      onHeader(header) {
        columns = redact ? redactCsvTable(header, [], EXPORT_SENSITIVE_COLUMNS).columns : header;
        buffer += rowsToCsv(columns, []);
      },
      onRow(row) {
        buffer += `${columns.map(col => csvEscape(row[col] ?? '')).join(',')}\n`;
        flush();
      },
    });
    flush(true);
    fs.closeSync(fd);
    fd = null;
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* bỏ qua */ } }
    try { fs.unlinkSync(tmpPath); } catch (_) { /* bỏ qua */ }
    throw err;
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  const cleanup = () => { fs.unlink(tmpPath, () => {}); };
  const stream = fs.createReadStream(tmpPath);
  stream.on('error', (err) => {
    cleanup();
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
    else res.destroy(err);
  });
  res.on('close', cleanup);
  return stream.pipe(res);
}

function sortRowsForTable(tableKey, rows) {
  const sortable = new Set(['initial_list', 'deep_source', 'patients', 'cohort']);
  if (!sortable.has(String(tableKey || ''))) return rows;
  if (!Array.isArray(rows) || rows.length < 2) return rows;

  const candidates = [
    'T/G vào', 'TG vào', 'Tg vào', 'Thời gian vào', 'Thoi gian vao',
    'Ngày vào viện', 'Ngay vao vien', 'Ngày nhập viện', 'Ngay nhap vien',
    'admission_time', 'admission_datetime', 'admission_date',
  ];

  return [...rows].sort((a, b) => {
    const da = parseDateTimeCell(getCell(a, candidates));
    const db = parseDateTimeCell(getCell(b, candidates));
    const ta = da ? da.getTime() : -Infinity;
    const tb = db ? db.getTime() : -Infinity;
    if (tb !== ta) return tb - ta;
    const ca = patientCode(a);
    const cb = patientCode(b);
    if (cb !== ca) return String(cb).localeCompare(String(ca));
    return String(getCell(a, ['Họ tên', 'Ho ten', 'patient_name'])).localeCompare(String(getCell(b, ['Họ tên', 'Ho ten', 'patient_name'])));
  });
}

function parseDateFilter(value, endOfDay = false) {
  const s = String(value || '').trim();
  if (!s) return null;
  const d = parseDateCell(s);
  if (!d) return null;
  if (endOfDay) d.setHours(23, 59, 59, 999);
  return d;
}

function rowPassesDateFilter(row, filters = {}) {
  const admission = parseDateCell(getCell(row, ['Ngày vào viện', 'Ngay vao vien', 'Ngày nhập viện', 'Ngay nhap vien', 'T/G vào', 'TG vao']));
  const discharge = parseDateCell(getCell(row, ['Ngày ra viện', 'Ngay ra vien', 'Ngày xuất viện', 'Ngay xuat vien', 'T/G ra', 'TG ra']));
  const admitFrom = parseDateFilter(filters.admitFrom);
  const admitTo = parseDateFilter(filters.admitTo, true);
  const dischargeFrom = parseDateFilter(filters.dischargeFrom);
  const dischargeTo = parseDateFilter(filters.dischargeTo, true);

  if (admitFrom && (!admission || admission < admitFrom)) return false;
  if (admitTo && (!admission || admission > admitTo)) return false;
  if (dischargeFrom && (!discharge || discharge < dischargeFrom)) return false;
  if (dischargeTo && (!discharge || discharge > dischargeTo)) return false;
  return true;
}

function listRunsForDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      const runDir = path.join(dir, e.name);
      const manifest = readJsonSafe(path.join(runDir, 'manifest.json'), {});
      const stat = fs.statSync(runDir);
      // Chỉ normalized_outputs là map số lượng. manifest.outputs của worker cũ có thể
      // chứa TÊN FILE (vd. du_lieu_ban_dau.csv), tuyệt đối không đưa filename lên UI như count.
      const outputs = {};
      for (const [key, value] of Object.entries(manifest.normalized_outputs || {})) {
        const n = Number(value);
        if (Number.isFinite(n)) outputs[key] = n;
      }
      // Các bảng raw chưa có trong normalized_outputs: đếm qua cache theo mtime.
      // Vì readCsvTable đã cache, lần sau không đọc/parse lại file nếu không đổi.
      for (const key of ['initial_list', 'deep_source', 'errors']) {
        if (outputs[key] != null) continue;
        const table = TABLES[key];
        if (table?.root === 'run') outputs[key] = countCsvRows(path.join(runDir, table.file));
      }
      const progress = readJsonSafe(path.join(runDir, 'progress.json'), {});
      const totalPatients = Number(manifest.patients_count || 0);
      const progressPatients = Object.entries(progress || {}).filter(([k]) => !k.startsWith('__')).map(([, v]) => v);
      const donePatients = progressPatients.filter(item => item && (item.committed === true || item.status === 'done')).length;
      const doneByTabs = progressPatients.filter(item => item && item.popup === 'done' && item.xn === 'done' && item.cdha === 'done').length;
      return {
        id: e.name,
        created_at: manifest.created_at || new Date(stat.mtimeMs).toISOString(),
        updated_at: manifest.updated_at || new Date(stat.mtimeMs).toISOString(),
        from_date: manifest.from_date || '',
        to_date: manifest.to_date || '',
        patients_count: totalPatients,
        done_patients: donePatients || doneByTabs,
        outputs,
        source: manifest.source || '',
        source_run_id: manifest.source_run_id || '',
      };
    })
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

function latestRunIdFast(dir) {
  if (!fs.existsSync(dir)) return '';
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      const runDir = path.join(dir, e.name);
      const manifest = readJsonSafe(path.join(runDir, 'manifest.json'), {}) || {};
      let mtime = 0;
      try { mtime = fs.statSync(runDir).mtimeMs || 0; } catch (_) {}
      return { id: e.name, created_at: manifest.created_at || new Date(mtime).toISOString(), mtime };
    })
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.mtime - a.mtime)[0]?.id || '';
}

function resolveArchiveRunIdFast(requested = 'latest') {
  const req = String(requested || 'latest');
  if (req && req !== 'latest') return safeRunId(req);
  return latestRunIdFast(archiveRunsDir());
}

function resolveStudyRunIdFast(studyId, requested = 'latest') {
  const req = String(requested || 'latest');
  if (req && req !== 'latest') return safeRunId(req);
  return latestRunIdFast(runsDir(studyId));
}

function readArchiveProgressMeta(runId = '') {
  ensureArchiveStore();
  const meta = readJsonSafe(archiveMetaPath(), {}) || {};
  const sourceCount = countCsvRows(archiveSourcePath());
  const rid = runId || resolveArchiveRunIdFast('latest');
  const manifest = rid ? readJsonSafe(path.join(archiveRunsDir(), rid, 'manifest.json'), {}) || {} : {};
  return {
    id: ARCHIVE_ID,
    name: meta.name || ARCHIVE_LABEL,
    source_count: sourceCount || Number(manifest.normalized_outputs?.initial_list || manifest.patients_count || 0),
    latest_run: rid ? { id: rid, patients_count: Number(manifest.patients_count || 0), outputs: manifest.outputs || {} } : null,
  };
}

function readStudyProgressMeta(studyId, runId = '') {
  const id = cleanStudyId(studyId);
  const meta = readJsonSafe(studyMetaPath(id), null);
  if (!meta || typeof meta !== 'object') return null;
  const rid = runId || resolveStudyRunIdFast(id, 'latest');
  const manifest = rid ? readJsonSafe(path.join(runsDir(id), rid, 'manifest.json'), {}) || {} : {};
  return {
    ...meta,
    id,
    cohort_count: countCsvRows(cohortPath(id)),
    latest_run: rid ? { id: rid, patients_count: Number(manifest.patients_count || 0), outputs: manifest.outputs || {} } : null,
  };
}

function listRuns(studyId) {
  return listRunsForDir(runsDir(studyId));
}

function readStudy(studyId) {
  const id = cleanStudyId(studyId);
  const meta = readJsonSafe(studyMetaPath(id), null);
  if (!meta || typeof meta !== 'object') return null;
  const runs = listRuns(id);
  const cohort = countCsvRows(cohortPath(id));
  return {
    ...meta,
    id,
    cohort_count: cohort,
    has_cohort: fs.existsSync(cohortPath(id)),
    runs,
    latest_run: runs[0] || null,
  };
}

function listStudies() {
  ensureResearchStore();
  return fs.readdirSync(RESEARCH_STORE_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .filter(e => e.name !== ARCHIVE_ID)
    .map(e => readStudy(e.name))
    .filter(Boolean)
    .sort((a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at)));
}

function updateStudy(studyId, patch) {
  const current = readJsonSafe(studyMetaPath(studyId), {});
  const next = { ...current, ...patch, id: studyId, updated_at: nowIso() };
  writeJsonAtomic(studyMetaPath(studyId), next);
  return readStudy(studyId);
}

function resolveRunId(studyId, requested) {
  if (requested && requested !== 'latest') return safeRunId(requested);
  const runs = listRuns(studyId);
  return runs[0]?.id || '';
}

function tablePathFor(studyId, tableKey, runId = 'latest') {
  const table = TABLES[tableKey] || TABLES.patients;
  if (table.root === 'study') return cohortPath(studyId);
  const rid = resolveRunId(studyId, runId);
  if (!rid) return '';
  return path.join(runsDir(studyId), rid, table.file);
}

function listArchiveRuns() {
  return listRunsForDir(archiveRunsDir());
}

function readArchive() {
  ensureArchiveStore();
  const meta = readJsonSafe(archiveMetaPath(), {});
  const runs = listArchiveRuns();
  const latest = runs[0] || null;
  const sourceCount = countCsvRows(archiveSourcePath()) || Number(latest?.outputs?.initial_list || latest?.outputs?.patients || 0);
  // Đọc fatal_alert.json từ run mới nhất nếu có
  let fatalAlert = null;
  if (latest?.id) {
    const alertPath = path.join(archiveRunsDir(), latest.id, 'fatal_alert.json');
    fatalAlert = readJsonSafe(alertPath, null);
  }
  // Đọc thống kê lỗi theo mức độ từ errors.csv
  let errorStats = null;
  if (latest?.id) {
    const errPath = path.join(archiveRunsDir(), latest.id, 'errors.csv');
    const errData = readJsonSafe && fs.existsSync(errPath) ? (() => {
      try {
        const { rows } = readCsvTable(errPath, 50000);
        const warn  = rows.filter(r => (r['Mức độ'] || r.severity || '') === 'WARN').length;
        const error = rows.filter(r => (r['Mức độ'] || r.severity || '') === 'ERROR').length;
        const fatal = rows.filter(r => (r['Mức độ'] || r.severity || '') === 'FATAL').length;
        return { total: rows.length, warn, error, fatal };
      } catch { return null; }
    })() : null;
    errorStats = errData;
  }
  const today = todayDateInput();
  const savedScanTo = String(meta.scan_to_date || '').trim();
  return {
    id: ARCHIVE_ID,
    name: meta.name || ARCHIVE_LABEL,
    description: meta.description || 'Quét toàn bộ danh sách người bệnh Hoàn tất để tạo dữ liệu gốc; nghiên cứu riêng sẽ lọc từ kho này rồi mới lấy dữ liệu sâu.',
    source_filename: meta.source_filename || '',
    source_uploaded_at: meta.source_uploaded_at || '',
    scan_from_date: meta.scan_from_date || '2026-01-01',
    // Metadata cũ có thể lưu ngày 29/05; UI/API mặc định phải mở rộng tới ngày hiện tại.
    scan_to_date: savedScanTo && savedScanTo > today ? savedScanTo : today,
    source_count: sourceCount,
    has_source: fs.existsSync(archiveSourcePath()),
    can_scan_without_source: true,
    runs,
    latest_run: latest,
    updated_at: meta.updated_at || '',
    fatal_alert: fatalAlert,
    error_stats: errorStats,
    refresh_policy: collection.sanitizeRefreshPolicy(meta.refresh_policy || {}),
  };
}

function updateArchive(patch) {
  ensureArchiveStore();
  const current = readJsonSafe(archiveMetaPath(), {});
  const next = { ...current, ...patch, id: ARCHIVE_ID, name: ARCHIVE_LABEL, updated_at: nowIso() };
  writeJsonAtomic(archiveMetaPath(), next);
  return readArchive();
}

// Mã run lấy từ URL/body: chỉ ký tự an toàn cho tên file, và không được là "." hay ".."
// (safeFilePart giữ dấu chấm nên "..", "runId=.." sẽ trỏ lên thư mục cha).
function safeRunId(value) {
  const id = safeFilePart(value);
  return /^\.*$/.test(id) ? '' : id;
}

function resolveArchiveRunId(requested) {
  if (requested && requested !== 'latest') return safeRunId(requested);
  const runs = listArchiveRuns();
  return runs[0]?.id || '';
}

function resolveArchiveRunIdForAction(requested = 'latest') {
  const rid = resolveArchiveRunId(String(requested || 'latest'));
  if (rid) return rid;
  const archive = readArchive();
  return safeFilePart(archive.latest_run?.id || archive.last_run_id || '');
}

function resolveStudyRunIdForAction(studyId, requested = 'latest') {
  if (requested && requested !== 'latest') return safeRunId(requested);
  return resolveRunId(studyId, 'latest') || nowFileStamp();
}

function archiveTablePath(tableKey, runId = 'latest') {
  const table = TABLES[tableKey] || TABLES.patients;
  if (tableKey === 'cohort') return archiveSourcePath();
  const rid = resolveArchiveRunId(runId);
  if (!rid) return '';
  return path.join(archiveRunsDir(), rid, table.file);
}

function chooseArchiveRunIdForResume({ fromDate = '', toDate = '' } = {}) {
  const archive = readArchive();
  const meta = readJsonSafe(archiveMetaPath(), {});
  const requestedToMs = dateOnlyMs(toDate);

  const sameFrom = (run) => !fromDate || String(run.from_date || '') === String(fromDate || '');
  const sameOrExpandableTo = (run) => {
    if (!toDate) return true;
    const runTo = String(run.to_date || '').trim();
    if (runTo === String(toDate || '')) return true;
    const runToMs = dateOnlyMs(runTo);
    // Cho phép dùng lại run cũ khi chỉ mở rộng ngày kết thúc đến hôm nay.
    // Như vậy du_lieu_ban_dau.csv cũ vẫn là mốc để quét tăng dần và dừng sớm.
    if (Number.isFinite(runToMs) && Number.isFinite(requestedToMs)) return runToMs <= requestedToMs;
    return false;
  };

  // Khi quét dữ liệu gốc không có trước tổng số bệnh nhân, nên không thể dựa vào
  // patients_count/done_patients để biết run còn dở. Nếu server/máy bị tắt ngang,
  // active_run_id vẫn còn trong metadata; ưu tiên dùng lại run này để quét tiếp.
  const activeRunId = safeFilePart(meta.active_run_id || '');
  if (activeRunId) {
    const activeRunDir = path.join(archiveRunsDir(), activeRunId);
    if (fs.existsSync(activeRunDir)) {
      const manifest = readJsonSafe(path.join(activeRunDir, 'manifest.json'), {});
      const activeRun = { id: activeRunId, from_date: manifest.from_date || '', to_date: manifest.to_date || '' };
      if (sameFrom(activeRun) && sameOrExpandableTo(activeRun)) return activeRunId;
    }
  }

  const sourceUploadedAt = archive.source_uploaded_at ? new Date(archive.source_uploaded_at).getTime() : 0;
  const runs = listArchiveRuns();
  const reusableRuns = runs
    .filter(r => !sourceUploadedAt || new Date(r.created_at).getTime() >= sourceUploadedAt)
    .filter(sameFrom)
    .filter(sameOrExpandableTo);

  const incomplete = reusableRuns.find(r => r.patients_count > 0 && r.done_patients < r.patients_count);
  if (incomplete?.id) return incomplete.id;

  // Với Bước 1, vẫn ưu tiên dùng lại run gần nhất cùng ngày bắt đầu/khoảng mở rộng
  // để quét tăng dần lên đầu danh sách, thay vì tạo run rỗng rồi phải quét lại toàn bộ.
  if (reusableRuns[0]?.id) return reusableRuns[0].id;

  return nowFileStamp();
}

function chooseStudyRunIdForResume(studyId) {
  const runs = listRuns(studyId);
  const incomplete = runs.find(r => r.patients_count > 0 && r.done_patients < r.patients_count);
  return incomplete?.id || nowFileStamp();
}

function isStoppedRunResult(result) {
  return result && (result.code === 130 || (result.code === -1 && !result.killedByTimeout));
}

function validatePatientCsv(csv, requiredMessage = 'CSV cần có cột Mã BN.') {
  const bytes = Buffer.byteLength(csv, 'utf8');
  if (!String(csv || '').trim()) throw new Error('File CSV rỗng.');
  if (bytes > MAX_CSV_BYTES) {
    const err = new Error('CSV quá lớn.');
    err.status = 413;
    throw err;
  }
  const parsed = parseCsv(csv, { maxRows: 200000 });
  if (!parsed.columns.length || !parsed.rows.length) throw new Error('CSV không có dữ liệu.');
  const hasPatientId = parsed.columns.some(c => /mabn|mabenhnhan/i.test(normalizedKey(c)));
  if (!hasPatientId) throw new Error(requiredMessage);
  return parsed;
}

function copyRowsByPatients(sourceFile, targetFile, patientSet, codeMap) {
  const data = readCsvTable(sourceFile, Number.MAX_SAFE_INTEGER);
  if (!data.columns.length) {
    writeCsv(targetFile, [], []);
    return 0;
  }
  const rows = data.rows
    .filter(row => patientSet.has(patientCode(row)))
    .map(row => {
      const next = { ...row };
      const code = codeMap.get(patientCode(row));
      if (code) next['Mã NC'] = code;
      return next;
    });
  writeCsv(targetFile, data.columns, rows);
  return rows.length;
}

function hchanhProfileRow(payload, meta = {}) {
  const p = payload || {};
  const maBn = p.ma_bn || meta.ma_bn || '';
  return {
    'Mã BN': maBn,
    'Mã vào viện': meta.emr_admission_id || meta.vaovienid || '',
    'Mã điều trị': meta.emr_treatment_id || meta.dieutriid || meta.noitruid || '',
    'Mã nội trú': meta.emr_noitru_id || meta.noitruid || '',
    'URL bác sĩ': meta.record_doctor_url || meta.doctor_url || '',
    'URL điều dưỡng': meta.record_nursing_url || meta.nursing_url || '',
    'Họ tên': p.ho_ten || meta.ho_ten || '',
    'Giới': p.gioi_tinh || p.gioi || '',
    'Ngày sinh': p.ngay_sinh || '',
    'Tuổi': p.tuoi || '',
    'Địa chỉ': p.dia_chi || '',
    'Điện thoại': p.dien_thoai || p.sdt || '',
    'Số CMND': p.cmnd || p.cccd || p.so_cmnd || p.so_cmt || '',
    'Đối tượng': p.doi_tuong || '',
    'Số thẻ': p.bhyt_code || p.so_the_bhyt || '',
    'Loại': p.bhyt_loai || '',
    'Giá trị từ': p.bhyt_tu_ngay || '',
    'Giá trị đến': p.bhyt_den_ngay || '',
    'Ngày vào viện': p.ngay_vao_vien || p.ngay_vao || '',
    'Ngày ra viện': p.ngay_ra_vien || p.ngay_ra || '',
    'Thời gian điều trị': p.so_ngay_dieu_tri || '',
    'Chẩn đoán': p.chan_doan || '',
    'Chẩn đoán vào viện': p.chan_doan_vao || '',
    'Chẩn đoán ra viện': p.chan_doan_ra || '',
    'Phòng/Giường': p.phong || '',
    'Nguồn input': 'hchanh_profile',
  };
}

function hchanhDischargeRow(payload, meta = {}) {
  const p = payload || {};
  const benhKem = Array.isArray(p.benh_kem) ? p.benh_kem.join('; ') : String(p.benh_kem || '');
  return {
    'Mã BN': p.ma_bn || meta.ma_bn || '',
    'Mã vào viện': meta.emr_admission_id || meta.vaovienid || '',
    'Mã điều trị': meta.emr_treatment_id || meta.dieutriid || meta.noitruid || '',
    'Mã nội trú': meta.emr_noitru_id || meta.noitruid || '',
    'URL bác sĩ': meta.record_doctor_url || meta.doctor_url || '',
    'URL điều dưỡng': meta.record_nursing_url || meta.nursing_url || '',
    'Họ tên': meta.ho_ten || '',
    'Ngày vào viện': p.ngay_vao || p.ngay_vao_vien || '',
    'Ngày ra viện': p.raw_time || [p.gio_ra, p.ngay_ra].filter(Boolean).join(' ') || p.ngay_ra || '',
    'Thời gian điều trị': p.tong_so_ngay_dt || p.so_ngay_tai_khoa || '',
    'Chẩn đoán': p.chan_doan_chinh || p.chan_doan_ra || '',
    'Chẩn đoán vào viện': p.chan_doan_vao || '',
    'Chẩn đoán ra viện': p.chan_doan_ra || p.chan_doan_chinh || '',
    'Bệnh kèm': benhKem,
    'Biến chứng': p.bien_chung || '',
    'Tai biến': p.tai_bien || '',
    'Tình trạng ra': p.tinh_trang_ra || p.ket_qua || p.xu_tri || '',
    'ICD chính': p.chan_doan_chinh_icd || '',
    'Nguồn input': 'hchanh_discharge',
  };
}

function jsonShort(value, max = 3000) {
  try {
    const s = JSON.stringify(value ?? '', null, 0);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch (_) {
    return String(value || '').slice(0, max);
  }
}

// index.patients (Hành chánh) giữ 1 dòng mới nhất theo mã BN, không phân biệt
// theo đợt nằm viện. Nếu bệnh nhân tái nhập viện, index có thể đã cập nhật
// admission_time của đợt MỚI trong khi file discharge/surgery/order_history còn
// là dữ liệu của đợt CŨ (chưa ai fetch lại cho đợt mới). Chỉ nhận dữ liệu lấy
// TỪ lúc nhập khoa hiện tại trở về sau — tránh gán nhầm dữ liệu đợt cũ vào kho
// nghiên cứu (khác với Hành chánh, dữ liệu nghiên cứu phải đúng, không thể tự
// quét bù lại như module khác nên bắt buộc phải lọc ở đây).
function hchanhSharedDataMatchesEncounter(payload, meta) {
  const admissionAt = parseAnyDate(meta?.admission_time);
  // Từ khi write_patient_file() (server/hchanh_data_contract.js) đóng dấu đúng
  // đợt Hành chánh đang active LÚC GHI vào _meta.admission_time, so khớp trực
  // tiếp mốc này với đợt đang xét — chính xác hơn hẳn suy đoán qua so sánh
  // fetched_at với admission_time. Chỉ rơi về heuristic cũ khi bản dùng chung
  // là dữ liệu cũ (ghi trước khi có trường này).
  const stampedAdmissionAt = parseAnyDate(payload?._meta?.admission_time);
  if (admissionAt && stampedAdmissionAt) {
    return stampedAdmissionAt.getTime() === admissionAt.getTime();
  }
  const fetchedAt = parseAnyDate(payload?._meta?.fetched_at);
  // Thiếu mốc để so sánh nghĩa là không thể xác nhận dữ liệu thuộc đúng đợt
  // hiện tại. Loại thay vì mặc định coi là khớp — đúng nguyên tắc "dữ liệu
  // nghiên cứu phải đúng, không tự quét bù lại được" đã nêu ở trên; dữ liệu
  // legacy/thiếu mốc thời gian dễ là dữ liệu cũ nhất, nên càng không nên
  // mặc định tin tưởng.
  if (!fetchedAt || !admissionAt) return false;
  return fetchedAt.getTime() >= admissionAt.getTime();
}

function flattenHchanhIntoResearchRun(ctx, runDir) {
  const index = readHchanhIndex(ctx);
  const patients = Object.values(index?.patients || {});
  const profileRows = [];
  const dischargeRows = [];
  const surgeryRows = [];
  const orderRows = [];
  for (const meta of patients) {
    const maBn = String(meta?.ma_bn || '').trim();
    if (!maBn) continue;
    const all = readHchanhPatientAll(ctx, maBn) || {};
    if (all.profile && hchanhSharedDataMatchesEncounter(all.profile, meta)) profileRows.push(hchanhProfileRow(all.profile, meta));
    if (all.discharge && hchanhSharedDataMatchesEncounter(all.discharge, meta)) dischargeRows.push(hchanhDischargeRow(all.discharge, meta));
    const surgeries = (all.surgery && hchanhSharedDataMatchesEncounter(all.surgery, meta) && Array.isArray(all.surgery?.surgeries)) ? all.surgery.surgeries : [];
    for (const item of surgeries) {
      const detail = item.detail || {};
      surgeryRows.push({
        'Mã BN': maBn,
        'Mã vào viện': meta.emr_admission_id || meta.vaovienid || '',
        'Mã điều trị': meta.emr_treatment_id || meta.dieutriid || meta.noitruid || '',
        'Mã nội trú': meta.emr_noitru_id || meta.noitruid || '',
        'Ngày vào viện': meta.admission_time || '',
        'Ngày ra viện': meta.discharge_time || '',
        'Họ tên': item.ho_ten || meta.ho_ten || '',
        'Ngày phẫu thuật': detail.bat_dau || item.thoi_gian || '',
        'Tên phẫu thuật': detail.dich_vu_phau_thuat || item.noi_dung_phau_thuat || '',
        'Phương pháp phẫu thuật': detail.phuong_phap_pt || detail.phuong_phap_phau_thuat || '',
        'PPVC': detail.pp_vo_cam || detail.phuong_phap_vo_cam || '',
        'Phân loại PT': detail.phan_loai_pt || item.tinh_trang || '',
        'Trạng thái': item.trang_thai || '',
        'Chẩn đoán trước mổ': detail.chan_doan_truoc_mo || '',
        'Chẩn đoán sau mổ': detail.chan_doan_sau_mo || '',
        'Phòng mổ': item.phong_mo || '',
        'Nguồn': 'hchanh_surgery',
        'Raw JSON': jsonShort(item),
      });
    }
    const historyRows = (all.order_history && hchanhSharedDataMatchesEncounter(all.order_history, meta) && Array.isArray(all.order_history?.rows)) ? all.order_history.rows : [];
    for (const item of historyRows) {
      orderRows.push({
        'Mã BN': maBn,
        'Mã vào viện': meta.emr_admission_id || meta.vaovienid || '',
        'Mã điều trị': meta.emr_treatment_id || meta.dieutriid || meta.noitruid || '',
        'Mã nội trú': meta.emr_noitru_id || meta.noitruid || '',
        'Ngày vào viện': meta.admission_time || '',
        'Ngày ra viện': meta.discharge_time || '',
        'Họ tên': meta.ho_ten || '',
        'TG y lệnh': item.tg_ylenh || item.ngay || '',
        'Ngày': item.ngay || '',
        'Bác sĩ': item.bac_si || '',
        'Diễn biến': item.dien_bien || '',
        'Tên y lệnh': item.ten_y_lenh || '',
        'Y lệnh khác': item.y_lenh_khac || '',
        'KQ': item.kq_text || '',
        'Trạng thái': item.status || '',
        'Nguồn': 'hchanh_order_history',
        'Raw JSON': jsonShort(item),
      });
    }
  }
  const dir = path.resolve(runDir);
  ensureDir(dir);
  if (profileRows.length) writeCsv(path.join(dir, 'hchanh_profile.csv'), Object.keys(profileRows[0]), profileRows);
  if (dischargeRows.length) writeCsv(path.join(dir, 'hchanh_discharge.csv'), Object.keys(dischargeRows[0]), dischargeRows);
  if (surgeryRows.length) writeCsv(path.join(dir, 'hchanh_surgery.csv'), Object.keys(surgeryRows[0]), surgeryRows);
  if (orderRows.length) writeCsv(path.join(dir, 'hchanh_order_history.csv'), Object.keys(orderRows[0]), orderRows);
  return { profile: profileRows.length, discharge: dischargeRows.length, surgery: surgeryRows.length, order_history: orderRows.length };
}

function researchHchanhSourceKey(row, sourceRunId = '') {
  const explicit = firstNonEmpty(row, ['Research key', 'research_key', 'source_key']);
  if (explicit) return String(explicit);
  // Không dùng sourceRunId để progress của cùng một lượt có thể tiếp tục qua nhiều lần chạy.
  return buildEncounterId(row, sourceRunId);
}

function researchHchanhMeta(row, sourceRunId = '') {
  const code = patientCode(row);
  // fetch_from_date/fetch_to_date là khoảng lấy dữ liệu đã đồng bộ theo run;
  // không ghi đè Ngày vào/ra viện thật của người bệnh.
  const admissionRaw = firstNonEmpty(row, ['fetch_from_date', 'Ngày vào viện', 'Ngay vao vien', 'Ngày nhập viện', 'Ngay nhap vien', 'T/G vào', 'TG vao', 'admission_date']);
  const dischargeRaw = firstNonEmpty(row, ['fetch_to_date', 'Ngày ra viện', 'Ngay ra vien', 'Ngày xuất viện', 'Ngay xuat vien', 'T/G ra', 'TG ra', 'discharge_date']);
  const actualAdmission = firstNonEmpty(row, ['Ngày vào viện', 'Ngay vao vien', 'Ngày nhập viện', 'Ngay nhap vien', 'T/G vào', 'TG vao', 'admission_date']);
  const actualDischarge = firstNonEmpty(row, ['Ngày ra viện', 'Ngay ra vien', 'Ngày xuất viện', 'Ngay xuat vien', 'T/G ra', 'TG ra', 'discharge_date']);
  return {
    source_key: researchHchanhSourceKey(row, sourceRunId),
    research_code: firstNonEmpty(row, ['Mã NC', 'Ma NC', 'research_code']),
    ma_bn: code,
    ho_ten: firstNonEmpty(row, ['Họ tên', 'Ho ten', 'Tên BN', 'Ten BN', 'patient_name']),
    date_from: isoDate(admissionRaw) || admissionRaw || '',
    date_to: isoDate(dischargeRaw) || dischargeRaw || '',
    admission_raw: actualAdmission || admissionRaw || '',
    discharge_raw: actualDischarge || dischargeRaw || '',
    emr_admission_id: rowEmrAdmissionId(row) || '',
    emr_treatment_id: rowEmrTreatmentId(row) || '',
    emr_noitru_id: rowNoitruId(row) || '',
    doctor_url: firstNonEmpty(row, ['URL bác sĩ', 'URL bac si', 'record_doctor_url', 'doctor_url']),
    nursing_url: firstNonEmpty(row, ['URL điều dưỡng', 'URL dieu duong', 'record_nursing_url', 'nursing_url']),
  };
}

function withResearchHchanhMeta(out, meta, sourceRunId) {
  return {
    ...out,
    'Mã NC': meta.research_code || out['Mã NC'] || '',
    'Research key': meta.source_key,
    'Nguồn input': out['Nguồn input'] || out['Nguồn'] || 'hchanh_auto',
    // Ghi ngày vào/ra viện thật để contextForRow build được encounter_id đúng khi normalize
    'Ngày vào viện': out['Ngày vào viện'] || meta.admission_raw || '',
    'Ngày ra viện':  out['Ngày ra viện']  || meta.discharge_raw  || '',
    'Mã vào viện': out['Mã vào viện'] || meta.emr_admission_id || '',
    'Mã điều trị': out['Mã điều trị'] || meta.emr_treatment_id || meta.emr_noitru_id || '',
    'Mã nội trú': out['Mã nội trú'] || meta.emr_noitru_id || '',
    'URL bác sĩ': out['URL bác sĩ'] || meta.doctor_url || '',
    'URL điều dưỡng': out['URL điều dưỡng'] || meta.nursing_url || '',
    'source_run_id': sourceRunId || '',
  };
}

function hchanhPayloadHasUsefulData(payload, fields = []) {
  if (!payload || typeof payload !== 'object') return false;
  const status = String(payload._fetch_status || '').toLowerCase();
  if (['error', 'no_url', 'no_session', 'timeout'].includes(status)) return false;
  if (String(payload._reason || '') === 'patient_not_completed_currently') return false;
  if (!fields.length) return !['empty'].includes(status);
  return fields.some(k => {
    const v = payload[k];
    if (Array.isArray(v)) return v.length > 0;
    return String(v ?? '').trim() !== '';
  });
}

function hchanhFetchOutputToRows(output, sourceRow, sourceRunId = '') {
  const meta = researchHchanhMeta(sourceRow, sourceRunId);
  const profileRows = [];
  const dischargeRows = [];
  const surgeryRows = [];
  const orderRows = [];
  const payload = output && typeof output === 'object' ? output : {};

  if (hchanhPayloadHasUsefulData(payload.profile, [
    'bhyt_code', 'ngay_vao_vien', 'ngay_sinh', 'dia_chi', 'doi_tuong', 'chan_doan_vao',
  ])) {
    profileRows.push(withResearchHchanhMeta(hchanhProfileRow(payload.profile, meta), meta, sourceRunId));
  }
  if (hchanhPayloadHasUsefulData(payload.discharge, [
    'xu_tri', 'tinh_trang_ra', 'ket_qua', 'chan_doan_chinh', 'chan_doan_ra', 'ngay_ra', 'raw_time', 'benh_kem',
  ])) {
    dischargeRows.push(withResearchHchanhMeta(hchanhDischargeRow(payload.discharge, meta), meta, sourceRunId));
  }

  const surgeries = Array.isArray(payload.surgery?.surgeries) ? payload.surgery.surgeries : [];
  for (const item of surgeries) {
    const detail = item?.detail || {};
    surgeryRows.push(withResearchHchanhMeta({
      'Mã BN': meta.ma_bn,
      'Họ tên': item?.ho_ten || meta.ho_ten || '',
      'Ngày phẫu thuật': detail.bat_dau || item?.thoi_gian || detail.ngay_phau_thuat || '',
      'Tên phẫu thuật': detail.dich_vu_phau_thuat || item?.noi_dung_phau_thuat || detail.ten_phau_thuat || '',
      'Phương pháp phẫu thuật': detail.phuong_phap_pt || detail.phuong_phap_phau_thuat || detail.pppt || '',
      'PPVC': detail.pp_vo_cam || detail.phuong_phap_vo_cam || detail.ppvc || '',
      'Phân loại PT': detail.phan_loai_pt || item?.tinh_trang || '',
      'Trạng thái': item?.trang_thai || '',
      'Chẩn đoán trước mổ': detail.chan_doan_truoc_mo || '',
      'Chẩn đoán sau mổ': detail.chan_doan_sau_mo || '',
      'Phòng mổ': item?.phong_mo || '',
      'Nguồn': 'hchanh_auto_surgery',
      'Raw JSON': jsonShort(item),
    }, meta, sourceRunId));
  }

  const historyRows = Array.isArray(payload.order_history?.rows) ? payload.order_history.rows : [];
  for (const item of historyRows) {
    orderRows.push(withResearchHchanhMeta({
      'Mã BN': meta.ma_bn,
      'Họ tên': meta.ho_ten || '',
      'TG y lệnh': item?.tg_ylenh || item?.ngay || '',
      'Ngày': item?.ngay || '',
      'Bác sĩ': item?.bac_si || '',
      'Diễn biến': item?.dien_bien || '',
      'Tên y lệnh': item?.ten_y_lenh || '',
      'Y lệnh khác': item?.y_lenh_khac || '',
      'KQ': item?.kq_text || '',
      'Trạng thái': item?.status || '',
      'Nguồn': 'hchanh_auto_order_history',
      'Raw JSON': jsonShort(item),
    }, meta, sourceRunId));
  }

  return { profileRows, dischargeRows, surgeryRows, orderRows, meta };
}

function runDateContext(runDir, defaults = {}) {
  const manifest = readJsonSafe(path.join(runDir, 'manifest.json'), {}) || {};
  const from = String(manifest.from_date || defaults.from_date || defaults.scan_from_date || defaults.fallbackDateFrom || '').trim();
  const to = String(manifest.to_date || defaults.to_date || defaults.scan_to_date || defaults.fallbackDateTo || '').trim();
  return {
    from_date: isoDate(from) || from || '',
    to_date: isoDate(to) || to || '',
    manifest,
  };
}

function researchSourceCandidatePaths(runDir, fallbackPath = '') {
  // Thứ tự nguồn gốc thống nhất:
  // 1) research_source.csv nếu đã tạo
  // 2) du_lieu_ban_dau.csv: danh sách Hoàn tất được Bước 1 quét, cũng là input của Bước 2 XN/CĐHA
  // 3) cohort.csv/fallback: danh sách mẫu của nghiên cứu riêng
  // 4) raw sâu chỉ dùng dự phòng khi thiếu nguồn 1-3
  // 5) bảng chuẩn hóa chỉ là dự phòng cuối, không làm nguồn chính.
  return [
    path.join(runDir, 'research_source.csv'),
    path.join(runDir, 'du_lieu_ban_dau.csv'),
    fallbackPath,
    path.join(runDir, 'mau_nghien_cuu.csv'),
    path.join(runDir, 'du_lieu_goc.csv'),
    path.join(runDir, 'du_lieu_ban_dau_da_gop.csv'),
    path.join(runDir, 'patients.csv'),
    path.join(runDir, 'encounters.csv'),
    path.join(runDir, 'analysis_ready.csv'),
  ].filter(Boolean);
}

function rowFetchDateWindow(row, dateCtx = {}) {
  const admissionRaw = rowAdmissionTime(row) || firstNonEmpty(row, [
    'Ngày vào viện', 'Ngay vao vien', 'Ngày nhập viện', 'Ngay nhap vien',
    'T/G vào', 'TG vao', 'admission_date', 'ngay_vao_vien', 'ngay_vao', 'fetch_from_date',
  ]);
  const dischargeRaw = rowDischargeTime(row) || firstNonEmpty(row, [
    'Ngày ra viện', 'Ngay ra vien', 'Ngày xuất viện', 'Ngay xuat vien',
    'T/G ra', 'TG ra', 'discharge_date', 'ngay_ra_vien', 'ngay_ra', 'fetch_to_date',
  ]);
  const from = isoDate(admissionRaw) || isoDate(dateCtx.from_date) || admissionRaw || dateCtx.from_date || '';
  const to = isoDate(dischargeRaw) || isoDate(dateCtx.to_date) || dischargeRaw || dateCtx.to_date || from || '';
  return { from, to, admissionRaw, dischargeRaw };
}

// Mã NC phải DUY NHẤT theo từng dòng nguồn (Research key) và ỔN ĐỊNH qua các lần
// quét lại. du_lieu_ban_dau.csv không có cột Mã NC, nên mã được cấp ở đây: giữ mã cũ
// của cùng Research key (previousCodes, đọc từ research_source.csv trước đó), dòng mới
// nhận số kế tiếp sau mã lớn nhất đã dùng. Trước đây biểu thức `out.length + 1` luôn
// ra NC0001 (mảng out không bao giờ được thêm phần tử), khiến mọi dòng trùng Mã NC và
// bước chuẩn hóa ghép nhầm dữ liệu giữa các đợt của cùng người bệnh.
function normalizeResearchSourceRows(rows, { sourceFile = '', sourceRunId = '', dateCtx = {}, previousCodes = new Map(), reservedCodes = [] } = {}) {
  const seen = new Map();
  const baseName = sourceFile ? path.basename(sourceFile) : '';
  const used = new Set();
  let nextNumber = 1;
  const reserve = (code) => {
    used.add(code);
    const m = /^NC(\d+)$/i.exec(String(code || '').trim());
    if (m) nextNumber = Math.max(nextNumber, Number(m[1]) + 1);
  };
  const allocate = () => {
    let code = '';
    do { code = `NC${String(nextNumber).padStart(4, '0')}`; nextNumber += 1; } while (used.has(code));
    used.add(code);
    return code;
  };
  for (const code of previousCodes.values()) reserve(code);
  for (const code of reservedCodes) reserve(code);
  for (const row of rows || []) {
    const explicit = firstNonEmpty(row, ['Mã NC', 'Ma NC', 'research_code']);
    if (explicit) reserve(explicit);
  }

  for (const row of rows || []) {
    const code = patientCode(row);
    if (!code) continue;
    const win = rowFetchDateWindow(row, dateCtx);
    const explicit = firstNonEmpty(row, ['Mã NC', 'Ma NC', 'research_code']);
    // Khóa không phụ thuộc Mã NC cấp mới (chỉ dùng Mã NC nếu nguồn đã có sẵn).
    const key = researchHchanhSourceKey({ ...row, fetch_from_date: win.from, fetch_to_date: win.to }, sourceRunId);
    const researchCode = explicit
      || seen.get(key)?.['Mã NC']
      || previousCodes.get(key)
      || allocate();
    const normalized = {
      ...row,
      'Mã NC': researchCode,
      'Mã BN': code,
      'Họ tên': firstNonEmpty(row, ['Họ tên', 'Ho ten', 'Tên BN', 'Ten BN', 'patient_name']),
      // Không ghi đè ngày vào/ra viện thật; fetch_* chỉ dùng cho các worker tự động.
      fetch_from_date: win.from,
      fetch_to_date: win.to,
      source_scan_from_date: dateCtx.from_date || '',
      source_scan_to_date: dateCtx.to_date || '',
      source_file: baseName,
      source_run_id: sourceRunId || '',
      'Research key': key,
      // Chữ ký (hash) từng dòng danh sách của đợt: dùng để biết dữ liệu EMR có thay đổi
      // giữa các lần quét, chỉ lấy lại ca thay đổi (xem server/research/collection.js).
      list_row_signatures: collection.mergeSignatures(collection.listRowSignature(row)),
    };
    if (!seen.has(key)) seen.set(key, normalized);
    else {
      const prev = seen.get(key);
      seen.set(key, {
        ...mergeSameStayRows(prev, normalized),
        'Mã NC': prev['Mã NC'],
        list_row_signatures: collection.mergeSignatures(prev.list_row_signatures, normalized.list_row_signatures),
      });
    }
  }
  return Array.from(seen.values());
}

// Research key -> Mã NC từ research_source.csv cũ, chỉ lấy mã dùng cho đúng MỘT key
// (mã bị trùng giữa nhiều key là dữ liệu hỏng, không được giữ lại).
function previousResearchCodes(rows) {
  const byCode = new Map();
  for (const row of rows || []) {
    const key = firstNonEmpty(row, ['Research key']);
    const code = firstNonEmpty(row, ['Mã NC', 'Ma NC', 'research_code']);
    if (!key || !code) continue;
    if (!byCode.has(code)) byCode.set(code, new Set());
    byCode.get(code).add(key);
  }
  const out = new Map();
  for (const [code, keys] of byCode.entries()) {
    if (keys.size === 1) out.set([...keys][0], code);
  }
  return out;
}

function researchCodesConflict(rows) {
  const keyByCode = new Map();
  for (const row of rows || []) {
    const key = firstNonEmpty(row, ['Research key']);
    const code = firstNonEmpty(row, ['Mã NC', 'Ma NC', 'research_code']);
    if (!key || !code) continue;
    if (keyByCode.has(code) && keyByCode.get(code) !== key) return true;
    keyByCode.set(code, key);
  }
  return false;
}

function preferredResearchSourceSeedPath(runDir, fallbackPath = '') {
  const runPath = path.resolve(runDir);
  // Chỉ xét các file raw có thể là nguồn thật. Không xét patients.csv/encounters.csv
  // vì đó là output chuẩn hóa và luôn có mtime mới hơn research_source.csv.
  const candidates = [
    path.join(runPath, 'du_lieu_ban_dau.csv'),
    fallbackPath,
    path.join(runPath, 'mau_nghien_cuu.csv'),
    path.join(runPath, 'du_lieu_goc.csv'),
    path.join(runPath, 'du_lieu_ban_dau_da_gop.csv'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (fs.statSync(file).isFile() && countCsvRows(file) > 0) return file;
    } catch (_) {}
  }
  return '';
}

function researchSourceNeedsRefresh(runDir, sourcePath, fallbackPath = '') {
  if (!sourcePath || !fs.existsSync(sourcePath)) return true;
  const seedPath = preferredResearchSourceSeedPath(runDir, fallbackPath);
  if (!seedPath) return false;
  try {
    const sourceStat = fs.statSync(sourcePath);
    const seedStat = fs.statSync(seedPath);
    return seedStat.mtimeMs > sourceStat.mtimeMs;
  } catch (_) {
    return true;
  }
}

function ensureResearchSourceRows(runDir, { fallbackPath = '', sourceRunId = '', dateDefaults = {}, force = false } = {}) {
  const runPath = path.resolve(runDir);
  ensureDir(runPath);
  const sourcePath = path.join(runPath, 'research_source.csv');
  const dateCtx = runDateContext(runPath, dateDefaults);

  const sourceStale = !force && researchSourceNeedsRefresh(runPath, sourcePath, fallbackPath);
  const existingRows = fs.existsSync(sourcePath)
    ? (readCsvTable(sourcePath, Number.MAX_SAFE_INTEGER).rows || []).filter(r => patientCode(r))
    : [];
  // File cũ có Mã NC trùng giữa các dòng khác nhau (lỗi cấp mã trước đây) phải được
  // tạo lại; mã hợp lệ của từng Research key vẫn được giữ nguyên.
  const codesBroken = researchCodesConflict(existingRows);
  if (!force && !sourceStale && !codesBroken && existingRows.length) {
    const rows = existingRows;
    if (rows.length) {
      return { rows, file: sourcePath, base_file: firstNonEmpty(rows[0], ['source_file']) || path.basename(sourcePath), candidates: researchSourceCandidatePaths(runPath, fallbackPath), date_context: dateCtx };
    }
  }

  const candidates = researchSourceCandidatePaths(runPath, fallbackPath).filter(f => path.basename(f || '') !== 'research_source.csv');
  let pickedFile = '';
  let pickedRows = [];
  for (const file of candidates) {
    if (!file || !fs.existsSync(file)) continue;
    const parsed = readCsvTable(file, Number.MAX_SAFE_INTEGER);
    const rows = (parsed.rows || []).filter(r => patientCode(r));
    if (rows.length) {
      pickedFile = file;
      pickedRows = rows;
      break;
    }
  }
  if (!pickedRows.length) return { rows: [], file: '', base_file: '', candidates, date_context: dateCtx };

  // Ưu tiên giữ mã của research_source.csv cũ; sau đó dùng mã mà script XN/CĐHA đã
  // cấp cho cùng đợt trong du_lieu_goc.csv (cùng Research key qua Mã điều trị/nội trú),
  // để hai nơi cấp mã không cho cùng một đợt hai Mã NC khác nhau.
  const previousCodes = previousResearchCodes(existingRows);
  const reservedCodes = [];
  const deepPath = path.join(runPath, 'du_lieu_goc.csv');
  if (fs.existsSync(deepPath)) {
    const deepRows = (readCsvTable(deepPath, Number.MAX_SAFE_INTEGER).rows || [])
      .filter(r => patientCode(r))
      .map(r => ({ ...r, 'Research key': researchHchanhSourceKey(r, sourceRunId) }));
    const usedCodes = new Set(previousCodes.values());
    // Mọi mã script XN/CĐHA đã dùng đều được giữ chỗ để không cấp trùng cho đợt khác.
    for (const r of deepRows) { const c = rowResearchCode(r); if (c) reservedCodes.push(c); }
    for (const [key, code] of previousResearchCodes(deepRows).entries()) {
      if (!previousCodes.has(key) && !usedCodes.has(code)) { previousCodes.set(key, code); usedCodes.add(code); }
    }
  }
  const normalized = normalizeResearchSourceRows(pickedRows, {
    sourceFile: pickedFile, sourceRunId, dateCtx, previousCodes, reservedCodes,
  });
  writeCsvUnion(sourcePath, normalized, [
    'Mã NC', 'Mã BN', 'Họ tên', 'Ngày vào viện', 'Ngày ra viện',
    'fetch_from_date', 'fetch_to_date', 'source_scan_from_date', 'source_scan_to_date',
    'source_file', 'source_run_id', 'Research key',
  ]);

  const manifestPath = path.join(runPath, 'manifest.json');
  const manifest = readJsonSafe(manifestPath, {}) || {};
  writeJsonAtomic(manifestPath, {
    ...manifest,
    updated_at: nowIso(),
    research_source_at: nowIso(),
    research_source_file: path.basename(pickedFile),
    research_source_rows: normalized.length,
    research_source_scan_from_date: dateCtx.from_date || '',
    research_source_scan_to_date: dateCtx.to_date || '',
  });

  return { rows: normalized, file: sourcePath, base_file: pickedFile, candidates, date_context: dateCtx };
}

function readResearchHchanhSourceRows(runDir, fallbackPath = '', options = {}) {
  // Tất cả nút tự động trong nghiên cứu phải dùng research_source.csv làm nguồn chung.
  // Nếu file này chưa có thì tạo từ du_lieu_ban_dau.csv/cohort.csv, tức cùng nguồn với Bước 2 XN/CĐHA.
  return ensureResearchSourceRows(runDir, {
    fallbackPath,
    sourceRunId: options.sourceRunId || path.basename(path.resolve(runDir)),
    dateDefaults: options.dateDefaults || {},
    force: options.force === true,
  });
}

function uniqueResearchHchanhRows(rows, sourceRunId = '') {
  const map = new Map();
  for (const row of rows || []) {
    const code = patientCode(row);
    if (!code) continue;
    const key = researchHchanhSourceKey(row, sourceRunId);
    if (!map.has(key)) map.set(key, row);
    else map.set(key, mergeRowsPreferFilled(map.get(key), row));
  }
  return Array.from(map.values());
}

function removeResearchSourceKey(rows, sourceKey) {
  return (rows || []).filter(r => String(r?.['Research key'] || r?.source_key || '') !== String(sourceKey || ''));
}

function hchanhDefaultFiles(files) {
  const allowed = new Set(['profile', 'discharge', 'surgery', 'order_history']);
  const requested = Array.isArray(files) ? files.map(x => String(x || '').trim()).filter(Boolean) : [];
  const filtered = requested.filter(x => allowed.has(x));
  // Mặc định lấy profile + discharge + surgery (không lấy y lệnh vì không phải NC nào cũng cần).
  // Nếu caller truyền order_history vào files thì gộp luôn vào 1 lần fetch.
  return filtered.length ? filtered : ['profile', 'discharge', 'surgery'];
}

function orderHistoryDefaultFiles(files) {
  const requested = Array.isArray(files) ? files.map(x => String(x || '').trim()).filter(Boolean) : [];
  return requested.includes('order_history') ? ['order_history'] : ['order_history'];
}

function orderHistoryRunLabel(files) {
  const joined = (files || []).join(',');
  return joined === 'order_history' ? 'lịch sử y lệnh' : `lịch sử y lệnh (${joined})`;
}

function parseResearchHeadless(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (['0', 'false', 'no', 'n', 'off', 'visible', 'show'].includes(text)) return false;
  if (['1', 'true', 'yes', 'y', 'on', 'hidden', 'headless'].includes(text)) return true;
  return defaultValue;
}

function researchHeadlessFromBody(body) {
  // Riêng module nghiên cứu mặc định chạy ẩn để không bật nhiều cửa sổ Chrome khi quét dài.
  // Vẫn cho phép bật lại cửa sổ bằng body.headless=false nếu cần debug.
  return parseResearchHeadless(body?.headless, true);
}

function statusCountsFromHchanhOutput(output) {
  const counts = { ok: 0, attention: 0, error: 0, total: 0 };
  for (const payload of Object.values(output || {})) {
    const st = String(payload?._fetch_status || '').toLowerCase();
    counts.total += 1;
    if (st === 'ok') counts.ok += 1;
    else if (['empty', 'partial'].includes(st)) counts.attention += 1;
    else if (['error', 'no_url', 'no_session', 'timeout'].includes(st)) counts.error += 1;
  }
  return counts;
}
function hchanhFailureCacheKey(meta, wantedFiles, status = 'Hoàn tất') {
  const maBn = String(meta?.ma_bn || '').trim();
  const filesKey = [...(wantedFiles || [])].map(v => String(v || '').trim()).filter(Boolean).sort().join(',');
  return `${maBn}|${String(status || '').trim()}|${filesKey}`;
}

function hchanhFailureSignatureFromTrace(workerTrace = [], output = {}) {
  const tags = new Set((Array.isArray(workerTrace) ? workerTrace : []).map(ev => String(ev?.tag || '')));
  if (tags.has('ERROR.NO_PATIENT_LINK')) return 'no_patient_link';
  if (tags.has('ERROR.NO_URL_PROFILE') || tags.has('ERROR.NO_URL_DISCHARGE') || tags.has('ERROR.NO_URL_ORDER_HISTORY') || tags.has('ERROR.NO_URL_SURGERY')) return 'no_url';
  const statuses = Object.entries(output || {})
    .filter(([k, v]) => !String(k).startsWith('_') && v && typeof v === 'object')
    .map(([, v]) => String(v?._fetch_status || '').toLowerCase())
    .filter(Boolean);
  if (statuses.length && statuses.every(st => st === 'no_url')) return 'no_url';
  if (statuses.includes('no_session')) return 'no_session';
  if (statuses.includes('timeout')) return 'timeout';
  if (statuses.includes('error')) return 'error';
  return '';
}

// Trạng thái RIÊNG từng file của một ca (profile/discharge/surgery/order_history) để sổ
// thu thập biết phần nào có dữ liệu, phần nào EMR không có, phần nào lỗi.
function hchanhFileStatusPatch(output, rowCounts, wantedFiles, previousCounts, at, fallbackStatus = '') {
  const out = {};
  for (const f of wantedFiles || []) {
    const payload = output && typeof output === 'object' ? output[f] : null;
    const rows = Number(rowCounts?.[f]) || 0;
    const fetchStatus = payload && typeof payload === 'object' ? String(payload._fetch_status || '') : '';
    const entry = { fetch_status: fetchStatus || fallbackStatus || 'pending', rows, at };
    if (payload?._reason) entry.reason = String(payload._reason).slice(0, 120);
    if (payload?._error) entry.detail = String(payload._error).split('\n')[0].slice(0, 300);
    if (entry.fetch_status === 'ok' && rows === 0 && (Number(previousCounts?.[f]) || 0) > 0) {
      // EMR nay rỗng mà lần trước có dữ liệu: dữ liệu cũ được giữ, cần người xem.
      entry.override_status = 'blocked';
      entry.override_reason = 'emr_now_empty_previously_had_data';
    }
    out[f] = entry;
  }
  return out;
}

async function fetchHchanhForResearchRun(ctx, runDir, {
  sourceRows = [], sourceRunId = '', files = null, headless = true, force = false,
  fallbackDateFrom = '', fallbackDateTo = '', limit = 0,
  mode = 'hchanh_auto', saveRaw = false, forceKeys = null, refreshProvisional = false,
} = {}) {
  const normalizedMode = String(mode || '').trim() === 'order_history_auto' ? 'order_history_auto' : 'hchanh_auto';
  const wantedFiles = normalizedMode === 'order_history_auto' ? orderHistoryDefaultFiles(files) : hchanhDefaultFiles(files);
  const runLabel = normalizedMode === 'order_history_auto' ? orderHistoryRunLabel(wantedFiles) : 'hành chánh tự động';
  const progressFile = normalizedMode === 'order_history_auto' ? 'order_history_auto_progress.json' : 'hchanh_auto_progress.json';
  const rawFolder = normalizedMode === 'order_history_auto' ? 'order_history_auto_raw' : 'hchanh_auto_raw';
  const logPrefix = normalizedMode === 'order_history_auto' ? 'ORDER AUTO' : 'HC AUTO';

  const runPath = path.resolve(runDir);
  ensureDir(runPath);
  const progressPath = path.join(runPath, progressFile);
  const rawDir = path.join(runPath, rawFolder);
  ensureDir(rawDir);

  const rows = uniqueResearchHchanhRows(sourceRows, sourceRunId);
  const selectedRows = limit > 0 ? rows.slice(0, limit) : rows;
  let progress = readJsonSafe(progressPath, {}) || {};
  const failureCachePath = path.join(runPath, `${normalizedMode}_failure_cache.json`);
  let failureCache = readJsonSafe(failureCachePath, {}) || {};

  let profileRows = readCsvTable(path.join(runPath, 'hchanh_profile.csv'), Number.MAX_SAFE_INTEGER).rows;
  let dischargeRows = readCsvTable(path.join(runPath, 'hchanh_discharge.csv'), Number.MAX_SAFE_INTEGER).rows;
  let surgeryRows = readCsvTable(path.join(runPath, 'hchanh_surgery.csv'), Number.MAX_SAFE_INTEGER).rows;
  let orderRows = readCsvTable(path.join(runPath, 'hchanh_order_history.csv'), Number.MAX_SAFE_INTEGER).rows;

  // hchanh_fetch.py gộp nhiều BN vào 1 phiên Chrome/đăng nhập theo lô (xem
  // HCHANH_BATCH_SIZE bên dưới), giống cách script XN&CĐHA dùng lại 1 Chrome
  // cho cả lô. Đo lại tổng số lô + thời gian mỗi lô, ghi vào action_log.txt để
  // có số liệu cụ thể đánh giá tải lên server EMR, thay vì chỉ ước lượng cảm tính.
  const stats = { total: selectedRows.length, processed: 0, skipped: 0, reused: 0, ok: 0, attention: 0, error: 0, cancelled: false, chromeCycles: 0, chromeCycleMs: 0 };
  appendResearchRunLog(runPath, `[${new Date().toLocaleString('vi-VN')}] Bắt đầu lấy ${runLabel}: ${selectedRows.length} ca | files=${wantedFiles.join(',')}`);
  appendActivity(ctx, {
    kind: 'workflow.research.fetch_hchanh.start',
    mode: normalizedMode,
    run_dir: path.basename(runPath),
    total: selectedRows.length,
    files: wantedFiles,
  });

  // hchanh_fetch.py hỗ trợ gộp nhiều BN vào 1 phiên Chrome/đăng nhập khi --input là
  // JSON array (xem run_hchanh_fetch_batch). Thay vì spawn 1 tiến trình/ca (mỗi ca
  // 1 Chrome + 1 lần đăng nhập EMR), gộp tối đa HCHANH_BATCH_SIZE ca liên tiếp vào
  // 1 tiến trình worker — Chrome chỉ đóng+mở lại (đăng nhập lại) sau mỗi lô, giảm
  // hẳn số lần mở/tắt Chrome và đăng nhập dồn dập lên server EMR.
  const HCHANH_BATCH_SIZE = 10;

  // Danh sách chờ tìm lại: BN từng không tìm thấy trên HIS (no_url/no_patient_link,
  // ghi trong failure cache) bị dời xuống cuối. Chỉ tìm lại khi mọi ca còn lại đã
  // lấy xong (done/partial) — tránh tốn Chrome dò đi dò lại BN không có trên danh
  // sách nội trú trong khi các ca khác còn chưa có dữ liệu. force=true bỏ qua cơ chế này.
  const DEFERRED_FAILURE_REASONS = ['no_patient_link', 'no_url'];
  const mainEntries = [];
  const deferredEntries = [];
  selectedRows.forEach((row, idx) => {
    const meta = researchHchanhMeta(row, sourceRunId);
    const previousFailure = failureCache[hchanhFailureCacheKey(meta, wantedFiles, 'Hoàn tất')];
    const deferred = !force && !forceKeys?.has(meta.source_key)
      && progress[meta.source_key]?.status !== 'done'
      && previousFailure && DEFERRED_FAILURE_REASONS.includes(String(previousFailure.reason || ''));
    (deferred ? deferredEntries : mainEntries).push({ row, idx });
  });
  if (deferredEntries.length) {
    appendResearchRunLog(runPath, `[${logPrefix}] ${deferredEntries.length} ca trong danh sách chờ tìm lại (từng không tìm thấy BN trên HIS) — dời xuống cuối, chỉ tìm lại khi các ca khác đã lấy đủ.`);
  }

  // Nguồn thường có nhiều dòng cho CÙNG một đợt nằm viện (mỗi khoa/lần chuyển khoa
  // một dòng, ngày vào lệch vài ngày). Worker tìm theo mã BN nên các dòng này đều mở
  // ra đúng một hồ sơ EMR và cho kết quả y hệt. Nhớ các đợt đã lấy trong lần chạy
  // này (ngày vào/ra THẬT do EMR trả về) để dòng sau cùng đợt dùng lại kết quả thay
  // vì mở Chrome lấy lại. BN có đợt nằm viện khác (ngày vào ngoài khoảng) vẫn lấy riêng.
  const fetchedStays = new Map();
  const rememberFetchedStay = (meta, key, output) => {
    const from = isoDate(output?.profile?.ngay_vao_vien || output?.profile?.ngay_vao || '');
    const to = isoDate(output?.discharge?.ngay_ra || '');
    if (!meta.ma_bn || !from || !to || from > to) return;
    const list = fetchedStays.get(meta.ma_bn) || [];
    list.push({ from, to, output, sourceKey: key });
    fetchedStays.set(meta.ma_bn, list);
  };
  const findFetchedStay = (meta) => {
    const admission = isoDate(meta.admission_raw || '');
    if (!admission) return null;
    return (fetchedStays.get(meta.ma_bn) || []).find(st => st.from <= admission && admission <= st.to)
      // Đợt đã lấy ở tab Hành chánh / Kiểm hồ sơ (kho dùng chung) — dùng lại, không mở EMR.
      || findStoredStay(meta.ma_bn, admission, wantedFiles, { onlyGoc: refreshProvisional })
      || null;
  };
  const writeHchanhCsvs = () => {
    writeCsvUnion(path.join(runPath, 'hchanh_profile.csv'), profileRows, ['Mã NC', 'Mã BN', 'Họ tên', 'Giới', 'Ngày sinh', 'Tuổi', 'Địa chỉ', 'Điện thoại', 'Số CMND', 'Đối tượng', 'Số thẻ', 'Ngày vào viện', 'Ngày ra viện', 'Chẩn đoán', 'Research key']);
    writeCsvUnion(path.join(runPath, 'hchanh_discharge.csv'), dischargeRows, ['Mã NC', 'Mã BN', 'Họ tên', 'Ngày vào viện', 'Ngày ra viện', 'Thời gian điều trị', 'Chẩn đoán', 'Chẩn đoán ra viện', 'Bệnh kèm', 'Biến chứng', 'Tai biến', 'Tình trạng ra', 'Research key']);
    writeCsvUnion(path.join(runPath, 'hchanh_surgery.csv'), surgeryRows, ['Mã NC', 'Mã BN', 'Họ tên', 'Ngày vào viện', 'Ngày ra viện', 'Ngày phẫu thuật', 'Tên phẫu thuật', 'Phương pháp phẫu thuật', 'PPVC', 'Phân loại PT', 'Trạng thái', 'Chẩn đoán trước mổ', 'Chẩn đoán sau mổ', 'Research key']);
    writeCsvUnion(path.join(runPath, 'hchanh_order_history.csv'), orderRows, ['Mã NC', 'Mã BN', 'Họ tên', 'TG y lệnh', 'Ngày', 'Bác sĩ', 'Diễn biến', 'Tên y lệnh', 'Y lệnh khác', 'KQ', 'Trạng thái', 'Research key']);
  };

  let batchNo = 0;
  let passEntries = mainEntries;
  let retryingDeferred = false;
  for (let pass = 0; pass < 2; pass += 1) {
    const queue = passEntries.slice();
    while (queue.length) {
      if (isCancelRequested(ctx.sid)) {
        stats.cancelled = true;
        appendResearchRunLog(runPath, `[${logPrefix}] ĐÃ DỪNG theo yêu cầu trước lô ${batchNo + 1}; không spawn worker mới.`);
        break;
      }

      const chunkEntries = queue.splice(0, HCHANH_BATCH_SIZE);
      // Dòng cùng mã BN với 1 ca đã có trong lô này được dời sang lô sau: khi đó
      // ca trước đã lấy xong và dòng này có thể dùng lại kết quả (xem findFetchedStay).
      const postponed = [];
      // Trong lô, vẫn lọc bỏ các ca đã done giống hệt logic cũ (từng ca), chỉ những
      // ca THỰC SỰ cần fetch mới được đưa vào batchItems để gộp 1 Chrome.
      const batchItems = [];
      let chunkReused = 0;
      for (const { row, idx } of chunkEntries) {
        const meta = researchHchanhMeta(row, sourceRunId);
        const key = meta.source_key;
        // Không đưa họ tên vào log/trace (action_log.txt hay bị gửi ra ngoài để xem lỗi).
        const display = `${idx + 1}/${selectedRows.length} ${meta.ma_bn}${meta.research_code ? ` (${meta.research_code})` : ''}`;
        // forceKeys: điều phối tự động yêu cầu lấy lại đúng ca này (thiếu/lỗi/đã đổi)
        // dù progress cũ ghi done.
        // refreshProvisional: ca đang dùng dữ liệu tạm thời (Hành chánh / Kiểm hồ sơ) được quét lại để lấy dữ liệu gốc.
        const forcedCase = force || Boolean(forceKeys?.has(key))
          || (refreshProvisional && (progress[key]?.provisional_files || []).length > 0);
        if (!forcedCase && progress[key]?.status === 'done') {
          stats.skipped += 1;
          continue;
        }

        const failKey = hchanhFailureCacheKey(meta, wantedFiles, 'Hoàn tất');
        const previousFailure = failureCache[failKey];
        // Lượt chính gặp ca trong danh sách chờ không bao giờ xảy ra (đã tách ở trên);
        // nhánh này giữ cho ca chờ KHÔNG được tìm lại (các ca khác chưa đủ) được ghi
        // progress/trace rõ ràng thay vì im lặng.
        if (!forcedCase && !retryingDeferred && previousFailure && DEFERRED_FAILURE_REASONS.includes(String(previousFailure.reason || ''))) {
          stats.skipped += 1;
          progress[key] = {
            ...(progress[key] || {}),
            ma_bn: meta.ma_bn, ho_ten: meta.ho_ten, research_code: meta.research_code,
            encounter_id: key, admission_date: meta.admission_raw || '', discharge_date: meta.discharge_raw || '',
            status: 'skipped_recent_failure',
            skipped_at: nowIso(),
            skipped_reason: previousFailure.reason,
            previous_failure_at: previousFailure.ts,
            files: wantedFiles,
          };
          writeJsonAtomic(progressPath, progress);
          appendResearchRunLog(runPath, `[${logPrefix}] CHỜ TÌM LẠI ${display}: từng không tìm thấy (${previousFailure.reason}) lúc ${previousFailure.ts}; sẽ tìm lại khi các ca khác đã lấy đủ.`);
          appendResearchCaseTrace(runPath, {
            case_id: key, source_key: key, index: idx + 1, total: selectedRows.length, ma_bn: meta.ma_bn, ho_ten: meta.ho_ten, research_code: meta.research_code, date_from: meta.date_from || fallbackDateFrom || '', date_to: meta.date_to || fallbackDateTo || '', files: wantedFiles, mode: normalizedMode,
          }, [
            { ts: nowIso(), tag: 'CASE.START', step: 'Bắt đầu case nhưng phát hiện lỗi lặp gần đây', screen: 'server/routes/research.js', sees: display, takes: wantedFiles.join(','), writes: 'skip case', target: progressPath },
            { ts: nowIso(), tag: 'WARN', step: 'Dời vào danh sách chờ tìm lại: BN từng không tìm thấy trên HIS', screen: 'failure_cache', sees: `reason=${previousFailure.reason}; previous=${previousFailure.ts}`, takes: 'failure cache', writes: 'progress.status=skipped_recent_failure', target: failureCachePath },
          ], { mode: normalizedMode, status: 'skipped_recent_failure', files: wantedFiles, counts: {} });
          continue;
        }

        const reuse = force ? null : findFetchedStay(meta);
        if (reuse) {
          const flat = hchanhFetchOutputToRows(reuse.output, row, sourceRunId);
          if (flat.profileRows.length) profileRows = dedupeRowsByStableKey(removeResearchSourceKey(profileRows, key).concat(flat.profileRows), ['Research key', 'Mã BN', 'Ngày vào viện', 'Ngày ra viện']);
          if (flat.dischargeRows.length) dischargeRows = dedupeRowsByStableKey(removeResearchSourceKey(dischargeRows, key).concat(flat.dischargeRows), ['Research key', 'Mã BN', 'Ngày vào viện', 'Ngày ra viện', 'Chẩn đoán ra viện']);
          if (flat.surgeryRows.length) surgeryRows = dedupeRowsByStableKey(removeResearchSourceKey(surgeryRows, key).concat(flat.surgeryRows), ['Research key', 'Mã BN', 'Ngày phẫu thuật', 'Tên phẫu thuật', 'Phương pháp phẫu thuật']);
          if (flat.orderRows.length) orderRows = dedupeRowsByStableKey(removeResearchSourceKey(orderRows, key).concat(flat.orderRows), ['Research key', 'Mã BN', 'TG y lệnh', 'Tên y lệnh', 'Y lệnh khác']);
          const sc = statusCountsFromHchanhOutput(reuse.output);
          const reuseCounts = { profile: flat.profileRows.length, discharge: flat.dischargeRows.length, surgery: flat.surgeryRows.length, order_history: flat.orderRows.length };
          stats.processed += 1;
          stats.reused += 1;
          if (sc.attention) stats.attention += 1;
          else stats.ok += 1;
          progress[key] = {
            ...(progress[key] || {}),
            ma_bn: meta.ma_bn, ho_ten: meta.ho_ten, research_code: meta.research_code,
            encounter_id: key, admission_date: meta.admission_raw || '', discharge_date: meta.discharge_raw || '',
            status: sc.attention ? 'partial' : 'done', finished_at: nowIso(), files: [...new Set([...(progress[key]?.files || []), ...wantedFiles])], counts: sc,
            file_status: { ...(progress[key]?.file_status || {}), ...hchanhFileStatusPatch(reuse.output, reuseCounts, wantedFiles, {}, nowIso()) },
            reused_from: reuse.sourceKey,
            // Dùng lại từ tab Hành chánh / Kiểm hồ sơ → dữ liệu tạm thời; lần quét lại của Kho nghiên cứu sẽ thay.
            provisional_files: reuse.provisional_files || [],
            rows: { profile: flat.profileRows.length, discharge: flat.dischargeRows.length, surgery: flat.surgeryRows.length, order_history: flat.orderRows.length },
          };
          chunkReused += 1;
          appendResearchRunLog(runPath, `[${logPrefix}] DÙNG LẠI ${display}: cùng đợt nằm viện ${reuse.from} → ${reuse.to} đã lấy ở ${String(reuse.sourceKey).startsWith('kho_hanh_chanh') ? 'tab Hành chánh / Kiểm hồ sơ (dữ liệu tạm thời)' : reuse.sourceKey === 'kho_nghien_cuu_goc' ? 'lần quét trước của Kho nghiên cứu (dữ liệu gốc)' : reuse.sourceKey}, không mở EMR lại.`);
          continue;
        }

        if (!force && batchItems.some(it => it.meta.ma_bn === meta.ma_bn)) {
          postponed.push({ row, idx });
          continue;
        }

        const dateFrom = meta.date_from || fallbackDateFrom || '';
        const dateTo = meta.date_to || fallbackDateTo || dateFrom || '';
        // Kho dùng chung có sẵn một phần (vd ra viện từ Kiểm hồ sơ): dùng phần đó, chỉ mở EMR lấy file còn thiếu.
        let storedFiles = null;
        let storedTiers = null;
        let filesOverride = null;
        const storedPart = force ? null : findStoredStay(meta.ma_bn, isoDate(meta.admission_raw || ''), [], { onlyGoc: refreshProvisional });
        if (storedPart) {
          const have = wantedFiles.filter(k => storedPart.output?.[k]);
          if (have.length) {
            storedFiles = Object.fromEntries(have.map(k => [k, storedPart.output[k]]));
            storedTiers = storedPart.tiers || {};
            filesOverride = wantedFiles.filter(k => !storedPart.output?.[k]);
            appendResearchRunLog(runPath, `[${logPrefix}] DÙNG MỘT PHẦN ${display}: đã có ${have.join(',')} từ tab Hành chánh / Kiểm hồ sơ; chỉ lấy ${filesOverride.join(',')}.`);
          }
        }
        batchItems.push({ idx, row, meta, key, failKey, display, dateFrom, dateTo, storedFiles, storedTiers, filesOverride });
      }
      if (postponed.length) queue.unshift(...postponed);

      if (chunkReused) {
        // CSV trước, progress sau: progress "done" chỉ được ghi khi dữ liệu đã nằm trong CSV.
        writeHchanhCsvs();
        writeJsonAtomic(progressPath, progress);
      }
      if (!batchItems.length) continue;

      batchNo += 1;
      const batchInputPath = path.join(rawDir, `batch_input_${String(batchNo).padStart(4, '0')}.json`);
      const batchOutputPath = path.join(rawDir, `batch_output_${String(batchNo).padStart(4, '0')}.json`);
      const batchPayload = batchItems.map(({ row, meta, key, dateFrom, dateTo, filesOverride }) => ({
        ...row,
        ...(filesOverride?.length ? { _files_override: filesOverride } : {}),
        ma_bn: meta.ma_bn,
        ho_ten: meta.ho_ten,
        research_code: meta.research_code,
        date_from: dateFrom,
        date_to: dateTo,
        inpatient_status: 'Hoàn tất',
        research_mode: true,
        _progress_key: key,
      }));
      writeJsonAtomic(batchInputPath, batchPayload);
      appendResearchRunLog(runPath, `[${logPrefix}] Lô ${batchNo}: ${batchItems.length} ca (${batchItems[0].display} … ${batchItems[batchItems.length - 1].display}) | ${wantedFiles.join(',')} | 1 Chrome dùng chung cho cả lô`);

      for (const item of batchItems) {
        progress[item.key] = { ...(progress[item.key] || {}), ma_bn: item.meta.ma_bn, ho_ten: item.meta.ho_ten, research_code: item.meta.research_code, encounter_id: item.key, admission_date: item.meta.admission_raw || '', discharge_date: item.meta.discharge_raw || '', status: 'queued', files: [...new Set([...(progress[item.key]?.files || []), ...wantedFiles])] };
      }
      writeJsonAtomic(progressPath, progress);

      // Không truyền --from/--to chung cho cả lô: mỗi ca trong batchPayload đã có
      // date_from/date_to riêng, worker Python dùng giá trị của từng dòng khi field
      // top-level rỗng (xem _run_hchanh_fetch_core).
      const args = [
        '--input', batchInputPath, '--out', batchOutputPath, '--scope', 'discharge',
        '--files', wantedFiles.join(','), '--status', 'Hoàn tất',
        '--batch-size', String(HCHANH_BATCH_SIZE), '--progress-file', progressPath,
      ];
      if (headless) args.push('--headless');

      let result;
      const chromeCycleStartedAt = Date.now();
      try {
        result = await runScript('hchanh_fetch.py', args, {
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
          runtimeDir: ctx.dir,
        });
      } finally {
        unregisterCancel(ctx.sid);
      }
      // Không biết chính xác Chrome đã mở lại mấy lần trong lô (chỉ worker Python biết
      // khi nào phải soft-switch thất bại và mở lại) — coi tối thiểu 1 Chrome/lô để có
      // con số tham khảo trong log, số thật có thể cao hơn nếu EMR lỗi giữa lô.
      stats.chromeCycles += 1;
      stats.chromeCycleMs += Date.now() - chromeCycleStartedAt;

      const cancelRequested = isCancelRequested(ctx.sid);
      const batchOutput = readJsonSafe(batchOutputPath, {}) || {};
      if (!saveRaw) {
        try { fs.rmSync(batchInputPath, { force: true }); } catch (_) {}
        try { fs.rmSync(batchOutputPath, { force: true }); } catch (_) {}
      }

      for (const item of batchItems) {
        const { idx, row, meta, key, failKey, display, dateFrom, dateTo } = item;
        stats.processed += 1;
        const fetchedOutput = batchOutput[key];
        // Ghép phần đã có trong kho dùng chung; file vừa lấy từ EMR được ưu tiên.
        const output = fetchedOutput && item.storedFiles ? { ...item.storedFiles, ...fetchedOutput } : fetchedOutput;

        // Nếu worker bị kill vì người dùng bấm Dừng và ca này chưa kịp có kết quả
        // trong batchOutput, đây không phải lỗi dữ liệu của BN — đưa về pending_refetch.
        if (cancelRequested && !output) {
          stats.cancelled = true;
          progress[key] = { ...progress[key], status: 'pending_refetch', cancelled_at: nowIso(), error: '' };
          continue;
        }

        if (!output) {
          stats.error += 1;
          const message = result.spawnError || (result.killedByTimeout ? 'timeout' : (result.code !== 0 ? fmtPyError('hchanh_fetch.py lỗi', result) : 'không có kết quả trong output lô (worker có thể đã dừng giữa chừng)'));
          progress[key] = {
            ...progress[key], status: 'error', finished_at: nowIso(), error: message,
            file_status: { ...(progress[key]?.file_status || {}), ...hchanhFileStatusPatch(null, {}, wantedFiles, {}, nowIso(), result.killedByTimeout ? 'timeout' : 'error') },
          };
          appendResearchRunLog(runPath, `[${logPrefix}] LỖI ${display}: ${String(message).split('\n')[0]}`);
          appendResearchCaseTrace(runPath, {
            case_id: key, source_key: key, index: idx + 1, total: selectedRows.length, ma_bn: meta.ma_bn, ho_ten: meta.ho_ten, research_code: meta.research_code, date_from: dateFrom, date_to: dateTo, files: wantedFiles, mode: normalizedMode,
          }, [
            { ts: nowIso(), tag: 'CASE.START', step: 'Bắt đầu xử lý case nhưng worker lỗi', screen: 'server/routes/research.js', sees: display, takes: wantedFiles.join(','), writes: 'progress error', target: progressPath },
            { ts: nowIso(), tag: 'ERROR', step: 'hchanh_fetch.py (lô) trả lỗi', screen: 'worker/hchanh_fetch.py', sees: String(message).split('\n')[0], takes: 'stderr/stdout', writes: 'progress.status=error', target: progressPath },
          ], { mode: normalizedMode, status: 'error', files: wantedFiles, counts: {} });
          writeJsonAtomic(progressPath, progress);
          continue;
        }

        const workerTrace = Array.isArray(output?._case_trace) ? output._case_trace : [];
        const flat = hchanhFetchOutputToRows(output, row, sourceRunId);
        const countForKey = rows => rows.filter(r => String(r?.['Research key'] || '') === String(key)).length;
        const previousCounts = { profile: countForKey(profileRows), discharge: countForKey(dischargeRows), surgery: countForKey(surgeryRows), order_history: countForKey(orderRows) };
        // Chỉ thay dữ liệu cũ của case này khi lần fetch này THỰC SỰ có dòng mới
        // cho đúng bảng đó. Một lần scrape lỗi/rỗng (worker vẫn thoát code 0 nhưng
        // _fetch_status = empty/no_session/timeout) không được phép xóa mất dữ
        // liệu tốt đã lấy được ở lần trước — status của case vẫn có thể đọc là
        // partial/done trong khi dữ liệu thật đã bị thay bằng rỗng nếu không giữ.
        if (flat.profileRows.length) profileRows = dedupeRowsByStableKey(removeResearchSourceKey(profileRows, key).concat(flat.profileRows), ['Research key', 'Mã BN', 'Ngày vào viện', 'Ngày ra viện']);
        if (flat.dischargeRows.length) dischargeRows = dedupeRowsByStableKey(removeResearchSourceKey(dischargeRows, key).concat(flat.dischargeRows), ['Research key', 'Mã BN', 'Ngày vào viện', 'Ngày ra viện', 'Chẩn đoán ra viện']);
        if (flat.surgeryRows.length) surgeryRows = dedupeRowsByStableKey(removeResearchSourceKey(surgeryRows, key).concat(flat.surgeryRows), ['Research key', 'Mã BN', 'Ngày phẫu thuật', 'Tên phẫu thuật', 'Phương pháp phẫu thuật']);
        if (flat.orderRows.length) orderRows = dedupeRowsByStableKey(removeResearchSourceKey(orderRows, key).concat(flat.orderRows), ['Research key', 'Mã BN', 'TG y lệnh', 'Tên y lệnh', 'Y lệnh khác']);

        const sc = statusCountsFromHchanhOutput(output);
        const csvTraceEvents = [
          { ts: nowIso(), tag: 'OUTPUT.WRITE_CSV', step: 'Backend ghi bảng hchanh_profile.csv', screen: 'server/routes/research.js', sees: `profileRows=${flat.profileRows.length}; total=${profileRows.length}`, takes: 'output.profile', writes: 'hchanh_profile.csv', target: path.join(runPath, 'hchanh_profile.csv') },
          { ts: nowIso(), tag: 'OUTPUT.WRITE_CSV', step: 'Backend ghi bảng hchanh_discharge.csv', screen: 'server/routes/research.js', sees: `dischargeRows=${flat.dischargeRows.length}; total=${dischargeRows.length}`, takes: 'output.discharge', writes: 'hchanh_discharge.csv', target: path.join(runPath, 'hchanh_discharge.csv') },
          { ts: nowIso(), tag: 'OUTPUT.WRITE_CSV', step: 'Backend ghi bảng hchanh_surgery.csv', screen: 'server/routes/research.js', sees: `surgeryRows=${flat.surgeryRows.length}; total=${surgeryRows.length}`, takes: 'output.surgery.surgeries', writes: 'hchanh_surgery.csv', target: path.join(runPath, 'hchanh_surgery.csv') },
          { ts: nowIso(), tag: 'OUTPUT.WRITE_CSV', step: 'Backend ghi bảng hchanh_order_history.csv', screen: 'server/routes/research.js', sees: `orderRows=${flat.orderRows.length}; total=${orderRows.length}`, takes: 'output.order_history.rows', writes: 'hchanh_order_history.csv', target: path.join(runPath, 'hchanh_order_history.csv') },
        ];
        const failureSignature = hchanhFailureSignatureFromTrace(workerTrace, output);
        if (sc.error && failureSignature) {
          failureCache[failKey] = {
            ts: nowIso(), reason: failureSignature, ma_bn: meta.ma_bn, ho_ten: meta.ho_ten, files: wantedFiles, source_key: key,
            rows: { profile: flat.profileRows.length, discharge: flat.dischargeRows.length, surgery: flat.surgeryRows.length, order_history: flat.orderRows.length },
          };
          writeJsonAtomic(failureCachePath, failureCache);
        } else if (!sc.error && failureCache[failKey]) {
          delete failureCache[failKey];
          writeJsonAtomic(failureCachePath, failureCache);
        }
        if (sc.error) stats.error += 1;
        else if (sc.attention) stats.attention += 1;
        else stats.ok += 1;
        if (!sc.error) rememberFetchedStay(meta, key, output);
        // Phần Kho nghiên cứu vừa tự quét là dữ liệu gốc: ghi vào kho dùng chung, thay dữ liệu tạm thời.
        try {
          if (fetchedOutput && !sc.error) recordHchanhFetch(meta.ma_bn, fetchedOutput, { admission: meta.admission_raw || dateFrom || '', source: 'kho_nghien_cuu' });
        } catch (err) {
          appendResearchRunLog(runPath, `[${logPrefix}] CẢNH BÁO ${display}: không ghi được vào kho dùng chung: ${String(err.message || err)}`);
        }
        const provisionalFromStore = item.storedFiles
          ? Object.keys(item.storedFiles).filter(k => !(fetchedOutput && fetchedOutput[k]) && item.storedTiers?.[k] !== 'goc')
          : [];
        const rowCounts = { profile: flat.profileRows.length, discharge: flat.dischargeRows.length, surgery: flat.surgeryRows.length, order_history: flat.orderRows.length };
        progress[key] = {
          ...progress[key], status: sc.error ? 'error' : (sc.attention ? 'partial' : 'done'),
          finished_at: nowIso(), output: path.basename(batchOutputPath), counts: sc,
          files: [...new Set([...(progress[key]?.files || []), ...wantedFiles])],
          rows: { ...(progress[key]?.rows || {}), ...Object.fromEntries(wantedFiles.map(f => [f, rowCounts[f] || 0])) },
          file_status: { ...(progress[key]?.file_status || {}), ...hchanhFileStatusPatch(output, rowCounts, wantedFiles, previousCounts, nowIso()) },
          provisional_files: provisionalFromStore,
        };
        // Progress của cả lô được ghi SAU khi CSV đã ghi xong (xem cuối lô). Nếu tiến trình
        // chết giữa hai bước, progress còn cũ → ca được lấy lại, không có "done" mà thiếu CSV.
        const savedTrace = appendResearchCaseTrace(runPath, {
          case_id: key,
          source_key: key,
          index: idx + 1,
          total: selectedRows.length,
          ma_bn: meta.ma_bn,
          ho_ten: meta.ho_ten,
          research_code: meta.research_code,
          date_from: dateFrom,
          date_to: dateTo,
          files: wantedFiles,
          mode: normalizedMode,
        }, workerTrace.concat(csvTraceEvents), {
          mode: normalizedMode,
          status: progress[key].status,
          files: wantedFiles,
          counts: { profile: flat.profileRows.length, discharge: flat.dischargeRows.length, surgery: flat.surgeryRows.length, order_history: flat.orderRows.length },
          output: saveRaw ? batchOutputPath : path.basename(batchOutputPath),
        });
        appendResearchRunLog(runPath, `[TRACE][CASE.END] ${display}: ghi case trace ${savedTrace?.events?.length || 0} bước vào ${CASE_TRACE_RECENT_JSON}`);
        appendResearchRunLog(runPath, `[${logPrefix}] Xong ${display}: status=${progress[key].status} | profile=${flat.profileRows.length}, discharge=${flat.dischargeRows.length}, surgery=${flat.surgeryRows.length}, order=${flat.orderRows.length}`);
      }

      // CSV union được ghi 1 lần sau khi xử lý xong cả lô (đủ, vì mỗi ca trong lô đã
      // gộp dòng của nó vào profileRows/dischargeRows/surgeryRows/orderRows ở trên),
      // rồi mới ghi progress của cả lô.
      writeHchanhCsvs();
      writeJsonAtomic(progressPath, progress);

      // Trường hợp người dùng bấm Dừng đúng lúc lô vừa hoàn tất: giữ kết quả các ca đã
      // xong trong lô nhưng tuyệt đối không chuyển sang lô tiếp theo.
      if (cancelRequested) {
        stats.cancelled = true;
        appendResearchRunLog(runPath, `[${logPrefix}] ĐÃ DỪNG sau lô ${batchNo}; kết quả các ca đã hoàn tất trong lô đã được giữ.`);
        break;
      }
    }
    if (pass > 0 || !deferredEntries.length) break;
    // Hết lượt chính: chỉ tìm lại danh sách chờ khi MỌI ca khác đã có dữ liệu
    // (done/partial). Còn ca lỗi/dừng giữa chừng thì ca chờ vẫn bị bỏ qua lần này.
    const pendingOthers = stats.cancelled ? mainEntries.length : mainEntries.filter(({ row }) => {
      const st = String(progress[researchHchanhMeta(row, sourceRunId).source_key]?.status || '');
      return st !== 'done' && st !== 'partial';
    }).length;
    retryingDeferred = pendingOthers === 0;
    if (retryingDeferred) {
      appendResearchRunLog(runPath, `[${logPrefix}] Các ca khác đã lấy đủ — tìm lại ${deferredEntries.length} ca trong danh sách chờ.`);
    } else if (!stats.cancelled) {
      appendResearchRunLog(runPath, `[${logPrefix}] Còn ${pendingOthers} ca khác chưa lấy đủ — chưa tìm lại ${deferredEntries.length} ca trong danh sách chờ.`);
    }
    if (stats.cancelled) break;
    passEntries = deferredEntries;
  }

  appendResearchRunLog(runPath, `[${new Date().toLocaleString('vi-VN')}] ${stats.cancelled ? 'Đã dừng' : 'Kết thúc'} lấy ${runLabel}: ok=${stats.ok}, partial=${stats.attention}, error=${stats.error}, skipped=${stats.skipped}, dùng lại=${stats.reused}`);
  if (stats.chromeCycles) {
    const avgSec = (stats.chromeCycleMs / stats.chromeCycles / 1000).toFixed(1);
    const totalMin = (stats.chromeCycleMs / 60000).toFixed(1);
    appendResearchRunLog(runPath, `[${logPrefix}] 🔐 Đã chạy ${stats.chromeCycles} lô (gộp tối đa ${HCHANH_BATCH_SIZE} ca/Chrome/lô, chỉ đăng nhập lại EMR khi sang lô mới) trong ${totalMin} phút — trung bình ${avgSec} giây/lô.`);
  }
  appendActivity(ctx, {
    kind: 'workflow.research.fetch_hchanh.finish',
    mode: normalizedMode,
    run_dir: path.basename(runPath),
    ok: stats.ok,
    partial: stats.attention,
    error: stats.error,
    skipped: stats.skipped,
    cancelled: stats.cancelled,
    chrome_cycles: stats.chromeCycles,
    chrome_cycle_ms_total: stats.chromeCycleMs,
  });
  const manifestPath = path.join(runPath, 'manifest.json');
  const manifest = readJsonSafe(manifestPath, {}) || {};
  writeJsonAtomic(manifestPath, {
    ...manifest,
    ...(normalizedMode === 'order_history_auto'
      ? { order_history_auto_at: nowIso(), order_history_auto_files: wantedFiles, order_history_auto_stats: stats }
      : { hchanh_auto_at: nowIso(), hchanh_auto_files: wantedFiles, hchanh_auto_stats: stats }),
  });
  return { ...stats, files: wantedFiles, progress_path: progressPath };
}

// ── Analysis config presets theo chuyên khoa ──────────────────────────────────
// Mỗi preset định nghĩa: inference_fields (các cột tự động suy luận từ text)
// và needs_review_checks (các điều kiện dùng để tạo cột needs_manual_review).
// Khi tạo nghiên cứu mới, user chọn preset; config lưu vào study.json.
// normalizeRunOutputs đọc config này để sinh analysis_ready phù hợp.

const NORMALIZE_INPUT_FILES = [
  'research_source.csv',
  'du_lieu_ban_dau.csv',
  'mau_nghien_cuu.csv',
  'du_lieu_goc.csv',
  'thong_tin_benh_nhan_bo_sung.csv',
  'hchanh_profile.csv',
  'hchanh_discharge.csv',
  'hchanh_surgery.csv',
  'hchanh_order_history.csv',
  'lich_su_xn.csv',
  'lich_su_cdha.csv',
  'progress.json',
  'hchanh_auto_progress.json',
  'order_history_auto_progress.json',
];

const NORMALIZE_OUTPUT_FILES = [
  'patients.csv',
  'encounters.csv',
  'diagnoses.csv',
  'lab_results.csv',
  'imaging_results.csv',
  'surgery_results.csv',
  'medication_orders.csv',
  'medication_day_summary.csv',
  'clinical_notes.csv',
  'patient_day.csv',
  'analysis_ready.csv',
  'extract_status.csv',
];

function normalizeInputSignature(runDir) {
  const dir = path.resolve(runDir);
  const files = [];
  for (const name of NORMALIZE_INPUT_FILES) {
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      files.push({ name, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
    } catch (_) {
      files.push({ name, missing: true });
    }
  }
  // analysis_config/variable_selection nằm trong study.json, không phải CSV input.
  // Đưa vào signature để bấm Chuẩn hóa sau khi đổi biến sẽ luôn sinh lại dataset.
  try {
    files.push({ name: 'analysis_config', hash: stableHash(loadAnalysisConfig(dir) || {}) });
  } catch (_) {
    files.push({ name: 'analysis_config', missing: true });
  }
  // Phần hành chánh lấy thêm từ Kho người bệnh: kho có bản quét mới thì phải chuẩn hoá lại.
  try {
    if (patientDb.available()) files.push({ name: 'kho_nguoi_benh', version: patientDb.dataVersion() });
  } catch (_) {}
  return stableHash(files);
}

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

function normalizedOutputsAvailable(runDir) {
  const dir = path.resolve(runDir);
  const config = loadAnalysisConfig(dir);
  const required = [...NORMALIZE_OUTPUT_FILES];
  if (variableSelection.hasActiveSelection(config?.variable_selection)) required.push('analysis_selected.csv');
  return required.every(name => {
    try { return fs.statSync(path.join(dir, name)).isFile(); }
    catch (_) { return false; }
  });
}

// Bọc bước chuẩn hóa bằng normalize_state.json: ghi "running" trước khi ghi bất kỳ
// bảng nào, "complete"/"failed" khi xong. Các bảng được ghi lần lượt (mỗi file ghi
// tạm rồi đổi tên), nên nếu tiến trình chết giữa chừng, thư mục có thể lẫn bảng mới
// và cũ: trạng thái "running" còn sót lại là dấu hiệu để chặn tạo dataset cuối và
// buộc lần Chuẩn hóa sau chạy lại đầy đủ thay vì dùng cache.
function normalizeRunOutputs(runDir, options = {}) {
  const dir = path.resolve(runDir);
  ensureDir(dir);
  const previousState = quality.readNormalizeState(dir);
  const startedAt = nowIso();
  const statePath = path.join(dir, quality.NORMALIZE_STATE_FILE);
  writeJsonAtomic(statePath, { status: 'running', started_at: startedAt, schema_version: NORMALIZED_SCHEMA_VERSION });
  try {
    const result = normalizeRunOutputsInner(dir, { ...options, previousState });
    writeJsonAtomic(statePath, {
      status: 'complete',
      started_at: startedAt,
      finished_at: nowIso(),
      schema_version: NORMALIZED_SCHEMA_VERSION,
      cached: Boolean(result.cached),
      qa_status: result.qa?.status || '',
      database_status: result.database_status || '',
    });
    return result;
  } catch (err) {
    writeJsonAtomic(statePath, {
      status: 'failed',
      started_at: startedAt,
      finished_at: nowIso(),
      schema_version: NORMALIZED_SCHEMA_VERSION,
      error: String(err?.message || err).slice(0, 300),
    });
    throw err;
  }
}

function normalizeRunOutputsInner(runDir, { sourceRunId = '', force = false, previousState = null } = {}) {
  const dir = path.resolve(runDir);
  ensureDir(dir);
  const runId = sourceRunId || path.basename(dir);
  const manifestPath = path.join(dir, 'manifest.json');
  const manifestBefore = readJsonSafe(manifestPath, {}) || {};
  // Đồng bộ nguồn chuẩn trước khi tính signature/cache. Nếu Bước 1 vừa cập nhật
  // du_lieu_ban_dau.csv thì research_source.csv cũ không được phép giữ nguyên.
  const sourceInfo = ensureResearchSourceRows(dir, { sourceRunId: runId });
  let inputSignature = normalizeInputSignature(dir);
  if (!force
    && Number(manifestBefore.normalized_schema_version || 0) === NORMALIZED_SCHEMA_VERSION
    && manifestBefore.normalized_input_signature === inputSignature
    && normalizedOutputsAvailable(dir)
    && manifestBefore.normalized_outputs
    && previousState?.status === 'complete') {
    let database = null;
    try {
      database = syncDatabaseForRun(dir, { runId, inputSignature, force: false });
    } catch (err) {
      console.warn('[RESEARCH][SQLITE] Không đồng bộ được SQLite cache:', err.message);
    }
    return {
      ...manifestBefore.normalized_outputs,
      cached: true,
      qa: quality.readQaReport(dir) ? { status: quality.readQaReport(dir).status } : null,
      database_status: manifestBefore.normalized_database_status || '',
      input_signature: inputSignature,
      database: database ? publicDatabaseInfo(database) : publicDatabaseInfo(databaseInfo(datasetDirFromRunDir(dir))),
    };
  }

  // Đọc analysis config từ study.json của nghiên cứu này
  const analysisConfig = loadAnalysisConfig(dir);
  const preset = ANALYSIS_PRESETS[analysisConfig.preset] || ANALYSIS_PRESETS.general;
  const customFields = Array.isArray(analysisConfig.custom_fields) ? analysisConfig.custom_fields : [];

  const sourceTable = readCsvTable(path.join(dir, 'research_source.csv'), Number.MAX_SAFE_INTEGER);
  const patientTable = readCsvTable(path.join(dir, 'mau_nghien_cuu.csv'), Number.MAX_SAFE_INTEGER);
  const deepTable = readCsvTable(path.join(dir, 'du_lieu_goc.csv'), Number.MAX_SAFE_INTEGER);
  const initialTable = readCsvTable(path.join(dir, 'du_lieu_ban_dau.csv'), Number.MAX_SAFE_INTEGER);
  const extraTable = readCsvTable(path.join(dir, 'thong_tin_benh_nhan_bo_sung.csv'), Number.MAX_SAFE_INTEGER);
  const hchanhProfileTable = readCsvTable(path.join(dir, 'hchanh_profile.csv'), Number.MAX_SAFE_INTEGER);
  const hchanhDischargeTable = readCsvTable(path.join(dir, 'hchanh_discharge.csv'), Number.MAX_SAFE_INTEGER);
  const hchanhSurgeryTable = readCsvTable(path.join(dir, 'hchanh_surgery.csv'), Number.MAX_SAFE_INTEGER);
  const hchanhOrderTable = readCsvTable(path.join(dir, 'hchanh_order_history.csv'), Number.MAX_SAFE_INTEGER);

  // Đợt 5 kho người bệnh: bổ sung / thay dữ liệu hành chánh từ kho chung (không sửa CSV thô).
  let khoOverlay = null;
  try {
    const overlaid = overlayHchanhFromPatientDb(dir, sourceTable.rows.length ? sourceTable.rows : initialTable.rows, runId, {
      profile: hchanhProfileTable.rows || [], discharge: hchanhDischargeTable.rows || [],
      surgery: hchanhSurgeryTable.rows || [], order_history: hchanhOrderTable.rows || [],
    });
    hchanhProfileTable.rows = overlaid.tables.profile;
    hchanhDischargeTable.rows = overlaid.tables.discharge;
    hchanhSurgeryTable.rows = overlaid.tables.surgery;
    hchanhOrderTable.rows = overlaid.tables.order_history;
    khoOverlay = overlaid.report;
    writeJsonAtomic(path.join(dir, KHO_OVERLAY_FILE), khoOverlay);
    const filled = Object.values(khoOverlay.filled).reduce((a, b) => a + b, 0);
    const replaced = Object.values(khoOverlay.replaced_by_goc).reduce((a, b) => a + b, 0);
    if (filled || replaced) {
      appendResearchRunLog(dir, `[${new Date().toLocaleString('vi-VN')}] Chuẩn hoá: lấy từ kho người bệnh ${filled} phần còn thiếu, thay ${replaced} phần tạm thời bằng dữ liệu gốc; còn ${khoOverlay.provisional.length} phần là dữ liệu tạm thời.`);
    }
  } catch (err) {
    console.warn('[RESEARCH] Không đọc được Kho người bệnh khi chuẩn hoá:', err.message);
  }

  const encounterSourceRows = combineEncounterSources({
    initialRows: sourceTable.rows.length ? sourceTable.rows : initialTable.rows,
    patientRows: patientTable.rows,
    deepRows: deepTable.rows,
    hchanhProfileRows: hchanhProfileTable.rows,
    hchanhDischargeRows: hchanhDischargeTable.rows,
    sourceRunId: runId,
  });
  const patientsRaw = encounterSourceRows.length ? encounterSourceRows : (patientTable.rows.length ? patientTable.rows : initialTable.rows);

  const ctxMap = buildContextMap(patientsRaw, runId);
  const demographicByPatient = new Map();
  const extraByEncounter = new Map();
  function mergeExtra(row, includePatientDemographics = false) {
    const code = patientCode(row);
    if (!code) return;
    if (includePatientDemographics) {
      demographicByPatient.set(code, mergeRowsPreferFilled(demographicByPatient.get(code) || {}, row));
    }
    const ctx = contextForRow(ctxMap, row, code);
    if (ctx.encounter_id) {
      extraByEncounter.set(ctx.encounter_id, mergeRowsPreferFilled(extraByEncounter.get(ctx.encounter_id) || {}, row));
    }
  }
  for (const row of extraTable.rows || []) mergeExtra(row, true);
  for (const row of hchanhProfileTable.rows || []) mergeExtra(row, true);
  for (const row of hchanhDischargeTable.rows || []) mergeExtra(row, false);
  function extraForContext(code, ctx) {
    return mergeRowsPreferFilled(demographicByPatient.get(code) || {}, extraByEncounter.get(ctx?.encounter_id) || {});
  }
  // Chỉ dữ liệu đúng đợt (encounter_id khớp) — không merge thêm bucket theo
  // mã BN, vì các trường dùng ở đây (chẩn đoán vào/ra viện, ngày vào/ra,
  // phòng/giường...) là dữ liệu riêng từng đợt điều trị. demographicByPatient
  // gộp thông tin từ MỌI đợt của cùng mã BN — dùng nó ở đây sẽ khiến chẩn
  // đoán/ngày tháng của một đợt cũ bị gán nhầm cho đợt đang build khi đợt này
  // thiếu dữ liệu riêng.
  function extraForEncounterOnly(ctx) {
    return extraByEncounter.get(ctx?.encounter_id) || {};
  }

  const encounterRows = patientsRaw.filter(row => patientCode(row));
  const encounterById = new Map();
  const encounters = [];
  for (const row of encounterRows) {
    const code = patientCode(row);
    const ctx = contextForRow(ctxMap, row, code);
    const extra = extraForEncounterOnly(ctx);
    const admissionDiagnosis = ctx.admission_diagnosis || firstNonEmpty(extra, ['Chẩn đoán vào viện', 'Chan doan vao vien']) || ctx.diagnosis_raw || firstNonEmpty(row, ['Chẩn đoán', 'Chan doan']);
    const dischargeDiagnosis = firstNonEmpty(row, ['Chẩn đoán ra viện', 'Chan doan ra vien']) || firstNonEmpty(extra, ['Chẩn đoán ra viện', 'Chan doan ra vien']) || '';
    const out = {
      encounter_id: ctx.encounter_id || buildEncounterId(row, runId),
      research_code: ctx.research_code || firstNonEmpty(row, ['Mã NC', 'Ma NC', 'research_code']) || '',
      patient_code: code,
      admission_date: ctx.admission_date || isoDateTime(firstNonEmpty(extra, ['Ngày vào viện', 'Ngay vao vien', 'ngay_vao_vien', 'ngay_vao'])) || '',
      discharge_date: ctx.discharge_date || isoDateTime(firstNonEmpty(extra, ['Ngày ra viện', 'Ngay ra vien', 'Ngày xuất viện', 'Ngay xuat vien', 'ngay_ra_vien', 'ngay_ra'])) || '',
      treatment_duration: ctx.treatment_duration || firstNonEmpty(extra, ['Thời gian điều trị', 'Thoi gian dieu tri', 'so_ngay_dieu_tri']) || '',
      department: ctx.department || '',
      room_bed: ctx.room_bed || firstNonEmpty(extra, ['Phòng/Giường', 'Phong/Giuong', 'Phòng', 'Phong']) || '',
      admission_diagnosis: admissionDiagnosis,
      discharge_diagnosis: dischargeDiagnosis,
      diagnosis_raw: dischargeDiagnosis || admissionDiagnosis || ctx.diagnosis_raw || '',
      comorbidity_text: firstNonEmpty(row, ['Bệnh kèm', 'Benh kem', 'Bệnh nền', 'Benh nen']) || firstNonEmpty(extra, ['Bệnh kèm', 'Benh kem', 'Bệnh nền', 'Benh nen']) || '',
      complication_text: firstNonEmpty(row, ['Biến chứng', 'Bien chung', 'Tai biến', 'Tai bien']) || firstNonEmpty(extra, ['Biến chứng', 'Bien chung', 'Tai biến', 'Tai bien']) || '',
      discharge_status: firstNonEmpty(row, ['Tình trạng ra', 'Tinh trang ra', 'Kết quả', 'Ket qua']) || firstNonEmpty(extra, ['Tình trạng ra', 'Tinh trang ra', 'Kết quả', 'Ket qua']) || '',
      surgery_date: ctx.surgery_date || isoDate(firstNonEmpty(row, ['Ngày mổ', 'Ngay mo', 'Ngày phẫu thuật', 'Ngay phau thuat'])) || '',
      emr_admission_id: ctx.emr_admission_id || rowEmrAdmissionId(row) || '',
      emr_treatment_id: ctx.emr_treatment_id || rowEmrTreatmentId(row) || '',
      emr_noitru_id: ctx.emr_noitru_id || rowNoitruId(row) || '',
      needs_manual_review: [ctx.needs_manual_review, firstNonEmpty(row, ['__needs_manual_review', 'needs_manual_review'])]
        .filter(Boolean).join('; '),
      source_run_id: runId,
      source_status: row.__source_status || '',
    };
    out.row_hash = stableHash(out);
    if (!encounterById.has(out.encounter_id)) {
      encounterById.set(out.encounter_id, out);
      encounters.push(out);
    } else {
      const merged = mergeRowsPreferFilled(encounterById.get(out.encounter_id), out);
      merged.row_hash = stableHash(merged);
      encounterById.set(out.encounter_id, merged);
    }
  }
  const finalEncounters = Array.from(encounterById.values());

  const patientByCode = new Map();
  for (const row of encounterRows) {
    const code = patientCode(row);
    if (!code) continue;
    const ctx = contextForRow(ctxMap, row, code);
    const extra = extraForContext(code, ctx);
    const base = patientByCode.get(code) || {
      patient_code: code,
      patient_name: '', sex: '', birth_date: '', age: '', birth_year: '',
      address: '', phone_number: '', citizen_id: '', insurance_subject: '', insurance_card: '', insurance_type: '',
      insurance_valid_from: '', insurance_valid_to: '', first_research_code: '', encounter_count: 0,
      source_input: '', source_run_id: runId,
    };
    const candidate = {
      patient_code: code,
      patient_name: ctx.patient_name || firstNonEmpty(extra, ['Họ tên', 'Ho ten']) || '',
      sex: normalizeSex(ctx.sex || firstNonEmpty(extra, ['Giới', 'Gioi', 'GT', 'sex'])),
      birth_date: ctx.birth_date || isoDate(firstNonEmpty(extra, ['Ngày sinh', 'Ngay sinh', 'birth_date'])) || '',
      age: ctx.age || firstNonEmpty(extra, ['Tuổi', 'Tuoi', 'age']) || '',
      birth_year: extractBirthYear(ctx.birth_date || ctx.age || firstNonEmpty(extra, ['Năm sinh', 'Nam sinh', 'Ngày sinh', 'Ngay sinh']) || ctx.patient_name || ''),
      address: ctx.address || firstNonEmpty(extra, ['Địa chỉ', 'Dia chi', 'address']) || '',
      phone_number: ctx.phone_number || firstNonEmpty(extra, ['Điện thoại', 'Dien thoai', 'SĐT', 'SDT', 'Số điện thoại', 'So dien thoai', 'phone', 'phone_number']) || '',
      citizen_id: ctx.citizen_id || firstNonEmpty(extra, ['Số CMND', 'So CMND', 'Số CMT', 'So CMT', 'CMND', 'CMT', 'CCCD', 'citizen_id']) || '',
      insurance_subject: ctx.insurance_subject || firstNonEmpty(extra, ['Đối tượng', 'Doi tuong']) || '',
      insurance_card: ctx.insurance_card || firstNonEmpty(extra, ['Số thẻ BHYT', 'So the BHYT', 'Số thẻ', 'So the', 'insurance_card']) || '',
      insurance_type: ctx.insurance_type || firstNonEmpty(extra, ['Loại', 'Loai', 'Loại BHYT', 'Loai BHYT']) || '',
      insurance_valid_from: ctx.insurance_valid_from || isoDate(firstNonEmpty(extra, ['Giá trị từ', 'Gia tri tu', 'Từ ngày', 'Tu ngay'])) || '',
      insurance_valid_to: ctx.insurance_valid_to || isoDate(firstNonEmpty(extra, ['Giá trị đến', 'Gia tri den', 'Đến ngày', 'Den ngay'])) || '',
      first_research_code: base.first_research_code || ctx.research_code || '',
      source_input: ctx.source_input || firstNonEmpty(extra, ['Nguồn input', 'Nguon input']) || '',
      source_run_id: runId,
    };
    const merged = mergeRowsPreferFilled(base, candidate);
    merged.encounter_count = (Number(base.encounter_count) || 0) + 1;
    patientByCode.set(code, merged);
  }
  const encounterCountByCode = new Map();
  for (const enc of finalEncounters) {
    encounterCountByCode.set(enc.patient_code, (encounterCountByCode.get(enc.patient_code) || 0) + 1);
  }
  for (const [code, row] of patientByCode.entries()) {
    row.encounter_count = encounterCountByCode.get(code) || 0;
    row.row_hash = stableHash(row);
    patientByCode.set(code, row);
  }
  const patients = Array.from(patientByCode.values()).sort((a, b) => String(a.patient_code).localeCompare(String(b.patient_code)));

  let labRaw = readCsvTable(path.join(dir, 'lich_su_xn.csv'), Number.MAX_SAFE_INTEGER).rows;
  let imagingRaw = readCsvTable(path.join(dir, 'lich_su_cdha.csv'), Number.MAX_SAFE_INTEGER).rows;
  try {
    const results = overlayResultsFromPatientDb(dir, sourceTable.rows.length ? sourceTable.rows : initialTable.rows, runId, labRaw, imagingRaw);
    labRaw = results.labRaw;
    imagingRaw = results.imagingRaw;
    if (khoOverlay) {
      khoOverlay.results = results.report;
      writeJsonAtomic(path.join(dir, KHO_OVERLAY_FILE), khoOverlay);
    }
    const r = results.report;
    if (r.filled_cases.xn || r.filled_cases.cdha) {
      appendResearchRunLog(dir, `[${new Date().toLocaleString('vi-VN')}] Chuẩn hoá: lấy từ kho người bệnh XN cho ${r.filled_cases.xn} ca (${r.filled_rows.xn} dòng), CĐHA cho ${r.filled_cases.cdha} ca (${r.filled_rows.cdha} dòng).`);
    }
  } catch (err) {
    console.warn('[RESEARCH] Không đồng bộ XN/CĐHA với Kho người bệnh:', err.message);
  }
  const labResultsAll = labRaw.map((row, idx) => {
    const code = patientCode(row);
    const ctx = contextForRow(ctxMap, row, code);
    const rawTime = firstNonEmpty(row, ['TG xét nghiệm', 'Thời gian xét nghiệm', 'TG chỉ định', 'Thời gian', 'Ngày xét nghiệm', 'Ngày chỉ định']);
    const name = firstNonEmpty(row, ['Chỉ số', 'Chi so', 'Tên xét nghiệm', 'Ten xet nghiem']);
    const result = firstNonEmpty(row, ['Kết quả', 'Ket qua', 'result']);
    const base = {
      research_code: firstNonEmpty(row, ['Mã NC', 'Ma NC']) || ctx.research_code || '',
      patient_code: code,
      encounter_id: ctx.encounter_id || '',
      encounter_match_status: encounterMatchStatus(ctx),
      lab_datetime: isoDateTime(rawTime),
      lab_date: isoDate(firstNonEmpty(row, ['Ngày xét nghiệm', 'Ngày chỉ định'])) || isoDate(rawTime),
      lab_group: firstNonEmpty(row, ['Loại XN', 'Loai XN', 'Nhóm XN']),
      test_name_raw: name,
      test_name_norm: normalizeLabName(name),
      result_raw: result,
      result_operator: resultOperator(result),
      result_num: parseNumeric(result),
      result_text: resultText(result),
      unit: firstNonEmpty(row, ['Đơn vị', 'Don vi', 'unit']),
      ref_range_raw: firstNonEmpty(row, ['Khoảng tham chiếu', 'Khoang tham chieu', 'ref_range']),
      flag_raw: firstNonEmpty(row, ['Bất thường', 'Bat thuong', 'flag']),
      flag_norm: normalizeFlag(firstNonEmpty(row, ['Bất thường', 'Bat thuong', 'flag'])),
      ...eventTemporalFields(ctx, rawTime),
      source_run_id: runId,
    };
    base.row_hash = stableHash(base);
    base.lab_result_id = `lab_${base.row_hash || stableHash([idx, base.patient_code])}`;
    return base;
  });
  // Cùng BN + cùng thời điểm + cùng chỉ số là CÙNG một kết quả (bệnh viện xác nhận):
  // dòng thô giống hệt nhau (do lấy lại, ghi nối) chỉ giữ một. Dòng cùng thời điểm/
  // chỉ số nhưng kết quả khác nhau KHÔNG bị bỏ — QA báo mâu thuẫn để người kiểm tra.
  const labResults = dedupeRowsByHash(labResultsAll);

  const imagingResultsAll = imagingRaw.map((row, idx) => {
    const code = patientCode(row);
    const ctx = contextForRow(ctxMap, row, code);
    const rawTime = firstNonEmpty(row, ['TG chỉ định', 'TG chi dinh', 'Thời gian', 'Ngày chỉ định']);
    const service = firstNonEmpty(row, ['Tên dịch vụ', 'Ten dich vu', 'Dịch vụ', 'Dich vu']);
    const base = {
      research_code: firstNonEmpty(row, ['Mã NC', 'Ma NC']) || ctx.research_code || '',
      patient_code: code,
      encounter_id: ctx.encounter_id || '',
      encounter_match_status: encounterMatchStatus(ctx),
      ordered_at: isoDateTime(rawTime),
      order_date: isoDate(firstNonEmpty(row, ['Ngày chỉ định', 'Ngay chi dinh'])) || isoDate(rawTime),
      service_name_raw: service,
      modality: firstNonEmpty(row, ['Nhóm dịch vụ', 'Nhom dich vu']) || modalityFromService(service),
      body_region: bodyRegionFromService(service),
      result_text: firstNonEmpty(row, ['Mô tả/Kết quả', 'Mo ta/Ket qua', 'Kết quả', 'Ket qua']),
      conclusion_text: firstNonEmpty(row, ['Kết luận', 'Ket luan']),
      status: firstNonEmpty(row, ['Trạng thái', 'Trang thai']),
      ...eventTemporalFields(ctx, rawTime),
      source_run_id: runId,
    };
    base.row_hash = stableHash(base);
    base.imaging_id = `img_${base.row_hash || stableHash([idx, base.patient_code])}`;
    return base;
  });
  const imagingResults = dedupeRowsByHash(imagingResultsAll);

  const diagnosisRows = [];
  for (const enc of finalEncounters) {
    const items = [
      ['admission', enc.admission_diagnosis, ''],
      ['discharge', enc.discharge_diagnosis, ''],
      ['comorbidity', enc.comorbidity_text, ''],
      ['complication', enc.complication_text, ''],
    ];
    for (const [type, text, icd] of items) {
      if (!String(text || '').trim()) continue;
      const row = {
        research_code: enc.research_code,
        patient_code: enc.patient_code,
        encounter_id: enc.encounter_id,
        diagnosis_date: type === 'discharge' ? isoDate(enc.discharge_date) : isoDate(enc.admission_date),
        diagnosis_type: type,
        icd_code: icd || (String(text).match(/\b([A-Z]\d{2}(?:\.\d+)?)\b/)?.[1] || ''),
        diagnosis_text: text,
        source: 'encounter',
        source_run_id: runId,
      };
      row.row_hash = stableHash(row);
      row.diagnosis_id = `dx_${row.row_hash}`;
      diagnosisRows.push(row);
    }
  }
  const diagnoses = dedupeByHash(diagnosisRows);

  const surgeryRaw = [
    ...hchanhSurgeryTable.rows,
    ...readCsvTable(path.join(dir, 'lich_su_phau_thuat.csv'), Number.MAX_SAFE_INTEGER).rows,
    ...readCsvTable(path.join(dir, 'phau_thuat.csv'), Number.MAX_SAFE_INTEGER).rows,
  ];
  let surgeryResults = surgeryRaw.map((row, idx) => {
    const code = patientCode(row);
    const ctx = contextForRow(ctxMap, row, code);
    const dt = firstNonEmpty(row, ['Ngày phẫu thuật', 'Ngay phau thuat', 'Thời gian', 'Thoi gian', 'bat_dau', 'surgery_datetime', 'surgery_date']);
    const base = {
      research_code: firstNonEmpty(row, ['Mã NC', 'Ma NC', 'research_code']) || ctx.research_code || '',
      patient_code: code,
      encounter_id: ctx.encounter_id || '',
      encounter_match_status: encounterMatchStatus(ctx),
      surgery_datetime: isoDateTime(dt),
      surgery_date: isoDate(dt),
      surgery_name: firstNonEmpty(row, ['Tên phẫu thuật', 'Ten phau thuat', 'Dịch vụ phẫu thuật', 'Dich vu phau thuat', 'dich_vu_phau_thuat', 'noi_dung_phau_thuat']),
      surgery_method: firstNonEmpty(row, ['Phương pháp phẫu thuật', 'Phuong phap phau thuat', 'phuong_phap_pt', 'PPPT']),
      anesthesia_method: firstNonEmpty(row, ['PPVC', 'Phương pháp vô cảm', 'Phuong phap vo cam', 'pp_vo_cam']),
      surgery_class: firstNonEmpty(row, ['Phân loại PT', 'Phan loai PT', 'phan_loai_pt']),
      status: firstNonEmpty(row, ['Trạng thái', 'Trang thai', 'status']),
      preop_diagnosis: firstNonEmpty(row, ['Chẩn đoán trước mổ', 'Chan doan truoc mo', 'chan_doan_truoc_mo']),
      postop_diagnosis: firstNonEmpty(row, ['Chẩn đoán sau mổ', 'Chan doan sau mo', 'chan_doan_sau_mo']),
      operating_room: firstNonEmpty(row, ['Phòng mổ', 'Phong mo', 'phong_mo']),
      ...eventTemporalFields(ctx, dt),
      source: firstNonEmpty(row, ['Nguồn', 'source']) || 'surgery_raw',
      source_run_id: runId,
    };
    base.row_hash = stableHash(base);
    base.surgery_id = `surg_${base.row_hash || stableHash([idx, base.patient_code])}`;
    return base;
  }).filter(r => r.patient_code && (r.surgery_date || r.surgery_name || r.surgery_method));
  surgeryResults = dedupeSurgeryRows(surgeryResults);

  // Chỉ index theo encounter đã ghép chắc chắn. Không dùng patient_code làm fallback:
  // một bệnh nhân có thể có nhiều đợt điều trị/phẫu thuật khác nhau.
  const firstSurgeryForMedicationByEncounter = firstSurgeryByEncounter(surgeryResults);

  const existingMedRows = readCsvTable(path.join(dir, 'medication_orders.csv'), Number.MAX_SAFE_INTEGER).rows;
  const medicationRowsFromHistory = [];
  for (const row of hchanhOrderTable.rows || []) {
    const raw = [firstNonEmpty(row, ['Tên y lệnh', 'Ten y lenh']), firstNonEmpty(row, ['Y lệnh khác', 'Y lenh khac'])].filter(Boolean).join('\n');
    if (!raw) continue;
    for (const line of raw.split(/\n+/).map(x => x.trim()).filter(Boolean)) {
      if (!/\(tt\)|thuoc|vien|ong|chai|uong|tiem|truyen|xịt|hit|bơm|boi/i.test(line)) continue;
      medicationRowsFromHistory.push({ ...row, raw_line: line });
    }
  }
  const medSourceRows = [
    // medication_orders.csv là output chuẩn hóa; không feed lại chính nó để tránh nhân đôi mỗi lần normalize.
    // Chỉ giữ các dòng legacy/raw nếu file cũ chưa có med_order_id và source_run_id.
    ...existingMedRows.filter(r => !r.med_order_id && !r.source_run_id && firstNonEmpty(r, ['drug_name_raw', 'raw_line', 'Tên thuốc', 'Ten thuoc'])),
    ...medicationRowsFromHistory,
  ];
  let medicationOrders = medSourceRows.map((row, idx) => {
    const code = patientCode(row);
    const ctx = contextForRow(ctxMap, row, code);
    const rawLine = firstNonEmpty(row, ['raw_line', 'Raw line', 'Tên y lệnh', 'Ten y lenh', 'Y lệnh khác', 'Y lenh khac']);
    const rawTime = firstNonEmpty(row, ['order_datetime', 'TG y lệnh', 'TG y lenh', 'Thời gian', 'Ngày', 'order_date']);
    const drug = firstNonEmpty(row, ['drug_name_raw', 'Tên thuốc', 'Ten thuoc']) || rawLine.replace(/^\(TT\)\s*/i, '').slice(0, 180);
    const orderDate = isoDate(rawTime);
    const surgeryRef = surgeryForMedicationContext(firstSurgeryForMedicationByEncounter, ctx);
    const surgeryDate = surgeryRef ? (surgeryRef.surgery_date || isoDate(surgeryRef.surgery_datetime)) : '';
    const postopOffset = surgeryDate && orderDate ? dateOffsetDays(surgeryDate, orderDate) : '';
    const postopNumber = postopOffset === '' ? NaN : Number(postopOffset);
    const base = {
      research_code: firstNonEmpty(row, ['Mã NC', 'Ma NC', 'research_code']) || ctx.research_code || '',
      patient_code: code,
      encounter_id: ctx.encounter_id || '',
      encounter_match_status: encounterMatchStatus(ctx),
      order_datetime: isoDateTime(rawTime),
      order_date: orderDate,
      drug_name_raw: drug,
      drug_name_norm: normalizeDrugName(drug),
      drug_group_guess: classifyDrugGroup(drug || rawLine),
      active_ingredient: firstNonEmpty(row, ['active_ingredient', 'Hoạt chất', 'Hoat chat']),
      route_raw: firstNonEmpty(row, ['route_raw', 'Đường dùng', 'Duong dung']) || rawLine,
      route_norm: normalizeRoute(firstNonEmpty(row, ['route_raw', 'Đường dùng', 'Duong dung']) || rawLine),
      dose_raw: firstNonEmpty(row, ['dose_raw', 'Liều', 'Lieu']) || rawLine,
      times_per_day: firstNonEmpty(row, ['times_per_day', 'Số lần', 'So lan']),
      raw_line: rawLine,
      surgery_datetime_ref: surgeryRef ? (surgeryRef.surgery_datetime || '') : '',
      surgery_date_ref: surgeryDate,
      postop_day_index: Number.isFinite(postopNumber) ? String(postopNumber) : '',
      postop_day_label: Number.isFinite(postopNumber) ? `N${postopNumber}` : '',
      // Không có surgery reference thì để missing, không biến unknown thành 0.
      is_postop_day_1_3: Number.isFinite(postopNumber) ? (postopNumber >= 1 && postopNumber <= 3 ? '1' : '0') : '',
      ...eventTemporalFields(ctx, rawTime),
      source: firstNonEmpty(row, ['source', 'Nguồn']) || 'hchanh_order_history',
      source_run_id: runId,
    };
    base.row_hash = stableHash(base);
    base.med_order_id = `med_${base.row_hash || stableHash([idx, base.patient_code])}`;
    return base;
  }).filter(r => r.patient_code && r.drug_name_raw);
  medicationOrders = dedupeRowsByHash(medicationOrders);

  const medicationDayMap = new Map();
  for (const med of medicationOrders) {
    if (!med.patient_code || !med.encounter_id || !med.order_date) continue;
    const key = [med.patient_code, med.encounter_id || '', med.order_date].join('|');
    const bucket = medicationDayMap.get(key) || {
      research_code: med.research_code,
      patient_code: med.patient_code,
      encounter_id: med.encounter_id,
      order_date: med.order_date,
      drug_count: 0,
      routeSet: new Set(),
      drugs: [],
      source_run_id: runId,
    };
    bucket.drug_count += 1;
    if (med.route_norm) bucket.routeSet.add(med.route_norm);
    if (med.drug_name_raw) bucket.drugs.push(med.drug_name_raw);
    medicationDayMap.set(key, bucket);
  }
  const medicationDaySummary = Array.from(medicationDayMap.values()).map(b => {
    const row = {
      research_code: b.research_code,
      patient_code: b.patient_code,
      encounter_id: b.encounter_id,
      order_date: b.order_date,
      drug_count: b.drug_count,
      route_set: Array.from(b.routeSet).join('; '),
      drugs_display: b.drugs.slice(0, 20).join('; '),
      drugs_json: JSON.stringify(b.drugs),
      source_run_id: runId,
    };
    row.row_hash = stableHash(row);
    return row;
  });

  let clinicalNotes = (hchanhOrderTable.rows || []).map((row, idx) => {
    const code = patientCode(row);
    const ctx = contextForRow(ctxMap, row, code);
    const rawTime = firstNonEmpty(row, ['TG y lệnh', 'TG y lenh', 'Thời gian', 'Ngày']);
    const base = {
      research_code: firstNonEmpty(row, ['Mã NC', 'Ma NC', 'research_code']) || ctx.research_code || '',
      patient_code: code,
      encounter_id: ctx.encounter_id || '',
      encounter_match_status: encounterMatchStatus(ctx),
      note_datetime: isoDateTime(rawTime),
      note_date: isoDate(rawTime),
      doctor_name: firstNonEmpty(row, ['Bác sĩ', 'Bac si', 'doctor_name']),
      note_type: 'order_history',
      clinical_text: firstNonEmpty(row, ['Diễn biến', 'Dien bien']),
      order_text: [firstNonEmpty(row, ['Tên y lệnh', 'Ten y lenh']), firstNonEmpty(row, ['Y lệnh khác', 'Y lenh khac'])].filter(Boolean).join('\n'),
      status: firstNonEmpty(row, ['Trạng thái', 'Trang thai', 'status']),
      ...eventTemporalFields(ctx, rawTime),
      source: firstNonEmpty(row, ['Nguồn', 'source']) || 'hchanh_order_history',
      source_run_id: runId,
    };
    base.row_hash = stableHash(base);
    base.note_id = `note_${base.row_hash || stableHash([idx, base.patient_code])}`;
    return base;
  }).filter(r => r.patient_code && (r.clinical_text || r.order_text));
  clinicalNotes = dedupeRowsByHash(clinicalNotes);

  const labByEncounter = byEncounterCount(labResults, 'lab_date');
  const imagingByEncounter = byEncounterCount(imagingResults, 'order_date');
  const surgeryByEncounter = byEncounterCount(surgeryResults, 'surgery_date');
  const medicationByEncounter = byEncounterCount(medicationOrders, 'order_date');
  const patientDayMap = new Map();
  function ensurePatientDay(row, date) {
    if (!row.patient_code || !row.encounter_id || !date) return null;
    const key = [row.patient_code, row.encounter_id || '', date].join('|');
    if (!patientDayMap.has(key)) {
      const ctx = contextForRow(ctxMap, row, row.patient_code);
      patientDayMap.set(key, {
        research_code: row.research_code || ctx.research_code || '',
        patient_code: row.patient_code,
        encounter_id: row.encounter_id || ctx.encounter_id || '',
        date,
        hospital_day: daysBetween(ctx.admission_date, date),
        has_lab: '0', lab_count: 0,
        has_imaging: '0', imaging_count: 0,
        has_surgery: '0', surgery_count: 0,
        has_medication: '0', medication_count: 0,
        hb: '', hct: '', neutrophil: '', lymphocyte: '', monocyte: '', rdw: '', plt: '',
        creatinine: '', egfr: '', wbc: '', crp: '',
        source_run_id: runId,
      });
    }
    return patientDayMap.get(key);
  }
  const pdLabMap = {
    hemoglobin: 'hb', hct: 'hct', neutrophil: 'neutrophil', lymphocyte: 'lymphocyte', monocyte: 'monocyte', rdw: 'rdw', platelet: 'plt',
    creatinine: 'creatinine', egfr: 'egfr', wbc: 'wbc', crp: 'crp',
  };
  for (const lab of labResults) {
    const pd = ensurePatientDay(lab, lab.lab_date);
    if (!pd) continue;
    pd.has_lab = '1';
    pd.lab_count += 1;
    const col = pdLabMap[lab.test_name_norm];
    if (col && !pd[col]) pd[col] = lab.result_raw;
  }
  for (const img of imagingResults) {
    const pd = ensurePatientDay(img, img.order_date);
    if (!pd) continue;
    pd.has_imaging = '1';
    pd.imaging_count += 1;
  }
  for (const surg of surgeryResults) {
    const pd = ensurePatientDay(surg, surg.surgery_date);
    if (!pd) continue;
    pd.has_surgery = '1';
    pd.surgery_count += 1;
  }
  for (const med of medicationOrders) {
    const pd = ensurePatientDay(med, med.order_date);
    if (!pd) continue;
    pd.has_medication = '1';
    pd.medication_count += 1;
  }
  const patientDay = Array.from(patientDayMap.values()).map(pd => {
    pd.row_hash = stableHash(pd);
    return pd;
  }).sort((a, b) => `${a.patient_code}|${a.encounter_id}|${a.date}`.localeCompare(`${b.patient_code}|${b.encounter_id}|${b.date}`));

  const firstLabByEncounter = new Map();
  for (const lab of labResults) {
    const col = pdLabMap[lab.test_name_norm];
    if (!col) continue;
    const key = lab.encounter_id;
    if (!key) continue;
    const bucket = firstLabByEncounter.get(key) || {};
    const old = bucket[`_${col}_time`] || '';
    if (!bucket[col] || String(lab.lab_datetime || '').localeCompare(old) < 0) {
      bucket[col] = lab.result_raw;
      bucket[`_${col}_time`] = lab.lab_datetime || '';
    }
    firstLabByEncounter.set(key, bucket);
  }
  // Đặt tên khác với hàm firstSurgeryByEncounter import ở đầu file (dùng cho
  // medication linkage, dòng ~4861 trong cùng hàm này) — trùng tên biến const
  // sẽ khiến JS coi cả hàm này nằm trong "vùng chết tạm thời" (TDZ) của tên đó
  // ngay từ đầu, làm lệnh gọi hàm import ở trên ném lỗi "Cannot access before
  // initialization" mỗi khi chạy nhánh không lấy từ cache.
  // Chỉ ghép theo đúng lượt điều trị (dòng thiếu encounter_id không phát tán sang mọi
  // lượt của cùng người bệnh). Dùng chung quy tắc chọn ca mổ đầu tiên với y lệnh.
  const firstSurgeryByEncounterMap = firstSurgeryByEncounter(surgeryResults);
  const imagingTextByEncounter = new Map();
  for (const img of imagingResults) {
    const key = img.encounter_id;
    if (!key) continue;
    const old = imagingTextByEncounter.get(key) || '';
    imagingTextByEncounter.set(key, `${old}\n${img.service_name_raw || ''}\n${img.result_text || ''}\n${img.conclusion_text || ''}`.trim());
  }
  const analysisReady = finalEncounters.map(enc => {
    const p = patientByCode.get(enc.patient_code) || {};
    const labs = firstLabByEncounter.get(enc.encounter_id) || {};
    const surg = firstSurgeryByEncounterMap.get(enc.encounter_id) || {};
    const diagnosisText = [enc.diagnosis_raw, enc.admission_diagnosis, enc.discharge_diagnosis, imagingTextByEncounter.get(enc.encounter_id) || ''].join('\n');
    const sDate = surg.surgery_datetime || surg.surgery_date || enc.surgery_date || '';

    // Sinh các inference fields theo preset của nghiên cứu
    const inferredFields = {};
    for (const inf of preset.inference_fields) {
      inferredFields[inf.key] = _runInference(inf.fn, diagnosisText);
    }

    // Custom fields: pattern matching trên diagnosisText
    // diagnosisText được chuẩn hóa bỏ dấu; pattern cũng phải được chuẩn hóa tương ứng.
    // Field boolean luôn trả 1/0, không dùng chuỗi rỗng để tránh nhầm "0" với missing.
    const customFieldValues = evaluateCustomFields(customFields, normalizeSimple(diagnosisText));

    // needs_manual_review: chạy checks của preset + cờ ghép encounter không chắc chắn.
    const reviewItems = String(enc.needs_manual_review || '').split(';').map(x => x.trim()).filter(Boolean);
    for (const chk of preset.needs_review_checks) {
      const val = chk.field === 'surgery_date' ? sDate : (inferredFields[chk.field] || '');
      if (!val) reviewItems.push(chk.empty_label);
    }

    const row = {
      research_code: enc.research_code,
      encounter_id: enc.encounter_id,
      patient_code: enc.patient_code,
      patient_name: p.patient_name || '',
      sex: p.sex || '',
      birth_year: p.birth_year || '',
      age: p.age || '',
      admission_date: enc.admission_date,
      surgery_date: sDate,
      discharge_date: enc.discharge_date,
      hospital_stay_days: enc.treatment_duration || daysBetween(enc.admission_date, enc.discharge_date),
      time_to_surgery_hours: hoursBetween(enc.admission_date, sDate),
      diagnosis_raw: enc.diagnosis_raw,
      ...inferredFields,
      ...customFieldValues,
      surgery_name: surg.surgery_name || '',
      surgery_method: surg.surgery_method || '',
      anesthesia_method: surg.anesthesia_method || '',
      comorbidity_text: enc.comorbidity_text || '',
      complication_text: enc.complication_text || '',
      hb: labs.hb || '', hct: labs.hct || '', neutrophil: labs.neutrophil || '', lymphocyte: labs.lymphocyte || '', monocyte: labs.monocyte || '', rdw: labs.rdw || '', plt: labs.plt || '',
      imaging_summary: (imagingTextByEncounter.get(enc.encounter_id) || '').slice(0, 1200),
      needs_manual_review: reviewItems.join('; '),
      source_run_id: runId,
    };
    row.row_hash = stableHash(row);
    return row;
  });

  const progress = readJsonSafe(path.join(dir, 'progress.json'), {});
  const hchanhProgress = readJsonSafe(path.join(dir, 'hchanh_auto_progress.json'), {});
  const orderProgress  = readJsonSafe(path.join(dir, 'order_history_auto_progress.json'), {});

  const encounterCountByPatient = new Map();
  for (const enc of finalEncounters) {
    encounterCountByPatient.set(enc.patient_code, (encounterCountByPatient.get(enc.patient_code) || 0) + 1);
  }

  function progressMatchScore(key, entry, enc) {
    if (!entry || typeof entry !== 'object') return -1;
    const entryEncounter = String(entry.encounter_id || '').trim();
    if (key === enc.encounter_id || entryEncounter === enc.encounter_id) return 100;

    const entryResearch = String(entry.research_code || entry['Mã NC'] || '').trim();
    if (entryResearch && enc.research_code && entryResearch === enc.research_code) return 90;

    const entryCode = String(entry.ma_bn || entry['Mã BN'] || key.split('|')[0] || '').trim();
    if (!entryCode || entryCode !== enc.patient_code) return -1;

    const entryAdmission = isoDateTime(entry.admission_date || entry['Ngày vào viện'] || '')
      || isoDate(entry.admission_date || entry['Ngày vào viện'] || '');
    const entryDischarge = isoDateTime(entry.discharge_date || entry['Ngày ra viện'] || '')
      || isoDate(entry.discharge_date || entry['Ngày ra viện'] || '');
    const encAdmission = isoDateTime(enc.admission_date) || isoDate(enc.admission_date);
    const encDischarge = isoDateTime(enc.discharge_date) || isoDate(enc.discharge_date);
    if (entryAdmission && encAdmission && entryAdmission === encAdmission) {
      if (!entryDischarge || !encDischarge || entryDischarge === encDischarge) return 70;
    }

    // Chỉ fallback theo Mã BN khi chắc chắn người bệnh chỉ có đúng một lượt trong cohort.
    return encounterCountByPatient.get(enc.patient_code) === 1 ? 10 : -1;
  }

  function bestProgressEntry(progressMap, enc, fileKey = '') {
    let best = null;
    let bestScore = -1;
    let bestTime = '';
    for (const [key, entry] of Object.entries(progressMap || {})) {
      if (key.startsWith('__') || !entry || typeof entry !== 'object') continue;
      if (fileKey && !(Array.isArray(entry.files) && entry.files.includes(fileKey))) continue;
      const score = progressMatchScore(key, entry, enc);
      if (score < 0) continue;
      const time = String(entry.updated_at || entry.finished_at || entry.started_at || '');
      const completedBonus = (entry.committed === true || entry.status === 'done') ? 5 : 0;
      const totalScore = score + completedBonus;
      if (!best || totalScore > bestScore || (totalScore === bestScore && time > bestTime)) {
        best = entry;
        bestScore = totalScore;
        bestTime = time;
      }
    }
    return best || {};
  }

  function statusFromProgressEntry(entry, fileKey = '') {
    if (!entry || typeof entry !== 'object') return '';
    // Có trạng thái riêng từng file (bản mới) thì dùng, không dùng trạng thái chung của cả ca.
    if (fileKey && entry.file_status?.[fileKey]) return hchanhEntryFileStatus(entry, fileKey);
    if (entry.status === 'done') return 'done';
    if (entry.status === 'error') return 'error';
    if (entry.status === 'partial') return 'partial';
    return entry.status || '';
  }

  const extractStatus = finalEncounters.map(enc => {
    const code = enc.patient_code;
    const item = bestProgressEntry(progress, enc);
    const popup = item.popup || item.status || '';
    const xn = item.xn || '';
    const cdha = item.cdha || '';

    // Trạng thái hành chánh theo từng file
    const profileStatus      = statusFromProgressEntry(bestProgressEntry(hchanhProgress, enc, 'profile'), 'profile');
    const dischargeStatus    = statusFromProgressEntry(bestProgressEntry(hchanhProgress, enc, 'discharge'), 'discharge');
    const surgeryStatus      = statusFromProgressEntry(bestProgressEntry(hchanhProgress, enc, 'surgery'), 'surgery');
    const orderHistoryStatus = statusFromProgressEntry(bestProgressEntry(orderProgress, enc, 'order_history'), 'order_history')
      || statusFromProgressEntry(bestProgressEntry(hchanhProgress, enc, 'order_history'), 'order_history');

    const isErr = v => v === 'error' || v === 'blocked';
    const hasError = item.error || isErr(popup) || isErr(xn) || isErr(cdha)
      || isErr(profileStatus) || isErr(dischargeStatus)
      || isErr(surgeryStatus) || isErr(orderHistoryStatus);
    // "empty" = EMR xác nhận không có → đã lấy xong phần đó.
    const got = v => v === 'done' || v === 'empty';
    const xnCdhaDone = popup === 'done' && got(xn) && got(cdha);
    const hchanhDone = got(profileStatus) && got(dischargeStatus);
    const surgeryRequired = surgeryByEncounter.get(enc.encounter_id)?.total > 0 || enc.surgery_date;
    const orderRequired = surgeryRequired || medicationByEncounter.get(enc.encounter_id)?.total > 0;
    const surgeryDone = !surgeryRequired || got(surgeryStatus);
    const orderDone = !orderRequired || got(orderHistoryStatus);
    const missingRequired = [];
    if (!xnCdhaDone) missingRequired.push('xn_cdha');
    if (!got(profileStatus)) missingRequired.push('profile');
    if (!got(dischargeStatus)) missingRequired.push('discharge');
    if (!surgeryDone) missingRequired.push('surgery');
    if (!orderDone) missingRequired.push('order_history');
    const encounterUnsafe = /encounter_match_(?:ambiguous|missing)/.test(String(enc.needs_manual_review || ''));
    if (encounterUnsafe) missingRequired.push('encounter_match');
    const readyForAnalysis = !hasError && missingRequired.length === 0;
    const completionLevel = readyForAnalysis
      ? 'full_required'
      : (xnCdhaDone && hchanhDone ? 'clinical_admin' : xnCdhaDone ? 'xn_cdha' : 'partial');
    const overall = readyForAnalysis
      ? 'done'
      : hasError ? 'error' : 'pending';

    return {
      research_code: enc.research_code || '',
      encounter_id: enc.encounter_id || '',
      patient_code: code,
      patient_name: patientByCode.get(code)?.patient_name || '',
      popup_status: popup,
      xn_status: xn,
      cdha_status: cdha,
      profile_status: profileStatus,
      discharge_status: dischargeStatus,
      surgery_status: surgeryStatus,
      order_history_status: orderHistoryStatus,
      overall_status: overall,
      completion_level: completionLevel,
      ready_for_analysis: readyForAnalysis ? '1' : '0',
      missing_required: missingRequired.join('; '),
      lab_count: labByEncounter.get(enc.encounter_id)?.total || 0,
      imaging_count: imagingByEncounter.get(enc.encounter_id)?.total || 0,
      surgery_count: surgeryByEncounter.get(enc.encounter_id)?.total || 0,
      medication_count: medicationByEncounter.get(enc.encounter_id)?.total || 0,
      last_error: item.error || '',
      source_run_id: runId,
    };
  });

  // Mã người bệnh giả danh: mọi bảng có patient_code có thêm patient_key, lấy từ bảng liên
  // kết riêng của kho (patient_link.csv). Dataset/phân tích chỉ mang patient_key.
  const patientLink = loadPatientLink(patientLinkPath(dir));
  const keyStamp = nowIso();
  for (const rows of [patients, finalEncounters, diagnoses, labResults, imagingResults, surgeryResults,
    medicationOrders, medicationDaySummary, clinicalNotes, patientDay, analysisReady, extractStatus]) {
    applyPatientKeys(patientLink, rows, keyStamp);
  }
  savePatientLink(patientLink);

  writeCsv(path.join(dir, 'patients.csv'), NORMALIZED_COLUMNS.patients, patients);
  writeCsv(path.join(dir, 'encounters.csv'), NORMALIZED_COLUMNS.encounters, finalEncounters);
  writeCsv(path.join(dir, 'diagnoses.csv'), NORMALIZED_COLUMNS.diagnoses, diagnoses);
  writeCsv(path.join(dir, 'lab_results.csv'), NORMALIZED_COLUMNS.lab_results, labResults);
  writeCsv(path.join(dir, 'imaging_results.csv'), NORMALIZED_COLUMNS.imaging_results, imagingResults);
  writeCsv(path.join(dir, 'surgery_results.csv'), NORMALIZED_COLUMNS.surgery_results, surgeryResults);
  writeCsv(path.join(dir, 'medication_orders.csv'), NORMALIZED_COLUMNS.medication_orders, medicationOrders);
  writeCsv(path.join(dir, 'medication_day_summary.csv'), NORMALIZED_COLUMNS.medication_day_summary, medicationDaySummary);
  writeCsv(path.join(dir, 'clinical_notes.csv'), NORMALIZED_COLUMNS.clinical_notes, clinicalNotes);
  writeCsv(path.join(dir, 'patient_day.csv'), NORMALIZED_COLUMNS.patient_day, patientDay);
  // Cột analysis_ready = cột cố định + inference fields của preset + custom fields
  const analysisReadyBaseCols = [
    'research_code', 'encounter_id', 'patient_code', 'patient_key', 'patient_name', 'sex', 'birth_year', 'age',
    'admission_date', 'surgery_date', 'discharge_date', 'hospital_stay_days', 'time_to_surgery_hours',
    'diagnosis_raw',
  ];
  const inferenceColKeys = preset.inference_fields.map(f => f.key);
  const customColKeys    = customFields.filter(cf => cf.name).map(cf => cf.name);
  const analysisReadyTrailCols = [
    'surgery_name', 'surgery_method', 'anesthesia_method', 'comorbidity_text', 'complication_text',
    'hb', 'hct', 'neutrophil', 'lymphocyte', 'monocyte', 'rdw', 'plt',
    'imaging_summary', 'needs_manual_review', 'source_run_id', 'row_hash',
  ];
  const analysisReadyCols = [...analysisReadyBaseCols, ...inferenceColKeys, ...customColKeys, ...analysisReadyTrailCols];
  writeCsv(path.join(dir, 'analysis_ready.csv'), analysisReadyCols, analysisReady);

  const variableSelectionSpec = analysisConfig.variable_selection || null;
  const selectedAnalysis = buildSelectedAnalysisForRun(dir, analysisReady, {
    analysis_ready: analysisReady,
    patients,
    patient_master: patients,
    encounters: finalEncounters,
    diagnoses,
    lab_results: labResults,
    imaging_results: imagingResults,
    surgery_results: surgeryResults,
    medication_orders: medicationOrders,
    medication_day_summary: medicationDaySummary,
    clinical_notes: clinicalNotes,
    patient_day: patientDay,
  }, variableSelectionSpec);
  if (!selectedAnalysis) {
    try { fs.unlinkSync(path.join(dir, 'analysis_selected.csv')); } catch (_) {}
    try { fs.unlinkSync(path.join(dir, 'analysis_selection_manifest.json')); } catch (_) {}
  }

  // analysis_final.csv của lần trước không còn khớp dữ liệu mới nên bị gỡ, nhưng luôn
  // được lưu bản sao (nếu chưa có) trong datasets/ để không mất dataset đã chốt.
  snapshotFinalDatasetIfUnsaved(dir, 'superseded_by_normalize');
  try { fs.unlinkSync(path.join(dir, 'analysis_final.csv')); } catch (_) {}
  writeCsv(path.join(dir, 'extract_status.csv'), NORMALIZED_COLUMNS.extract_status, extractStatus);

  // research_source.csv có thể vừa được tạo ở đầu normalize, nên tính lại signature
  // trước khi ghi manifest để lần bấm Chuẩn hóa sau có thể trả kết quả ngay.
  inputSignature = normalizeInputSignature(dir);
  const manifest = readJsonSafe(manifestPath, {});
  const outputs = {
    initial_list: initialTable.rows.length,
    research_source: sourceTable.rows.length || sourceInfo.rows?.length || 0,
    deep_source: deepTable.rows.length,
    raw_patients: patientTable.rows.length,
    patient_extra: extraTable.rows.length,
    hchanh_profile: hchanhProfileTable.rows.length,
    hchanh_discharge: hchanhDischargeTable.rows.length,
    hchanh_surgery: hchanhSurgeryTable.rows.length,
    hchanh_order_history: hchanhOrderTable.rows.length,
    patients: patients.length,
    encounters: finalEncounters.length,
    diagnoses: diagnoses.length,
    lab_results: labResults.length,
    unmatched_lab_results: labResults.filter(row => row.encounter_match_status !== 'matched').length,
    imaging_results: imagingResults.length,
    unmatched_imaging_results: imagingResults.filter(row => row.encounter_match_status !== 'matched').length,
    surgery_results: surgeryResults.length,
    unmatched_surgery_results: surgeryResults.filter(row => row.encounter_match_status !== 'matched').length,
    medication_orders: medicationOrders.length,
    unmatched_medication_orders: medicationOrders.filter(row => row.encounter_match_status !== 'matched').length,
    medication_day_summary: medicationDaySummary.length,
    clinical_notes: clinicalNotes.length,
    patient_day: patientDay.length,
    analysis_ready: analysisReady.length,
    analysis_selected: selectedAnalysis ? selectedAnalysis.rows : 0,
    extract_status: extractStatus.length,
    kho_nguoi_benh: khoOverlay ? {
      cases: khoOverlay.cases_in_kho,
      filled: Object.values(khoOverlay.filled).reduce((a, b) => a + b, 0),
      replaced_by_goc: Object.values(khoOverlay.replaced_by_goc).reduce((a, b) => a + b, 0),
      provisional: khoOverlay.provisional.length,
      xn_cases: khoOverlay.results?.filled_cases?.xn || 0,
      cdha_cases: khoOverlay.results?.filled_cases?.cdha || 0,
    } : null,
  };
  let database = null;
  let databaseError = '';
  try {
    database = syncDatabaseForRun(dir, { runId, inputSignature, force: true });
  } catch (err) {
    databaseError = String(err?.message || err);
    console.warn('[RESEARCH][SQLITE] Không tạo/cập nhật được SQLite:', databaseError);
  }
  const databasePublic = database
    ? publicDatabaseInfo(database)
    : publicDatabaseInfo(databaseInfo(datasetDirFromRunDir(dir)));
  const databaseStatus = databaseError ? 'failed' : 'ok';

  const qaReport = quality.buildQualityReport({
    runId,
    runDir: dir,
    duplicatesRemoved: {
      lab_results: labResultsAll.length - labResults.length,
      imaging_results: imagingResultsAll.length - imagingResults.length,
    },
    tables: {
      patients, encounters: finalEncounters, diagnoses,
      lab_results: labResults, imaging_results: imagingResults, surgery_results: surgeryResults,
      medication_orders: medicationOrders, clinical_notes: clinicalNotes, analysis_ready: analysisReady,
    },
    inputCounts: {
      initial_list: outputs.initial_list, research_source: outputs.research_source,
      hchanh_profile: outputs.hchanh_profile, hchanh_discharge: outputs.hchanh_discharge,
      hchanh_surgery: outputs.hchanh_surgery, hchanh_order_history: outputs.hchanh_order_history,
      lich_su_xn: countCsvRows(path.join(dir, 'lich_su_xn.csv')), lich_su_cdha: countCsvRows(path.join(dir, 'lich_su_cdha.csv')),
    },
    databaseManifest: databaseError ? null : databaseInfo(datasetDirFromRunDir(dir)),
    databaseError,
    csvFilesInDatabase: ['patients.csv', 'encounters.csv', 'lab_results.csv', 'imaging_results.csv', 'surgery_results.csv', 'medication_orders.csv', 'analysis_ready.csv'],
    inferenceFields: preset.inference_fields || [],
  });
  writeJsonAtomic(path.join(dir, quality.QA_REPORT_FILE), { ...qaReport, review: undefined });
  writeCsv(path.join(dir, quality.ENCOUNTER_REVIEW_FILE),
    ['encounter_id', 'research_code', 'patient_code', 'issue', 'detail', 'related_encounter_id', 'source_status'],
    qaReport.review);
  const qaSummary = { status: qaReport.status, blocking_count: qaReport.blocking_count, warning_count: qaReport.warning_count, review_count: qaReport.review_count };
  const version = quality.codeVersion(ROOT_DIR);
  try {
    // Nhật ký chỉ ghi nối tiếp: mỗi lần chuẩn hóa một dòng, không ghi đè lần trước.
    fs.appendFileSync(path.join(dir, quality.NORMALIZE_HISTORY_FILE), `${JSON.stringify({
      at: nowIso(),
      run_id: runId,
      normalized_schema_version: NORMALIZED_SCHEMA_VERSION,
      input_signature: inputSignature,
      ...version,
      analysis_preset: analysisConfig.preset || 'general',
      variable_selection_hash: stableHash(analysisConfig.variable_selection || null),
      counts: outputs,
      database_status: databaseStatus,
      qa: qaSummary,
    })}\n`, 'utf-8');
  } catch (err) {
    console.warn('[RESEARCH][HISTORY] Không ghi được normalize_history.jsonl:', err.message);
  }

  writeJsonAtomic(manifestPath, {
    ...manifest,
    normalized_at: nowIso(),
    normalized_schema_version: NORMALIZED_SCHEMA_VERSION,
    normalized_input_signature: inputSignature,
    normalized_outputs: outputs,
    normalized_database: databasePublic,
    normalized_database_status: databaseStatus,
    normalized_qa: qaSummary,
    normalized_code_version: version,
    variable_selection_applied: Boolean(selectedAnalysis),
    variable_selection_output: selectedAnalysis ? { rows: selectedAnalysis.rows, columns: selectedAnalysis.columns } : null,
  });
  return { ...outputs, cached: false, input_signature: inputSignature, database: databasePublic, database_status: databaseStatus, qa: qaSummary };
}

function normalizeArchiveLatest() {
  const runId = resolveArchiveRunId('latest');
  if (!runId) throw new Error('Kho dữ liệu gốc chưa có run để chuẩn hóa.');
  const runDir = path.join(archiveRunsDir(), runId);
  const counts = normalizeRunOutputs(runDir, { sourceRunId: runId });
  return { run_id: runId, counts };
}

function normalizeStudyLatest(studyId) {
  const runId = resolveRunId(studyId, 'latest');
  if (!runId) throw new Error('Nghiên cứu chưa có run để chuẩn hóa.');
  const runDir = path.join(runsDir(studyId), runId);
  const counts = normalizeRunOutputs(runDir, { sourceRunId: runId });
  return { run_id: runId, counts };
}

function importArchiveToStudy(study, filters) {
  const archive = readArchive();
  if (!archive.latest_run?.id) throw new Error('Kho dữ liệu gốc chưa có lần quét dữ liệu.');
  const archiveRunId = archive.latest_run.id;
  let patientFile = archiveTablePath('initial_list', archiveRunId);
  let patientData = readCsvTable(patientFile, Number.MAX_SAFE_INTEGER);
  if (!patientData.rows.length) {
    patientFile = archiveTablePath('patients', archiveRunId);
    patientData = readCsvTable(patientFile, Number.MAX_SAFE_INTEGER);
  }
  if (!patientData.rows.length) throw new Error('Kho dữ liệu gốc chưa có bảng dữ liệu ban đầu để lọc người bệnh.');

  const dateFilteredPatients = patientData.rows.filter(row => rowPassesDateFilter(row, filters));
  const selection = sanitizeVariableSelection(filters?.variable_selection || activeVariableSelectionFromStudy(study));
  const archiveRunDir = path.join(archiveRunsDir(), archiveRunId);
  const tableRowsByKey = loadRunTablesForSelection(archiveRunDir, selection, dateFilteredPatients);
  const selectionResult = variableSelection.filterCohortRowsByVariableSelection(dateFilteredPatients, selection, tableRowsByKey);
  const selectedPatients = variableSelection.hasActiveSelection(selection) ? selectionResult.rows : dateFilteredPatients;
  const selectedVisits = selectedPatients.filter(row => patientCode(row));
  if (!selectedVisits.length) throw new Error(variableSelection.hasActiveSelection(selection)
    ? 'Không có bệnh nhân phù hợp điều kiện lọc và variable selection.'
    : 'Không có bệnh nhân phù hợp điều kiện lọc.');

  ensureDir(studyDir(study.id));
  const usedCodes = new Set();
  const cohortRows = selectedVisits.map((row, index) => {
    const next = { ...row };
    let code = getCell(next, ['Mã NC', 'Ma NC', 'research_code']);
    if (!code || usedCodes.has(code)) code = `NC${String(index + 1).padStart(4, '0')}`;
    usedCodes.add(code);
    next['Mã NC'] = code;
    return next;
  });
  const cohortColumns = [...patientData.columns];
  if (!cohortColumns.includes('Mã NC')) cohortColumns.unshift('Mã NC');
  writeCsv(cohortPath(study.id), cohortColumns, cohortRows);

  // Không copy dữ liệu XN/CĐHA/Thuốc từ kho gốc sang nghiên cứu.
  // Nghiên cứu chỉ nhận danh sách Mã BN đã lọc; bước "Lấy thêm dữ liệu EMR"
  // sẽ dùng chính các Mã BN này để mở EMR và ghi run riêng cho nghiên cứu.
  const updated = updateStudy(study.id, {
    cohort_source: 'archive',
    cohort_source_run_id: archiveRunId,
    cohort_filter: filters || {},
    variable_selection: variableSelection.hasActiveSelection(selection) ? selection : study.variable_selection,
    analysis_config: variableSelection.hasActiveSelection(selection)
      ? { ...(study.analysis_config || {}), variable_selection: selection }
      : study.analysis_config,
    variable_selection_import: variableSelection.hasActiveSelection(selection) ? {
      applied: true,
      input_count: patientData.rows.length,
      date_filtered_count: dateFilteredPatients.length,
      matched_count: cohortRows.length,
      condition_count: selection.conditions.length,
      applied_at: nowIso(),
    } : { applied: false, input_count: patientData.rows.length, date_filtered_count: dateFilteredPatients.length, matched_count: cohortRows.length, applied_at: nowIso() },
    last_import_at: nowIso(),
  });
  return {
    study: updated,
    source_run_id: archiveRunId,
    count: cohortRows.length,
    variable_selection: variableSelection.hasActiveSelection(selection) ? {
      applied: true,
      condition_count: selection.conditions.length,
      selected_variable_count: selection.selected_variables.length,
      date_filtered_count: dateFilteredPatients.length,
    } : { applied: false },
  };
}

// ── Khóa theo phạm vi (kho gốc / từng nghiên cứu) ───────────────────────────
// Các thao tác ghi dữ liệu của một kho (lấy dữ liệu, thu thập tự động, chuẩn hóa, chốt
// dataset...) không được chạy chồng: server cho phép 2 tác vụ nặng song song, nên trước
// đây hai người (hoặc hai tab) có thể cùng ghi progress.json, sổ thu thập và các CSV của
// cùng một run. Khóa giữ tới khi handler xong hẳn (các handler này chờ worker chạy xong
// mới trả lời). Thao tác chỉ đọc và nút Dừng (/api/cancel) không bị khóa.
const RESEARCH_SCOPE_LOCKS = new Map();

function researchScopeKey(req) {
  const studyId = req.params?.studyId;
  if (studyId) {
    try { return `study:${cleanStudyId(studyId)}`; } catch (_) { return `study:${String(studyId)}`; }
  }
  if (req.path === '/research/refetch-missing') {
    const raw = String(req.body?.scope || ARCHIVE_ID).trim();
    if (raw === ARCHIVE_ID || raw === '__archive__' || raw === 'archive') return 'archive';
    try { return `study:${cleanStudyId(raw)}`; } catch (_) { return `study:${raw}`; }
  }
  return 'archive';
}

function researchScopeBusy(key) {
  return RESEARCH_SCOPE_LOCKS.get(key) || null;
}

function lockedResearchRoute(method, routePath, label, handler) {
  router[method](routePath, async (req, res, next) => {
    const key = researchScopeKey(req);
    const holder = RESEARCH_SCOPE_LOCKS.get(key);
    if (holder) {
      return res.status(409).json({
        status: 'error',
        code: 'RESEARCH_SCOPE_BUSY',
        message: `Kho này đang chạy "${holder.label}" (từ ${holder.since}). Chờ tác vụ đó xong hoặc bấm Dừng rồi thử lại.`,
        busy: { label: holder.label, since: holder.since },
      });
    }
    const token = { label, since: nowIso() };
    RESEARCH_SCOPE_LOCKS.set(key, token);
    try {
      return await handler(req, res, next);
    } finally {
      if (RESEARCH_SCOPE_LOCKS.get(key) === token) RESEARCH_SCOPE_LOCKS.delete(key);
    }
  });
}

router.post('/research/archive/dismiss-alert', (_req, res) => {
  try {
    const runId = resolveArchiveRunId('latest');
    if (runId) {
      const alertPath = path.join(archiveRunsDir(), runId, 'fatal_alert.json');
      if (fs.existsSync(alertPath)) fs.unlinkSync(alertPath);
    }
    return res.json({ status: 'ok' });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/archive', (_req, res) => {
  return res.json({ status: 'ok', archive: readArchive() });
});

lockedResearchRoute('post', '/research/archive/source', 'Nạp danh sách nguồn', (req, res) => {
  try {
    ensureArchiveStore();
    const csv = String(req.body?.csv || '');
    const parsed = validatePatientCsv(csv, 'CSV tổng cần có cột Mã BN. Nên có thêm Ngày vào viện và Ngày ra viện để lọc nghiên cứu.');
    writeFileAtomic(archiveSourcePath(), csv.replace(/^\ufeff/, ''), 'utf-8');
    const original = String(req.body?.filename || 'source.csv').trim();
    const archive = updateArchive({ source_filename: original || 'source.csv', source_uploaded_at: nowIso() });
    return res.json({ status: 'ok', archive, columns: parsed.columns, count: parsed.count });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

// Trạng thái quyền xem dữ liệu có định danh, để giao diện hiện "đang khóa" thay vì gọi
// API rồi báo lỗi. Không trả dữ liệu nào; server vẫn tự chặn ở từng API như cũ.
function identifiedAccessStatus(req) {
  const envEnabled = Boolean(ALLOW_IDENTIFIED_RESEARCH_EXPORT);
  const roleOk = hasRole(req.auth, 'supervisor');
  return { allowed: envEnabled && roleOk, env_enabled: envEnabled, role_ok: roleOk };
}

router.get('/research/identified-access', (req, res) => {
  res.json({ status: 'ok', ...identifiedAccessStatus(req) });
});

router.get('/research/archive/patient-history', (req, res) => {
  const startedAt = Date.now();
  try {
    if (researchResponseShouldRedact(req)) {
      const err = new Error('Tra cứu người bệnh trả dữ liệu có định danh (họ tên, lịch sử điều trị). Cần thêm identified=1, vai trò supervisor/admin, và bật EMR_ALLOW_IDENTIFIED_RESEARCH_EXPORT=1.');
      err.status = 403;
      throw err;
    }
    const runId = resolveArchiveRunId(String(req.query.runId || 'latest'));
    const runDir = runId ? path.join(archiveRunsDir(), runId) : '';
    const data = buildPatientHistory(runDir, String(req.query.q || ''));
    const elapsed = Date.now() - startedAt;
    // Không in từ khóa tra cứu (có thể là họ tên/Mã BN) ra console.
    if (elapsed > 1200) console.warn(`[RESEARCH][LOOKUP] ${elapsed}ms | q_len=${String(req.query.q || '').length} | source=${data.data_source || '?'}`);

    // Không bao giờ trả một response lịch sử quá lớn làm Express/V8 lỗi Invalid string length.
    let eventRows = 0;
    for (const patient of data.patients || []) {
      for (const enc of patient.encounters || []) {
        eventRows += Number(enc?.labs?.length || 0)
          + Number(enc?.imaging?.length || 0)
          + Number(enc?.medications?.length || 0)
          + Number(enc?.surgeries?.length || 0);
      }
    }
    if (eventRows > 12000) {
      return res.status(413).json({
        status: 'error',
        code: 'RESEARCH_LOOKUP_TOO_LARGE',
        message: 'Kết quả chi tiết quá lớn. Hãy tra cứu bằng mã BN/mã NC cụ thể hơn.',
        candidate_count: Number(data.total_matches || 0),
      });
    }
    return res.json({ status: 'ok', run_id: runId || '', ...data, request_ms: elapsed });
  } catch (err) {
    // Khóa định danh là trạng thái cấu hình, không phải lỗi: không in stack ra console.
    if (!String(err.code || '').startsWith('IDENTIFIED_ACCESS_')) console.error('[RESEARCH][LOOKUP][ERROR]', err);
    return res.status(err.status || 400).json({ status: 'error', code: err.code || '', message: String(err.message || err) });
  }
});

router.get('/research/archive/variable-catalog', (req, res) => {
  try {
    const redact = researchResponseShouldRedact(req);
    const runId = resolveArchiveRunId(String(req.query.runId || 'latest'));
    const runDir = runId ? path.join(archiveRunsDir(), runId) : '';
    const catalog = buildVariableCatalog(runDir, { redact });
    return res.json({ status: 'ok', run_id: runId || '', redacted: redact, catalog });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.post('/research/archive/variable-preview', (req, res) => {
  try {
    const selection = sanitizeVariableSelection(req.body?.variable_selection || req.body || {});
    if (!selection.selected_variables?.length) return res.status(400).json({ status: 'error', message: 'Chọn ít nhất 1 biến để xem trước.' });
    const runId = resolveArchiveRunId(String(selection.run_id || req.body?.runId || 'latest'));
    const runDir = runId ? path.join(archiveRunsDir(), runId) : '';
    if (!runDir || !fs.existsSync(runDir)) return res.status(400).json({ status: 'error', message: 'Chưa có dữ liệu chuẩn hóa để xem trước.' });

    const analysisFile = path.join(runDir, TABLES.analysis_ready.file);
    const analysisTable = readCsvTable(analysisFile, VARIABLE_PREVIEW_MAX_ENCOUNTERS);
    const tableRows = loadRunTablesForSelection(runDir, selection, [], VARIABLE_PREVIEW_MAX_SOURCE_ROWS);
    const cohortRows = variableSelection.filterCohortRowsByVariableSelection(analysisTable.rows || [], selection, tableRows);
    const dataset = variableSelection.buildSelectedAnalysisDataset(cohortRows, selection, tableRows);
    const summary = variableSelection.summarizeSelectedDataset(dataset);
    const redact = researchResponseShouldRedact(req);
    const sensitiveOutput = new Set(dataset.manifest.variables
      .filter(variable => redact && isSensitiveColumn(variable.name))
      .map(variable => variable.output_column));
    const redacted = redact
      ? redactCsvTable(dataset.columns.filter(column => !sensitiveOutput.has(column)), dataset.rows, EXPORT_SENSITIVE_COLUMNS)
      : { columns: dataset.columns, rows: dataset.rows, removed_columns: [] };
    const limit = Math.max(1, Math.min(100, Number(req.body?.limit || 20)));
    return res.json({
      status: 'ok',
      run_id: runId,
      redacted: redact,
      summary,
      variables: dataset.manifest.variables,
      columns: redacted.columns,
      rows: redacted.rows.slice(0, limit),
      preview_limit: limit,
      source_limited: Boolean(analysisTable.limited) || Object.values(tableRows).some(rows => rows.length >= VARIABLE_PREVIEW_MAX_SOURCE_ROWS),
      removed_columns: [...(redacted.removed_columns || []), ...sensitiveOutput],
    });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/archive/data', (req, res) => {
  try {
    const archive = readArchive();
    const tableKey = TABLES[req.query.table] ? String(req.query.table) : 'patients';
    const runId = resolveArchiveRunId(String(req.query.runId || 'latest'));
    const filePath = archiveTablePath(tableKey, runId || 'latest');
    const data = filePath ? readCsvTable(filePath, MAX_TABLE_ROWS) : { columns: [], rows: [], count: 0, limited: false, exists: false };
    const displayRows = sortRowsForTable(tableKey, data.rows);
    const redact = researchResponseShouldRedact(req);
    const output = redact ? redactCsvTable(data.columns, displayRows, EXPORT_SENSITIVE_COLUMNS) : { columns: data.columns, rows: displayRows, removed_columns: [] };
    return res.json({
      status: 'ok',
      archive,
      table: { key: tableKey, ...TABLES[tableKey] },
      run_id: runId || '',
      columns: output.columns,
      rows: output.rows,
      redacted: redact,
      removed_columns: output.removed_columns,
      count: data.count,
      limited: data.limited,
      exists: data.exists,
      max_rows: MAX_TABLE_ROWS,
    });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/archive/export', (req, res) => {
  try {
    const tableKey = TABLES[req.query.table] ? String(req.query.table) : 'analysis_ready';
    const runId = resolveArchiveRunId(String(req.query.runId || 'latest'));
    const filePath = archiveTablePath(tableKey, runId || 'latest');
    return sendCsvFile(res, filePath, `archive_${runId || 'latest'}_${tableKey}`, { redact: researchResponseShouldRedact(req) });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/archive/coverage', (req, res) => {
  try {
    const runId = resolveArchiveRunId(String(req.query.runId || 'latest'));
    const runDir = runId ? path.join(archiveRunsDir(), runId) : '';
    return res.json({ status: 'ok', coverage: buildCoverageSummary(runDir) });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/data-dictionary', (_req, res) => {
  return res.json({
    status: 'ok',
    version: dataDictionary.DICTIONARY_VERSION,
    conventions: dataDictionary.CONVENTIONS,
    tables: dataDictionary.TABLES,
    raw_tables: dataDictionary.RAW_TABLES,
    known_issues: dataDictionary.KNOWN_ISSUES,
  });
});

router.get('/research/archive/datasets', (req, res) => {
  try {
    const runId = resolveArchiveRunId(String(req.query.runId || 'latest'));
    const runDir = runId ? path.join(archiveRunsDir(), runId) : '';
    return res.json({ status: 'ok', run_id: runId || '', datasets: runDir ? listDatasetSnapshots(runDir) : [] });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

// Kiểm tra toàn vẹn snapshot dataset: valid | missing | modified. Chỉ đọc — không sửa,
// không ghi đè, không dọn gì. Kết quả chỉ gồm tên snapshot, tên file và checksum.
function datasetVerifyResponse(runId, runDir) {
  const results = runDir ? verifyAllDatasetSnapshots(runDir) : [];
  const counts = { valid: 0, missing: 0, modified: 0 };
  for (const r of results) counts[r.status] += 1;
  return { status: 'ok', run_id: runId || '', counts, snapshots: results };
}
router.get('/research/archive/datasets/verify', (req, res) => {
  try {
    const runId = resolveArchiveRunId(String(req.query.runId || 'latest'));
    return res.json(datasetVerifyResponse(runId, runId ? path.join(archiveRunsDir(), runId) : ''));
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});
router.get('/research/studies/:studyId/datasets/verify', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const runId = resolveRunId(study.id, String(req.query.runId || 'latest'));
    return res.json(datasetVerifyResponse(runId, runId ? path.join(runsDir(study.id), runId) : ''));
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});
router.get('/research/studies/:studyId/datasets', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const runId = resolveRunId(study.id, String(req.query.runId || 'latest'));
    const runDir = runId ? path.join(runsDir(study.id), runId) : '';
    return res.json({ status: 'ok', run_id: runId || '', datasets: runDir ? listDatasetSnapshots(runDir) : [] });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/archive/progress', (req, res) => {
  try {
    const runId = resolveArchiveRunIdFast(String(req.query.runId || 'latest'));
    const archive = readArchiveProgressMeta(runId);
    const runDir = runId ? path.join(archiveRunsDir(), runId) : '';
    const progress = buildResearchProgressSnapshot(runDir, archive, { isArchive: true });
    return res.json({ status: 'ok', run_id: runId || '', progress });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute('post', '/research/archive/finalize-dataset', 'Tạo dataset cuối', (_req, res) => {
  try {
    const runId = resolveArchiveRunIdForAction('latest');
    if (!runId) return res.status(400).json({ status: 'error', message: 'Kho gốc chưa có run.' });
    const result = finalizeAnalysisDataset(path.join(archiveRunsDir(), runId));
    const archive = updateArchive({ last_finalized_at: nowIso() });
    return res.json({ status: 'ok', message: `Đã tạo analysis_final.csv (${result.count} dòng).`, archive, ...result });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err), coverage: err.coverage || undefined });
  }
});

lockedResearchRoute('post', '/research/archive/build-encoded-dataset', 'Tạo dataset mã hóa', (_req, res) => {
  try {
    const runId = resolveArchiveRunIdForAction('latest');
    if (!runId) return res.status(400).json({ status: 'error', message: 'Kho gốc chưa có run.' });
    const result = buildEncodedDataset(path.join(archiveRunsDir(), runId));
    const archive = updateArchive({ last_encoded_at: nowIso() });
    return res.json({ status: 'ok', message: `Đã tạo/cập nhật dữ liệu encoded cho ${runId}.`, archive, ...result });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute('post', '/research/archive/clean-generated', 'Dọn dữ liệu sinh ra', (req, res) => {
  try {
    const runId = resolveArchiveRunIdForAction('latest');
    if (!runId) return res.status(400).json({ status: 'error', message: 'Kho gốc chưa có run.' });
    const result = cleanResearchGenerated(path.join(archiveRunsDir(), runId), {
      encoded: req.body?.encoded !== false,
      debug: req.body?.debug !== false,
      derived: req.body?.derived === true,
    });
    const archive = updateArchive({ last_cleaned_at: nowIso() });
    return res.json({ status: 'ok', message: `Đã dọn file phụ cho ${runId}.`, archive, run_id: runId, ...result });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/archive/log', (req, res) => {
  try {
    const runId = resolveArchiveRunId(String(req.query.runId || 'latest'));
    if (!runId) return res.json({ status: 'ok', lines: [], run_id: '' });
    const logPath = path.join(archiveRunsDir(), runId, 'action_log.txt');
    const maxLines = Math.min(2000, Number(req.query.lines || 500));
    if (!fs.existsSync(logPath)) return res.json({ status: 'ok', lines: [], run_id: runId, exists: false });
    const text = fs.readFileSync(logPath, 'utf-8');
    const all  = text.split('\n').filter(l => l.trim());
    const lines = all.slice(-maxLines);
    return res.json({ status: 'ok', lines, total: all.length, run_id: runId, exists: true });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/studies/:studyId/log', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const runId = resolveRunId(study.id, String(req.query.runId || 'latest'));
    if (!runId) return res.json({ status: 'ok', lines: [], run_id: '' });
    const logPath = path.join(runsDir(study.id), runId, 'action_log.txt');
    const maxLines = Math.min(2000, Number(req.query.lines || 500));
    if (!fs.existsSync(logPath)) return res.json({ status: 'ok', lines: [], run_id: runId, exists: false });
    const text = fs.readFileSync(logPath, 'utf-8');
    const all  = text.split('\n').filter(l => l.trim());
    const lines = all.slice(-maxLines);
    return res.json({ status: 'ok', lines, total: all.length, run_id: runId, exists: true });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/archive/case-trace', (req, res) => {
  try {
    const runId = resolveArchiveRunId(String(req.query.runId || 'latest'));
    if (!runId) return res.json({ status: 'ok', cases: [], run_id: '' });
    const runDir = path.join(archiveRunsDir(), runId);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit || CASE_TRACE_RECENT_LIMIT)));
    const cases = readResearchCaseTrace(runDir, limit);
    const redact = researchResponseShouldRedact(req);
    return res.json({ status: 'ok', run_id: runId, cases: redact ? redactCaseTracePayload(cases) : cases, limit, redacted: redact });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/studies/:studyId/case-trace', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const runId = resolveRunId(study.id, String(req.query.runId || 'latest'));
    if (!runId) return res.json({ status: 'ok', cases: [], run_id: '' });
    const runDir = path.join(runsDir(study.id), runId);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit || CASE_TRACE_RECENT_LIMIT)));
    const cases = readResearchCaseTrace(runDir, limit);
    const redact = researchResponseShouldRedact(req);
    return res.json({ status: 'ok', run_id: runId, cases: redact ? redactCaseTracePayload(cases) : cases, limit, redacted: redact });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute('post', '/research/archive/normalize', 'Chuẩn hóa', (_req, res) => {
  try {
    const result = normalizeArchiveLatest();
    const archive = result.counts?.cached ? readArchive() : updateArchive({ last_normalized_at: nowIso() });
    return res.json({ status: 'ok', message: result.counts?.cached ? 'Dữ liệu đã chuẩn hóa sẵn, không cần chạy lại.' : `Đã chuẩn hóa kho dữ liệu gốc.${khoOverlayNote(result.counts)}`, archive, ...result });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute('post', '/research/archive/import-hchanh', 'Nạp dữ liệu hành chánh', (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    const runId = resolveArchiveRunId(String(req.body?.runId || 'latest')) || safeRunId(req.body?.runId) || nowFileStamp();
    if (!runId) return res.status(400).json({ status: 'error', message: 'Kho dữ liệu gốc chưa có run để gộp dữ liệu hành chánh.' });
    const runDir = path.join(archiveRunsDir(), runId);
    ensureDir(runDir);
    const imported = flattenHchanhIntoResearchRun(ctx, runDir);
    const normalized = normalizeRunOutputs(runDir, { sourceRunId: runId });
    const archive = updateArchive({ last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso(), last_hchanh_import_at: nowIso() });
    return res.json({
      status: 'ok',
      message: `Đã gộp dữ liệu hành chánh vào kho nghiên cứu: nền=${imported.profile}, ra viện=${imported.discharge}, phẫu thuật=${imported.surgery}, y lệnh=${imported.order_history}.`,
      archive,
      run_id: runId,
      imported,
      normalized,
    });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute('post', '/research/archive/fetch-hchanh', 'Lấy dữ liệu hành chánh', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    const archive = readArchive();
    const runId = resolveArchiveRunIdForAction(req.body?.runId || 'latest');
    if (!runId) return res.status(400).json({ status: 'error', message: 'Kho dữ liệu gốc chưa có run. Hãy chạy Bước 1 — Quét danh sách trước.' });
    const runDir = path.join(archiveRunsDir(), runId);
    const effectiveFromDate = String(req.body?.fromDate || archive.scan_from_date || '').trim();
    const effectiveToDate = String(req.body?.toDate || archive.scan_to_date || todayDateInput()).trim();
    const sourceInfo = readResearchHchanhSourceRows(runDir, archiveSourcePath(), {
      sourceRunId: runId,
      dateDefaults: { from_date: effectiveFromDate, to_date: effectiveToDate },
    });
    const { rows, file, base_file: baseFile, date_context: dateContext } = sourceInfo;
    if (!rows.length) return res.status(400).json({ status: 'error', message: `Không tìm thấy danh sách Mã BN để lấy hành chánh tự động trong run ${runId}. Hãy kiểm tra đã có du_lieu_ban_dau.csv/cohort.csv hoặc bấm Bước 1 trước.` });

    const files = hchanhDefaultFiles(req.body?.files);
    const limit = Number.isFinite(Number(req.body?.limit)) ? Math.max(0, Math.trunc(Number(req.body.limit))) : 0;
    updateArchive({ active_run_id: runId, active_mode: 'hchanh_auto' });

    await enqueueHeavy(ctx.sid, async () => {
      try {
        const fetched = await fetchHchanhForResearchRun(ctx, runDir, {
          sourceRows: rows,
          sourceRunId: runId,
          files,
          headless: researchHeadlessFromBody(req.body),
          force: req.body?.force === true,
          refreshProvisional: req.body?.refreshProvisional === true,
          fallbackDateFrom: dateContext?.from_date || effectiveFromDate || '',
          fallbackDateTo: dateContext?.to_date || effectiveToDate || todayDateInput(),
          limit,
          mode: 'hchanh_auto',
        });
        const normalized = normalizeRunOutputs(runDir, { sourceRunId: runId });
        const updated = updateArchive({
          last_run_id: runId,
          last_run_at: nowIso(),
          last_normalized_at: nowIso(),
          last_hchanh_auto_at: nowIso(),
          active_run_id: '',
          active_mode: '',
        });
        return res.json({
          status: 'ok',
          message: `Đã tự động lấy hành chánh từ EMR: xử lý=${fetched.processed}, bỏ qua=${fetched.skipped}, OK=${fetched.ok}, cần xem=${fetched.attention}, lỗi=${fetched.error}.`,
          archive: updated,
          run_id: runId,
          source_file: path.basename(file || ''),
          source_base_file: path.basename(baseFile || ''),
          source_date_from: dateContext?.from_date || '',
          source_date_to: dateContext?.to_date || '',
          fetched,
          normalized,
        });
      } catch (err) {
        updateArchive({ active_run_id: '', active_mode: '', stopped_at: nowIso() });
        throw err;
      }
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute('post', '/research/archive/fetch-order-history', 'Lấy lịch sử y lệnh', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    const archive = readArchive();
    const runId = resolveArchiveRunIdForAction(req.body?.runId || 'latest');
    if (!runId) return res.status(400).json({ status: 'error', message: 'Kho dữ liệu gốc chưa có run. Hãy chạy Bước 1 — Quét danh sách trước.' });
    const runDir = path.join(archiveRunsDir(), runId);
    const effectiveFromDate = String(req.body?.fromDate || archive.scan_from_date || '').trim();
    const effectiveToDate = String(req.body?.toDate || archive.scan_to_date || todayDateInput()).trim();
    const sourceInfo = readResearchHchanhSourceRows(runDir, archiveSourcePath(), {
      sourceRunId: runId,
      dateDefaults: { from_date: effectiveFromDate, to_date: effectiveToDate },
    });
    const { rows, file, base_file: baseFile, date_context: dateContext } = sourceInfo;
    if (!rows.length) return res.status(400).json({ status: 'error', message: `Không tìm thấy danh sách Mã BN để lấy lịch sử y lệnh trong run ${runId}. Hãy kiểm tra đã có du_lieu_ban_dau.csv/cohort.csv hoặc bấm Bước 1 trước.` });

    const files = orderHistoryDefaultFiles(req.body?.files);
    const limit = Number.isFinite(Number(req.body?.limit)) ? Math.max(0, Math.trunc(Number(req.body.limit))) : 0;
    updateArchive({ active_run_id: runId, active_mode: 'order_history_auto' });

    await enqueueHeavy(ctx.sid, async () => {
      try {
        const fetched = await fetchHchanhForResearchRun(ctx, runDir, {
          sourceRows: rows,
          sourceRunId: runId,
          files,
          headless: researchHeadlessFromBody(req.body),
          force: req.body?.force === true,
          refreshProvisional: req.body?.refreshProvisional === true,
          fallbackDateFrom: dateContext?.from_date || effectiveFromDate || '',
          fallbackDateTo: dateContext?.to_date || effectiveToDate || todayDateInput(),
          limit,
          mode: 'order_history_auto',
        });
        const normalized = normalizeRunOutputs(runDir, { sourceRunId: runId });
        const updated = updateArchive({
          last_run_id: runId,
          last_run_at: nowIso(),
          last_normalized_at: nowIso(),
          last_order_history_auto_at: nowIso(),
          active_run_id: '',
          active_mode: '',
        });
        return res.json({
          status: 'ok',
          message: `Đã tự động lấy ${orderHistoryRunLabel(files)} từ EMR: xử lý=${fetched.processed}, bỏ qua=${fetched.skipped}, OK=${fetched.ok}, cần xem=${fetched.attention}, lỗi=${fetched.error}.`,
          archive: updated,
          run_id: runId,
          source_file: path.basename(file || ''),
          source_base_file: path.basename(baseFile || ''),
          source_date_from: dateContext?.from_date || '',
          source_date_to: dateContext?.to_date || '',
          fetched,
          normalized,
        });
      } catch (err) {
        updateArchive({ active_run_id: '', active_mode: '', stopped_at: nowIso() });
        throw err;
      }
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute('post', '/research/archive/patient-info', 'Lấy thông tin người bệnh', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    const archive = readArchive();
    if (!fs.existsSync(SCRIPT_PATH)) return res.status(500).json({ status: 'error', message: 'Thiếu script lấy dữ liệu nghiên cứu.' });
    const effectiveFromDate = String(req.body?.fromDate || archive.scan_from_date || '').trim();
    const effectiveToDate = String(req.body?.toDate || archive.scan_to_date || todayDateInput()).trim();
    const runId = safeRunId(req.body?.runId || archive.latest_run?.id || chooseArchiveRunIdForResume({ fromDate: effectiveFromDate, toDate: effectiveToDate }) || nowFileStamp()) || nowFileStamp();
    const runDir = path.join(archiveRunsDir(), runId);
    const sourceInfo = readResearchHchanhSourceRows(runDir, archiveSourcePath(), {
      sourceRunId: runId,
      dateDefaults: { from_date: effectiveFromDate, to_date: effectiveToDate },
    });
    const inputPath = sourceInfo.file;
    if (!inputPath || !fs.existsSync(inputPath)) {
      return res.status(400).json({ status: 'error', message: 'Chưa có danh sách Mã BN. Hãy chạy Bước 1 — Quét danh sách trước.' });
    }
    const args = [
      '-u', SCRIPT_PATH,
      '--input', inputPath,
      '--project-id', ARCHIVE_ID,
      '--run-id', runId,
      '--out-root', RESEARCH_STORE_DIR,
      '--patient-info-only',
    ];
    if (effectiveFromDate) args.push('--from-date', effectiveFromDate);
    if (effectiveToDate) args.push('--to-date', effectiveToDate);
    if (researchHeadlessFromBody(req.body)) args.push('--headless');
    updateArchive({ active_run_id: runId, active_mode: 'patient_info' });

    await enqueueHeavy(ctx.sid, async () => {
      let result;
      try {
        result = await runPython(args, {
          cwd: ROOT_DIR,
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
          extraEnv: { RESEARCH_INPUT_NAME: path.basename(inputPath) },
        });
      } finally {
        unregisterCancel(ctx.sid);
      }

      if (result.spawnError) return res.status(500).json({ status: 'error', message: `Không khởi động được Python: ${result.spawnError}` });
      if (result.killedByTimeout) return res.status(504).json({ status: 'error', message: 'Timeout khi lấy thông tin khác. Dữ liệu đã lưu từng mã BN, bấm lại để chạy tiếp.' });
      if (isStoppedRunResult(result)) {
        const normalized = normalizeRunOutputs(path.join(archiveRunsDir(), runId), { sourceRunId: runId });
        const updated = updateArchive({ last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso(), stopped_at: nowIso(), active_run_id: '', active_mode: '' });
        return res.json({ status: 'ok', stopped: true, message: 'Đã dừng. Thông tin khác đã lấy vẫn được giữ; bấm lại để chạy tiếp.', archive: updated, run_id: runId, normalized });
      }
      if (result.code !== 0) return res.status(500).json({ status: 'error', message: fmtPyError('Python lỗi khi lấy thông tin khác từ D/s Bệnh nhân. Dữ liệu đã lưu nếu chạy được một phần.', result) });

      const normalized = normalizeRunOutputs(path.join(archiveRunsDir(), runId), { sourceRunId: runId });
      const updated = updateArchive({ last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso(), active_run_id: '', active_mode: '' });
      return res.json({ status: 'ok', message: 'Đã lấy thông tin khác: Điện thoại, Số CMND/CCCD, BHYT, địa chỉ từ D/s Bệnh nhân.', archive: updated, run_id: runId, normalized });
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute('post', '/research/archive/run', 'Lấy dữ liệu', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    const archive = readArchive();
    if (!fs.existsSync(SCRIPT_PATH)) return res.status(500).json({ status: 'error', message: 'Thiếu script lấy dữ liệu nghiên cứu.' });

    const mode = String(req.body?.mode || '').toLowerCase();
    const deep = req.body?.deep === true || mode === 'deep';
    const fromDate = String(req.body?.fromDate || '2026-01-01').trim();
    const toDate = String(req.body?.toDate || todayDateInput()).trim();
    const runId = safeRunId(req.body?.runId || (deep
      ? (archive.latest_run?.id || chooseArchiveRunIdForResume({ fromDate, toDate }) || nowFileStamp())
      : (req.body?.resume === false ? nowFileStamp() : chooseArchiveRunIdForResume({ fromDate, toDate }))
    )) || nowFileStamp();
    const initialListPath = archiveTablePath('initial_list', runId);
    const inputPath = deep ? initialListPath : archiveSourcePath();
    if (deep && (!inputPath || !fs.existsSync(inputPath))) {
      return res.status(400).json({ status: 'error', message: 'Chưa có du_lieu_ban_dau.csv. Hãy chạy Bước 1 trước.' });
    }
    const args = [
      '-u', SCRIPT_PATH,
      '--input', inputPath,
      '--project-id', ARCHIVE_ID,
      '--run-id', runId,
      '--out-root', RESEARCH_STORE_DIR,
    ];
    if (!deep) args.push('--list-only');
    if (deep && initialListPath) args.push('--archive-initial-list', initialListPath);
    const rescanRecentDays = Number.isFinite(Number(req.body?.rescanRecentDays))
      ? Math.max(0, Math.min(30, Math.trunc(Number(req.body.rescanRecentDays))))
      : 7;
    if (fromDate) args.push('--from-date', fromDate);
    if (toDate) args.push('--to-date', toDate);
    if (!deep) args.push('--rescan-recent-days', String(rescanRecentDays));
    if (researchHeadlessFromBody(req.body)) args.push('--headless');
    updateArchive({ scan_from_date: fromDate, scan_to_date: toDate, active_run_id: runId, active_mode: deep ? 'deep' : 'initial' });

    await enqueueHeavy(ctx.sid, async () => {
      try {
        let result;
      try {
        result = await runPython(args, {
          cwd: ROOT_DIR,
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
          extraEnv: { RESEARCH_INPUT_NAME: path.basename(inputPath) },
        });
        } finally {
          unregisterCancel(ctx.sid);
        }

        if (result.spawnError) return res.status(500).json({ status: 'error', message: `Không khởi động được Python: ${result.spawnError}` });
      const normalizeCurrentArchiveRun = () => {
        const currentRunDir = path.join(archiveRunsDir(), runId);
        // Bước 1 vừa thay đổi du_lieu_ban_dau.csv: luôn dựng lại nguồn chuẩn trước
        // khi normalize để progress/các bước sau không tiếp tục dùng mẫu cũ.
        if (!deep) {
          ensureResearchSourceRows(currentRunDir, {
            sourceRunId: runId,
            dateDefaults: { from_date: fromDate, to_date: toDate },
            force: true,
          });
        }
        return normalizeRunOutputs(currentRunDir, { sourceRunId: runId });
      };
      if (result.killedByTimeout) return res.status(504).json({ status: 'error', message: deep ? 'Timeout khi cập nhật dữ liệu gốc. Tiến độ đã lưu, bấm Bước 3 để chạy tiếp.' : 'Timeout khi quét danh sách ban đầu. Tiến độ đã lưu, bấm Bước 1 để chạy tiếp.' });
      if (isStoppedRunResult(result)) {
        const normalized = normalizeCurrentArchiveRun();
        const updated = updateArchive({ last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso(), stopped_at: nowIso() });
        return res.json({ status: 'ok', stopped: true, message: deep ? 'Đã dừng. Dữ liệu sâu đã commit vẫn được giữ; lần sau bấm Bước 3 để chạy tiếp.' : 'Đã dừng. Các trang đã quét xong đã lưu vào du_lieu_ban_dau.csv; lần sau bấm Bước 1 để quét lại và bỏ qua dòng đã có.', archive: updated, run_id: runId, normalized });
      }
      if (result.code !== 0) return res.status(500).json({ status: 'error', message: fmtPyError(deep ? 'Python lỗi khi cập nhật dữ liệu gốc. Tiến độ đã lưu nếu đã chạy được một phần.' : 'Python lỗi khi quét dữ liệu ban đầu. Tiến độ đã lưu nếu đã chạy được một phần.', result) });

      const normalized = normalizeCurrentArchiveRun();
      const updated = updateArchive({ last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso(), active_run_id: '', active_mode: '' });
        return res.json({ status: 'ok', message: deep ? 'Đã cập nhật dữ liệu gốc: lấy sâu từ du_lieu_ban_dau.csv, gộp/xóa các dòng đã nằm trong cùng đợt điều trị và chuẩn hóa.' : 'Đã quét dữ liệu ban đầu từ bảng Hoàn tất và chuẩn hóa dữ liệu gốc.', archive: updated, run_id: runId, normalized });
      } finally {
        updateArchive({ active_run_id: '', active_mode: '' });
      }
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/studies', (_req, res) => {
  return res.json({ status: 'ok', studies: listStudies() });
});

// ── Lấy lại chỗ thiếu ────────────────────────────────────────────────────────
// Đọc extract_status.csv, lọc BN còn thiếu loại dữ liệu nào, gọi đúng fetcher.
// scope = 'archive' | studyId
// missingTypes = ['xn_cdha', 'profile', 'discharge', 'surgery', 'order_history'] (mảng)
lockedResearchRoute('post', '/research/refetch-missing', 'Lấy lại chỗ thiếu', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    const rawScope     = String(req.body?.scope || ARCHIVE_ID).trim();
    const isArc        = rawScope === ARCHIVE_ID || rawScope === '__archive__' || rawScope === 'archive';
    const scope        = isArc ? ARCHIVE_ID : rawScope;
    const missingTypes = Array.isArray(req.body?.missingTypes) ? req.body.missingTypes : [];
    const headless     = researchHeadlessFromBody(req.body);
    const force        = req.body?.force === true;

    if (!missingTypes.length) {
      return res.status(400).json({ status: 'error', message: 'Cần chỉ định missingTypes cần lấy lại.' });
    }

    // Xác định runDir
    let runDir, runId, sourceRowsForHchanh, fallbackFrom, fallbackTo;
    if (isArc) {
      const archive = readArchive();
      runId = resolveArchiveRunIdForAction('latest');
      if (!runId) return res.status(400).json({ status: 'error', message: 'Kho gốc chưa có run. Chạy Bước 1 trước.' });
      runDir = path.join(archiveRunsDir(), runId);
      fallbackFrom = String(req.body?.fromDate || archive.scan_from_date || '').trim();
      fallbackTo   = String(req.body?.toDate || archive.scan_to_date || todayDateInput()).trim();
      const srcInfo = readResearchHchanhSourceRows(runDir, archiveSourcePath(), {
        sourceRunId: runId,
        dateDefaults: { from_date: fallbackFrom, to_date: fallbackTo },
      });
      sourceRowsForHchanh = srcInfo.rows;
    } else {
      const study = readStudy(scope);
      if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
      runId = resolveRunId(study.id, 'latest');
      if (!runId) return res.status(400).json({ status: 'error', message: 'Nghiên cứu chưa có run.' });
      runDir = path.join(runsDir(study.id), runId);
      fallbackFrom = String(req.body?.fromDate || '').trim();
      fallbackTo   = String(req.body?.toDate || todayDateInput()).trim();
      const srcInfo = readResearchHchanhSourceRows(runDir, cohortPath(study.id), { sourceRunId: runId });
      sourceRowsForHchanh = srcInfo.rows;
    }

    // Đọc extract_status để lọc BN thiếu
    const statusTable = readCsvTable(path.join(runDir, 'extract_status.csv'), Number.MAX_SAFE_INTEGER);

    // Xác định BN cần lấy lại cho từng nhóm
    const needXnCdha = missingTypes.includes('xn_cdha');
    const hchanhFiles = missingTypes.filter(t => ['profile', 'discharge', 'surgery', 'order_history'].includes(t));

    // BN/lượt cần lấy lại XN/CĐHA: thiếu popup, XN hoặc CĐHA. Giữ cả Mã NC để tránh nhầm nhiều lần nhập viện.
    const missingXnCdhaRows = needXnCdha
      ? statusTable.rows.filter(r => isRowMissingXnCdha(r))
      : [];
    const missingXnCdha = [...new Set(missingXnCdhaRows.map(r => String(r.patient_code || r['Mã BN'] || '').trim()).filter(Boolean))];

    // BN cần lấy lại hành chánh: bất kỳ file nào trong hchanhFiles chưa done.
    // Khớp thêm Mã NC khi có để tránh đọc nhầm trạng thái của một đợt nhập
    // viện khác cùng mã BN (một mã BN có thể có nhiều dòng extract_status
    // ứng với nhiều lần nhập viện).
    const missingHchanhRows = hchanhFiles.length
      ? sourceRowsForHchanh.filter(row => {
          const code = patientCode(row);
          const rc = rowResearchCode(row);
          const st = rc
            ? statusTable.rows.find(r => r.patient_code === code && rowResearchCode(r) === rc)
            : statusTable.rows.find(r => r.patient_code === code);
          if (!st) return true; // chưa có trong extract_status → chưa lấy
          return hchanhFiles.some(f => {
            const col = `${f}_status`;
            return st[col] !== 'done';
          });
        })
      : [];

    const summary = {
      xn_cdha_patients: missingXnCdha.length,
      hchanh_patients: missingHchanhRows.length,
      hchanh_files: hchanhFiles,
    };

    if (!missingXnCdha.length && !missingHchanhRows.length) {
      return res.json({ status: 'ok', message: 'Không có dữ liệu còn thiếu cho các loại đã chọn.', summary });
    }

    // Người dùng đang chủ động chạy tiếp phần còn thiếu: bỏ cảnh báo fatal cũ.
    // Nếu lần chạy mới gặp fatal thật, worker sẽ ghi lại fatal_alert.json.
    try {
      const oldAlertPath = path.join(runDir, 'fatal_alert.json');
      if (fs.existsSync(oldAlertPath)) fs.unlinkSync(oldAlertPath);
    } catch (_) {}

    const task = beginResearchTask(runDir, {
      type: 'refetch_missing',
      label: 'Bổ sung dữ liệu còn thiếu',
      status: 'queued',
      scope,
      run_id: runId,
      missing_types: missingTypes,
      summary,
      message: `Đã nhận yêu cầu bổ sung: XN/CĐHA=${summary.xn_cdha_patients}, hành chánh=${summary.hchanh_patients}.`,
    });

    await enqueueHeavy(ctx.sid, async () => {
      updateResearchTask(runDir, task.id, {
        status: 'running',
        message: 'Đang chạy bổ sung dữ liệu còn thiếu. Có thể chuyển tab, tiến độ vẫn được lưu ở backend.',
      });
      const results = {};
      try {

      const finishCancelled = () => {
        const normalized = normalizeRunOutputs(runDir, { sourceRunId: runId });
        if (isArc) {
          updateArchive({ last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso(), stopped_at: nowIso() });
        } else {
          updateStudy(scope, { last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso(), stopped_at: nowIso() });
        }
        const message = 'Đã dừng theo yêu cầu. Dữ liệu đã lấy xong vẫn được giữ; bấm Cập nhật để chạy tiếp phần còn thiếu.';
        finishResearchTask(runDir, task.id, 'cancelled', {
          message,
          summary,
          results,
        });
        appendResearchRunLog(runDir, `[REFETCH_MISSING] ${message}`);
        return res.json({
          status: 'ok',
          stopped: true,
          cancelled: true,
          message,
          summary,
          results,
          normalized,
        });
      };

      // Có thể người dùng bấm Dừng lúc job còn chờ heavy slot; không được bắt đầu worker đầu tiên.
      if (isCancelRequested(ctx.sid)) return finishCancelled();

      // Lấy lại hành chánh cho BN thiếu
      if (missingHchanhRows.length && hchanhFiles.length) {
        const fetched = await fetchHchanhForResearchRun(ctx, runDir, {
          sourceRows: missingHchanhRows,
          sourceRunId: runId,
          files: hchanhFiles,
          headless,
          force,
          fallbackDateFrom: fallbackFrom,
          fallbackDateTo: fallbackTo,
          mode: hchanhFiles.includes('order_history') && hchanhFiles.length === 1
            ? 'order_history_auto' : 'hchanh_auto',
        });
        results.hchanh = fetched;
        if (fetched.cancelled || isCancelRequested(ctx.sid)) return finishCancelled();
      }

      // XN/CĐHA — chạy lấy lại ngay trên subset BN/lượt còn thiếu, không chỉ đánh dấu chờ Bước 2.
      if (missingXnCdhaRows.length) {
        if (isCancelRequested(ctx.sid)) return finishCancelled();
        const reset = resetXnCdhaProgress(runDir, missingXnCdhaRows);
        const refetchRows = sourceRowsForXnCdhaRefetch(runDir, isArc ? archiveSourcePath() : cohortPath(scope), missingXnCdhaRows, runId, {
          from_date: fallbackFrom,
          to_date: fallbackTo,
        });
        if (!refetchRows.length) {
          results.xn_cdha = {
            patients: missingXnCdha.length,
            reset_in_progress: reset.resetCount,
            error: 'Không dựng được danh sách BN để lấy lại XN/CĐHA.',
          };
        } else {
          const inputDir = path.join(runDir, 'input');
          ensureDir(inputDir);
          const subsetPath = path.join(inputDir, `refetch_xn_cdha_${nowFileStamp()}.csv`);
          writeCsvUnion(subsetPath, refetchRows, [
            'Mã NC', 'Mã BN', 'Họ tên', 'T/G vào', 'TG vào', 'Ngày vào viện', 'Ngày ra viện',
            'fetch_from_date', 'fetch_to_date', 'source_scan_from_date', 'source_scan_to_date', 'source_file', 'source_run_id', 'Research key',
          ]);
          const args = [
            '-u', SCRIPT_PATH,
            '--input', subsetPath,
            '--project-id', scope,
            '--run-id', runId,
            '--out-root', RESEARCH_STORE_DIR,
          ];
          const initialListPath = isArc ? archiveTablePath('initial_list', runId) : '';
          if (isArc && initialListPath) args.push('--archive-initial-list', initialListPath);
          if (fallbackFrom) args.push('--from-date', fallbackFrom);
          if (fallbackTo) args.push('--to-date', fallbackTo);
          if (headless) args.push('--headless');
          appendResearchRunLog(runDir, `[REFETCH_XN_CDHA] Bắt đầu lấy lại ${refetchRows.length} dòng nguồn / ${missingXnCdha.length} BN còn thiếu`);
          let xnResult;
          try {
            xnResult = await runPython(args, {
              cwd: ROOT_DIR,
              onSpawn: killFn => registerCancel(ctx.sid, killFn),
              extraEnv: { RESEARCH_INPUT_NAME: path.basename(subsetPath), RESEARCH_REFETCH_MISSING: '1' },
            });
          } finally {
            unregisterCancel(ctx.sid);
          }
          if (isCancelRequested(ctx.sid)) {
            results.xn_cdha = {
              patients: missingXnCdha.length,
              input_rows: refetchRows.length,
              reset_in_progress: reset.resetCount,
              cancelled: true,
            };
            appendResearchRunLog(runDir, '[REFETCH_XN_CDHA] ĐÃ DỪNG theo yêu cầu; phần đã commit được giữ, phần còn lại sẽ lấy tiếp lần sau.');
            return finishCancelled();
          }
          if (xnResult.spawnError || xnResult.killedByTimeout || xnResult.code !== 0) {
            results.xn_cdha = {
              patients: missingXnCdha.length,
              input_rows: refetchRows.length,
              reset_in_progress: reset.resetCount,
              error: xnResult.spawnError || (xnResult.killedByTimeout ? 'timeout' : fmtPyError('Lấy lại XN/CĐHA lỗi', xnResult)),
            };
            appendResearchRunLog(runDir, `[REFETCH_XN_CDHA] LỖI: ${String(results.xn_cdha.error).split('\n')[0]}`);
          } else {
            results.xn_cdha = {
              patients: missingXnCdha.length,
              input_rows: refetchRows.length,
              reset_in_progress: reset.resetCount,
              message: `Đã chạy lấy lại XN/CĐHA cho ${refetchRows.length} dòng nguồn (${missingXnCdha.length} BN).`,
            };
            appendResearchRunLog(runDir, `[REFETCH_XN_CDHA] Xong: ${refetchRows.length} dòng nguồn / ${missingXnCdha.length} BN`);
          }
        }
      }

      const normalized = normalizeRunOutputs(runDir, { sourceRunId: runId });
      if (isArc) {
        updateArchive({ last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso() });
      } else {
        updateStudy(scope, { last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso() });
      }

      const message = [
        results.hchanh ? `Hành chánh: xử lý=${results.hchanh.processed}, OK=${results.hchanh.ok}, lỗi=${results.hchanh.error}` : '',
        results.xn_cdha ? (results.xn_cdha.error ? `XN/CĐHA lỗi: ${String(results.xn_cdha.error).split('\n')[0]}` : results.xn_cdha.message) : '',
      ].filter(Boolean).join(' | ');
      finishResearchTask(runDir, task.id, results.xn_cdha?.error ? 'error' : 'done', {
        message: message || 'Đã hoàn tất bổ sung dữ liệu còn thiếu.',
        summary,
        results,
      });

      return res.json({
        status: 'ok',
        message,
        summary,
        results,
        normalized,
      });
      } catch (taskErr) {
        finishResearchTask(runDir, task.id, 'error', {
          message: String(taskErr?.message || taskErr || 'Tác vụ bổ sung dữ liệu lỗi.'),
          summary,
          results,
        });
        throw taskErr;
      }
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

// ── Điều phối thu thập tự động ───────────────────────────────────────────────
// So sổ thu thập (collection_ledger.json) với nguồn hiện tại: ca không đổi thì bỏ qua;
// ca mới, phần còn thiếu, phần lỗi kỹ thuật (có giới hạn số lần) và phần mà danh sách
// EMR đã thay đổi thì lấy lại ĐÚNG phần đó. Lỗi kỹ thuật được thử lại trong cùng lần
// chạy; ca không xác định chắc lượt / giao diện EMR lạ thì dừng đúng ca và ghi lý do.
const COLLECTION_LEDGER_FILE = 'collection_ledger.json';
const COLLECTION_REPORT_FILE = 'collection_report.json';
const COLLECTION_HISTORY_FILE = 'collection_history.jsonl';
const COLLECTION_EXCEPTIONS_FILE = 'collection_exceptions.csv';
const COLLECTION_ENCOUNTER_OVERRIDES_FILE = 'collection_encounter_overrides.json';
const COLLECTION_EXCEPTION_COLUMNS = [
  'category', 'research_code', 'patient_code', 'part_label', 'status', 'reason_label', 'detail',
  'attempts', 'auto_retry', 'updated_at', 'key', 'part', 'reason',
];
const STUDY_READINESS_FILE = 'study_readiness.csv';
// Lịch sử phiên bản (chỉ thêm, không ghi đè): mỗi khi lấy lại một phần mà nội dung khác
// bản trước, ghi cả bản cũ và bản mới của đúng phần đó.
const COLLECTION_VERSIONS_FILE = 'collection_versions.jsonl';
const COLLECTION_CHANGES_FILE = 'collection_changes.csv';
const COLLECTION_CHANGE_COLUMNS = ['changed_at', 'research_code', 'part_label', 'from_version', 'to_version', 'rows_added', 'rows_removed', 'trigger', 'key', 'part', 'change_id', 'txn_id'];

// Dữ liệu thô hiện có của từng phần, để so trước/sau khi lấy lại.
function readCollectionPartRows(runDir) {
  const group = (file, field) => {
    const m = new Map();
    for (const r of readCsvTable(path.join(runDir, file), Number.MAX_SAFE_INTEGER).rows || []) {
      const k = String(r?.[field] || '').trim();
      if (!k) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };
  return {
    xn: group('lich_su_xn.csv', 'Mã NC'),
    cdha: group('lich_su_cdha.csv', 'Mã NC'),
    profile: group('hchanh_profile.csv', 'Research key'),
    discharge: group('hchanh_discharge.csv', 'Research key'),
    surgery: group('hchanh_surgery.csv', 'Research key'),
    order_history: group('hchanh_order_history.csv', 'Research key'),
  };
}

function partRowsMap(index, ledger, targets) {
  const out = new Map();
  for (const { key, part } of targets) {
    const enc = ledger?.encounters?.[key];
    // XN/CĐHA được script lưu theo Mã NC; hành chánh theo Research key của từng dòng thuộc lượt.
    const ids = (part === 'xn' || part === 'cdha')
      ? (enc?.data_codes?.length ? enc.data_codes : [enc?.research_code || ''])
      : (enc?.members?.length ? enc.members : [key]);
    const rows = [...new Set(ids)].flatMap(id => index[part]?.get(id) || []);
    out.set(`${key}|${part}`, rows);
  }
  return out;
}

// Id các phiên bản đã có trong lịch sử. Dòng cuối có thể bị cắt dở nếu tiến trình chết
// đúng lúc ghi: dòng đó không parse được nên bị bỏ qua và sẽ được ghi lại đầy đủ.
function readCollectionVersionIds(runDir) {
  const file = path.join(runDir, COLLECTION_VERSIONS_FILE);
  const ids = new Set();
  if (!fs.existsSync(file)) return ids;
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      ids.add(v.version_id || collection.versionId(v));
    } catch (_) { /* dòng dở dang */ }
  }
  return ids;
}

// Chỉ thêm, không bao giờ ghi đè/xóa; bỏ qua phiên bản đã có (chạy lại không tạo trùng).
function appendCollectionVersions(runDir, versions) {
  if (!versions.length) return 0;
  const file = path.join(runDir, COLLECTION_VERSIONS_FILE);
  const ids = readCollectionVersionIds(runDir);
  const fresh = versions.filter(v => !ids.has(v.version_id || collection.versionId(v)));
  if (!fresh.length) return 0;
  let prefix = '';
  try {
    const st = fs.statSync(file);
    if (st.size > 0) {
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(1);
      fs.readSync(fd, buf, 0, 1, st.size - 1);
      fs.closeSync(fd);
      if (buf.toString() !== '\n') prefix = '\n'; // tách khỏi dòng dở dang
    }
  } catch (_) {}
  fs.appendFileSync(file, prefix + fresh.map(v => JSON.stringify(v)).join('\n') + '\n', { encoding: 'utf-8', mode: 0o600 });
  return fresh.length;
}

function appendCollectionChanges(runDir, changes) {
  if (!changes.length) return 0;
  const file = path.join(runDir, COLLECTION_CHANGES_FILE);
  const existing = fs.existsSync(file) ? (readCsvTable(file, Number.MAX_SAFE_INTEGER).rows || []) : [];
  const ids = new Set(existing.map(r => r.change_id).filter(Boolean));
  const fresh = changes.filter(c => !ids.has(c.change_id));
  if (!fresh.length) return 0;
  writeCsv(file, COLLECTION_CHANGE_COLUMNS, existing.concat(fresh));
  return fresh.length;
}

// ── Giao dịch làm mới có thể khôi phục ───────────────────────────────────────
// Mỗi lượt giao việc cho worker là một giao dịch trong <run>/.collection_txn/<id>/:
//   1. prepared  — TRƯỚC khi worker thay dữ liệu: chụp dữ liệu cũ của đúng các phần sẽ
//                  lấy (before_rows.json) và sổ hiện tại (before_ledger.json), rồi mới ghi
//                  journal.json (có journal = ảnh chụp đã đủ).
//   2. fetched   — worker đã chạy xong (CSV/progress có thể đã đổi).
//   3. finalize  — so sánh, ghi lịch sử phiên bản → lịch sử thay đổi → sổ; mỗi bước đánh
//                  dấu trong journal, và bản thân mỗi bước đều idempotent (id ổn định).
//   4. committed — xóa thư mục giao dịch (chứa dữ liệu nhạy cảm), ghi 1 dòng nhật ký
//                  không định danh vào collection_txn_log.jsonl.
// Khi tiếp tục thu thập / xem trạng thái, giao dịch dở dang (không thuộc tiến trình đang
// chạy) được hoàn tất lại từ ảnh chụp: bản cũ không mất, phiên bản không trùng.
const COLLECTION_TXN_DIR = '.collection_txn';
const COLLECTION_TXN_LOG_FILE = 'collection_txn_log.jsonl';
const ACTIVE_COLLECTION_TXNS = new Map(); // txn_id → runDir của tiến trình này

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch (_) {}
}

function writePrivateJson(file, value) {
  writeJsonAtomic(file, value);
  try { fs.chmodSync(file, 0o600); } catch (_) {}
}

function collectionTxnRoot(runDir) {
  return path.join(runDir, COLLECTION_TXN_DIR);
}

function runDirHasActiveTxn(runDir) {
  const target = path.resolve(runDir);
  for (const dir of ACTIVE_COLLECTION_TXNS.values()) if (dir === target) return true;
  return false;
}

function beginCollectionTxn(runDir, { before, targets, reasons, beforeRows }) {
  const id = `txn_${nowFileStamp()}_${crypto.randomBytes(4).toString('hex')}`;
  const dir = path.join(collectionTxnRoot(runDir), id);
  ensurePrivateDir(collectionTxnRoot(runDir));
  ensurePrivateDir(dir);
  writePrivateJson(path.join(dir, 'before_rows.json'), Object.fromEntries(beforeRows));
  writePrivateJson(path.join(dir, 'before_ledger.json'), before);
  const journal = {
    txn_id: id, phase: 'prepared', created_at: nowIso(), process_instance_id: RESEARCH_PROCESS_INSTANCE_ID,
    targets, reasons, dispatched: [], steps: {},
  };
  writePrivateJson(path.join(dir, 'journal.json'), journal);
  ACTIVE_COLLECTION_TXNS.set(id, path.resolve(runDir));
  return { id, dir, journal };
}

function updateCollectionTxn(txn, patch) {
  txn.journal = { ...txn.journal, ...patch, steps: { ...(txn.journal.steps || {}), ...(patch.steps || {}) }, updated_at: nowIso() };
  writePrivateJson(path.join(txn.dir, 'journal.json'), txn.journal);
}

function closeCollectionTxn(runDir, txn, { recovered = false, counts = {} } = {}) {
  updateCollectionTxn(txn, { phase: 'committed', committed_at: nowIso() });
  try {
    fs.appendFileSync(path.join(runDir, COLLECTION_TXN_LOG_FILE), `${JSON.stringify({
      txn_id: txn.id, created_at: txn.journal.created_at, committed_at: txn.journal.committed_at,
      recovered, targets: (txn.journal.targets || []).length, ...counts,
    })}\n`, 'utf-8');
  } catch (_) {}
  fs.rmSync(txn.dir, { recursive: true, force: true });
}

// Bản JS của recover_interrupted_patient_commits (script XN/CĐHA): commit CSV dở dang
// (.commit_*/state.json chưa "committed") thì trả lại bản backup cho các file đã thay.
function recoverPythonPatientCommits(runDir) {
  let entries = [];
  try { entries = fs.readdirSync(runDir, { withFileTypes: true }); } catch (_) { return 0; }
  let restored = 0;
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('.commit_')) continue;
    const staging = path.join(runDir, e.name);
    const state = readJsonSafe(path.join(staging, 'state.json'), {}) || {};
    let ok = true;
    if (String(state.phase || '') !== 'committed') {
      for (const name of [...(state.replace_targets || [])].reverse()) {
        const backup = path.join(staging, `${name}.backup`);
        if (!fs.existsSync(backup)) continue;
        try { fs.copyFileSync(backup, path.join(runDir, name)); restored += 1; } catch (_) { ok = false; }
      }
    }
    if (ok) fs.rmSync(staging, { recursive: true, force: true });
  }
  return restored;
}

// Hoàn tất một giao dịch: dùng cho cả lần chạy bình thường lẫn khôi phục. Kết quả chỉ phụ
// thuộc ảnh chụp trong journal + dữ liệu hiện có, nên chạy lại cho đúng cùng phiên bản.
function finalizeCollectionTxn(runDir, txn, { sourceRows, applyOutcome = false, crash = () => {} } = {}) {
  recoverPythonPatientCommits(runDir);
  const j = txn.journal;
  const before = readJsonSafe(path.join(txn.dir, 'before_ledger.json'), null) || { encounters: {} };
  const beforeRows = new Map(Object.entries(readJsonSafe(path.join(txn.dir, 'before_rows.json'), {}) || {}));
  const now = j.fetched_at || j.created_at || nowIso();
  const after = buildCollectionLedgerForRun(runDir, sourceRows, before);
  if (applyOutcome) collection.applyDispatchOutcome(before, after, j.dispatched || [], now);
  const targets = (j.dispatched && j.dispatched.length) ? j.dispatched : (j.targets || []);
  const afterRows = partRowsMap(readCollectionPartRows(runDir), after, targets);
  const cv = collection.applyContentVersions({ before, after, targets, beforeRows, afterRows, reasons: j.reasons || {}, now });
  const versionsWritten = appendCollectionVersions(runDir, cv.versions.map(v => ({ ...v, txn_id: j.txn_id })));
  crash('after_versions');
  updateCollectionTxn(txn, { phase: 'finalizing', steps: { versions: true } });
  const changesWritten = appendCollectionChanges(runDir, cv.changes.map(c => ({ ...c, txn_id: j.txn_id })));
  updateCollectionTxn(txn, { steps: { changes: true } });
  crash('before_ledger');
  writeJsonAtomic(path.join(runDir, COLLECTION_LEDGER_FILE), after);
  updateCollectionTxn(txn, { steps: { ledger: true } });
  return { after, cv, versionsWritten, changesWritten };
}

// Tìm và hoàn tất giao dịch dở dang của run (bỏ qua giao dịch tiến trình này đang chạy).
function recoverCollectionTransactions(runDir, sourceRows) {
  const root = collectionTxnRoot(runDir);
  if (!fs.existsSync(root)) return [];
  const results = [];
  for (const id of fs.readdirSync(root).sort()) {
    if (ACTIVE_COLLECTION_TXNS.has(id)) continue;
    const dir = path.join(root, id);
    const journal = readJsonSafe(path.join(dir, 'journal.json'), null);
    if (!journal) {
      // Dừng khi đang chụp dữ liệu cũ: worker chưa được giao việc, không có gì để hoàn tất.
      fs.rmSync(dir, { recursive: true, force: true });
      results.push({ txn_id: id, action: 'discarded_unprepared' });
      continue;
    }
    const txn = { id, dir, journal };
    if (journal.phase === 'committed') {
      fs.rmSync(dir, { recursive: true, force: true });
      results.push({ txn_id: id, action: 'cleaned' });
      continue;
    }
    const { cv, versionsWritten, changesWritten } = finalizeCollectionTxn(runDir, txn, { sourceRows });
    closeCollectionTxn(runDir, txn, { recovered: true, counts: { versions: versionsWritten, changes: changesWritten } });
    appendResearchRunLog(runDir, `[COLLECT] Khôi phục giao dịch dở dang ${id} (từ bước ${journal.phase}): ghi thêm ${versionsWritten} phiên bản, ${changesWritten} thay đổi.`);
    results.push({ txn_id: id, action: 'recovered', from_phase: journal.phase, changes: cv.changes, versions_written: versionsWritten });
  }
  try { if (!fs.readdirSync(root).length) fs.rmdirSync(root); } catch (_) {}
  return results;
}

function refreshPolicyFor(isArchive, study) {
  const raw = isArchive ? readJsonSafe(archiveMetaPath(), {})?.refresh_policy : study?.refresh_policy;
  return collection.sanitizeRefreshPolicy(raw || {});
}

// Đánh giá đủ dùng theo yêu cầu của TỪNG nghiên cứu (kho gốc: mọi nghiên cứu; nghiên
// cứu riêng: chính nó) trên dữ liệu hiện tại của run.
function readinessByStudy({ isArchive, study, runDir, ledger, keys }) {
  const studies = isArchive ? listStudies() : (study ? [study] : []);
  if (!studies.length) return {};
  const tables = readinessTablesForRun(runDir);
  const out = {};
  for (const st of studies) {
    const r = collection.evaluateStudyReadiness({
      ledger, keys, requirements: collection.requirementsFromStudy(st), tables,
      maxAttempts: Number(st?.data_requirements?.max_attempts) || collection.DEFAULT_MAX_ATTEMPTS,
    });
    out[st.id] = { name: st.name || st.id, counts: r.counts, rows: new Map(r.rows.map(x => [x.key, x])), all: r.rows };
  }
  return out;
}

function readinessDiff(beforeMap, afterMap, keysOfInterest) {
  const changes = [];
  for (const [studyId, after] of Object.entries(afterMap || {})) {
    const before = beforeMap?.[studyId];
    for (const key of keysOfInterest) {
      const a = after.rows.get(key);
      const b = before?.rows?.get(key);
      if (!a || (b && b.readiness === a.readiness)) continue;
      changes.push({ study_id: studyId, study_name: after.name, key, research_code: a.research_code, before: b?.readiness || '', after: a.readiness, reasons: a.reasons });
    }
  }
  return changes;
}
const IN_RUN_RETRY_REASONS = new Set(['retry']);

// Đơn vị theo dõi = lượt điều trị: gom các dòng danh sách (chuyển khoa) về lượt đã chuẩn
// hóa trong encounters.csv. Chưa chuẩn hóa thì mỗi dòng là một đơn vị.
function collectionEncounterOverrideState(runDir) {
  const raw = readJsonSafe(path.join(runDir, COLLECTION_ENCOUNTER_OVERRIDES_FILE), {}) || {};
  return {
    version: 1,
    updated_at: String(raw.updated_at || ''),
    decisions: raw.decisions && typeof raw.decisions === 'object' ? raw.decisions : {},
  };
}

function collectionUnitsForRun(runDir, sourceRows) {
  const encounterRows = readCsvTable(path.join(runDir, 'encounters.csv'), Number.MAX_SAFE_INTEGER).rows || [];
  const overrides = collectionEncounterOverrideState(runDir).decisions;
  return collection.buildCollectionUnits({ sourceRows, encounterRows, encounterOverrides: overrides });
}

function unitKeysForRun(runDir, sourceRows) {
  return collectionUnitsForRun(runDir, sourceRows).map(u => u.key);
}

function buildCollectionLedgerForRun(runDir, sourceRows, previous) {
  return collection.buildLedger({
    units: collectionUnitsForRun(runDir, sourceRows),
    xnProgress: readProgressMapSafe(path.join(runDir, 'progress.json')),
    hchanhProgress: readProgressMapSafe(path.join(runDir, 'hchanh_auto_progress.json')),
    orderProgress: readProgressMapSafe(path.join(runDir, 'order_history_auto_progress.json')),
    previous: previous === undefined ? readJsonSafe(path.join(runDir, COLLECTION_LEDGER_FILE), null) : previous,
  });
}

// Dựng lại sổ từ progress hiện tại và ghi ra file. Idempotent: gọi lại với cùng
// progress/nguồn cho cùng kết quả (không đếm trùng số lần thử).
function syncCollectionLedger(runDir, sourceRows) {
  // Hoàn tất giao dịch dở dang TRƯỚC khi đọc progress, nếu không kết quả của worker sẽ bị
  // hấp thụ vào sổ mà không được lưu phiên bản.
  recoverCollectionTransactions(runDir, sourceRows);
  const ledger = buildCollectionLedgerForRun(runDir, sourceRows);
  // Tiến trình này đang có giao dịch trên run: không ghi sổ chen vào, giao dịch sẽ ghi.
  if (!runDirHasActiveTxn(runDir)) writeJsonAtomic(path.join(runDir, COLLECTION_LEDGER_FILE), ledger);
  return ledger;
}

// Lượt không ghép chắc chắn sau chuẩn hóa (không đủ khóa EMR để xác định đợt).
function unresolvedEncountersForRun(runDir) {
  const rows = readCsvTable(path.join(runDir, 'encounters.csv'), Number.MAX_SAFE_INTEGER).rows || [];
  return rows
    .filter(r => String(r.encounter_id || '').startsWith('enc_unresolved_'))
    .map(r => ({ key: r.encounter_id, research_code: r.research_code || '', patient_code: r.patient_code || '', detail: 'Không đủ khóa EMR để xác định lượt điều trị' }));
}

function collectionStatusSummary(ledger, keys) {
  const scope = keys || Object.keys(ledger?.encounters || {});
  const parts = Object.fromEntries(collection.PARTS.map(p => [p.key, { key: p.key, label: p.label, ok: 0, empty: 0, pending: 0, failed: 0, blocked: 0, stale: 0 }]));
  let complete = 0;
  for (const key of scope) {
    const enc = ledger?.encounters?.[key];
    if (!enc) continue;
    let all = true;
    for (const p of collection.PART_KEYS) {
      const st = enc.parts?.[p]?.status || 'pending';
      if (collection.isStale(enc, p)) parts[p].stale += 1;
      else parts[p][st] = (parts[p][st] || 0) + 1;
      if (!collection.partIsCurrent(enc, p)) all = false;
    }
    if (all) complete += 1;
  }
  return { encounters: scope.length, complete, parts: Object.values(parts) };
}

function collectionEncounterReviewPayload(sc) {
  const encounterRows = readCsvTable(path.join(sc.runDir, 'encounters.csv'), Number.MAX_SAFE_INTEGER).rows || [];
  const overrideState = collectionEncounterOverrideState(sc.runDir);
  const units = collection.buildCollectionUnits({
    sourceRows: sc.sourceRows,
    encounterRows,
    encounterOverrides: overrideState.decisions,
  });
  const validEncounters = encounterRows.filter(r => {
    const id = String(r.encounter_id || '').trim();
    return id && !id.startsWith('enc_unresolved_');
  });
  const dateMs = value => {
    const date = isoDate(value);
    const parsed = date ? Date.parse(date) : NaN;
    return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
  };
  const items = units
    .filter(u => u.match_status === 'unmatched')
    .map(u => {
      const sourceKey = String(u.members?.[0] || u.key || '');
      const decision = overrideState.decisions[sourceKey] || {};
      const sourceDate = firstNonEmpty(u.row || {}, ['T/G vào', 'TG vào', 'Ngày vào viện', 'admission_date']);
      const candidates = validEncounters
        .filter(r => String(r.patient_code || '').trim() === String(u.patient_code || '').trim())
        .sort((a, b) => Math.abs(dateMs(a.admission_date) - dateMs(sourceDate)) - Math.abs(dateMs(b.admission_date) - dateMs(sourceDate)))
        .slice(0, 12)
        .map(r => ({
          encounter_id: String(r.encounter_id || ''),
          research_code: String(r.research_code || ''),
          admission_date: String(r.admission_date || ''),
          discharge_date: String(r.discharge_date || ''),
          emr_noitru_id: String(r.emr_noitru_id || ''),
          emr_treatment_id: String(r.emr_treatment_id || ''),
        }));
      return {
        source_key: sourceKey,
        research_code: String(u.research_code || ''),
        patient_code: String(u.patient_code || ''),
        patient_name: firstNonEmpty(u.row || {}, ['Họ tên', 'Ho ten', 'patient_name']),
        admission_date: sourceDate,
        source_noitru_id: firstNonEmpty(u.row || {}, ['Mã nội trú', 'noitruid', 'emr_noitru_id']),
        reason: String(u.unmatched_reason || 'no_unique_encounter'),
        reason_label: collection.REASON_LABELS[u.unmatched_reason] || 'Chưa xác định chắc lượt điều trị',
        review_status: decision.status === 'unresolved' ? 'confirmed_unresolved' : 'pending',
        reviewed_at: String(decision.updated_at || ''),
        candidates,
      };
    });
  const linkedItems = Object.entries(overrideState.decisions)
    .filter(([, d]) => d?.status === 'linked' && d.encounter_id)
    .map(([sourceKey, decision]) => {
      const sourceRow = sc.sourceRows.find(r => String(firstNonEmpty(r, ['Research key', 'research_key', 'source_key']) || '').trim() === sourceKey);
      const target = validEncounters.find(r => String(r.encounter_id || '') === String(decision.encounter_id || ''));
      if (!sourceRow || !target) return null;
      return {
        source_key: sourceKey,
        research_code: firstNonEmpty(sourceRow, ['Mã NC', 'Ma NC', 'research_code']),
        patient_code: patientCode(sourceRow),
        patient_name: firstNonEmpty(sourceRow, ['Họ tên', 'Ho ten', 'patient_name']),
        encounter_id: String(target.encounter_id || ''),
        admission_date: String(target.admission_date || ''),
        discharge_date: String(target.discharge_date || ''),
        emr_noitru_id: String(target.emr_noitru_id || ''),
        reviewed_at: String(decision.updated_at || ''),
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.reviewed_at).localeCompare(String(a.reviewed_at)));
  return {
    status: 'ok', run_id: sc.runId, total: items.length,
    pending: items.filter(x => x.review_status === 'pending').length,
    confirmed_unresolved: items.filter(x => x.review_status === 'confirmed_unresolved').length,
    manual_linked: linkedItems.length,
    items, linked_items: linkedItems,
  };
}

function handleCollectionEncounterReviews(req, res, studyIdParam = '') {
  try {
    const sc = collectionScopeFromRequest(req, studyIdParam);
    if (sc.error) return res.status(sc.status || 400).json({ status: 'error', message: sc.error });
    if (req.method === 'GET') return res.json(collectionEncounterReviewPayload(sc));

    const sourceKey = String(req.body?.source_key || '').trim();
    const action = String(req.body?.action || '').trim();
    if (!sourceKey || sourceKey.length > 500) return res.status(400).json({ status: 'error', message: 'Research key không hợp lệ.' });
    const sourceRow = sc.sourceRows.find(r => String(firstNonEmpty(r, ['Research key', 'research_key', 'source_key']) || '').trim() === sourceKey);
    if (!sourceRow) return res.status(404).json({ status: 'error', message: 'Không còn tìm thấy dòng nguồn này.' });

    const state = collectionEncounterOverrideState(sc.runDir);
    if (action === 'clear') {
      delete state.decisions[sourceKey];
    } else if (action === 'unresolved') {
      state.decisions[sourceKey] = { status: 'unresolved', encounter_id: '', updated_at: nowIso() };
    } else if (action === 'link') {
      const encounterId = String(req.body?.encounter_id || '').trim();
      const encounterRows = readCsvTable(path.join(sc.runDir, 'encounters.csv'), Number.MAX_SAFE_INTEGER).rows || [];
      const target = encounterRows.find(r => String(r.encounter_id || '').trim() === encounterId && !encounterId.startsWith('enc_unresolved_'));
      if (!target) return res.status(404).json({ status: 'error', message: 'Lượt điều trị được chọn không còn tồn tại.' });
      if (String(patientCode(sourceRow) || '').trim() !== String(target.patient_code || '').trim()) {
        return res.status(400).json({ status: 'error', message: 'Không thể ghép hai Mã BN khác nhau.' });
      }
      state.decisions[sourceKey] = { status: 'linked', encounter_id: encounterId, updated_at: nowIso() };
    } else {
      return res.status(400).json({ status: 'error', message: 'Thao tác rà soát không hợp lệ.' });
    }
    state.updated_at = nowIso();
    writeJsonAtomic(path.join(sc.runDir, COLLECTION_ENCOUNTER_OVERRIDES_FILE), state);
    if (sc.sourceRows.length) syncCollectionLedger(sc.runDir, sc.sourceRows);
    return res.json(collectionEncounterReviewPayload(sc));
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
}

function writeCollectionOutputs(runDir, report) {
  writeJsonAtomic(path.join(runDir, COLLECTION_REPORT_FILE), report);
  writeCsv(path.join(runDir, COLLECTION_EXCEPTIONS_FILE), COLLECTION_EXCEPTION_COLUMNS, report.exceptions || []);
  const { exceptions, changes, readiness_changes: readinessChanges, ...summary } = report;
  try {
    fs.appendFileSync(path.join(runDir, COLLECTION_HISTORY_FILE), `${JSON.stringify(summary)}\n`, 'utf-8');
  } catch (_) {}
}

function redactCollectionRows(rows, redact) {
  if (!redact) return rows;
  return (rows || []).map(r => ({ ...r, patient_code: r.patient_code ? '[đã che]' : '' }));
}

async function runXnCdhaSubsetForCollection(ctx, { runDir, runId, scope, isArchive, rows, fromDate, toDate, headless }) {
  const inputDir = path.join(runDir, 'input');
  ensureDir(inputDir);
  const subsetPath = path.join(inputDir, `collect_xn_cdha_${nowFileStamp()}.csv`);
  writeCsvUnion(subsetPath, rows, [
    'Mã NC', 'Mã BN', 'Họ tên', 'T/G vào', 'TG vào', 'Ngày vào viện', 'Ngày ra viện', 'Mã nội trú',
    'fetch_from_date', 'fetch_to_date', 'source_run_id', 'Research key', 'refetch_parts',
  ]);
  const args = ['-u', SCRIPT_PATH, '--input', subsetPath, '--project-id', scope, '--run-id', runId, '--out-root', RESEARCH_STORE_DIR];
  const initialListPath = isArchive ? archiveTablePath('initial_list', runId) : '';
  if (isArchive && initialListPath) args.push('--archive-initial-list', initialListPath);
  if (fromDate) args.push('--from-date', fromDate);
  if (toDate) args.push('--to-date', toDate);
  if (headless) args.push('--headless');
  let result;
  try {
    result = await runPython(args, {
      cwd: ROOT_DIR,
      onSpawn: killFn => registerCancel(ctx.sid, killFn),
      extraEnv: { RESEARCH_INPUT_NAME: path.basename(subsetPath), RESEARCH_REFETCH_MISSING: '1' },
    });
  } finally {
    unregisterCancel(ctx.sid);
  }
  if (result.spawnError) return { error: `Không khởi động được Python: ${result.spawnError}` };
  if (result.killedByTimeout) return { error: 'timeout' };
  if (result.code !== 0 && !isStoppedRunResult(result)) return { error: fmtPyError('Lấy XN/CĐHA lỗi', result) };
  return { ok: true, stopped: isStoppedRunResult(result) };
}

const DEFAULT_COLLECTION_RUNNERS = {
  hchanh: (ctx, opts) => fetchHchanhForResearchRun(ctx, opts.runDir, opts),
  xnCdha: (ctx, opts) => runXnCdhaSubsetForCollection(ctx, opts),
  normalize: (runDir, runId) => normalizeRunOutputs(runDir, { sourceRunId: runId }),
};

async function runCollectionOrchestration(ctx, {
  runDir, runId, scope, isArchive = true, sourceRows = [], fromDate = '', toDate = '', headless = true,
  maxAttempts = collection.DEFAULT_MAX_ATTEMPTS, maxPasses = 2, force = false, retryBlocked = false,
  parts = collection.PART_KEYS, limit = 0, refreshPolicy = {}, refreshParts = [], refreshKeys = null, study = null,
  now = null, faults = null,
} = {}, runners = DEFAULT_COLLECTION_RUNNERS) {
  const startedAt = nowIso();
  // Chỉ dùng trong test: mô phỏng tiến trình chết tại một điểm (ném lỗi, không dọn dẹp gì).
  const crash = (point) => {
    if (faults?.crashAt === point) {
      const err = new Error(`SIMULATED_CRASH:${point}`);
      err.code = 'SIMULATED_CRASH';
      throw err;
    }
  };
  // Giao dịch dở dang của lần chạy trước được hoàn tất trước khi dựng sổ (xem syncCollectionLedger).
  const recoveredTxns = recoverCollectionTransactions(runDir, sourceRows);
  const units = collectionUnitsForRun(runDir, sourceRows);
  const keys = units.map(u => u.key);
  // Mỗi lượt giao cho worker một dòng đại diện (dòng vào sớm nhất, khoảng lấy phủ cả lượt).
  const rowByKey = new Map(units.map(u => [u.key, u.row]));
  const first = syncCollectionLedger(runDir, sourceRows);
  const plan = collection.planCollection(first, { keys, maxAttempts, parts, retryBlocked, force, refreshPolicy, refreshParts, refreshKeys, now: now || nowIso() });
  if (limit > 0) plan.tasks = plan.tasks.slice(0, limit);
  appendResearchRunLog(runDir, `[COLLECT] Bắt đầu: ${keys.length} lượt | cần lấy ${plan.tasks.length} lượt (${plan.summary.parts_to_fetch} phần, trong đó kiểm tra lại ${plan.summary.refresh_parts}) | không đổi ${plan.summary.unchanged} | hết lượt thử ${plan.summary.exhausted_parts} phần | cần người xem ${plan.summary.blocked_parts} phần`);

  let readinessBefore = {};
  try { readinessBefore = readinessByStudy({ isArchive, study, runDir, ledger: first, keys }); } catch (err) { console.error('[COLLECT] readiness(before)', err.message); }
  const reasonById = {};
  for (const t of plan.tasks) for (const pk of t.parts) reasonById[`${t.key}|${pk}`] = t.reasons[pk];
  const content = { changes: recoveredTxns.flatMap(r => r.changes || []), rechecked: 0, unchanged: 0, first: 0 };

  let current = first;
  let cancelled = false;
  const errors = [];
  for (let pass = 0; pass < Math.max(1, maxPasses); pass += 1) {
    let tasks;
    if (pass === 0) tasks = plan.tasks;
    else {
      // Thử lại trong cùng lần chạy CHỈ cho lỗi kỹ thuật vừa gặp (còn lượt thử).
      const retryPlan = collection.planCollection(current, { keys: plan.tasks.map(t => t.key), maxAttempts, parts });
      tasks = retryPlan.tasks
        .map(t => ({ ...t, parts: t.parts.filter(pk => IN_RUN_RETRY_REASONS.has(t.reasons[pk])) }))
        .filter(t => t.parts.length);
      if (tasks.length) appendResearchRunLog(runDir, `[COLLECT] Thử lại lỗi kỹ thuật: ${tasks.length} lượt`);
    }
    if (!tasks.length) break;
    const before = current;
    const dispatched = [];
    const targets = tasks.flatMap(t => t.parts.map(pk => ({ key: t.key, part: pk })));
    const beforeRows = partRowsMap(readCollectionPartRows(runDir), before, targets);
    const groups = collection.groupTasksByFetcher(tasks);
    const rowsFor = list => list.map(t => rowByKey.get(t.key)).filter(Boolean);
    const cancelNow = () => { if (isCancelRequested(ctx.sid)) cancelled = true; return cancelled; };
    // Ghi nhận "chuẩn bị làm mới" + ảnh chụp dữ liệu cũ TRƯỚC khi worker thay dữ liệu.
    const passReasons = {};
    for (const t of tasks) for (const pk of t.parts) passReasons[`${t.key}|${pk}`] = reasonById[`${t.key}|${pk}`] || t.reasons[pk];
    const txn = beginCollectionTxn(runDir, { before, targets, reasons: passReasons, beforeRows });
    try {
      crash('before_csv');

      for (const [sig, list] of groups.hchanh.entries()) {
        if (cancelNow()) break;
        const files = sig.split(',');
        try {
          const r = await runners.hchanh(ctx, {
            runDir, sourceRows: rowsFor(list), sourceRunId: runId, files, headless,
            forceKeys: new Set(list.map(t => t.key)), fallbackDateFrom: fromDate, fallbackDateTo: toDate, mode: 'hchanh_auto',
          });
          if (r?.cancelled) cancelled = true;
        } catch (err) {
          errors.push(`Hành chánh (${files.join(',')}): ${err.message || err}`);
        }
        for (const t of list) for (const pk of files) dispatched.push({ key: t.key, part: pk });
      }
      if (!cancelNow() && groups.order_history.length) {
        try {
          const r = await runners.hchanh(ctx, {
            runDir, sourceRows: rowsFor(groups.order_history), sourceRunId: runId, files: ['order_history'], headless,
            forceKeys: new Set(groups.order_history.map(t => t.key)), fallbackDateFrom: fromDate, fallbackDateTo: toDate, mode: 'order_history_auto',
          });
          if (r?.cancelled) cancelled = true;
        } catch (err) {
          errors.push(`Y lệnh: ${err.message || err}`);
        }
        for (const t of groups.order_history) dispatched.push({ key: t.key, part: 'order_history' });
      }
      if (!cancelNow() && groups.xn_cdha.length) {
        const rows = groups.xn_cdha
          .map(t => {
            const row = rowByKey.get(t.key);
            return row ? { ...row, refetch_parts: t.parts.join(';') } : null;
          })
          .filter(Boolean);
        const r = await runners.xnCdha(ctx, { runDir, runId, scope, isArchive, rows, fromDate, toDate, headless });
        if (r?.error) errors.push(`XN/CĐHA: ${String(r.error).split('\n')[0]}`);
        if (r?.stopped) cancelled = true;
        for (const t of groups.xn_cdha) for (const pk of t.parts) dispatched.push({ key: t.key, part: pk });
      }
      if (isCancelRequested(ctx.sid)) cancelled = true;
      crash('after_csv');
      updateCollectionTxn(txn, { phase: 'fetched', fetched_at: nowIso(), dispatched, cancelled });

      // So dữ liệu mới với bản trước: giống → chỉ ghi "đã kiểm tra"; khác → phiên bản mới,
      // bản cũ và bản mới đều được lưu vào lịch sử (chỉ thêm). Dừng giữa chừng: phần chưa tới
      // lượt không bị tính là worker không trả kết quả.
      const { after, cv } = finalizeCollectionTxn(runDir, txn, { sourceRows, applyOutcome: !cancelled, crash });
      closeCollectionTxn(runDir, txn, { counts: { versions: cv.versions.length, changes: cv.changes.length } });
      content.changes.push(...cv.changes);
      content.rechecked += cv.rechecked;
      content.unchanged += cv.unchanged;
      content.first += cv.first;
      current = after;
    } finally {
      // Kết thúc (kể cả khi lỗi/dừng): giao dịch không còn thuộc tiến trình này; nếu chưa
      // committed thì lần sau sẽ được khôi phục.
      ACTIVE_COLLECTION_TXNS.delete(txn.id);
    }
    if (cancelled) break;
  }

  let normalized = null;
  try {
    normalized = runners.normalize(runDir, runId);
  } catch (err) {
    errors.push(`Chuẩn hóa: ${err.message || err}`);
  }
  // Sau khi cập nhật: đánh giá lại các lượt vừa lấy theo yêu cầu của từng nghiên cứu.
  let readinessChanges = [];
  let readinessSummary = {};
  try {
    const readinessAfter = readinessByStudy({ isArchive, study, runDir, ledger: current, keys });
    const touched = new Set(plan.tasks.map(t => t.key));
    readinessChanges = readinessDiff(readinessBefore, readinessAfter, touched);
    readinessSummary = Object.fromEntries(Object.entries(readinessAfter).map(([id, r]) => [id, { name: r.name, counts: r.counts }]));
    if (!isArchive && study && readinessAfter[study.id]) {
      writeCsv(path.join(runDir, STUDY_READINESS_FILE), ['research_code', 'encounter_id', 'readiness', 'reasons', 'missing_parts', 'review_parts', 'key'], readinessAfter[study.id].all);
    }
  } catch (err) {
    errors.push(`Đánh giá đủ dùng: ${err.message || err}`);
  }
  const report = collection.buildRunReport({
    content,
    readinessChanges,
    before: first,
    after: current,
    plan,
    keys,
    maxAttempts,
    unmatchedEncounters: unresolvedEncountersForRun(runDir),
    startedAt,
    finishedAt: nowIso(),
    cancelled,
    errors,
  });
  report.run_id = runId;
  report.scope = scope;
  report.max_attempts = maxAttempts;
  report.progress_unattributed = current.unmatched_progress || 0;
  report.refresh_policy = collection.sanitizeRefreshPolicy(refreshPolicy);
  report.recovered_transactions = recoveredTxns.filter(r => r.action === 'recovered').length;
  report.readiness_by_study = readinessSummary;
  writeCollectionOutputs(runDir, report);
  appendResearchRunLog(runDir, `[COLLECT] ${cancelled ? 'Đã dừng' : 'Xong'}: đã lấy ${report.fetched_encounters} lượt | bỏ qua vì không đổi ${report.skipped_unchanged} | lấy bù ${report.parts_backfilled} phần | kiểm tra lại ${report.parts_rechecked} phần, có thay đổi ${report.parts_changed} | lỗi Selenium còn tồn ${report.selenium_errors_open} phần | không ghép chắc ${report.unmatched_encounters} lượt | đổi mức đủ dùng ${report.readiness_changes.length}`);
  return { report, normalized, ledger: current };
}

function collectionScopeFromRequest(req, studyIdParam = '') {
  if (!studyIdParam) {
    const archive = readArchive();
    const runId = resolveArchiveRunIdForAction(req.body?.runId || req.query?.runId || 'latest');
    if (!runId) return { error: 'Kho gốc chưa có run. Chạy Bước 1 — Quét danh sách trước.' };
    const runDir = path.join(archiveRunsDir(), runId);
    const fromDate = String(req.body?.fromDate || archive.scan_from_date || '').trim();
    const toDate = String(req.body?.toDate || archive.scan_to_date || todayDateInput()).trim();
    const src = readResearchHchanhSourceRows(runDir, archiveSourcePath(), { sourceRunId: runId, dateDefaults: { from_date: fromDate, to_date: toDate } });
    return { isArchive: true, scope: ARCHIVE_ID, runId, runDir, fromDate: src.date_context?.from_date || fromDate, toDate: src.date_context?.to_date || toDate, sourceRows: src.rows || [], study: null, refreshPolicy: refreshPolicyFor(true, null) };
  }
  const study = readStudy(studyIdParam);
  if (!study) return { error: 'Không tìm thấy nghiên cứu.', status: 404 };
  const runId = resolveRunId(study.id, 'latest');
  if (!runId) return { error: 'Nghiên cứu chưa có run.' };
  const runDir = path.join(runsDir(study.id), runId);
  const fromDate = String(req.body?.fromDate || '').trim();
  const toDate = String(req.body?.toDate || todayDateInput()).trim();
  const src = readResearchHchanhSourceRows(runDir, cohortPath(study.id), { sourceRunId: runId });
  return { isArchive: false, scope: study.id, runId, runDir, fromDate: src.date_context?.from_date || fromDate, toDate: src.date_context?.to_date || toDate, sourceRows: src.rows || [], study, refreshPolicy: refreshPolicyFor(false, study) };
}

function maxAttemptsFrom(req, study) {
  const fromBody = Number(req.body?.maxAttempts);
  if (Number.isInteger(fromBody) && fromBody >= 1 && fromBody <= 10) return fromBody;
  const fromStudy = Number(study?.data_requirements?.max_attempts);
  if (Number.isInteger(fromStudy) && fromStudy >= 1 && fromStudy <= 10) return fromStudy;
  return collection.DEFAULT_MAX_ATTEMPTS;
}

async function handleCollectAuto(req, res, studyIdParam = '') {
  const ctx = getRuntimePaths(req);
  try {
    const sc = collectionScopeFromRequest(req, studyIdParam);
    if (sc.error) return res.status(sc.status || 400).json({ status: 'error', message: sc.error });
    if (!sc.sourceRows.length) return res.status(400).json({ status: 'error', message: 'Chưa có danh sách lượt điều trị (research_source.csv). Hãy quét danh sách hoặc nạp cohort trước.' });
    const requestedParts = Array.isArray(req.body?.parts) ? req.body.parts.filter(p => collection.PART_KEYS.includes(p)) : [];
    const options = {
      runDir: sc.runDir, runId: sc.runId, scope: sc.scope, isArchive: sc.isArchive, sourceRows: sc.sourceRows,
      fromDate: sc.fromDate, toDate: sc.toDate, headless: researchHeadlessFromBody(req.body),
      maxAttempts: maxAttemptsFrom(req, sc.study),
      force: req.body?.force === true,
      refreshProvisional: req.body?.refreshProvisional === true,
      retryBlocked: req.body?.retryBlocked === true,
      parts: requestedParts.length ? requestedParts : collection.PART_KEYS,
      limit: Number.isFinite(Number(req.body?.limit)) ? Math.max(0, Math.trunc(Number(req.body.limit))) : 0,
      // "Làm mới": người dùng chọn kiểm tra lại các phần này (tùy chọn chỉ vài lượt).
      refreshParts: Array.isArray(req.body?.refreshParts) ? req.body.refreshParts.filter(p => collection.PART_KEYS.includes(p)) : [],
      refreshKeys: Array.isArray(req.body?.refreshKeys) && req.body.refreshKeys.length ? req.body.refreshKeys.map(String).slice(0, 20000) : null,
      refreshPolicy: sc.refreshPolicy,
      study: sc.study,
    };
    const task = beginResearchTask(sc.runDir, {
      type: 'collect_auto', label: 'Thu thập tự động', status: 'queued', scope: sc.scope, run_id: sc.runId,
      message: 'Đã nhận yêu cầu thu thập tự động (chỉ lấy phần thiếu/lỗi/đã thay đổi).',
    });
    if (sc.isArchive) updateArchive({ active_run_id: sc.runId, active_mode: 'collect_auto' });
    await enqueueHeavy(ctx.sid, async () => {
      updateResearchTask(sc.runDir, task.id, { status: 'running', message: 'Đang thu thập tự động. Có thể chuyển tab, tiến độ vẫn được lưu ở backend.' });
      try {
        const { report, normalized } = await runCollectionOrchestration(ctx, options);
        const metaPatch = { last_run_id: sc.runId, last_run_at: nowIso(), last_normalized_at: nowIso(), last_collect_at: nowIso() };
        if (sc.isArchive) updateArchive({ ...metaPatch, active_run_id: '', active_mode: '' });
        else updateStudy(sc.scope, metaPatch);
        const message = `${report.cancelled ? 'Đã dừng' : 'Xong'}: lấy ${report.fetched_encounters} lượt, bỏ qua ${report.skipped_unchanged} lượt không đổi, lấy bù ${report.parts_backfilled} phần, kiểm tra lại ${report.parts_rechecked} phần (${report.parts_changed} phần có thay đổi), lỗi còn tồn ${report.selenium_errors_open} phần, không ghép chắc ${report.unmatched_encounters} lượt.`;
        finishResearchTask(sc.runDir, task.id, report.cancelled ? 'cancelled' : (report.errors.length ? 'error' : 'done'), { message });
        const redact = researchResponseShouldRedact(req);
        return res.json({
          status: 'ok', message, run_id: sc.runId, cancelled: report.cancelled,
          report: { ...report, exceptions: redactCollectionRows(report.exceptions.slice(0, 500), redact) },
          normalized,
        });
      } catch (err) {
        if (sc.isArchive) updateArchive({ active_run_id: '', active_mode: '', stopped_at: nowIso() });
        finishResearchTask(sc.runDir, task.id, 'error', { message: String(err?.message || err) });
        throw err;
      }
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(err.status || 500).json({ status: 'error', message: String(err.message || err) });
  }
}

function handleCollectionStatus(req, res, studyIdParam = '') {
  try {
    const sc = collectionScopeFromRequest(req, studyIdParam);
    if (sc.error) return res.status(sc.status || 400).json({ status: 'error', message: sc.error });
    const keys = unitKeysForRun(sc.runDir, sc.sourceRows);
    const ledger = sc.sourceRows.length ? syncCollectionLedger(sc.runDir, sc.sourceRows) : { encounters: {} };
    const maxAttempts = maxAttemptsFrom(req, sc.study);
    const plan = collection.planCollection(ledger, { keys, maxAttempts, refreshPolicy: sc.refreshPolicy });
    const exceptions = collection.exceptionRows(ledger, { keys, maxAttempts, unmatchedEncounters: unresolvedEncountersForRun(sc.runDir) });
    const lastReport = readJsonSafe(path.join(sc.runDir, COLLECTION_REPORT_FILE), null);
    const redact = researchResponseShouldRedact(req);
    return res.json({
      status: 'ok',
      run_id: sc.runId,
      max_attempts: maxAttempts,
      refresh_policy: sc.refreshPolicy,
      summary: collectionStatusSummary(ledger, keys),
      next_plan: plan.summary,
      last_report: lastReport ? { ...lastReport, exceptions: undefined } : null,
      exceptions_total: exceptions.length,
      exceptions: redactCollectionRows(exceptions.slice(0, 500), redact),
    });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
}

function handleCollectionExceptionsExport(req, res, studyIdParam = '') {
  try {
    const sc = collectionScopeFromRequest(req, studyIdParam);
    if (sc.error) return res.status(sc.status || 400).json({ status: 'error', message: sc.error });
    const keys = unitKeysForRun(sc.runDir, sc.sourceRows);
    const ledger = sc.sourceRows.length ? syncCollectionLedger(sc.runDir, sc.sourceRows) : { encounters: {} };
    const rows = collection.exceptionRows(ledger, { keys, maxAttempts: maxAttemptsFrom(req, sc.study), unmatchedEncounters: unresolvedEncountersForRun(sc.runDir) });
    writeCsv(path.join(sc.runDir, COLLECTION_EXCEPTIONS_FILE), COLLECTION_EXCEPTION_COLUMNS, rows);
    return sendCsvFile(res, path.join(sc.runDir, COLLECTION_EXCEPTIONS_FILE), `${sc.scope}_ngoai_le_thu_thap`, { redact: researchResponseShouldRedact(req) });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
}

function readinessTablesForRun(runDir) {
  const read = name => readCsvTable(path.join(runDir, `${name}.csv`), Number.MAX_SAFE_INTEGER).rows || [];
  return {
    encounters: read('encounters'),
    lab_results: read('lab_results'),
    imaging_results: read('imaging_results'),
    surgery_results: read('surgery_results'),
    medication_orders: read('medication_orders'),
    diagnoses: read('diagnoses'),
    clinical_notes: read('clinical_notes'),
  };
}

// Đủ dùng cho nghiên cứu `study`, đánh giá trên run `runDir` (run của chính nghiên cứu,
// hoặc kho gốc để biết ca nào trong kho đạt điều kiện đề tài).
function studyReadinessForRun(study, runDir, sourceRows, { write = false, maxAttempts } = {}) {
  const keys = unitKeysForRun(runDir, sourceRows);
  const ledger = syncCollectionLedger(runDir, sourceRows);
  const requirements = collection.requirementsFromStudy(study);
  const result = collection.evaluateStudyReadiness({
    ledger, keys, requirements, tables: readinessTablesForRun(runDir),
    maxAttempts: maxAttempts || collection.DEFAULT_MAX_ATTEMPTS,
  });
  if (write) {
    writeCsv(path.join(runDir, STUDY_READINESS_FILE), ['research_code', 'encounter_id', 'readiness', 'reasons', 'missing_parts', 'review_parts', 'key'], result.rows);
  }
  return result;
}

lockedResearchRoute('post', '/research/archive/collect-auto', 'Thu thập tự động', (req, res) => handleCollectAuto(req, res));
lockedResearchRoute('post', '/research/studies/:studyId/collect-auto', 'Thu thập tự động', (req, res) => handleCollectAuto(req, res, req.params.studyId));
router.get('/research/archive/collection-status', (req, res) => handleCollectionStatus(req, res));
router.get('/research/studies/:studyId/collection-status', (req, res) => handleCollectionStatus(req, res, req.params.studyId));
router.get('/research/archive/collection-exceptions', (req, res) => handleCollectionExceptionsExport(req, res));
router.get('/research/studies/:studyId/collection-exceptions', (req, res) => handleCollectionExceptionsExport(req, res, req.params.studyId));
router.get('/research/archive/encounter-reviews', (req, res) => handleCollectionEncounterReviews(req, res));
lockedResearchRoute('post', '/research/archive/encounter-reviews', 'Duyệt lượt chưa ghép', (req, res) => handleCollectionEncounterReviews(req, res));
router.get('/research/studies/:studyId/encounter-reviews', (req, res) => handleCollectionEncounterReviews(req, res, req.params.studyId));
lockedResearchRoute('post', '/research/studies/:studyId/encounter-reviews', 'Duyệt lượt chưa ghép', (req, res) => handleCollectionEncounterReviews(req, res, req.params.studyId));

// Đủ dùng của các lượt trong run nghiên cứu, theo phần bắt buộc + điều kiện dữ liệu của đề cương.
router.get('/research/studies/:studyId/readiness', (req, res) => {
  try {
    const sc = collectionScopeFromRequest(req, req.params.studyId);
    if (sc.error) return res.status(sc.status || 400).json({ status: 'error', message: sc.error });
    const result = studyReadinessForRun(sc.study, sc.runDir, sc.sourceRows, { write: true, maxAttempts: maxAttemptsFrom(req, sc.study) });
    return res.json({ status: 'ok', run_id: sc.runId, requirements: result.requirements, counts: result.counts, total: result.total, rows: result.rows.slice(0, 2000) });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

// Các lượt trong KHO GỐC đạt điều kiện của một nghiên cứu (không ghi file).
router.get('/research/archive/readiness', (req, res) => {
  try {
    const study = readStudy(String(req.query?.studyId || ''));
    if (!study) return res.status(404).json({ status: 'error', message: 'Cần studyId của một nghiên cứu có thật.' });
    const sc = collectionScopeFromRequest(req);
    if (sc.error) return res.status(sc.status || 400).json({ status: 'error', message: sc.error });
    const result = studyReadinessForRun(study, sc.runDir, sc.sourceRows, { maxAttempts: maxAttemptsFrom(req, study) });
    return res.json({ status: 'ok', run_id: sc.runId, study_id: study.id, requirements: result.requirements, counts: result.counts, total: result.total, rows: result.rows.slice(0, 2000) });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

// Chính sách làm mới riêng từng phần (số ngày kể từ lần kiểm tra gần nhất; trống = không
// tự kiểm tra lại). Kho gốc và mỗi nghiên cứu có chính sách riêng.
router.post('/research/archive/refresh-policy', (req, res) => {
  try {
    const policy = collection.sanitizeRefreshPolicy(req.body?.refresh_policy || req.body || {});
    updateArchive({ refresh_policy: policy });
    return res.json({ status: 'ok', refresh_policy: policy });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.post('/research/studies/:studyId/refresh-policy', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const policy = collection.sanitizeRefreshPolicy(req.body?.refresh_policy || req.body || {});
    updateStudy(study.id, { refresh_policy: policy });
    return res.json({ status: 'ok', refresh_policy: policy });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

// Lịch sử thay đổi nội dung (phần nào, phiên bản nào, thêm/bớt bao nhiêu dòng).
function handleCollectionChanges(req, res, studyIdParam = '') {
  try {
    const sc = collectionScopeFromRequest(req, studyIdParam);
    if (sc.error) return res.status(sc.status || 400).json({ status: 'error', message: sc.error });
    const rows = readCsvTable(path.join(sc.runDir, COLLECTION_CHANGES_FILE), Number.MAX_SAFE_INTEGER).rows || [];
    return res.json({ status: 'ok', run_id: sc.runId, total: rows.length, changes: rows.slice(-1000).reverse() });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
}
router.get('/research/archive/collection-changes', (req, res) => handleCollectionChanges(req, res));
router.get('/research/studies/:studyId/collection-changes', (req, res) => handleCollectionChanges(req, res, req.params.studyId));

// Yêu cầu dữ liệu của đề cương: phần bắt buộc + dữ liệu phải có (ví dụ CT).
router.post('/research/studies/:studyId/data-requirements', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const dataRequirements = collection.sanitizeDataRequirements(req.body?.data_requirements || req.body || {});
    const updated = updateStudy(study.id, { data_requirements: { ...dataRequirements, updated_at: nowIso() } });
    return res.json({ status: 'ok', study: updated, requirements: collection.requirementsFromStudy(updated) });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/analysis-presets', (_req, res) => {
  const out = Object.entries(ANALYSIS_PRESETS).map(([id, p]) => ({
    id,
    label: p.label,
    inference_fields: p.inference_fields.map(f => ({ key: f.key, label: f.label })),
  }));
  return res.json({ status: 'ok', presets: out });
});

function sanitizeVariableSelection(input) {
  return variableSelection.sanitizeVariableSelection(input);
}

function activeVariableSelectionFromStudy(study) {
  return study?.variable_selection || study?.analysis_config?.variable_selection || null;
}

function readRunRowsForSelection(runDir, tableKey, fallbackRows = [], maxRows = Number.MAX_SAFE_INTEGER) {
  if (!tableKey) return [];
  if (Array.isArray(fallbackRows) && ['cohort', 'initial_list', 'research_source'].includes(tableKey) && fallbackRows.length) return fallbackRows;
  const table = TABLES[tableKey];
  if (!table || table.root !== 'run') return [];
  return readCsvTable(path.join(runDir, table.file), maxRows).rows || [];
}

function loadRunTablesForSelection(runDir, selection, fallbackRows = [], maxRows = Number.MAX_SAFE_INTEGER) {
  const out = {};
  const keys = new Set();
  for (const item of [...(selection?.selected_variables || []), ...(selection?.conditions || [])]) {
    if (item?.table) keys.add(item.table);
  }
  for (const key of keys) out[key] = readRunRowsForSelection(runDir, key, fallbackRows, maxRows);
  if (fallbackRows?.length) {
    out.initial_list = out.initial_list || fallbackRows;
    out.cohort = out.cohort || fallbackRows;
    out.research_source = out.research_source || fallbackRows;
  }
  return out;
}

function buildSelectedAnalysisForRun(runDir, analysisReadyRows, normalizedRowsByKey, selection) {
  if (!variableSelection.hasActiveSelection(selection)) return null;
  const selected = variableSelection.buildSelectedAnalysisDataset(analysisReadyRows || [], selection, normalizedRowsByKey || {});
  writeCsv(path.join(runDir, 'analysis_selected.csv'), selected.columns, selected.rows);
  writeJsonAtomic(path.join(runDir, 'analysis_selection_manifest.json'), {
    ...selected.manifest,
    run_id: path.basename(runDir),
    source: 'variable_selection',
  });
  return { rows: selected.rows.length, columns: selected.columns.length, manifest: selected.manifest };
}

router.post('/research/studies', (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ status: 'error', message: 'Cần nhập tên nghiên cứu.' });
    const id = req.body?.id ? cleanStudyId(req.body.id) : uniqueStudyId(name);
    if (id === ARCHIVE_ID) return res.status(400).json({ status: 'error', message: 'Mã này đang dùng cho kho dữ liệu gốc.' });
    if (fs.existsSync(studyDir(id))) return res.status(409).json({ status: 'error', message: 'Mã nghiên cứu đã tồn tại.' });
    ensureDir(studyDir(id));

    // Validate analysis_config
    const rawPreset = String(req.body?.analysis_config?.preset || 'general');
    const presetId  = ANALYSIS_PRESETS[rawPreset] ? rawPreset : 'general';
    const customFields = cleanCustomFields(req.body?.analysis_config?.custom_fields, presetId, true);
    const rawVariableSelection = req.body?.variable_selection || req.body?.analysis_config?.variable_selection || null;
    const variable_selection = rawVariableSelection ? sanitizeVariableSelection(rawVariableSelection) : null;
    const analysis_config = { preset: presetId, custom_fields: customFields };
    if (variable_selection) analysis_config.variable_selection = variable_selection;

    const meta = {
      id,
      name,
      description: String(req.body?.description || '').trim(),
      type: 'archive_derived',
      analysis_config,
      variable_selection,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    writeJsonAtomic(studyMetaPath(id), meta);
    return res.json({ status: 'ok', study: readStudy(id) });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.post('/research/studies/:studyId/analysis-config', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });

    const rawPreset = String(req.body?.preset || 'general');
    const presetId  = ANALYSIS_PRESETS[rawPreset] ? rawPreset : 'general';
    const customFields = cleanCustomFields(req.body?.custom_fields, presetId, true);
    const analysis_config = { preset: presetId, custom_fields: customFields };
    if (study.analysis_config?.variable_selection) analysis_config.variable_selection = study.analysis_config.variable_selection;
    const updated = updateStudy(study.id, { analysis_config });
    return res.json({ status: 'ok', message: `Đã cập nhật cấu hình phân tích: ${ANALYSIS_PRESETS[presetId].label}.`, study: updated });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/studies/:studyId', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    return res.json({ status: 'ok', study });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute('post', '/research/studies/:studyId/cohort', 'Nạp cohort', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const csv = String(req.body?.csv || '');
    const parsed = validatePatientCsv(csv, 'CSV cần có cột Mã BN.');
    writeFileAtomic(cohortPath(study.id), csv.replace(/^\ufeff/, ''), 'utf-8');
    const original = String(req.body?.filename || 'cohort.csv').trim();
    updateStudy(study.id, { cohort_filename: original || 'cohort.csv', cohort_uploaded_at: nowIso(), cohort_source: 'upload' });
    return res.json({ status: 'ok', study: readStudy(study.id), columns: parsed.columns, count: parsed.count });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute('delete', '/research/studies/:studyId', 'Xóa nghiên cứu', (req, res) => {
  try {
    const { studyId } = req.params;
    const study = readStudy(studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    // Không xóa vĩnh viễn: chuyển cả thư mục (runs, cohort, study.json, SQLite) vào
    // research_store/_deleted/<id>_<thời điểm>/ để còn khôi phục được nếu xóa nhầm.
    // Dọn hẳn thư mục _deleted là việc của admin theo chính sách lưu trữ của bệnh viện.
    const trashDir = path.join(RESEARCH_STORE_DIR, '_deleted');
    ensureDir(trashDir);
    const target = path.join(trashDir, `${study.id}_${nowFileStamp()}`);
    fs.renameSync(studyDir(study.id), target);
    appendSecurityAudit({
      kind: 'research.study_deleted',
      actor: { id: String(req.auth?.id || ''), role: String(req.auth?.role || '') },
      study_id: study.id,
      moved_to: path.relative(RESEARCH_STORE_DIR, target),
    });
    return res.json({ status: 'ok', message: `Đã xóa nghiên cứu "${study.name}" (thư mục được chuyển vào _deleted, admin có thể khôi phục).` });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

// Lưu cohort từ danh sách đã lọc trên frontend (mảng rows JSON → ghi thành cohort.csv)
lockedResearchRoute('post', '/research/studies/:studyId/cohort-from-filtered', 'Nạp cohort', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ status: 'error', message: 'Danh sách rỗng.' });
    const normalizedRows = rows.map((row, idx) => {
      const next = { ...(row || {}) };
      const code = firstNonEmpty(next, ['Mã BN', 'Ma BN', 'MABN', 'patient_code']);
      if (code && !next['Mã BN']) next['Mã BN'] = code;
      const name = firstNonEmpty(next, ['Họ tên', 'Ho ten', 'patient_name']);
      if (name && !next['Họ tên']) next['Họ tên'] = name;
      const researchCode = firstNonEmpty(next, ['Mã NC', 'Ma NC', 'research_code']) || `NC${String(idx + 1).padStart(4, '0')}`;
      if (!next['Mã NC']) next['Mã NC'] = researchCode;
      if (!next['Ngày vào viện'] && next.admission_date) next['Ngày vào viện'] = next.admission_date;
      if (!next['Ngày ra viện'] && next.discharge_date) next['Ngày ra viện'] = next.discharge_date;
      if (!next['Chẩn đoán'] && next.diagnosis_raw) next['Chẩn đoán'] = next.diagnosis_raw;
      if (!next['Tuổi'] && next.age) next['Tuổi'] = next.age;
      if (!next['Giới'] && next.sex) next['Giới'] = next.sex;
      return next;
    });
    const colSet = new Set(['Mã NC', 'Mã BN', 'Họ tên', 'Giới', 'Tuổi', 'Ngày vào viện', 'Ngày ra viện', 'Chẩn đoán']);
    for (const row of normalizedRows) Object.keys(row).forEach(k => colSet.add(k));
    const cols = Array.from(colSet);
    const escape = v => { const s = String(v ?? ''); return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = '\ufeff' + cols.map(escape).join(',') + '\n'
      + normalizedRows.map(r => cols.map(c => escape(r[c] ?? '')).join(',')).join('\n');
    writeFileAtomic(cohortPath(study.id), csv.replace(/^\ufeff/, ''), 'utf-8');
    updateStudy(study.id, {
      cohort_filename: 'cohort.csv',
      cohort_uploaded_at: nowIso(),
      cohort_source: 'filtered',
      cohort_count: rows.length,
    });
    return res.json({ status: 'ok', study: readStudy(study.id), count: rows.length });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute('post', '/research/studies/:studyId/import-from-archive', 'Nhập từ kho gốc', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const result = importArchiveToStudy(study, {
      admitFrom: String(req.body?.admitFrom || ''),
      admitTo: String(req.body?.admitTo || ''),
      dischargeFrom: String(req.body?.dischargeFrom || ''),
      dischargeTo: String(req.body?.dischargeTo || ''),
    });
    return res.json({ status: 'ok', message: `Đã tạo danh sách ${result.count} Mã BN từ kho gốc. Bấm Lấy thêm dữ liệu EMR để quét dữ liệu riêng cho nghiên cứu.`, ...result });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/studies/:studyId/data', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const tableKey = TABLES[req.query.table] ? String(req.query.table) : 'patients';
    const runId = resolveRunId(study.id, String(req.query.runId || 'latest'));
    const filePath = tablePathFor(study.id, tableKey, runId || 'latest');
    const data = filePath ? readCsvTable(filePath, MAX_TABLE_ROWS) : { columns: [], rows: [], count: 0, limited: false, exists: false };
    const displayRows = sortRowsForTable(tableKey, data.rows);
    const redact = researchResponseShouldRedact(req);
    const output = redact ? redactCsvTable(data.columns, displayRows, EXPORT_SENSITIVE_COLUMNS) : { columns: data.columns, rows: displayRows, removed_columns: [] };
    return res.json({
      status: 'ok',
      study,
      table: { key: tableKey, ...TABLES[tableKey] },
      run_id: runId || '',
      columns: output.columns,
      rows: output.rows,
      redacted: redact,
      removed_columns: output.removed_columns,
      count: data.count,
      limited: data.limited,
      exists: data.exists,
      max_rows: MAX_TABLE_ROWS,
    });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/studies/:studyId/export', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const tableKey = TABLES[req.query.table] ? String(req.query.table) : 'analysis_ready';
    const runId = resolveRunId(study.id, String(req.query.runId || 'latest'));
    const filePath = tablePathFor(study.id, tableKey, runId || 'latest');
    return sendCsvFile(res, filePath, `${study.id}_${runId || 'latest'}_${tableKey}`, { redact: researchResponseShouldRedact(req) });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/studies/:studyId/coverage', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const runId = resolveRunId(study.id, String(req.query.runId || 'latest'));
    const runDir = runId ? path.join(runsDir(study.id), runId) : '';
    return res.json({ status: 'ok', coverage: buildCoverageSummary(runDir) });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/studies/:studyId/progress', (req, res) => {
  try {
    const runId = resolveStudyRunIdFast(req.params.studyId, String(req.query.runId || 'latest'));
    const study = readStudyProgressMeta(req.params.studyId, runId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const runDir = runId ? path.join(runsDir(study.id), runId) : '';
    const progress = buildResearchProgressSnapshot(runDir, study, { isArchive: false });
    return res.json({ status: 'ok', run_id: runId || '', progress });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute('post', '/research/studies/:studyId/finalize-dataset', 'Tạo dataset cuối', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const runId = resolveRunId(study.id, String(req.query.runId || 'latest'));
    if (!runId) return res.status(400).json({ status: 'error', message: 'Nghiên cứu chưa có run.' });
    const result = finalizeAnalysisDataset(path.join(runsDir(study.id), runId));
    const updated = updateStudy(study.id, { last_finalized_at: nowIso() });
    return res.json({ status: 'ok', message: `Đã tạo analysis_final.csv (${result.count} dòng).`, study: updated, ...result });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err), coverage: err.coverage || undefined });
  }
});

lockedResearchRoute('post', '/research/studies/:studyId/build-encoded-dataset', 'Tạo dataset mã hóa', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const runId = resolveRunId(study.id, String(req.query.runId || 'latest'));
    if (!runId) return res.status(400).json({ status: 'error', message: 'Nghiên cứu chưa có run.' });
    const result = buildEncodedDataset(path.join(runsDir(study.id), runId));
    const updated = updateStudy(study.id, { last_encoded_at: nowIso() });
    return res.json({ status: 'ok', message: `Đã tạo/cập nhật dữ liệu encoded cho ${runId}.`, study: updated, ...result });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute('post', '/research/studies/:studyId/clean-generated', 'Dọn dữ liệu sinh ra', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const runId = resolveRunId(study.id, String(req.query.runId || 'latest'));
    if (!runId) return res.status(400).json({ status: 'error', message: 'Nghiên cứu chưa có run.' });
    const result = cleanResearchGenerated(path.join(runsDir(study.id), runId), {
      encoded: req.body?.encoded !== false,
      debug: req.body?.debug !== false,
      derived: req.body?.derived === true,
    });
    const updated = updateStudy(study.id, { last_cleaned_at: nowIso() });
    return res.json({ status: 'ok', message: `Đã dọn file phụ cho ${runId}.`, study: updated, run_id: runId, ...result });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute('post', '/research/studies/:studyId/normalize', 'Chuẩn hóa', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const result = normalizeStudyLatest(study.id);
    const updated = result.counts?.cached ? study : updateStudy(study.id, { last_normalized_at: nowIso() });
    return res.json({ status: 'ok', message: result.counts?.cached ? 'Dữ liệu nghiên cứu đã chuẩn hóa sẵn, không cần chạy lại.' : `Đã chuẩn hóa dữ liệu nghiên cứu.${khoOverlayNote(result.counts)}`, study: updated, ...result });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute('post', '/research/studies/:studyId/fetch-hchanh', 'Lấy dữ liệu hành chánh', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    if (!fs.existsSync(cohortPath(study.id))) return res.status(400).json({ status: 'error', message: 'Chưa có danh sách bệnh nhân cho nghiên cứu này.' });

    const runId = resolveStudyRunIdForAction(study.id, req.body?.runId || 'latest');
    const runDir = path.join(runsDir(study.id), runId);
    ensureDir(runDir);

    // Nếu nghiên cứu riêng chưa có run XN/CĐHA, dùng cohort làm nguồn nền cho run hành chánh.
    const initialPath = path.join(runDir, 'du_lieu_ban_dau.csv');
    const samplePath = path.join(runDir, 'mau_nghien_cuu.csv');
    if (!fs.existsSync(initialPath)) fs.copyFileSync(cohortPath(study.id), initialPath);
    if (!fs.existsSync(samplePath)) fs.copyFileSync(cohortPath(study.id), samplePath);
    const manifestPath = path.join(runDir, 'manifest.json');
    const manifest = readJsonSafe(manifestPath, {}) || {};
    const archiveSourceManifest = study.cohort_source_run_id
      ? readJsonSafe(path.join(archiveRunsDir(), safeFilePart(study.cohort_source_run_id), 'manifest.json'), {}) || {}
      : {};
    const dateDefaults = {
      from_date: String(req.body?.fromDate || manifest.from_date || archiveSourceManifest.from_date || '').trim(),
      to_date: String(req.body?.toDate || manifest.to_date || archiveSourceManifest.to_date || '').trim(),
    };
    writeJsonAtomic(manifestPath, {
      created_at: manifest.created_at || nowIso(),
      updated_at: nowIso(),
      source: manifest.source || 'study_hchanh_auto',
      source_run_id: manifest.source_run_id || study.cohort_source_run_id || '',
      from_date: manifest.from_date || dateDefaults.from_date || '',
      to_date: manifest.to_date || dateDefaults.to_date || '',
      patients_count: manifest.patients_count || countCsvRows(cohortPath(study.id)),
      ...manifest,
    });

    const sourceInfo = readResearchHchanhSourceRows(runDir, cohortPath(study.id), { sourceRunId: runId, dateDefaults });
    const { rows, file, base_file: baseFile, date_context: dateContext } = sourceInfo;
    if (!rows.length) return res.status(400).json({ status: 'error', message: `Không tìm thấy danh sách Mã BN để lấy hành chánh tự động trong run ${runId}. Hãy kiểm tra đã có du_lieu_ban_dau.csv/cohort.csv hoặc bấm Bước 1 trước.` });
    const files = hchanhDefaultFiles(req.body?.files);
    const limit = Number.isFinite(Number(req.body?.limit)) ? Math.max(0, Math.trunc(Number(req.body.limit))) : 0;

    await enqueueHeavy(ctx.sid, async () => {
      const fetched = await fetchHchanhForResearchRun(ctx, runDir, {
        sourceRows: rows,
        sourceRunId: runId,
        files,
        headless: researchHeadlessFromBody(req.body),
        force: req.body?.force === true,
        refreshProvisional: req.body?.refreshProvisional === true,
        fallbackDateFrom: dateContext?.from_date || String(req.body?.fromDate || ''),
        fallbackDateTo: dateContext?.to_date || String(req.body?.toDate || ''),
        limit,
        mode: 'hchanh_auto',
      });
      const normalized = normalizeRunOutputs(runDir, { sourceRunId: runId });
      const updated = updateStudy(study.id, {
        last_run_id: runId,
        last_run_at: nowIso(),
        last_normalized_at: nowIso(),
        last_hchanh_auto_at: nowIso(),
      });
      return res.json({
        status: 'ok',
        message: `Đã tự động lấy hành chánh từ EMR cho nghiên cứu: xử lý=${fetched.processed}, bỏ qua=${fetched.skipped}, OK=${fetched.ok}, cần xem=${fetched.attention}, lỗi=${fetched.error}.`,
        study: updated,
        run_id: runId,
        source_file: path.basename(file || ''),
        source_base_file: path.basename(baseFile || ''),
        source_date_from: dateContext?.from_date || '',
        source_date_to: dateContext?.to_date || '',
        fetched,
        normalized,
      });
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute('post', '/research/studies/:studyId/fetch-order-history', 'Lấy lịch sử y lệnh', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    if (!fs.existsSync(cohortPath(study.id))) return res.status(400).json({ status: 'error', message: 'Chưa có danh sách bệnh nhân cho nghiên cứu này.' });

    const runId = resolveStudyRunIdForAction(study.id, req.body?.runId || 'latest');
    const runDir = path.join(runsDir(study.id), runId);
    ensureDir(runDir);

    const initialPath = path.join(runDir, 'du_lieu_ban_dau.csv');
    const samplePath = path.join(runDir, 'mau_nghien_cuu.csv');
    if (!fs.existsSync(initialPath)) fs.copyFileSync(cohortPath(study.id), initialPath);
    if (!fs.existsSync(samplePath)) fs.copyFileSync(cohortPath(study.id), samplePath);
    const manifestPath = path.join(runDir, 'manifest.json');
    const manifest = readJsonSafe(manifestPath, {}) || {};
    const archiveSourceManifest = study.cohort_source_run_id
      ? readJsonSafe(path.join(archiveRunsDir(), safeFilePart(study.cohort_source_run_id), 'manifest.json'), {}) || {}
      : {};
    const dateDefaults = {
      from_date: String(req.body?.fromDate || manifest.from_date || archiveSourceManifest.from_date || '').trim(),
      to_date: String(req.body?.toDate || manifest.to_date || archiveSourceManifest.to_date || '').trim(),
    };
    writeJsonAtomic(manifestPath, {
      created_at: manifest.created_at || nowIso(),
      updated_at: nowIso(),
      source: manifest.source || 'study_order_history_auto',
      source_run_id: manifest.source_run_id || study.cohort_source_run_id || '',
      from_date: manifest.from_date || dateDefaults.from_date || '',
      to_date: manifest.to_date || dateDefaults.to_date || '',
      patients_count: manifest.patients_count || countCsvRows(cohortPath(study.id)),
      ...manifest,
    });

    const sourceInfo = readResearchHchanhSourceRows(runDir, cohortPath(study.id), { sourceRunId: runId, dateDefaults });
    const { rows, file, base_file: baseFile, date_context: dateContext } = sourceInfo;
    if (!rows.length) return res.status(400).json({ status: 'error', message: `Không tìm thấy danh sách Mã BN để lấy lịch sử y lệnh trong run ${runId}. Hãy kiểm tra đã có du_lieu_ban_dau.csv/cohort.csv hoặc bấm Bước 1 trước.` });

    const files = orderHistoryDefaultFiles(req.body?.files);
    const limit = Number.isFinite(Number(req.body?.limit)) ? Math.max(0, Math.trunc(Number(req.body.limit))) : 0;

    await enqueueHeavy(ctx.sid, async () => {
      const fetched = await fetchHchanhForResearchRun(ctx, runDir, {
        sourceRows: rows,
        sourceRunId: runId,
        files,
        headless: researchHeadlessFromBody(req.body),
        force: req.body?.force === true,
        refreshProvisional: req.body?.refreshProvisional === true,
        fallbackDateFrom: dateContext?.from_date || String(req.body?.fromDate || ''),
        fallbackDateTo: dateContext?.to_date || String(req.body?.toDate || ''),
        limit,
        mode: 'order_history_auto',
      });
      const normalized = normalizeRunOutputs(runDir, { sourceRunId: runId });
      const updated = updateStudy(study.id, {
        last_run_id: runId,
        last_run_at: nowIso(),
        last_normalized_at: nowIso(),
        last_order_history_auto_at: nowIso(),
      });
      return res.json({
        status: 'ok',
        message: `Đã tự động lấy ${orderHistoryRunLabel(files)} từ EMR cho nghiên cứu: xử lý=${fetched.processed}, bỏ qua=${fetched.skipped}, OK=${fetched.ok}, cần xem=${fetched.attention}, lỗi=${fetched.error}.`,
        study: updated,
        run_id: runId,
        source_file: path.basename(file || ''),
        source_base_file: path.basename(baseFile || ''),
        source_date_from: dateContext?.from_date || '',
        source_date_to: dateContext?.to_date || '',
        fetched,
        normalized,
      });
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute('post', '/research/studies/:studyId/patient-info', 'Lấy thông tin người bệnh', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    if (!fs.existsSync(cohortPath(study.id))) return res.status(400).json({ status: 'error', message: 'Chưa có danh sách bệnh nhân cho nghiên cứu này.' });
    if (!fs.existsSync(SCRIPT_PATH)) return res.status(500).json({ status: 'error', message: 'Thiếu script lấy dữ liệu nghiên cứu.' });
    const runId = resolveStudyRunIdForAction(study.id, req.body?.runId || 'latest');
    const runDir = path.join(runsDir(study.id), runId);
    ensureDir(runDir);
    const initialPath = path.join(runDir, 'du_lieu_ban_dau.csv');
    const samplePath = path.join(runDir, 'mau_nghien_cuu.csv');
    if (!fs.existsSync(initialPath)) fs.copyFileSync(cohortPath(study.id), initialPath);
    if (!fs.existsSync(samplePath)) fs.copyFileSync(cohortPath(study.id), samplePath);
    const archiveSourceManifest = study.cohort_source_run_id
      ? readJsonSafe(path.join(archiveRunsDir(), safeFilePart(study.cohort_source_run_id), 'manifest.json'), {}) || {}
      : {};
    const sourceInfo = readResearchHchanhSourceRows(runDir, cohortPath(study.id), {
      sourceRunId: runId,
      dateDefaults: { from_date: archiveSourceManifest.from_date || '', to_date: archiveSourceManifest.to_date || '' },
    });
    const inputPath = sourceInfo.file || cohortPath(study.id);
    const args = [
      '-u', SCRIPT_PATH,
      '--input', inputPath,
      '--project-id', study.id,
      '--run-id', runId,
      '--out-root', RESEARCH_STORE_DIR,
      '--patient-info-only',
    ];
    if (researchHeadlessFromBody(req.body)) args.push('--headless');

    await enqueueHeavy(ctx.sid, async () => {
      let result;
      try {
        result = await runPython(args, {
          cwd: ROOT_DIR,
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
          extraEnv: { RESEARCH_INPUT_NAME: path.basename(inputPath) },
        });
      } finally {
        unregisterCancel(ctx.sid);
      }

      if (result.spawnError) return res.status(500).json({ status: 'error', message: `Không khởi động được Python: ${result.spawnError}` });
      if (result.killedByTimeout) return res.status(504).json({ status: 'error', message: 'Timeout khi lấy thông tin khác. Dữ liệu đã lưu từng mã BN, bấm lại để chạy tiếp.' });
      if (isStoppedRunResult(result)) {
        const normalized = normalizeRunOutputs(path.join(runsDir(study.id), runId), { sourceRunId: runId });
        const updated = updateStudy(study.id, { last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso(), stopped_at: nowIso() });
        return res.json({ status: 'ok', stopped: true, message: 'Đã dừng. Thông tin khác đã lấy vẫn được giữ; bấm lại để chạy tiếp.', study: updated, run_id: runId, normalized });
      }
      if (result.code !== 0) return res.status(500).json({ status: 'error', message: fmtPyError('Python lỗi khi lấy thông tin khác từ D/s Bệnh nhân. Dữ liệu đã lưu nếu chạy được một phần.', result) });

      const normalized = normalizeRunOutputs(path.join(runsDir(study.id), runId), { sourceRunId: runId });
      const updated = updateStudy(study.id, { last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso() });
      return res.json({ status: 'ok', message: 'Đã lấy thông tin khác: Điện thoại, Số CMND/CCCD, BHYT, địa chỉ từ D/s Bệnh nhân.', study: updated, run_id: runId, normalized });
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

lockedResearchRoute('post', '/research/studies/:studyId/run', 'Lấy dữ liệu', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    if (!fs.existsSync(cohortPath(study.id))) return res.status(400).json({ status: 'error', message: 'Chưa có danh sách bệnh nhân cho nghiên cứu này.' });
    if (!fs.existsSync(SCRIPT_PATH)) return res.status(500).json({ status: 'error', message: 'Thiếu script lấy dữ liệu nghiên cứu.' });

    const runId = safeRunId(req.body?.runId || (req.body?.resume === false ? nowFileStamp() : chooseStudyRunIdForResume(study.id))) || nowFileStamp();
    const args = [
      '-u', SCRIPT_PATH,
      '--input', cohortPath(study.id),
      '--project-id', study.id,
      '--run-id', runId,
      '--out-root', RESEARCH_STORE_DIR,
    ];
    if (req.body?.fromDate) args.push('--from-date', String(req.body.fromDate));
    if (req.body?.toDate) args.push('--to-date', String(req.body.toDate));
    if (researchHeadlessFromBody(req.body)) args.push('--headless');
    const archiveInitialListPath = study.cohort_source === 'archive' && study.cohort_source_run_id
      ? archiveTablePath('initial_list', study.cohort_source_run_id)
      : '';
    if (archiveInitialListPath && fs.existsSync(archiveInitialListPath)) {
      args.push('--archive-initial-list', archiveInitialListPath);
    }

    updateStudy(study.id, { active_run_id: runId, active_mode: 'deep' });

    await enqueueHeavy(ctx.sid, async () => {
      try {
      let result;
      try {
        result = await runPython(args, {
          cwd: ROOT_DIR,
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
          extraEnv: { RESEARCH_INPUT_NAME: path.basename(cohortPath(study.id)) },
        });
      } finally {
        unregisterCancel(ctx.sid);
      }

      if (result.spawnError) return res.status(500).json({ status: 'error', message: `Không khởi động được Python: ${result.spawnError}` });
      if (result.killedByTimeout) return res.status(504).json({ status: 'error', message: 'Timeout khi lấy dữ liệu nghiên cứu. Tiến độ đã lưu, bấm Lấy thêm/tiếp tục để chạy tiếp từ ca chưa xong.' });
      if (isStoppedRunResult(result)) {
        const normalized = normalizeRunOutputs(path.join(runsDir(study.id), runId), { sourceRunId: runId });
        const updated = updateStudy(study.id, { last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso(), stopped_at: nowIso() });
        return res.json({ status: 'ok', stopped: true, message: 'Đã dừng. Các ca đã đủ dữ liệu đã lưu; ca đang dở sẽ được lấy lại khi bấm Lấy thêm/tiếp tục.', study: updated, run_id: runId, normalized });
      }
      if (result.code !== 0) return res.status(500).json({ status: 'error', message: fmtPyError('Python lỗi khi lấy dữ liệu nghiên cứu. Tiến độ đã lưu nếu đã chạy được một phần.', result) });

      const normalized = normalizeRunOutputs(path.join(runsDir(study.id), runId), { sourceRunId: runId });
      const updated = updateStudy(study.id, { last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso(), active_run_id: '', active_mode: '' });
      return res.json({ status: 'ok', message: 'Đã lấy và chuẩn hóa dữ liệu nghiên cứu.', study: updated, run_id: runId, normalized });
      } finally {
        updateStudy(study.id, { active_run_id: '', active_mode: '' });
      }
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

module.exports = router;
// Chỉ dùng cho kiểm thử (scripts/research_hchanh_same_stay_reuse_test.js, scripts/research_data_safety_test.js).
module.exports._fetchHchanhForResearchRun = fetchHchanhForResearchRun;
// Danh sách cột chuẩn hóa, dùng để đối chiếu từ điển dữ liệu (server/research/data_dictionary.js).
module.exports.NORMALIZED_COLUMNS = NORMALIZED_COLUMNS;
module.exports.ingestAllResearchResultsToPatientDb = ingestAllResearchResultsToPatientDb;
module.exports._test = { buildEncodedDataset, buildPatientHistory, sendCsvFile, RESEARCH_SCOPE_LOCKS, researchScopeKey, readCsvTable, buildResearchProgressSnapshot, safeRunId, overlayHchanhFromPatientDb, overlayResultsFromPatientDb, buildResultDayIndex, resultDayIndexHasRange, addRowsToResultDayIndex, ingestAllResearchResultsToPatientDb, researchHchanhMeta, normalizeInputSignature, identifiedAccessStatus, normalizeResearchSourceRows, ensureResearchSourceRows, combineEncounterSources, buildContextMap, contextForRow, encounterMatchStatus, encounterMatchMethod, summarizeVariableColumns, VARIABLE_CATALOG_MAX_ROWS, normalizeRunOutputs, buildCoverageSummary, listDatasetSnapshots, writeDatasetSnapshot, verifyDatasetSnapshot, verifyAllDatasetSnapshots, cleanupStaleDatasetStaging, finalizeAnalysisDataset, runCollectionOrchestration, readCollectionPartRows, recoverCollectionTransactions, recoverPythonPatientCommits, appendCollectionVersions, readCollectionVersionIds, syncCollectionLedger, studyReadinessForRun, hchanhFileStatusPatch, hchanhEntryFileStatus };
