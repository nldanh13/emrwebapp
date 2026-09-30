// Mô hình trạng thái Kho nghiên cứu: tổng quan dữ liệu, trạng thái từng lượt/phần, so sánh tiến độ giữa hai lần làm mới.
import { parseDateTime, text, pick, lower } from './researchFormat.js';
import { datasetCount } from './researchScope.js';
import { C } from '../../tokens.js';

function overviewStatusReady(row) {
  return statusIsDone(row?.overall_status) || String(row?.ready_for_analysis || '') === '1';
}

function overviewDone(row, fields = []) {
  return fields.some(field => statusIsDone(row?.[field]));
}

function overviewDateLabel(value) {
  const d = parseDateTime(value);
  if (!d || Number.isNaN(d.getTime())) return text(value);
  return d.toLocaleDateString('vi-VN');
}

function buildGeneralOverviewModel({
  patientRows = [],
  encounterRows = [],
  statusRows = [],
  coverage = null,
  progressSnapshot = null,
  source = null,
  isArchive = true,
  limited = false,
  patientCount = 0,
  encounterCount = 0,
}) {
  const people = new Map();
  const patientList = Array.isArray(patientRows) ? patientRows : [];
  const encounterList = Array.isArray(encounterRows) ? encounterRows : [];
  const statusList = Array.isArray(statusRows) ? statusRows : [];
  const hasStatusRows = statusList.length > 0;

  const overviewKey = (seed = {}, idx = 0) => {
    const encounterId = pick(seed, ['encounter_id', 'encounter_key']);
    const researchCode = pick(seed, ['research_code', 'Mã NC', 'Ma NC', 'first_research_code']);
    const patientCode = pick(seed, ['patient_code', 'Mã BN', 'Ma BN', 'MABN', 'ma_bn']);
    const patientName = pick(seed, ['patient_name', 'Họ tên', 'Ho ten', 'Tên BN', 'Ten BN', 'ho_ten']);
    const rowHash = pick(seed, ['row_hash']);
    return encounterId || researchCode || patientCode || rowHash || `${patientName || 'row'}_${idx}`;
  };

  const ensure = (seed = {}, idx = 0, allowCreate = true) => {
    const researchCode = pick(seed, ['research_code', 'Mã NC', 'Ma NC', 'first_research_code']);
    const patientCode = pick(seed, ['patient_code', 'Mã BN', 'Ma BN', 'MABN', 'ma_bn']);
    const patientName = pick(seed, ['patient_name', 'Họ tên', 'Ho ten', 'Tên BN', 'Ten BN', 'ho_ten']);
    const key = overviewKey(seed, idx);
    if (!people.has(key)) {
      if (!allowCreate) return null;
      people.set(key, {
        key,
        research_code: researchCode,
        patient_code: patientCode,
        patient_name: patientName,
        encounter_count: 0,
        admissions: [],
        discharges: [],
        diagnoses: [],
        lab_count: 0,
        imaging_count: 0,
        surgery_count: 0,
        medication_count: 0,
        profile_done: false,
        discharge_done: false,
        surgery_done: false,
        order_done: false,
        xn_done: false,
        cdha_done: false,
        ready_count: 0,
        status_count: 0,
        missing: new Set(),
        last_error: '',
      });
    }
    const item = people.get(key);
    if (!item.research_code) item.research_code = researchCode;
    if (!item.patient_code) item.patient_code = patientCode;
    if (!item.patient_name) item.patient_name = patientName;
    return item;
  };

  const applyEncounter = (row, idx, allowCreate = true) => {
    const item = ensure(row, idx, allowCreate);
    if (!item) return;
    item.encounter_count += 1;
    const admission = pick(row, ['admission_datetime', 'admission_date', 'Ngày vào viện', 'Ngày nhập viện', 'T/G vào', 'tg_vao']);
    const discharge = pick(row, ['discharge_datetime', 'discharge_date', 'Ngày ra viện', 'ngay_ra_vien']);
    const diagnosis = pick(row, ['diagnosis_raw', 'primary_diagnosis', 'discharge_diagnosis', 'Chẩn đoán', 'chan_doan']);
    if (admission) item.admissions.push(admission);
    if (discharge) item.discharges.push(discharge);
    if (diagnosis && !item.diagnoses.includes(diagnosis)) item.diagnoses.push(diagnosis);
  };

  const applyStatus = (row, idx) => {
    const item = ensure(row, idx, true);
    if (!item) return;
    item.status_count += 1;
    if (overviewStatusReady(row)) item.ready_count += 1;
    item.lab_count += Number(row?.lab_count || 0);
    item.imaging_count += Number(row?.imaging_count || 0);
    item.surgery_count += Number(row?.surgery_count || 0);
    item.medication_count += Number(row?.medication_count || 0);
    item.profile_done = item.profile_done || overviewDone(row, ['profile_status']);
    item.discharge_done = item.discharge_done || overviewDone(row, ['discharge_status']);
    item.surgery_done = item.surgery_done || overviewDone(row, ['surgery_status']) || Number(row?.surgery_count || 0) > 0;
    item.order_done = item.order_done || overviewDone(row, ['order_history_status']) || Number(row?.medication_count || 0) > 0;
    item.xn_done = item.xn_done || overviewDone(row, ['xn_status', 'popup_status']) || Number(row?.lab_count || 0) > 0;
    item.cdha_done = item.cdha_done || overviewDone(row, ['cdha_status', 'popup_status']) || Number(row?.imaging_count || 0) > 0;
    for (const label of missingLabelsForStatusRow(row)) item.missing.add(label);
    const err = pick(row, ['last_error', 'Lỗi cuối', 'error']);
    if (err) item.last_error = err;
  };

  // Bảng phía dưới là bảng theo dõi tiến độ, vì vậy extract_status là nguồn gốc.
  // Chỉ dùng encounters để bổ sung ngày/chẩn đoán cho đúng cùng encounter_id/Mã NC;
  // không union toàn bộ patients + encounters + progress vì khi ẩn định danh các
  // khóa patient_code bị loại, làm một người/lượt bị đếm thành nhiều dòng.
  if (hasStatusRows) {
    statusList.forEach(applyStatus);
    encounterList.forEach((row, idx) => applyEncounter(row, idx, false));
  } else if (encounterList.length) {
    encounterList.forEach((row, idx) => applyEncounter(row, idx, true));
  } else {
    patientList.forEach((row, idx) => ensure(row, idx, true));
  }

  const sortDates = values => [...values].sort((a, b) => {
    const da = parseDateTime(a);
    const db = parseDateTime(b);
    return (db?.getTime?.() || 0) - (da?.getTime?.() || 0);
  });

  const rows = [...people.values()].map(item => {
    const admissions = sortDates(item.admissions);
    const discharges = sortDates(item.discharges);
    const missing = [...item.missing];
    const ready = item.status_count > 0 && item.ready_count === item.status_count && !missing.length && !item.last_error;
    return {
      ...item,
      admission_date: overviewDateLabel(admissions[0] || ''),
      discharge_date: overviewDateLabel(discharges[0] || ''),
      diagnosis: item.diagnoses[0] || '',
      missing_text: missing.join(', '),
      status_label: item.last_error ? 'Lỗi/cần xem' : ready ? 'Đủ dữ liệu' : missing.length ? 'Còn thiếu' : item.status_count ? 'Đang hoàn thiện' : 'Chưa có tiến độ',
      status_tone: item.last_error ? 'danger' : ready ? 'ok' : missing.length ? 'warn' : 'neutral',
      ready,
    };
  }).sort((a, b) => {
    const da = parseDateTime(a.admission_date);
    const db = parseDateTime(b.admission_date);
    return (db?.getTime?.() || 0) - (da?.getTime?.() || 0);
  });

  const allDates = [];
  for (const row of encounterRows || []) {
    for (const value of [
      pick(row, ['admission_datetime', 'admission_date', 'Ngày vào viện', 'T/G vào']),
      pick(row, ['discharge_datetime', 'discharge_date', 'Ngày ra viện']),
    ]) {
      const d = parseDateTime(value);
      if (d && !Number.isNaN(d.getTime())) allDates.push(d);
    }
  }
  allDates.sort((a, b) => a - b);

  // "Mức độ đầy đủ" phải phản ánh đúng đợt thu thập hiện tại.
  // Progress endpoint còn chứa cả các lượt đang chờ/đang lỗi chưa kịp ghi vào extract_status.csv,
  // nên không dùng số dòng extract_status làm mẫu số cho dashboard tổng quát.
  const statusSummary = progressSnapshot?.total
    ? progressSnapshot
    : summarizeStatusRows(statusRows, source, coverage, isArchive);
  const counts = coverage?.counts || {};
  const countOr = (...values) => {
    for (const value of values) {
      if (value === '' || value == null) continue;
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return 0;
  };
  const runFrom = source?.latest_run?.from_date || source?.scan_from_date || '';
  const runTo = source?.latest_run?.to_date || source?.scan_to_date || '';
  const runFromLabel = overviewDateLabel(runFrom);
  const runToLabel = overviewDateLabel(runTo);
  return {
    rows,
    row_kind: hasStatusRows ? 'monitor' : encounterList.length ? 'encounter' : 'patient',
    row_unit: hasStatusRows ? 'lượt' : encounterList.length ? 'đợt' : 'BN',
    statusSummary,
    counts: {
      // Tất cả card lấy từ cùng snapshot count của backend. Không dùng rows.length
      // vì rows là dữ liệu hiển thị/redacted và có thể bị giới hạn hoặc mất khóa join.
      patients: countOr(counts.patient_master, patientCount, patientList.length),
      encounters: countOr(counts.encounters, encounterCount, encounterList.length),
      patient_days: countOr(counts.patient_day),
      labs: countOr(counts.lab_results),
      imaging: countOr(counts.imaging_results),
      surgeries: countOr(counts.surgery_results),
      medications: countOr(counts.medication_orders),
      final_rows: countOr(counts.analysis_final, counts.analysis_ready),
    },
    date_from: runFromLabel || (allDates.length ? allDates[0].toLocaleDateString('vi-VN') : ''),
    date_to: runToLabel || (allDates.length ? allDates[allDates.length - 1].toLocaleDateString('vi-VN') : ''),
    run_id: progressSnapshot?.run_id || source?.latest_run?.id || '',
    limited: Boolean(limited),
  };
}

const RESEARCH_DATA_PARTS = [
  { key: 'xn_cdha', label: 'XN & CĐHA', fields: ['popup_status', 'xn_status', 'cdha_status'], countKeys: ['lab_count', 'imaging_count'] },
  { key: 'profile', label: 'Hồ sơ nền', fields: ['profile_status'], countKeys: [] },
  { key: 'discharge', label: 'Ra viện', fields: ['discharge_status'], countKeys: [] },
  { key: 'surgery', label: 'Phẫu thuật', fields: ['surgery_status'], countKeys: ['surgery_count'] },
  { key: 'order_history', label: 'Y lệnh', fields: ['order_history_status'], countKeys: ['medication_count'] },
];

const RESEARCH_STATUS_COMPARE_FIELDS = [
  'overall_status', 'completion_level', 'ready_for_analysis', 'missing_required', 'last_error',
  ...RESEARCH_DATA_PARTS.flatMap(part => [...part.fields, ...part.countKeys]),
];

function statusIsDone(v) {
  const s = lower(v);
  return s === 'done' || s === 'ok' || s === 'success' || s === '1' || s === 'true';
}

function statusIsMissing(v) {
  const s = lower(v);
  return !s || ['pending', 'error', 'failed', 'no_url', 'missing', 'incomplete', 'partial'].some(x => s.includes(x));
}

function patientStatusKey(row, idx = 0) {
  return pick(row, ['research_code', 'Mã NC', 'Ma NC'])
    || `${pick(row, ['patient_code', 'Mã BN', 'Ma BN', 'MABN']) || 'row'}_${idx}`;
}

function patientStatusLabel(row) {
  return pick(row, ['research_code', 'Mã NC', 'Ma NC']) || pick(row, ['patient_code', 'Mã BN', 'Ma BN', 'MABN']) || '—';
}

function patientStatusName(row) {
  return pick(row, ['patient_name', 'Họ tên', 'Ho ten', 'Tên BN', 'Ten BN']) || '—';
}

function missingLabelsForStatusRow(row) {
  if (!row) return [];
  const labels = [];
  const missingRaw = lower(row.missing_required || row['missing_required']);
  for (const part of RESEARCH_DATA_PARTS) {
    const firstWord = lower(part.label).split(' ')[0];
    const explicitMissing = Boolean(missingRaw && (missingRaw.includes(part.key) || missingRaw.includes(firstWord)));
    const partDone = part.fields.every(f => statusIsDone(row[f]));
    const partMissing = part.fields.some(f => statusIsMissing(row[f]));
    if (explicitMissing || (!partDone && partMissing)) labels.push(part.label);
  }
  return Array.from(new Set(labels));
}

function summarizeStatusRows(rows = [], source = null, coverage = null, isArchive = false) {
  const arr = Array.isArray(rows) ? rows : [];
  const total = arr.length || Number(coverage?.extract?.total || 0) || datasetCount(source, isArchive ? 'initial_list' : 'cohort', isArchive) || 0;
  const ready = arr.length
    ? arr.filter(r => statusIsDone(r.overall_status) || String(r.ready_for_analysis || '') === '1').length
    : Number(coverage?.extract?.ready || 0);
  const modules = RESEARCH_DATA_PARTS.map(part => {
    const done = arr.length
      ? arr.filter(r => part.fields.every(f => statusIsDone(r[f]))).length
      : Number(coverage?.extract?.file_done?.[part.key] || 0);
    return { ...part, done, missing: Math.max(0, total - done) };
  });
  const monitorRows = arr.map((row, idx) => {
    const missing = missingLabelsForStatusRow(row);
    const hasError = Boolean(pick(row, ['last_error', 'Lỗi cuối', 'error']));
    const isReady = statusIsDone(row.overall_status) || String(row.ready_for_analysis || '') === '1';
    const state = isReady ? 'done' : hasError ? 'error' : missing.length ? 'missing' : 'waiting';
    return {
      key: patientStatusKey(row, idx),
      sample: patientStatusLabel(row),
      patient_code: pick(row, ['patient_code', 'Mã BN', 'Ma BN', 'MABN']),
      patient_name: patientStatusName(row),
      state,
      state_label: isReady ? 'Đủ dữ liệu' : hasError ? 'Lỗi/cần xem' : missing.length ? 'Còn thiếu' : 'Chưa lấy đủ',
      missing: missing.join(', '),
      xn_cdha: missing.includes('XN & CĐHA') ? 'Chưa lấy' : 'Đã lấy',
      profile: missing.includes('Hồ sơ nền') ? 'Chưa lấy' : 'Đã lấy',
      discharge: missing.includes('Ra viện') ? 'Chưa lấy' : 'Đã lấy',
      surgery: missing.includes('Phẫu thuật') ? 'Chưa lấy' : 'Đã lấy',
      order_history: missing.includes('Y lệnh') ? 'Chưa lấy' : 'Đã lấy',
      last_error: pick(row, ['last_error', 'Lỗi cuối', 'error']),
      updated_at: pick(row, ['updated_at', 'finished_at', 'started_at']),
    };
  });
  const missingRows = monitorRows.filter(r => text(r.missing) || text(r.last_error)).slice(0, 200);
  return {
    total,
    ready,
    missingCount: Math.max(0, total - ready),
    manualReview: Number(coverage?.extract?.manual_review || 0),
    modules,
    missingRows,
    rows: monitorRows.slice(0, 500),
    counts: {
      running: monitorRows.filter(r => r.state === 'running').length,
      error: monitorRows.filter(r => r.state === 'error').length,
      missing: monitorRows.filter(r => r.state === 'missing').length,
      waiting: monitorRows.filter(r => r.state === 'waiting').length,
      done: monitorRows.filter(r => r.state === 'done').length,
    },
  };
}

function diffStatusRows(beforeRows = [], afterRows = [], title = 'Cập nhật dữ liệu') {
  const beforeMap = new Map((Array.isArray(beforeRows) ? beforeRows : []).map((row, idx) => [patientStatusKey(row, idx), row]));
  const outRows = [];
  for (const [idx, row] of (Array.isArray(afterRows) ? afterRows : []).entries()) {
    const key = patientStatusKey(row, idx);
    const old = beforeMap.get(key);
    const changedFields = RESEARCH_STATUS_COMPARE_FIELDS.filter(f => text(old?.[f]) !== text(row?.[f]));
    if (!changedFields.length && old) continue;
    const updatedParts = RESEARCH_DATA_PARTS.filter(part => {
      const partChanged = part.fields.concat(part.countKeys).some(f => changedFields.includes(f));
      const nowDone = part.fields.every(f => statusIsDone(row[f]));
      return partChanged || (!old && nowDone);
    }).map(part => part.label);
    outRows.push({
      key,
      sample: patientStatusLabel(row),
      patient_code: pick(row, ['patient_code', 'Mã BN', 'Ma BN', 'MABN']),
      patient_name: patientStatusName(row),
      updated: updatedParts.length ? Array.from(new Set(updatedParts)).join(', ') : 'Trạng thái mẫu',
      missing: missingLabelsForStatusRow(row).join(', '),
      result: statusIsDone(row.overall_status) || String(row.ready_for_analysis || '') === '1' ? 'Đủ dữ liệu' : (pick(row, ['overall_status', 'completion_level']) || 'Đã cập nhật'),
    });
  }
  return { title, at: new Date().toLocaleString('vi-VN'), totalChanged: outRows.length, rows: outRows.slice(0, 120) };
}

function diffProgressSnapshots(before = null, after = null, title = 'Cập nhật dữ liệu') {
  const beforeKeys = new Set((before?.recentUpdates || []).map(row => `${row.key || row.sample}|${row.updated}|${row.updated_at || ''}`));
  let rows = (after?.recentUpdates || []).filter(row => !beforeKeys.has(`${row.key || row.sample}|${row.updated}|${row.updated_at || ''}`));
  if (!rows.length) rows = (after?.recentUpdates || []).slice(0, 20);
  return { title, at: new Date().toLocaleString('vi-VN'), totalChanged: rows.length, rows: rows.slice(0, 120) };
}

function statusToneForMonitor(value, state = '') {
  const raw = lower(value || state);
  if (raw.includes('đang') || raw.includes('running')) return { c: C.blue, bg: C.blueBg, b: C.blueBorder };
  if (raw.includes('lỗi') || raw.includes('error') || raw.includes('fail') || raw.includes('timeout')) return { c: C.red, bg: C.redBg, b: C.redBorder };
  if (raw.includes('một phần') || raw.includes('partial') || raw.includes('thiếu') || raw.includes('chưa')) return { c: C.amber, bg: C.amberBg, b: C.amberBorder };
  if (raw.includes('đã lấy') || raw.includes('đủ') || raw.includes('done') || raw.includes('ok')) return { c: C.green, bg: C.greenBg, b: C.greenBorder };
  return { c: C.text3, bg: C.surface2, b: C.border2 };
}

function statusDotTone(state) {
  if (state === 'running') return { bg: C.blue, soft: C.blueBg, border: C.blueBorder, text: C.blue };
  if (state === 'error') return { bg: C.red, soft: C.redBg, border: C.redBorder, text: C.red };
  if (state === 'missing' || state === 'waiting') return { bg: C.amber, soft: C.amberBg, border: C.amberBorder, text: C.amber };
  if (state === 'done') return { bg: C.green, soft: C.greenBg, border: C.greenBorder, text: C.green };
  return { bg: C.text3, soft: C.surface2, border: C.border2, text: C.text3 };
}

export {
  overviewStatusReady,
  overviewDone,
  overviewDateLabel,
  buildGeneralOverviewModel,
  RESEARCH_DATA_PARTS,
  RESEARCH_STATUS_COMPARE_FIELDS,
  statusIsDone,
  statusIsMissing,
  patientStatusKey,
  patientStatusLabel,
  patientStatusName,
  missingLabelsForStatusRow,
  summarizeStatusRows,
  diffStatusRows,
  diffProgressSnapshots,
  statusToneForMonitor,
  statusDotTone,
};
