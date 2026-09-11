function pad2(value) {
  return String(Number(value)).padStart(2, '0');
}

function validDateParts(day, month, year) {
  const d = Number(day);
  const m = Number(month);
  const y = Number(year);
  if (!Number.isInteger(d) || !Number.isInteger(m) || !Number.isInteger(y)) return false;
  if (y < 2000 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function normalizeDischargeDate(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';

  let match = text.match(/(?:^|\D)(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})(?:\D|$)/);
  if (match && validDateParts(match[1], match[2], match[3])) {
    return `${pad2(match[1])}/${pad2(match[2])}/${match[3]}`;
  }

  match = text.match(/(?:^|\D)(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})(?:\D|$)/);
  if (match && validDateParts(match[3], match[2], match[1])) {
    return `${pad2(match[3])}/${pad2(match[2])}/${match[1]}`;
  }
  return '';
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function hasDischargeKeyword(value) {
  const text = normalizeText(value);
  return /\b(?:ra|xuat)\s*vien\b/.test(text) || /\bcho\s*ve\b/.test(text);
}

function isDischargeEvent(event) {
  if (!event || typeof event !== 'object') return false;
  if (normalizeText(event.type) === 'discharge') return true;
  return hasDischargeKeyword([
    event.label,
    event.text,
    event.note,
    event.title,
    event.name,
    event.xu_tri,
    event.disposition,
  ].filter(Boolean).join(' '));
}

function explicitDateFrom(source) {
  if (!source || typeof source !== 'object') return '';
  const keys = [
    'ngay_ra_vien_date',
    'ngay_ra_vien',
    'discharge_date',
    'discharge_time',
    'raw_discharge_time',
    'ngay_ra',
    'Ngày ra viện',
    'Thời gian ra viện',
  ];
  for (const key of keys) {
    const normalized = normalizeDischargeDate(source[key]);
    if (normalized) return normalized;
  }
  return '';
}

function eventDate(event, fallbackDate = '') {
  if (!event || typeof event !== 'object') return '';
  const keys = [
    'ngay_ra_vien_date', 'ngay_ra_vien', 'discharge_date', 'discharge_time',
    'date', 'ngay', 'datetime', 'time', 'at', 'timestamp',
  ];
  for (const key of keys) {
    const normalized = normalizeDischargeDate(event[key]);
    if (normalized) return normalized;
  }
  return normalizeDischargeDate(fallbackDate);
}

function hasDischargeMarker(source) {
  if (!source || typeof source !== 'object') return false;
  if (source.ra_vien_hom_nay || String(source.care_mode || '').trim() === 'discharge_day') return true;
  if (String(source.gio_ra_vien || '').trim()) return true;
  if (hasDischargeKeyword([source.xu_tri, source.disposition, source.status_text].filter(Boolean).join(' '))) return true;
  const events = Array.isArray(source.care_special_events) ? source.care_special_events : [];
  return events.some(isDischargeEvent);
}

function dmyStampLocal(value) {
  const m = String(value || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return 0;
  const dt = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return Number.isNaN(dt.getTime()) ? 0 : dt.getTime();
}

function hasOrderContentOnDay(day) {
  if (!day || typeof day !== 'object') return false;
  // care_required/has_infusion/has_procedure là cờ đã tính sẵn ở server
  // (buildPatientDayBundle) để biết ngày đó có việc lâm sàng thật hay không —
  // ưu tiên dùng vì đáng tin hơn text thô. ncs.y_lenh/dien_bien (đổi tên từ
  // nhap_cham_soc khi build day_map) là lưới an toàn cho các ca lẻ khác.
  if (day.care_required || day.has_infusion || day.has_procedure) return true;
  const yLenh = String(day?.ncs?.y_lenh || '').trim();
  const dienBien = String(day?.ncs?.dien_bien || '').trim();
  return Boolean(yLenh || dienBien);
}

// BN không thể thật sự ra viện vào dischargeDate nếu vẫn còn y lệnh/diễn biến
// ở ngày SAU đó trong cùng dữ liệu đã lấy — dấu hiệu lệnh ra viện bị huỷ/ghi
// nhầm hoặc BN ở lại điều trị tiếp. Chỉ so trong phạm vi ngày đã tải (day_map
// hiện có trên patient); ngày ngoài phạm vi KHOẢNG NGÀY đang chọn không thấy được.
export function isDischargeContradictedByLaterCare(patient, dischargeDateDmy) {
  const dischargeStamp = dmyStampLocal(dischargeDateDmy);
  if (!dischargeStamp) return false;
  const dayMap = patient?.day_map && typeof patient.day_map === 'object' ? patient.day_map : {};
  for (const [dayKey, day] of Object.entries(dayMap)) {
    const stamp = dmyStampLocal(dayKey);
    if (!stamp || stamp <= dischargeStamp) continue;
    if (hasOrderContentOnDay(day)) return true;
  }
  return false;
}

export function getPatientDischargeDates(patient) {
  if (!patient || typeof patient !== 'object') return [];
  const dates = new Set();

  const topExplicit = explicitDateFrom(patient);
  if (topExplicit) dates.add(topExplicit);

  const dayMap = patient.day_map && typeof patient.day_map === 'object' ? patient.day_map : {};
  for (const [dayKey, day] of Object.entries(dayMap)) {
    if (!day || typeof day !== 'object') continue;
    const keyDate = normalizeDischargeDate(dayKey);
    const explicit = explicitDateFrom(day);
    if (explicit) {
      dates.add(explicit);
    } else if (keyDate && hasDischargeMarker(day)) {
      dates.add(keyDate);
    }

    const events = Array.isArray(day.care_special_events) ? day.care_special_events : [];
    for (const event of events) {
      if (!isDischargeEvent(event)) continue;
      const date = eventDate(event, keyDate);
      if (date) dates.add(date);
    }
  }

  const topEvents = Array.isArray(patient.care_special_events) ? patient.care_special_events : [];
  const activeDate = normalizeDischargeDate(patient.ngay_lam);
  for (const event of topEvents) {
    if (!isDischargeEvent(event)) continue;
    const date = eventDate(event, activeDate);
    if (date) dates.add(date);
  }

  // Chỉ suy ra từ cờ/giờ/xử trí khi không có ngày ra viện tường minh ở cấp BN.
  // Điều này tránh trường hợp BN ra viện ngày 14 nhưng khi lọc ngày 13 vẫn giữ
  // cờ ra_vien_hom_nay từ bản ghi gốc và bị đưa vào danh sách in nhầm.
  if (!topExplicit && activeDate && hasDischargeMarker(patient)) dates.add(activeDate);

  // Bỏ các ngày ra viện bị chính dữ liệu sau đó phủ nhận: còn y lệnh/diễn biến
  // thật vào ngày sau ngày ra viện nghĩa là BN chưa thật sự ra viện lúc đó.
  return [...dates].filter(date => !isDischargeContradictedByLaterCare(patient, date));
}

export function getMatchingDischargeDate(patient, targetDates = []) {
  const targets = [...new Set((Array.isArray(targetDates) ? targetDates : [targetDates])
    .map(normalizeDischargeDate)
    .filter(Boolean))];
  if (!targets.length) return '';
  const actual = new Set(getPatientDischargeDates(patient));
  return targets.find(date => actual.has(date)) || '';
}

export function isDischargePrintPatientOnDates(patient, targetDates = []) {
  return Boolean(getMatchingDischargeDate(patient, targetDates));
}
