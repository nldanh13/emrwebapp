'use strict';

// Kiểm tra chất lượng dữ liệu nghiên cứu sau mỗi lần Chuẩn hóa.
//
// Nguyên tắc:
// - Chỉ PHÁT HIỆN và BÁO CÁO; không tự sửa giá trị lâm sàng, không tự gộp đợt.
// - "blocking": lỗi làm dataset không đáng tin (trùng khóa, mồ côi khóa ngoại,
//   CSV lệch SQLite...). Chặn bước tạo dataset cuối cho tới khi xử lý.
// - "warning": cần người xem lại (ngày bất hợp lý, ca nghi trùng đợt do chuyển
//   khoa, dòng chưa ghép được đợt...). Không chặn, nhưng hiện rõ và vào danh sách duyệt.
// - Báo cáo chỉ chứa mã giả danh (encounter_id, research_code) và số đếm; không
//   chứa họ tên/điện thoại/địa chỉ/số thẻ.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const QA_REPORT_FILE = 'qa_report.json';
const ENCOUNTER_REVIEW_FILE = 'encounter_review.csv';
const NORMALIZE_STATE_FILE = 'normalize_state.json';
const NORMALIZE_HISTORY_FILE = 'normalize_history.jsonl';

const CHILD_TABLES = [
  ['diagnoses', 'diagnosis_id'],
  ['lab_results', 'lab_result_id'],
  ['imaging_results', 'imaging_id'],
  ['surgery_results', 'surgery_id'],
  ['medication_orders', 'med_order_id'],
  ['clinical_notes', 'note_id'],
];

const DAY_MS = 86400000;

function text(value) {
  return String(value ?? '').trim();
}

