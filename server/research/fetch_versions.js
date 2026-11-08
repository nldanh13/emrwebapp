'use strict';

// Version dữ liệu thô cần được các tầng Thu thập và worker hiểu giống nhau.
// Khi parser/cửa sổ Lịch sử y lệnh thay đổi, tăng số này để collection ledger
// tự đánh dấu các kết quả cũ là stale và giao lại cho worker đúng một lần.
const ORDER_HISTORY_FETCH_WINDOW_VERSION = 4;

// Nội dung Kho nghiên cứu cần trong phần Hồ sơ nền (sinh hiệu Phiếu vào viện) và Chi phí (khối
// Tổng hợp chi phí). Bản lấy trước khi worker đọc các mục này, hoặc bản dùng lại từ tab Hành chánh /
// Kiểm HSBA / kho người bệnh, thiếu chúng: không được dùng lại, và sổ thu thập giao lấy lại một lần.
//
// Mức 3 (11/2026):
// - profile: bản cũ đọc "Phiếu vào viện" lỗi ở mọi ca (trang còn đứng ở bảng kê, không thấy mục) → lấy
//   lại một lần. Bản đã đọc được (ok/empty) hoặc bản worker mới (_admission_vitals_read) giữ nguyên.
// - billing: bản cũ có thể đọc nhầm trang người bệnh trước khi bảng kê mở (0 dòng) → lấy lại một lần.
//   Bản có dòng chi tiết hoặc bản worker mới đã kiểm đúng trang (_billing_page_checked) giữ nguyên.
const HCHANH_CONTENT_VERSIONS = Object.freeze({ profile: 3, billing: 3 });

// Mức nội dung của một payload worker; 0 = phần không theo dõi mức nội dung.
function hchanhPayloadContentVersion(file, payload) {
  if (!Object.prototype.hasOwnProperty.call(HCHANH_CONTENT_VERSIONS, file)) return 0;
  if (!payload || typeof payload !== 'object') return 0;
  if (file === 'profile') {
    if (!Object.prototype.hasOwnProperty.call(payload, '_admission_vitals_status')) return 1;
    const read = payload._admission_vitals_read != null || ['ok', 'empty'].includes(String(payload._admission_vitals_status || ''));
    return read ? 3 : 2;
  }
  if (!(payload.tong_hop && typeof payload.tong_hop === 'object')) return 1;
  const hasRows = Array.isArray(payload.rows) && payload.rows.length > 0;
  return hasRows || Object.prototype.hasOwnProperty.call(payload, '_billing_page_checked') ? 3 : 2;
}

function hchanhPayloadComplete(file, payload) {
  const need = HCHANH_CONTENT_VERSIONS[file];
  return !need || hchanhPayloadContentVersion(file, payload) >= need;
}

module.exports = {
  ORDER_HISTORY_FETCH_WINDOW_VERSION,
  HCHANH_CONTENT_VERSIONS,
  hchanhPayloadContentVersion,
  hchanhPayloadComplete,
};
