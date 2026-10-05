#!/usr/bin/env node
'use strict';

// Bảng "Đánh giá dữ liệu" (Đủ / Chính xác): snapshot tiến độ kèm tóm tắt kiểm tra độ chính xác
// (qa_report.json + encounter_review.csv), báo cũ khi lấy thêm dữ liệu sau lần kiểm tra, và
// danh sách lượt đưa lượt LỖI lên đầu (trước đây lượt đang chạy chiếm đầu danh sách 500 dòng).
// Chạy: node scripts/research_data_health_snapshot_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.EMR_RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'data_health_'));
const ps = require('../server/research/progress_snapshot');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); } catch (err) { console.error(`  FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}

const runDir = path.join(process.env.EMR_RUNTIME_ROOT, 'run1');
fs.mkdirSync(runDir, { recursive: true });
const snap = () => ps.buildResearchProgressSnapshot(runDir, { id: 'archive' }, { isArchive: true });

test('chưa chuẩn hóa: qa = null (giao diện báo "Chưa kiểm tra")', () => {
  assert.strictEqual(snap().qa, null);
});

test('có báo cáo kiểm tra: đếm theo loại vấn đề, giữ lỗi chặn, kèm mẫu danh sách', () => {
  const checkedAt = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(path.join(runDir, 'qa_report.json'), JSON.stringify({
    status: 'warnings', generated_at: checkedAt,
    blocking: [], warnings: [{ code: 'possible_same_stay', message: '2 cặp đợt…', count: 2 }],
    review_count: 3,
  }));
  fs.writeFileSync(path.join(runDir, 'encounter_review.csv'), [
    'encounter_id,research_code,patient_code,issue,detail,related_encounter_id,source_status',
    'E1,NC1,26000001,possible_same_stay,Có thể cùng đợt với NC2,E2,',
    'E2,NC2,26000001,possible_same_stay,Có thể cùng đợt với NC1,E1,',
    'E3,NC3,26000002,discharge_before_admission,Ngày ra viện trước ngày vào viện.,,',
  ].join('\n'));
  const qa = snap().qa;
  assert.strictEqual(qa.review_count, 3);
  assert.deepStrictEqual(qa.review_by_issue, { possible_same_stay: 2, discharge_before_admission: 1 });
  assert.strictEqual(qa.review[2].research_code, 'NC3');
  assert.strictEqual(qa.warnings[0].code, 'possible_same_stay');
  assert.strictEqual(qa.stale, false);
});

test('lấy thêm dữ liệu sau lần kiểm tra: qa.stale = true (nhắc chuẩn hóa lại)', () => {
  fs.writeFileSync(path.join(runDir, 'progress.json'), JSON.stringify({}));
  assert.strictEqual(snap().qa.stale, true);
});

test('danh sách lượt: lượt lỗi lên đầu, lượt đang chạy sau lượt còn thiếu', () => {
  fs.writeFileSync(path.join(runDir, 'extract_status.csv'), [
    'research_code,patient_code,patient_name,profile_status,discharge_status,surgery_status,order_history_status,xn_status,cdha_status,popup_status,last_error',
    'NC1,26000001,A,running,,,,,,,',
    'NC2,26000002,B,,,,,,,,',
    'NC3,26000003,C,error,,,,,,,Không mở được hồ sơ',
  ].join('\n'));
  const order = snap().rows.map(r => r.research_code);
  assert.deepStrictEqual(order, ['NC3', 'NC2', 'NC1']);
});

test('đang thu thập: trạng thái MỚI trong file tiến độ thắng trạng thái cũ của lần chuẩn hóa trước', () => {
  // Người dùng: "bộ đếm dữ liệu sao không cập nhật gì hết". extract_status.csv (lần chuẩn hóa
  // trước) ghi profile=error; thu thập vừa lấy lại xong (done) nhưng bộ đếm vẫn đếm lỗi vì chỉ
  // dùng tiến độ mới khi ô cũ để trống.
  const dir = path.join(process.env.EMR_RUNTIME_ROOT, 'run_live');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'extract_status.csv'), [
    'research_code,patient_code,patient_name,profile_status,discharge_status,surgery_status,order_history_status,xn_status,cdha_status,popup_status,last_error',
    'NC1,26000001,A,error,error,error,partial,done,done,done,',
    'NC2,26000001,A,done,done,done,done,done,done,done,',
  ].join('\n'));
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'hchanh_auto_progress.json'), JSON.stringify({
    k1: { research_code: 'NC1', ma_bn: '26000001', files: ['profile', 'discharge', 'surgery'], status: 'done', updated_at: now },
  }));
  fs.writeFileSync(path.join(dir, 'order_history_auto_progress.json'), JSON.stringify({
    k1: { research_code: 'NC1', ma_bn: '26000001', files: ['order_history'], status: 'done', updated_at: now },
    // Lượt KHÁC của cùng người bệnh đang lỗi: không được đè sang NC2.
    k2: { research_code: 'NC9', ma_bn: '26000001', files: ['order_history'], status: 'error', updated_at: now },
  }));
  const s = ps.buildResearchProgressSnapshot(dir, { id: 'archive' }, { isArchive: true });
  const byCode = Object.fromEntries(s.rows.map(r => [r.research_code, r]));
  assert.strictEqual(byCode.NC1.state, 'done', JSON.stringify(byCode.NC1));
  assert.strictEqual(byCode.NC2.state, 'done', JSON.stringify(byCode.NC2));
  assert.strictEqual(s.counts.done, 2);
});

console.log(`\n${passed} test(s) passed.`);
