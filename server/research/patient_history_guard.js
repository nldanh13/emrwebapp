'use strict';

// Lớp bảo vệ cho màn Tra cứu người bệnh.
// Mục tiêu: dữ liệu lịch sử cũ đã chuẩn hóa trước khi sửa logic encounter vẫn phải
// hiển thị an toàn: không tự gộp hai Mã BN khác nhau chỉ vì trùng tên/giới/tuổi,
// và không hiển thị hai "Đợt" cho cùng một lần nhập viện khi một bản thiếu ngày ra.

function text(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalize(value) {
  return text(value).toLowerCase();
}

function stableKey(value) {
  try { return JSON.stringify(value); } catch (_) { return String(value); }
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
  preferred.counts = {
    labs: preferred.labs.length,
    imaging: preferred.imaging.length,
    medications: preferred.medications.length,
    surgeries: preferred.surgeries.length,
  };

  // Nếu một bản đã có ngày ra viện còn bản kia chưa có, giữ bản đầy đủ.
  if (!text(preferred.discharge_date) && text(incoming?.discharge_date)) preferred.discharge_date = incoming.discharge_date;
  if (!text(preferred.diagnosis_raw) && text(incoming?.diagnosis_raw)) preferred.diagnosis_raw = incoming.diagnosis_raw;
  return preferred;
}

function collapseDisplayEncounters(encounters = []) {
  const out = [];
  for (const enc of encounters || []) {
    const idx = out.findIndex(current => sameDisplayStay(current, enc));
    if (idx < 0) out.push({ ...enc });
    else out[idx] = mergeDisplayStay(out[idx], enc);
  }
  return out.sort((a, b) => text(a.admission_date).localeCompare(text(b.admission_date)));
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
  sameDisplayStay,
  mergeDisplayStay,
  collapseDisplayEncounters,
  splitPatientByCode,
  sanitizePatientHistory,
  installPatientHistoryGuard,
};