// Ngày ở dạng ISO (YYYY-MM-DD[ HH:mm]) do bước chuẩn hóa sinh ra. Trả về null nếu
// không đọc được — không đoán định dạng khác ở đây.
function isoToTime(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(text(value));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0));
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function duplicates(values) {
  const seen = new Map();
  for (const v of values) {
    const key = text(v);
    if (!key) continue;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
}

function sample(list, n = 10) {
  return list.slice(0, n);
}

function fileSha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

// So file CSV hiện tại với SQLite: dùng source_sha256 mà research/sqlite_store.py
// đã ghi vào manifest khi nạp từng bảng.
function compareCsvWithSqlite(runDir, databaseManifest, tableFiles) {
  const issues = [];
  if (!databaseManifest || !databaseManifest.exists) {
    return [{ code: 'sqlite_missing', message: 'Chưa có research.sqlite3 cho lần chuẩn hóa này.' }];
  }
  const tables = Array.isArray(databaseManifest.tables) ? databaseManifest.tables : [];
  for (const file of tableFiles) {
    const csvPath = path.join(runDir, file);
    if (!fs.existsSync(csvPath)) continue;
    const entry = tables.find(t => path.basename(text(t.source_file)) === file);
    if (!entry) {
      issues.push({ code: 'sqlite_table_missing', message: `SQLite không có bảng nạp từ ${file}.`, file });
      continue;
    }
    if (entry.source_sha256 && entry.source_sha256 !== fileSha256(csvPath)) {
      issues.push({ code: 'sqlite_out_of_sync', message: `${file} đã khác với bản nạp vào SQLite.`, file });
    }
  }
  return issues;
}

// Ca cùng người bệnh có khoảng nằm viện chồng lấn hoặc liền nhau (≤ 1 ngày) thường
// là các dòng chuyển khoa của CÙNG một đợt nằm viện. Không tự gộp: chỉ đưa vào danh
// sách duyệt vì cũng có thể là hai lần nhập viện sát nhau thật.
function possibleSameStayPairs(encounters) {
  const byPatient = new Map();
  for (const enc of encounters) {
    const code = text(enc.patient_code);
    if (!code) continue;
    if (!byPatient.has(code)) byPatient.set(code, []);
    byPatient.get(code).push(enc);
  }
  const pairs = [];
  for (const list of byPatient.values()) {
    if (list.length < 2) continue;
    const withTimes = list
      .map(enc => ({ enc, a: isoToTime(enc.admission_date), d: isoToTime(enc.discharge_date) }))
      .filter(x => x.a != null)
      .sort((x, y) => x.a - y.a);
    for (let i = 0; i < withTimes.length; i += 1) {
      for (let j = i + 1; j < withTimes.length; j += 1) {
        const x = withTimes[i];
        const y = withTimes[j];
        const sameDischarge = x.d != null && y.d != null && Math.abs(x.d - y.d) < DAY_MS;
        const endX = x.d != null ? x.d : null;
        const overlaps = endX != null && y.a <= endX + DAY_MS;
        if (sameDischarge || overlaps) {
          pairs.push({
            a: x.enc, b: y.enc,
            reason: sameDischarge ? 'cùng ngày ra viện' : 'khoảng nằm viện chồng lấn/liền nhau',
          });
        }
      }
    }
  }
  return pairs;
}

function buildQualityReport({
  runId = '',
  tables = {},
  inputCounts = {},
  databaseManifest = null,
  databaseError = '',
  runDir = '',
  csvFilesInDatabase = [],
  inferenceFields = [],
  now = new Date(),
} = {}) {
  const blocking = [];
  const warnings = [];
  const review = [];
  const encounters = Array.isArray(tables.encounters) ? tables.encounters : [];
  const patients = Array.isArray(tables.patients) ? tables.patients : [];

  const addReview = (enc, issue, detail, related = '') => review.push({
    encounter_id: text(enc?.encounter_id),
    research_code: text(enc?.research_code),
    patient_code: text(enc?.patient_code),
    issue,
    detail,
    related_encounter_id: text(related),
    source_status: text(enc?.source_status),
  });

  // Khóa chính / tính duy nhất.
  const dupEnc = duplicates(encounters.map(e => e.encounter_id));
  if (dupEnc.length) blocking.push({ code: 'duplicate_encounter_id', message: `${dupEnc.length} encounter_id bị trùng trong encounters.csv.`, count: dupEnc.length, sample: sample(dupEnc) });
  const dupRc = duplicates(encounters.map(e => e.research_code));
  if (dupRc.length) blocking.push({ code: 'duplicate_research_code', message: `${dupRc.length} Mã NC dùng cho nhiều đợt điều trị.`, count: dupRc.length, sample: sample(dupRc) });
  const dupPatient = duplicates(patients.map(p => p.patient_code));
  if (dupPatient.length) blocking.push({ code: 'duplicate_patient_code', message: `${dupPatient.length} patient_code bị trùng trong patients.csv.`, count: dupPatient.length });

  const missingEncKey = encounters.filter(e => !text(e.encounter_id) || !text(e.patient_code)).length;
  if (missingEncKey) blocking.push({ code: 'missing_required_key', message: `${missingEncKey} đợt thiếu encounter_id hoặc patient_code.`, count: missingEncKey });

  const patientSet = new Set(patients.map(p => text(p.patient_code)).filter(Boolean));
  const orphanEncounters = patients.length ? encounters.filter(e => text(e.patient_code) && !patientSet.has(text(e.patient_code))).length : 0;
  if (orphanEncounters) blocking.push({ code: 'encounter_without_patient', message: `${orphanEncounters} đợt có patient_code không có trong patients.csv.`, count: orphanEncounters });

  // Bảng con: khóa ngoại và trạng thái ghép đợt.
  const encSet = new Set(encounters.map(e => text(e.encounter_id)).filter(Boolean));
  const unmatchedByTable = {};
  for (const [name, idCol] of CHILD_TABLES) {
    const rows = Array.isArray(tables[name]) ? tables[name] : [];
    const dupIds = duplicates(rows.map(r => r[idCol]));
    if (dupIds.length) blocking.push({ code: 'duplicate_row_id', message: `${name}: ${dupIds.length} ${idCol} bị trùng.`, table: name, count: dupIds.length });
    const orphans = rows.filter(r => text(r.encounter_id) && !encSet.has(text(r.encounter_id))).length;
    if (orphans) blocking.push({ code: 'orphan_child_row', message: `${name}: ${orphans} dòng trỏ tới encounter_id không tồn tại.`, table: name, count: orphans });
    const ambiguous = rows.filter(r => text(r.encounter_match_status) === 'ambiguous').length;
    const missing = rows.filter(r => text(r.encounter_match_status) === 'missing').length;
    unmatchedByTable[name] = { ambiguous, missing };
    if (ambiguous) warnings.push({ code: 'child_match_ambiguous', message: `${name}: ${ambiguous} dòng khớp nhiều đợt, chưa gắn vào đợt nào.`, table: name, count: ambiguous });
    if (missing) warnings.push({ code: 'child_match_missing', message: `${name}: ${missing} dòng không khớp đợt nào.`, table: name, count: missing });
  }

  // Ngày tháng: chỉ báo, không sửa.
  const nowMs = now.getTime();
  let missingAdmission = 0;
  let invalidOrder = 0;
  let futureDates = 0;
  let longStay = 0;
  for (const enc of encounters) {
    const a = isoToTime(enc.admission_date);
    const d = isoToTime(enc.discharge_date);
    if (a == null) { missingAdmission += 1; addReview(enc, 'missing_admission_date', 'Thiếu hoặc không đọc được ngày vào viện.'); continue; }
    if (d != null && d < a) { invalidOrder += 1; addReview(enc, 'discharge_before_admission', 'Ngày ra viện trước ngày vào viện.'); }
    if (a > nowMs + DAY_MS || (d != null && d > nowMs + DAY_MS)) { futureDates += 1; addReview(enc, 'future_date', 'Ngày vào/ra viện ở tương lai.'); }
    if (d != null && d - a > 365 * DAY_MS) { longStay += 1; addReview(enc, 'stay_over_365_days', 'Thời gian nằm viện trên 365 ngày.'); }
    const reason = text(enc.needs_manual_review);
    if (reason) addReview(enc, 'needs_manual_review', reason);
  }
  if (missingAdmission) warnings.push({ code: 'missing_admission_date', message: `${missingAdmission} đợt thiếu ngày vào viện.`, count: missingAdmission });
  if (invalidOrder) warnings.push({ code: 'discharge_before_admission', message: `${invalidOrder} đợt có ngày ra trước ngày vào.`, count: invalidOrder });
  if (futureDates) warnings.push({ code: 'future_date', message: `${futureDates} đợt có ngày ở tương lai.`, count: futureDates });
  if (longStay) warnings.push({ code: 'stay_over_365_days', message: `${longStay} đợt nằm viện trên 365 ngày.`, count: longStay });

  const pairs = possibleSameStayPairs(encounters);
  for (const p of pairs) {
    addReview(p.a, 'possible_same_stay', `Có thể cùng đợt nằm viện với ${text(p.b.research_code) || text(p.b.encounter_id)} (${p.reason}). Chưa tự gộp.`, p.b.encounter_id);
    addReview(p.b, 'possible_same_stay', `Có thể cùng đợt nằm viện với ${text(p.a.research_code) || text(p.a.encounter_id)} (${p.reason}). Chưa tự gộp.`, p.a.encounter_id);
  }
  if (pairs.length) warnings.push({ code: 'possible_same_stay', message: `${pairs.length} cặp đợt của cùng người bệnh có thể là một đợt nằm viện (chuyển khoa). Xem ${ENCOUNTER_REVIEW_FILE}.`, count: pairs.length });

  // CSV ↔ SQLite.
  if (databaseError) {
    blocking.push({ code: 'sqlite_failed', message: `Không tạo/cập nhật được research.sqlite3: ${text(databaseError).slice(0, 200)}` });
  } else if (runDir && csvFilesInDatabase.length) {
    for (const issue of compareCsvWithSqlite(runDir, databaseManifest, csvFilesInDatabase)) blocking.push(issue);
  }

  const notes = [];
  if (inferenceFields.length) {
    notes.push({
      code: 'inferred_fields',
      message: `Các cột suy luận tự động cần người xác nhận trước khi dùng: ${inferenceFields.map(f => f.key).join(', ')}.`,
      fields: inferenceFields.map(f => ({ key: f.key, label: f.label || '', rule: f.fn || '', status: 'needs_human_confirmation' })),
    });
  }

  return {
    run_id: runId,
    generated_at: now.toISOString(),
    status: blocking.length ? 'blocked' : (warnings.length ? 'warnings' : 'ok'),
    blocking_count: blocking.length,
    warning_count: warnings.length,
    blocking,
    warnings,
    notes,
    input_counts: inputCounts,
    output_counts: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])),
    unmatched_by_table: unmatchedByTable,
    review_count: review.length,
    review,
  };
}

