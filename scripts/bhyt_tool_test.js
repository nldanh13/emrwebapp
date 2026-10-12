// Tự khởi động công cụ nhập cổng BHXH: công cụ tắt ngay khi khởi động thì báo đúng lý do
// (đọc từ runtime/launch.log), không báo chung chung "chưa sẵn sàng".
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { launchFailureMessage, waitForLaunch, forwardToTool } = require('../server/services/bhyt_tool');

// Thiếu thư viện Python
{
  const log = 'Traceback (most recent call last):\n  File "app.py", line 13, in <module>\n'
    + "    from bhyt.auto_run import AutoRunError\nModuleNotFoundError: No module named 'pdfminer'\n";
  const msg = launchFailureMessage(log, { exited: true });
  assert.match(msg, /thiếu thư viện pdfminer/);
  assert.match(msg, /start\.bat/);
  assert.doesNotMatch(msg, /Traceback/);
}

// Cổng 5005 đã bị chiếm (Windows và Linux)
for (const line of [
  'OSError: [WinError 10048] Only one usage of each socket address (protocol/network address/port) is normally permitted',
  'OSError: [Errno 98] Address already in use',
]) {
  assert.match(launchFailureMessage(`* Serving Flask app 'app'\n${line}\n`, { exited: true }), /Cổng 5005 đang bị/);
}

// Lỗi khác: lấy dòng lỗi cuối, không kèm traceback
{
  const msg = launchFailureMessage('Traceback (most recent call last):\n  File "x"\nValueError: config.json hỏng\n', { exited: true });
  assert.match(msg, /ValueError: config\.json hỏng/);
  assert.doesNotMatch(msg, /Traceback|File "x"/);
}

// Không tắt mà chỉ chậm
assert.match(launchFailureMessage('', { exited: false }), /khởi động lâu hơn bình thường/);

(async () => {
  // Công cụ tắt ngay → trả lỗi kèm lý do, không chờ hết thời gian
  {
    const child = new EventEmitter();
    let reads = 0;
    const started = Date.now();
    setTimeout(() => child.emit('exit', 1), 20);
    const r = await waitForLaunch({
      child,
      isRunning: async () => false,
      readLog: () => { reads += 1; return "ModuleNotFoundError: No module named 'flask'\n"; },
      timeoutMs: 5000,
      intervalMs: 10,
    });
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /thiếu thư viện flask/);
    assert.ok(Date.now() - started < 2000, 'không chờ hết thời gian khi công cụ đã tắt');
    assert.strictEqual(reads, 1);
  }

  // Công cụ lên sau vài lần hỏi → ok
  {
    let n = 0;
    const r = await waitForLaunch({
      child: new EventEmitter(),
      isRunning: async () => { n += 1; return n >= 3; },
      readLog: () => '',
      timeoutMs: 5000,
      intervalMs: 5,
    });
    assert.deepStrictEqual(r, { ok: true });
  }

  // Hết thời gian mà công cụ vẫn chạy (chưa lắng nghe) → báo chậm
  {
    const r = await waitForLaunch({
      child: new EventEmitter(),
      isRunning: async () => false,
      readLog: () => '',
      timeoutMs: 40,
      intervalMs: 5,
    });
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /lâu hơn bình thường/);
  }

  // Trình duyệt gọi công cụ qua máy chủ chính (/api/bhyt-tool/...), không gọi thẳng cổng 5005.
  {
    const seen = [];
    const ok = await forwardToTool({
      method: 'GET', path: '/api/summary',
      fetchImpl: async (url, opts) => { seen.push([url, opts.method]); return { ok: true, status: 200, json: async () => ({ auto: null }) }; },
    });
    assert.deepStrictEqual(ok, { status: 200, body: { auto: null } });
    assert.deepStrictEqual(seen, [['http://127.0.0.1:5005/api/summary', 'GET']]);

    const post = await forwardToTool({
      method: 'POST', path: '/api/records/12/sick-leave', body: { answer: 'co' },
      fetchImpl: async (_url, opts) => ({ ok: true, status: 200, json: async () => JSON.parse(opts.body) }),
    });
    assert.deepStrictEqual(post.body, { answer: 'co' });
  }
  // Đường có mật khẩu (đăng nhập) hoặc ngoài danh sách thì không chuyển tiếp.
  for (const [method, p] of [['POST', '/api/browser/login'], ['POST', '/api/emr/login'], ['GET', '/api/logs'], ['POST', '/api/summary']]) {
    const r = await forwardToTool({ method, path: p, fetchImpl: async () => { throw new Error('không được gọi'); } });
    assert.strictEqual(r.status, 404, `${method} ${p}`);
    assert.match(r.body.message, /không hỗ trợ/);
  }
  // Công cụ chưa chạy
  {
    const r = await forwardToTool({ method: 'GET', path: '/api/summary', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.body.code, 'BHYT_TOOL_DOWN');
    assert.match(r.body.message, /chưa chạy/);
  }
  // Công cụ báo lỗi bằng JSON → giữ nguyên lời báo; lỗi trang HTML → câu tiếng Việt, không "500 Internal Server Error"
  {
    const j = await forwardToTool({ method: 'GET', path: '/api/records',
      fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: 'Chưa đăng nhập cổng' }) }) });
    assert.deepStrictEqual(j, { status: 400, body: { status: 'error', message: 'Chưa đăng nhập cổng' } });
    const h = await forwardToTool({ method: 'GET', path: '/api/records',
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => { throw new SyntaxError('html'); } }) });
    assert.strictEqual(h.status, 502);
    assert.match(h.body.message, /Công cụ nhập cổng BHXH bị lỗi khi xử lý/);
    assert.doesNotMatch(h.body.message, /Internal Server Error/);
  }

  console.log('bhyt_tool_test: OK');
})().catch(err => { console.error(err); process.exit(1); });
