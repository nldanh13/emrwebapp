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

function normalizeAliases(values) {
  const list = Array.isArray(values) ? values : [values];
  return [...new Set(list.map(value => String(value || '').trim()).filter(Boolean))];
}

function aliasesIntersect(left, right) {
  const set = new Set(normalizeAliases(left));
  return normalizeAliases(right).some(alias => set.has(alias));
}

// Cùng ý tưởng với phần Trả HSBA: mỗi hồ sơ không chỉ có một khóa mà có một tập
// alias định danh. Khi nguồn khác nhau đổi cách gọi khóa (encounter/noitru/admission/
// Research key) ta vẫn nhận ra cùng lượt điều trị qua giao của hai tập alias.
// Không bao giờ dùng riêng Mã BN làm alias vì một người bệnh có thể nhập viện nhiều lần.
function encounterIdentityAliases(row) {
  const aliases = [];
  const existingEncounter = normalizedIdentity(rowExistingEncounterId(row));
  if (existingEncounter) aliases.push(`encounter:${existingEncounter}`);

  const researchKey = normalizedIdentity(firstNonEmpty(row, ['Research key', 'research_key']));
  if (researchKey) aliases.push(`research_key:${researchKey}`);

  const treatmentId = normalizedIdentity(rowEmrTreatmentId(row) || rowNoitruId(row));
  if (treatmentId) aliases.push(`treatment:${treatmentId}`);

  const admissionId = normalizedIdentity(rowEmrAdmissionId(row));
  if (admissionId) aliases.push(`admission:${admissionId}`);

  const code = normalizedIdentity(patientCode(row));
  const admission = rowAdmissionTime(row);
  const discharge = rowDischargeTime(row);
  if (code && admission) {
    // Alias ngày/giờ vào là khóa fallback quan trọng khi một nguồn chưa có ID nội trú.
    aliases.push(`visit:${code}|${admission}`);
    if (discharge) aliases.push(`visit_range:${code}|${admission}|${discharge}`);
  }
  return normalizeAliases(aliases);
}

function researchIdentityAliases(row) {
  const code = normalizedIdentity(patientCode(row));
  const researchCode = normalizedIdentity(rowResearchCode(row));
  return researchCode ? normalizeAliases([
    `research:${researchCode}`,
    code ? `patient_research:${code}|${researchCode}` : '',
  ]) : [];
}

function verifiedStayKey(patientCodeValue, admissionValue, dischargeValue) {
  const code = normalizedIdentity(patientCodeValue);
  const admission = rowAdmissionTime({ 'T/G vào': admissionValue }) || '';
  const discharge = rowDischargeTime({ 'Ngày ra viện': dischargeValue }) || '';
  if (!code || !admission || !discharge) return '';
  return `verified_stay:${code}|${admission}|${discharge}`;
}

function buildVerifiedStayIndex(profileRows = [], dischargeRows = []) {
  const byResearchKey = new Map();
  const touch = row => {
    const code = normalizedIdentity(patientCode(row));
    const researchKey = normalizedIdentity(firstNonEmpty(row, ['Research key', 'research_key']));
    if (!code || !researchKey) return null;
    const key = `${code}|${researchKey}`;
    const bucket = byResearchKey.get(key) || { code, researchKey, admission: '', discharge: '' };
    byResearchKey.set(key, bucket);
    return bucket;
  };

  // Profile là nguồn đáng tin cậy cho ngày vào thực tế mà worker đọc từ EMR.
  for (const row of profileRows || []) {
    const bucket = touch(row);
    if (!bucket) continue;
    const admission = rowAdmissionTime(row);
    if (admission) bucket.admission = admission;
  }
  // Discharge là nguồn đáng tin cậy cho ngày ra thực tế mà worker đọc từ EMR.
  for (const row of dischargeRows || []) {
    const bucket = touch(row);
    if (!bucket) continue;
    const discharge = rowDischargeTime(row);
    if (discharge) bucket.discharge = discharge;
  }

  const direct = new Map();
  const byPatient = new Map();
  for (const bucket of byResearchKey.values()) {
    if (!bucket.admission || !bucket.discharge) continue;
    const key = verifiedStayKey(bucket.code, bucket.admission, bucket.discharge);
    if (!key) continue;
    const stay = { key, patient_code: bucket.code, admission: bucket.admission, discharge: bucket.discharge };
    direct.set(`${bucket.code}|${bucket.researchKey}`, stay);
    const list = byPatient.get(bucket.code) || [];
    if (!list.some(item => item.key === key)) list.push(stay);
    byPatient.set(bucket.code, list);
  }
  return { direct, byPatient };
}

