'use strict';

// Danh sách run của kho gốc/nghiên cứu, metadata kho và nghiên cứu, chọn run hiện hành, kiểm tra CSV nguồn.

const { parseDateTimeCell, getCell, patientCode, parseDateCell, countCsvRows, readCsvTable, parseCsv, writeCsv } = require('./table_io');
const fs = require('fs');
const path = require('path');
const { readJsonSafe, writeJsonAtomic, safeFilePart, nowFileStamp } = require('../utils/file');
const { TABLES, archiveRunsDir, runsDir, ensureArchiveStore, archiveMetaPath, archiveSourcePath, ARCHIVE_ID, ARCHIVE_LABEL, cleanStudyId, studyDir, studyMetaPath, cohortPath, ensureResearchStore, nowIso, todayDateInput, dateOnlyMs, MAX_CSV_BYTES, normalizedKey } = require('./store_paths');
const { RESEARCH_STORE_DIR } = require('../constants');
const collection = require('./collection');

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
  if (table.root === 'study') return tableKey === 'cohort' || !TABLES[tableKey] ? cohortPath(studyId) : path.join(studyDir(studyId), table.file);
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

module.exports = {
  sortRowsForTable,
  parseDateFilter,
  rowPassesDateFilter,
  listRunsForDir,
  latestRunIdFast,
  resolveArchiveRunIdFast,
  resolveStudyRunIdFast,
  readArchiveProgressMeta,
  readStudyProgressMeta,
  listRuns,
  readStudy,
  listStudies,
  updateStudy,
  resolveRunId,
  tablePathFor,
  listArchiveRuns,
  readArchive,
  updateArchive,
  safeRunId,
  resolveArchiveRunId,
  resolveArchiveRunIdForAction,
  resolveStudyRunIdForAction,
  archiveTablePath,
  chooseArchiveRunIdForResume,
  chooseStudyRunIdForResume,
  isStoppedRunResult,
  validatePatientCsv,
  copyRowsByPatients,
};
