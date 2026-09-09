#!/usr/bin/env node
'use strict';

// Kiểm thử logic thuần cho tiền giám định BHYT (Tầng 1: tính toàn vẹn dữ liệu;
// Tầng 2: ngày giường). Không cần server/session. Chạy:
// node scripts/bhyt_pre_audit_test.js

const assert = require('assert');
const { runBhytPreAudit, ASSESSMENT } = require('../server/services/hchanh/bhyt_pre_audit');

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

function baseData(overrides = {}) {
  return {
    profile: {
      bhyt_code: 'HS12345678901',
      bhyt_tu_ngay: '01/01/2026',
      bhyt_den_ngay: '31/12/2026',
      ngay_vao_vien: '03/09/2026',
      ngay_ra_vien: '09/09/2026',
      ...overrides.profile,
    },
    discharge: {
      chan_doan_chinh: 'S72.0 Gãy cổ xương đùi',
      xu_tri: 'Xuất viện',
      ...overrides.discharge,
    },
    billing: overrides.billing !== undefined ? overrides.billing : {
      rows: [
        { name: 'Ngày giường ngoại 1', tg_ylenh: '04/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 500000 },
        { name: 'X-quang xương đùi', tg_ylenh: '08/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 200000 },
      ],
    },
    surgery: overrides.surgery !== undefined ? overrides.surgery : {
      surgeries: [{ ten: 'Thay khớp háng', thoi_gian: '05/09/2026 08:00' }],
    },
  };
}

console.log('bhyt_pre_audit_test');

test('1. Scope khác discharge -> không áp dụng', () => {
  const result = runBhytPreAudit({ meta: { scope_default: 'daily' }, data: baseData() });
  assert.strictEqual(result.applicable, false);
  assert.strictEqual(result.assessment, null);
});

test('2. Chưa có profile/discharge -> không đủ dữ liệu', () => {
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data: {} });
  assert.strictEqual(result.applicable, true);
  assert.strictEqual(result.assessment.code, ASSESSMENT.INSUFFICIENT_DATA.code);
});

test('3. Hồ sơ sạch -> an toàn', () => {
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data: baseData() });
  assert.strictEqual(result.assessment.code, ASSESSMENT.SAFE.code);
  assert.strictEqual(result.tier1_findings.length, 0);
});

test('4. Ra viện trước vào viện -> không nên nộp (BLOCK)', () => {
  const data = baseData({ profile: { ngay_vao_vien: '09/09/2026', ngay_ra_vien: '03/09/2026' } });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.strictEqual(result.assessment.code, ASSESSMENT.DO_NOT_SUBMIT.code);
  assert.ok(result.tier1_findings.some(f => f.rule_id === 'BHYT_T1_DISCHARGE_BEFORE_ADMISSION'));
});

test('5. Thẻ BHYT hết hạn trước ngày ra viện -> không nên nộp', () => {
  const data = baseData({ profile: { bhyt_den_ngay: '05/09/2026' } });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.strictEqual(result.assessment.code, ASSESSMENT.DO_NOT_SUBMIT.code);
  assert.ok(result.tier1_findings.some(f => f.rule_id === 'BHYT_T1_CARD_EXPIRED_BEFORE_DISCHARGE'));
});

