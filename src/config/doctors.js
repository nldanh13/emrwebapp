import { normalizeName, normalizeRoom } from '../utils/text.js';

export const CTCH_TK_DOCTORS = Object.freeze([
  'Nguyễn Thành Tấn',
  'Nguyễn Lê Hoan',
  'Nguyễn Chí Nguyện',
  'Hồ Điền',
  'Trần Quốc Toản',
  'Phạm Việt Tân',
  'Phan Văn Tuấn',
  'Trần Quang Sơn',
  'Nguyễn Tư Thái Bảo',
  'Trần Nguyễn Anh Duy',
  'Nguyễn Giang Tử',
]);

export const ROOM_DOCTOR_MAP = Object.freeze({
  P01: 'Trần Nguyễn Anh Duy',
  P02: 'Trần Nguyễn Anh Duy',
  P03: 'Trần Quang Sơn',
  P04: 'Trần Quang Sơn',
  P05: 'Nguyễn Tư Thái Bảo',
  P06: 'Nguyễn Tư Thái Bảo',
  P07: 'Nguyễn Tư Thái Bảo',
  P08: 'Hồ Điền',
  P09: 'Trần Quốc Toản',
  P10: 'Nguyễn Chí Nguyện',
  P11: 'Phạm Việt Tân',
});

const CTCH_TK_DOCTOR_SET = new Set(CTCH_TK_DOCTORS.map(normalizeName));

export function isCtchTkDoctor(name) {
  return CTCH_TK_DOCTOR_SET.has(normalizeName(name));
}

export function getResponsibleDoctorByRoom(room) {
  return ROOM_DOCTOR_MAP[normalizeRoom(room)] || '';
}
