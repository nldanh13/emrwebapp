'use strict';

// Trạng thái tác vụ nghiên cứu, tiến độ từng lượt (XN/CĐHA/hành chánh) và độ phủ dữ liệu của một run.

const { readJsonSafe, ensureDir, writeJsonAtomic } = require('../utils/file');
const path = require('path');
const { TABLES, nowIso, cohortPath } = require('./store_paths');
const fs = require('fs');
const { countCsvRows, readCsvTable, getCell, patientCode } = require('./table_io');
const crypto = require('crypto');
const collection = require('./collection');
const { normalizedIdentity, firstNonEmpty } = require('./encounter_context');
const { readCurrentCaseTrace, readCurrentHchanhCase } = require('./case_trace');
const quality = require('./quality');

function tableCountsForRunDir(runDir) {
  const manifest = readJsonSafe(path.join(runDir, 'manifest.json'), {}) || {};
  const saved = { ...(manifest.outputs || {}), ...(manifest.normalized_outputs || {}) };
  const counts = {};
  for (const [key, meta] of Object.entries(TABLES)) {
    if (meta.root !== 'run') continue;
    const filePath = path.join(runDir, meta.file);
    // Số trên dashboard phải phản ánh snapshot đang nằm trên đĩa, không ưu tiên
    // metadata cũ. countCsvRows đã cache theo mtime nên việc đếm lại này không
    // buộc parse toàn bộ CSV ở mỗi lần refresh.
    if (fs.existsSync(filePath)) counts[key] = countCsvRows(filePath);
    else if (saved[key] != null && Number.isFinite(Number(saved[key]))) counts[key] = Number(saved[key]);
    else counts[key] = 0;
  }
  return counts;
}

function computeExtractCoverage(runDir) {
  const statusPath = path.join(runDir, 'extract_status.csv');
  const table = readCsvTable(statusPath, Number.MAX_SAFE_INTEGER);
  const rows = table.rows || [];
  const total = rows.length;
  const byOverall = { done: 0, pending: 0, error: 0, other: 0 };
  const byCompletion = {};
  const fileDone = { xn_cdha: 0, profile: 0, discharge: 0, surgery: 0, order_history: 0 };
  let ready = 0;
  let manualReview = 0;
  for (const row of rows) {
    const overall = String(row.overall_status || '').trim() || 'other';
    if (byOverall[overall] == null) byOverall.other += 1; else byOverall[overall] += 1;
    const level = String(row.completion_level || '').trim() || 'unknown';
    byCompletion[level] = (byCompletion[level] || 0) + 1;
    if (row.popup_status === 'done' && row.xn_status === 'done' && row.cdha_status === 'done') fileDone.xn_cdha += 1;
    if (row.profile_status === 'done') fileDone.profile += 1;
    if (row.discharge_status === 'done') fileDone.discharge += 1;
    if (row.surgery_status === 'done') fileDone.surgery += 1;
    if (row.order_history_status === 'done') fileDone.order_history += 1;
    if (String(row.ready_for_analysis || '') === '1') ready += 1;
  }
  const ar = readCsvTable(path.join(runDir, 'analysis_ready.csv'), Number.MAX_SAFE_INTEGER);
  for (const row of ar.rows || []) {
    if (String(row.needs_manual_review || '').trim()) manualReview += 1;
  }
  return { total, ready, manual_review: manualReview, by_overall: byOverall, by_completion: byCompletion, file_done: fileDone };
}

const RESEARCH_PROGRESS_PARTS = [
  { key: 'xn_cdha', label: 'XN & CĐHA', fields: ['popup_status', 'xn_status', 'cdha_status'] },
  { key: 'profile', label: 'Hồ sơ nền', fields: ['profile_status'] },
  { key: 'discharge', label: 'Ra viện', fields: ['discharge_status'] },
  { key: 'surgery', label: 'Phẫu thuật', fields: ['surgery_status'] },
  { key: 'order_history', label: 'Y lệnh', fields: ['order_history_status'] },
];

const RESEARCH_TASK_STATE_FILE = 'research_task_state.json';

const RESEARCH_TASK_ACTIVE_STATUSES = new Set(['queued', 'running']);

// Dùng để phân biệt task thật sự thuộc process Node hiện tại với trạng thái `running`
// bị lưu sót trên đĩa sau khi server bị restart/đóng ngang.
const RESEARCH_PROCESS_INSTANCE_ID = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;

function researchTaskStatePath(runDir) {
  return path.join(runDir, RESEARCH_TASK_STATE_FILE);
}

function readResearchTaskState(runDir) {
  const state = readJsonSafe(researchTaskStatePath(runDir), {}) || {};
  return state && typeof state === 'object' && !Array.isArray(state)
    ? { current: state.current || null, history: Array.isArray(state.history) ? state.history : [] }
    : { current: null, history: [] };
}

function writeResearchTaskState(runDir, state) {
  if (!runDir) return;
  ensureDir(runDir);
  const history = Array.isArray(state?.history) ? state.history.slice(-30) : [];
  writeJsonAtomic(researchTaskStatePath(runDir), { current: state?.current || null, history });
}

function beginResearchTask(runDir, info = {}) {
  const state = readResearchTaskState(runDir);
  const task = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: String(info.type || 'research_task'),
    label: String(info.label || 'Tác vụ nghiên cứu'),
    status: String(info.status || 'queued'),
    scope: String(info.scope || ''),
    run_id: String(info.run_id || path.basename(runDir || '')),
    missing_types: Array.isArray(info.missing_types) ? info.missing_types : [],
    summary: info.summary || {},
    message: String(info.message || 'Đã xếp hàng chờ chạy.'),
    started_at: nowIso(),
    heartbeat_at: nowIso(),
    process_instance_id: RESEARCH_PROCESS_INSTANCE_ID,
  };
  const history = state.current ? [...state.history, state.current] : state.history;
  writeResearchTaskState(runDir, { current: task, history });
  return task;
}

