#!/usr/bin/env node
'use strict';

// Kiểm tra che thông tin trong log (server/utils/log_redact.js) và bản Python
// (worker/log_redact.py) cho cùng kết quả khi dùng cùng muối. Dữ liệu dưới đây là giả.

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { redactLogLine, isDriverStackNoise, patientTag, LOG_REDACT_SALT } = require('../server/utils/log_redact');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

const FAKE_URL = 'http://10.0.0.1:2026/home.aspx?scope=sys&lang=vi&role=323&usid=10.9.9.9_abcdefsessiontoken&st=140734'
  + '&wpid=bacsidraw&noitruid=00000000-1111-2222-3333-444444444444&keyword=99000001&kp=aaaa-bbbb&tt=4&tg=7'
  + '&tungay=06%2F07%2F2026&denngay=23%2F09%2F2026&wpre=danhsachdieutrinoitrudraw&nextlink=lichsuylenh';

const SAMPLES = [
  `[PY] LOG [hchanh-click] Mở tên người bệnh: ${FAKE_URL}`,
  'LOG [hchanh-click] Dùng lại Chrome đang mở cho BN 99000001 | trạng thái=Hoàn tất.',
  'LOG [order_history] 99000001: 1 khoa | total=15 | incomplete=0 | after_discharge=0',
  'LOG: ── Ca 2/4 trong lô: BN=99000002 | files=[\'discharge\']',
  'LOG [surgery] tìm D/s phẫu thuật 15/07/2026 → 17/07/2026: 0 dòng',
  'Run 20260529_162615 | chrome=153.0.8010.54 | 10:50:12',
  'Mã BN (99000003) và mã khác 99000003',
  'uuid 12345678-1111-2222-3333-444444444444 giữ nguyên',
];

console.log('log_redact');

test('che usid/noitruid/keyword/kp và giữ wpid/wpre/nextlink trong URL', () => {
  const out = redactLogLine(SAMPLES[0]);
  assert(!out.includes('abcdefsessiontoken'));
  assert(!out.includes('00000000-1111'));
  assert(!out.includes('99000001'));
  assert(!out.includes('aaaa-bbbb'));
  assert(!out.includes('06%2F07'));
  assert(out.includes('wpid=bacsidraw'));
  assert(out.includes('wpre=danhsachdieutrinoitrudraw'));
  assert(out.includes('nextlink=lichsuylenh'));
});

test('Mã BN thành nhãn BN#xxxxxx, cùng mã cùng nhãn', () => {
  const a = redactLogLine(SAMPLES[1]);
  const b = redactLogLine(SAMPLES[2]);
  assert(!a.includes('99000001') && !b.includes('99000001'));
  assert(a.includes(patientTag('99000001')) && b.includes(patientTag('99000001')));
  assert(redactLogLine(SAMPLES[3]).includes(`BN=${patientTag('99000002')}`));
  const c = redactLogLine(SAMPLES[6]);
  assert.strictEqual(c.split(patientTag('99000003')).length - 1, 2);
});

test('không che ngày, giờ, run id, phiên bản Chrome, uuid', () => {
  assert.strictEqual(redactLogLine(SAMPLES[4]), SAMPLES[4]);
  assert.strictEqual(redactLogLine(SAMPLES[5]), SAMPLES[5]);
  assert.strictEqual(redactLogLine(SAMPLES[7]), SAMPLES[7]);
});

test('nhận ra dòng stacktrace chromedriver', () => {
  for (const l of ['Stacktrace:', '  (Session info: chrome=153.0.8010.54)',
    '       chromedriver!GetHandleVerifier [0x7ff784f41035+5a95]',
    '       chromedriver!(No symbol) [0x7ff784e62c70]',
    '       KERNEL32!BaseThreadInitThunk [0x7ffef6e0cdf7+17]',
    '       ntdll!RtlUserThreadStart [0x7ffef7ddee4c+2c]']) {
    assert(isDriverStackNoise(l), l);
  }
  assert(!isDriverStackNoise('WARN [surgery] Không bấm được D/s Phẫu thuật'));
  assert(!isDriverStackNoise('Traceback (most recent call last):'));
});

test('bản Python cho cùng kết quả với cùng muối', () => {
  const py = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
  const code = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'worker'))})`,
    'from log_redact import redact_log_line',
    'lines = json.loads(sys.stdin.read())',
    'print(json.dumps([redact_log_line(l) for l in lines], ensure_ascii=False))',
  ].join('\n');
  const r = spawnSync(py, ['-X', 'utf8', '-c', code], {
    input: JSON.stringify(SAMPLES),
    env: { ...process.env, LOG_REDACT_SALT, PYTHONIOENCODING: 'utf-8' },
    encoding: 'utf-8',
  });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), SAMPLES.map(redactLogLine));
});

console.log(`\n${passed} test(s) passed.`);
