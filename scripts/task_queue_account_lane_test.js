#!/usr/bin/env node
'use strict';

// Kiểm thử task_queue.js: hai tác vụ nặng dùng CHUNG accountKey (cùng tài
// khoản đăng nhập EMR) không bao giờ chạy chồng lấn, còn accountKey khác
// nhau (vd 'default' và 'infusion') thì chạy song song thật sự.
// Xem docs/PARALLEL_CARE_INFUSION.md.
// Chạy: node scripts/task_queue_account_lane_test.js

process.env.MAX_HEAVY_JOBS = '4';

const assert = require('assert');
const { enqueueHeavy } = require('../server/services/task_queue');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function job(label, ms, log) {
  return async () => {
    log.push(`${label}:start`);
    await delay(ms);
    log.push(`${label}:end`);
    return label;
  };
}

async function main() {
  console.log('task_queue_account_lane_test');

  await test('Hai tác vụ cùng accountKey chạy tuần tự, không chồng lấn', async () => {
    const log = [];
    const p1 = enqueueHeavy('sid-same-A', job('J1', 40, log), { accountKey: 'main' });
    const p2 = enqueueHeavy('sid-same-B', job('J2', 10, log), { accountKey: 'main' });
    await Promise.all([p1, p2]);
    assert.deepStrictEqual(log, ['J1:start', 'J1:end', 'J2:start', 'J2:end']);
  });

  await test('Hai tác vụ accountKey khác nhau chạy song song thật sự', async () => {
    const log = [];
    const start = Date.now();
    const p1 = enqueueHeavy('sid-diff-A', job('K1', 70, log), { accountKey: 'infusion' });
    const p2 = enqueueHeavy('sid-diff-B', job('K2', 70, log), { accountKey: 'main' });
    await Promise.all([p1, p2]);
    const elapsed = Date.now() - start;
    // Nếu chạy tuần tự sẽ mất ~140ms; chạy song song chỉ ~70ms. Cho biên độ rộng để tránh CI flaky.
    assert.ok(elapsed < 130, `Kỳ vọng chạy song song (<130ms), thực tế ${elapsed}ms`);
    assert.ok(log.includes('K1:start') && log.includes('K2:start'));
  });

  await test('Không truyền accountKey -> mặc định dùng chung lane "default", vẫn tuần tự với nhau', async () => {
    const log = [];
    const p1 = enqueueHeavy('sid-default-A', job('L1', 30, log));
    const p2 = enqueueHeavy('sid-default-B', job('L2', 10, log));
    await Promise.all([p1, p2]);
    assert.deepStrictEqual(log, ['L1:start', 'L1:end', 'L2:start', 'L2:end']);
  });

  await test('Một tác vụ lỗi không làm kẹt lane của accountKey đó cho tác vụ sau', async () => {
    const log = [];
    const failing = enqueueHeavy('sid-err-A', async () => {
      log.push('E1:start');
      await delay(5);
      log.push('E1:end');
      throw new Error('lỗi giả lập');
    }, { accountKey: 'main' });
    await assert.rejects(failing);
    const p2 = enqueueHeavy('sid-err-B', job('E2', 5, log), { accountKey: 'main' });
    await p2;
    assert.deepStrictEqual(log, ['E1:start', 'E1:end', 'E2:start', 'E2:end']);
  });

  console.log(`\n${passed} kịch bản pass.`);
  if (process.exitCode) {
    console.error('CÓ KỊCH BẢN FAIL.');
    process.exit(1);
  }
}

main();
