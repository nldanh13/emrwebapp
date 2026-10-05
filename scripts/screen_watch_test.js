'use strict';
// Bộ theo dõi màn hình dùng chung (UX_RULES mục 9): file/thư mục nguồn đổi thì phát đúng một sự
// kiện 'screen' cho đúng workspace + màn hình; không đổi thì im lặng; sự kiện không chứa đường dẫn.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sw = require('../server/services/screen_watch');

let failed = 0; let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); } catch (err) { failed += 1; console.log(`  not ok - ${name}\n    ${err.stack}`); }
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-watch-'));
const state = path.join(dir, 'state.json');
fs.writeFileSync(state, '{}');

console.log('screen_watch_test');
test('không đổi gì thì không phát sự kiện', () => {
  sw.__resetScreenWatch();
  sw.watchScreen({ sid: 'a', key: 'clinic-monitor', files: [state] });
  assert.deepStrictEqual(sw.tick(), []);
});

test('file đổi thì phát một sự kiện cho đúng workspace và màn hình', () => {
  sw.__resetScreenWatch();
  sw.watchScreen({ sid: 'a', key: 'clinic-monitor', files: [state] });
  sw.watchScreen({ sid: 'b', key: 'other', files: [path.join(dir, 'khong-co.json')] });
  fs.writeFileSync(state, '{"running":true}');
  const events = sw.tick();
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].sid, 'a');
  assert.strictEqual(events[0].key, 'clinic-monitor');
  assert.deepStrictEqual(sw.tick(), []);
  assert.ok(!JSON.stringify(events[0]).includes(dir));
});

test('thư mục: thêm file mới (ghi atomic) thì báo đổi', () => {
  sw.__resetScreenWatch();
  const sub = fs.mkdtempSync(path.join(dir, 'bundles-'));
  sw.watchScreen({ sid: 'a', key: 'discharge-bundles', files: [sub] });
  const tmp = path.join(sub, 'x.tmp');
  fs.writeFileSync(tmp, 'pdf');
  fs.renameSync(tmp, path.join(sub, 'IN_RA_VIEN_1.pdf'));
  const t0 = Date.now(); while (Date.now() - t0 < 5) { /* để mtime khác */ }
  assert.strictEqual(sw.tick().length, 1);
});

test('trạng thái trong bộ nhớ (extra) đổi cũng báo; gọi lại route thì lấy mốc mới', () => {
  sw.__resetScreenWatch();
  let running = false;
  const extra = () => (running ? 'run' : 'idle');
  sw.watchScreen({ sid: 'a', key: 'clinic-monitor', files: [state], extra });
  running = true;
  assert.strictEqual(sw.tick().length, 1);
  running = false;
  sw.watchScreen({ sid: 'a', key: 'clinic-monitor', files: [state], extra });
  assert.deepStrictEqual(sw.tick(), []);
});

test('người nghe nhận sự kiện qua subscribeScreenEvents', () => {
  sw.__resetScreenWatch();
  const got = [];
  const off = sw.subscribeScreenEvents(e => got.push(e));
  sw.watchScreen({ sid: 'a', key: 'k', files: [state] });
  fs.writeFileSync(state, '{"x":1,"y":2,"z":3}');
  sw.tick();
  off();
  assert.strictEqual(got.length, 1);
});

sw.__resetScreenWatch();
fs.rmSync(dir, { recursive: true, force: true });
if (failed) { console.log(`${failed} test(s) failed.`); process.exit(1); }
console.log(`${passed} test(s) passed.`);
