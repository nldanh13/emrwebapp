'use strict';

// Version dữ liệu thô cần được các tầng Thu thập và worker hiểu giống nhau.
// Khi parser/cửa sổ Lịch sử y lệnh thay đổi, tăng số này để collection ledger
// tự đánh dấu các kết quả cũ là stale và giao lại cho worker đúng một lần.
const ORDER_HISTORY_FETCH_WINDOW_VERSION = 4;

module.exports = {
  ORDER_HISTORY_FETCH_WINDOW_VERSION,
};
