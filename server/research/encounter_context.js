'use strict';

// Ngày giờ và ghép dòng theo Mã BN + khoảng thời gian; không phụ thuộc mã điều trị/mã nội trú/mã vào viện.

const crypto = require('crypto');
const { removeVietnameseMarks } = require('./store_paths');
const { strictLocalDate } = require('./date_utils');
const { getCell, patientCode } = require('./table_io');

function stableHash(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value || {})).digest('hex').slice(0, 16);
}

function normalizeSimple(value) {
  return removeVietnameseMarks(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeToken(value) {
  return normalizeSimple(value).replace(/\s+/g, '_');
}

function parseAnyDate(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  let m = s.match(/(\d{1,2}):(\d{2})\s+(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
  if (m) return strictLocalDate(Number(m[5]), Number(m[4]), Number(m[3]), Number(m[1]), Number(m[2]));
  m = s.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\s+(\d{1,2}):(\d{2})/);
  if (m) return strictLocalDate(Number(m[3]), Number(m[2]), Number(m[1]), Number(m[4]), Number(m[5]));
  m = s.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
  if (m) return strictLocalDate(Number(m[3]), Number(m[2]), Number(m[1]));
  m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{2}))?/);
  if (m) return strictLocalDate(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] || 0), Number(m[5] || 0));
  return null;
}

