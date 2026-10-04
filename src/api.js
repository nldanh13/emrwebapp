import { getSessionId } from './hooks/useSession.js';
import { logActivity } from './utils/activityLogger.js';

const APP_TOKEN_KEY = 'emr_app_token_v1';

function getStoredAppToken() {
  // Ưu tiên sessionStorage để mã truy cập tự mất khi đóng tab/trình duyệt.
  // Tương thích ngược: nếu bản cũ đã lưu ở localStorage thì migrate một lần rồi xoá.
  try {
    const sessionToken = sessionStorage.getItem(APP_TOKEN_KEY) || '';
    if (sessionToken) return sessionToken;

    const legacyToken = localStorage.getItem(APP_TOKEN_KEY) || '';
    if (legacyToken) {
      sessionStorage.setItem(APP_TOKEN_KEY, legacyToken);
      localStorage.removeItem(APP_TOKEN_KEY);
      return legacyToken;
    }
  } catch {}
  return '';
}

function setStoredAppToken(token) {
  try {
    if (token) sessionStorage.setItem(APP_TOKEN_KEY, token);
    else sessionStorage.removeItem(APP_TOKEN_KEY);
    localStorage.removeItem(APP_TOKEN_KEY);
  } catch {}
}

// Khi mã truy cập bị 401 giữa phiên làm việc (vd admin thu hồi token) — xoá token cũ
// và báo cho AuthGate quay lại màn hình đăng nhập, thay vì window.prompt() thô.
function reportAuthRequired() {
  setStoredAppToken('');
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('emr:auth-required'));
  }
}

function headers(extra = {}) {
  const token = getStoredAppToken();
  return {
    'Content-Type': 'application/json',
    'x-session-id': getSessionId(),
    ...(token ? { 'x-app-token': token } : {}),
    ...extra,
  };
}

function cleanApiPath(url) {
  try {
    const u = new URL(String(url), window.location.origin);
    // 'url' che vì /api/inspect-emr-page nhận nguyên URL EMR (kèm mã phiên usid/st) —
    // không nên lưu nguyên văn vào log hoạt động.
    for (const key of ['token', 'ott', 'url']) {
      if (u.searchParams.has(key)) u.searchParams.set(key, '[hidden]');
    }
    const qs = u.searchParams.toString();
    return u.pathname.replace(/^\/api\/?/, '/api/') + (qs ? `?${qs}` : '');
  } catch {
    return String(url || '').replace(/([?&](token|ott)=)[^&]+/gi, '$1[hidden]');
  }
}

