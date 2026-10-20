'use strict';

function firstSurgeryByEncounter(surgeryRows) {
  const byEncounter = new Map();
  for (const surg of Array.isArray(surgeryRows) ? surgeryRows : []) {
    const encounterId = String(surg?.encounter_id || '').trim();
    if (!encounterId) continue;
    const current = byEncounter.get(encounterId);
    const currentTime = String(current?.surgery_datetime || current?.surgery_date || '');
    const candidateTime = String(surg?.surgery_datetime || surg?.surgery_date || '');
    // Dòng có ngày luôn thắng dòng không có ngày (trước đây dòng không ngày đứng trước giữ
    // chỗ mãi); giữa hai dòng có ngày, chọn dòng sớm hơn (chuỗi ISO so sánh được).
    if (!current || (candidateTime && (!currentTime || candidateTime.localeCompare(currentTime) < 0))) {
      byEncounter.set(encounterId, surg);
    }
  }
  return byEncounter;
}

function surgeryForMedicationContext(byEncounter, ctx) {
  const encounterId = String(ctx?.encounter_id || '').trim();
  if (!encounterId) return null;
  return byEncounter?.get(encounterId) || null;
}

// Gắn ngày ca mổ sớm nhất đã xác minh (ghép chắc chắn, nằm trong đợt) vào ngữ cảnh đợt điều trị,
// để encounters.surgery_date và days_from_surgery của các bảng con có giá trị. Ngày đã có sẵn
// trên ngữ cảnh (cột "Ngày mổ" của nguồn) được giữ nguyên.
function applyVerifiedSurgeryDates(ctxMap, surgeryRows) {
  const verified = (Array.isArray(surgeryRows) ? surgeryRows : [])
    .filter(row => row?.encounter_match_status === 'matched' && row?.is_within_encounter === '1');
  const byEncounter = firstSurgeryByEncounter(verified);
  let applied = 0;
  for (const [key, list] of ctxMap || []) {
    if (!String(key).startsWith('patient:') || !Array.isArray(list)) continue;
    for (const ctx of list) {
      if (!ctx || ctx.surgery_date) continue;
      const surg = byEncounter.get(String(ctx.encounter_id || '').trim());
      const day = String(surg?.surgery_date || surg?.surgery_datetime || '').slice(0, 10);
      if (!day) continue;
      ctx.surgery_date = day;
      applied += 1;
    }
  }
  return applied;
}

module.exports = { applyVerifiedSurgeryDates, firstSurgeryByEncounter, surgeryForMedicationContext };
