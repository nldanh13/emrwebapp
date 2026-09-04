'use strict';

const { parseDmy, doneKey } = require('../validation');

function patientIdOfTarget(item) {
  if (item == null) return '';
  if (typeof item === 'string' || typeof item === 'number') return String(item).trim();
  return String(item.ma_bn || item.MaBN || item.id || item.patient_id || '').trim();
}


function roomOfTargetRow(row) {
  return String(row?.so_phong || row?.room || row?.Vi_Tri || row?.phong_giuong || row?.['Phòng'] || row?.['Vị trí'] || '').trim();
}

function normalizeRoomCode(value) {
  const raw = String(value || '').trim();
  const m = raw.match(/p\s*0*(\d{1,3})/i);
  if (!m) return raw;
  const n = Number(m[1]);
  return n > 0 ? `P${String(n).padStart(2, '0')}` : raw;
}

function roomMatchesTarget(row, roomSet, normalizedRoomSet) {
  if (!roomSet?.size) return true;
  const room = roomOfTargetRow(row);
  return roomSet.has(room) || normalizedRoomSet.has(normalizeRoomCode(room));
}

function datesOfTargetPatient(item) {
  if (!item || typeof item !== 'object') return [];
  const dates = Array.isArray(item.available_dates) && item.available_dates.length
    ? item.available_dates
    : [item.ngay_lam].filter(Boolean);
  return dates.map(x => String(x || '').trim()).filter(Boolean);
}

function normalizeInputTargets(rawTargets = {}, processedRows = []) {
  const raw          = rawTargets && typeof rawTargets === 'object' ? rawTargets : {};
  const rawPatientIds = Array.isArray(raw.patientIds) ? raw.patientIds : [];
  const patientIds   = [];
  const patientDates = { ...((raw.patientDates && typeof raw.patientDates === 'object') ? raw.patientDates : {}) };
  const seen         = new Set();

  for (const item of rawPatientIds) {
    const id = patientIdOfTarget(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    patientIds.push(id);
    const dates = datesOfTargetPatient(item);
    if (dates.length && !Array.isArray(patientDates[id])) patientDates[id] = dates;
  }

  const selectedDates = Array.isArray(raw.selectedDates)
    ? raw.selectedDates.map(x => String(x || '').trim()).filter(Boolean)
    : [];

  const targetRooms = [...new Set([
    ...(Array.isArray(raw.targetRooms) ? raw.targetRooms : []),
    ...(Array.isArray(raw.selectedRooms) ? raw.selectedRooms : []),
  ].map(x => String(x || '').trim()).filter(Boolean))];

  const targetRoomSet = new Set(targetRooms);
  const normalizedTargetRoomSet = new Set(targetRooms.map(normalizeRoomCode).filter(Boolean));
  const allowedDatesByPatient = new Map();

  if (targetRooms.length && Array.isArray(processedRows) && processedRows.length) {
    for (const row of processedRows) {
      const rowId = String(row?.ma_bn || row?.id || '').trim();
      if (!rowId || !roomMatchesTarget(row, targetRoomSet, normalizedTargetRoomSet)) continue;
      const ngay = String(row?.ngay_lam || '').trim();
      if (!allowedDatesByPatient.has(rowId)) allowedDatesByPatient.set(rowId, new Set());
      if (ngay) allowedDatesByPatient.get(rowId).add(ngay);
    }

    for (let i = patientIds.length - 1; i >= 0; i -= 1) {
      const id = patientIds[i];
      const allowedDates = allowedDatesByPatient.get(id);
      if (!allowedDates) {
        patientIds.splice(i, 1);
        continue;
      }

      const currentDates = Array.isArray(patientDates[id])
        ? patientDates[id].map(x => String(x || '').trim()).filter(Boolean)
        : [];
      const sourceDates = currentDates.length ? currentDates : selectedDates;
      if (sourceDates.length) {
        const filteredDates = [...new Set(sourceDates)].filter(ngay => allowedDates.has(ngay));
        if (!filteredDates.length) {
          patientIds.splice(i, 1);
          delete patientDates[id];
          continue;
        }
        patientDates[id] = filteredDates;
      }
    }

    const allowedIds = new Set(patientIds);
    for (const id of Object.keys(patientDates)) {
      if (!allowedIds.has(id)) delete patientDates[id];
    }
  }

  // Nếu không có date filter toàn cục → tự động lấy các ngày từ file processed
  const hasGlobalDateFilter = Boolean(String(raw.from || '').trim() || String(raw.to || '').trim() || selectedDates.length);
  if (!hasGlobalDateFilter) {
    for (const id of patientIds) {
      if (Array.isArray(patientDates[id]) && patientDates[id].length) continue;
      const dates    = [];
      const seenDates = new Set();
      for (const row of (Array.isArray(processedRows) ? processedRows : [])) {
        const rowId = String(row?.ma_bn || row?.id || '').trim();
        if (rowId !== id) continue;
        if (targetRooms.length && !roomMatchesTarget(row, targetRoomSet, normalizedTargetRoomSet)) continue;
        const ngay = String(row?.ngay_lam || '').trim();
        if (!ngay || seenDates.has(ngay)) continue;
        seenDates.add(ngay);
        dates.push(ngay);
      }
      if (dates.length) patientDates[id] = dates;
    }
  }

  return { ...raw, patientIds, patientDates, selectedDates, targetRooms };
}

/** @internal — không còn được dùng bởi routes hiện tại. Giữ lại để tham khảo. */
function resolveDoneKeysForTargets(processedRows, targets = {}) {
  const patientIds   = Array.isArray(targets.patientIds) ? targets.patientIds : [];
  const fallbackDate = String(targets.ngay_lam || '').trim();
  const wanted       = new Set(patientIds.map(id => String(id || '').trim()).filter(Boolean));
  if (!wanted.size) return [];

  const patientDatesRaw = (targets?.patientDates && typeof targets.patientDates === 'object') ? targets.patientDates : {};
  const selectedDates   = Array.isArray(targets.selectedDates)
    ? targets.selectedDates.map(x => String(x || '').trim()).filter(Boolean)
    : [];

  const out  = [];
  const seen = new Set();
  const pushKey = (id, ngay) => {
    const key = doneKey(id, ngay);
    if (!seen.has(key)) { seen.add(key); out.push(key); }
  };

  for (const id of wanted) {
    const dates = Array.isArray(patientDatesRaw[id])
      ? patientDatesRaw[id].map(x => String(x || '').trim()).filter(Boolean)
      : [];
    if (dates.length)         { dates.forEach(ngay => pushKey(id, ngay)); continue; }
    if (selectedDates.length) { selectedDates.forEach(ngay => pushKey(id, ngay)); continue; }
    if (fallbackDate)         { pushKey(id, fallbackDate); }
  }

  if (out.length) return out;

  // Fallback: lấy ngày gần nhất từ processedRows
  const latestDateByPatient = new Map();
  for (const row of (Array.isArray(processedRows) ? processedRows : [])) {
    const id   = String(row?.ma_bn || '').trim();
    if (!id || !wanted.has(id)) continue;
    const ngay = String(row?.ngay_lam || '').trim();
    if (!ngay) continue;
    const prev = latestDateByPatient.get(id);
    if (!prev || parseDmy(ngay) > parseDmy(prev)) latestDateByPatient.set(id, ngay);
  }

  return [...wanted].map(id => doneKey(id, latestDateByPatient.get(id) || fallbackDate));
}

module.exports = { patientIdOfTarget, datesOfTargetPatient, normalizeInputTargets, resolveDoneKeysForTargets, roomOfTargetRow, normalizeRoomCode };
