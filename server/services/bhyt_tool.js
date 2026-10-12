// server/services/bhyt_tool.js — mọi lần nói chuyện với công cụ nhập cổng BHXH (tools/bhyt_selenium_app,
// Flask/Selenium, chỉ lắng nghe 127.0.0.1:5005) đi qua đây.
//
// Trình duyệt không gọi thẳng cổng 5005: tab Nghỉ ốm gọi /api/bhyt-tool/... trên máy chủ chính, máy
// chủ chuyển tiếp (forwardToTool) theo danh sách đường cho phép. Đường có mật khẩu (đăng nhập cổng,
// đăng nhập EMR) chỉ máy chủ gọi (callTool), không chuyển tiếp từ trình duyệt.
//
// Máy chủ tự chạy công cụ khi người dùng bấm "Lấy mã CAPTCHA". Công cụ tắt ngay (thiếu thư viện,
// cổng 5005 bị chiếm…) thì đọc runtime/launch.log để báo đúng lý do bằng tiếng Việt, thay vì để
// giao diện chờ rồi báo chung chung "chưa sẵn sàng".

'use strict';

const BHYT_TOOL_URL = 'http://127.0.0.1:5005';
const START_BAT = 'tools\\bhyt_selenium_app\\start.bat';
const TOOL_DOWN_MESSAGE = 'Công cụ nhập cổng BHXH chưa chạy. Bấm "Lấy mã CAPTCHA" để khởi động.';

// Đường trình duyệt được gọi qua máy chủ (tab Nghỉ ốm). Ngoài danh sách này thì từ chối.
const FORWARD_ROUTES = [
  ['GET', /^\/api\/summary$/],
  ['GET', /^\/api\/records$/],
  ['GET', /^\/api\/browser\/status$/],
  ['GET', /^\/api\/browser\/captcha$/],
  ['POST', /^\/api\/browser\/refresh-captcha$/],
  ['GET', /^\/api\/emr\/status$/],
  ['GET', /^\/api\/emr\/grv-defaults$/],
  ['POST', /^\/api\/emr\/grv-defaults$/],
  ['POST', /^\/api\/auto-run$/],
  ['POST', /^\/api\/records\/\d+\/sick-leave$/],
  ['POST', /^\/api\/run$/],
  ['POST', /^\/api\/stop$/],
];

async function isBhytToolRunning(fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${BHYT_TOOL_URL}/api/summary`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch (_) {
    return false;
  }
}

/** Máy chủ gọi công cụ (kể cả đường có mật khẩu). Ném lỗi tiếng Việt. */
async function callTool(fetchImpl, path, body) {
  const r = await requestTool({ fetchImpl, method: body === undefined ? 'GET' : 'POST', path, body });
  if (r.status >= 400) throw new Error(r.body.message);
  return r.body;
}

async function requestTool({ fetchImpl, method, path, body }) {
  let res;
  try {
    res = await fetchImpl(`${BHYT_TOOL_URL}${path}`, method === 'GET' ? { method } : {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
    });
  } catch (_) {
    return { status: 503, body: { status: 'error', code: 'BHYT_TOOL_DOWN', message: TOOL_DOWN_MESSAGE } };
  }
  let data = null;
  try { data = await res.json(); } catch (_) { data = null; }
  if (res.ok && data) return { status: res.status, body: data };
  if (data && (data.error || data.message)) {
    return { status: res.status, body: { status: 'error', message: String(data.error || data.message) } };
  }
  return {
    status: 502,
    body: {
      status: 'error',
      message: `Công cụ nhập cổng BHXH bị lỗi khi xử lý (mã ${res.status}). Xem cửa sổ "BHYT Selenium" hoặc runtime\\launch.log để biết chi tiết, rồi thử lại.`,
    },
  };
}

/** Chuyển tiếp một lời gọi từ trình duyệt sang công cụ. Trả {status, body}. */
async function forwardToTool({ method, path, body, fetchImpl = fetch }) {
  const m = String(method || '').toUpperCase();
  const allowed = FORWARD_ROUTES.some(([rm, re]) => rm === m && re.test(String(path || '')));
  if (!allowed) {
    return { status: 404, body: { status: 'error', message: 'Thao tác này không hỗ trợ qua web app. Tải lại trang rồi thử lại.' } };
  }
  return requestTool({ fetchImpl, method: m, path, body });
}

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

module.exports = {
  BHYT_TOOL_URL, callTool, forwardToTool, isBhytToolRunning, launchFailureMessage, waitForLaunch,
};
