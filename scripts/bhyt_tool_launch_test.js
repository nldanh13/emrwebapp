// Tự khởi động công cụ nhập cổng BHXH: công cụ tắt ngay khi khởi động thì báo đúng lý do
// (đọc từ runtime/launch.log), không báo chung chung "chưa sẵn sàng".
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { launchFailureMessage, waitForLaunch } = require('../server/services/bhyt_tool_launch');

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

  console.log('bhyt_tool_launch_test: OK');
})().catch(err => { console.error(err); process.exit(1); });