function apiActionLabel(method, url) {
  const path = cleanApiPath(url).split('?')[0];
  const map = {
    'GET /api/run-scan': 'quét danh sách bệnh nhân',
    'GET /api/run-emr-structure-scan': 'dò cấu trúc EMR',
    'GET /api/inspect-emr-page': 'dò cấu trúc 1 trang EMR',
    'GET /api/get-raw': 'tải dữ liệu thô',
    'GET /api/data': 'tải danh sách xếp phòng',
    'POST /api/save': 'lưu xếp phòng',
    'GET /api/room-mismatches': 'kiểm tra phòng lệch giữa board và dữ liệu y lệnh',
    'POST /api/fix-rooms': 'đồng bộ lại phòng cho dữ liệu y lệnh đã lấy',
    'POST /api/run-details': 'lấy y lệnh/dữ liệu chi tiết',
    'POST /api/remove-details-rooms': 'xoá dữ liệu y lệnh đã lấy nhầm phòng',
    'POST /api/run-details-one': 'cập nhật y lệnh một người bệnh',
    'GET /api/run-postprocess': 'xử lý và phân loại dữ liệu',
    'GET /api/has-processed': 'kiểm tra dữ liệu đã xử lý',
    'GET /api/get-patients': 'tải danh sách người bệnh đã xử lý',
    'POST /api/update-infusion-item': 'sửa thể tích/tốc độ dịch truyền',
    'GET /api/medication-catalog': 'tải danh mục thuốc',
    'POST /api/medication-catalog': 'thêm thuốc vào danh mục',
    'POST /api/check-input-changes': 'kiểm tra y lệnh mới trước khi nhập',
    'POST /api/run-input-care': 'nhập chăm sóc',
    'POST /api/run-input-infusions': 'nhập dịch truyền',
    'POST /api/run-input-procedures': 'nhập thủ thuật',
    'POST /api/run-input-vtyt': 'nhập/kiểm VTYT',
    'POST /api/preview-input-vtyt': 'quét xem trước VTYT',
    'POST /api/vtyt-catalog/scan-emr': 'dò danh mục VTYT trên EMR',
    'GET /api/vtyt-combos': 'tải danh sách combo VTYT',
    'POST /api/vtyt-combos': 'tạo combo VTYT',
    'POST /api/report-token': 'lấy quyền mở phiếu in',
    'GET /api/run-report-infusion': 'mở phiếu PDF',
    'GET /api/data-info': 'kiểm tra trạng thái dữ liệu',
    'GET /api/session-logs': 'tải log session',
    'GET /api/health': 'kiểm tra nhanh hệ thống',
    'GET /api/diagnostics': 'chẩn đoán hệ thống',
    'POST /api/clinic/preview': 'đọc danh sách phòng khám',
    'POST /api/clinic/care-preview': 'tìm người bệnh nhập viện cần nhập chăm sóc',
    'POST /api/clinic/care-order-seeds': 'lấy vị trí đau từ y lệnh đầu tiên',
    'POST /api/clinic/input-care': 'nhập chăm sóc người bệnh nhập viện',
    'POST /api/clinic/monitor/bbhc/prepare': 'soạn nháp Sổ biên bản hội chẩn',
    'POST /api/clinic/monitor/ngoaitru': 'làm điều trị ngoại trú',
    'POST /api/clinic/monitor/bbhc/run': 'lập Sổ biên bản hội chẩn',
    'GET /api/clinic/care-draft': 'tải bản nháp chăm sóc phòng khám',
    'POST /api/hchanh/stay-store/import': 'góp dữ liệu hành chánh vào kho nghiên cứu',
    'GET /api/kho/tong-quan': 'đọc tổng quan kho người bệnh',
    'GET /api/kho/tim': 'tìm người bệnh trong kho',
    'GET /api/kho/benh-nhan': 'đọc hành trình người bệnh',
    'GET /api/kho/luot': 'đọc danh sách lượt khám / nằm viện',
    'POST /api/kho/dong-bo': 'góp dữ liệu đã lấy vào kho người bệnh',
    'GET /api/kho/tai-kham': 'đọc báo cáo tái khám',
    'GET /api/kho/tai-nhap-vien': 'đọc báo cáo tái nhập viện',
    'POST /api/clinic/monitor/start': 'bắt đầu theo dõi phòng khám',
    'POST /api/clinic/monitor/stop': 'dừng theo dõi phòng khám',
    'POST /api/clinic/monitor/refresh': 'làm mới danh sách phòng khám',
    'GET /api/clinic/monitor/state': 'đọc danh sách phòng khám',
    'POST /api/clinic/monitor/complete': 'hoàn tất khám các người bệnh đã sẵn sàng',
    'POST /api/clinic/monitor/weight': 'ghi cân nặng người bệnh',
    'GET /api/data-sessions': 'tải danh sách phiên dữ liệu',
    'DELETE /api/data-sessions': 'xoá phiên dữ liệu',
    'POST /api/cancel': 'huỷ tác vụ đang chạy',
    'GET /api/nurse-settings': 'tải lịch điều dưỡng',
    'POST /api/nurse-settings': 'lưu lịch điều dưỡng',
    'GET /api/admin-nurse-state': 'tải trạng thái kiểm hành chánh',
    'POST /api/admin-nurse-state': 'lưu trạng thái kiểm hành chánh',
    'GET /api/sick-leave-state': 'tải trạng thái đã nộp nghỉ ốm',
    'POST /api/sick-leave-state': 'lưu trạng thái đã nộp nghỉ ốm',
    'GET /api/sick-leave-import': 'tải danh sách BHXH đã nhập gần nhất',
    'POST /api/sick-leave-import': 'nhập danh sách BHXH (.xlsx) để rà soát nghỉ ốm/ra viện',
    'POST /api/sick-leave-import/delete-row': 'xoá dòng đã nhập trong danh sách BHXH',
    'POST /api/sick-leave-launch-bhyt-tool': 'tự khởi động công cụ nhập cổng BHXH',
    'POST /api/check-current-bed': 'kiểm buồng giường hiện tại',

    'POST /api/hchanh/sync': 'đồng bộ danh sách kiểm hồ sơ',
    'GET /api/hchanh/dashboard': 'tải bảng hành chánh/kiểm hồ sơ',
    'POST /api/hchanh/fetch': 'lấy dữ liệu hành chánh/kiểm hồ sơ',
    'GET /api/hchanh/vtyt-draft': 'tải bản nháp VTYT hành chánh',
    'POST /api/hchanh/vtyt-draft': 'lưu bản nháp VTYT hành chánh',
    'DELETE /api/hchanh/vtyt-draft': 'xóa bản nháp VTYT hành chánh',
    'GET /api/hchanh/records-check/dashboard': 'tải danh sách kiểm hồ sơ hoàn tất',
    'POST /api/hchanh/records-check/scan-completed': 'quét danh sách hoàn tất kiểm hồ sơ',
    'POST /api/hchanh/records-check/export-pdf': 'xuất PDF kiểm hồ sơ đã kiểm',
    'POST /api/hchanh/records-check/google-sheet/update-row': 'sửa dòng Google Sheet kiểm hồ sơ',
    'POST /api/hchanh/records-check/paper-checklist': 'cập nhật checklist hồ sơ giấy',
    'GET /api/hchanh/records-check/submissions': 'tải lịch sử nộp hồ sơ',
    'POST /api/hchanh/records-check/submissions/add': 'xếp hồ sơ vào ngày nộp',
    'POST /api/hchanh/records-check/submissions/submit': 'chốt đợt hồ sơ đã nộp',
    'POST /api/hchanh/records-check/submissions/returned': 'đánh dấu hồ sơ bị trả về',
    'POST /api/hchanh/records-check/submissions/remove': 'bỏ hồ sơ khỏi đợt nộp chưa khóa',
    'POST /api/hchanh/records-check/submissions/export-pdf': 'xuất PDF theo ngày nộp hồ sơ',
    'POST /api/hchanh/records-check/submissions/discrepancy': 'ghi nhận sai sót sau bàn giao',
    'POST /api/hchanh/print-billing': 'in/lưu bảng kê hành chánh',
    'POST /api/hchanh/print-discharge-bundle': 'tổng hợp file in ra viện bệnh phòng',
    'GET /api/hchanh/print-ward-list': 'in danh sách xếp phòng',
    'POST /api/hchanh/print-ward-list-pdf': 'lưu PDF danh sách xếp phòng',
    'GET /api/export-data': 'xuất dữ liệu phiên',
    'POST /api/import-data': 'nhập dữ liệu phiên',
    'GET /api/research/studies': 'tải danh sách nghiên cứu',
    'POST /api/research/studies': 'tạo nghiên cứu mới',
  };
  const exact = map[`${method} ${path}`];
  if (exact) return exact;
  if (method === 'DELETE' && path.startsWith('/api/data-sessions/')) return 'xoá phiên dữ liệu';
  if (path.startsWith('/api/research/studies/') && path.endsWith('/cohort')) return 'nạp danh sách nghiên cứu';
  if (path.startsWith('/api/research/studies/') && path.endsWith('/run')) return 'lấy dữ liệu nghiên cứu';
  if (path.startsWith('/api/research/studies/') && path.endsWith('/data')) return 'tải bảng nghiên cứu';
  if (path.startsWith('/api/research/studies/')) return 'tải nghiên cứu';
  return `${method} ${path}`;
}