function updateResearchTask(runDir, taskId, patch = {}) {
  const state = readResearchTaskState(runDir);
  const current = state.current || {};
  if (!current.id || (taskId && current.id !== taskId)) return current;
  const next = { ...current, ...patch, heartbeat_at: nowIso() };
  writeResearchTaskState(runDir, { current: next, history: state.history });
  return next;
}

function finishResearchTask(runDir, taskId, status, patch = {}) {
  const state = readResearchTaskState(runDir);
  const current = state.current || {};
  if (!current.id || (taskId && current.id !== taskId)) return current;
  const finished = { ...current, ...patch, status: String(status || 'done'), finished_at: nowIso(), heartbeat_at: nowIso() };
  writeResearchTaskState(runDir, { current: null, history: [...state.history, finished] });
  return finished;
}

function activeResearchTask(runDir) {
  const state = readResearchTaskState(runDir);
  const cur = state.current;
  if (!cur || typeof cur !== 'object') return null;
  const status = String(cur.status || '').toLowerCase();
  if (!RESEARCH_TASK_ACTIVE_STATUSES.has(status)) return null;

  const instanceId = String(cur.process_instance_id || '').trim();
  const taskFromAnotherProcess = instanceId !== RESEARCH_PROCESS_INSTANCE_ID;

  // `research_task_state.json` là file bền vững. Nếu Node bị restart giữa chừng,
  // task cũ không thể còn chạy nhưng trước đây state vẫn là running tới 8 giờ,
  // khiến frontend khóa nút Lấy dữ liệu/Cập nhật. Task không có instance id cũng
  // là state từ phiên bản cũ, nên phải giải phóng ngay sau khi nâng cấp/restart.
  if (taskFromAnotherProcess) {
    finishResearchTask(runDir, cur.id, 'interrupted', {
      message: 'Tác vụ trước đã dừng khi server khởi động lại. Có thể bấm Lấy dữ liệu/Cập nhật để tiếp tục phần còn thiếu.',
      interrupted_reason: 'server_restarted',
    });
    return null;
  }

  return cur;
}

function researchStatusDone(value) {
  const s = String(value || '').trim().toLowerCase();
  // empty = đã lấy xong và EMR xác nhận không có dữ liệu (khác "chưa lấy được").
  return s === 'done' || s === 'ok' || s === 'empty' || s === 'success' || s === '1' || s === 'true';
}

function progressCodeFromKey(key, value = {}) {
  return String(
    value['Mã BN'] || value.ma_bn || value.patient_code || String(key || '').split('|')[0] || ''
  ).replace(/^day:[^|]*\|page:[^|]*\|row:/, '').trim();
}

function progressResearchCode(value = {}) {
  return String(value['Mã NC'] || value.research_code || value.ma_nc || '').trim();
}

function progressPatientName(value = {}) {
  return String(value['Họ tên'] || value.ho_ten || value.patient_name || value.ten_bn || '').trim();
}

function progressUpdatedAt(value = {}) {
  return String(value.finished_at || value.updated_at || value.started_at || '').trim();
}

