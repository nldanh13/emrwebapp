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

module.exports = { firstSurgeryByEncounter, surgeryForMedicationContext };
