'use strict';

// Lớp bảo vệ cho màn Tra cứu người bệnh.
// Mục tiêu: dữ liệu lịch sử cũ đã chuẩn hóa trước khi sửa logic encounter vẫn phải
// hiển thị an toàn: không tự gộp hai Mã BN khác nhau chỉ vì trùng tên/giới/tuổi,
// không hiển thị hai "Đợt" cho cùng một lần nhập viện, và không gắn XN/CĐHA/
// thuốc/phẫu thuật nằm ngoài cửa sổ của lượt điều trị đang hiển thị.

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

function dayKey(value) {
  const s = text(value);
  if (!s) return '';
  let m = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = s.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\b/);
  if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  return '';
}

const EVENT_DATE_KEYS = {
  labs: [
    'lab_datetime', 'lab_date', 'ordered_at', 'order_datetime',
    'TG xét nghiệm', 'Thời gian xét nghiệm', 'TG chỉ định', 'Ngày chỉ định', 'Thời gian', 'Ngày',
  ],
  imaging: [
    'ordered_at', 'order_datetime', 'performed_at', 'result_datetime', 'order_date',
    'TG chỉ định', 'Ngày chỉ định', 'Thời gian', 'Ngày',
  ],
  medications: [
    'order_datetime', 'ordered_at', 'order_date', 'start_datetime', 'start_date',
    'TG y lệnh', 'Thời gian y lệnh', 'Ngày y lệnh', 'TG chỉ định', 'Ngày chỉ định', 'Thời gian', 'Ngày',
  ],
  surgeries: [
    'surgery_datetime', 'surgery_date', 'operation_datetime', 'operation_date',
    'Ngày mổ', 'Ngày phẫu thuật', 'Thời gian phẫu thuật', 'Thời gian', 'Ngày',
  ],
};

function eventDay(kind, row) {
  return dayKey(first(row, EVENT_DATE_KEYS[kind] || []));
}

function eventPatientCode(row) {
  return first(row, ['patient_code', 'Mã BN', 'Ma BN', 'ma_bn']);
}

function eventEncounterId(row) {
  return first(row, ['encounter_id', 'Encounter ID', 'visit_id']);
}

function isEventInsideEncounter(kind, row, encounter) {
  const patient = text(encounter?.patient_code);
  const rowPatient = eventPatientCode(row);
  if (patient && rowPatient && patient !== rowPatient) return false;

  const encId = text(encounter?.encounter_id);
  const rowEncId = eventEncounterId(row);
  if (encId && rowEncId && encId !== rowEncId) return false;

  const start = dayKey(encounter?.admission_date);
  const end = dayKey(encounter?.discharge_date);
  const event = eventDay(kind, row);
  // Không có ngày sự kiện thì không tự loại: ID đợt/người bệnh vẫn có thể là bằng chứng duy nhất.
  if (!event || !start) return true;
  if (event < start) return false;
  if (end && event > end) return false;
  return true;
}

function clinicalEventKey(kind, row) {
  const at = eventDay(kind, row) || normalize(first(row, EVENT_DATE_KEYS[kind] || []));
  if (kind === 'labs') {
    return [
      at,
      normalize(first(row, ['test_name_raw', 'test_name', 'Chỉ số', 'Tên xét nghiệm', 'Xét nghiệm'])),
      normalize(first(row, ['result_raw', 'result_num', 'Kết quả'])),
      normalize(first(row, ['unit_raw', 'unit', 'Đơn vị'])),
      normalize(first(row, ['reference_raw', 'reference_range', 'Khoảng tham chiếu'])),
    ].join('|');
  }
  if (kind === 'imaging') {
    return [
      at,
      normalize(first(row, ['service_name_raw', 'service_name', 'Tên dịch vụ', 'Dịch vụ'])),
      normalize(first(row, ['conclusion_raw', 'conclusion', 'Kết luận'])),
      normalize(first(row, ['description_raw', 'description', 'Mô tả/Kết quả', 'Kết quả'])),
    ].join('|');
  }
  if (kind === 'medications') {
    return [
      at,
      normalize(first(row, ['medication_name_raw', 'medication_name', 'drug_name', 'Tên thuốc', 'Thuốc'])),
      normalize(first(row, ['active_ingredient', 'active_ingredient_raw', 'Hoạt chất'])),
      normalize(first(row, ['dose_raw', 'dose', 'Liều dùng', 'Liều'])),
      normalize(first(row, ['route_raw', 'route', 'Đường dùng'])),
      normalize(first(row, ['frequency_raw', 'frequency', 'Số lần dùng', 'Tần suất'])),
      normalize(first(row, ['quantity_raw', 'quantity', 'Số lượng'])),
    ].join('|');
  }
  if (kind === 'surgeries') {
    return [
      at,
      normalize(first(row, ['surgery_name_raw', 'surgery_name', 'procedure_name', 'Tên PT/TT', 'Tên phẫu thuật', 'Phẫu thuật/thủ thuật'])),
      normalize(first(row, ['method_raw', 'method', 'Phương pháp', 'Phương pháp PT'])),
      normalize(first(row, ['anesthesia_raw', 'anesthesia', 'Vô cảm', 'Phương pháp vô cảm'])),
      normalize(first(row, ['surgeon_raw', 'surgeon', 'Phẫu thuật viên'])),
    ].join('|');
  }
  return stableKey(row);
}

