'use strict';

// Gộp các nguồn danh sách (ban đầu, lấy sâu, hành chánh) thành đợt điều trị; gộp dòng chuyển khoa cùng đợt.

const { rowExistingEncounterId, normalizedIdentity, firstNonEmpty, rowAdmissionTime, rowDischargeTime, stableHash, parseAnyDate, openStayEnd } = require('./encounter_context');
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

// Nhận diện một khoảng dữ liệu chỉ từ khóa nội bộ sẵn có và Mã BN + thời điểm vào.
// Không dùng Mã điều trị/Mã nội trú/Mã vào viện vì pipeline nghiên cứu không thu các khóa đó.
function encounterIdentityAliases(row) {
  const aliases = [];
  const existingEncounter = normalizedIdentity(rowExistingEncounterId(row));
  if (existingEncounter) aliases.push(`encounter:${existingEncounter}`);

  const researchKey = normalizedIdentity(firstNonEmpty(row, ['Research key', 'research_key']));
  if (researchKey) aliases.push(`research_key:${researchKey}`);

  const code = normalizedIdentity(patientCode(row));
  const admission = rowAdmissionTime(row);
  const discharge = rowDischargeTime(row);
  if (code && admission) {
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
        const toMs = to ? to.getTime() + (/\d{1,2}:\d{2}/.test(item.discharge) ? 0 : 86400000 - 1) : 0;
        return from && to && admission.getTime() >= from.getTime() && admission.getTime() <= toMs;
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

  // Hai mốc vào khác nhau vẫn có thể là cùng một lần nằm viện nếu một mốc là lúc
  // chuyển khoa và nằm trong khoảng vào-ra của dòng kia. Chỉ coi là xung đột khi
  // không có bằng chứng thời gian như vậy.
  const admissionA = rowAdmissionTime(left);
  const admissionB = rowAdmissionTime(right);
  if (admissionA && admissionB && admissionA !== admissionB) {
    const encounterShared = encounterA && encounterB && encounterA === encounterB;
    if (encounterShared) return false;
    const dischargeA = rowDischargeTime(left);
    const dischargeB = rowDischargeTime(right);
    if (dischargeA && isTimeInsideVisit(admissionB, admissionA, dischargeA)) return false;
    if (dischargeB && isTimeInsideVisit(admissionA, admissionB, dischargeB)) return false;
    return true;
  }
  return false;
}

function visitSignature(row, sourceRunId = '') {
  const verified = String(row?.__verified_stay_key || '').trim();
  if (verified) return verified;
  const aliases = encounterIdentityAliases(row);
  const preferred = ['encounter:', 'research_key:', 'visit_range:', 'visit:'];
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

// Các dòng của cùng Mã BN có thể mang thời điểm vào KHOA khác nhau trong cùng một
// lần nằm viện. Khi có khoảng thời gian chứng minh chúng thuộc cùng lần nằm, gộp và
// lấy thời điểm vào SỚM NHẤT cùng khoảng lấy dữ liệu RỘNG NHẤT.
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

// File hchanh_* mang Mã NC tại lúc lấy dữ liệu; mã cũ từng bị cấp trùng (một mã cho hàng trăm Mã BN)
// vẫn còn trong các file đó. Mã NC chỉ hợp lệ khi thuộc đúng một Mã BN trong file: mã dùng chung
// bị bỏ khỏi bản làm việc (file thô không đổi), đợt sẽ nhận Mã NC từ nguồn chuẩn (research_source).
const RESEARCH_CODE_FIELDS = ['Mã NC', 'Ma NC', 'research_code'];

function dropSharedResearchCodes(rows = []) {
  const patientsByCode = new Map();
  for (const row of rows) {
    const code = firstNonEmpty(row, RESEARCH_CODE_FIELDS);
    const pc = normalizedIdentity(patientCode(row));
    if (!code || !pc) continue;
    if (!patientsByCode.has(code)) patientsByCode.set(code, new Set());
    patientsByCode.get(code).add(pc);
  }
  const shared = new Set([...patientsByCode].filter(([, set]) => set.size > 1).map(([code]) => code));
  if (!shared.size) return rows;
  return rows.map(row => {
    const code = firstNonEmpty(row, RESEARCH_CODE_FIELDS);
    if (!shared.has(code)) return row;
    const out = { ...row };
    for (const field of RESEARCH_CODE_FIELDS) if (field in out) out[field] = '';
    return out;
  });
}

// File hchanh_* cũ đã lỡ ghi ngày cuối khoảng lấy dữ liệu (dạng YYYY-MM-DD) vào "Ngày ra viện" khi chưa
// có ngày ra thật. EMR không ghi ngày ra dạng đó, nên ngày ra dạng YYYY-MM-DD trùng ngày cuối khoảng quét
// / khoảng lấy dữ liệu của danh sách được coi là chưa có ngày ra (bản làm việc; file thô không đổi).
function dropPlaceholderDischarge(rows = [], placeholderDays = new Set()) {
  if (!placeholderDays.size) return rows;
  return rows.map(row => {
    let out = row;
    for (const f of DISCHARGE_FIELDS) {
      const v = String(row?.[f] ?? '').trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(v) && placeholderDays.has(v)) {
        if (out === row) out = { ...row };
        out[f] = '';
      }
    }
    return out;
  });
}

function placeholderDischargeDays(sourceRows = []) {
  const days = new Set();
  for (const row of sourceRows) {
    for (const f of ['source_scan_to_date', 'fetch_to_date']) {
      const v = String(row?.[f] ?? '').trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) days.add(v);
    }
    // Ngày ra thật của dòng danh sách (nếu có) thì không phải ngày giả.
    const real = String(firstNonEmpty(row, DISCHARGE_FIELDS) || '').trim();
    const m = real.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
    if (m) days.delete(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`);
  }
  return days;
}

// Một lần nằm viện là MỘT đợt, tính từ lúc vào viện (kể cả Cấp cứu) đến lúc ra viện. Hai đợt của
// cùng Mã BN không thể chồng thời gian: các dòng khoa (Cấp cứu → CTCH → PHCN…) mang giờ vào khoa
// riêng nhưng cùng ngày ra viện là cùng một đợt. Gộp các dòng có khoảng vào–ra chồng nhau; lấy giờ
// vào sớm nhất và ngày ra muộn nhất. Dòng chưa có ngày ra không tự nuốt dòng sau (không đủ bằng chứng).
const STAY_GAP_MS = 86400000;
const DISCHARGE_FIELDS = ['Ngày ra viện', 'Ngay ra vien', 'Ngày xuất viện', 'Ngay xuat vien', 'discharge_date'];

// Cùng thứ tự cột với bước ghép (buildContextMap): "Ngày vào viện" trước "T/G vào". Khác thứ tự thì
// bước gộp thấy hai đợt rời nhau trong khi bước ghép thấy chúng chồng nhau → kết quả "mơ hồ".
const STAY_ADMISSION_FIELDS = ['Ngày vào viện', 'Ngay vao vien', 'Ngày nhập viện', 'Ngay nhap vien', 'T/G vào', 'TG vao', 'admission_date'];

function stayBounds(row) {
  const startRaw = firstNonEmpty(row, STAY_ADMISSION_FIELDS);
  const endRaw = firstNonEmpty(row, DISCHARGE_FIELDS);
  const start = parseAnyDate(startRaw);
  if (!start) return null;
  const end = parseAnyDate(endRaw);
  const endHasClock = /\d{1,2}:\d{2}/.test(firstNonEmpty(row, DISCHARGE_FIELDS));
  // Ngày ra chỉ có ngày: tính hết ngày đó.
  const endMs = end ? end.getTime() + (endHasClock ? 0 : 86400000 - 1) : null;
  return { start: start.getTime(), end: endMs };
}

function laterDischarge(a, b) {
  const da = firstNonEmpty(a, DISCHARGE_FIELDS);
  const db = firstNonEmpty(b, DISCHARGE_FIELDS);
  if (!da) return db;
  if (!db) return da;
  const pa = parseAnyDate(da); const pb = parseAnyDate(db);
  if (!pa || !pb) return da;
  return pb.getTime() > pa.getTime() ? db : da;
}

function mergeOverlappingStays(rows) {
  const byPatient = new Map();
  const others = [];
  for (const row of rows) {
    const code = normalizedIdentity(patientCode(row));
    const bounds = code ? stayBounds(row) : null;
    if (!bounds) { others.push(row); continue; }
    if (!byPatient.has(code)) byPatient.set(code, []);
    byPatient.get(code).push({ row, ...bounds });
  }
  const out = [...others];
  for (const list of byPatient.values()) {
    list.sort((a, b) => a.start - b.start);
    let cur = null;
    for (const item of list) {
      if (cur && cur.end != null && item.start <= cur.end) {
        const discharge = laterDischarge(cur.row, item.row);
        const merged = mergeSameStayRows(cur.row, item.row);
        if (discharge) for (const f of DISCHARGE_FIELDS) if (String(merged[f] ?? '').trim()) merged[f] = discharge;
        if (discharge && !DISCHARGE_FIELDS.some(f => String(merged[f] ?? '').trim())) merged['Ngày ra viện'] = discharge;
        merged.__source_status = [...new Set([cur.row.__source_status, item.row.__source_status]
          .filter(Boolean).join('+').split('+').filter(Boolean))].join('+');
        cur = { row: merged, start: cur.start, end: item.end == null ? cur.end : Math.max(cur.end, item.end) };
        continue;
      }
      if (cur) out.push(cur.row);
      cur = item;
    }
    if (cur) out.push(cur.row);
  }
  return out;
}

// Dòng y lệnh/diễn biến mang khoảng vào–ra của cả lần nằm viện (EMR trả khi lấy). Đợt của kho có thể
// dừng sớm (lúc ra khoa CTCH) trong khi y lệnh tiếp tục ở khoa sau tới ngày ra viện. Khoảng đó chồng
// lên đúng MỘT đợt của người bệnh thì kéo dài ngày ra của đợt đó; chồng nhiều đợt thì không đoán.
// Không tạo đợt mới từ các khoảng này.
function extendStaysWithEvidence(rows, evidenceRows = []) {
  if (!evidenceRows || !evidenceRows.length) return rows;
  const windows = new Map();
  for (const ev of evidenceRows) {
    const code = normalizedIdentity(patientCode(ev));
    const bounds = code ? stayBounds(ev) : null;
    if (!bounds || bounds.end == null) continue;
    const raw = firstNonEmpty(ev, DISCHARGE_FIELDS);
    windows.set(`${code}|${bounds.start}|${bounds.end}`, { code, ...bounds, raw });
  }
  if (!windows.size) return rows;
  const out = rows.map(row => ({ row, code: normalizedIdentity(patientCode(row)), bounds: stayBounds(row) }));
  const byCode = new Map();
  for (const item of out) {
    if (!item.code || !item.bounds) continue;
    if (!byCode.has(item.code)) byCode.set(item.code, []);
    byCode.get(item.code).push(item);
  }
  for (const w of windows.values()) {
    const hits = (byCode.get(w.code) || []).filter(item => {
      const end = item.bounds.end == null ? item.bounds.start : item.bounds.end;
      return item.bounds.start <= w.end && w.start <= end;
    }).sort((a, b) => a.bounds.start - b.bounds.start);
    if (!hits.length) continue;
    if (hits.length > 1) {
      // Khoảng của cả lần nằm viện phủ nhiều đợt liền nhau (cách nhau ≤ 1 ngày: chuyển khoa): là một lần
      // nằm viện → nối các đợt đó (đợt đầu kéo tới cuối khoảng; mergeOverlappingStays gộp phần còn lại).
      // Các đợt cách nhau xa hơn thì không đoán.
      const contiguous = hits.every((item, i) => i === 0
        || (hits[i - 1].bounds.end != null && item.bounds.start - hits[i - 1].bounds.end <= STAY_GAP_MS));
      if (!contiguous) continue;
    }
    const item = hits[0];
    if (item.bounds.end != null && item.bounds.end >= w.end) continue;
    const next = { ...item.row };
    let set = false;
    for (const f of DISCHARGE_FIELDS) if (String(next[f] ?? '').trim()) { next[f] = w.raw; set = true; }
    if (!set) next['Ngày ra viện'] = w.raw;
    next.__stay_extended_by = 'order_history_window';
    item.row = next;
    item.bounds = { ...item.bounds, end: w.end };
  }
  return out.map(item => item.row);
}

function combineEncounterSources({ initialRows = [], deepRows = [], patientRows = [], hchanhProfileRows = [], hchanhDischargeRows = [], stayEvidenceRows = [], sourceRunId = '' } = {}) {
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

    // encounter_id ở đây là khóa nội bộ do pipeline tạo từ Mã BN + thời điểm vào.
    // Không đọc/so Mã điều trị, Mã nội trú hay Mã vào viện từ nguồn.
    const encounterA = normalizedIdentity(rowExistingEncounterId(row));
    const encounterB = normalizedIdentity(rowExistingEncounterId(existing));
    if (encounterA && encounterB) {
      if (encounterA === encounterB) return true;
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
  return mergeOverlappingStays(extendStaysWithEvidence(mergeOverlappingStays(Array.from(map.values())), stayEvidenceRows)).sort((a, b) => {
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
  dropPlaceholderDischarge,
  placeholderDischargeDays,
  dropSharedResearchCodes,
  mergeOverlappingStays,
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
