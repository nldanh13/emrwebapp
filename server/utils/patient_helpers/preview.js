'use strict';

const { getNurseByShift } = require('../nurse_config');
const { sanitizeDisplayText, dedupeStrings } = require('./common');
const { buildDrugSearchName, buildDrugDisplayName } = require('./drugs');
const { buildCareDienBien } = require('./care');
const { mergeRecordGroup } = require('./merge');
const { OVERNIGHT_HOURS, parseHourFromText, resolveHour, parseDateTime, formatDateTimeDisplay, sortByDateTimeAsc } = require('./datetime');
const { parseMedicationOrderHour, isRehabServiceName } = require('./timeline');

function buildCareTimeKey(hour, ngayLam) {
  if (!ngayLam) return `${String(hour).padStart(2, '0')}:00`;
  const [dd, mm, yyyy] = String(ngayLam).split('/').map(Number);
  if (!dd || !mm || !yyyy) return `${ngayLam} ${String(hour).padStart(2, '0')}:00`;
  const dt = new Date(yyyy, mm - 1, dd);
  // Giờ qua đêm (00, 05, 06) thuộc ca bắt đầu từ ngày hôm trước → ghi vào ngày tiếp theo
  if (OVERNIGHT_HOURS.has(Number(hour))) dt.setDate(dt.getDate() + 1);
  const d = String(dt.getDate()).padStart(2, '0');
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const y = dt.getFullYear();
  return `${String(hour).padStart(2, '0')}:00 ${d}/${m}/${y}`;
}

function formatCareDateTime(dt) {
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return '';
  const hh = String(dt.getHours()).padStart(2, '0');
  const mi = String(dt.getMinutes()).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const yyyy = dt.getFullYear();
  return `${hh}:${mi} ${dd}/${mm}/${yyyy}`;
}

function getDischargeCutoff(record = {}) {
  const events = getSpecialCareEvents(record, SPECIAL_EVENT_TYPES.discharge);
  for (const ev of events) {
    const raw = ev.time_full || (ev.time_label && record.ngay_lam ? `${ev.time_label} ${record.ngay_lam}` : ev.time_label);
    const dt = parseDateTime(raw);
    if (dt) return dt;
  }
  const raw = record.ngay_ra_vien || (record.gio_ra_vien && (record.ngay_ra_vien_date || record.ngay_lam)
    ? `${record.gio_ra_vien} ${record.ngay_ra_vien_date || record.ngay_lam}`
    : '');
  return parseDateTime(raw);
}

function sameCalendarDate(dt, ddmmyyyy) {
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime()) || !ddmmyyyy) return false;
  const [dd, mm, yyyy] = String(ddmmyyyy).split('/').map(Number);
  if (!dd || !mm || !yyyy) return false;
  return dt.getFullYear() === yyyy && (dt.getMonth() + 1) === mm && dt.getDate() === dd;
}

function isBeforeDischargeTime(raw, cutoff, { allowEqual = false } = {}) {
  if (!cutoff) return true;
  const dt = parseDateTime(raw);
  if (!dt) return true;
  return allowEqual ? dt <= cutoff : dt < cutoff;
}

function isAfterDischargeTime(raw, cutoff, { allowEqual = false } = {}) {
  if (!cutoff) return false;
  const dt = parseDateTime(raw);
  if (!dt) return false;
  return allowEqual ? dt >= cutoff : dt > cutoff;
}

function isBeforeWorkStartOnSameDate(raw, ngayLam, startHour = 7) {
  if (!raw || !ngayLam) return false;
  const dt = parseDateTime(raw);
  if (!dt) return false;
  const [dd, mm, yyyy] = String(ngayLam).split('/').map(Number);
  if (!dd || !mm || !yyyy) return false;
  const sameDate = dt.getFullYear() === yyyy && (dt.getMonth() + 1) === mm && dt.getDate() === dd;
  if (!sameDate) return false;
  return (dt.getHours() * 60 + dt.getMinutes()) < Number(startHour) * 60;
}


function normalizeNoAccent(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();
}

function defaultSurgeryCutoff(record = {}) {
  const ngayLam = String(record.ngay_lam || '').trim();
  if (!ngayLam) return null;
  return parseDateTime(`11:00 ${ngayLam}`);
}

