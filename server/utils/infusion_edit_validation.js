'use strict';

// Matching one local infusion record must not silently edit several doses.
// Do not use patient names, scheduled display labels, or a list index as identity.
function infusionItemKey(item = {}) {
  return [
    String(item.ten_thuoc || '').trim().toLowerCase(),
    String(item.bac_si || '').trim().toLowerCase(),
    String(item.tg_bat_dau || item.gio_dung || '').trim(),
    String(item.tg_ket_thuc || '').trim(),
    String(item.the_tich ?? '').trim(),
    String(item.toc_do ?? '').trim(),
  ].join('|');
}

function parsePositiveInfusionValue(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^\d+(?:[.,]\d+)?$/.test(raw)) {
    throw new Error(`${label} phải là số dương tính theo đúng đơn vị hiển thị.`);
  }
  const num = Number(raw.replace(',', '.'));
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`${label} phải lớn hơn 0.`);
  }
  return num;
}

function matchAndUpdateInfusions(rows, patientId, workDate, match, updates, rowPatientId, rowWorkDate) {
  const key = infusionItemKey(match);
  const targets = [];
  for (const row of (Array.isArray(rows) ? rows : [])) {
    if (rowPatientId(row) !== patientId || rowWorkDate(row) !== workDate) continue;
    for (const item of (Array.isArray(row?.thuoc?.dich_truyen) ? row.thuoc.dich_truyen : [])) {
      if (infusionItemKey(item) === key) targets.push(item);
    }
  }
  if (targets.length !== 1) return { matched: targets.length, updated: false };
  Object.assign(targets[0], updates);
  // Values manually corrected can no longer be treated as unchanged inferred defaults.
  if (Object.hasOwn(updates, 'toc_do')) targets[0].toc_do_inferred = false;
  if (Object.keys(updates).length) {
    // A changed volume/rate invalidates a computed end time and possibly
    // overlapping/queued infusions. Do not keep an old end time as "verified".
    targets[0].infusion_schedule_stale = true;
  }
  return { matched: 1, updated: true };
}

module.exports = { infusionItemKey, parsePositiveInfusionValue, matchAndUpdateInfusions };