function canonicalizeRowToVerifiedStay(row, verifiedIndex) {
  const code = normalizedIdentity(patientCode(row));
  if (!code || !verifiedIndex) return { ...(row || {}) };

  const researchKey = normalizedIdentity(firstNonEmpty(row, ['Research key', 'research_key']));
  let stay = researchKey ? verifiedIndex.direct.get(`${code}|${researchKey}`) : null;

  if (!stay) {
    const admission = parseAnyDate(rowAdmissionTime(row));
    if (admission) {
      const matches = (verifiedIndex.byPatient.get(code) || []).filter(item => {
        const from = parseAnyDate(item.admission);
        const to = parseAnyDate(item.discharge);
        return from && to && admission.getTime() >= from.getTime() && admission.getTime() <= to.getTime();
      });
      if (matches.length === 1) stay = matches[0];
    }
  }
  if (!stay) return { ...(row || {}) };

  const out = { ...(row || {}) };
  if (!out.__source_admission_raw) out.__source_admission_raw = rowAdmissionTime(row) || '';
  if (!out.__source_discharge_raw) out.__source_discharge_raw = rowDischargeTime(row) || '';
  out.__verified_stay_key = stay.key;
  // Chỉ sửa bản làm việc trong bộ chuẩn hóa; file raw không bị đụng tới.
  // Ghi vào mọi alias thời gian thường dùng để context/encounter không đọc lại mốc chuyển khoa cũ.
  out['T/G vào'] = stay.admission;
  out['TG vao'] = stay.admission;
  out['Ngày vào viện'] = stay.admission;
  out.admission_date = stay.admission;
  out['Ngày ra viện'] = stay.discharge;
  out.discharge_date = stay.discharge;
  return out;
}

function conflictingStrongIdentity(left, right) {
  const codeA = normalizedIdentity(patientCode(left));
  const codeB = normalizedIdentity(patientCode(right));
  if (codeA && codeB && codeA !== codeB) return true;

  const verifiedA = String(left?.__verified_stay_key || '').trim();
  const verifiedB = String(right?.__verified_stay_key || '').trim();
  if (verifiedA && verifiedB) return verifiedA !== verifiedB;

  const encounterA = normalizedIdentity(rowExistingEncounterId(left));
  const encounterB = normalizedIdentity(rowExistingEncounterId(right));
  if (encounterA && encounterB && encounterA !== encounterB) return true;

  const treatmentA = normalizedIdentity(rowEmrTreatmentId(left) || rowNoitruId(left));
  const treatmentB = normalizedIdentity(rowEmrTreatmentId(right) || rowNoitruId(right));
  if (treatmentA && treatmentB && treatmentA !== treatmentB) return true;

  const admissionIdA = normalizedIdentity(rowEmrAdmissionId(left));
  const admissionIdB = normalizedIdentity(rowEmrAdmissionId(right));
  if (admissionIdA && admissionIdB && admissionIdA !== admissionIdB) return true;

  const admissionA = rowAdmissionTime(left);
  const admissionB = rowAdmissionTime(right);
  if (admissionA && admissionB && admissionA !== admissionB) {
    // Khác thời điểm vào chưa chắc khác đợt nếu một dòng là thời điểm vào khoa;
    // trường hợp đó được xử lý riêng bằng isTimeInsideVisit ở sameStrongIdentity().
    const encounterShared = encounterA && encounterB && encounterA === encounterB;
    const treatmentShared = treatmentA && treatmentB && treatmentA === treatmentB;
    const admissionShared = admissionIdA && admissionIdB && admissionIdA === admissionIdB;
    if (!encounterShared && !treatmentShared && !admissionShared) return true;
  }
  return false;
}