function isoDate(value) {
  const d = parseAnyDate(value);
  if (!d || Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isoDateTime(value) {
  const d = parseAnyDate(value);
  if (!d || Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

function dateOffsetDays(startDate, date) {
  const a = parseAnyDate(startDate);
  const b = parseAnyDate(date);
  if (!a || !b) return '';
  const a0 = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const b0 = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return String(Math.floor((b0 - a0) / 86400000));
}

function daysBetween(startDate, date) {
  const offset = dateOffsetDays(startDate, date);
  return offset === '' ? '' : String(Number(offset) + 1);
}

// Đợt chưa có ngày ra viện (đang nằm hoặc chưa lấy được ngày ra): coi khoảng nằm viện
// kéo tới hôm nay. Trước đây cắt cứng 60 ngày sau ngày vào, nên người bệnh nằm lâu hơn
// bị mất kết quả mà không có cảnh báo. QA báo riêng số đợt chưa có ngày ra viện.
function openStayEnd(admissionDt) {
  const now = Date.now();
  return new Date(Math.max(admissionDt.getTime(), now));
}

function eventTemporalFields(ctx, eventDate) {
  const admission = ctx?.admission_date || '';
  const surgery = ctx?.surgery_date || '';
  const discharge = ctx?.discharge_date || '';
  const event = parseAnyDate(eventDate);
  const admissionDt = parseAnyDate(admission);
  const dischargeDt = parseAnyDate(discharge);
  let within = '';
  if (event && admissionDt) within = eventInsideContext(eventDate, ctx) ? '1' : '0';
  return {
    days_from_admission: dateOffsetDays(admission, eventDate),
    days_from_surgery: dateOffsetDays(surgery, eventDate),
    days_from_discharge: dateOffsetDays(discharge, eventDate),
    is_within_encounter: within,
  };
}

function firstNonEmpty(row, names) {
  return getCell(row, names);
}

function normalizedIdentity(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '');
}

function rowNoitruId(row) {
  return firstNonEmpty(row, [
    'noitruid', 'noi_tru_id', 'NoiTruID', 'Mã nội trú', 'Ma noi tru',
    'emr_noitru_id', 'treatment_uuid',
  ]);
}

function rowExistingEncounterId(row) {
  return firstNonEmpty(row, ['encounter_id', 'visit_id']);
}

function buildEncounterId(row, sourceRunId = '') {
  // sourceRunId cố ý không tham gia khóa: cùng một lượt điều trị phải giữ nguyên ID
  // khi chạy lại ở ngày khác hoặc từ một run khác.
  const existing = rowExistingEncounterId(row);
  if (existing) return existing;

  const maBn = patientCode(row);
  const admission = isoDateTime(firstNonEmpty(row, [
    'Ngày vào viện', 'Ngay vao vien', 'Ngày nhập viện', 'Ngay nhap vien',
    'T/G vào', 'TG vao', 'admission_date', 'ngay_vao_vien', 'ngay_vao',
  ])) || isoDate(firstNonEmpty(row, [
    'Ngày vào viện', 'Ngay vao vien', 'Ngày nhập viện', 'Ngay nhap vien',
    'T/G vào', 'TG vao', 'admission_date', 'ngay_vao_vien', 'ngay_vao',
  ]));
  if (maBn && admission) {
    // Ngày ra viện KHÔNG tham gia encounter_id. Cùng một lượt lúc đang nằm viện và
    // sau khi đã có ngày ra phải giữ nguyên khóa; trước đây thêm discharge làm sinh
    // hai encounter khác nhau cho cùng một lần nhập viện.
    return `enc_${stableHash(['visit', normalizedIdentity(maBn), admission])}`;
  }

  // Khóa cuối cùng chỉ để không làm hỏng schema. Dòng này phải được đánh dấu
  // manual review vì không đủ bằng chứng để ghép lượt tự động.
  return `enc_unresolved_${stableHash([
    maBn,
    firstNonEmpty(row, ['Họ tên', 'Ho ten', 'patient_name']),
    firstNonEmpty(row, ['Khoa', 'department']),
    firstNonEmpty(row, ['Chẩn đoán', 'Chan doan', 'diagnosis_raw']),
  ])}`;
}

function contextVisitKey(code, admission, discharge) {
  return [code || '', admission || '', discharge || ''].join('|');
}

function addContextMapKey(map, key, ctx) {
  if (!key) return;
  const current = map.get(key);
  if (!current) {
    map.set(key, ctx);
    return;
  }
  const list = Array.isArray(current) ? current : [current];
  if (!list.some(item => item?.encounter_id === ctx.encounter_id)) list.push(ctx);
  map.set(key, list);
}

function uniqueContext(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value.length === 1 ? value[0] : null;
  return value;
}

function matchedContext(ctx, method) {
  return ctx ? { ...ctx, _encounter_match_method: method || '' } : null;
}

function rowEventDate(row) {
  const raw = firstNonEmpty(row, [
    'lab_datetime', 'ordered_at', 'surgery_datetime', 'order_datetime', 'note_datetime',
    'TG xét nghiệm', 'Thời gian xét nghiệm', 'TG chỉ định', 'TG y lệnh',
    'Ngày chỉ định', 'Ngày xét nghiệm', 'Ngày phẫu thuật', 'Thời gian', 'Ngày',
    'lab_date', 'order_date', 'surgery_date', 'note_date',
  ]);
  if (!raw) return '';
  // Giữ nguyên độ chính xác của nguồn: chỉ khi nguồn thật sự có giờ mới chuẩn hóa thành datetime.
  // Dòng chỉ có ngày không được tự biến thành 00:00 vì sẽ gây loại nhầm sự kiện cùng ngày nhập viện.
  return hasPreciseClock(raw) ? isoDateTime(raw) : isoDate(raw);
}

function hasPreciseClock(value) {
  return /\b\d{1,2}:\d{2}\b/.test(String(value || ''));
}

function eventInsideContext(eventDate, ctx) {
  if (!eventDate || !ctx?.admission_date) return false;
  const event = parseAnyDate(eventDate);
  const admission = parseAnyDate(ctx.admission_date);
  const discharge = parseAnyDate(ctx.discharge_date);
  if (!event || !admission) return false;

  const dayStart = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayEnd = d => dayStart(d) + 86400000 - 1;
  const eventHasTime = hasPreciseClock(eventDate);
  const admissionHasTime = hasPreciseClock(ctx.admission_date);
  const dischargeHasTime = discharge && hasPreciseClock(ctx.discharge_date);

  // Nếu kết quả có giờ, so chính xác theo giờ vào/ra nếu EMR có giờ.
  // Nếu mốc vào/ra chỉ có ngày, dùng đầu/cuối ngày tương ứng.
  if (eventHasTime) {
    const startMs = admissionHasTime ? admission.getTime() : dayStart(admission);
    const endMs = discharge
      ? (dischargeHasTime ? discharge.getTime() : dayEnd(discharge))
      : openStayEnd(admission).getTime();
    return event.getTime() >= startMs && event.getTime() <= endMs;
  }

  // Nếu bản thân kết quả chỉ có ngày thì không thể suy ra giờ; chỉ xác nhận theo ngày lịch.
  const atDay = dayStart(event);
  const startDay = dayStart(admission);
  const endDay = discharge ? dayStart(discharge) : dayStart(openStayEnd(admission));
  return atDay >= startDay && atDay <= endDay;
}

function unresolvedContext(code, candidates = [], reason = '') {
  return {
    patient_code: code || '',
    encounter_id: '',
    research_code: '',
    needs_manual_review: reason || (candidates.length > 1 ? 'encounter_match_ambiguous' : 'encounter_match_missing'),
  };
}

function matchedContextForRow(ctx, row, code, method) {
  if (!ctx || normalizedIdentity(ctx.patient_code) !== normalizedIdentity(code)) return null;
  const eventDate = rowEventDate(row);
  if (eventDate && !eventInsideContext(eventDate, ctx)) {
    return unresolvedContext(code, [ctx], 'encounter_match_outside_time');
  }
  return matchedContext(ctx, method);
}

function encounterMatchStatus(ctx) {
  if (ctx?.encounter_id) return 'matched';
  const reason = String(ctx?.needs_manual_review || '');
  if (reason.includes('ambiguous')) return 'ambiguous';
  return 'missing';
}

function encounterMatchMethod(ctx) {
  return ctx?.encounter_id ? String(ctx._encounter_match_method || '') : '';
}

function buildContextMap(patientRows, sourceRunId = '') {
  const map = new Map();
  const byPatient = new Map();
  for (const row of patientRows) {
    const code = patientCode(row);
    if (!code) continue;
    const admission = isoDateTime(firstNonEmpty(row, ['Ngày vào viện', 'Ngay vao vien', 'Ngày nhập viện', 'Ngay nhap vien', 'T/G vào', 'TG vao', 'admission_date']))
      || isoDate(firstNonEmpty(row, ['Ngày vào viện', 'Ngay vao vien', 'Ngày nhập viện', 'Ngay nhap vien', 'T/G vào', 'TG vao', 'admission_date']));
    const discharge = isoDateTime(firstNonEmpty(row, ['Ngày ra viện', 'Ngay ra vien', 'Ngày xuất viện', 'Ngay xuat vien', 'discharge_date']))
      || isoDate(firstNonEmpty(row, ['Ngày ra viện', 'Ngay ra vien', 'Ngày xuất viện', 'Ngay xuat vien', 'discharge_date']));
    const admissionDiagnosis = firstNonEmpty(row, ['Chẩn đoán vào viện', 'Chan doan vao vien', 'Chẩn đoán', 'Chan doan', 'diagnosis_raw']);
    const ctx = {
      research_code: firstNonEmpty(row, ['Mã NC', 'Ma NC', 'research_code']),
      patient_code: code,
      patient_name: firstNonEmpty(row, ['Họ tên', 'Ho ten', 'Tên BN', 'Ten BN', 'patient_name']),
      sex: firstNonEmpty(row, ['Giới', 'Gioi', 'GT', 'sex']),
      birth_date: isoDate(firstNonEmpty(row, ['Ngày sinh', 'Ngay sinh', 'birth_date', 'DOB'])),
      age: firstNonEmpty(row, ['Tuổi', 'Tuoi', 'age']),
      address: firstNonEmpty(row, ['Địa chỉ', 'Dia chi', 'address']),
      phone_number: firstNonEmpty(row, ['Điện thoại', 'Dien thoai', 'SĐT', 'SDT', 'Số điện thoại', 'So dien thoai', 'phone', 'phone_number']),
      citizen_id: firstNonEmpty(row, ['Số CMND', 'So CMND', 'Số CMT', 'So CMT', 'CMND', 'CMT', 'CCCD', 'citizen_id']),
      insurance_subject: firstNonEmpty(row, ['Đối tượng', 'Doi tuong', 'insurance_subject']),
      insurance_card: firstNonEmpty(row, ['Số thẻ', 'So the', 'Số thẻ BHYT', 'So the BHYT', 'insurance_card']),
      insurance_type: firstNonEmpty(row, ['Loại', 'Loai', 'Loại BHYT', 'Loai BHYT', 'insurance_type']),
      insurance_valid_from: isoDate(firstNonEmpty(row, ['Giá trị từ', 'Gia tri tu', 'Từ ngày', 'Tu ngay', 'valid_from'])),
      insurance_valid_to: isoDate(firstNonEmpty(row, ['Giá trị đến', 'Gia tri den', 'Đến ngày', 'Den ngay', 'valid_to'])),
      source_input: firstNonEmpty(row, ['Nguồn input', 'Nguon input', 'source_input']),
      admission_date: admission,
      discharge_date: discharge,
      treatment_duration: firstNonEmpty(row, ['Thời gian điều trị', 'Thoi gian dieu tri', 'treatment_duration']),
      department: firstNonEmpty(row, ['Khoa', 'department', 'Khoa chuyển đến', 'Khoa dieu tri']),
      room_bed: firstNonEmpty(row, ['Phòng/Giường', 'Phong/Giuong', 'Phòng', 'Phong', 'room_bed']),
      admission_diagnosis: admissionDiagnosis,
      diagnosis_raw: admissionDiagnosis,
      surgery_date: isoDate(firstNonEmpty(row, ['Ngày mổ', 'Ngay mo', 'Ngày phẫu thuật', 'Ngay phau thuat', 'surgery_date'])),
      needs_manual_review: firstNonEmpty(row, ['__needs_manual_review', 'needs_manual_review']),
      encounter_id: buildEncounterId(row, sourceRunId),
    };

    const patientList = byPatient.get(code) || [];
    if (!patientList.some(item => item.encounter_id === ctx.encounter_id)) patientList.push(ctx);
    byPatient.set(code, patientList);

    addContextMapKey(map, `encounter:${normalizedIdentity(ctx.encounter_id)}`, ctx);
    if (admission || discharge) addContextMapKey(map, `visit:${contextVisitKey(code, admission, discharge)}`, ctx);
    if (admission) {
      addContextMapKey(map, `admission_time:${contextVisitKey(code, admission, '')}`, ctx);
      addContextMapKey(map, `admission_day:${contextVisitKey(code, isoDate(admission), '')}`, ctx);
    }
    if (discharge) {
      addContextMapKey(map, `discharge_time:${contextVisitKey(code, discharge, '')}`, ctx);
      addContextMapKey(map, `discharge_day:${contextVisitKey(code, isoDate(discharge), '')}`, ctx);
    }
  }
  for (const [code, list] of byPatient.entries()) map.set(`patient:${code}`, list);
  return map;
}

function resolveStrongEncounterKey(ctxMap, keys, row, code, method, aliasMethod = '') {
  const keyList = Array.isArray(keys) ? keys : [keys];
  const candidates = [];
  const seen = new Set();
  let usedAlias = false;
  for (let i = 0; i < keyList.length; i += 1) {
    const value = ctxMap.get(keyList[i]);
    if (!value) continue;
    for (const ctx of (Array.isArray(value) ? value : [value])) {
      const id = String(ctx?.encounter_id || '');
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      candidates.push(ctx);
      if (i > 0) usedAlias = true;
    }
  }
  if (!candidates.length) return unresolvedContext(code, [], 'encounter_match_strong_key_not_found');
  const samePatient = candidates.filter(ctx => normalizedIdentity(ctx.patient_code) === normalizedIdentity(code));
  if (samePatient.length !== 1) {
    return unresolvedContext(code, samePatient, samePatient.length > 1
      ? 'encounter_match_strong_key_ambiguous'
      : 'encounter_match_identity_conflict');
  }
  return matchedContextForRow(samePatient[0], row, code, usedAlias && aliasMethod ? aliasMethod : method);
}

function contextForRow(ctxMap, row, code) {
  const explicitEncounter = rowExistingEncounterId(row);
  if (explicitEncounter) {
    return resolveStrongEncounterKey(ctxMap, `encounter:${normalizedIdentity(explicitEncounter)}`, row, code, 'encounter_id');
  }

  const admission = isoDateTime(firstNonEmpty(row, ['Ngày vào viện', 'Ngay vao vien', 'T/G vào', 'TG vao', 'admission_date']))
    || isoDate(firstNonEmpty(row, ['Ngày vào viện', 'Ngay vao vien', 'T/G vào', 'TG vao', 'admission_date']));
  const discharge = isoDateTime(firstNonEmpty(row, ['Ngày ra viện', 'Ngay ra vien', 'discharge_date']))
    || isoDate(firstNonEmpty(row, ['Ngày ra viện', 'Ngay ra vien', 'discharge_date']));
  if (admission || discharge) {
    const exact = uniqueContext(ctxMap.get(`visit:${contextVisitKey(code, admission, discharge)}`));
    if (exact) return matchedContextForRow(exact, row, code, 'visit_exact');
  }
  if (admission) {
    const exactTime = uniqueContext(ctxMap.get(`admission_time:${contextVisitKey(code, admission, '')}`));
    if (exactTime) return matchedContextForRow(exactTime, row, code, 'admission_time');
    const exactDay = uniqueContext(ctxMap.get(`admission_day:${contextVisitKey(code, isoDate(admission), '')}`));
    if (exactDay) return matchedContextForRow(exactDay, row, code, 'admission_date');
  }
  if (discharge) {
    const exactTime = uniqueContext(ctxMap.get(`discharge_time:${contextVisitKey(code, discharge, '')}`));
    if (exactTime) return matchedContextForRow(exactTime, row, code, 'discharge_time');
    const exactDay = uniqueContext(ctxMap.get(`discharge_day:${contextVisitKey(code, isoDate(discharge), '')}`));
    if (exactDay) return matchedContextForRow(exactDay, row, code, 'discharge_date');
  }

  const candidates = ctxMap.get(`patient:${code}`) || [];
  const eventDate = rowEventDate(row);
  if (eventDate) {
    const temporal = candidates.filter(ctx => eventInsideContext(eventDate, ctx));
    if (temporal.length === 1) return matchedContext(temporal[0], 'event_date_range');
    if (!candidates.length) return unresolvedContext(code, [], 'encounter_match_missing');
    if (!temporal.length) return unresolvedContext(code, candidates, 'encounter_match_outside_time');
    return unresolvedContext(code, temporal, 'encounter_match_ambiguous');
  }
  // Chỉ Mã BN không đủ để chứng minh một dòng lâm sàng thuộc đợt nào khi nguồn thiếu thời gian.
  if (candidates.length === 1) return unresolvedContext(code, candidates, 'encounter_match_missing_event_time');
  return unresolvedContext(code, candidates);
}

function rowAdmissionTime(row) {
  return isoDateTime(firstNonEmpty(row, ['T/G vào', 'TG vao', 'Thời gian vào', 'Thoi gian vao', 'Ngày vào viện', 'Ngay vao vien', 'ngay_vao_vien', 'ngay_vao', 'admission_date']))
    || isoDate(firstNonEmpty(row, ['T/G vào', 'TG vao', 'Ngày vào viện', 'Ngay vao vien', 'ngay_vao_vien', 'ngay_vao', 'admission_date']));
}

function rowDischargeTime(row) {
  return isoDateTime(firstNonEmpty(row, ['Ngày ra viện', 'Ngay ra vien', 'Ngày xuất viện', 'Ngay xuat vien', 'ngay_ra_vien', 'ngay_ra', 'discharge_date']))
    || isoDate(firstNonEmpty(row, ['Ngày ra viện', 'Ngay ra vien', 'Ngày xuất viện', 'Ngay xuat vien', 'ngay_ra_vien', 'ngay_ra', 'discharge_date']));
}


module.exports = {
  stableHash,
  normalizeSimple,
  normalizeToken,
  parseAnyDate,
  isoDate,
  isoDateTime,
  dateOffsetDays,
  daysBetween,
  openStayEnd,
  eventTemporalFields,
  firstNonEmpty,
  normalizedIdentity,
  rowExistingEncounterId,
  buildEncounterId,
  contextVisitKey,
  addContextMapKey,
  uniqueContext,
  matchedContext,
  matchedContextForRow,
  resolveStrongEncounterKey,
  rowEventDate,
  eventInsideContext,
  hasPreciseClock,
  unresolvedContext,
  encounterMatchStatus,
  encounterMatchMethod,
  buildContextMap,
  contextForRow,
  rowAdmissionTime,
  rowDischargeTime,
};
