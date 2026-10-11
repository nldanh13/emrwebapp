// Smoke test: only the intended read-only records-check calls enter resident Chrome.
'use strict';
const assert = require('node:assert/strict');
const { readOnlyJob } = require('../server/services/hchanh_resident_worker');

const valid = [
  '--input', '/runtime/sessions/one/hchanh/fetch_batch_input.json',
  '--out', '/runtime/sessions/one/hchanh/fetch_batch_output.json',
  '--scope', 'discharge', '--files', 'discharge,cls',
  '--status', 'Hoàn tất', '--batch-size', '10', '--headless',
];
assert.deepEqual(readOnlyJob(valid), {
  op: 'records_check',
  input: valid[1], output: valid[3],
  files: ['discharge', 'cls'], headless: true, status: 'Hoàn tất',
});
assert.equal(readOnlyJob(valid.filter(x => x !== '--headless')), null);
assert.equal(readOnlyJob(valid.map(x => x === 'discharge,cls' ? 'surgery' : x)), null);
assert.equal(readOnlyJob([...valid, '--action', 'write']), null);
assert.equal(readOnlyJob([...valid, '--scope', 'discharge']), null);
assert.equal(readOnlyJob(valid.map(x => x === 'Hoàn tất' ? 'Đang thực hiện' : x)), null);
assert.equal(readOnlyJob(valid.map(x => x === '10' ? '1000' : x)), null);
console.log('hchanh resident worker read-only dispatch: OK');
