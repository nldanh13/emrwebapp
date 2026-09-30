'use strict';

// Gộp các nguồn danh sách (ban đầu, lấy sâu, hành chánh) thành đợt điều trị; gộp dòng chuyển khoa cùng đợt.

const { rowExistingEncounterId, normalizedIdentity, rowEmrTreatmentId, rowNoitruId, rowEmrAdmissionId, firstNonEmpty, rowAdmissionTime, rowDischargeTime, stableHash, parseAnyDate, openStayEnd } = require('./encounter_context');
const { patientCode, parseDateTimeCell } = require('./table_io');
const { rowResearchCode } = require('./progress_snapshot');

function byEncounterCount(rows, dateKey) {
  const map = new Map();
  for (const row of rows) {
    const encounter = String(row?.encounter_id || '').trim();
    if (!encounter) continue; // không gộp dữ liệu chưa ghép lượt vào mọi lượt của cùng BN
    const bucket = map.get(encounter) || { total: 0, byDate: new Map() };
    bucket.total += 1;
    const d = row[dateKey] || '';
    if (d) bucket.byDate.set(d, (bucket.byDate.get(d) || 0) + 1);
    map.set(encounter, bucket);
  }
  return map;
}

function visitSignature(row, sourceRunId = '') {
  const existingEncounter = rowExistingEncounterId(row);
  if (existingEncounter) return `encounter:${existingEncounter}`;
  const treatmentId = normalizedIdentity(rowEmrTreatmentId(row) || rowNoitruId(row));
  if (treatmentId) return `treatment:${treatmentId}`;
  const admissionId = normalizedIdentity(rowEmrAdmissionId(row));
  if (admissionId) return `admission:${admissionId}`;
  const code = patientCode(row);
  const researchCode = firstNonEmpty(row, ['Mã NC', 'Ma NC', 'research_code']);
  const admission = rowAdmissionTime(row);
  const discharge = rowDischargeTime(row);
  if (researchCode) return `research:${researchCode}`;
  if (code && admission) return `visit:${code}|${admission}|${discharge || ''}`;
  if (code) return `patient_unresolved:${code}|${stableHash([
    firstNonEmpty(row, ['Họ tên', 'Ho ten', 'patient_name']),
    firstNonEmpty(row, ['Khoa', 'department']),
    firstNonEmpty(row, ['Chẩn đoán', 'Chan doan', 'diagnosis_raw']),
  ])}`;
  return `row:${stableHash(row)}`;
}

function rowCompletenessScore(row) {
  if (!row || typeof row !== 'object') return 0;
  let score = 0;
  for (const value of Object.values(row)) {
    const text = String(value ?? '').trim();
    if (!text) continue;
    score += Math.min(8, text.length > 20 ? 8 : 1);
  }
  return score;
}

function mergeRowsPreferFilled(base, patch) {
  const out = { ...(base || {}) };
  for (const [key, value] of Object.entries(patch || {})) {
    const next = String(value ?? '').trim();
    if (!next) continue;
    const cur = String(out[key] ?? '').trim();
    if (!cur || next.length > cur.length) out[key] = value;
  }
  return out;
}

// Các dòng chuyển khoa của CÙNG một đợt nằm viện dùng chung Mã nội trú (đã được bệnh
// viện xác nhận) nên được gộp thành một đợt. Mỗi dòng mang thời điểm vào KHOA của nó;
// khi gộp phải lấy thời điểm vào SỚM NHẤT (vào viện) và khoảng lấy dữ liệu RỘNG NHẤT,
// không phụ thuộc dòng nào đứng trước trong file.
const EARLIEST_TIME_FIELDS = ['T/G vào', 'TG vao', 'Ngày vào viện', 'Ngay vao vien', 'admission_date', 'fetch_from_date'];

const LATEST_TIME_FIELDS = ['fetch_to_date'];

function pickTimeValue(a, b, preferEarlier) {
  const ta = parseAnyDate(a);
  const tb = parseAnyDate(b);
  if (!ta) return b;
  if (!tb) return a;
  const aWins = preferEarlier ? ta.getTime() <= tb.getTime() : ta.getTime() >= tb.getTime();
  return aWins ? a : b;
}

