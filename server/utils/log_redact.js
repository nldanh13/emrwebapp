// server/utils/log_redact.js — Che thông tin định danh / mã phiên trong dòng log.
//
// Áp dụng cho log console của worker Python, stderr trả về giao diện và action_log.txt.
// Chỉ đổi phần hiển thị trong log; không đụng dữ liệu nghiên cứu. Bản Python tương ứng:
// worker/log_redact.py (hai bản phải cho cùng kết quả — xem scripts/log_redact_test.js).

'use strict';

const crypto = require('crypto');

// Muối ngẫu nhiên cho mỗi lần khởi động server: cùng một Mã BN cho cùng một nhãn (để lần
// theo log), nhưng không tra ngược được bằng cách thử hết các mã. Worker Python nhận cùng
// muối qua biến môi trường LOG_REDACT_SALT (python_runner) nên nhãn hai bên khớp nhau.
const SALT = crypto.randomBytes(16).toString('hex');

// Tham số URL EMR giữ lại vì chỉ mô tả màn hình (không định danh, không phải phiên).
const SAFE_URL_PARAMS = new Set(['wpid', 'wpre', 'nextlink', 'scope', 'lang', 'tt', 'tg']);

function patientTag(code) {
  const h = crypto.createHash('sha256').update(`${SALT}|${code}`).digest('hex').slice(0, 6);
  return `BN#${h}`;
}

function redactUrl(url) {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const base = url.slice(0, q);
  const kept = url.slice(q + 1).split('&').filter(Boolean).map(pair => {
    const k = pair.split('=')[0];
    return SAFE_URL_PARAMS.has(k.toLowerCase()) ? pair : `${k}=…`;
  });
  return `${base}?${kept.join('&')}`;
}

function redactLogLine(line) {
  let s = String(line ?? '');
  if (!s) return s;
  s = s.replace(/https?:\/\/[^\s'"<>]+/gi, redactUrl);
  // Tham số định danh/phiên xuất hiện ngoài URL.
  s = s.replace(/\b(usid|noitruid|dieutriid|vaovienid|benhnhanid|keyword|kp)=([^\s&'"]+)/gi, '$1=…');
  // Mã BN: dãy 7–10 chữ số đứng riêng (ngày/giờ/phiên bản không khớp vì có dấu phân cách).
  s = s.replace(/(^|[^\w./-])(\d{7,10})(?![\w./-])(?!:\d)/g, (_, pre, code) => `${pre}${patientTag(code)}`);
  return s;
}

// Khung stacktrace của chromedriver/Windows: không có giá trị chẩn đoán, chỉ làm nhiễu log.
function isDriverStackNoise(line) {
  const t = String(line || '').trim();
  return t === 'Stacktrace:'
    || /^\(Session info: /.test(t)
    || /^[\w.-]+!(GetHandleVerifier|\(No symbol\)|BaseThreadInitThunk|RtlUserThreadStart)(?=\s|$)/.test(t)
    || /^#\d+ 0x[0-9a-f]+ <unknown>$/i.test(t);
}

module.exports = { redactLogLine, isDriverStackNoise, patientTag, LOG_REDACT_SALT: SALT };