function readProgressMapSafe(filePath) {
  const raw = readJsonSafe(filePath, {}) || {};
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function buildProgressSeedRows(runDir, scopeMeta = {}, isArchive = true) {
  const candidates = [
    ['extract_status', path.join(runDir, 'extract_status.csv')],
    ['research_source', path.join(runDir, 'research_source.csv')],
    ['initial_list', path.join(runDir, 'du_lieu_ban_dau.csv')],
    ['patients', path.join(runDir, 'mau_nghien_cuu.csv')],
  ];
  if (!isArchive && scopeMeta?.id) candidates.push(['cohort', cohortPath(scopeMeta.id)]);
  for (const [, fp] of candidates) {
    if (!fp || !fs.existsSync(fp)) continue;
    const table = readCsvTable(fp, 50000);
    if (table.rows?.length) return table.rows;
  }
  return [];
}

function pickProgressValue(row, names) {
  return getCell(row, names);
}

// Trạng thái một file hành chánh của một ca theo trạng thái riêng từng file (bản mới);
// progress cũ chưa có file_status thì dùng trạng thái chung của ca như trước.
function hchanhEntryFileStatus(entry, fileKey) {
  if (!entry || typeof entry !== 'object') return '';
  if (entry.file_status?.[fileKey]) {
    const res = collection.classifyHchanhFile(entry, fileKey);
    if (res.status === 'ok') return 'done';
    if (res.status === 'empty') return 'empty';
    if (res.status === 'blocked') return 'blocked';
    if (res.status === 'failed') return res.reason === 'partial' ? 'partial' : 'error';
    return '';
  }
  return String(entry.status || '').trim();
}

// Chỉ mục theo Mã NC / Mã BN cho mỗi file tiến độ: bảng theo dõi tra trạng thái cho mọi lượt
// (~3.000) mỗi vài giây; không quét lại toàn bộ file tiến độ cho từng lượt.
const progressIndexCache = new WeakMap();

function progressIndex(progressMap) {
  const key = progressMap || {};
  let idx = progressIndexCache.get(key);
  if (idx) return idx;
  idx = { byRc: new Map(), byCode: new Map() };
  for (const v of Object.values(key)) {
    if (!v || typeof v !== 'object' || !Array.isArray(v.files)) continue;
    const vRc = String(v.research_code || v.ma_nc || v['Mã NC'] || '').trim();
    const vCode = String(v.ma_bn || v.patient_code || v['Mã BN'] || '').trim();
    if (vRc) {
      if (!idx.byRc.has(vRc)) idx.byRc.set(vRc, []);
      idx.byRc.get(vRc).push(v);
    }
    if (vCode) {
      if (!idx.byCode.has(vCode)) idx.byCode.set(vCode, []);
      idx.byCode.get(vCode).push(v);
    }
  }
  progressIndexCache.set(key, idx);
  return idx;
}

function buildHchanhFileStatus(progressMap, code, researchCode, fileKey) {
  const idx = progressIndex(progressMap);
  const pool = [
    ...(researchCode ? idx.byRc.get(researchCode) || [] : []),
    ...(code ? idx.byCode.get(code) || [] : []),
  ];
  const seen = new Set();
  const candidates = pool.filter(v => {
    if (seen.has(v)) return false;
    seen.add(v);
    if (!v.files.includes(fileKey)) return false;
    const vCode = String(v.ma_bn || v.patient_code || v['Mã BN'] || '').trim();
    const vRc = String(v.research_code || v.ma_nc || v['Mã NC'] || '').trim();
    if (researchCode && vRc) return vRc === researchCode;  // lượt khác của cùng BN: không lấy
    return vCode && code && vCode === code;
  });
  if (!candidates.length) return '';
  candidates.sort((a, b) => String(progressUpdatedAt(b)).localeCompare(String(progressUpdatedAt(a))));
  return hchanhEntryFileStatus(candidates[0], fileKey);
}

function hchanhFileDone(progressMap, fileKey) {
  const seen = new Set();
  for (const v of Object.values(progressMap || {})) {
    if (!v || typeof v !== 'object') continue;
    const files = Array.isArray(v.files) ? v.files : [];
    if (!files.includes(fileKey)) continue;
    if (!researchStatusDone(hchanhEntryFileStatus(v, fileKey))) continue;
    const key = String(v.research_code || v.ma_nc || v.ma_bn || v.patient_code || '').trim();
    if (key) seen.add(key);
  }
  return seen.size;
}

function missingLabelsForProgressRow(row) {
  const labels = [];
  for (const part of RESEARCH_PROGRESS_PARTS) {
    const done = part.fields.every(f => researchStatusDone(row[f]));
    if (!done) labels.push(part.label);
  }
  return labels;
}

function researchStatusRunning(value) {
  const s = String(value || '').trim().toLowerCase();
  return ['running', 'processing', 'in_progress', 'working'].some(x => s.includes(x));
}

function researchStatusError(value) {
  const s = String(value || '').trim().toLowerCase();
  return ['error', 'failed', 'timeout', 'no_url', 'no_session', 'skipped_recent_failure', 'blocked'].some(x => s.includes(x));
}

function researchStatusLabel(value) {
  const s = String(value || '').trim();
  const l = s.toLowerCase();
  if (l === 'empty') return 'EMR không có';
  if (researchStatusDone(l)) return 'Đã lấy';
  if (researchStatusRunning(l)) return 'Đang lấy';
  if (l === 'blocked') return 'Cần xem';
  if (researchStatusError(l)) return 'Lỗi';
  if (l === 'partial' || l === 'incomplete' || l === 'running_partial') return 'Một phần';
  if (!s || ['pending', 'missing'].includes(l)) return 'Chưa lấy';
  return s;
}

function progressPartValue(row, part) {
  const values = part.fields.map(f => String(row?.[f] || '').trim()).filter(Boolean);
  if (!values.length) return '';
  if (values.every(v => researchStatusDone(v))) return 'done';
  if (values.some(v => researchStatusRunning(v))) return 'running';
  if (values.some(v => researchStatusError(v))) return values.find(v => researchStatusError(v)) || 'error';
  if (values.some(v => v.toLowerCase() === 'partial')) return 'partial';
  return values[0];
}

function progressMonitorRow(row) {
  const partValues = Object.fromEntries(RESEARCH_PROGRESS_PARTS.map(part => [part.key, progressPartValue(row, part)]));
  const partLabels = Object.fromEntries(RESEARCH_PROGRESS_PARTS.map(part => [part.key, researchStatusLabel(partValues[part.key])]));
  const hasRunning = Object.values(partValues).some(researchStatusRunning) || researchStatusRunning(row.overall_status);
  const hasError = Object.values(partValues).some(researchStatusError) || researchStatusError(row.overall_status) || Boolean(String(row.last_error || '').trim());
  const missing = Array.isArray(row.missing) ? row.missing : missingLabelsForProgressRow(row);
  // "Đủ dữ liệu" = đủ cả 5 phần. Không dùng overall_status: với dòng lấy từ
  // progress XN&CĐHA, status=done chỉ nghĩa là XN xong, nên trước đây ô "đủ"
  // đếm cả ca còn thiếu Hồ sơ nền/Ra viện/PT/Y lệnh.
  const ready = Boolean(row.ready || String(row.ready_for_analysis || '') === '1' || !missing.length);
  let state = 'waiting';
  let state_label = 'Chưa lấy đủ';
  if (ready) { state = 'done'; state_label = 'Đủ dữ liệu'; }
  else if (hasRunning) { state = 'running'; state_label = 'Đang lấy'; }
  else if (hasError) { state = 'error'; state_label = 'Lỗi/cần xem'; }
  else if (missing.length) { state = 'missing'; state_label = 'Còn thiếu'; }
  return {
    key: row.key,
    sample: row.research_code || row.patient_code || row.key,
    research_code: row.research_code || '',
    patient_code: row.patient_code || '',
    patient_name: row.patient_name || '',
    state,
    state_label,
    missing: missing.join(', '),
    xn_cdha: partLabels.xn_cdha,
    profile: partLabels.profile,
    discharge: partLabels.discharge,
    surgery: partLabels.surgery,
    order_history: partLabels.order_history,
    last_error: String(row.last_error || '').split('\n')[0].slice(0, 180),
    updated_at: row.updated_at || '',
  };
}

function monitorRowSortKey(row) {
  // Lượt cần người xử lý (lỗi) lên đầu, rồi lượt còn thiếu; lượt máy đang lấy và lượt đã đủ sau cùng.
  const order = { error: 0, missing: 1, waiting: 2, running: 3, done: 4 };
  return [order[row.state] ?? 9, String(row.updated_at || '')];
}

function progressPartStats(rows, part) {
  const out = { key: part.key, label: part.label, total: 0, done: 0, running: 0, error: 0, missing: 0, waiting: 0 };
  for (const row of rows || []) {
    out.total += 1;
    const value = progressPartValue(row, part);
    if (researchStatusDone(value)) out.done += 1;
    else if (researchStatusRunning(value)) out.running += 1;
    else if (researchStatusError(value)) out.error += 1;
    else if (String(value || '').trim()) out.missing += 1;
    else out.waiting += 1;
  }
  out.missing = Math.max(out.missing, Math.max(0, out.total - out.done - out.running - out.error - out.waiting));
  return out;
}

function isRowMissingXnCdha(row) {
  return !researchStatusDone(row?.xn_status) || !researchStatusDone(row?.cdha_status) || !researchStatusDone(row?.popup_status);
}

function progressMatchesCode(key, val, patientCodes, researchCodes) {
  const rawKey = String(key || '');
  const code = progressCodeFromKey(rawKey, val);
  const rc = progressResearchCode(val);
  if (code && patientCodes.has(code)) return true;
  if (rc && researchCodes.has(rc)) return true;
  for (const item of patientCodes) if (item && rawKey.includes(item)) return true;
  for (const item of researchCodes) if (item && rawKey.includes(item)) return true;
  return false;
}

function resetXnCdhaProgress(runDir, statusRows = []) {
  const patientCodes = new Set(statusRows.map(r => String(r.patient_code || r['Mã BN'] || '').trim()).filter(Boolean));
  const researchCodes = new Set(statusRows.map(rowResearchCode).filter(Boolean));
  const progressPath = path.join(runDir, 'progress.json');
  const progress = readJsonSafe(progressPath, {}) || {};
  let resetCount = 0;
  for (const [key, val] of Object.entries(progress)) {
    if (String(key).startsWith('__') || !val || typeof val !== 'object') continue;
    if (!progressMatchesCode(key, val, patientCodes, researchCodes)) continue;
    progress[key] = {
      ...val,
      popup: '',
      xn: '',
      cdha: '',
      status: 'pending_refetch',
      committed: false,
      reset_for_refetch: true,
      updated_at: nowIso(),
    };
    resetCount += 1;
  }
  if (resetCount) writeJsonAtomic(progressPath, progress);
  return { resetCount, patientCodes, researchCodes };
}

function sourceRowsForXnCdhaRefetch(runDir, fallbackPath, statusRows = [], sourceRunId = '', dateDefaults = {}) {
  const patientCodes = new Set(statusRows.map(r => String(r.patient_code || r['Mã BN'] || '').trim()).filter(Boolean));
  const researchCodes = new Set(statusRows.map(rowResearchCode).filter(Boolean));
  // Một số file nguồn (đặc biệt extract_status/research_source cũ) có Mã NC nhưng
  // thiếu Mã BN. Deep worker bắt buộc cần Mã BN để tìm trên EMR, nên khôi phục
  // Mã BN từ chính statusRows theo Mã NC trước khi dựng CSV refetch.
  const patientCodeByResearchCode = new Map();
  for (const statusRow of statusRows) {
    const rc = rowResearchCode(statusRow);
    const code = String(statusRow.patient_code || statusRow['Mã BN'] || '').trim();
    if (rc && code && !patientCodeByResearchCode.has(rc)) patientCodeByResearchCode.set(rc, code);
  }

  const allCandidates = [];
  const pushRows = (fp) => {
    if (!fp || !fs.existsSync(fp)) return;
    const table = readCsvTable(fp, Number.MAX_SAFE_INTEGER);
    for (const row of table.rows || []) allCandidates.push(row);
  };
  pushRows(path.join(runDir, 'research_source.csv'));
  pushRows(fallbackPath);
  pushRows(path.join(runDir, 'du_lieu_ban_dau.csv'));
  pushRows(path.join(runDir, 'mau_nghien_cuu.csv'));
  pushRows(path.join(runDir, 'du_lieu_goc.csv'));
  pushRows(path.join(runDir, 'extract_status.csv'));

  const picked = [];
  const seen = new Set();
  const coveredTargets = new Set();
  for (const sourceRow of allCandidates) {
    const rc = rowResearchCode(sourceRow);
    const originalCode = patientCode(sourceRow) || String(sourceRow.patient_code || '').trim();
    const code = originalCode || (rc ? (patientCodeByResearchCode.get(rc) || '') : '');
    // Không bao giờ đưa dòng không có Mã BN vào deep worker. Mã NC một mình
    // không đủ để tìm bệnh nhân trên D/s Điều trị nội trú.
    if (!code) continue;
    if (!patientCodes.has(code) && !researchCodes.has(rc)) continue;

    const row = originalCode ? sourceRow : {
      ...sourceRow,
      'Mã BN': code,
      patient_code: String(sourceRow.patient_code || code).trim(),
    };
    const key = `${rc || ''}|${code}|${getCell(row, ['Ngày vào viện','T/G vào','fetch_from_date'])}|${getCell(row, ['Ngày ra viện','T/G ra','fetch_to_date'])}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(row);
    coveredTargets.add(rc ? `rc:${rc}` : `bn:${code}`);
  }

  // Bổ sung từng target còn thiếu từ extract_status, không chỉ fallback khi picked rỗng.
  // Nhờ vậy một vài dòng nguồn lỗi/thiếu Mã BN không làm mất các ca refetch khác.
  for (const row of statusRows) {
    const code = String(row.patient_code || row['Mã BN'] || '').trim();
    if (!code) continue;
    const rc = rowResearchCode(row);
    const targetKey = rc ? `rc:${rc}` : `bn:${code}`;
    if (coveredTargets.has(targetKey)) continue;
    const fallbackRow = {
      'Mã NC': rc,
      'Mã BN': code,
      'Họ tên': String(row.patient_name || row['Họ tên'] || '').trim(),
      'Ngày vào viện': String(row.admission_date || row['Ngày vào viện'] || dateDefaults.from_date || '').trim(),
      'Ngày ra viện': String(row.discharge_date || row['Ngày ra viện'] || dateDefaults.to_date || '').trim(),
      'fetch_from_date': dateDefaults.from_date || '',
      'fetch_to_date': dateDefaults.to_date || '',
      'source_run_id': sourceRunId || '',
    };
    const key = `${rc || ''}|${code}|${fallbackRow['Ngày vào viện']}|${fallbackRow['Ngày ra viện']}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(fallbackRow);
    coveredTargets.add(targetKey);
  }
  return picked;
}

// Trạng thái tác vụ của run: đang chạy, đã dừng (lý do, lúc nào), lần chạy gần nhất kết thúc ra sao.
// Dùng chung cho bảng tiến độ cũ và mô hình màn hình (screen_model).
function taskStatusParts(runDir) {
  const activeTask = activeResearchTask(runDir);
  const taskState = readResearchTaskState(runDir);
  const lastFinishedTask = Array.isArray(taskState.history) && taskState.history.length
    ? taskState.history[taskState.history.length - 1]
    : null;
  const lastTaskStopped = ['cancelled', 'interrupted'].includes(String(lastFinishedTask?.status || '').toLowerCase());
  // Cảnh báo fatal của worker chỉ còn đúng nếu ghi sau khi lần chạy gần nhất bắt đầu; cảnh báo cũ
  // hơn là của lần chạy trước đó, không được báo mãi "đã dừng giữa chừng".
  const fatalPath = path.join(runDir, 'fatal_alert.json');
  let fatalAlert = readJsonSafe(fatalPath, null);
  let fatalAt = '';
  if (fatalAlert) {
    try { fatalAt = new Date(fs.statSync(fatalPath).mtimeMs).toISOString(); } catch (_) { fatalAt = ''; }
    const lastStart = Date.parse(lastFinishedTask?.started_at || '');
    // Dung sai 2 giây: hệ thống file có thể làm tròn mtime xuống theo giây.
    if (fatalAt && Number.isFinite(lastStart) && Date.parse(fatalAt) < lastStart - 2000) fatalAlert = null;
  }
  // Không hiển thị đồng thời “Đang chạy” và “đã dừng giữa chừng”. Ngoài fatal
  // của worker, cancellation/restart cũng được coi là trạng thái có thể resume.
  const stopped = !activeTask && (fatalAlert || lastTaskStopped) ? {
    ma_nc: String(fatalAlert?.ma_nc || '').trim(),
    ma_bn: String(fatalAlert?.ma_bn || '').trim(),
    ho_ten: String(fatalAlert?.ho_ten || '').trim(),
    hint: 'Tác vụ đã dừng giữa chừng. Bấm cập nhật lại để chạy tiếp từ phần chưa lấy.',
    reason: lastTaskStopped ? String(lastFinishedTask.status).toLowerCase() : 'fatal',
    label: lastTaskStopped ? String(lastFinishedTask.label || '') : '',
    at: lastTaskStopped ? String(lastFinishedTask.finished_at || '') : fatalAt,
  } : null;
  // Lần chạy gần nhất đã kết thúc (xong / lỗi / dừng): để giao diện nói rõ chuyện gì đã xảy ra.
  const lastTask = lastFinishedTask ? {
    label: String(lastFinishedTask.label || ''),
    status: String(lastFinishedTask.status || ''),
    message: String(lastFinishedTask.message || ''),
    started_at: String(lastFinishedTask.started_at || ''),
    finished_at: String(lastFinishedTask.finished_at || ''),
  } : null;

  return { activeTask, stopped, lastTask };
}

function taskStatusForRun(runDir) {
  const { activeTask, stopped, lastTask } = taskStatusParts(runDir);
  return {
    active_task: activeTask ? { id: activeTask.id, type: activeTask.type, label: activeTask.label, status: activeTask.status, message: activeTask.message || '', started_at: activeTask.started_at || '', heartbeat_at: activeTask.heartbeat_at || '' } : null,
    stopped,
    last_task: activeTask ? null : lastTask,
  };
}

function buildResearchProgressSnapshot(runDir, scopeMeta = {}, { isArchive = true } = {}) {
  if (!runDir || !fs.existsSync(runDir)) {
    const total = Number(scopeMeta?.source_count || scopeMeta?.cohort_count || 0) || 0;
    return {
      exists: false,
      run_id: '',
      total,
      ready: 0,
      missingCount: total,
      manualReview: 0,
      modules: RESEARCH_PROGRESS_PARTS.map(p => ({ ...p, done: 0, missing: total })),
      missingRows: [],
      rows: [],
      counts: { running: 0, error: 0, missing: total, waiting: total, done: 0 },
      recentUpdates: [],
      active_task: null,
      current_case: null,
      generated_at: nowIso(),
    };
  }

  const manifest = readJsonSafe(path.join(runDir, 'manifest.json'), {}) || {};
  const progress = readProgressMapSafe(path.join(runDir, 'progress.json'));
  const hchanhProgress = readProgressMapSafe(path.join(runDir, 'hchanh_auto_progress.json'));
  const orderProgress = readProgressMapSafe(path.join(runDir, 'order_history_auto_progress.json'));
  const extractTable = readCsvTable(path.join(runDir, 'extract_status.csv'), 50000);
  const seedRows = extractTable.rows?.length ? extractTable.rows : buildProgressSeedRows(runDir, scopeMeta, isArchive);

  const rowsByKey = new Map();
  const putRow = (row, idx = 0) => {
    const researchCode = pickProgressValue(row, ['research_code', 'Mã NC', 'Ma NC']);
    const code = patientCode(row) || pickProgressValue(row, ['patient_code', 'Mã BN', 'Ma BN', 'MABN']);
    const key = researchCode || code || `row:${idx}`;
    if (!rowsByKey.has(key)) {
      rowsByKey.set(key, {
        key,
        research_code: researchCode || '',
        patient_code: code || '',
        patient_name: pickProgressValue(row, ['patient_name', 'Họ tên', 'Ho ten', 'Tên BN', 'Ten BN']) || '',
        popup_status: String(row.popup_status || '').trim(),
        xn_status: String(row.xn_status || '').trim(),
        cdha_status: String(row.cdha_status || '').trim(),
        profile_status: String(row.profile_status || '').trim(),
        discharge_status: String(row.discharge_status || '').trim(),
        surgery_status: String(row.surgery_status || '').trim(),
        order_history_status: String(row.order_history_status || '').trim(),
        overall_status: String(row.overall_status || '').trim(),
        ready_for_analysis: String(row.ready_for_analysis || '').trim(),
        missing_required: String(row.missing_required || '').trim(),
        last_error: String(row.last_error || row.error || '').trim(),
        updated_at: '',
      });
    }
    return rowsByKey.get(key);
  };

  seedRows.forEach(putRow);

  // progress.json của script XN/CĐHA ghi theo từng lượt trên EMR (`Mã BN|row:N`), nhiều
  // mục (vd. lỗi mở popup, lượt ngoài khoảng lọc) không có Mã NC. Khi đã có danh sách
  // nguồn, chỉ ghép mục vào lượt có sẵn: đúng Mã NC, hoặc Mã BN chỉ có đúng một lượt.
  // Không tạo lượt mới, nếu không số "lượt theo dõi" và số lỗi bị đếm dư.
  const seededByResearch = new Map();
  const seededByPatient = new Map();
  for (const row of rowsByKey.values()) {
    if (row.research_code) seededByResearch.set(normalizedIdentity(row.research_code), row);
    const pc = normalizedIdentity(row.patient_code);
    if (pc) seededByPatient.set(pc, [...(seededByPatient.get(pc) || []), row]);
  }
  const hasSeedRows = rowsByKey.size > 0;
  let unmatchedProgress = 0;

  for (const [key, item] of Object.entries(progress || {})) {
    if (!item || typeof item !== 'object' || String(key).startsWith('__')) continue;
    const code = progressCodeFromKey(key, item);
    const researchCode = progressResearchCode(item);
    const rowKey = researchCode || code || key;
    let seeded = null;
    if (hasSeedRows) {
      seeded = (researchCode && seededByResearch.get(normalizedIdentity(researchCode))) || null;
      if (!seeded) {
        const samePatient = seededByPatient.get(normalizedIdentity(code)) || [];
        if (samePatient.length === 1) seeded = samePatient[0];
      }
      if (!seeded) {
        unmatchedProgress += 1;
        continue;
      }
    }
    const row = seeded || rowsByKey.get(rowKey) || rowsByKey.get(code) || rowsByKey.get(researchCode) || {
      key: rowKey,
      research_code: researchCode,
      patient_code: code,
      patient_name: progressPatientName(item),
      popup_status: '', xn_status: '', cdha_status: '', profile_status: '', discharge_status: '', surgery_status: '', order_history_status: '',
      overall_status: '', ready_for_analysis: '', missing_required: '', last_error: '', updated_at: '',
    };
    row.research_code = row.research_code || researchCode;
    row.patient_code = row.patient_code || code;
    row.patient_name = row.patient_name || progressPatientName(item);
    row.popup_status = String(item.popup || row.popup_status || '').trim();
    row.xn_status = String(item.xn || row.xn_status || '').trim();
    row.cdha_status = String(item.cdha || row.cdha_status || '').trim();
    row.last_error = String(item.last_error || item.error || row.last_error || '').trim();
    row.updated_at = progressUpdatedAt(item) || row.updated_at;
    if (item.status) row.overall_status = String(item.status || row.overall_status || '').trim();
    if (item.committed === true && !researchStatusDone(row.overall_status)) row.overall_status = row.overall_status || 'running_partial';
    rowsByKey.set(row.key || rowKey, row);
  }

  for (const row of rowsByKey.values()) {
    const code = row.patient_code;
    const rc = row.research_code;
    // Trạng thái MỚI trong file tiến độ (đang thu thập) thắng trạng thái của lần chuẩn hóa trước
    // (extract_status.csv); trước đây chỉ dùng tiến độ mới khi ô cũ trống nên bộ đếm đứng yên.
    row.profile_status = buildHchanhFileStatus(hchanhProgress, code, rc, 'profile') || row.profile_status;
    row.discharge_status = buildHchanhFileStatus(hchanhProgress, code, rc, 'discharge') || row.discharge_status;
    row.surgery_status = buildHchanhFileStatus(hchanhProgress, code, rc, 'surgery') || row.surgery_status;
    row.order_history_status = buildHchanhFileStatus(orderProgress, code, rc, 'order_history') || buildHchanhFileStatus(hchanhProgress, code, rc, 'order_history') || row.order_history_status;
    const missing = missingLabelsForProgressRow(row);
    row.missing = missing;
    row.ready = missing.length === 0;
  }

  const rows = Array.from(rowsByKey.values());
  const progressPatients = Object.entries(progress || {}).filter(([k, v]) => !String(k).startsWith('__') && v && typeof v === 'object').map(([, v]) => v);
  const liveDoneXnCdha = progressPatients.filter(v => v?.committed === true || v?.status === 'done' || (v?.popup === 'done' && v?.xn === 'done' && v?.cdha === 'done')).length;
  const liveTotalFromProgress = progressPatients.reduce((max, v) => Math.max(max, Number(v?.total || 0)), 0) || progressPatients.length;
  const total = rows.length || Math.max(
    liveTotalFromProgress,
    Number(manifest.patients_count || 0),
    Number(scopeMeta?.source_count || scopeMeta?.cohort_count || 0),
    Number(manifest.normalized_outputs?.initial_list || manifest.normalized_outputs?.patients || 0)
  );

  const ready = rows.filter(r => r.ready || String(r.ready_for_analysis || '') === '1').length;
  let manualReview = 0;
  const analysisReady = readCsvTable(path.join(runDir, 'analysis_ready.csv'), 50000);
  for (const row of analysisReady.rows || []) if (String(row.needs_manual_review || '').trim()) manualReview += 1;

  const modules = RESEARCH_PROGRESS_PARTS.map(part => {
    const stats = progressPartStats(rows, part);
    if (!rows.length && total) stats.missing = total;
    stats.missing = Math.max(0, stats.total - stats.done - stats.running - stats.error - stats.waiting);
    return stats;
  });

  const missingRows = rows
    .filter(r => r.missing?.length || String(r.last_error || '').trim())
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    .slice(0, 300)
    .map(r => ({
      key: r.key,
      sample: r.research_code || r.patient_code || r.key,
      patient_code: r.patient_code || '',
      patient_name: r.patient_name || '',
      missing: r.missing || [],
      last_error: String(r.last_error || '').split('\n')[0].slice(0, 180),
    }));

  const monitorRows = rows.map(progressMonitorRow).sort((a, b) => {
    const ak = monitorRowSortKey(a);
    const bk = monitorRowSortKey(b);
    if (ak[0] !== bk[0]) return ak[0] - bk[0];
    return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
  });
  const counts = {
    running: monitorRows.filter(r => r.state === 'running').length,
    error: monitorRows.filter(r => r.state === 'error').length,
    missing: monitorRows.filter(r => r.state === 'missing').length,
    waiting: monitorRows.filter(r => r.state === 'waiting').length,
    done: monitorRows.filter(r => r.state === 'done').length,
  };

  const updateEvents = [];
  for (const row of rows) {
    const updated = [];
    for (const part of RESEARCH_PROGRESS_PARTS) {
      if (part.fields.every(f => researchStatusDone(row[f]))) updated.push(part.label);
    }
    if (!updated.length) continue;
    updateEvents.push({
      key: row.key,
      sample: row.research_code || row.patient_code || row.key,
      patient_code: row.patient_code || '',
      patient_name: row.patient_name || '',
      updated: updated.join(', '),
      result: row.ready ? 'Đủ dữ liệu' : 'Đã cập nhật một phần',
      missing: (row.missing || []).join(', '),
      updated_at: row.updated_at || '',
    });
  }
  updateEvents.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));

  const { activeTask, stopped, lastTask } = taskStatusParts(runDir);

  return {
    exists: true,
    run_id: path.basename(runDir),
    total,
    ready,
    missingCount: Math.max(0, total - ready),
    manualReview,
    // Mục tiến độ không ghép được vào lượt nào trong danh sách (không tính vào total/lỗi).
    unmatched_progress: unmatchedProgress,
    qa: qaSummaryForSnapshot(runDir),
    modules,
    missingRows,
    rows: monitorRows.slice(0, 500),
    counts,
    recentUpdates: updateEvents.slice(0, 80),
    active_task: activeTask ? {
      id: activeTask.id,
      type: activeTask.type,
      label: activeTask.label,
      status: activeTask.status,
      message: activeTask.message || '',
      missing_types: activeTask.missing_types || [],
      summary: activeTask.summary || {},
      started_at: activeTask.started_at || '',
      heartbeat_at: activeTask.heartbeat_at || '',
    } : null,
    current_case: readCurrentCaseTrace(runDir) || readCurrentHchanhCase(runDir),
    stopped,
    last_task: activeTask ? null : lastTask,
    generated_at: nowIso(),
  };
}

