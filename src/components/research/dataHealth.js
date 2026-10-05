// Đánh giá dữ liệu Kho nghiên cứu theo đúng hai tiêu chí của người thu thập dữ liệu:
//   1. ĐỦ       — mỗi lượt điều trị đã lấy đủ các phần chưa;
//   2. CHÍNH XÁC — dữ liệu đã lấy có sai lệch không (trùng, ngày tháng vô lý, kết quả mâu thuẫn...).
// Mỗi con số trả về kèm: nó là gì (meaning) và phải làm gì (action). Con số nào không dẫn tới
// việc gì thì không hiện ở phần chính (để trong "Chi tiết kỹ thuật").
// Mẫu số duy nhất: tổng số lượt điều trị đang theo dõi (snapshot.total).

const num = (v) => Number(v || 0) || 0;
const fmt = (v) => num(v).toLocaleString('vi-VN');

export const QA_ISSUE_LABELS = {
  possible_same_stay: 'Có thể cùng một đợt nằm viện (chuyển khoa)',
  discharge_before_admission: 'Ngày ra viện trước ngày vào viện',
  future_date: 'Ngày vào/ra viện ở tương lai',
  stay_over_365_days: 'Nằm viện trên 365 ngày',
  missing_admission_date: 'Thiếu ngày vào viện',
  conflicting_lab_result: 'Cùng xét nghiệm, cùng thời điểm nhưng kết quả khác nhau',
  conflicting_imaging_result: 'Cùng CĐHA, cùng thời điểm nhưng kết quả khác nhau',
  needs_manual_review: 'Cần xem lại khi chuẩn hóa',
};

export const issueLabel = (code) => QA_ISSUE_LABELS[code] || code || 'Khác';

