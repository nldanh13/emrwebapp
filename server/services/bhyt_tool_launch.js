// server/services/bhyt_tool_launch.js — chờ công cụ nhập cổng BHXH (tools/bhyt_selenium_app) khởi động.
//
// Máy chủ tự chạy công cụ khi người dùng bấm "Lấy mã CAPTCHA". Công cụ tắt ngay (thiếu thư viện,
// cổng 5005 bị chiếm…) thì đọc runtime/launch.log để báo đúng lý do bằng tiếng Việt, thay vì để
// giao diện chờ rồi báo chung chung "chưa sẵn sàng".

'use strict';

const START_BAT = 'tools\\bhyt_selenium_app\\start.bat';

function lastErrorLine(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (/^[A-Za-z_][\w.]*(Error|Exception)\b.*:/.test(line)) return line;
  }
  return '';
}

/** Lý do công cụ không lên, từ phần log của lần khởi động này. */
function launchFailureMessage(logText, { exited }) {
  const text = String(logText || '');
  const missing = text.match(/No module named ['"]?([\w.]+)/);
  if (missing) {
    const lib = missing[1].split('.')[0];
    return `Công cụ nhập cổng BHXH thiếu thư viện ${lib}. Mở ${START_BAT} một lần để cài, rồi bấm "Lấy mã CAPTCHA" lại.`;
  }
  if (/WinError 10048|Address already in use|Only one usage of each socket address/i.test(text)) {
    return 'Cổng 5005 đang bị một chương trình khác chiếm (thường là cửa sổ công cụ cũ bị treo). '
      + 'Đóng cửa sổ "BHYT Selenium" cũ hoặc khởi động lại máy, rồi bấm "Lấy mã CAPTCHA" lại.';
  }
  if (!exited) {
    return 'Công cụ nhập cổng BHXH khởi động lâu hơn bình thường. Chờ vài giây rồi bấm "Lấy mã CAPTCHA" lại.';
  }
  const line = lastErrorLine(text.split(/\r?\n/)).slice(0, 200);
  return line
    ? `Công cụ nhập cổng BHXH khởi động bị lỗi: ${line}. Mở ${START_BAT} để xem chi tiết.`
    : `Công cụ nhập cổng BHXH tắt ngay khi khởi động. Mở ${START_BAT} để xem lỗi.`;
}

/**
 * Chờ công cụ lắng nghe ở cổng 5005. Dừng sớm khi tiến trình đã tắt.
 * @returns {Promise<{ok: true} | {ok: false, message: string}>}
 */
async function waitForLaunch({ child, isRunning, readLog, timeoutMs = 20000, intervalMs = 500 }) {
  let exited = false;
  child.once('exit', () => { exited = true; });
  child.once('error', () => { exited = true; });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(res => setTimeout(res, intervalMs));
    if (await isRunning()) return { ok: true };
    if (exited) break;
  }
  return { ok: false, message: launchFailureMessage(readLog(), { exited }) };
}

module.exports = { launchFailureMessage, waitForLaunch };
