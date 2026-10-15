// Review signals for processed infusion rows: a calculated schedule is NOT
// evidence of the doctor's prescribed administration time or rate.
export function infusionReview(item = {}, workDate = '') {
  const scheduled = String(item.tg_bat_dau || '').trim();
  const orderTime = String(item.gio_dung || '').trim();
  const end = String(item.tg_ket_thuc || '').trim();
  const inferredRate = item.toc_do_inferred === true;
  const missingTime = item.missing_infusion_time === true || !scheduled;
  const stale = item.infusion_schedule_stale === true;
  const concerns = [];
  if (missingTime) concerns.push('Thiếu giờ bắt đầu đã xác nhận');
  if (inferredRate) concerns.push('Tốc độ có thể được phần mềm tự điền; chưa xác nhận');
  else if (item.missing_infusion_rate) concerns.push('Y lệnh chưa có tốc độ truyền được xác nhận');
  if (stale) concerns.push('Lịch sau khi sửa thể tích/tốc độ chưa được tính lại');
  if (item.can_xac_nhan_pha || item.can_xac_nhan_duong_dung)
    concerns.push('Cách pha/đường dùng cần xác nhận');
  const dm = scheduled.match(/\b(\d{2}\/\d{2}\/\d{4})\b/);
  const otherDay = !!(dm && workDate && dm[1] !== workDate);
  const source = item.nguon_pha || '';
  return {
    scheduled, end, orderTime, missingTime, inferredRate, stale, concerns,
    needsReview: concerns.length > 0,
    otherDay,
    scheduledDate: dm?.[1] || '',
    source,
  };
}

export function groupInfusionRows(items = [], workDate = '') {
  const scheduled = [];
  const unresolved = [];
  for (const item of items) {
    const review = infusionReview(item, workDate);
    (review.missingTime ? unresolved : scheduled).push({ item, review });
  }
  return { scheduled, unresolved };
}