function readQaReport(runDir) {
  if (!runDir) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir, QA_REPORT_FILE), 'utf8'));
  } catch (_) {
    return null;
  }
}

function readNormalizeState(runDir) {
  if (!runDir) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir, NORMALIZE_STATE_FILE), 'utf8'));
  } catch (_) {
    return null;
  }
}

// Phiên bản code tạo ra dữ liệu: version trong package.json + commit git nếu đọc được
// (đọc thẳng .git, không chạy lệnh ngoài).
function codeVersion(rootDir) {
  let version = '';
  let commit = '';
  try { version = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version || ''; } catch (_) {}
  try {
    const head = fs.readFileSync(path.join(rootDir, '.git', 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5).trim();
      const refFile = path.join(rootDir, '.git', ref);
      if (fs.existsSync(refFile)) commit = fs.readFileSync(refFile, 'utf8').trim();
      else {
        const packed = fs.readFileSync(path.join(rootDir, '.git', 'packed-refs'), 'utf8');
        const line = packed.split('\n').find(l => l.endsWith(` ${ref}`));
        if (line) commit = line.split(' ')[0];
      }
    } else {
      commit = head;
    }
  } catch (_) {}
  return { app_version: version, git_commit: commit.slice(0, 40) };
}

module.exports = {
  QA_REPORT_FILE,
  ENCOUNTER_REVIEW_FILE,
  NORMALIZE_STATE_FILE,
  NORMALIZE_HISTORY_FILE,
  buildQualityReport,
  possibleSameStayPairs,
  compareCsvWithSqlite,
  readQaReport,
  readNormalizeState,
  codeVersion,
  fileSha256,
};
