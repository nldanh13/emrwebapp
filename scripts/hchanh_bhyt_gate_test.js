#!/usr/bin/env node
'use strict';

// Kiểm thử cổng đạt/không đạt gộp QA hành chánh + BHYT: hồ sơ chỉ "Đủ hoàn
// tất" khi CẢ HAI đều sạch — một cổng duy nhất, không phải hai mức độ tách
// rời để người kiểm tự đối chiếu. Không cần server/session.
// Chạy: node scripts/hchanh_bhyt_gate_test.js

const assert = require('assert');
const { buildQaGate } = require('../server/services/hchanh/discharge_qa');
const { computeWorkflowStatus, statusLabelFor } = require('../server/services/hchanh/dashboard');
const { ASSESSMENT } = require('../server/services/hchanh/bhyt_pre_audit');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

console.log('hchanh_bhyt_gate_test');

// ── buildQaGate (discharge_qa.js) ────────────────────────────────────────────

test('1. QA hành chánh sạch + BHYT an toàn -> canPrint true', () => {
  const bhyt = { applicable: true, assessment: { ...ASSESSMENT.SAFE } };
  const { canPrint, summary } = buildQaGate({ status: 'ok', errors: 0, warnings: 0, bhyt });
  assert.strictEqual(canPrint, true);
  assert.strictEqual(summary, 'Đủ điều kiện in/chốt hồ sơ.');
});

test('2. QA hành chánh sạch nhưng BHYT cần kiểm tra -> canPrint false, nêu rõ lý do BHYT', () => {
  const bhyt = { applicable: true, assessment: { ...ASSESSMENT.NEEDS_REVIEW } };
  const { canPrint, summary } = buildQaGate({ status: 'ok', errors: 0, warnings: 0, bhyt });
  assert.strictEqual(canPrint, false);
  assert.ok(summary.includes('BHYT'));
  assert.ok(summary.includes(ASSESSMENT.NEEDS_REVIEW.label));
});

test('3. QA hành chánh có lỗi, BHYT an toàn -> canPrint false, nêu lỗi hành chánh (không đổi hành vi cũ)', () => {
  const bhyt = { applicable: true, assessment: { ...ASSESSMENT.SAFE } };
  const { canPrint, summary } = buildQaGate({ status: 'error', errors: 2, warnings: 1, bhyt });
  assert.strictEqual(canPrint, false);
  assert.strictEqual(summary, 'Còn 2 lỗi và 1 cảnh báo cần xử lý.');
});

test('4. QA hành chánh có lỗi VÀ BHYT nguy cơ cao -> canPrint false, ưu tiên nêu lỗi hành chánh trước', () => {
  const bhyt = { applicable: true, assessment: { ...ASSESSMENT.HIGH_RISK } };
  const { canPrint, summary } = buildQaGate({ status: 'error', errors: 1, warnings: 0, bhyt });
  assert.strictEqual(canPrint, false);
  assert.ok(summary.includes('lỗi'));
});

test('5. Scope không phải discharge (BHYT không áp dụng) -> chỉ phụ thuộc QA hành chánh, không suy đoán BHYT', () => {
  const bhyt = { applicable: false, assessment: null };
  const clean = buildQaGate({ status: 'ok', errors: 0, warnings: 0, bhyt });
  assert.strictEqual(clean.canPrint, true);
  const dirty = buildQaGate({ status: 'warn', errors: 0, warnings: 1, bhyt });
  assert.strictEqual(dirty.canPrint, false);
});

test('6. BHYT không đủ dữ liệu -> cũng chặn canPrint (chưa xác minh được thì chưa tính là đạt)', () => {
  const bhyt = { applicable: true, assessment: { ...ASSESSMENT.INSUFFICIENT_DATA } };
  const { canPrint } = buildQaGate({ status: 'ok', errors: 0, warnings: 0, bhyt });
  assert.strictEqual(canPrint, false);
});

// ── computeWorkflowStatus / statusLabelFor (dashboard.js) ────────────────────

test('7. Dữ liệu đủ, không lỗi hành chánh, nhưng BHYT chặn -> workflowStatus amber, nhãn "Cần kiểm BHYT"', () => {
  const status = computeWorkflowStatus({
    fetchErrorActive: false, issueCounts: { errors: 0, warnings: 0 },
    dataState: 'complete', dataComplete: true, fileAttentionCount: 0, bhytBlocking: true,
  });
  assert.strictEqual(status, 'amber');
  const label = statusLabelFor({
    workflowStatus: status, issueCounts: { errors: 0, warnings: 0 },
    dataState: 'complete', missingCount: 0, fileAttentionCount: 0, bhytBlocking: true,
  });
  assert.strictEqual(label, 'Cần kiểm BHYT');
});

test('8. Dữ liệu đủ, không lỗi hành chánh, BHYT không chặn -> workflowStatus green (hành vi cũ giữ nguyên)', () => {
  const status = computeWorkflowStatus({
    fetchErrorActive: false, issueCounts: { errors: 0, warnings: 0 },
    dataState: 'complete', dataComplete: true, fileAttentionCount: 0, bhytBlocking: false,
  });
  assert.strictEqual(status, 'green');
});

test('9. Lỗi hành chánh vẫn ưu tiên hiển thị số lượng lỗi, không bị nhãn BHYT che mất', () => {
  const label = statusLabelFor({
    workflowStatus: 'amber', issueCounts: { errors: 1, warnings: 0 },
    dataState: 'complete', missingCount: 0, fileAttentionCount: 0, bhytBlocking: true,
  });
  assert.strictEqual(label, 'Cần xử lý 1');
});

console.log(`\n${passed} test(s) passed.`);
if (process.exitCode) console.error('\nCó test thất bại.');
