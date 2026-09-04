'use strict';

const { safeArray, stableHash, normText, toNumber } = require('./common');

function flatten(snapshot) {
  const map = new Map();
  for (const p of safeArray(snapshot?.patients)) {
    for (const item of safeArray(p.items)) {
      const key = item.key || stableHash([item.patientId || p.patientId, item.itemType, normText(item.name), normText(item.route), normText(item.date)], 16);
      const qty = toNumber(item.qty, 1);
      if (!map.has(key)) map.set(key, { ...item, key, qty, patientId: item.patientId || p.patientId, patientName: item.patientName || p.patientName, room: item.room || p.room, doctor: item.doctor || p.doctor });
      else {
        const prev = map.get(key);
        prev.qty += qty;
      }
    }
  }
  return map;
}

function classifyItem(base, current) {
  const diffQty = Number((toNumber(current?.qty, 0) - toNumber(base?.qty, 0)).toFixed(2));
  const common = { ...(current || base), beforeQty: base?.qty || 0, afterQty: current?.qty || 0, diffQty };
  if (!base && current) return { ...common, qty: current.qty, action: 'LINH_THEM', reason: 'Mục mới xuất hiện ở snapshot chiều.' };
  if (base && !current) return { ...common, qty: base.qty, action: 'LAM_PHIEU_TRA_KHO', reason: 'Mục có ở snapshot sáng nhưng không còn ở snapshot chiều.' };
  if (diffQty > 0) return { ...common, qty: diffQty, action: 'LINH_THEM', reason: 'Số lượng chiều tăng so với sáng.' };
  if (diffQty < 0) return { ...common, qty: Math.abs(diffQty), action: 'LAM_PHIEU_TRA_KHO', reason: 'Số lượng chiều giảm so với sáng.' };
  return { ...common, qty: current.qty, action: 'GIU_NGUYEN', reason: 'Không thay đổi.' };
}

function compareSnapshots(morning, afternoon) {
  const a = flatten(morning);
  const b = flatten(afternoon);
  const keys = new Set([...a.keys(), ...b.keys()]);
  const added = [];
  const returned = [];
  const unchanged = [];
  const changed = [];
  for (const key of keys) {
    const result = classifyItem(a.get(key), b.get(key));
    if (result.action === 'LINH_THEM') added.push(result);
    else if (result.action === 'LAM_PHIEU_TRA_KHO') returned.push(result);
    else unchanged.push(result);
    if (result.diffQty !== 0) changed.push(result);
  }
  const sort = (x, y) => String(x.room || '').localeCompare(String(y.room || ''), 'vi') || String(x.patientName || '').localeCompare(String(y.patientName || ''), 'vi') || String(x.name || '').localeCompare(String(y.name || ''), 'vi');
  added.sort(sort); returned.sort(sort); unchanged.sort(sort); changed.sort(sort);
  return {
    version: 2,
    createdAt: new Date().toISOString(),
    baseSnapshotAt: morning?.createdAt || null,
    compareSnapshotAt: afternoon?.createdAt || null,
    added,
    returned,
    unchanged,
    changed,
    counts: { added: added.length, returned: returned.length, unchanged: unchanged.length, changed: changed.length },
  };
}

module.exports = { compareSnapshots, flatten, classifyItem };
