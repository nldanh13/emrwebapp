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

// screen: mô hình màn hình từ máy chủ (/screen/collection) — total, counts (done/missing/error/
// waiting/unmatched, chia rời nhau, cộng lại = total), parts, qa, plan. autoRunning: đang thu thập.
export function buildDataHealth(screen, { autoRunning = false } = {}) {
  const snap = screen || {};
  const counts = snap.counts || {};
  const total = num(snap.total);
  const done = num(counts.done);
  const missing = num(counts.missing);
  const errors = num(counts.error);
  const waiting = num(counts.waiting);
  const unmatched = num(counts.unmatched);
  const maxAttempts = num(snap.plan?.max_attempts) || 3;
  const pct = total ? Math.round((done * 100) / total) : 0;
  const partLabels = (snap.parts || []).map(m => m.label).filter(Boolean);
  const gaps = (snap.parts || [])
    .map(m => ({ label: m.label, count: Math.max(0, num(m.total) - num(m.done)) }))
    .filter(g => g.count > 0)
    .sort((a, b) => b.count - a.count);

  // Màn chính chỉ có ba trạng thái hành động, tất cả lấy từ cùng collection ledger.
  // Các trạng thái kỹ thuật missing/error/waiting/unmatched vẫn nằm trong screen.counts
  // và danh sách chi tiết, nhưng không đứng thành các "trạng thái" riêng trên màn chính.
  const userCounts = snap.user_counts || {};
  const ready = userCounts.ready != null ? num(userCounts.ready) : done;
  const automatic = userCounts.automatic != null ? num(userCounts.automatic) : missing + errors;
  const manual = userCounts.manual != null ? num(userCounts.manual) : waiting + unmatched;

  const complete = [{
    key: 'ready', label: 'Sẵn sàng', value: ready, tone: 'ok',
    meaning: `Lượt đã có đủ ${partLabels.length || 6} phần hiện hành${partLabels.length ? ` (${partLabels.join(', ')})` : ''}, có thể dùng tiếp.`,
    action: '',
  }];

  if (automatic > 0) {
    complete.push({
      key: 'automatic',
      label: autoRunning ? 'Máy đang xử lý' : 'Chờ máy xử lý',
      value: automatic,
      tone: 'info',
      filter: 'automatic',
      meaning: gaps.length
        ? `Gồm phần chưa lấy, dữ liệu cần cập nhật parser/cửa sổ mới hoặc lỗi kỹ thuật còn tự thử được. Các phần chưa hiện hành nhiều nhất: ${gaps.slice(0, 3).map(g => `${g.label} (${fmt(g.count)})`).join(', ')}.`
        : 'Gồm phần chưa lấy, dữ liệu cần cập nhật hoặc lỗi kỹ thuật còn tự thử được.',
      action: autoRunning
        ? 'Máy đang xử lý — không cần làm gì, chờ lượt Thu thập kết thúc.'
        : 'Bấm "Thu thập tự động". Máy chỉ xử lý phần cần thiết, không lấy lại phần đã hiện hành.',
    });
  }

  if (manual > 0) {
    const details = [];
    if (waiting) details.push(`${fmt(waiting)} lượt máy đã dừng tự thử`);
    if (unmatched) details.push(`${fmt(unmatched)} lượt chưa ghép chắc`);
    complete.push({
      key: 'manual',
      label: 'Cần bạn kiểm tra',
      value: manual,
      tone: 'danger',
      filter: 'manual',
      meaning: details.length
        ? `${details.join('; ')}. Máy không tự quyết để tránh lấy/sửa nhầm dữ liệu.`
        : 'Có lượt cần quyết định của người dùng trước khi tiếp tục.',
      action: autoRunning
        ? 'Không cần dừng lượt đang chạy. Khi Thu thập xong, mở danh sách này để xử lý từng lượt.'
        : 'Mở danh sách này để xem lý do. Ca chưa ghép thì chọn đúng lượt; ca đã dừng tự thử thì kiểm tra EMR rồi cho chạy lại phần cần thiết.',
    });
  }

  const qa = snap.qa || null;
  const accurate = [];
  let accuracyChecked = false;
  const qaBlocking = Array.isArray(qa?.blocking) ? qa.blocking : [];
  const transientInputChange = qaBlocking.some(item => String(item?.code || '').toLowerCase() === 'input_changed_during_normalize');

  // Khi nguồn đang tiếp tục thay đổi, QA cũ không còn là "kết quả hiện tại".
  // Chỉ hiển thị một trạng thái chờ; không vừa hiện "668 cần xem" vừa báo Thu thập đang chạy.
  if (autoRunning || qa?.stale || transientInputChange) {
    accurate.push({
      key: 'quality_pending',
      label: autoRunning ? 'Sẽ kiểm tra sau khi Thu thập xong' : 'Có dữ liệu mới cần kiểm tra lại',
      value: null,
      tone: 'info',
      meaning: autoRunning
        ? 'Thu thập đang thay đổi dữ liệu nguồn. Kết quả kiểm tra cũ không được dùng để đánh giá lần hiện tại.'
        : 'Dữ liệu nguồn đã đổi sau lần kiểm tra gần nhất nên kết quả cũ không còn đại diện cho trạng thái hiện tại.',
      action: autoRunning
        ? 'Không cần làm gì. Thu thập xong máy sẽ tự Chuẩn hóa và kiểm tra lại.'
        : 'Chạy lại Chuẩn hóa từ dữ liệu đã có; không cần mở EMR.',
    });
  } else if (!qa) {
    accurate.push({
      key: 'unchecked', label: 'Chưa kiểm tra', value: null, tone: 'warn',
      meaning: 'Chưa chuẩn hóa nên chưa kiểm tra trùng lặp, ngày tháng vô lý, kết quả mâu thuẫn.',
      action: 'Bấm "Chuẩn hóa ngay" ở đầu trang.',
    });
  } else {
    accuracyChecked = true;
    if (qaBlocking.length) {
      accurate.push({
        key: 'blocking', label: 'Lỗi phải sửa trước khi dùng', value: qaBlocking.length, tone: 'danger',
        meaning: qaBlocking.slice(0, 3).map(b => b.message).filter(Boolean).join(' '),
        action: 'Bấm "Chuẩn hóa lại". Nếu vẫn còn, báo người quản trị: đây là lỗi cấu trúc dữ liệu, không sửa tay được.',
      });
    }
    const reviewCount = num(qa.review_count);
    if (reviewCount > 0) {
      const top = Object.entries(qa.review_by_issue || {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
      accurate.push({
        key: 'review', label: 'Cần người kiểm tra', value: reviewCount, tone: 'warn', filter: 'review',
        meaning: top.length ? top.map(([code, n]) => `${issueLabel(code)}: ${fmt(n)} lượt`).join('; ') + '.' : 'Dữ liệu có điểm bất thường.',
        action: 'Mở danh sách, đối chiếu với EMR. Đúng thì giữ; sai thì sửa ở phiếu nhập tay hoặc loại lượt đó khỏi nghiên cứu.',
      });
    }
    if (!qaBlocking.length && !reviewCount) {
      accurate.push({
        key: 'clean', label: 'Không phát hiện sai lệch', value: null, tone: 'ok',
        meaning: 'Đã kiểm tra trùng lặp, ngày tháng, kết quả mâu thuẫn: không có vấn đề.',
        action: '',
      });
    }
  }

  // Một câu kết luận cho cả kho, dùng đúng ba trạng thái trên.
  const needsYou = manual > 0 || accurate.some(i => ['blocking', 'review'].includes(i.key));
  let verdict;
  if (!total) verdict = { tone: 'info', text: 'Chưa có lượt nào. Quét danh sách người bệnh ở bước 1.' };
  else if (needsYou) verdict = { tone: 'warn', text: `Sẵn sàng ${fmt(ready)}/${fmt(total)} lượt · cần bạn kiểm tra ${fmt(manual)} lượt.` };
  else if (automatic > 0) verdict = {
    tone: 'info',
    text: autoRunning
      ? `Sẵn sàng ${fmt(ready)}/${fmt(total)} lượt · máy đang xử lý ${fmt(automatic)} lượt.`
      : `Sẵn sàng ${fmt(ready)}/${fmt(total)} lượt · ${fmt(automatic)} lượt chờ máy xử lý.`,
  };
  else if (!accuracyChecked) verdict = { tone: 'info', text: 'Đã lấy đủ dữ liệu hiện hành · đang chờ kiểm tra chất lượng.' };
  else verdict = { tone: 'ok', text: 'Dữ liệu hiện hành đã đủ và đã kiểm tra.' };

  return { total, done: ready, ready, automatic, manual, pct: total ? Math.round((ready * 100) / total) : 0, autoRunning, complete, accurate, accuracyChecked, verdict, gaps };
}
