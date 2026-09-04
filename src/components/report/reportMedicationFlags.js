import {
  DUTY_WINDOW, SEPARATED_HOUR_GAP_MINUTES, COMMON_SLOT_MIN_PATIENTS,
  Q6_SCHEDULE_MINUTES, Q6_TOLERANCE_MINUTES, Q6_MIN_MATCHES,
  EARLY_ISOLATED_END_MINUTES, CONTINUOUS_INFUSION_GAP_MINUTES, timeToMinutes,
} from './reportBaseUtils.js';

function groupOf(row, selectedDate) {
  const minutes = timeToMinutes(row.time);
  if (minutes == null) return 'other';
  if (row.date && selectedDate && row.date !== selectedDate && minutes < 7 * 60) return 'earlyNext';
  if (minutes >= 7 * 60 && minutes < 13 * 60) return 'morning';
  if (minutes >= 13 * 60 && minutes < 18 * 60) return 'afternoon';
  if (minutes >= 18 * 60 && minutes < 21 * 60) return 'night20';
  if (minutes >= 21 * 60 && minutes < 24 * 60) return 'night22';
  if (minutes >= 0 && minutes < 7 * 60) return 'earlyNext';
  return 'other';
}

function isOral(row) {
  return row?.route === 'Uống';
}

function rowMinutes(row) {
  return timeToMinutes(row?.time) ?? 9999;
}

function isWorkHourRow(row, selectedDate) {
  const m = rowMinutes(row);
  return row.date === selectedDate && m >= DUTY_WINDOW.workStart && m < DUTY_WINDOW.workEnd;
}

function isMorningRow(row, date) {
  const m = rowMinutes(row);
  return row.date === date && m >= DUTY_WINDOW.workStart && m < DUTY_WINDOW.morningEnd;
}

function isAfterWorkOrEarlyNext(row, selectedDate) {
  const m = rowMinutes(row);
  if (row.date && row.date !== selectedDate) return true;
  return m >= DUTY_WINDOW.workEnd || m < DUTY_WINDOW.workStart;
}

function patientKey(row) {
  return String(row?.patientId || row?.patientName || '').trim();
}

