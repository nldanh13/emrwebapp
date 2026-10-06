'use strict';

// Lớp bảo vệ cho màn Tra cứu người bệnh.
// Không sửa dữ liệu nguồn; chỉ dựng một view an toàn có provenance/integrity rõ ràng.

function text(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalize(value) {
  return text(value).toLowerCase();
}

function stableKey(value) {
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

function first(row, keys) {
  for (const key of keys || []) {
    const value = text(row?.[key]);
    if (value) return value;
  }
  return '';
}

function parseDateParts(value) {
  const s = text(value);
  if (!s) return null;
  let m = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return {
    y: m[1], mo: String(m[2]).padStart(2, '0'), d: String(m[3]).padStart(2, '0'),
    h: m[4] == null ? '' : String(m[4]).padStart(2, '0'), mi: m[5] || '', s: m[6] || '',
  };
  m = s.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return {
    y: m[3], mo: String(m[2]).padStart(2, '0'), d: String(m[1]).padStart(2, '0'),
    h: m[4] == null ? '' : String(m[4]).padStart(2, '0'), mi: m[5] || '', s: m[6] || '',
  };
  return null;
}

function dayKey(value) {
  const p = parseDateParts(value);
  return p ? `${p.y}-${p.mo}-${p.d}` : '';
}

function timeKey(value) {
  const p = parseDateParts(value);
  if (!p) return '';
  const day = `${p.y}-${p.mo}-${p.d}`;
  if (!p.h) return day;
  return `${day} ${p.h}:${p.mi || '00'}:${p.s || '00'}`;
}

const EVENT_DATE_KEYS = {
  labs: ['lab_datetime', 'lab_date', 'ordered_at', 'order_datetime', 'TG xét nghiệm', 'Thời gian xét nghiệm', 'TG chỉ định', 'Ngày chỉ định', 'Thời gian', 'Ngày'],
  imaging: ['ordered_at', 'order_datetime', 'performed_at', 'result_datetime', 'order_date', 'TG chỉ định', 'Ngày chỉ định', 'Thời gian', 'Ngày'],
  medications: ['order_datetime', 'ordered_at', 'order_date', 'start_datetime', 'start_date', 'TG y lệnh', 'Thời gian y lệnh', 'Ngày y lệnh', 'TG chỉ định', 'Ngày chỉ định', 'Thời gian', 'Ngày'],
  surgeries: ['surgery_datetime', 'surgery_date', 'operation_datetime', 'operation_date', 'Ngày mổ', 'Ngày phẫu thuật', 'Thời gian phẫu thuật', 'Thời gian', 'Ngày'],
};

function eventRawTime(kind, row) {
  return first(row, EVENT_DATE_KEYS[kind] || []);
}

function eventDay(kind, row) {
  return dayKey(eventRawTime(kind, row));
}

function eventTime(kind, row) {
  return timeKey(eventRawTime(kind, row));
}

function eventPatientCode(row) {
  return first(row, ['patient_code', 'Mã BN', 'Ma BN', 'ma_bn']);
}

const STRONG_ID_KEYS = {
  encounter_id: ['encounter_id', 'Encounter ID'],
  treatment_id: ['emr_treatment_id', 'treatment_id', 'Mã điều trị', 'Ma dieu tri'],
  admission_id: ['emr_admission_id', 'admission_id', 'Mã vào viện', 'Ma vao vien'],
  noitruid: ['noitruid', 'noi_tru_id', 'NoiTruID'],
  visit_id: ['visit_id', 'episode_id'],
};

function strongIds(row) {
  const out = {};
  for (const [name, keys] of Object.entries(STRONG_ID_KEYS)) {
    const value = first(row, keys);
    if (value) out[name] = value;
  }
  return out;
}

function strongIdConflict(row, encounter) {
  const a = strongIds(row);
  const b = strongIds(encounter);
  for (const key of Object.keys(a)) {
    if (b[key] && a[key] !== b[key]) return key;
  }
  return '';
}

function classifyEvent(kind, row, encounter) {
  const reasons = [];
  const patient = text(encounter?.patient_code);
  const rowPatient = eventPatientCode(row);
  if (patient && rowPatient && patient !== rowPatient) {
    return { status: 'rejected', reasons: ['patient_code_mismatch'] };
  }

  const idConflict = strongIdConflict(row, encounter);
  if (idConflict) return { status: 'rejected', reasons: [`strong_id_mismatch:${idConflict}`] };

  const start = dayKey(encounter?.admission_date);
  const end = dayKey(encounter?.discharge_date);
  const event = eventDay(kind, row);
  if (event && start && event < start) return { status: 'rejected', reasons: ['before_admission'] };
  if (event && end && event > end) return { status: 'rejected', reasons: ['after_discharge'] };

  if (!event) reasons.push('missing_event_time');
  if (!start) reasons.push('missing_admission_time');
  if (start && !end) reasons.push('open_encounter_no_discharge');

  return { status: reasons.length ? 'ambiguous' : 'verified', reasons };
}

function isEventInsideEncounter(kind, row, encounter) {
  return classifyEvent(kind, row, encounter).status !== 'rejected';
}

function clinicalEventKey(kind, row) {
  // Dùng timestamp đầy đủ nếu có. Không được hạ xuống chỉ còn ngày vì có thể có nhiều
  // XN/y lệnh hợp lệ giống nhau trong cùng ngày.
  const at = eventTime(kind, row) || normalize(eventRawTime(kind, row));
  if (kind === 'labs') return [
    at,
    normalize(first(row, ['test_name_raw', 'test_name', 'Chỉ số', 'Tên xét nghiệm', 'Xét nghiệm'])),
    normalize(first(row, ['result_raw', 'result_num', 'Kết quả'])),
    normalize(first(row, ['unit_raw', 'unit', 'Đơn vị'])),
    normalize(first(row, ['reference_raw', 'reference_range', 'Khoảng tham chiếu'])),
  ].join('|');
  if (kind === 'imaging') return [
    at,
    normalize(first(row, ['service_name_raw', 'service_name', 'Tên dịch vụ', 'Dịch vụ'])),
    normalize(first(row, ['conclusion_raw', 'conclusion', 'Kết luận'])),
    normalize(first(row, ['description_raw', 'description', 'Mô tả/Kết quả', 'Kết quả'])),
  ].join('|');
  if (kind === 'medications') return [
    at,
    normalize(first(row, ['medication_name_raw', 'medication_name', 'drug_name', 'Tên thuốc', 'Thuốc'])),
    normalize(first(row, ['active_ingredient', 'active_ingredient_raw', 'Hoạt chất'])),
    normalize(first(row, ['dose_raw', 'dose', 'Liều dùng', 'Liều'])),
    normalize(first(row, ['route_raw', 'route', 'Đường dùng'])),
    normalize(first(row, ['frequency_raw', 'frequency', 'Số lần dùng', 'Tần suất'])),
    normalize(first(row, ['quantity_raw', 'quantity', 'Số lượng'])),
  ].join('|');
  if (kind === 'surgeries') return [
    at,
    normalize(first(row, ['surgery_name_raw', 'surgery_name', 'procedure_name', 'Tên PT/TT', 'Tên phẫu thuật', 'Phẫu thuật/thủ thuật'])),
    normalize(first(row, ['method_raw', 'method', 'Phương pháp', 'Phương pháp PT'])),
    normalize(first(row, ['anesthesia_raw', 'anesthesia', 'Vô cảm', 'Phương pháp vô cảm'])),
    normalize(first(row, ['surgeon_raw', 'surgeon', 'Phẫu thuật viên'])),
  ].join('|');
  return stableKey(row);
}

function annotateIntegrity(row, verdict) {
  return {
    ...row,
    _integrity_status: verdict.status,
    _integrity_reasons: verdict.reasons,
  };
}

function sanitizeEventRows(kind, rows = [], encounter = {}) {
  const out = [];
  const seen = new Set();
  const stats = { verified: 0, ambiguous: 0, rejected: 0, deduplicated: 0 };
  const reasons = {};
  for (const row of rows || []) {
    const verdict = classifyEvent(kind, row, encounter);
    for (const reason of verdict.reasons) reasons[reason] = (reasons[reason] || 0) + 1;
    if (verdict.status === 'rejected') {
      stats.rejected += 1;
      continue;
    }
    let key = clinicalEventKey(kind, row);
    if (!key.replace(/\|/g, '')) key = stableKey(row);
    if (seen.has(key)) {
      stats.deduplicated += 1;
      reasons.duplicate_clinical_event = (reasons.duplicate_clinical_event || 0) + 1;
      continue;
    }
    seen.add(key);
    stats[verdict.status] += 1;
    out.push(annotateIntegrity(row, verdict));
  }
  return {
    rows: out,
    excluded: stats.rejected + stats.deduplicated,
    stats,
    reasons,
  };
}

function unionRows(a = [], b = []) {
  const seen = new Set();
  const out = [];
  for (const row of [...a, ...b]) {
    const key = stableKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function sameDisplayStay(a, b) {
  const patientA = text(a?.patient_code);
  const patientB = text(b?.patient_code);
  if (!patientA || patientA !== patientB) return false;

  const idsA = strongIds(a);
  const idsB = strongIds(b);
  for (const key of Object.keys(idsA)) {
    if (idsB[key] && idsA[key] === idsB[key]) return true;
  }

  const admissionA = timeKey(a?.admission_date) || dayKey(a?.admission_date);
  const admissionB = timeKey(b?.admission_date) || dayKey(b?.admission_date);
  if (!admissionA || admissionA !== admissionB) return false;

  const dischargeA = timeKey(a?.discharge_date) || dayKey(a?.discharge_date);
  const dischargeB = timeKey(b?.discharge_date) || dayKey(b?.discharge_date);
  if (dischargeA && dischargeB && dischargeA !== dischargeB) return false;
  return true;
}

function mergeDisplayStay(base, incoming) {
  const preferred = { ...(base || {}) };
  for (const [key, value] of Object.entries(incoming || {})) {
    if ((preferred[key] === '' || preferred[key] === null || preferred[key] === undefined) && value !== '' && value !== null && value !== undefined) preferred[key] = value;
  }
  preferred.labs = unionRows(base?.labs, incoming?.labs);
  preferred.imaging = unionRows(base?.imaging, incoming?.imaging);
  preferred.medications = unionRows(base?.medications, incoming?.medications);
  preferred.surgeries = unionRows(base?.surgeries, incoming?.surgeries);
  if (!text(preferred.discharge_date) && text(incoming?.discharge_date)) preferred.discharge_date = incoming.discharge_date;
  if (!text(preferred.diagnosis_raw) && text(incoming?.diagnosis_raw)) preferred.diagnosis_raw = incoming.diagnosis_raw;
  return preferred;
}

function sanitizeEncounterEvents(encounter) {
  const enc = { ...(encounter || {}) };
  const excluded = {};
  const integrity = { status: 'verified', critical: 0, ambiguous: 0, rejected: 0, deduplicated: 0, by_kind: {}, reasons: {} };

  if (enc.unmatched) {
    for (const kind of ['labs', 'imaging', 'medications', 'surgeries']) {
      const patient = text(enc.patient_code);
      const samePatient = (enc[kind] || []).filter(row => {
        const rowPatient = eventPatientCode(row);
        return !patient || !rowPatient || patient === rowPatient;
      });
      const deduped = [];
      const seen = new Set();
      for (const row of samePatient) {
        let key = clinicalEventKey(kind, row);
        if (!key.replace(/\|/g, '')) key = stableKey(row);
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(row);
      }
      enc[kind] = deduped;
      excluded[kind] = Math.max(0, Number((encounter?.[kind] || []).length) - deduped.length);
    }
    enc.counts = {
      labs: enc.labs.length,
      imaging: enc.imaging.length,
      medications: enc.medications.length,
      surgeries: enc.surgeries.length,
    };
    enc.excluded_counts = excluded;
    // Dòng chưa gắn được lượt nào: không thuộc lượt để kiểm khoảng thời gian.
    integrity.status = 'unassigned';
    enc.integrity = integrity;
    return enc;
  }
  for (const kind of ['labs', 'imaging', 'medications', 'surgeries']) {
    const result = sanitizeEventRows(kind, enc[kind], enc);
    enc[kind] = result.rows;
    excluded[kind] = result.excluded;
    integrity.by_kind[kind] = result.stats;
    integrity.ambiguous += result.stats.ambiguous;
    integrity.rejected += result.stats.rejected;
    integrity.deduplicated += result.stats.deduplicated;
    for (const [reason, count] of Object.entries(result.reasons)) integrity.reasons[reason] = (integrity.reasons[reason] || 0) + count;
  }

  // Các mismatch/ngoài cửa sổ là lỗi critical vì có nguy cơ gắn nhầm ca; duplicate là warning.
  integrity.critical = Object.entries(integrity.reasons)
    .filter(([reason]) => /mismatch|before_admission|after_discharge/.test(reason))
    .reduce((sum, [, count]) => sum + count, 0);
  if (integrity.critical > 0) integrity.status = 'critical';
  else if (integrity.ambiguous > 0) integrity.status = 'ambiguous';
  else if (integrity.deduplicated > 0) integrity.status = 'verified_with_dedup';

  enc.counts = {
    labs: enc.labs.length,
    imaging: enc.imaging.length,
    medications: enc.medications.length,
    surgeries: enc.surgeries.length,
  };
  enc.excluded_counts = excluded;
  enc.integrity = integrity;

  const surgeryDates = enc.surgeries
    .map(row => ({ raw: first(row, EVENT_DATE_KEYS.surgeries), key: eventTime('surgeries', row) }))
    .filter(x => x.raw)
    .sort((a, b) => xSafe(a.key).localeCompare(xSafe(b.key)));
  if (surgeryDates.length) enc.surgery_date = surgeryDates[0].raw;
  else {
    const current = dayKey(enc.surgery_date);
    const start = dayKey(enc.admission_date);
    const end = dayKey(enc.discharge_date);
    if (current && start && (current < start || (end && current > end))) enc.surgery_date = '';
  }
  return enc;
}

function xSafe(value) { return text(value); }

function collapseDisplayEncounters(encounters = []) {
  const out = [];
  for (const enc of encounters || []) {
    const idx = out.findIndex(current => sameDisplayStay(current, enc));
    if (idx < 0) out.push({ ...enc });
    else out[idx] = mergeDisplayStay(out[idx], enc);
  }
  return out
    .map(sanitizeEncounterEvents)
    .sort((a, b) => {
      if (Boolean(a.unmatched) !== Boolean(b.unmatched)) return a.unmatched ? 1 : -1;
      return text(a.admission_date).localeCompare(text(b.admission_date));
    });
}

function splitPatientByCode(patient, query) {
  const encounters = Array.isArray(patient?.encounters) ? patient.encounters : [];
  const codes = new Set();
  for (const code of patient?.patient_codes || []) if (text(code)) codes.add(text(code));
  if (text(patient?.patient_code)) codes.add(text(patient.patient_code));
  for (const enc of encounters) if (text(enc?.patient_code)) codes.add(text(enc.patient_code));

  const exactQueryCode = [...codes].find(code => normalize(code) === normalize(query));
  const selectedCodes = exactQueryCode ? [exactQueryCode] : [...codes];
  if (!selectedCodes.length) return [patient];

  return selectedCodes.map(code => {
    const codeEncounters = collapseDisplayEncounters(encounters.filter(enc => text(enc?.patient_code) === code));
    const researchCodes = codeEncounters.map(enc => text(enc?.research_code)).filter(Boolean).sort();
    const critical = codeEncounters.reduce((sum, enc) => sum + Number(enc.integrity?.critical || 0), 0);
    const ambiguous = codeEncounters.reduce((sum, enc) => sum + Number(enc.integrity?.ambiguous || 0), 0);
    return {
      ...patient,
      patient_code: code,
      patient_codes: [code],
      first_research_code: researchCodes[0] || (selectedCodes.length === 1 ? patient.first_research_code : ''),
      encounter_count: codeEncounters.filter(enc => !enc.unmatched).length,
      unassigned_count: codeEncounters.filter(enc => enc.unmatched).reduce((sum, enc) =>
        sum + Number(enc.counts?.labs || 0) + Number(enc.counts?.imaging || 0)
          + Number(enc.counts?.medications || 0) + Number(enc.counts?.surgeries || 0), 0),
      possible_same_patient_codes: false,
      merge_reason: '',
      integrity: { status: critical ? 'critical' : ambiguous ? 'ambiguous' : 'verified', critical, ambiguous },
      encounters: codeEncounters,
    };
  }).filter(patientRow => patientRow.encounter_count > 0 || selectedCodes.length === 1);
}

function sanitizePatientHistory(payload, query = '') {
  if (!payload || typeof payload !== 'object' || payload.selection_required) return payload;
  const out = [];
  for (const patient of payload.patients || []) out.push(...splitPatientByCode(patient, query));
  const critical = out.reduce((sum, patient) => sum + Number(patient.integrity?.critical || 0), 0);
  const ambiguous = out.reduce((sum, patient) => sum + Number(patient.integrity?.ambiguous || 0), 0);
  return {
    ...payload,
    patients: out,
    total_matches: out.length,
    integrity: { status: critical ? 'critical' : ambiguous ? 'ambiguous' : 'verified', critical, ambiguous },
  };
}

let installed = false;
function installPatientHistoryGuard() {
  if (installed) return;
  const history = require('./patient_history');
  const original = history.buildPatientHistory;
  if (typeof original !== 'function') return;
  history.buildPatientHistory = function guardedBuildPatientHistory(runDir, query) {
    return sanitizePatientHistory(original(runDir, query), query);
  };
  installed = true;
}

module.exports = {
  dayKey,
  timeKey,
  eventDay,
  eventTime,
  strongIds,
  strongIdConflict,
  classifyEvent,
  isEventInsideEncounter,
  clinicalEventKey,
  sanitizeEventRows,
  sanitizeEncounterEvents,
  sameDisplayStay,
  mergeDisplayStay,
  collapseDisplayEncounters,
  splitPatientByCode,
  sanitizePatientHistory,
  installPatientHistoryGuard,
};
