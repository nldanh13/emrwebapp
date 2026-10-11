// Smoke test: only the intended read-only records-check calls enter resident Chrome.
'use strict';
const assert = require('node:assert/strict');
const { readOnlyJob, ResidentWorker, residentStatus } = require('../server/services/hchanh_resident_worker');

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
// Use a fake child (no Chrome/network) to prove that concurrent callers
// never overlap commands sent to one persistent Python process.
async function testSerialQueue() {
  const worker = new ResidentWorker('/tmp/fake-records-check');
  const observed = [];
  let inflight = 0;
  let maxInflight = 0;
  let spawned = 0;
  worker._spawn = function fakeSpawn() {
    spawned += 1;
    const child = {
      stdin: { write: frame => {
        const message = JSON.parse(frame);
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        observed.push(message.id);
        setTimeout(() => {
          inflight -= 1;
          worker._onStdout(child, Buffer.from(JSON.stringify({ id: message.id, code: 0 }) + '\n'));
        }, 8);
      }},
    };
    worker.child = child;
    return child;
  };
  const command = { op: 'records_check' };
  const values = await Promise.all([worker.run(command), worker.run(command)]);
  assert.deepEqual(values.map(v => v.code), [0, 0]);
  assert.equal(maxInflight, 1);
  assert.equal(spawned, 1);
  assert.equal(observed.length, 2);
}

async function testCancelBeforeDispatch() {
  const worker = new ResidentWorker('/tmp/fake-cancelled-records-check');
  let sent = 0;
  worker._spawn = function fakeSpawn() {
    const child = { stdin: { write: () => { sent += 1; } } };
    worker.child = child;
    return child;
  };
  const result = await worker.run({ op: 'records_check' }, {
    onSpawn: cancel => cancel(),
  });
  assert.equal(result.code, -1);
  assert.equal(sent, 0, 'cancelled tasks must not reach Chrome');
}

async function testStatusAndNoPatientLogs() {
  const original = process.env.EMR_PERSISTENT_HCHANH_WORKER;
  try {
    delete process.env.EMR_PERSISTENT_HCHANH_WORKER;
    assert.equal(residentStatus().enabled, true, 'read-only worker is enabled by default');
    process.env.EMR_PERSISTENT_HCHANH_WORKER = '0';
    assert.equal(residentStatus().enabled, false, 'rollback must disable resident Chrome');
  } finally {
    if (original === undefined) delete process.env.EMR_PERSISTENT_HCHANH_WORKER;
    else process.env.EMR_PERSISTENT_HCHANH_WORKER = original;
  }
  const worker = new ResidentWorker('/tmp/fake-privacy-test');
  const patientText = 'Nguyễn Văn B';
  worker._onStderr(Buffer.from('WARN [EMR] ' + patientText + ' mã 12345678\\n'));
  assert.equal(worker.stderrTail.length, 1);
  assert(!JSON.stringify(worker.stderrTail).includes(patientText), 'patient names must not reach logs');
  assert(!JSON.stringify(residentStatus()).includes('/tmp'), 'status must not reveal workspace paths');
}

Promise.resolve().then(testSerialQueue).then(testCancelBeforeDispatch).then(testStatusAndNoPatientLogs).then(() => {
  console.log('hchanh resident worker read-only dispatch, queue and cancel: OK');
}).catch(err => { console.error(err); process.exitCode = 1; });