function visitSignature(row, sourceRunId = '') {
  const verified = String(row?.__verified_stay_key || '').trim();
  if (verified) return verified;
  const aliases = encounterIdentityAliases(row);
  const preferred = ['encounter:', 'research_key:', 'treatment:', 'admission:', 'visit_range:', 'visit:'];
  for (const prefix of preferred) {
    const found = aliases.find(alias => alias.startsWith(prefix));
    if (found) return found;
  }

  const code = patientCode(row);
  const researchCode = rowResearchCode(row);
  // Mã NC chỉ là fallback. Kèm Mã BN để một mã NC cấp trùng không thể gộp hai BN.
  // Nếu cùng BN nhưng thiếu mọi bằng chứng lượt điều trị thì giữ riêng và bắt rà soát.
  if (code && researchCode) return `research_unresolved:${normalizedIdentity(code)}|${normalizedIdentity(researchCode)}|${stableHash(row)}`;
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
  const verifiedIndex = buildVerifiedStayIndex(hchanhProfileRows, hchanhDischargeRows);
  // Chỉ dò các bản ghi của cùng một người bệnh. Trước đây mỗi dòng mới đều quét
  // toàn bộ Map (và còn tạo Array.from(...)), khiến chuẩn hoá tăng theo O(n²).
  const signaturesByPatient = new Map();

  function patientSignatures(code) {
    if (!signaturesByPatient.has(code)) signaturesByPatient.set(code, new Set());
    return signaturesByPatient.get(code);
  }

  function sameStrongIdentity(row, existing, sourceStatus = '') {
    const codeA = normalizedIdentity(patientCode(row));
    const codeB = normalizedIdentity(patientCode(existing));
    if (!codeA || !codeB || codeA !== codeB) return false;

    const verifiedA = String(row?.__verified_stay_key || '').trim();
    const verifiedB = String(existing?.__verified_stay_key || '').trim();
    if (verifiedA && verifiedB) return verifiedA === verifiedB;

    // ID mạnh bằng nhau là bằng chứng trực tiếp cùng lượt. Nếu cả hai phía đều có
    // cùng loại ID mạnh nhưng giá trị khác nhau thì không được dùng ngày/Mã NC để
    // gộp lại, vì đó có thể là hai lần nhập viện khác nhau.
    const encounterA = normalizedIdentity(rowExistingEncounterId(row));
    const encounterB = normalizedIdentity(rowExistingEncounterId(existing));
    if (encounterA && encounterB) {
      if (encounterA === encounterB) return true;
      return false;
    }

    const treatmentA = normalizedIdentity(rowEmrTreatmentId(row) || rowNoitruId(row));
    const treatmentB = normalizedIdentity(rowEmrTreatmentId(existing) || rowNoitruId(existing));
    if (treatmentA && treatmentB) {
      if (treatmentA === treatmentB) return true;
      return false;
    }

    const admissionIdA = normalizedIdentity(rowEmrAdmissionId(row));
    const admissionIdB = normalizedIdentity(rowEmrAdmissionId(existing));
    if (admissionIdA && admissionIdB) {
      if (admissionIdA === admissionIdB) return true;
      return false;
    }

    const keyA = normalizedIdentity(firstNonEmpty(row, ['Research key', 'research_key']));
    const keyB = normalizedIdentity(firstNonEmpty(existing, ['Research key', 'research_key']));
    if (keyA && keyB && keyA === keyB) return true;

    const a1 = rowAdmissionTime(row);
    const a2 = rowDischargeTime(row);
    const b1 = rowAdmissionTime(existing);
    const b2 = rowDischargeTime(existing);

    // Cùng Mã BN + cùng thời điểm vào là cùng một lượt fallback. Điều này đặc biệt
    // quan trọng khi một dòng đã có ngày ra còn dòng cũ vẫn đang để mở: trước đây
    // hai dòng bị tách thành hai "Đợt" dù thực tế là cùng lần nằm viện.
    if (a1 && b1 && a1 === b1 && !conflictingStrongIdentity(row, existing)) return true;

    // Chỉ cho phép ghép T/G vào khoa nằm trong khoảng điều trị khi một phía thực sự
    // là dòng initial. Không dùng overlap chung vì hai lượt gần nhau có thể bị gộp sai.
    const existingIsInitial = String(existing.__source_status || '').split('+').includes('initial');
    if (!conflictingStrongIdentity(row, existing)) {
      if (existingIsInitial && a1 && a2 && b1 && isTimeInsideVisit(b1, a1, a2)) return true;
      if (sourceStatus === 'initial' && b1 && b2 && a1 && isTimeInsideVisit(a1, b1, b2)) return true;
    }

    // Mã NC là alias yếu: chỉ dùng khi không có bằng chứng mạnh mâu thuẫn. Điều này
    // giữ tương thích dữ liệu cũ nhưng không còn cho NC0001 hay mã tái dùng gộp nhầm
    // hai lượt điều trị khác nhau.
    if (!conflictingStrongIdentity(row, existing)
        && aliasesIntersect(researchIdentityAliases(row), researchIdentityAliases(existing))) {
      return true;
    }
    return false;
  }

  function findExistingSigFor(row, sourceStatus) {
    const code = patientCode(row);
    if (!code) return '';
    // Cả initialRows cũng phải được dò trùng. Trước đây initial bị bỏ qua hoàn toàn,
    // nên cùng một lần nằm viện xuất hiện hai dòng (một dòng có ngày ra, một dòng mở)
    // sẽ luôn tạo thành hai Đợt khác nhau trên màn Tra cứu người bệnh.
    for (const sig of patientSignatures(code)) {
      const existing = map.get(sig);
      if (!existing) continue;
      if (sameStrongIdentity(row, existing, sourceStatus)) return sig;
    }
    return '';
  }

  function add(row, sourceStatus) {
    const canonicalRow = canonicalizeRowToVerifiedStay(row, verifiedIndex);
    const code = patientCode(canonicalRow);
    if (!code) return;
    let withStatus = { ...canonicalRow };
    if (sourceStatus && !withStatus.__source_status) withStatus.__source_status = sourceStatus;

    const existingSig = findExistingSigFor(withStatus, sourceStatus);
    const sameCodeCount = patientSignatures(code).size;
    if (!existingSig && sameCodeCount > 0 && sourceStatus !== 'initial') {
      withStatus = appendManualReview(withStatus, 'encounter_match_ambiguous');
    }

    const baseSig = existingSig || visitSignature(withStatus, sourceRunId);
    const sig = (!existingSig && withStatus.__needs_manual_review && /^(?:patient|research)_unresolved:/.test(baseSig))
      ? `row:${code}|${stableHash(withStatus)}`
      : baseSig;
    const existing = map.get(sig);
    if (!existing) {
      map.set(sig, withStatus);
      patientSignatures(code).add(sig);
      return;
    }

    // Cùng chữ ký nhưng thuộc BN khác là dữ liệu định danh xung đột: tuyệt đối không
    // gộp. Tạo khóa riêng để không mất dòng và buộc người dùng rà soát.
    if (normalizedIdentity(patientCode(existing)) !== normalizedIdentity(code)) {
      const conflicted = appendManualReview(withStatus, 'duplicate_identity_conflict');
      const conflictSig = `row:${normalizedIdentity(code)}|${stableHash(conflicted)}`;
      map.set(conflictSig, conflicted);
      patientSignatures(code).add(conflictSig);
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
  normalizeAliases,
  aliasesIntersect,
  encounterIdentityAliases,
  researchIdentityAliases,
  verifiedStayKey,
  buildVerifiedStayIndex,
  canonicalizeRowToVerifiedStay,
  conflictingStrongIdentity,
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
