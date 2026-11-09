'use strict';

// Giữ giờ bắt đầu dịch truyền do người dùng "Bổ sung giờ" khi y lệnh được xử lý lại
// (vd. bấm nhập → tiền kiểm thấy "YL mới" → post_process.py tạo lại dữ liệu đã xử lý).
// Chỉ khôi phục cho đúng dòng y lệnh cũ (cùng BN, ngày, thuốc, dòng đường dùng, số lượng)
// và chỉ khi dòng đó vẫn chưa có giờ; nếu bác sĩ đã ghi giờ thì dùng giờ của y lệnh.

const { matchAndUpdateInfusions, parseManualStart } = require('./infusion_edit_validation');

function rowPatientId(row) {
  return String(
    row?.ma_bn || row?.['Mã BN'] || row?.['Mã YT'] || row?.ma_yt || row?.MaBN || row?.Ma_BN || row?.mabn || row?.id || ''
  ).trim();
}

function rowWorkDate(row) {
  return String(row?.ngay_lam || row?.ngay_y_lenh || row?.ngay || row?.date || '').trim();
}

const norm = v => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

function orderKey(item = {}) {
  return [item.ten_thuoc, item.raw_usage_line || item.duong_dung_goc, item.so_luong].map(norm).join('|');
}

function eachInfusion(rows, fn) {
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const id = rowPatientId(row);
    const date = rowWorkDate(row);
    if (!id || !date) continue;
    for (const item of (Array.isArray(row?.thuoc?.dich_truyen) ? row.thuoc.dich_truyen : [])) fn(item, id, date);
  }
}

function collectManualStarts(rows) {
  const saved = new Map();
  eachInfusion(rows, (item, id, date) => {
    if (!item?.tg_bat_dau_nhap_tay) return;
    const key = `${id}::${date}::${orderKey(item)}`;
    if (!saved.has(key)) saved.set(key, { ma_bn: id, ngay_lam: date, ten_thuoc: item.ten_thuoc, starts: [], toc_do: item.toc_do });
    const entry = saved.get(key);
    const start = String(item.gio_bat_dau_chon || item.tg_bat_dau || '').trim();
    if (start && !entry.starts.includes(start)) entry.starts.push(start);
  });
  return saved;
}

function reapplyManualStarts(rows, saved) {
  const restored = [];
  const skipped = [];
  for (const [key, entry] of (saved instanceof Map ? saved : new Map())) {
    const candidates = [];
    eachInfusion(rows, (item, id, date) => {
      if (`${id}::${date}::${orderKey(item)}` === key) candidates.push(item);
    });
    const open = candidates.filter(it => !String(it?.tg_bat_dau || '').trim());
    if (!open.length) {
      // Không còn dòng này, hoặc y lệnh mới đã có giờ: không ghi đè.
      if (!candidates.length) skipped.push({ ...entry, reason: 'Y lệnh không còn dòng thuốc này' });
      continue;
    }
    if (open.length !== 1) {
      skipped.push({ ...entry, reason: 'Có nhiều dòng giống nhau, không khôi phục tự động' });
      continue;
    }
    let starts;
    try {
      starts = entry.starts.map(s => parseManualStart(s, entry.ngay_lam));
    } catch (e) {
      skipped.push({ ...entry, reason: e.message });
      continue;
    }
    const item = open[0];
    const updates = { tg_bat_dau: starts.length === 1 ? starts[0] : starts };
    if ((item.missing_infusion_rate || item.toc_do_inferred) && Number(entry.toc_do) > 0) {
      updates.toc_do = Number(entry.toc_do);
    }
    const result = matchAndUpdateInfusions(rows, entry.ma_bn, entry.ngay_lam, { ...item }, updates, rowPatientId, rowWorkDate);
    if (result.updated) restored.push({ ...entry, schedules: result.schedules });
    else skipped.push({ ...entry, reason: result.error || 'Không khớp đúng dòng dịch truyền' });
  }
  return { restored, skipped };
}

module.exports = { collectManualStarts, reapplyManualStarts };
