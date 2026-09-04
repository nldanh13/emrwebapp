import { useCallback, useSyncExternalStore } from 'react';

export function useWindowWidth() {
  const subscribe = useCallback((cb) => {
    window.addEventListener('resize', cb);
    return () => window.removeEventListener('resize', cb);
  }, []);
  const getSnapshot = () => typeof window !== 'undefined' ? window.innerWidth : 1024;
  return useSyncExternalStore(subscribe, getSnapshot, () => 1024);
}

const ROOM_CONFIG_KEY = 'emr_room_config_v1';

export function buildDefaultRooms() {
  const r = {};
  r['P01'] = 4;
  for (let i = 2; i <= 7; i++)  r[`P${String(i).padStart(2,'0')}`] = 2;
  for (let i = 8; i <= 11; i++) r[`P${String(i).padStart(2,'0')}`] = 6;
  return r;
}

export function loadRoomConfig() {
  try {
    const raw = localStorage.getItem(ROOM_CONFIG_KEY);
    if (raw) return { ...buildDefaultRooms(), ...JSON.parse(raw) };
  } catch (_) {}
  return buildDefaultRooms();
}

export function saveRoomConfig(cfg) {
  try { localStorage.setItem(ROOM_CONFIG_KEY, JSON.stringify(cfg)); } catch (_) {}
}

export function normalizeRoom(s) {
  if (!s) return '';
  const m = String(s).trim().match(/p\s*0*(\d{1,3})/i);
  if (!m) return '';
  const n = parseInt(m[1], 10);
  return n > 0 ? `P${String(n).padStart(2,'0')}` : '';
}

export function getPatientId(p) {
  return String(p['Mã BN'] ?? p['ma_bn'] ?? p['Mã YT'] ?? p['ma_yt'] ?? '').trim();
}

export function getPatientName(p) {
  const raw = String(p['Họ tên'] ?? p['ho_ten'] ?? '').trim();
  // Cắt bỏ phần metadata thừa: "- PM: ...", "- P...", v.v.
  const clean = raw.replace(/\s*[-–]\s*(PM|P\d|phòng|giường).*/i, '').trim();
  return clean || getPatientId(p);
}


export function getWardAdmissionTime(p) {
  return String(p?.thoi_gian_vao_khoa ?? p?.tg_vao ?? p?.['T/G vào'] ?? p?.thoi_gian_vao ?? p?.admission_time ?? '').trim();
}

export function getDepartmentName(p) {
  return String(p?.ten_khoa_dieu_tri ?? p?.khoa_dieu_tri ?? p?.khoa_chuyen_den ?? p?.['Tên khoa điều trị'] ?? p?.['Khoa điều trị'] ?? p?.['Khoa chuyển đến'] ?? p?.department_name ?? p?.department ?? '').trim();
}

export function getWardMetaLine(p) {
  const admissionTime = getWardAdmissionTime(p);
  const departmentName = getDepartmentName(p);
  if (!admissionTime && !departmentName) return '';
  return [admissionTime ? `Vào khoa ${admissionTime}` : '', departmentName].filter(Boolean).join(' · ');
}

export function toInputDate(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function fromInputDate(value) {
  const [yyyy, mm, dd] = String(value || '').split('-').map(Number);
  if (!yyyy || !mm || !dd) return '';
  return `${String(dd).padStart(2, '0')}/${String(mm).padStart(2, '0')}/${yyyy}`;
}

export function defaultDefaultRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  // Người dùng chọn khoảng ngày làm việc thật. Worker sẽ tự lấy thêm sáng ngày kế tiếp
  // trước 07:00 cho ngày cuối, nên mặc định UI chỉ cần chọn hôm nay → hôm nay.
  return { from: toInputDate(start), to: toInputDate(start) };
}

export function sortedRoomEntries(roomConfig) {
  return Object.entries(roomConfig || {}).sort(([a], [b]) => a.localeCompare(b));
}

export function sanitizePatientsForSave(patients) {
  return (patients || []).map((p) => {
    const clean = { ...p };
    Object.keys(clean).forEach((k) => {
      if (k.startsWith('_')) delete clean[k];
    });
    return clean;
  });
}

export function filterUnassignedPatients(patients, search) {
  const q = String(search || '').trim().toLowerCase();
  const unassigned = (patients || []).filter(p => !normalizeRoom(p.Vi_Tri || ''));
  if (!q) return unassigned;
  return unassigned.filter(p => (
    getPatientName(p).toLowerCase().includes(q) ||
    getPatientId(p).toLowerCase().includes(q)
  ));
}
