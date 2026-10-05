'use strict';

// Integrity gate chạy SAU bước chuẩn hóa. Không sửa giá trị lâm sàng và không xóa
// dòng nguồn; chỉ kiểm tra tính nhất quán của các bảng chuẩn hóa, ghi báo cáo audit
// và đổi trạng thái normalize để dữ liệu có lỗi nghiêm trọng không bị hiểu là "đã sạch".

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readCsvTable } = require('./table_io');
const { readJsonSafe, writeJsonAtomic } = require('../utils/file');
const { archiveRunsDir, runsDir, nowIso } = require('./store_paths');
const { resolveArchiveRunId, resolveRunId } = require('./run_registry');
const quality = require('./quality');

const INTEGRITY_REPORT_FILE = 'integrity_report.json';
const INPUT_SNAPSHOT_FILE = 'normalize_input_snapshot.json';

// research_source.csv do chính normalize tạo/cập nhật nên không dùng để phát hiện
// thu thập chạy song song. Chỉ hash các nguồn mà Thu thập hoặc người dùng có thể ghi.
const VOLATILE_NORMALIZE_INPUTS = [
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

const CHILD_SPECS = {
  lab_results: {
    file: 'lab_results.csv',
    time: ['lab_datetime', 'lab_date'],
    key: row => [row.patient_code, row.lab_datetime || row.lab_date, row.test_name_raw, row.result_raw, row.unit],
  },
  imaging_results: {
    file: 'imaging_results.csv',
    time: ['ordered_at', 'order_date'],
    key: row => [row.patient_code, row.ordered_at || row.order_date, row.service_name_raw, row.result_text, row.conclusion_text],
  },
  surgery_results: {
    file: 'surgery_results.csv',
    time: ['surgery_datetime', 'surgery_date'],
    key: row => [row.patient_code, row.surgery_datetime || row.surgery_date, row.surgery_name, row.surgery_method, row.anesthesia_method],
  },
  medication_orders: {
    file: 'medication_orders.csv',
    time: ['order_datetime', 'order_date'],
    key: row => [row.patient_code, row.order_datetime || row.order_date, row.drug_name_raw, row.active_ingredient, row.dose_raw, row.route_raw, row.times_per_day],
  },
  clinical_notes: {
    file: 'clinical_notes.csv',
    time: ['note_datetime', 'note_date'],
    key: row => [row.patient_code, row.note_datetime || row.note_date, row.note_type, row.clinical_text, row.order_text],
  },
};

function text(v) { return String(v ?? '').trim(); }

function fileSha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function resolveJobRunDir(job = {}) {
  if (job.kind === 'run' && job.runDir) return path.resolve(job.runDir);
  if (job.kind === 'archive') {
    const runId = resolveArchiveRunId('latest');
    return runId ? path.join(archiveRunsDir(), runId) : '';
  }
  if (job.kind === 'study' && job.studyId) {
    const runId = resolveRunId(job.studyId, 'latest');
    return runId ? path.join(runsDir(job.studyId), runId) : '';
  }
  return '';
}

function captureNormalizeInputs(runDir) {
  const dir = path.resolve(runDir);
  const files = {};
  for (const name of VOLATILE_NORMALIZE_INPUTS) {
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      files[name] = {
        exists: true,
        size: st.size,
        mtime_ms: Math.floor(st.mtimeMs),
        sha256: fileSha256(file),
      };
    } catch (_) {
      files[name] = { exists: false };
    }
  }
  return { captured_at: nowIso(), files };
}

function changedNormalizeInputs(before, after) {
  const out = [];
  const names = new Set([
    ...Object.keys(before?.files || {}),
    ...Object.keys(after?.files || {}),
  ]);
  for (const name of names) {
    const a = before?.files?.[name] || { exists: false };
    const b = after?.files?.[name] || { exists: false };
    if (Boolean(a.exists) !== Boolean(b.exists) || text(a.sha256) !== text(b.sha256)) out.push(name);
  }
  return out.sort();
}

function loadTable(runDir, file) {
  try { return readCsvTable(path.join(runDir, file), Number.MAX_SAFE_INTEGER).rows || []; }
  catch (_) { return []; }
}

function addIssue(list, code, message, extra = {}) {
  list.push({ code, message, ...extra });
}

