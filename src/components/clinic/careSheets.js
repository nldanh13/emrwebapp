// src/components/clinic/careSheets.js — 2 phiếu chăm sóc của người bệnh nhập viện từ Phòng khám
// (cùng quy tắc với worker/clinic_input_care.py: care_sheets, ward_time, ward_dien_bien, vitals_errors).
//   Phiếu 1 · Khoa Khám Bệnh chuyển: đúng T/G vào, chăm sóc "Kính chuyển … nhận / Hồ sơ".
//   Phiếu 2 · Khoa nhận: sau T/G vào 15 phút (sửa được), chăm sóc nhận người bệnh, sinh hiệu người dùng nhập.

export const WARD_NAME = 'Khoa Chấn Thương chỉnh hình - Thần kinh';
export const WARD_MINUTES = 15;
export const CLINIC_CARE = [`Kính chuyển ${WARD_NAME} nhận`, 'Hồ sơ'].join('\n');
export const WARD_CARE = ['Nhận HS', 'Lấy dấu hiệu sinh tồn', 'Trình Bs trực', 'Hướng dẫn nội quy khoa phòng', 'Thực hiện CLS'].join('\n');
export const VITAL_FIELDS = [
  ['mach', 'Mạch', 'lần/phút'],
  ['nhiet_do', 'Nhiệt độ', '°C'],
  ['huyet_ap', 'Huyết áp', 'mmHg'],
  ['nhip_tho', 'Nhịp thở', 'lần/phút'],
];

const TIME_RE = /^(\d{1,2}):(\d{2}) (\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const pad = n => String(n).padStart(2, '0');

function parseTime(text) {
  const m = String(text || '').trim().match(TIME_RE);
  if (!m) return null;
  const d = new Date(Number(m[5]), Number(m[4]) - 1, Number(m[3]), Number(m[1]), Number(m[2]));
  return Number.isNaN(d.getTime()) || d.getHours() !== Number(m[1]) ? null : d;
}
const fmtTime = d => `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;

export function wardTime(careTime, minutes = WARD_MINUTES) {
  const d = parseTime(careTime);
  return d ? fmtTime(new Date(d.getTime() + minutes * 60000)) : '';
}

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();

export function wardDienBien(dienBien) {
  const lines = String(dienBien || '').split('\n').filter(l => l.trim());
  const rest = lines.length && norm(lines[0]).includes('nhan') ? lines.slice(1) : lines;
  return [`${WARD_NAME} nhận`, ...rest].join('\n');
}

export function vitalsErrors(v = {}) {
  const checks = {
    mach: x => /^\d{2,3}$/.test(x) && Number(x) >= 30 && Number(x) <= 220,
    nhiet_do: x => /^\d{2}([.,]\d)?$/.test(x) && Number(x.replace(',', '.')) >= 34 && Number(x.replace(',', '.')) <= 43,
    huyet_ap: x => /^\d{2,3}\/\d{2,3}$/.test(x),
    nhip_tho: x => /^\d{1,2}$/.test(x) && Number(x) >= 6 && Number(x) <= 60,
  };
  const out = [];
  for (const [key, label] of VITAL_FIELDS) {
    const value = String(v?.[key] || '').trim();
    if (!value) out.push(`thiếu ${label}`);
    else if (!checks[key](value)) out.push(`${label} "${value}" không hợp lệ`);
  }
  return out;
}

// Dòng tìm được → thêm nội dung mặc định của 2 phiếu.
export function withSheetDefaults(row, dienBien) {
  return {
    ...row,
    dien_bien: dienBien,
    cham_soc: CLINIC_CARE,
    dien_bien_khoa: wardDienBien(dienBien),
    cham_soc_khoa: WARD_CARE,
    khoa_time_str: wardTime(row.care_time_str),
    vitals: { mach: '', nhiet_do: '', huyet_ap: '', nhip_tho: '' },
    sheets_done: null,
    skip: false,
  };
}

// Đổi diễn biến phiếu 1 thì diễn biến phiếu 2 đi theo, trừ khi người dùng đã tự sửa phiếu 2.
export function setClinicDienBien(row, value) {
  const follows = row.dien_bien_khoa === wardDienBien(row.dien_bien);
  return { ...row, dien_bien: value, dien_bien_khoa: follows ? wardDienBien(value) : row.dien_bien_khoa };
}

// Ca không cần nhập: đã có đủ 2 phiếu Hoàn tất trên EMR.
export const bothDone = row => Boolean(row?.sheets_done?.kham && row?.sheets_done?.khoa);

// Còn thiếu gì để nhập được (rỗng = nhập được). Phiếu đã Hoàn tất thì không xét.
export function rowProblems(row) {
  const out = [];
  if (!row?.can_input) return ['không nhập được'];
  const done = row.sheets_done || {};
  if (!done.kham) {
    if (!String(row.dien_bien || '').trim()) out.push('diễn biến phiếu 1');
    if (!String(row.cham_soc || '').trim()) out.push('chăm sóc phiếu 1');
  }
  if (!done.khoa) {
    if (!String(row.dien_bien_khoa || '').trim()) out.push('diễn biến phiếu 2');
    if (!String(row.cham_soc_khoa || '').trim()) out.push('chăm sóc phiếu 2');
    const at = parseTime(row.khoa_time_str);
    const start = parseTime(row.care_time_str);
    if (!at) out.push('giờ phiếu 2 (HH:mm dd/mm/yyyy)');
    else if (start && at <= start) out.push('giờ phiếu 2 phải sau T/G vào');
    out.push(...vitalsErrors(row.vitals));
  }
  return out;
}

export function rowsToInput(rows = []) {
  return rows.filter(r => r.can_input && !r.skip && !bothDone(r) && !rowProblems(r).length);
}