function mergeSameStayRows(base, patch) {
  const out = mergeRowsPreferFilled(base, patch);
  for (const field of EARLIEST_TIME_FIELDS) {
    const a = String(base?.[field] ?? '').trim();
    const b = String(patch?.[field] ?? '').trim();
    if (a && b) out[field] = pickTimeValue(a, b, true);
  }
  for (const field of LATEST_TIME_FIELDS) {
    const a = String(base?.[field] ?? '').trim();
    const b = String(patch?.[field] ?? '').trim();
    if (a && b) out[field] = pickTimeValue(a, b, false);
  }
  return out;
}

function appendManualReview(row, message) {
  const out = { ...(row || {}) };
  const cur = String(out.__needs_manual_review || out.needs_manual_review || '').trim();
  out.__needs_manual_review = [...new Set([cur, message].filter(Boolean).join('; ').split(';').map(x => x.trim()).filter(Boolean))].join('; ');
  return out;
}

function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  const as = parseAnyDate(aStart);
  const ae = parseAnyDate(aEnd);
  const bs = parseAnyDate(bStart);
  const be = parseAnyDate(bEnd);
  if (!as || !bs) return false;
  if (!ae || !be) return false;
  return as.getTime() <= be.getTime() + 86400000 && bs.getTime() <= ae.getTime() + 86400000;
}

function isTimeInsideVisit(timeValue, admissionValue, dischargeValue) {
  const t = parseAnyDate(timeValue);
  const a = parseAnyDate(admissionValue);
  const d = parseAnyDate(dischargeValue);
  if (!t || !a) return false;
  const end = d || openStayEnd(a);
  return t.getTime() >= a.getTime() - 86400000 && t.getTime() <= end.getTime() + 86400000;
}

