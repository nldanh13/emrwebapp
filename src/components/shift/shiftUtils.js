import { useEffect, useState } from 'react';

export function useWindowWidth() {
  const [w, setW] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1024));
  useEffect(() => {
    const handle = () => setW(window.innerWidth);
    window.addEventListener('resize', handle);
    return () => window.removeEventListener('resize', handle);
  }, []);
  return w;
}


export function normalizeClockTime(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const m = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('vi-VN', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export function fmtAge(ms) {
  if (!ms) return '';
  const mins = Math.round((Date.now() - ms) / 60_000);
  if (mins < 1) return 'vừa xong';
  if (mins < 60) return `${mins} phút trước`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} giờ trước`;
  return `${Math.round(hrs / 24)} ngày trước`;
}

export function patientIdOf(item) {
  if (item == null) return '';
  if (typeof item === 'string' || typeof item === 'number') return String(item).trim();
  return String(item.ma_bn || item.MaBN || item.id || item.patient_id || '').trim();
}

export function patientNameOf(item) {
  if (!item || typeof item !== 'object') return patientIdOf(item);
  return String(item.ho_ten || item.name || item['Họ tên'] || patientIdOf(item) || '').trim();
}

export function datesOfPatient(item) {
  if (!item || typeof item !== 'object') return [];
  const dates = Array.isArray(item.available_dates) && item.available_dates.length
    ? item.available_dates
    : [item.ngay_lam].filter(Boolean);
  return dates.map(x => String(x || '').trim()).filter(Boolean);
}

function shouldInputDate(item, date, taskType = '', options = {}) {
  const cleanDate = String(date || '').trim();
  const hasDayMap = item?.day_map && typeof item.day_map === 'object';
  const hasExplicitDay = hasDayMap && Object.prototype.hasOwnProperty.call(item.day_map, cleanDate);
  const fallbackMatches = String(item?.ngay_lam || '').trim() === cleanDate;
  if (cleanDate && hasDayMap && !hasExplicitDay && !fallbackMatches) return false;
  const day = (hasExplicitDay ? item.day_map[cleanDate] : null) || (fallbackMatches ? item : {});
  const task = String(taskType || '').toLowerCase();
  const includeDone = Boolean(options.includeDone || options.repairExisting || options.allowDone);
  const onlyDone = Boolean(options.onlyDone || options.existingOnly || options.recheckExisting);
  if (task === 'care') {
    if (day.care_required === false) return false;
    if (onlyDone) return Boolean(day.care_done);
    if (includeDone) return true;
    return !(day.care_done && !day.care_stale);
  }
  if (task === 'infusion' || task === 'infusions' || task === 'dt') {
    const hasExpectedInfusion = Boolean(day.has_infusion || day.has_inf);
    // Khi chạy luồng hợp nhất, vẫn kiểm tra ngày đã từng nhập dù y lệnh hiện tại
    // không còn dịch truyền. Worker cần mở ngày này để dọn dòng cũ/thừa trên EMR.
    if (!hasExpectedInfusion && !(includeDone && day.infus_done)) return false;
    if (includeDone) return true;
    return !(day.infus_done && !day.infus_stale);
  }
  if (task === 'procedure' || task === 'procedures' || task === 'tt') {
    const hasExpectedProcedure = Boolean(day.has_procedure);
    if (!hasExpectedProcedure && !(includeDone && day.procedure_done)) return false;
    if (includeDone) return true;
    return !(day.procedure_done && !day.procedure_stale);
  }
  return true;
}



export function buildInputTargets(items = [], selectedDate = null, taskType = '', options = {}) {
  const arr = Array.isArray(items) ? items : [items];
  const patientIds = [];
  const patientDates = {};
  const patientSummaries = [];
  const seen = new Set();
  const explicitDates = Array.isArray(selectedDate)
    ? selectedDate.map(x => String(x || '').trim()).filter(Boolean)
    : (selectedDate ? [String(selectedDate).trim()].filter(Boolean) : null);
  const includeDone = Boolean(options.includeDone || options.repairExisting || options.allowDone);
  const onlyDone = Boolean(options.onlyDone || options.existingOnly || options.recheckExisting);

  for (const item of arr) {
    const id = patientIdOf(item);
    if (!id) continue;
    const candidateDates = explicitDates ? explicitDates : datesOfPatient(item);
    const dates = candidateDates.filter(date => shouldInputDate(item, date, taskType, { includeDone, onlyDone }));
    if (!dates.length) continue;
    if (!seen.has(id)) {
      seen.add(id);
      patientIds.push(id);
      patientSummaries.push({
        id,
        name: patientNameOf(item),
        room: patientRoom(item),
      });
    }
    patientDates[id] = [...new Set([...(patientDates[id] || []), ...dates])];
  }

  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const today = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  const selectedDates = explicitDates || [];

  return {
    patientIds,
    patientDates,
    patientSummaries,
    selectedDates,
    ngay_lam: selectedDates.length === 1 ? selectedDates[0] : today,
    taskType,
    repairExisting: includeDone,
    includeDone,
    onlyDone,
  };
}

export function dateRangeLabel(item) {
  const dates = Array.isArray(item?.data_dates) ? item.data_dates.filter(Boolean) : [];
  if (!dates.length) return 'Không rõ ngày';
  if (dates.length === 1) return dates[0];
  return `${dates[dates.length - 1]} → ${dates[0]}`;
}

export function primaryLabel(primary) {
  if (primary === 'processed') return 'Đã phân loại';
  if (primary === 'raw') return 'Danh sách quét';
  if (primary === 'sorted') return 'Đã xếp phòng';
  return 'Y lệnh thô';
}

export function patientRoom(p) {
  return p?.so_phong || p?.room || p?.Vi_Tri || p?.phong_giuong || '';
}

export function getRooms(patients) {
  return [...new Set((patients || []).map(patientRoom).filter(Boolean))].sort();
}

export function getShiftStats(patients) {
  const list = Array.isArray(patients) ? patients : [];
  return {
    total: list.length,
    gray: list.filter(p => p.status === 'gray').length,
    amber: list.filter(p => p.status === 'amber').length,
    green: list.filter(p => p.status === 'green').length,
  };
}

export function filterPatientsByRoom(patients, room) {
  const list = Array.isArray(patients) ? patients : [];
  return room ? list.filter(p => patientRoom(p) === room) : list;
}

export function patientsInRoom(patients, room) {
  return (patients || []).filter(p => patientRoom(p) === room);
}
