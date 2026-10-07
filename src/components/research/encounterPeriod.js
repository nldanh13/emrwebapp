// Giai đoạn của một dòng XN/CĐHA/thuốc/PT so với đợt điều trị (theo encounter_match_method của chuẩn hóa).
// Dòng ngoài khoảng nằm viện được gắn kèm đợt có chủ đích nhưng phải nhận ra ngay.
const PERIODS = {
  pre_admission: { label: 'Trước nhập viện', outside: true },
  emergency_before_ward: { label: 'Cấp cứu, trước vào khoa', outside: false },
};

export function encounterPeriod(row) {
  const known = PERIODS[String(row?.encounter_match_method || '').trim()];
  return known || { label: 'Trong đợt', outside: false, inStay: true };
}

export function countOutsideStay(enc) {
  return ['labs', 'imaging', 'medications', 'surgeries']
    .reduce((sum, kind) => sum + (enc?.[kind] || []).filter(r => encounterPeriod(r).outside).length, 0);
}
