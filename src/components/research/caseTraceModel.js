// Đường đi lấy dữ liệu của các ca gần nhất (Kho nghiên cứu): mỗi ca vào màn hình EMR nào, thấy gì, lấy gì.
// Dữ liệu là "vết ca" worker ghi (server/research/case_trace.js, đã che định danh ở máy chủ).
// Hàm thuần: chỉ đổi gói vết thành dòng hiển thị, không gọi máy chủ (docs/UX_RULES.md mục 9.2).

const MODE_LABELS = {
  xn_cdha: 'Xét nghiệm / CĐHA',
  hchanh_auto: 'Hồ sơ nền / Ra viện / Phẫu thuật / Chi phí',
  order_history_auto: 'Y lệnh',
};

const STATUS_LABELS = {
  done: ['Lấy xong', 'ok'],
  ok: ['Lấy xong', 'ok'],
  partial: ['Lấy được một phần', 'warn'],
  empty: ['EMR không có dữ liệu', 'warn'],
  skipped_recent_failure: ['Bỏ qua vì vừa lỗi', 'warn'],
  error: ['Lỗi', 'error'],
  fatal: ['Lỗi', 'error'],
  incomplete: ['Chưa xong', 'error'],
  pending_refetch: ['Chưa tới lượt, lần sau lấy tiếp', 'warn'],
};

// Thẻ lỗi của worker → câu tiếng Việt nói thẳng chuyện gì xảy ra.
const ERROR_HINTS = {
  'ERROR.NO_URL': 'Không tìm thấy đường vào màn hình này',
  'ERROR.NO_URL_PROFILE': 'Không tìm thấy đường vào Thông tin nền',
  'ERROR.NO_URL_DISCHARGE': 'Không tìm thấy đường vào phiếu Ra viện',
  'ERROR.NO_URL_ORDER_HISTORY': 'Không tìm thấy đường vào Lịch sử y lệnh',
  'ERROR.NO_URL_SURGERY': 'Không tìm thấy đường vào Phẫu thuật',
  'ERROR.NO_PATIENT_LINK': 'Không tìm thấy người bệnh trong danh sách EMR',
  'ERROR.NO_NURSING_EYE_LINK': 'Không thấy nút mắt điều dưỡng',
  'ERROR.NO_DOCTOR_LINK': 'Không thấy đường vào màn hình bác sĩ',
  'ERROR.NO_SESSION': 'Chưa đăng nhập được EMR',
  'ERROR.SESSION_EXPIRED': 'Phiên EMR đã hết hạn',
  'ERROR.EMPTY_HTML': 'Màn hình EMR trả về trang trống',
  'ERROR.SELECTOR_NOT_FOUND': 'Màn hình EMR khác với lúc viết chương trình (không thấy ô cần đọc)',
  'FETCH.NO_URL': 'Không tìm thấy đường vào màn hình này',
};

const txt = v => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());

// Vết cũ ghi cả tên file code / trường dữ liệu vào ô màn hình (vd "server/routes/research.js",
// "output.order_history.rows"): đó không phải màn hình EMR, không hiện dưới nhãn "Màn hình EMR".
function emrScreen(value) {
  const s = txt(value);
  if (!s) return '';
  if (/^(server|worker|src|research)\//.test(s) || /\.(js|py|json|csv|txt)\b/i.test(s) || /^output\./.test(s)) return '';
  return s;
}

function stepTone(tag) {
  const t = txt(tag).toUpperCase();
  if (t.startsWith('ERROR') || t === 'FETCH.NO_URL') return 'error';
  if (t === 'WARN' || t.includes('FALLBACK') || t.endsWith('_EMPTY') || t.endsWith('_NOT_FOUND')) return 'warn';
  return 'ok';
}

/**
 * @param {Array<object>} cases  mảng vết ca (mới nhất trước) từ GET …/case-trace
 * @returns {Array<object>} mỗi ca: { id, title, when, mode, status, tone, files, counts, errors, steps }
 */
export function buildCaseTraceView(cases = []) {
  return (Array.isArray(cases) ? cases : []).filter(Boolean).map((c, i) => {
    const events = Array.isArray(c.events) ? c.events : [];
    const steps = events
      // Bước chỉ đánh dấu bắt đầu/kết thúc mà không vào màn hình nào thì bỏ cho gọn.
      .filter(ev => emrScreen(ev.screen) || txt(ev.sees) || txt(ev.takes) || stepTone(ev.tag) !== 'ok')
      .map(ev => {
        const tone = stepTone(ev.tag);
        const tag = txt(ev.tag).toUpperCase();
        return {
          tag,
          tone,
          step: txt(ev.step),
          hint: tone === 'error' ? (ERROR_HINTS[tag] || '') : '',
          screen: emrScreen(ev.screen),
          sees: txt(ev.sees),
          takes: txt(ev.takes),
          writes: txt(ev.writes),
        };
      });
    const [statusLabel, statusTone] = STATUS_LABELS[txt(c.status).toLowerCase()] || [txt(c.status) || 'Không rõ', 'warn'];
    const errors = steps.filter(s => s.tone === 'error').length;
    const tone = statusTone === 'error' || errors ? 'error' : statusTone;
    const code = txt(c.research_code);
    const bn = txt(c.ma_bn);
    return {
      id: txt(c.case_id) || `${i}`,
      title: [code && `Mã NC ${code}`, bn && `Mã BN ${bn}`].filter(Boolean).join(' · ') || `Ca ${i + 1}`,
      when: txt(c.ts),
      stay: [txt(c.date_from), txt(c.date_to)].filter(Boolean).join(' → '),
      mode: MODE_LABELS[txt(c.mode)] || txt(c.mode),
      status: statusLabel,
      tone,
      files: Array.isArray(c.files) ? c.files.map(txt).filter(Boolean) : [],
      counts: c.counts && typeof c.counts === 'object' ? c.counts : {},
      errors,
      steps,
    };
  });
}