// Tóm tắt kiểm tra độ CHÍNH XÁC (qa_report.json do bước chuẩn hóa ghi) cho bảng theo dõi:
// lỗi chặn, số lượt cần người kiểm tra theo từng loại, mẫu danh sách, và có cũ hơn dữ liệu
// vừa lấy không (lấy thêm sau lần chuẩn hóa thì phải chuẩn hóa lại mới kiểm tra phần mới).
// Danh sách cần kiểm tra có thể nhiều dòng cho một lượt (vd. "có thể cùng một đợt" ghi cho cả hai
// lượt của cặp, một lượt nằm trong nhiều cặp). Đếm theo lượt để không ra số lớn hơn tổng số lượt.
function summarizeReviewRows(review = []) {
  const keyOf = r => String(r?.encounter_id || r?.research_code || '').trim() || `${r?.patient_code || ''}|${r?.detail || ''}`;
  const all = new Set();
  const perIssue = {};
  for (const r of review) {
    const k = keyOf(r);
    const issue = String(r?.issue || 'other');
    all.add(k);
    (perIssue[issue] ||= new Set()).add(k);
  }
  return { encounters: all.size, byIssue: Object.fromEntries(Object.entries(perIssue).map(([i, set]) => [i, set.size])) };
}

function qaSummaryForSnapshot(runDir) {
  const qa = quality.readQaReport(runDir);
  if (!qa || typeof qa !== 'object') return null;
  // Danh sách cần kiểm tra nằm ở encounter_review.csv (qa_report.json không chép lại).
  const review = Array.isArray(qa.review)
    ? qa.review
    : (readCsvTable(path.join(runDir, quality.ENCOUNTER_REVIEW_FILE), 20000).rows || []);
  const { encounters: reviewEncounters, byIssue } = summarizeReviewRows(review);
  const generatedAt = String(qa.generated_at || '');
  let latestCollectMs = 0;
  for (const name of ['progress.json', 'hchanh_auto_progress.json', 'order_history_auto_progress.json']) {
    try { latestCollectMs = Math.max(latestCollectMs, fs.statSync(path.join(runDir, name)).mtimeMs); } catch (_) { /* chưa có */ }
  }
  const checkedMs = Date.parse(generatedAt);
  const short = (list) => (Array.isArray(list) ? list : []).slice(0, 30).map(x => ({
    code: String(x?.code || ''), message: String(x?.message || ''), count: Number(x?.count || 0) || 0, table: String(x?.table || ''),
  }));
  return {
    status: String(qa.status || ''),
    generated_at: generatedAt,
    stale: Number.isFinite(checkedMs) && latestCollectMs > checkedMs + 2000,
    blocking: short(qa.blocking),
    warnings: short(qa.warnings),
    // Đếm theo LƯỢT (cùng đơn vị với "N lượt điều trị" trên màn hình); số dòng giữ riêng.
    review_count: review.length ? reviewEncounters : Number(qa.review_count || 0) || 0,
    review_rows: review.length,
    review_by_issue: byIssue,
    review: review.slice(0, 300).map(r => ({
      research_code: String(r?.research_code || ''),
      patient_code: String(r?.patient_code || ''),
      issue: String(r?.issue || ''),
      detail: String(r?.detail || '').slice(0, 240),
    })),
  };
}