function summarizeApiBody(body) {
  if (body == null) return null;
  if (Array.isArray(body)) return { type: 'array', count: body.length };
  if (typeof body !== 'object') return { type: typeof body };
  const visibleKeys = Object.keys(body).filter(k => !/password|pass|token|secret|cookie|authorization/i.test(k));
  const out = { type: 'object', keys: visibleKeys.slice(0, 20) };
  for (const key of ['targets', 'rows', 'patients']) {
    if (Array.isArray(body[key])) out[key] = { count: body[key].length };
  }
  if (body.patient) {
    out.patient = {
      ma_bn: body.patient.ma_bn || body.patient.id || body.patient['Mã BN'] || body.patient['Mã YT'] || '',
      so_phong: body.patient.so_phong || body.patient.room || body.patient.Vi_Tri || '',
    };
  }
  for (const key of ['date', 'dateFrom', 'dateTo', 'date_from', 'date_to', 'rooms', 'scope', 'partial']) {
    if (body[key] != null) out[key] = body[key];
  }
  return out;
}

function parseRequestBody(options = {}) {
  const raw = options.body;
  if (!raw || typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Đọc message lỗi từ response JSON của backend.
 * Tránh mất thông tin như "Python timeout", "thiếu file", "date_from sai định dạng".
 */
async function extractErrorMessage(res) {
  try {
    const data = await res.json();
    return data?.message || `${res.status} ${res.statusText}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

async function fetchWithAuth(url, options = {}, retried = false, details = null) {
  // ... unchanged ...
}