export function buildDataHealth(snapshot) {
  const snap = snapshot || {};
  const counts = snap.counts || {};
  const total = num(snap.total);
  const done = num(counts.done ?? snap.ready);
  const running = num(counts.running);
  const errors = num(counts.error);
  const missing = num(counts.missing) + num(counts.waiting);
  const autoRunning = Boolean(snap.active_task || snap.scope_running);
  const pct = total ? Math.round((done * 100) / total) : 0;
  const partLabels = (snap.modules || []).map(m => m.label).filter(Boolean);
  const gaps = (snap.modules || [])
    .map(m => ({ label: m.label, count: Math.max(0, num(m.total) - num(m.done)) }))
    .filter(g => g.count > 0)
    .sort((a, b) => b.count - a.count);

  const complete = [];
  complete.push({
    key: 'done', label: 'Đủ dữ liệu', value: done, tone: 'ok',
    meaning: `Lượt đã có đủ ${partLabels.length || 5} phần${partLabels.length ? ` (${partLabels.join(', ')})` : ''}, dùng được ngay.`,
    action: '',
  });
  if (missing > 0) {
    complete.push({
      key: 'missing', label: 'Còn thiếu', value: missing, tone: 'warn', filter: 'missing',
      meaning: gaps.length
        ? `Chưa lấy đủ. Thiếu nhiều nhất: ${gaps.slice(0, 3).map(g => `${g.label} (${fmt(g.count)})`).join(', ')}.`
        : 'Chưa lấy đủ các phần.',
      action: autoRunning
        ? 'Đang thu thập tự động — không cần làm gì, chờ chạy xong.'
        : 'Bấm "Thu thập tự động" ở bước 2: chỉ lấy phần còn thiếu, không lấy lại phần đã có.',
    });
  }
  if (running > 0) {
    complete.push({
      key: 'running', label: 'Đang lấy', value: running, tone: 'info', filter: 'running',
      meaning: 'Máy đang lấy dữ liệu các lượt này.',
      action: 'Không cần làm gì.',
    });
  }
  if (errors > 0) {
    complete.push({
      key: 'error', label: 'Lấy bị lỗi', value: errors, tone: 'danger', filter: 'error',
      meaning: 'Đã tự thử lại mà EMR vẫn không trả dữ liệu (lý do ghi ở từng lượt).',
      action: autoRunning
        ? 'Chờ lần thu thập này xong rồi xem lại danh sách lỗi.'
        : 'Bấm "Thu thập tự động" để thử lại; lượt nào vẫn lỗi thì mở EMR kiểm tra theo lý do ghi trong danh sách.',
    });
  }

  const qa = snap.qa || null;
  const accurate = [];
  let accuracyChecked = false;
  if (!qa) {
    accurate.push({
      key: 'unchecked', label: 'Chưa kiểm tra', value: null, tone: 'warn',
      meaning: 'Chưa chuẩn hóa nên chưa kiểm tra trùng lặp, ngày tháng vô lý, kết quả mâu thuẫn.',
      action: 'Bấm "Chuẩn hóa ngay" ở đầu trang.',
    });
  } else {
    accuracyChecked = true;
    const blocking = Array.isArray(qa.blocking) ? qa.blocking : [];
    if (blocking.length) {
      accurate.push({
        key: 'blocking', label: 'Lỗi phải sửa trước khi dùng', value: blocking.length, tone: 'danger',
        meaning: blocking.slice(0, 3).map(b => b.message).filter(Boolean).join(' '),
        action: 'Bấm "Chuẩn hóa lại". Nếu vẫn còn, báo người quản trị: đây là lỗi cấu trúc dữ liệu, không sửa tay được.',
      });
    }
    const reviewCount = num(qa.review_count);
    if (reviewCount > 0) {
      const top = Object.entries(qa.review_by_issue || {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
      accurate.push({
        key: 'review', label: 'Cần người kiểm tra', value: reviewCount, tone: 'warn', filter: 'review',
        meaning: top.length ? top.map(([code, n]) => `${issueLabel(code)}: ${fmt(n)}`).join('; ') + '.' : 'Dữ liệu có điểm bất thường.',
        action: 'Mở danh sách, đối chiếu với EMR. Đúng thì giữ; sai thì sửa ở phiếu nhập tay hoặc loại lượt đó khỏi nghiên cứu.',
      });
    }
    if (!blocking.length && !reviewCount) {
      accurate.push({
        key: 'clean', label: 'Không phát hiện sai lệch', value: null, tone: 'ok',
        meaning: 'Đã kiểm tra trùng lặp, ngày tháng, kết quả mâu thuẫn: không có vấn đề.',
        action: '',
      });
    }
    if (qa.stale) {
      accurate.push({
        key: 'stale', label: 'Có dữ liệu mới chưa kiểm tra', value: null, tone: 'warn',
        meaning: 'Đã lấy thêm dữ liệu sau lần kiểm tra gần nhất.',
        action: 'Bấm "Chuẩn hóa ngay" ở đầu trang để kiểm tra cả phần mới.',
      });
    }
  }

  // Một câu kết luận cho cả kho.
  const needsYou = errors > 0 || accurate.some(i => ['blocking', 'review'].includes(i.key));
  let verdict;
  if (!total) verdict = { tone: 'info', text: 'Chưa có lượt nào. Quét danh sách người bệnh ở bước 1.' };
  else if (needsYou) verdict = { tone: 'warn', text: `Đủ ${pct}%. Có việc cần bạn xử lý bên dưới.` };
  else if (missing || running) verdict = { tone: 'info', text: autoRunning ? `Đủ ${pct}%. Đang tự lấy phần còn thiếu.` : `Đủ ${pct}%. Còn thiếu dữ liệu: chạy Thu thập tự động.` };
  else if (!accuracyChecked || qa?.stale) verdict = { tone: 'info', text: 'Đã lấy đủ. Còn bước kiểm tra độ chính xác (Chuẩn hóa).' };
  else verdict = { tone: 'ok', text: 'Đủ và đã kiểm tra: sẵn sàng phân tích.' };

  return { total, done, pct, autoRunning, complete, accurate, accuracyChecked, verdict, gaps };
}