function buildCoverageSummary(runDir) {
  if (!runDir || !fs.existsSync(runDir)) return { exists: false, run_id: '', counts: {}, extract: computeExtractCoverage('/__missing__') };
  const counts = tableCountsForRunDir(runDir);
  const extract = computeExtractCoverage(runDir);
  const blockers = [];
  if (!counts.analysis_ready) blockers.push('Chưa có analysis_ready.csv.');
  if (!extract.total) blockers.push('Chưa có extract_status.csv.');
  if (extract.total && extract.ready < extract.total) blockers.push(`Còn ${extract.total - extract.ready}/${extract.total} dòng chưa đạt ready_for_analysis.`);
  if (extract.manual_review > 0) blockers.push(`Còn ${extract.manual_review} dòng cần manual review.`);
  const normalizeState = quality.readNormalizeState(runDir);
  if (normalizeState?.status === 'running') blockers.push('Lần Chuẩn hóa trước bị dừng giữa chừng, dữ liệu có thể lẫn bảng cũ và mới. Bấm Chuẩn hóa lại.');
  if (normalizeState?.status === 'failed') blockers.push('Lần Chuẩn hóa gần nhất bị lỗi. Bấm Chuẩn hóa lại sau khi xử lý lỗi.');
  const qaReport = quality.readQaReport(runDir);
  for (const item of qaReport?.blocking || []) blockers.push(`Kiểm tra chất lượng: ${item.message}`);
  const manifest = readJsonSafe(path.join(runDir, 'manifest.json'), {}) || {};
  const provisionalCount = Number(manifest?.normalized_outputs?.kho_nguoi_benh?.provisional || 0);
  if (provisionalCount > 0) {
    blockers.push(`Còn ${provisionalCount} phần dữ liệu tạm thời từ Kho người bệnh; cần quét/chốt bản gốc trước khi tạo dataset cuối.`);
  }
  return {
    exists: true,
    run_id: path.basename(runDir),
    counts,
    extract,
    final_dataset_ready: blockers.length === 0,
    blockers,
    normalize_state: normalizeState ? { status: normalizeState.status, finished_at: normalizeState.finished_at || '' } : null,
    qa: qaReport ? {
      status: qaReport.status, generated_at: qaReport.generated_at,
      blocking: qaReport.blocking || [], warnings: qaReport.warnings || [], notes: qaReport.notes || [],
      review_count: qaReport.review_count || 0,
    } : null,
  };
}

