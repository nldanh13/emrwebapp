// src/utils/workingAge.js — lọc "còn tuổi lao động" cho Giấy chứng nhận nghỉ việc hưởng BHXH.
// Dùng chung cho tab Nghỉ ốm và khung "Xin nghỉ ốm" của Phòng khám.

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

// Tuổi nghỉ hưu theo Bộ luật Lao động 2019 (Nghị định 135/2020/NĐ-CP): tăng dần
// mỗi năm cho đến khi đạt mốc cuối — Nam 60y3m (2021) +3 tháng/năm → 62 (từ 2028);
// Nữ 55y4m (2021) +4 tháng/năm → 60 (từ 2035). Dùng làm ngưỡng lọc "còn tuổi lao
// động" khi quét EMR (chỉ có năm sinh, không có ngày/tháng) — không phải căn cứ
// pháp lý chính xác tuyệt đối, chỉ để loại bớt người rõ ràng ngoài tuổi lao động.
export function laborRetirementAgeYears(year, isFemale) {
  const y = Math.max(2021, Math.min(Number(year) || 2021, isFemale ? 2035 : 2028));
  const months = isFemale ? (55 * 12 + 4 + (y - 2021) * 4) : (60 * 12 + 3 + (y - 2021) * 3);
  return months / 12;
}

// Chỉ có năm sinh trên danh sách quét EMR (không có ngày/tháng sinh) nên tuổi tính
// được có thể lệch tới 1 năm — nới biên 1 tuổi hai đầu để tránh loại nhầm ca sát
// ngưỡng. Thiếu năm sinh/giới tính thì không loại (để người dùng tự xem, tránh bỏ sót).
export function isLikelyWorkingAge(namSinh, gioiTinh, refYear) {
  const birthYear = Number(String(namSinh || '').trim());
  if (!birthYear || birthYear < 1900 || birthYear > refYear) return true;
  const age = refYear - birthYear;
  const isFemale = /^n[uữ]/.test(normalizeText(gioiTinh || ''));
  const retireAge = laborRetirementAgeYears(refYear, isFemale);
  return age >= 14 && age <= retireAge + 1;
}

// Giống isLikelyWorkingAge() nhưng dùng tuổi trực tiếp (cột "Tuổi" trong bảng
// tblNoiTru của tab Phòng khám) thay vì ước tính từ năm sinh — chính xác hơn nên
// không cần nới biên như bản kia.
export function isLikelyWorkingAgeByAge(tuoi, gioiTinh, refYear) {
  const age = Number(String(tuoi || '').trim());
  if (!Number.isFinite(age) || age <= 0) return true;
  const isFemale = /^n[uữ]/.test(normalizeText(gioiTinh || ''));
  const retireAge = laborRetirementAgeYears(refYear, isFemale);
  return age >= 14 && age <= retireAge;
}