function combineEncounterSources({ initialRows = [], deepRows = [], patientRows = [], hchanhProfileRows = [], hchanhDischargeRows = [], sourceRunId = '' } = {}) {
  const map = new Map();
  // Chỉ dò các bản ghi của cùng một người bệnh. Trước đây mỗi dòng mới đều quét
  // toàn bộ Map (và còn tạo Array.from(...)), khiến chuẩn hoá tăng theo O(n²).
  const signaturesByPatient = new Map();

  function patientSignatures(code) {
    if (!signaturesByPatient.has(code)) signaturesByPatient.set(code, new Set());
    return signaturesByPatient.get(code);
  }

  function sameStrongIdentity(row, existing, sourceStatus = '') {
    // Research key là khóa của đúng dòng nguồn mà worker đã lấy: bằng nhau là cùng đợt.
    // Khi cả hai có Research key mà khác nhau thì KHÔNG dùng Mã NC để ghép, vì Mã NC
    // từng bị cấp trùng (NC0001 cho mọi dòng) và ghép theo nó gán nhầm dữ liệu giữa
    // các đợt của cùng người bệnh.
    const keyA = firstNonEmpty(row, ['Research key', 'research_key']);
    const keyB = firstNonEmpty(existing, ['Research key', 'research_key']);
    if (keyA && keyB && keyA === keyB) return true;
    const researchA = rowResearchCode(row);
    const researchB = rowResearchCode(existing);
    if (!(keyA && keyB) && researchA && researchB && researchA === researchB) return true;

    const admissionIdA = normalizedIdentity(rowEmrAdmissionId(row));
    const admissionIdB = normalizedIdentity(rowEmrAdmissionId(existing));
    if (admissionIdA && admissionIdB && admissionIdA === admissionIdB) return true;

    const treatmentIdA = normalizedIdentity(rowEmrTreatmentId(row) || rowNoitruId(row));
    const treatmentIdB = normalizedIdentity(rowEmrTreatmentId(existing) || rowNoitruId(existing));
    if (treatmentIdA && treatmentIdB && treatmentIdA === treatmentIdB) return true;

    const a1 = rowAdmissionTime(row);
    const a2 = rowDischargeTime(row);
    const b1 = rowAdmissionTime(existing);
    const b2 = rowDischargeTime(existing);
    if (a1 && b1 && a1 === b1 && (!a2 || !b2 || a2 === b2)) return true;

    // Chỉ cho phép ghép T/G vào khoa nằm trong khoảng điều trị khi một phía thực sự
    // là dòng initial. Không dùng overlap chung vì hai lượt gần nhau có thể bị gộp sai.
    const existingIsInitial = String(existing.__source_status || '').split('+').includes('initial');
    if (existingIsInitial && a1 && a2 && b1 && isTimeInsideVisit(b1, a1, a2)) return true;
    if (sourceStatus === 'initial' && b1 && b2 && a1 && isTimeInsideVisit(a1, b1, b2)) return true;
    return false;
  }

  function findExistingSigFor(row, sourceStatus) {
    const code = patientCode(row);
    if (!code || sourceStatus === 'initial') return '';
    for (const sig of patientSignatures(code)) {
      const existing = map.get(sig);
      if (!existing) continue;
      if (sameStrongIdentity(row, existing, sourceStatus)) return sig;
    }
    return '';
  }

  function add(row, sourceStatus) {
    const code = patientCode(row);
    if (!code) return;
    let withStatus = { ...(row || {}) };
    if (sourceStatus && !withStatus.__source_status) withStatus.__source_status = sourceStatus;

    const existingSig = findExistingSigFor(withStatus, sourceStatus);
    const sameCodeCount = patientSignatures(code).size;
    if (!existingSig && sameCodeCount > 0 && sourceStatus !== 'initial') {
      withStatus = appendManualReview(withStatus, 'encounter_match_ambiguous');
    }

    const baseSig = existingSig || visitSignature(withStatus, sourceRunId);
    const sig = (!existingSig && withStatus.__needs_manual_review && /^patient_unresolved:/.test(baseSig))
      ? `row:${code}|${stableHash(withStatus)}`
      : baseSig;
    const existing = map.get(sig);
    if (!existing) {
      map.set(sig, withStatus);
      patientSignatures(code).add(sig);
      return;
    }
    const merged = rowCompletenessScore(withStatus) >= rowCompletenessScore(existing)
      ? mergeSameStayRows(withStatus, existing)
      : mergeSameStayRows(existing, withStatus);
    merged.__source_status = [...new Set([existing.__source_status, sourceStatus].filter(Boolean).join('+').split('+').filter(Boolean))].join('+');
    // File hchanh_* mang Mã NC của research_source.csv tại lúc lấy dữ liệu, có thể là
    // mã cũ bị cấp trùng (NC0001): không để mã đó đè lên mã của dòng đã có. Các nguồn
    // khác (XN/CĐHA) giữ cách gộp cũ để không đổi Mã NC của dữ liệu hiện có.
    if (String(sourceStatus || '').startsWith('hchanh') && rowResearchCode(existing)) {
      merged['Mã NC'] = rowResearchCode(existing);
    }
    merged.__needs_manual_review = [...new Set([existing.__needs_manual_review, withStatus.__needs_manual_review].filter(Boolean).join('; ').split(';').map(x => x.trim()).filter(Boolean))].join('; ');
    map.set(sig, merged);
  }
  for (const row of initialRows) add(row, 'initial');
  for (const row of patientRows) add(row, 'sample');
  for (const row of deepRows) add(row, 'deep');
  for (const row of hchanhProfileRows) add(row, 'hchanh_profile');
  for (const row of hchanhDischargeRows) add(row, 'hchanh_discharge');
  return Array.from(map.values()).sort((a, b) => {
    const da = parseDateTimeCell(firstNonEmpty(a, ['Ngày vào viện', 'Ngay vao vien', 'T/G vào', 'TG vao', 'ngay_vao_vien', 'ngay_vao']));
    const db = parseDateTimeCell(firstNonEmpty(b, ['Ngày vào viện', 'Ngay vao vien', 'T/G vào', 'TG vao', 'ngay_vao_vien', 'ngay_vao']));
    const ta = da ? da.getTime() : 0;
    const tb = db ? db.getTime() : 0;
    if (ta !== tb) return ta - tb;
    return String(patientCode(a)).localeCompare(String(patientCode(b)));
  });
}

function dedupeByHash(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const key = row.row_hash || stableHash(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

module.exports = {
  byEncounterCount,
  visitSignature,
  rowCompletenessScore,
  mergeRowsPreferFilled,
  EARLIEST_TIME_FIELDS,
  LATEST_TIME_FIELDS,
  pickTimeValue,
  mergeSameStayRows,
  appendManualReview,
  intervalsOverlap,
  isTimeInsideVisit,
  combineEncounterSources,
  dedupeByHash,
};