const PT_MARKER_RE = /\b(?:ma\s*)?(?:pt|pttt)\s*[:：]\s*\d+\s*\/\s*\d+\b/i;
const EXPLICIT_SURGERY_TIME_KEYS = [
  'surgery_out_time', 'gio_di_mo', 'thoi_gian_di_mo', 'tg_di_mo',
  'gio_chuyen_mo', 'thoi_gian_chuyen_mo', 'tg_chuyen_mo',
  'ngay_gio_di_mo', 'ngay_gio_chuyen_mo',
];

function normalizeDmy(raw) {
  const m = String(raw || '').match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
  if (!m) return '';
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  return `${String(Number(m[1])).padStart(2, '0')}/${String(Number(m[2])).padStart(2, '0')}/${year}`;
}

function parseDateTimeWithFallback(raw, fallbackDate = '') {
  const direct = parseDateTime(raw);
  if (direct) return direct;
  const date = normalizeDmy(fallbackDate);
  if (!date) return null;
  const hm = String(raw || '').match(/\b(\d{1,2}):(\d{2})\b/);
  return hm ? parseDateTime(`${hm[1]}:${hm[2]} ${date}`) : null;
}

function sameWorkDate(dt, record = {}) {
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return false;
  const workDate = normalizeDmy(record.ngay_lam);
  if (!workDate) return false;
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${dt.getFullYear()}` === workDate;
}

function explicitSurgeryCutoff(record = {}) {
  for (const key of EXPLICIT_SURGERY_TIME_KEYS) {
    const dt = parseDateTimeWithFallback(record[key], record.ngay_lam);
    if (dt && sameWorkDate(dt, record)) return dt;
  }
  return null;
}

function ptMarkerSurgeryCutoff(record = {}) {
  const workDate = normalizeDmy(record.ngay_lam);
  if (!workDate) return null;
  let found = false;
  let earliest = null;
  for (const ev of (Array.isArray(record.raw_order_events) ? record.raw_order_events : [])) {
    if (!ev || typeof ev !== 'object') continue;
    const text = [ev.text, ev.kq_text, ev.row_text, ev.dien_bien].filter(Boolean).join(' ');
    if (!PT_MARKER_RE.test(text)) continue;
    const eventDate = normalizeDmy(ev.ngay_lam || ev.work_date || ev.ngay) || workDate;
    if (eventDate !== workDate) continue;
    found = true;
    const dt = parseDateTimeWithFallback(ev.gio_y_lenh || ev.time || ev.thoi_gian || ev.tg_ylenh || ev.tg_y_lenh, workDate);
    if (dt && (!earliest || dt < earliest)) earliest = dt;
  }
  return found ? (earliest || defaultSurgeryCutoff(record)) : null;
}

function getSurgeryCutoff(record = {}) {
  // Đồng bộ với worker/surgery_guard.py. Chỉ “khẳng định đi mổ” khi có đủ hai căn cứ:
  // (1) chỉ định PT/DVKT phẫu thuật của chính ngày làm việc; và
  // (2) mã PT/PTTT cùng ngày hoặc mốc chuyển mổ rõ ràng cùng ngày.
  // “Trình duyệt mổ”, “Đánh dấu vị trí mổ”, PPPT trong diễn biến hoặc kế hoạch mổ
  // không được xem là chỉ định PT và không được dùng riêng để chặn chăm sóc tại khoa.
  if (getPostopReceiveEvents(record).length > 0 || getDischargeEvents(record).length > 0) return null;
  if (!hasSameDaySurgeryIndication(record)) return null;

  const explicit = explicitSurgeryCutoff(record);
  if (explicit) return explicit;

  const markerCutoff = ptMarkerSurgeryCutoff(record);
  if (markerCutoff) return markerCutoff;

  // Giữ tương thích dữ liệu đã được worker xác nhận đủ điều kiện nhưng thiếu giờ.
  if (record.surgery_out || record.care_mode === 'surgery_out_day') return defaultSurgeryCutoff(record);
  return null;
}

function isAfterSurgeryTime(raw, cutoff, { allowEqual = true } = {}) {
  if (!cutoff) return false;
  const dt = parseDateTime(raw);
  if (!dt) return false;
  return allowEqual ? dt >= cutoff : dt > cutoff;
}


function isSurgeryServiceName(name) {
  const text = normalizeNoAccent(name);
  return /\b(cat loc|phau thuat|ket hop xuong|thay khop|noi soi)\b/.test(text)
    || /\bmo\s+(cat|ket|thay|noi|lay|rut|thao)\b/.test(text);
}

function getSurgeryIndicationName(item = {}) {
  if (typeof item === 'string') return item.trim();
  if (!item || typeof item !== 'object') return '';
  return String(item.ten || item.name || item.ten_dich_vu || item.service_name || item.noi_dung || '').trim();
}

function hasSameDaySurgeryIndication(record = {}) {
  const workDate = normalizeDmy(record.ngay_lam);
  if (!workDate) return false;
  for (const item of (Array.isArray(record.chi_dinh_dvkt) ? record.chi_dinh_dvkt : [])) {
    const name = getSurgeryIndicationName(item);
    if (!name || !isSurgeryServiceName(name)) continue;
    if (!item || typeof item !== 'object') return true;
    const rawTime = item.gio || item.time || item.thoi_gian || item.tg_ylenh || item.tg_y_lenh || '';
    if (!String(rawTime || '').trim()) return true;
    const dt = parseDateTimeWithFallback(rawTime, workDate);
    if (!dt || sameWorkDate(dt, record)) return true;
  }
  return false;
}

function extractExplicitActionTimeByHour(record = {}) {
  const out = new Map();
  const ngayLam = String(record.ngay_lam || '').trim();
  const add = raw => {
    if (isBeforeWorkStartOnSameDate(raw, ngayLam)) return;
    const dt = parseDateTime(raw);
    if (!dt) return;
    const hour = dt.getHours();
    if (!out.has(hour)) out.set(hour, formatCareDateTime(dt));
  };
  const cs = record.chi_dinh_khac || {};
  for (const item of (cs.thay_bang_cat_chi || [])) add(item && item.gio);
  for (const item of (cs.duong_mau_mao_mach || [])) add(item && item.gio);
  const vltl = cs.vat_ly_tri_lieu;
  if (String(vltl || '').trim()) add(vltl);
  for (const item of (record.chi_dinh_dvkt || [])) {
    if (!isSurgeryServiceName(item && item.ten)) add(item && item.gio);
  }
  return out;
}

function collectMedicationPlan(thuoc = {}, ngayLam = '') {
  const hours = new Set();
  let hasReserveOrders = false;

  const addHour = raw => {
    if (isBeforeWorkStartOnSameDate(raw, ngayLam)) return;
    const h = parseHourFromText(raw);
    if (Number.isFinite(h)) hours.add(h);
  };

  const scanReserve = list => {
    for (const item of (list || [])) {
      const orderHour = parseMedicationOrderHour(item);
      if (Number.isFinite(orderHour) && orderHour < 7) hasReserveOrders = true;
    }
  };

  for (const item of (thuoc.dich_truyen || [])) addHour(item.tg_bat_dau || item.gio_dung);
  for (const item of (thuoc.thuoc_tiem || [])) String(item.gio_dung || '').split(',').forEach(x => addHour(x));
  for (const item of (thuoc.thuoc_uong || [])) String(item.gio_dung || '').split(',').forEach(x => addHour(x));

  scanReserve(thuoc.dich_truyen || []);
  scanReserve(thuoc.thuoc_tiem  || []);
  scanReserve(thuoc.thuoc_uong  || []);

  return { hours: [...hours].sort((a, b) => a - b), hasReserveOrders };
}

function extractCareActionsByHour(record = {}) {
  const out  = new Map();
  const ngayLam = String(record.ngay_lam || '').trim();
  const push = (hour, label) => {
    if (!Number.isFinite(hour)) return;
    if (!out.has(hour)) out.set(hour, []);
    out.get(hour).push(label);
  };

  const cs = record.chi_dinh_khac || {};
  const yk = record.y_lenh_khac   || {};

  for (const item of (cs.thay_bang_cat_chi || [])) {
    if (isBeforeWorkStartOnSameDate(item && item.gio, ngayLam)) continue;
    push(parseHourFromText(item.gio), item.ten || 'Thay băng');
  }
  for (const item of (cs.duong_mau_mao_mach || [])) {
    if (isBeforeWorkStartOnSameDate(item && item.gio, ngayLam)) continue;
    push(parseHourFromText(item.gio), item.ten || 'Test đường máu mao mạch');
  }
  for (const line of (yk.moi_hoi_chan || [])) {
    push(resolveHour(line, 8), 'Mời bác sĩ khám');
  }
  if (String(cs.vat_ly_tri_lieu || '').trim()) {
    push(resolveHour(cs.vat_ly_tri_lieu, 8), 'Mời tập vật lý trị liệu');
  }
  for (const item of (record.chi_dinh_dvkt || [])) {
    if (isBeforeWorkStartOnSameDate(item && item.gio, ngayLam)) continue;
    const ten = String(item.ten || '').trim();
    if (!ten || isSurgeryServiceName(ten)) continue;
    if (isRehabServiceName(ten)) {
      push(resolveHour(item.gio, 8), 'Mời tập vật lý trị liệu');
    } else {
      push(resolveHour(item.gio, 8), 'Thực hiện cận lâm sàng');
    }
  }
  return out;
}

function parseCareTimeMinutes(value) {
  const m = String(value || '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h  = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

function getSpecialCareEvents(record = {}, type = '') {
  return (Array.isArray(record.care_special_events) ? record.care_special_events : [])
    .filter(ev => ev && (!type || ev.type === type) && (ev.time_full || ev.time_label));
}

const SPECIAL_EVENT_TYPES = {
  postop_receive:         'postop_receive',
  discharge:              'discharge',
  clinic_admission:       'clinic_admission',
  ward_receive:           'ward_receive',
  interdepartment_receive:'interdepartment_receive',
};

const POSTOP_RECEIVE_CARE = 'Nhận hồ sơ + Lấy dấu hiệu sinh tồn + Trình Bác sĩ trực + Hướng dẫn ăn uống nghỉ ngơi sau mổ';

const ADMISSION_TYPES = new Set([
  SPECIAL_EVENT_TYPES.clinic_admission,
  SPECIAL_EVENT_TYPES.ward_receive,
  SPECIAL_EVENT_TYPES.interdepartment_receive,
]);

function getPostopReceiveEvents(record)    { return getSpecialCareEvents(record, SPECIAL_EVENT_TYPES.postop_receive); }
function getDischargeEvents(record)        { return getSpecialCareEvents(record, SPECIAL_EVENT_TYPES.discharge); }
function getAdmissionTransferEvents(record){
  const events = getSpecialCareEvents(record);
  // Nếu cùng ngày đã có mốc nhận bệnh hậu phẫu/chuyển khoa sau mổ,
  // không tạo thêm phiếu nhận chuyển khoa từ cột T/G vào để tránh dư phiếu 13:38.
  if (events.some(ev => String(ev.type || '') === SPECIAL_EVENT_TYPES.postop_receive)) return [];
  return events.filter(ev => ADMISSION_TYPES.has(String(ev.type || '')));
}

function hasPostopReceiveContext(record = {}) {
  if (record.care_mode === 'postop_receive_day') return true;
  if ((record.care_special_events || []).some(ev => String(ev && ev.type || '') === SPECIAL_EVENT_TYPES.postop_receive)) return true;
  const cs = record.nhap_cham_soc || {};
  const ylk = record.y_lenh_khac || {};
  const raw = [
    record.chan_doan, record['Chẩn đoán'], record.ten_khoa_dieu_tri, record.khoa_dieu_tri, record.khoa_chuyen_den, record['Tên khoa điều trị'], record['Khoa điều trị'], record['Khoa chuyển đến'],
    cs.dien_bien, cs.y_lenh, record['Diễn biến'], record['Y lệnh'],
    ...(Array.isArray(ylk.khac) ? ylk.khac : []),
    ...(Array.isArray(ylk.moi_hoi_chan) ? ylk.moi_hoi_chan : []),
    ...((record.care_special_events || []).map(ev => [ev && ev.source_body, ev && ev.title, ev && ev.dien_bien].filter(Boolean).join(' '))),
  ].filter(Boolean).join('\n');
  const text = normalizeNoAccent(raw);
  return /\b(hau phau|sau mo|phong phau thuat|gay me hoi suc|gmhs|pt\s*0?1|vet mo|ket hop xuong|thay khop|noi soi)\b/.test(text);
}


function defaultSpecialDienBien(ev = {}) {
  if (ev.type === SPECIAL_EVENT_TYPES.discharge)       return 'Người bệnh xuất viện';
  if (ADMISSION_TYPES.has(String(ev.type || '')))      return 'Người bệnh tỉnh';
  return [
    'Khoa Ngoại Chấn Thương Chỉnh Hình và Thần Kinh nhận bệnh',
    'Người bệnh tỉnh', 'Tiếp xúc tốt', 'Da niêm hồng', 'Mạch rõ, chi ấm',
    'Đau vết mổ', 'Vết mổ chưa ghi nhận dịch thấm băng',
  ].join('\n');
}

function defaultSpecialChamSoc(ev = {}) {
  if (ev.type === SPECIAL_EVENT_TYPES.discharge)
    return 'Hoàn tất hồ sơ ra viện + Cấp giấy ra viện + Cấp thuốc theo toa + Hướng dẫn tái khám';
  if (ev.type === SPECIAL_EVENT_TYPES.clinic_admission)
    return 'Hoàn tất hồ sơ nhập viện + Kính chuyển Khoa Ngoại Chấn Thương Chỉnh Hình và Thần Kinh + Hồ sơ';
  if (ev.type === SPECIAL_EVENT_TYPES.ward_receive)
    return 'Nhận hồ sơ + Lấy dấu hiệu sinh tồn + Trình Bác sĩ trực + Hướng dẫn nội quy khoa phòng + Thực hiện cận lâm sàng';
  if (ev.type === SPECIAL_EVENT_TYPES.interdepartment_receive)
    return 'Nhận hồ sơ + Lấy dấu hiệu sinh tồn + Trình Bác sĩ trực + Hướng dẫn nội quy khoa phòng';
  return POSTOP_RECEIVE_CARE;
}

function specialEventDateTime(ev = {}, ngayLam = '') {
  const raw = ev.time_full || (ev.time_label && ngayLam ? `${ev.time_label} ${ngayLam}` : ev.time_label);
  return parseDateTime(raw);
}

function getWardCareStart(admissionEvents = [], ngayLam = '') {
  const directWardEvents = admissionEvents
    .filter(ev => [SPECIAL_EVENT_TYPES.ward_receive, SPECIAL_EVENT_TYPES.interdepartment_receive].includes(String(ev?.type || '')))
    .map(ev => specialEventDateTime(ev, ngayLam))
    .filter(Boolean);
  const clinicEvents = admissionEvents
    .filter(ev => String(ev?.type || '') === SPECIAL_EVENT_TYPES.clinic_admission)
    .map(ev => specialEventDateTime(ev, ngayLam))
    .filter(Boolean);
  const candidates = directWardEvents.length ? directWardEvents : clinicEvents;
  return candidates.length ? new Date(Math.min(...candidates.map(dt => dt.getTime()))) : null;
}

function getNurseForSpecialEvent(ev = {}, timeFull = '', nurseSchedule = {}) {
  const type = String(ev.type || '').trim().toLowerCase();

  // Các mốc nhận người bệnh/nhận chuyển khoa vẫn chia điều dưỡng theo giờ như bình thường:
  // 07:00-10:59, 13:00-16:59 -> người làm; 11:00-12:59, 17:00-06:59 -> người trực.
  // Bỏ qua nurse_shift_override cũ nếu file dữ liệu đã từng được tạo với rule ép người trực.
  let forceShift = ADMISSION_TYPES.has(type)
    ? ''
    : String(ev.nurse_shift_override || ev.force_nurse_shift || '').trim().toLowerCase();

  if (forceShift === 'work' || forceShift === 'oncall') {
    return getNurseByShift(timeFull, nurseSchedule, { forceShift });
  }
  return getNurseByShift(timeFull, nurseSchedule);
}

function buildCarePreview(record, nurseSchedule = {}) {
  const merged  = mergeRecordGroup(record, [record]);
  const thuoc   = merged.thuoc  || {};
  const ngayLam = merged.ngay_lam || '';
  const medPlan = collectMedicationPlan(thuoc, ngayLam);
  const medHours = medPlan.hours;
  const actionMap = extractCareActionsByHour(merged);
  const explicitActionTimeByHour = extractExplicitActionTimeByHour(merged);

  const postopEvents    = getPostopReceiveEvents(merged);
  const dischargeEvents = getDischargeEvents(merged);
  const dischargeCutoff = getDischargeCutoff(merged);
  const surgeryCutoff = getSurgeryCutoff(merged);
  const admissionEvents = getAdmissionTransferEvents(merged);
  const allSpecialEvents = [...postopEvents, ...dischargeEvents, ...admissionEvents];

  const isPostopReceiveDay    = merged.care_mode === 'postop_receive_day'    || postopEvents.length > 0;
  const isDischargeDay        = merged.care_mode === 'discharge_day'         || dischargeEvents.length > 0 || sameCalendarDate(dischargeCutoff, ngayLam);
  const isAdmissionTransferDay = merged.care_mode === 'admission_transfer_day' || admissionEvents.length > 0;

  const receiveCutoff = postopEvents
    .map(ev => specialEventDateTime(ev, ngayLam))
    .filter(Boolean)
    .sort((a, b) => a - b)[0] || null;
  const dischargeMinutes = dischargeEvents.length
    ? parseCareTimeMinutes(dischargeEvents[0].time_full || dischargeEvents[0].time_label)
    : null;
  const wardCareStart = getWardCareStart(admissionEvents, ngayLam);

  // Mốc giờ chăm sóc mặc định theo loại ngày:
  // - Hậu phẫu (nhận lại từ GMHS): bỏ 08:00 buổi sáng trước giờ nhận, chỉ giữ 05:00 & 16:00
  // - Ra viện: chỉ giữ 08:00, bỏ 16:00 sau khi bệnh nhân đã ra viện
  // - Ngày thường: đủ 3 mốc 05:00, 08:00, 16:00
  const defaultCareHours = isPostopReceiveDay ? [5, 16] : (isDischargeDay ? [8] : [5, 8, 16]);

  const hours = [...new Set([...medHours, ...actionMap.keys(), ...defaultCareHours])]
    .filter(hour => Number.isFinite(hour))
    .filter(hour => {
      const candidateTime = explicitActionTimeByHour.get(hour) || buildCareTimeKey(hour, ngayLam);
      const candidateDt = parseDateTime(candidateTime);

      // Ngày nhận bệnh/chuyển khoa: chỉ tạo phiếu thường từ lúc khoa thực sự
      // nhận người bệnh. Cữ 05:00 được dựng sang ngày hôm sau nên không bị loại
      // nhầm khi người bệnh vào khoa buổi chiều hoặc buổi tối.
      if (isAdmissionTransferDay && wardCareStart && candidateDt && candidateDt < wardCareStart) return false;

      // Ngày nhận hậu phẫu: giữ các mốc từ giờ nhận trở đi, gồm 05:00 ngày sau.
      if (isPostopReceiveDay && receiveCutoff && candidateDt && candidateDt < receiveCutoff) return false;

      if (dischargeCutoff) {
        if (candidateDt) return candidateDt < dischargeCutoff;
        if (isDischargeDay && dischargeMinutes != null) return (hour * 60) < dischargeMinutes;
      }
      if (surgeryCutoff && isAfterSurgeryTime(candidateTime, surgeryCutoff, { allowEqual: true })) return false;
      return true;
    })
    .sort((a, b) => a - b);

  const specialItems = allSpecialEvents.map(ev => {
    const time_full = ev.time_full || (ev.time_label && ngayLam ? `${ev.time_label} ${ngayLam}` : ev.time_label);
    const evType = String(ev.type || '').trim();
    let chamSoc = String(ev.cham_soc || '').trim() || defaultSpecialChamSoc(ev);
    // Dữ liệu cũ có thể còn lưu event chuyển khoa thường trong khi record là hậu phẫu.
    // Ưu tiên mẫu chăm sóc sau mổ thay vì "Hướng dẫn nội quy khoa phòng".
    if (ADMISSION_TYPES.has(evType) && hasPostopReceiveContext(merged)) {
      chamSoc = POSTOP_RECEIVE_CARE;
    }
    return {
      time_full,
      time_label:   ev.time_label || String(time_full || '').split(' ')[0],
      dieu_duong:   getNurseForSpecialEvent(ev, time_full, nurseSchedule),
      dien_bien:    String(ev.dien_bien || '').trim()  || defaultSpecialDienBien(ev),
      cham_soc:     chamSoc,
      needs_vitals: ev.needs_vitals !== false && ev.type !== SPECIAL_EVENT_TYPES.discharge,
      special_type: ev.type || 'special',
    };
  });

  const regularItems = hours.map(hour => {
    const time_full  = explicitActionTimeByHour.get(hour) || buildCareTimeKey(hour, ngayLam);
    const time_label = `${String(hour).padStart(2, '0')}:00`;
    const dieu_duong = getNurseByShift(time_full, nurseSchedule);
    const cham_soc_items = [];

    if (medHours.includes(hour)) {
      cham_soc_items.push('Thực hiện chỉ định thuốc');
    }
    if (hour === 5 || hour === 16) cham_soc_items.push('Lấy dấu hiệu sinh tồn');
    cham_soc_items.push(...(actionMap.get(hour) || []));

    const uniqueActions = dedupeStrings(cham_soc_items);
    const dien_bien = (!isPostopReceiveDay && !isAdmissionTransferDay && hour === 8)
      ? buildCareDienBien(merged, uniqueActions)
      : 'Người bệnh tỉnh';

    return { time_full, time_label, dieu_duong, dien_bien, cham_soc: uniqueActions.join(' + ') };
  });

  return [...specialItems, ...regularItems]
    .filter(item => {
      if (!(item.dien_bien || item.cham_soc || item.dieu_duong)) return false;
      if (isBeforeWorkStartOnSameDate(item.time_full, ngayLam)) return false;
      if (dischargeCutoff) {
        const allowEqual = item.special_type === SPECIAL_EVENT_TYPES.discharge;
        if (!isBeforeDischargeTime(item.time_full, dischargeCutoff, { allowEqual })) return false;
      }
      if (surgeryCutoff && isAfterSurgeryTime(item.time_full, surgeryCutoff, { allowEqual: true })) return false;
      return true;
    })
    .sort((a, b) => sortByDateTimeAsc(a.time_full, b.time_full));
}

function buildInfusionPreview(dichTruyen = [], nurseSchedule = {}, record = {}) {
  const cutoff = getDischargeCutoff(record);
  const surgeryCutoff = getSurgeryCutoff(record);
  return [...(dichTruyen || [])]
    .filter(item => {
      const start = String(item.tg_bat_dau || item.gio_dung || '').trim();
      const end = String(item.tg_ket_thuc || '').trim();
      if (cutoff) {
        if (isAfterDischargeTime(start, cutoff, { allowEqual: true })) return false;
        if (end && isAfterDischargeTime(end, cutoff)) return false;
      }
      if (surgeryCutoff) {
        if (isAfterSurgeryTime(start, surgeryCutoff, { allowEqual: true })) return false;
        if (end && isAfterSurgeryTime(end, surgeryCutoff, { allowEqual: false })) return false;
      }
      return true;
    })
    .map(item => {
      const tg_bat_dau = String(item.tg_bat_dau || item.gio_dung || '').trim();
      const ten_chuan  = buildDrugDisplayName(item);
      return {
        bac_si:          String(item.bac_si || '').trim(),
        dieu_duong:      String(item.dieu_duong || getNurseByShift(tg_bat_dau, nurseSchedule) || '').trim(),
        ten_chuan,
        chon_thuoc:      buildDrugSearchName(item.ten_thuoc || item.ten_hien_thi || ''),
        ten_hien_thi:    ten_chuan,
        the_tich:        item.the_tich || '',
        toc_do:          item.toc_do   || '',
        tg_bat_dau:      formatDateTimeDisplay(tg_bat_dau),
        tg_ket_thuc:     formatDateTimeDisplay(String(item.tg_ket_thuc || '').trim()),
        duong_dung_goc:  sanitizeDisplayText(item.duong_dung_goc || ''),
      };
    })
    .sort((a, b) => sortByDateTimeAsc(a.tg_bat_dau, b.tg_bat_dau));
}

function buildPreview(record, allDichTruyen = [], nurseSchedule = {}) {
  return {
    care:      buildCarePreview(record, nurseSchedule),
    infusions: buildInfusionPreview(allDichTruyen, nurseSchedule, record),
  };
}

module.exports = { buildCareTimeKey, formatCareDateTime, getDischargeCutoff, isAfterDischargeTime, isBeforeWorkStartOnSameDate, getSurgeryCutoff, isAfterSurgeryTime, collectMedicationPlan, extractCareActionsByHour, extractExplicitActionTimeByHour, parseCareTimeMinutes, getSpecialCareEvents, SPECIAL_EVENT_TYPES, ADMISSION_TYPES, getPostopReceiveEvents, getDischargeEvents, getAdmissionTransferEvents, defaultSpecialDienBien, defaultSpecialChamSoc, getNurseForSpecialEvent, buildCarePreview, buildInfusionPreview, buildPreview };