test('6. Dòng bảng kê sau ngày ra viện -> không nên nộp, đúng số tiền BHYT liên quan', () => {
  const data = baseData({
    billing: { rows: [
      { name: 'Thuốc mang về', tg_ylenh: '12/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 300000 },
    ] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.strictEqual(result.assessment.code, ASSESSMENT.DO_NOT_SUBMIT.code);
  const f = result.tier1_findings.find(x => x.rule_id === 'BHYT_T1_SERVICE_DATE_AFTER_DISCHARGE');
  assert.ok(f);
  assert.strictEqual(f.amount_at_risk, 300000);
});

test('7. Thiếu chẩn đoán chính -> không nên nộp', () => {
  const data = baseData({ discharge: { chan_doan_chinh: '', xu_tri: 'Xuất viện' } });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.strictEqual(result.assessment.code, ASSESSMENT.DO_NOT_SUBMIT.code);
  assert.ok(result.tier1_findings.some(f => f.rule_id === 'BHYT_T1_PRIMARY_DIAGNOSIS_MISSING'));
});

test('8. Phẫu thuật không rõ ngày -> không nên nộp', () => {
  const data = baseData({ surgery: { surgeries: [{ ten: 'Thay khớp háng' }] } });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.strictEqual(result.assessment.code, ASSESSMENT.DO_NOT_SUBMIT.code);
  assert.ok(result.tier1_findings.some(f => f.rule_id === 'BHYT_T1_SURGERY_DATE_MISSING'));
});

test('9. Mức hưởng BHYT không đồng nhất -> cần kiểm tra (REVIEW), không BLOCK', () => {
  const data = baseData({
    billing: { rows: [
      { name: 'Ngày giường', tg_ylenh: '04/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 500000 },
      { name: 'X-quang', tg_ylenh: '05/09/2026', payment_group: 'bhyt', muc_huong: '100%', thanh_tien: 200000 },
    ] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.strictEqual(result.assessment.code, ASSESSMENT.NEEDS_REVIEW.code);
  assert.ok(result.tier1_findings.some(f => f.rule_id === 'BHYT_T1_BENEFIT_LEVEL_INCONSISTENT'));
});

test('10. Thiếu mã thẻ BHYT (không tự túc) -> cần kiểm tra', () => {
  const data = baseData({ profile: { bhyt_code: '', bhyt_tu_ngay: '', bhyt_den_ngay: '' } });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.strictEqual(result.assessment.code, ASSESSMENT.NEEDS_REVIEW.code);
  assert.ok(result.tier1_findings.some(f => f.rule_id === 'BHYT_T1_BHYT_CODE_MISSING'));
});

test('11. Tự túc viện phí -> không kiểm thẻ BHYT', () => {
  const data = baseData({ profile: { bhyt_code: '', tu_tuc: true } });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.strictEqual(result.assessment.code, ASSESSMENT.SAFE.code);
});

// ── Tầng 2: ngày giường ──────────────────────────────────────────────────────

test('12. Nằm dưới 4 giờ nhưng vẫn tính ngày giường -> nguy cơ cao', () => {
  const data = baseData({
    profile: { ngay_vao_vien: '08:00 09/09/2026', ngay_ra_vien: '10:30 09/09/2026' },
    discharge: { chan_doan_chinh: 'S72.0 Gãy cổ xương đùi', xu_tri: 'Xuất viện' },
    billing: null,
    surgery: null,
  });
  const result = runBhytPreAudit({
    meta: { scope_default: 'discharge' },
    data: { ...data, bed_days: { so_ngay_tinh: 1 } },
  });
  assert.strictEqual(result.assessment.code, ASSESSMENT.HIGH_RISK.code);
  assert.ok(result.tier2_findings.some(f => f.rule_id === 'BHYT_T2_SHORT_STAY_BED_CHARGED'));
});

test('13. Nằm dưới 4 giờ nhưng KHÔNG tính ngày giường -> không cảnh báo', () => {
  const data = baseData({
    profile: { ngay_vao_vien: '08:00 09/09/2026', ngay_ra_vien: '10:30 09/09/2026' },
    billing: null,
    surgery: null,
  });
  const result = runBhytPreAudit({
    meta: { scope_default: 'discharge' },
    data: { ...data, bed_days: { so_ngay_tinh: 0 } },
  });
  assert.ok(!result.tier2_findings.some(f => f.rule_id === 'BHYT_T2_SHORT_STAY_BED_CHARGED'));
});

test('14. Ngày giường tính thừa so với thời gian điều trị (bedDaysReview mismatch) -> nguy cơ cao', () => {
  const data = baseData();
  const bedDaysReview = { status: 'mismatch', expected_total: 6, actual_total: 7, amount: { diff: 350000 }, suggestions: ['Tổng ngày giường dự kiến 6, hiện đang tính 7.'] };
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data, bedDaysReview });
  assert.strictEqual(result.assessment.code, ASSESSMENT.HIGH_RISK.code);
  const f = result.tier2_findings.find(x => x.rule_id === 'BHYT_T2_BED_DAYS_OVER_EXPECTED');
  assert.ok(f);
  assert.strictEqual(f.amount_at_risk, 350000);
});

test('15. Ngày giường tính THIẾU so với dự kiến -> không phải nguy cơ BHYT, bỏ qua', () => {
  const data = baseData();
  const bedDaysReview = { status: 'mismatch', expected_total: 7, actual_total: 6, amount: { diff: -350000 }, suggestions: [] };
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data, bedDaysReview });
  assert.ok(!result.tier2_findings.some(f => f.rule_id === 'BHYT_T2_BED_DAYS_OVER_EXPECTED'));
  assert.strictEqual(result.assessment.code, ASSESSMENT.SAFE.code);
});

test('16. Ngoại lệ 4-24 giờ (kỳ vọng 0 ngày, tính 1 ngày) -> không báo tính thừa', () => {
  const data = baseData({
    profile: { ngay_vao_vien: '20:00 09/09/2026', ngay_ra_vien: '08:00 10/09/2026' },
    surgery: null,
  });
  const bedDaysReview = { status: 'mismatch', expected_total: 0, actual_total: 1, amount: { diff: 500000 }, suggestions: [] };
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data, bedDaysReview });
  assert.ok(!result.tier2_findings.some(f => f.rule_id === 'BHYT_T2_BED_DAYS_OVER_EXPECTED'));
});

console.log(`\n${passed} test(s) passed.`);
if (process.exitCode) console.error('\nCó test thất bại.');