function rowResearchCode(row) {
  return firstNonEmpty(row, ['Mã NC', 'Ma NC', 'research_code']);
}

module.exports = {
  summarizeReviewRows,
  taskStatusForRun,
  qaSummaryForSnapshot,
  tableCountsForRunDir,
  computeExtractCoverage,
  RESEARCH_PROGRESS_PARTS,
  RESEARCH_TASK_STATE_FILE,
  RESEARCH_TASK_ACTIVE_STATUSES,
  RESEARCH_PROCESS_INSTANCE_ID,
  researchTaskStatePath,
  readResearchTaskState,
  writeResearchTaskState,
  beginResearchTask,
  updateResearchTask,
  finishResearchTask,
  activeResearchTask,
  researchStatusDone,
  progressCodeFromKey,
  progressResearchCode,
  progressPatientName,
  progressUpdatedAt,
  readProgressMapSafe,
  buildProgressSeedRows,
  pickProgressValue,
  hchanhEntryFileStatus,
  buildHchanhFileStatus,
  hchanhFileDone,
  missingLabelsForProgressRow,
  researchStatusRunning,
  researchStatusError,
  researchStatusLabel,
  progressPartValue,
  progressMonitorRow,
  monitorRowSortKey,
  progressPartStats,
  isRowMissingXnCdha,
  rowResearchCode,
  progressMatchesCode,
  resetXnCdhaProgress,
  sourceRowsForXnCdhaRefetch,
  buildResearchProgressSnapshot,
  buildCoverageSummary,
};
