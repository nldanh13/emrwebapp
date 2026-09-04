const ADMIN_START_MINUTES = 7 * 60;
const ADMIN_END_MINUTES = 16 * 60;

function stripDiacritics(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

export function normalizeText(value) {
  return stripDiacritics(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

export function normalizeRoomCode(value) {
  const raw = String(value || '').trim();
  const m = raw.match(/p\s*0*(\d{1,3})/i);
  if (!m) return '';
  const n = Number(m[1]);
  return n > 0 ? `P${String(n).padStart(2, '0')}` : '';
}

export function patientRoom(patient) {
  return normalizeRoomCode(patient?.so_phong || patient?.room || patient?.Vi_Tri || patient?.phong_giuong || '');
}

export function getUniqueRooms(patients = []) {
  return [...new Set((patients || []).map(patientRoom).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function strictLocalDate(year, month, day, hour = 0, minute = 0, second = 0, ms = 0) {
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const mi = Number(minute);
  if (![y, mo, d, h, mi].every(Number.isInteger)) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  const out = new Date(y, mo - 1, d, h, mi, second, ms);
  if (out.getFullYear() !== y || out.getMonth() !== mo - 1 || out.getDate() !== d || out.getHours() !== h || out.getMinutes() !== mi) return null;
  return out;
}

export function parseAdmissionDateTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  let m = raw.match(/(\d{1,2}):(\d{2})\s+(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) {
    return strictLocalDate(m[5], m[4], m[3], m[1], m[2]);
  }

  m = raw.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\s+(\d{1,2}):(\d{2})/);
  if (m) {
    return strictLocalDate(m[3], m[2], m[1], m[4], m[5]);
  }

  m = raw.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) {
    return strictLocalDate(m[3], m[2], m[1], 0, 0);
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function inputDateToDate(value, endOfDay = false) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return strictLocalDate(m[1], m[2], m[3], endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
}

export function isDateInWorkRange(date, workDateRange) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return false;
  const from = inputDateToDate(workDateRange?.from, false);
  const to = inputDateToDate(workDateRange?.to || workDateRange?.from, true);
  if (!from || !to) return false;
  return date >= from && date <= to;
}

export function isOutsideAdministrativeHours(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return false;
  const minutes = date.getHours() * 60 + date.getMinutes();
  return minutes < ADMIN_START_MINUTES || minutes >= ADMIN_END_MINUTES;
}

export function isAnesthesiaRecoveryWard(value) {
  const text = normalizeText(value);
  return /gay\s*me\s*hoi\s*suc|gmhs|g\.?m\.?h\.?s/.test(text);
}

function asWardHistoryItem(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const departmentName = String(
    raw.ten_khoa_dieu_tri || raw.khoa_dieu_tri || raw.khoa_chuyen_den || raw.department_name || raw.department || raw.khoa || raw.name || ''
  ).trim();
  const admissionTime = String(
    raw.thoi_gian_vao_khoa || raw.tg_vao || raw.thoi_gian_vao || raw.admission_time || raw.ngay_vao || raw.time || ''
  ).trim();
  const orderNoRaw = raw.thu_tu ?? raw.order_no ?? raw.stt ?? raw.index;
  const orderNo = Number.isFinite(Number(orderNoRaw)) ? Number(orderNoRaw) : index + 1;
  return {
    ...raw,
    thu_tu: orderNo,
    thoi_gian_vao_khoa: admissionTime,
    ten_khoa_dieu_tri: departmentName,
    khoa_dieu_tri: departmentName,
    _admissionDate: parseAdmissionDateTime(admissionTime),
  };
}

export function getWardHistory(patient) {
  const rawHistory = Array.isArray(patient?.lich_su_khoa_dieu_tri) ? patient.lich_su_khoa_dieu_tri
    : Array.isArray(patient?.khoa_dieu_tri_history) ? patient.khoa_dieu_tri_history
      : Array.isArray(patient?.ward_admissions) ? patient.ward_admissions
        : [];

  const history = rawHistory.map(asWardHistoryItem).filter(Boolean);
  if (!history.length) {
    const admissionTime = String(patient?.thoi_gian_vao_khoa || patient?.tg_vao || patient?.['T/G vào'] || patient?.admission_time || '').trim();
    const departmentName = String(patient?.ten_khoa_dieu_tri || patient?.khoa_dieu_tri || patient?.khoa_chuyen_den || patient?.['Khoa chuyển đến'] || patient?.department_name || patient?.department || '').trim();
    if (admissionTime || departmentName) {
      history.push(asWardHistoryItem({ thu_tu: 1, thoi_gian_vao_khoa: admissionTime, ten_khoa_dieu_tri: departmentName }, 0));
    }
  }

  return history.sort((a, b) => {
    const na = Number.isFinite(Number(a.thu_tu)) ? Number(a.thu_tu) : 9999;
    const nb = Number.isFinite(Number(b.thu_tu)) ? Number(b.thu_tu) : 9999;
    if (na !== nb) return na - nb;
    const ta = a._admissionDate?.getTime?.() || 0;
    const tb = b._admissionDate?.getTime?.() || 0;
    return ta - tb;
  });
}

export function getCurrentWardEntry(patient) {
  const history = getWardHistory(patient);
  return history.length ? history[history.length - 1] : null;
}

export function getPreviousWardEntry(patient) {
  const history = getWardHistory(patient);
  return history.length >= 2 ? history[history.length - 2] : null;
}

function workflowResult(scope, reason, current = null, previous = null, extra = {}) {
  return {
    scope,
    workflow_scope: scope,
    isDuty: scope === 'duty',
    isUnknown: scope === 'unknown',
    reason,
    current,
    previous,
    ...extra,
  };
}

export function getDutyCaseInfo(patient, workDateRange) {
  const history = getWardHistory(patient);
  const current = history.length ? history[history.length - 1] : null;
  if (!current) {
    return workflowResult('unknown', 'Thiếu mốc vào khoa để phân luồng', null, null);
  }

  const admissionRaw = String(current.thoi_gian_vao_khoa || '').trim();
  const admissionDate = current._admissionDate || parseAdmissionDateTime(admissionRaw);
  if (!(admissionDate instanceof Date) || Number.isNaN(admissionDate.getTime())) {
    return workflowResult('unknown', 'Không đọc được giờ vào khoa để phân luồng', current, null);
  }

  if (!isDateInWorkRange(admissionDate, workDateRange)) {
    return workflowResult('ward', 'Không cùng ngày trực', current, null);
  }

  const previous = history.length >= 2 ? history[history.length - 2] : null;
  if (!previous) {
    return workflowResult('duty', 'Lần đầu vào khoa trong ngày trực', current, null);
  }

  const previousWardName = previous.ten_khoa_dieu_tri || previous.khoa_dieu_tri || previous.khoa_chuyen_den || '';
  if (!String(previousWardName || '').trim()) {
    return workflowResult('unknown', 'Thiếu khoa trước đó để phân luồng chuyển khoa', current, previous);
  }

  if (!isAnesthesiaRecoveryWard(previousWardName)) {
    return workflowResult('duty', `Chuyển từ ${previousWardName || 'khoa khác'}`, current, previous);
  }

  if (isOutsideAdministrativeHours(admissionDate)) {
    return workflowResult('duty', 'Từ GMHS ngoài giờ hành chánh', current, previous);
  }

  return workflowResult('ward', 'Từ GMHS trong giờ hành chánh', current, previous);
}

export function getPatientWorkflowScope(patient, workDateRange) {
  return getDutyCaseInfo(patient, workDateRange).scope || 'unknown';
}

function availableDatesOfPatient(patient) {
  if (Array.isArray(patient?.available_dates) && patient.available_dates.length) {
    return patient.available_dates.map(x => String(x || '').trim()).filter(Boolean);
  }
  const dayMapDates = patient?.day_map && typeof patient.day_map === 'object'
    ? Object.keys(patient.day_map).map(x => String(x || '').trim()).filter(Boolean)
    : [];
  if (dayMapDates.length) return dayMapDates;
  return [patient?.ngay_lam].map(x => String(x || '').trim()).filter(Boolean);
}

function singleDateWorkRange(dateDmy) {
  const m = String(dateDmy || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const inputDate = `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  return { from: inputDate, to: inputDate };
}

function patientAtDate(patient, date) {
  const cleanDate = String(date || '').trim();
  const day = patient?.day_map && typeof patient.day_map === 'object'
    ? patient.day_map[cleanDate]
    : null;
  const fallbackMatches = String(patient?.ngay_lam || '').trim() === cleanDate;
  if (!day && !fallbackMatches) return null;
  return {
    ...patient,
    ...(day && typeof day === 'object' ? day : {}),
    ngay_lam: cleanDate,
    available_dates: [cleanDate],
  };
}

function buildScopedDayMap(patient, dates) {
  const dayMap = {};
  for (const date of dates) {
    dayMap[date] = patient?.day_map?.[date]
      || (String(patient?.ngay_lam || '').trim() === date ? patient : {})
      || {};
  }
  return dayMap;
}

function countWarnings(dayMap, dates) {
  return dates.reduce((sum, d) => sum + Number(dayMap[d]?.warning_count || 0), 0);
}

function scopedStatus({ careDoneCount, infusDoneCount, procedureDoneCount, careDone, hasInfusion, infusDone, hasProcedure, procedureDone, staleAny, warningCount }) {
  if (staleAny || warningCount > 0) return 'amber';
  if (careDone && (!hasInfusion || infusDone) && (!hasProcedure || procedureDone)) return 'green';
  if (careDoneCount > 0 || infusDoneCount > 0 || procedureDoneCount > 0) return 'amber';
  return 'gray';
}

export function scopePatientToDates(patient, targetDates = []) {
  if (!patient || !Array.isArray(targetDates) || !targetDates.length) return patient;
  const targetSet = new Set(targetDates);
  const available = Array.isArray(patient.available_dates) && patient.available_dates.length
    ? patient.available_dates.map(x => String(x || '').trim()).filter(Boolean)
    : [patient.ngay_lam].map(x => String(x || '').trim()).filter(Boolean);
  const dates = available.filter(date => targetSet.has(date));
  if (!dates.length) return null;

  const dayMap = buildScopedDayMap(patient, dates);
  const activeDate = dates[0];
  const active = dayMap[activeDate] || {};

  const careDates = dates.filter(d => dayMap[d]?.care_required !== false);
  const careDoneCount = careDates.filter(d => dayMap[d]?.care_done).length;
  const careStaleCount = careDates.filter(d => dayMap[d]?.care_stale).length;
  const infusionDates = dates.filter(d => dayMap[d]?.has_infusion || dayMap[d]?.has_inf);
  const infusDoneCount = infusionDates.filter(d => dayMap[d]?.infus_done).length;
  const infusStaleCount = infusionDates.filter(d => dayMap[d]?.infus_stale).length;
  const procedureDates = dates.filter(d => dayMap[d]?.has_procedure);
  const procedureDoneCount = procedureDates.filter(d => dayMap[d]?.procedure_done).length;
  const procedureStaleCount = procedureDates.filter(d => dayMap[d]?.procedure_stale).length;
  const warningCount = countWarnings(dayMap, dates);
  const careDone = careDates.length === 0 || careDoneCount === careDates.length;
  const hasInfusion = infusionDates.length > 0;
  const infusDone = hasInfusion && infusDoneCount === infusionDates.length;
  const hasProcedure = procedureDates.length > 0;
  const procedureDone = hasProcedure && procedureDoneCount === procedureDates.length;
  const staleAny = careStaleCount || infusStaleCount || procedureStaleCount;

  return {
    ...patient,
    ngay_lam: activeDate,
    available_dates: dates,
    total_dates: dates.length,
    care_done_count: careDoneCount,
    care_total_dates: careDates.length,
    care_stale_count: careStaleCount,
    infusion_total_dates: infusionDates.length,
    infus_done_count: infusDoneCount,
    infus_stale_count: infusStaleCount,
    procedure_total_dates: procedureDates.length,
    procedure_done_count: procedureDoneCount,
    procedure_stale_count: procedureStaleCount,
    care_done: careDone,
    infus_done: infusDone,
    procedure_done: procedureDone,
    has_infusion: hasInfusion,
    has_infusion_any: hasInfusion,
    has_procedure: hasProcedure,
    warning_count: warningCount,
    status: scopedStatus({ careDoneCount, infusDoneCount, procedureDoneCount, careDone, hasInfusion, infusDone, hasProcedure, procedureDone, staleAny, warningCount }),
    day_map: dayMap,
    timeline: active.timeline || patient.timeline,
    preview: active.preview || patient.preview,
    thuoc: active.thuoc || patient.thuoc,
    ncs: active.ncs || patient.ncs,
    cs_extra: active.cs_extra || patient.cs_extra,
    bac_si: active.bac_si || patient.bac_si,
    xu_tri: active.xu_tri || patient.xu_tri,
    tg_vao: active.tg_vao || patient.tg_vao,
    thoi_gian_vao_khoa: active.thoi_gian_vao_khoa || patient.thoi_gian_vao_khoa,
    khoa_chuyen_den: active.khoa_chuyen_den || patient.khoa_chuyen_den,
    khoa_dieu_tri: active.khoa_dieu_tri || patient.khoa_dieu_tri,
    ten_khoa_dieu_tri: active.ten_khoa_dieu_tri || patient.ten_khoa_dieu_tri,
    lich_su_khoa_dieu_tri: active.lich_su_khoa_dieu_tri || patient.lich_su_khoa_dieu_tri,
    chan_doan: active.chan_doan || patient.chan_doan,
    care_mode: active.care_mode || patient.care_mode,
    surgery_out: Boolean(active.surgery_out),
    surgery_out_time: active.surgery_out_time || '',
    surgery_out_reason: active.surgery_out_reason || '',
    care_special_events: Array.isArray(active.care_special_events) ? active.care_special_events : [],
    ngay_ra_vien: active.ngay_ra_vien || '',
    gio_ra_vien: active.gio_ra_vien || '',
    ngay_ra_vien_date: active.ngay_ra_vien_date || '',
    ra_vien_hom_nay: Boolean(active.ra_vien_hom_nay),
  };
}


/**
 * Trả về đúng các ngày của một người bệnh thuộc luồng ward/duty/unknown.
 *
 * Phải phân luồng theo từng ngày riêng. Nếu dùng cả khoảng ngày để kiểm tra,
 * một ca mới vào khoa ở ngày đầu sẽ bị xem là "trực" cho toàn bộ những ngày
 * sau đó trong cùng khoảng, làm giao diện và danh sách thực nhập không khớp.
 */
export function getPatientWorkflowDates(patient, targetDates = [], mode = 'ward') {
  const wantedMode = String(mode || '').trim().toLowerCase();
  const availableDates = availableDatesOfPatient(patient);
  const targetSet = new Set(
    (Array.isArray(targetDates) ? targetDates : [])
      .map(x => String(x || '').trim())
      .filter(Boolean)
  );
  const candidateDates = targetSet.size
    ? availableDates.filter(date => targetSet.has(date))
    : availableDates;

  if (!['ward', 'duty', 'unknown'].includes(wantedMode)) return candidateDates;

  return candidateDates.filter(date => {
    const dateRange = singleDateWorkRange(date);
    const datedPatient = patientAtDate(patient, date);
    if (!dateRange || !datedPatient) return wantedMode === 'unknown';
    return getPatientWorkflowScope(datedPatient, dateRange) === wantedMode;
  });
}

export function withPatientWorkflowScope(patient, workDateRange) {
  const info = getDutyCaseInfo(patient, workDateRange);
  return {
    ...patient,
    workflow_scope: info.scope,
    workflow_scope_reason: info.reason,
    duty_case_info: info,
  };
}

export function isDutyPatient(patient, workDateRange) {
  return getDutyCaseInfo(patient, workDateRange).scope === 'duty';
}

export function isUnknownWorkflowPatient(patient, workDateRange) {
  return getDutyCaseInfo(patient, workDateRange).scope === 'unknown';
}

export function filterPatientsByWorkflow(patients = [], mode = 'ward', workDateRange) {
  const list = Array.isArray(patients) ? patients : [];
  if (mode === 'duty') return list.filter(p => getPatientWorkflowScope(p, workDateRange) === 'duty');
  if (mode === 'ward') return list.filter(p => getPatientWorkflowScope(p, workDateRange) === 'ward');
  if (mode === 'unknown') return list.filter(p => getPatientWorkflowScope(p, workDateRange) === 'unknown');
  return list;
}

export function countDutyPatients(patients = [], workDateRange) {
  return (Array.isArray(patients) ? patients : []).filter(p => getPatientWorkflowScope(p, workDateRange) === 'duty').length;
}

export function countUnknownWorkflowPatients(patients = [], workDateRange) {
  return (Array.isArray(patients) ? patients : []).filter(p => getPatientWorkflowScope(p, workDateRange) === 'unknown').length;
}
