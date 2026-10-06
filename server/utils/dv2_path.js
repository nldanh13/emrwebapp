'use strict';
// Đường dẫn cấu hình thuốc d_v2.json cho worker.
//
// Trước đây mỗi phiên chép config/d_v2.json vào thư mục phiên MỘT LẦN rồi worker đọc bản chép đó
// mãi mãi: bản cập nhật sửa luật pha/giờ mặc định không tới được phiên cũ, không báo gì. Nay luôn
// dùng file chung của dự án; bản riêng của phiên chỉ được dùng khi chính nó ghi rõ
// "__dung_ban_rieng__": true (người sửa tay muốn giữ).

const fs = require('fs');
const path = require('path');
const { ROOT_DIR } = require('../constants');
const { readJsonSafe } = require('./file');

const PROJECT_DV2 = path.join(ROOT_DIR, 'config', 'd_v2.json');

function resolveDv2Path(runtimeDir) {
  if (runtimeDir) {
    const own = path.join(runtimeDir, 'd_v2.json');
    if (fs.existsSync(own)) {
      const data = readJsonSafe(own, null);
      if (data && data.__dung_ban_rieng__ === true) return own;
    }
  }
  return PROJECT_DV2;
}

module.exports = { resolveDv2Path, PROJECT_DV2 };
