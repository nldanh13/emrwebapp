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

const pad2 = n => String(n).padStart(2, '0');

function parseDmyHm(text) {
  const m = String(text || '').trim().match(/^(\d{1,2}):(\d{2})\s+(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [, hh, mi, dd, mm, yyyy] = m.map(Number);
  if (hh > 23 || mi > 59) return null;
  const d = new Date(yyyy, mm - 1, dd, hh, mi);
  if (d.getFullYear() !== yyyy || d.getMonth() !== mm - 1 || d.getDate() !== dd) return null;
  return d;
}

function formatHmDmy(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())} ${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

// Giờ bắt đầu do điều dưỡng bổ sung khi y lệnh không ghi giờ dùng.
// Chỉ nhận "HH:MM dd/mm/yyyy" thuộc ngày làm việc hoặc ngày kế tiếp (ca đêm).
function parseManualStart(value, workDate) {
  const start = parseDmyHm(value);
  if (!start) throw new Error('Giờ bắt đầu phải có dạng giờ:phút và ngày, ví dụ 08:00 09/11/2026.');
  const day = parseDmyHm(`00:00 ${String(workDate || '').trim()}`);
  if (!day) throw new Error('Ngày làm việc không hợp lệ.');
  const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 2);
  if (start < day || start >= next) {
    throw new Error(`Giờ bắt đầu phải thuộc ngày ${workDate} hoặc ngày hôm sau.`);
  }
  return formatHmDmy(start);
}

// Cùng công thức với worker (infusion_scheduler._duration_minutes): 20 giọt = 1 ml.
function infusionDurationMinutes(volume, rate) {
  const v = Number(volume);
  const r = Number(rate);
  if (!(v > 0) || !(r > 0)) return 0;
  return Math.floor((v * 20) / r);
}

// Tính lịch cho một dòng khi có giờ bắt đầu nhập tay (giờ kết thúc = bắt đầu + thời lượng).
function scheduleFromManualStart(item, startText) {
  const start = parseDmyHm(startText);
  if (!start) return { error: 'Giờ bắt đầu không hợp lệ.' };
  if (item?.toc_do_inferred) {
    return { error: 'Tốc độ truyền đang là giá trị phần mềm tự đoán; nhập tốc độ theo y lệnh trước khi bổ sung giờ.' };
  }
  const rate = Number(String(item?.toc_do ?? '').replace(',', '.'));
  const minutes = infusionDurationMinutes(item?.the_tich, rate);
  if (!minutes) return { error: 'Cần thể tích và tốc độ truyền hợp lệ để tính giờ kết thúc.' };
  const end = new Date(start.getTime() + minutes * 60000);
  return { tg_bat_dau: formatHmDmy(start), tg_ket_thuc: formatHmDmy(end), thoi_gian_chay_phut: minutes };
}

function overlappingInfusion(siblings, target, startText, endText) {
  const s = parseDmyHm(startText);
  const e = parseDmyHm(endText);
  for (const other of siblings) {
    if (other === target) continue;
    const os = parseDmyHm(other?.tg_bat_dau);
    const oe = parseDmyHm(other?.tg_ket_thuc);
    if (!os || !oe) continue;
    if (s < oe && os < e) return other;
  }
  return null;
}

function matchAndUpdateInfusions(rows, patientId, workDate, match, updates, rowPatientId, rowWorkDate) {
  const key = infusionItemKey(match);
  const targets = [];
  const siblings = [];
  for (const row of (Array.isArray(rows) ? rows : [])) {
    if (rowPatientId(row) !== patientId || rowWorkDate(row) !== workDate) continue;
    for (const item of (Array.isArray(row?.thuoc?.dich_truyen) ? row.thuoc.dich_truyen : [])) {
      siblings.push(item);
      if (infusionItemKey(item) === key) targets.push(item);
    }
  }
  if (targets.length !== 1) return { matched: targets.length, updated: false };
  const target = targets[0];
  const { tg_bat_dau: manualStart, ...valueUpdates } = updates || {};

  if (manualStart) {
    // Kiểm tra trên bản nháp; chỉ ghi khi toàn bộ hợp lệ.
    const draft = { ...target, ...valueUpdates };
    if (Object.hasOwn(valueUpdates, 'toc_do')) {
      draft.toc_do_inferred = false;
    } else if (draft.missing_infusion_rate) {
      return { matched: 1, updated: false,
        error: 'Y lệnh chưa có tốc độ truyền được xác nhận; nhập tốc độ theo y lệnh cùng lúc với giờ bắt đầu.' };
    }
    const plan = scheduleFromManualStart(draft, manualStart);
    if (plan.error) return { matched: 1, updated: false, error: plan.error };
    const clash = overlappingInfusion(siblings, target, plan.tg_bat_dau, plan.tg_ket_thuc);
    if (clash) {
      return { matched: 1, updated: false, error:
        `Trùng giờ với ${clash.ten_hien_thi || clash.ten_thuoc || 'dịch truyền khác'} `
        + `(${clash.tg_bat_dau} → ${clash.tg_ket_thuc}). Chọn giờ bắt đầu khác.` };
    }
    Object.assign(target, valueUpdates, plan);
    if (Object.hasOwn(valueUpdates, 'toc_do')) {
      target.toc_do_inferred = false;
      delete target.missing_infusion_rate;
    }
    if (!String(target.gio_dung || '').trim()) {
      target.gio_dung = `${Number(plan.tg_bat_dau.slice(0, 2))} giờ`;
    }
    delete target.missing_infusion_time;
    target.tg_bat_dau_nhap_tay = true;
    // Giờ kết thúc vừa tính từ chính thể tích/tốc độ đã xác nhận: lịch dòng này hợp lệ.
    target.infusion_schedule_stale = false;
    return { matched: 1, updated: true, schedule: plan };
  }

  Object.assign(target, valueUpdates);
  // Values manually corrected can no longer be treated as unchanged inferred defaults.
  if (Object.hasOwn(valueUpdates, 'toc_do')) target.toc_do_inferred = false;
  if (Object.keys(valueUpdates).length) {
    // A changed volume/rate invalidates a computed end time and possibly
    // overlapping/queued infusions. Do not keep an old end time as "verified".
    target.infusion_schedule_stale = true;
  }
  return { matched: 1, updated: true };
}

module.exports = {
  infusionItemKey, parsePositiveInfusionValue, matchAndUpdateInfusions,
  parseManualStart, scheduleFromManualStart, infusionDurationMinutes,
};