function strongIdIntegrity(encounters, critical) {
  const specs = [
    ['emr_admission_id', 'Mã tiếp nhận/admission'],
    ['emr_treatment_id', 'Mã điều trị'],
    ['emr_noitru_id', 'Mã nội trú'],
  ];
  for (const [field, label] of specs) {
    const groups = new Map();
    for (const enc of encounters) {
      const value = text(enc[field]);
      if (!value) continue;
      if (!groups.has(value)) groups.set(value, []);
      groups.get(value).push(enc);
    }
    let crossPatient = 0;
    let conflictingStay = 0;
    for (const rows of groups.values()) {
      const patients = new Set(rows.map(r => text(r.patient_code)).filter(Boolean));
      if (patients.size > 1) crossPatient += 1;
      const admissions = new Set(rows.map(r => text(r.admission_date)).filter(Boolean));
      if (admissions.size > 1) conflictingStay += 1;
    }
    if (crossPatient) addIssue(critical, 'strong_id_cross_patient', `${label}: ${crossPatient} ID đang gắn với nhiều Mã BN.`, { field, count: crossPatient });
    if (conflictingStay) addIssue(critical, 'strong_id_conflicting_admission', `${label}: ${conflictingStay} ID có nhiều thời điểm vào viện khác nhau.`, { field, count: conflictingStay });
  }
}

function researchCodeIntegrity(encounters, critical) {
  const groups = new Map();
  for (const enc of encounters) {
    const rc = text(enc.research_code);
    if (!rc) continue;
    if (!groups.has(rc)) groups.set(rc, new Set());
    const pc = text(enc.patient_code);
    if (pc) groups.get(rc).add(pc);
  }
  const bad = [...groups.values()].filter(set => set.size > 1).length;
  if (bad) addIssue(critical, 'research_code_cross_patient', `${bad} Mã NC đang gắn với nhiều Mã BN.`, { count: bad });
}

function childIntegrity(runDir, critical, warnings, byTable) {
  for (const [name, spec] of Object.entries(CHILD_SPECS)) {
    const rows = loadTable(runDir, spec.file);
    const summary = { rows: rows.length, outside_encounter: 0, missing_time: 0, unmatched: 0, duplicate_clinical_key: 0 };
    const seen = new Map();
    for (const row of rows) {
      if (text(row.encounter_id) && text(row.is_within_encounter) === '0') summary.outside_encounter += 1;
      const at = spec.time.map(k => text(row[k])).find(Boolean) || '';
      if (!at) summary.missing_time += 1;
      const match = text(row.encounter_match_status);
      if (match && match !== 'matched') summary.unmatched += 1;
      const keyParts = spec.key(row).map(v => text(v).toLowerCase());
      // Chỉ coi duplicate khi có timestamp thật; không gộp các dòng thiếu thời gian.
      if (at && keyParts.some(Boolean)) {
        const key = keyParts.join('|');
        seen.set(key, (seen.get(key) || 0) + 1);
      }
    }
    summary.duplicate_clinical_key = [...seen.values()].filter(n => n > 1).reduce((sum, n) => sum + (n - 1), 0);
    byTable[name] = summary;
    if (summary.outside_encounter) {
      addIssue(critical, 'event_outside_encounter', `${name}: ${summary.outside_encounter} dòng đã gắn encounter nhưng nằm ngoài khoảng vào-ra viện.`, { table: name, count: summary.outside_encounter });
    }
    if (summary.missing_time) {
      addIssue(warnings, 'event_missing_timestamp', `${name}: ${summary.missing_time} dòng không có timestamp đủ để xác minh cửa sổ điều trị.`, { table: name, count: summary.missing_time });
    }
    if (summary.unmatched) {
      addIssue(warnings, 'event_not_verified_to_encounter', `${name}: ${summary.unmatched} dòng chưa được ghép chắc chắn vào một encounter.`, { table: name, count: summary.unmatched });
    }
    if (summary.duplicate_clinical_key) {
      addIssue(warnings, 'duplicate_clinical_event', `${name}: ${summary.duplicate_clinical_key} dòng trùng cùng timestamp và nội dung lâm sàng. Dữ liệu được giữ để audit, không tự xóa tại integrity gate.`, { table: name, count: summary.duplicate_clinical_key });
    }
  }
}

