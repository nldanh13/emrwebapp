import { safeText, normalizeText, normalizeRoom } from '../utils/text.js';
import { isCtchTkDoctor, getResponsibleDoctorByRoom } from '../config/doctors.js';

function matchField(text, regex) {
  return text.match(regex)?.[1]?.trim() || '';
}

function isCurrentStatus(value) {
  return normalizeText(value).includes('dang thuc hien');
}

function parseVNDateTime(value) {
  const s = String(value || '').trim();
  const m = s.match(/(\d{1,2}):(\d{2})\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const d = new Date(Number(m[5]), Number(m[4]) - 1, Number(m[3]), Number(m[1]), Number(m[2]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function extractRoomNameFromHeading(h2) {
  const afterPipe = String(h2 || '').split('|')[1] || '';
  return afterPipe.replace(/\([^)]*\)/g, '').trim();
}

function getTimelineBlocks(container) {
  const directRows = Array.from(container.children || []).filter((el) => el.matches?.('.row'));
  if (directRows.length) return directRows;
  return Array.from(container.querySelectorAll('.row')).filter((row) => row.querySelector('h2'));
}

export function parseBedTimeline(root = document) {
  const container = root.querySelector('#vertical-timeline');
  if (!container) return [];

  return getTimelineBlocks(container).map((block, index) => {
    const text = safeText(block.innerText || block.textContent || '');
    const h2 = safeText(block.querySelector('h2')?.innerText || block.querySelector('h2')?.textContent || '');
    const p = safeText(block.querySelector('p')?.innerText || block.querySelector('p')?.textContent || '');
    const phong = extractRoomNameFromHeading(h2);
    const nguoiChiDinh = matchField(text, /Người\s+chỉ\s+định:\s*(.*?)\s*Loại:/i);
    const maGiuong = h2.match(/Giường\s*([^|]+)/i)?.[1]?.trim() || '';
    const trangThai = matchField(text, /Trạng\s*thái:\s*(.*?)\s*Từ:/i);
    const tu = matchField(text, /Từ:\s*([0-9: ]+\d{1,2}\/\d{1,2}\/\d{4})/i);
    const den = matchField(text, /Đến:\s*([0-9: ]+\d{1,2}\/\d{1,2}\/\d{4})/i);
    const expectedDoctor = getResponsibleDoctorByRoom(phong || maGiuong);
    const doctorOk = !expectedDoctor || !nguoiChiDinh || normalizeText(expectedDoctor) === normalizeText(nguoiChiDinh);

    return {
      index,
      trang_thai: trangThai,
      is_current: isCurrentStatus(trangThai),
      tu,
      den,
      nguoi_chi_dinh: nguoiChiDinh,
      loai_nam: matchField(text, /Loại:\s*(.*?)(?:\s*Giường|$)/i),
      ma_giuong: maGiuong,
      phong,
      phong_norm: normalizeRoom(phong || maGiuong),
      khoa: h2.match(/\(([^)]+)\)/)?.[1]?.trim() || '',
      ten_dich_vu_giuong: p.split('|')[0]?.trim() || '',
      mo_ta_day_du: p,
      is_ctch_tk_doctor: isCtchTkDoctor(nguoiChiDinh),
      expected_doctor_by_room: expectedDoctor,
      doctor_matches_room: doctorOk,
    };
  });
}

export function getCurrentBedFromTimeline(timeline = []) {
  const rows = Array.isArray(timeline) ? timeline : [];
  const active = rows.filter((row) => row?.is_current || isCurrentStatus(row?.trang_thai));
  if (active.length) {
    return active.sort((a, b) => (parseVNDateTime(b.tu)?.getTime() || 0) - (parseVNDateTime(a.tu)?.getTime() || 0))[0];
  }
  return [...rows].sort((a, b) => (parseVNDateTime(b.tu)?.getTime() || 0) - (parseVNDateTime(a.tu)?.getTime() || 0))[0] || null;
}

export function checkCurrentBedTimeline(timeline = []) {
  const current = getCurrentBedFromTimeline(timeline);
  const warnings = [];

  if (!timeline.length) warnings.push('Không đọc được timeline buồng giường.');
  if (!current) warnings.push('Không xác định được giường hiện tại.');
  else {
    if (!current.is_current) warnings.push('Không thấy dòng trạng thái Đang thực hiện; đang lấy dòng mới nhất làm tạm thời.');
    if (!current.phong_norm) warnings.push('Không xác định được số phòng từ thông tin buồng giường.');
    if (!current.nguoi_chi_dinh) warnings.push('Thiếu người chỉ định buồng giường.');
    if (current.nguoi_chi_dinh && !current.is_ctch_tk_doctor) warnings.push(`Người chỉ định không nằm trong danh sách bác sĩ CTCH-TK: ${current.nguoi_chi_dinh}.`);
    if (current.expected_doctor_by_room && current.nguoi_chi_dinh && !current.doctor_matches_room) {
      warnings.push(`Phòng ${current.phong_norm}: bác sĩ phụ trách dự kiến là ${current.expected_doctor_by_room}, nhưng người chỉ định là ${current.nguoi_chi_dinh}.`);
    }
  }

  return {
    status: warnings.length ? 'warning' : 'ok',
    current,
    timeline_count: timeline.length,
    warnings,
  };
}
