#!/usr/bin/env node
'use strict';

// Kiểm thử task_queue.js: hai tác vụ nặng dùng CHUNG accountKey (cùng tài
// khoản đăng nhập EMR) không bao giờ chạy chồng lấn, còn accountKey khác
// nhau (vd 'default' và 'infusion') thì chạy song song thật sự.
// Xem docs/PARALLEL_CARE_INFUSION.md.
// Chạy: node scripts/task_queue_account_lane_test.js

process.env.MAX_HEAVY_JOBS = '4';

const assert = require('assert');
const { enqueueHeavy, enqueueLocal, registerCancel } = require('../server/services/task_queue');

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
    const p1 = enqueueHeavy('sid-diff-A', job('K1', 70, log), { accountKey: 'infusion' });
    const p2 = enqueueHeavy('sid-diff-B', job('K2', 70, log), { accountKey: 'main' });
    await Promise.all([p1, p2]);
    // Kiểm tra chồng lấn theo thứ tự sự kiện thay vì đo thời gian (máy CI chậm làm số ms dao động):
    // chạy song song thì cả hai đã bắt đầu trước khi bất kỳ tác vụ nào kết thúc; chạy tuần tự
    // thì K2:start luôn nằm sau K1:end.
    const firstEnd = Math.min(log.indexOf('K1:end'), log.indexOf('K2:end'));
    assert.ok(log.indexOf('K1:start') !== -1 && log.indexOf('K2:start') !== -1, `Thiếu sự kiện bắt đầu: ${log.join(', ')}`);
    assert.ok(log.indexOf('K1:start') < firstEnd && log.indexOf('K2:start') < firstEnd,
      `Kỳ vọng hai tác vụ chạy chồng lên nhau, thực tế: ${log.join(', ')}`);
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

  // Ảnh chụp người dùng 05/10/2026: đang thu thập Kho nghiên cứu (hàng giờ, mở EMR) thì bấm
  // "Thêm chữ ký" (chỉ chèn ảnh vào PDF trên máy) quay mãi — vì cùng hàng đợi phiên + lane EMR.
  await test('Tác vụ chạy trên máy (không mở EMR) không chờ tác vụ EMR dài cùng phiên', async () => {
    const log = [];
    const long = enqueueHeavy('sid-local', job('EMR', 120, log));
    await delay(10);
    await enqueueLocal('sid-local', job('KY', 5, log), { taskType: 'sign_discharge_bundle' });
    assert.deepStrictEqual(log.slice(0, 3), ['EMR:start', 'KY:start', 'KY:end'],
      `Ký phải xong khi tác vụ EMR còn chạy, thực tế: ${log.join(', ')}`);
    await long;
  });

  await test('Tác vụ trên máy không giành nút Dừng của tác vụ EMR đang chạy', async () => {
    const killed = [];
    // Tác vụ EMR chỉ kết thúc khi bị Dừng (không dùng hẹn giờ cố định: máy CI chậm có thể để nó
    // xong trước khi bấm Dừng, làm test đỏ dù hàng đợi đúng).
    let release;
    const stopped = new Promise(resolve => { release = resolve; });
    const long = enqueueHeavy('sid-cancel', async () => {
      registerCancel('sid-cancel', () => { killed.push('EMR'); release(); });
      await Promise.race([stopped, delay(5000)]);
    });
    await delay(10);
    await enqueueLocal('sid-cancel', async () => { await delay(5); });
    const { cancelSession } = require('../server/services/task_queue');
    assert.strictEqual(cancelSession('sid-cancel'), true);
    assert.deepStrictEqual(killed, ['EMR']);
    await long.catch(() => {});
  });

  console.log(`\n${passed} kịch bản pass.`);
  if (process.exitCode) {
    console.error('CÓ KỊCH BẢN FAIL.');
    process.exit(1);
  }
}

main();