function mergeQaIssue(report, bucket, issue) {
  const list = Array.isArray(report[bucket]) ? report[bucket] : [];
  const key = `${issue.code}|${issue.table || ''}|${issue.field || ''}`;
  if (!list.some(x => `${x.code}|${x.table || ''}|${x.field || ''}` === key)) list.push(issue);
  report[bucket] = list;
}

function evaluateNormalizationIntegrity(runDir, { beforeSnapshot = null, afterSnapshot = null } = {}) {
  const dir = path.resolve(runDir);
  const encounters = loadTable(dir, 'encounters.csv');
  const critical = [];
  const warnings = [];
  const byTable = {};

  strongIdIntegrity(encounters, critical);
  researchCodeIntegrity(encounters, critical);
  childIntegrity(dir, critical, warnings, byTable);

  const changedInputs = beforeSnapshot && afterSnapshot ? changedNormalizeInputs(beforeSnapshot, afterSnapshot) : [];
  if (changedInputs.length) {
    addIssue(critical, 'input_changed_during_normalize', `Nguồn thu thập thay đổi trong lúc Chuẩn hóa (${changedInputs.length} file). Kết quả lần này không được coi là snapshot nhất quán.`, {
      count: changedInputs.length,
      files: changedInputs,
    });
  }

  const existingQa = readJsonSafe(path.join(dir, quality.QA_REPORT_FILE), {}) || {};
  for (const issue of critical) mergeQaIssue(existingQa, 'blocking', issue);
  for (const issue of warnings) mergeQaIssue(existingQa, 'warnings', issue);
  existingQa.blocking_count = (existingQa.blocking || []).length;
  existingQa.warning_count = (existingQa.warnings || []).length;
  existingQa.status = existingQa.blocking_count ? 'blocked' : (existingQa.warning_count ? 'warnings' : 'ok');
  writeJsonAtomic(path.join(dir, quality.QA_REPORT_FILE), existingQa);

  const status = existingQa.blocking_count
    ? 'failed_integrity'
    : (existingQa.warning_count ? 'completed_with_warnings' : 'completed_clean');
  const report = {
    generated_at: nowIso(),
    status,
    critical_count: critical.length,
    warning_count: warnings.length,
    qa_blocking_count: existingQa.blocking_count,
    qa_warning_count: existingQa.warning_count,
    critical,
    warnings,
    by_table: byTable,
    input_snapshot: beforeSnapshot && afterSnapshot ? {
      before_at: beforeSnapshot.captured_at,
      after_at: afterSnapshot.captured_at,
      changed_files: changedInputs,
      stable: changedInputs.length === 0,
    } : null,
  };
  writeJsonAtomic(path.join(dir, INTEGRITY_REPORT_FILE), report);

  const statePath = path.join(dir, quality.NORMALIZE_STATE_FILE);
  const state = readJsonSafe(statePath, {}) || {};
  writeJsonAtomic(statePath, {
    ...state,
    status,
    integrity_status: status,
    qa_status: existingQa.status,
    integrity_critical_count: critical.length,
    integrity_warning_count: warnings.length,
    qa_blocking_count: existingQa.blocking_count,
    qa_warning_count: existingQa.warning_count,
    integrity_checked_at: nowIso(),
  });

  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = readJsonSafe(manifestPath, {}) || {};
  writeJsonAtomic(manifestPath, {
    ...manifest,
    normalized_integrity: {
      status,
      critical_count: critical.length,
      warning_count: warnings.length,
      qa_blocking_count: existingQa.blocking_count,
      qa_warning_count: existingQa.warning_count,
      report_file: INTEGRITY_REPORT_FILE,
      input_stable: changedInputs.length === 0,
      checked_at: nowIso(),
    },
  });

  if (beforeSnapshot || afterSnapshot) {
    writeJsonAtomic(path.join(dir, INPUT_SNAPSHOT_FILE), {
      before: beforeSnapshot,
      after: afterSnapshot,
      changed_files: changedInputs,
      stable: changedInputs.length === 0,
    });
  }
  return report;
}

module.exports = {
  INTEGRITY_REPORT_FILE,
  INPUT_SNAPSHOT_FILE,
  VOLATILE_NORMALIZE_INPUTS,
  resolveJobRunDir,
  captureNormalizeInputs,
  changedNormalizeInputs,
  evaluateNormalizationIntegrity,
};
