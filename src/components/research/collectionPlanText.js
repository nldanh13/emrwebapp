// Kế hoạch Thu thập tự động: một mẫu số (số lượt trong danh sách thu thập), các nhóm cộng lại
// đúng bằng tổng, và nhóm nào không tự lấy được thì có nghĩa + việc cần làm (UX_RULES 5.3).

const n = (v) => Number(v || 0) || 0;

export function buildPlanView(plan, { running = false, maxAttempts = 3, busy = false } = {}) {
  if (!plan) return null;
  const total = n(plan.encounters);
  const groups = [
    { key: 'fetch', label: 'lấy', value: n(plan.to_fetch), extra: n(plan.parts_to_fetch) ? `${n(plan.parts_to_fetch).toLocaleString('vi-VN')} phần` : '' },
    { key: 'unchanged', label: 'đã đủ, không đổi', value: n(plan.unchanged) },
    { key: 'waiting', label: 'chờ người xem', value: n(plan.waiting_encounters) },
    { key: 'unmatched', label: 'chưa ghép chắc', value: n(plan.unmatched_encounters) },
  ];
  const notes = [];
  if (n(plan.waiting_encounters)) {
    notes.push({
      key: 'waiting',
      label: 'chờ người xem',
      value: n(plan.waiting_encounters),
      meaning: `Lượt chỉ còn phần đã tự thử ${maxAttempts} lần vẫn lỗi, hoặc phần mà giao diện EMR khác mẫu; máy không tự thử nữa.`,
      action: 'Mở "Danh sách cần xử lý" xem lý do từng phần. Muốn thử lại thì bấm "Làm mới…" và chọn phần đó.',
    });
  }
  if (n(plan.unmatched_encounters)) {
    notes.push({
      key: 'unmatched',
      label: 'chưa ghép chắc',
      value: n(plan.unmatched_encounters),
      meaning: 'Dòng danh sách không chắc ứng với lượt điều trị nào trên EMR (vd. cùng ngày có hai lượt), nên không tự lấy để tránh lấy nhầm dữ liệu.',
      action: busy
        ? 'Đợi lượt thu thập này xong, rồi bấm "Rà soát ghép lượt" để chọn đúng lượt.'
        : 'Bấm "Rà soát ghép lượt" để chọn đúng lượt; chọn xong lần thu thập sau sẽ tự lấy.',
    });
  }
  return {
    title: running ? 'Lần này' : 'Lần chạy tới',
    total,
    groups,
    sum: groups.reduce((s, g) => s + g.value, 0),
    notes,
  };
}
