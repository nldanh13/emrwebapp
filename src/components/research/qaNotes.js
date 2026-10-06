// "Ghi chú khi chuẩn hóa": máy đã tự xử lý, người dùng chỉ cần biết. Gom các cảnh báo kỹ thuật
// (tên bảng tiếng Anh, is_within_encounter = 0, tên file) thành vài dòng tiếng Việt, mỗi dòng một
// loại, liệt kê theo phần dữ liệu (UX_RULES mục 6: không hiện chữ kỹ thuật trần).

const TABLE_LABELS = {
  lab_results: 'Xét nghiệm',
  imaging_results: 'CĐHA',
  surgery_results: 'Phẫu thuật',
  medication_orders: 'Y lệnh thuốc',
  clinical_notes: 'Diễn biến lâm sàng',
  encounters: 'Lượt điều trị',
};

const fmt = n => Number(n || 0).toLocaleString('vi-VN');
const tableLabel = t => TABLE_LABELS[t] || t;

// Bảng cũ không có trường table: lấy từ đầu câu "lab_results: …".
function tableOf(w) {
  if (w?.table) return String(w.table);
  const m = String(w?.message || '').match(/^([a-z_]+):/);
  return m ? m[1] : '';
}

function countOf(w) {
  if (Number.isFinite(Number(w?.count)) && Number(w.count) > 0) return Number(w.count);
  const m = String(w?.message || '').match(/(\d[\d.,]*)/);
  return m ? Number(m[1].replace(/[.,]/g, '')) : 0;
}

const PER_TABLE = [
  ['child_match_ambiguous', 'Kết quả khớp nhiều lượt nên chưa gắn vào lượt nào'],
  ['child_match_missing', 'Kết quả không khớp lượt nào'],
  ['child_outside_encounter', 'Kết quả đã gắn lượt nhưng ngoài thời gian nằm viện'],
  ['duplicate_raw_rows_removed', 'Bỏ dòng trùng y hệt (giữ một)'],
  ['conflicting_results', 'Nhóm cùng người bệnh, cùng thời điểm, cùng chỉ số nhưng kết quả khác nhau'],
];

const PER_ENCOUNTER = {
  missing_admission_date: n => `${fmt(n)} lượt thiếu ngày vào viện.`,
  discharge_before_admission: n => `${fmt(n)} lượt có ngày ra viện trước ngày vào viện.`,
  future_date: n => `${fmt(n)} lượt có ngày ở tương lai.`,
  stay_over_365_days: n => `${fmt(n)} lượt nằm viện trên 365 ngày.`,
  missing_discharge_date: n => `${fmt(n)} lượt chưa có ngày ra viện: tạm tính thời gian nằm viện tới hôm nay khi ghép kết quả.`,
  possible_same_stay: n => `${fmt(n)} cặp lượt của cùng người bệnh có thể là một đợt nằm viện (chuyển khoa): xem ở "Cần người kiểm tra".`,
};

export function describeQaWarnings(warnings = []) {
  const list = Array.isArray(warnings) ? warnings : [];
  const lines = [];
  for (const [code, label] of PER_TABLE) {
    const items = list.filter(w => w?.code === code && countOf(w) > 0);
    if (!items.length) continue;
    const parts = items
      .map(w => ({ name: tableLabel(tableOf(w)), n: countOf(w) }))
      .sort((a, b) => b.n - a.n)
      .map(x => `${x.name} ${fmt(x.n)}`);
    lines.push(`${label}: ${parts.join(', ')}.`);
  }
  for (const w of list) {
    const f = PER_ENCOUNTER[w?.code];
    if (f && countOf(w) > 0) lines.push(f(countOf(w)));
  }
  const known = new Set([...PER_TABLE.map(([c]) => c), ...Object.keys(PER_ENCOUNTER)]);
  for (const w of list) {
    if (!known.has(w?.code) && w?.message) lines.push(String(w.message));
  }
  return lines;
}
