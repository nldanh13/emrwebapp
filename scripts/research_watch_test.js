'use strict';
// Kênh báo số liệu nghiên cứu đổi (UX_RULES mục 9): chỉ phát sự kiện khi file nguồn đổi hoặc
// danh sách tác vụ đang chạy đổi; không đổi thì im lặng (giao diện không phải hỏi theo giờ).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const watch = require('../server/services/research_watch');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok - ${name}`); } catch (err) { failed += 1; console.log(`  not ok - ${name}\n    ${err.stack}`); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-watch-'));
fs.writeFileSync(path.join(dir, 'progress.json'), '{"a":1}');

console.log('research_watch_test');
test('không đổi gì thì không phát sự kiện', () => {
  watch.__resetResearchWatch();
  watch.watchResearchScope('archive', dir);
  watch.tick();
  assert.deepStrictEqual(watch.tick(), []);
});

test('file tiến độ đổi thì phát đúng một sự kiện data cho phạm vi đó', () => {
  watch.__resetResearchWatch();
  watch.watchResearchScope('archive', dir);
  watch.tick();
  fs.writeFileSync(path.join(dir, 'progress.json'), '{"a":1,"b":2}');
  const events = watch.tick();
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].kind, 'data');
  assert.strictEqual(events[0].scope, 'archive');
  assert.deepStrictEqual(watch.tick(), []);
});

test('danh sách tác vụ đang chạy đổi thì phát sự kiện running; sự kiện đến người nghe', () => {
  watch.__resetResearchWatch();
  let sig = '';
  watch.setRunningSignature(() => sig);
  const got = [];
  const off = watch.subscribeResearchEvents(e => got.push(e));
  watch.tick();
  sig = 'archive|Thu thập tự động|2026-10-05';
  watch.tick();
  sig = '';
  watch.tick();
  off();
  assert.deepStrictEqual(got.map(e => e.kind), ['running', 'running']);
});

test('sự kiện không chứa đường dẫn hay dữ liệu người bệnh', () => {
  watch.__resetResearchWatch();
  watch.watchResearchScope('st1', dir);
  watch.tick();
  fs.writeFileSync(path.join(dir, 'collection_ledger.json'), '{}');
  const [e] = watch.tick();
  assert.deepStrictEqual(Object.keys(e).sort(), ['at', 'event', 'kind', 'scope', 'version']);
  assert.ok(!JSON.stringify(e).includes(dir));
});

watch.__resetResearchWatch();
fs.rmSync(dir, { recursive: true, force: true });
if (failed) { console.log(`${failed} test(s) failed.`); process.exit(1); }
console.log('4 test(s) passed.');
