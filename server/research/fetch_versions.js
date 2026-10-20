'use strict';

// Version dữ liệu thô cần được các tầng Thu thập và worker hiểu giống nhau.
// Khi parser/cửa sổ Lịch sử y lệnh thay đổi, tăng số này để collection ledger
// tự đánh dấu các kết quả cũ là stale và giao lại cho worker đúng một lần.
const ORDER_HISTORY_FETCH_WINDOW_VERSION = 4;

// Nội dung Kho nghiên cứu cần trong phần Hồ sơ nền (sinh hiệu Phiếu vào viện) và Chi phí (khối
// Tổng hợp chi phí). Bản lấy trước khi worker đọc các mục này, hoặc bản dùng lại từ tab Hành chánh /
// Kiểm HSBA / kho người bệnh, thiếu chúng: không được dùng lại, và sổ thu thập giao lấy lại một lần.
const HCHANH_CONTENT_VERSIONS = Object.freeze({ profile: 2, billing: 2 });

// Mức nội dung của một payload worker; 0 = phần không theo dõi mức nội dung.
function hchanhPayloadContentVersion(file, payload) {
  if (!Object.prototype.hasOwnProperty.call(HCHANH_CONTENT_VERSIONS, file)) return 0;
  if (!payload || typeof payload !== 'object') return 0;
  if (file === 'profile') return Object.prototype.hasOwnProperty.call(payload, '_admission_vitals_status') ? 2 : 1;
  return payload.tong_hop && typeof payload.tong_hop === 'object' ? 2 : 1;
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
