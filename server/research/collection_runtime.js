'use strict';

// Thu thập tự động: sổ theo dõi từng phần của từng lượt, giao dịch làm mới có thể khôi phục, lưu phiên bản khi dữ liệu thay đổi, đánh giá đủ dùng theo nghiên cứu.

const { readCsvTable, writeCsv, patientCode, writeCsvUnion } = require('./table_io');
const path = require('path');
const fs = require('fs');
const collection = require('./collection');
const { writeJsonAtomic, nowFileStamp, readJsonSafe, ensureDir } = require('../utils/file');
const crypto = require('crypto');
const { nowIso, archiveMetaPath } = require('./store_paths');
const { RESEARCH_PROCESS_INSTANCE_ID, readProgressMapSafe } = require('./progress_snapshot');
const { appendResearchRunLog } = require('./case_trace');
const { listStudies, archiveTablePath, isStoppedRunResult } = require('./run_registry');
const { isoDate, firstNonEmpty } = require('./encounter_context');
const { SCRIPT_PATH } = require('./worker_paths');
const { RESEARCH_STORE_DIR, ROOT_DIR } = require('../constants');
const { runPython, fmtPyError } = require('../services/python_runner');
const { registerCancel, unregisterCancel, isCancelRequested } = require('../services/task_queue');
const { fetchHchanhForResearchRun } = require('./hchanh_fetch');
const { normalizeRunOutputs } = require('./normalize');

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

module.exports = {
  COLLECTION_LEDGER_FILE,
  COLLECTION_REPORT_FILE,
  COLLECTION_HISTORY_FILE,
  COLLECTION_EXCEPTIONS_FILE,
  COLLECTION_ENCOUNTER_OVERRIDES_FILE,
  COLLECTION_EXCEPTION_COLUMNS,
  STUDY_READINESS_FILE,
  COLLECTION_VERSIONS_FILE,
  COLLECTION_CHANGES_FILE,
  COLLECTION_CHANGE_COLUMNS,
  readCollectionPartRows,
  partRowsMap,
  readCollectionVersionIds,
  appendCollectionVersions,
  appendCollectionChanges,
  COLLECTION_TXN_DIR,
  COLLECTION_TXN_LOG_FILE,
  ACTIVE_COLLECTION_TXNS,
  ensurePrivateDir,
  writePrivateJson,
  collectionTxnRoot,
  runDirHasActiveTxn,
  beginCollectionTxn,
  updateCollectionTxn,
  closeCollectionTxn,
  recoverPythonPatientCommits,
  finalizeCollectionTxn,
  recoverCollectionTransactions,
  refreshPolicyFor,
  readinessByStudy,
  readinessDiff,
  IN_RUN_RETRY_REASONS,
  collectionEncounterOverrideState,
  collectionUnitsForRun,
  unitKeysForRun,
  buildCollectionLedgerForRun,
  syncCollectionLedger,
  unresolvedEncountersForRun,
  collectionStatusSummary,
  collectionEncounterReviewPayload,
  writeCollectionOutputs,
  redactCollectionRows,
  runXnCdhaSubsetForCollection,
  DEFAULT_COLLECTION_RUNNERS,
  runCollectionOrchestration,
  readinessTablesForRun,
  studyReadinessForRun,
};