function formatDuration(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m)) return '';
  if (m < 60) return `${m} phút`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} giờ ${rest} phút` : `${h} giờ`;
}

function clockDistanceMinutes(a, b) {
  const diff = Math.abs(Number(a) - Number(b));
  if (!Number.isFinite(diff)) return Infinity;
  return Math.min(diff, 24 * 60 - diff);
}

function isNearScheduleMinute(minutes, scheduleMinutes, tolerance = Q6_TOLERANCE_MINUTES) {
  return scheduleMinutes.some(target => clockDistanceMinutes(minutes, target) <= tolerance);
}

function markContinuousInfusionRows(rows) {
  const byPatientDate = new Map();
  for (const row of rows || []) {
    if (row?.route !== 'TTM') continue;
    const key = `${patientKey(row)}|${row.date || ''}`;
    const minutes = rowMinutes(row);
    if (!patientKey(row) || !Number.isFinite(minutes) || minutes >= 9999) continue;
    if (!byPatientDate.has(key)) byPatientDate.set(key, []);
    byPatientDate.get(key).push(row);
  }

  for (const patientRows of byPatientDate.values()) {
    const sorted = [...patientRows].sort((a, b) => rowMinutes(a) - rowMinutes(b));
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      const gap = Math.abs(rowMinutes(cur) - rowMinutes(prev));
      if (gap <= CONTINUOUS_INFUSION_GAP_MINUTES) {
        prev.isContinuousInfusion = true;
        cur.isContinuousInfusion = true;
        prev.continuousInfusionReason = 'TTM nối tiếp trong cùng người bệnh, không tính là giờ riêng.';
        cur.continuousInfusionReason = 'TTM nối tiếp trong cùng người bệnh, không tính là giờ riêng.';
      }
    }
  }
}

function markQ6ScheduleRows(rows) {
  const byPatient = new Map();
  for (const row of rows || []) {
    const key = patientKey(row);
    const minutes = rowMinutes(row);
    if (!key || !Number.isFinite(minutes) || minutes >= 9999) continue;
    if (!byPatient.has(key)) byPatient.set(key, []);
    byPatient.get(key).push(row);
  }

  for (const patientRows of byPatient.values()) {
    const minutesList = patientRows
      .map(row => rowMinutes(row))
      .filter(minutes => Number.isFinite(minutes) && minutes < 9999);

    const matchedSlots = Q6_SCHEDULE_MINUTES.filter(target =>
      minutesList.some(minutes => clockDistanceMinutes(minutes, target) <= Q6_TOLERANCE_MINUTES)
    );

    if (matchedSlots.length < Q6_MIN_MATCHES) continue;

    for (const row of patientRows) {
      const minutes = rowMinutes(row);
      if (!Number.isFinite(minutes) || minutes >= 9999) continue;
      if (!isNearScheduleMinute(minutes, Q6_SCHEDULE_MINUTES)) continue;

      // Nếu giờ này là giờ chung của nhiều người bệnh, hoặc đang là một chuỗi TTM nối tiếp,
      // không đánh dấu riêng để tránh báo động giả.
      if (row.isCommonMedicationTime || row.isContinuousInfusion) continue;

      row.isSeparatedHour = true;
      row.isQ6Schedule = true;
      row.separatedHourReason = 'Cữ 6 giờ/lần 00:00 - 06:00 - 12:00 - 18:00, nên để riêng để tránh sót.';
    }
  }
}

function markSeparatedHours(rows) {
  for (const row of rows || []) {
    row.isSeparatedHour = false;
    row.isQ6Schedule = false;
    row.isCommonMedicationTime = false;
    row.isContinuousInfusion = false;
    row.separatedHourReason = '';
    row.continuousInfusionReason = '';
  }

  markContinuousInfusionRows(rows);

  const byDate = new Map();

  for (const row of rows || []) {
    const minutes = rowMinutes(row);
    if (!Number.isFinite(minutes) || minutes >= 9999) continue;
    const dateKey = row.date || '';
    if (!byDate.has(dateKey)) byDate.set(dateKey, new Map());
    const slots = byDate.get(dateKey);
    if (!slots.has(row.time)) {
      slots.set(row.time, { time: row.time, minutes, rows: [], patients: new Set() });
    }
    const slot = slots.get(row.time);
    slot.rows.push(row);
    const pk = patientKey(row);
    if (pk) slot.patients.add(pk);
  }

  for (const slots of byDate.values()) {
    const slotList = [...slots.values()].sort((a, b) => a.minutes - b.minutes);
    if (!slotList.length) continue;

    // Một giờ được xem là giờ thuốc chung khi có từ 2 người bệnh trở lên cùng dùng.
    // Ví dụ 20:00 có nhiều bệnh nhân thì soạn chung, không được gắn “giờ riêng”.
    const commonSlots = slotList.filter(slot => slot.patients.size >= COMMON_SLOT_MIN_PATIENTS);
    const commonTimes = new Set(commonSlots.map(x => x.time));

    for (const slot of slotList) {
      const isCommon = commonTimes.has(slot.time);
      const nearest = commonSlots.length
        ? commonSlots.reduce((best, common) => {
            const d = Math.abs(slot.minutes - common.minutes);
            return d < best ? d : best;
          }, Infinity)
        : Infinity;

      const earlyIsolated = !isCommon
        && slot.patients.size === 1
        && slot.minutes >= 0
        && slot.minutes < EARLY_ISOLATED_END_MINUTES;

      const separatedByGap = !isCommon && nearest > SEPARATED_HOUR_GAP_MINUTES;

      for (const row of slot.rows) {
        row.isCommonMedicationTime = isCommon;
        if (isCommon || row.isContinuousInfusion) {
          row.isSeparatedHour = false;
          row.separatedHourReason = row.isContinuousInfusion ? row.continuousInfusionReason : '';
          continue;
        }

        if (earlyIsolated) {
          row.isSeparatedHour = true;
          row.separatedHourReason = 'Cữ sáng sớm/rạng sáng chỉ có 1 người bệnh, cần để riêng để tránh sót.';
          continue;
        }

        if (separatedByGap) {
          row.isSeparatedHour = true;
          row.separatedHourReason = commonSlots.length
            ? `Cữ này cách giờ thuốc chung gần nhất trên 2 giờ, khoảng ${formatDuration(nearest)}.`
            : 'Cữ này không đi cùng giờ thuốc chung nào trong ngày.';
        }
      }
    }
  }

  // Mẫu thuốc 6 giờ/lần thường gặp 06:00 - 12:00 - 18:00 - 00:00 phải được tô riêng,
  // nhưng không tô nếu đó là giờ chung của nhiều bệnh nhân hoặc là TTM nối tiếp.
  markQ6ScheduleRows(rows);

  return rows;
}

function isSeparatedHour(row) {
  return Boolean(row?.isSeparatedHour);
}

function isOddHour(row) {
  // Giữ tên hàm cũ để tránh phải đổi toàn bộ component, nhưng ý nghĩa mới là “giờ riêng/cách xa giờ chung”.
  return isSeparatedHour(row);
}

function uniquePatientCount(rows) {
  return new Set((rows || []).map(x => x.patientId || x.patientName).filter(Boolean)).size;
}

function dutyWindowLabel(row, selectedDate) {
  const m = rowMinutes(row);
  if (row.date && row.date !== selectedDate) {
    if (m >= DUTY_WINDOW.workStart && m < DUTY_WINDOW.morningEnd) return `Sáng hôm sau ${row.date}`;
    if (m < DUTY_WINDOW.workStart) return `Rạng sáng ${row.date}`;
    return String(row.date || 'Ngày khác');
  }
  if (m >= DUTY_WINDOW.workStart && m < DUTY_WINDOW.morningEnd) return 'Sáng';
  if (m >= DUTY_WINDOW.morningEnd && m < DUTY_WINDOW.workEnd) return 'Chiều hành chánh';
  if (m >= DUTY_WINDOW.workEnd && m < 24 * 60) return 'Chiều/tối trực';
  if (m < DUTY_WINDOW.workStart) return 'Rạng sáng';
  return 'Ngoài khung';
}

export {
  groupOf, isOral, rowMinutes, isWorkHourRow, isMorningRow, isAfterWorkOrEarlyNext,
  patientKey, formatDuration, clockDistanceMinutes, isNearScheduleMinute,
  markContinuousInfusionRows, markQ6ScheduleRows, markSeparatedHours,
  isSeparatedHour, isOddHour, uniquePatientCount, dutyWindowLabel,
};