function sanitizeEventRows(kind, rows = [], encounter = {}) {
  const out = [];
  const seen = new Set();
  let excluded = 0;
  for (const row of rows || []) {
    if (!isEventInsideEncounter(kind, row, encounter)) {
      excluded += 1;
      continue;
    }
    let key = clinicalEventKey(kind, row);
    // Nếu không có đủ nội dung lâm sàng để tạo khóa có nghĩa, dùng toàn bộ dòng.
    if (!key.replace(/\|/g, '')) key = stableKey(row);
    if (seen.has(key)) {
      excluded += 1;
      continue;
    }
    seen.add(key);
    out.push(row);
  }
  return { rows: out, excluded };
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

  const encounterA = text(a?.encounter_id);
  const encounterB = text(b?.encounter_id);
  if (encounterA && encounterB && encounterA === encounterB) return true;

  const admissionA = text(a?.admission_date);
  const admissionB = text(b?.admission_date);
  if (!admissionA || admissionA !== admissionB) return false;

  // Cùng thời điểm nhập viện nhưng hai ngày ra khác nhau rõ ràng: không tự gộp.
  const dischargeA = text(a?.discharge_date);
  const dischargeB = text(b?.discharge_date);
  if (dischargeA && dischargeB && dischargeA !== dischargeB) return false;

  return true;
}

function mergeDisplayStay(base, incoming) {
  const preferred = { ...(base || {}) };
  for (const [key, value] of Object.entries(incoming || {})) {
    if ((preferred[key] === '' || preferred[key] === null || preferred[key] === undefined) && value !== '' && value !== null && value !== undefined) {
      preferred[key] = value;
    }
  }

  preferred.labs = unionRows(base?.labs, incoming?.labs);
  preferred.imaging = unionRows(base?.imaging, incoming?.imaging);
  preferred.medications = unionRows(base?.medications, incoming?.medications);
  preferred.surgeries = unionRows(base?.surgeries, incoming?.surgeries);

  // Nếu một bản đã có ngày ra viện còn bản kia chưa có, giữ bản đầy đủ.
  if (!text(preferred.discharge_date) && text(incoming?.discharge_date)) preferred.discharge_date = incoming.discharge_date;
  if (!text(preferred.diagnosis_raw) && text(incoming?.diagnosis_raw)) preferred.diagnosis_raw = incoming.diagnosis_raw;
  return preferred;
}

function sanitizeEncounterEvents(encounter) {
  const enc = { ...(encounter || {}) };
  const excluded = {};
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
    return enc;
  }
  for (const kind of ['labs', 'imaging', 'medications', 'surgeries']) {
    const result = sanitizeEventRows(kind, enc[kind], enc);
    enc[kind] = result.rows;
    excluded[kind] = result.excluded;
  }
  enc.counts = {
    labs: enc.labs.length,
    imaging: enc.imaging.length,
    medications: enc.medications.length,
    surgeries: enc.surgeries.length,
  };
  enc.excluded_counts = excluded;

  // Không để ngày mổ tóm tắt tiếp tục hiển thị một ca nằm ngoài đợt. Nếu còn ca mổ
  // hợp lệ thì lấy ngày sớm nhất từ chính danh sách đã lọc; nếu không còn thì chỉ giữ
  // surgery_date cũ khi nó nằm trong cửa sổ đợt.
  const surgeryDates = enc.surgeries.map(row => first(row, EVENT_DATE_KEYS.surgeries)).filter(Boolean).sort();
  if (surgeryDates.length) enc.surgery_date = surgeryDates[0];
  else {
    const current = dayKey(enc.surgery_date);
    const start = dayKey(enc.admission_date);
    const end = dayKey(enc.discharge_date);
    if (current && start && (current < start || (end && current > end))) enc.surgery_date = '';
  }
  return enc;
}

function collapseDisplayEncounters(encounters = []) {
  const out = [];
  for (const enc of encounters || []) {
    const idx = out.findIndex(current => sameDisplayStay(current, enc));
    if (idx < 0) out.push({ ...enc });
    else out[idx] = mergeDisplayStay(out[idx], enc);
  }
  return out
    .map(sanitizeEncounterEvents)
    .sort((a, b) => text(a.admission_date).localeCompare(text(b.admission_date)));
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
    return {
      ...patient,
      patient_code: code,
      patient_codes: [code],
      first_research_code: researchCodes[0] || (selectedCodes.length === 1 ? patient.first_research_code : ''),
      encounter_count: codeEncounters.length,
      possible_same_patient_codes: false,
      merge_reason: '',
      encounters: codeEncounters,
    };
  }).filter(patientRow => patientRow.encounter_count > 0 || selectedCodes.length === 1);
}

function sanitizePatientHistory(payload, query = '') {
  if (!payload || typeof payload !== 'object' || payload.selection_required) return payload;
  const out = [];
  for (const patient of payload.patients || []) out.push(...splitPatientByCode(patient, query));
  return {
    ...payload,
    patients: out,
    total_matches: out.length,
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
  eventDay,
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
