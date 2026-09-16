#!/usr/bin/env node
'use strict';

// Kiểm thử logic thuần cho tiền giám định BHYT (Tầng 1-5). Không cần
// server/session. Chạy: node scripts/bhyt_pre_audit_test.js

const assert = require('assert');
const { runBhytPreAudit, ASSESSMENT, BHYT_SEVERITY } = require('../server/services/hchanh/bhyt_pre_audit');

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
      chan_doan_chinh_icd: 'S72.0',
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

test('8b. Phẫu thuật có giờ kết thúc trước giờ bắt đầu -> không nên nộp (xung đột thời gian)', () => {
  const data = baseData({
    surgery: { surgeries: [{
      ten: 'Thay khớp háng', thoi_gian: '05/09/2026 08:00',
      bat_dau: '10:00 05/09/2026', ket_thuc: '08:30 05/09/2026',
    }] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.strictEqual(result.assessment.code, ASSESSMENT.DO_NOT_SUBMIT.code);
  assert.ok(result.tier1_findings.some(f => f.rule_id === 'BHYT_T1_SURGERY_TIME_SEQUENCE_INVALID'));
});

test('8c. Phẫu thuật có giờ bắt đầu/kết thúc hợp lệ -> không cảnh báo', () => {
  const data = baseData({
    surgery: { surgeries: [{
      ten: 'Thay khớp háng', thoi_gian: '05/09/2026 08:00',
      bat_dau: '08:00 05/09/2026', ket_thuc: '10:30 05/09/2026',
    }] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.ok(!result.tier1_findings.some(f => f.rule_id === 'BHYT_T1_SURGERY_TIME_SEQUENCE_INVALID'));
});

test('8d. Phẫu thuật thiếu giờ bắt đầu hoặc kết thúc -> không suy đoán, không cảnh báo', () => {
  const data = baseData({
    surgery: { surgeries: [{ ten: 'Thay khớp háng', thoi_gian: '05/09/2026 08:00', bat_dau: '08:00 05/09/2026' }] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.ok(!result.tier1_findings.some(f => f.rule_id === 'BHYT_T1_SURGERY_TIME_SEQUENCE_INVALID'));
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

// ── Tầng 3: chẩn đoán ↔ PT/TT ────────────────────────────────────────────────

test('17. Thay khớp háng + ICD phù hợp (S72.0) -> không cảnh báo, an toàn', () => {
  const data = baseData(); // mặc định: chan_doan_chinh_icd=S72.0, PT="Thay khớp háng"
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.strictEqual(result.assessment.code, ASSESSMENT.SAFE.code);
  assert.strictEqual(result.tier3_findings.length, 0);
});

test('18. Thay khớp háng + ICD không liên quan (S42) -> nguy cơ cao', () => {
  const data = baseData({ discharge: { chan_doan_chinh_icd: 'S42.1' } });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.strictEqual(result.assessment.code, ASSESSMENT.HIGH_RISK.code);
  assert.ok(result.tier3_findings.some(f => f.rule_id === 'BHYT_T3_DX_PROCEDURE_INCOMPATIBLE'));
});

test('19. Thay khớp háng + ICD chưa rõ nhóm -> cần kiểm tra (REVIEW)', () => {
  const data = baseData({ discharge: { chan_doan_chinh_icd: 'S00.1' } });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.strictEqual(result.assessment.code, ASSESSMENT.NEEDS_REVIEW.code);
  assert.ok(result.tier3_findings.some(f => f.rule_id === 'BHYT_T3_DX_PROCEDURE_NEEDS_REVIEW'));
});

test('20. Chưa tách được ICD chẩn đoán chính -> không đánh giá Tầng 3 (không suy đoán)', () => {
  const data = baseData({ discharge: { chan_doan_chinh_icd: '' } });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.strictEqual(result.tier3_findings.length, 0);
});

test('21. Tháo PTKHX, chẩn đoán "gãy xương" chung chung, không có XQ trong bảng kê -> nguy cơ cao', () => {
  const data = baseData({
    discharge: { chan_doan_chinh_icd: 'S82.3', chan_doan_chinh: 'Gãy xương chày' },
    surgery: { surgeries: [{ ten: 'Tháo PTKHX xương chày', thoi_gian: '05/09/2026 08:00' }] },
    billing: { rows: [
      { name: 'Ngày giường ngoại 1', tg_ylenh: '04/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 500000 },
    ] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.strictEqual(result.assessment.code, ASSESSMENT.HIGH_RISK.code);
  assert.ok(result.tier3_findings.some(f => f.rule_id === 'BHYT_T3_IMPLANT_REMOVAL_NEEDS_EVIDENCE'));
});

test('22. Tháo PTKHX + chẩn đoán Z47.0 (liền xương) -> không cảnh báo', () => {
  const data = baseData({
    discharge: { chan_doan_chinh_icd: 'Z47.0', chan_doan_chinh: 'Theo dõi sau PT kết hợp xương' },
    surgery: { surgeries: [{ ten: 'Tháo PTKHX xương chày', thoi_gian: '05/09/2026 08:00' }] },
    billing: { rows: [
      { name: 'Ngày giường ngoại 1', tg_ylenh: '04/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 500000 },
    ] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.ok(!result.tier3_findings.some(f => f.rule_id === 'BHYT_T3_IMPLANT_REMOVAL_NEEDS_EVIDENCE'));
});

test('23. Tháo PTKHX + có X-quang trong bảng kê -> không cảnh báo (đủ bằng chứng)', () => {
  const data = baseData({
    discharge: { chan_doan_chinh_icd: 'S82.3', chan_doan_chinh: 'Gãy xương chày' },
    surgery: { surgeries: [{ ten: 'Tháo PTKHX xương chày', thoi_gian: '05/09/2026 08:00' }] },
    billing: { rows: [
      { name: 'X-quang xương chày kiểm tra liền xương', tg_ylenh: '04/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 150000 },
    ] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.ok(!result.tier3_findings.some(f => f.rule_id === 'BHYT_T3_IMPLANT_REMOVAL_NEEDS_EVIDENCE'));
});

test('23b. Mã bệnh chính là mã nhóm PLII 3 ký tự (A15) -> cần kiểm tra (thông tuyến 1.16)', () => {
  const data = baseData({ discharge: { chan_doan_chinh_icd: 'A15' } });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  const f = result.tier3_findings.find(x => x.rule_id === 'BHYT_T3_ICD_PL2_GROUP_CODE_TOO_GENERIC');
  assert.ok(f);
  assert.strictEqual(f.severity, BHYT_SEVERITY.REVIEW);
  assert.ok(f.title.includes('A15'));
});

test('23c. Mã bệnh chính là mã cụ thể 4 ký tự thuộc PLII (A15.0) -> không cảnh báo', () => {
  const data = baseData({ discharge: { chan_doan_chinh_icd: 'A15.0' } });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.ok(!result.tier3_findings.some(f => f.rule_id === 'BHYT_T3_ICD_PL2_GROUP_CODE_TOO_GENERIC'));
});

test('23d. Mã bệnh chính 3 ký tự nhưng KHÔNG thuộc PLII (M47) -> ngoài phạm vi, không cảnh báo', () => {
  const data = baseData({ discharge: { chan_doan_chinh_icd: 'M47' } });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.ok(!result.tier3_findings.some(f => f.rule_id === 'BHYT_T3_ICD_PL2_GROUP_CODE_TOO_GENERIC'));
});

test('23e. Chưa tách được mã ICD chẩn đoán chính -> không suy đoán, không cảnh báo', () => {
  const data = baseData({ discharge: { chan_doan_chinh_icd: '' } });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.ok(!result.tier3_findings.some(f => f.rule_id === 'BHYT_T3_ICD_PL2_GROUP_CODE_TOO_GENERIC'));
});

// ── Tầng 4: CLS chứng minh chỉ định ──────────────────────────────────────────
// Tái dùng specialty_rules đã cấu hình sẵn trong config/hchanh/qa_rules.json.

test('24. CTCH, gãy xương, không có X-quang trong bảng kê -> cần kiểm tra', () => {
  const data = baseData({
    profile: { khoa: 'Khoa Chấn thương chỉnh hình' },
    discharge: { chan_doan_chinh: 'Gãy xương chày' },
    surgery: null,
    billing: null,
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.strictEqual(result.assessment.code, ASSESSMENT.NEEDS_REVIEW.code);
  assert.ok(result.tier4_findings.some(f => f.rule_id === 'BHYT_T4_CTCH_FRACTURE_NO_XRAY'));
});

test('25. CTCH, gãy xương, CÓ X-quang trong bảng kê -> không cảnh báo', () => {
  const data = baseData({
    profile: { khoa: 'Khoa Chấn thương chỉnh hình' },
    discharge: { chan_doan_chinh: 'Gãy xương chày' },
    surgery: null,
    billing: { rows: [
      { name: 'X-quang xương chày', loai_yc: 'Chẩn đoán hình ảnh', tg_ylenh: '04/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 150000 },
    ] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.ok(!result.tier4_findings.some(f => f.rule_id === 'BHYT_T4_CTCH_FRACTURE_NO_XRAY'));
});

test('26. Ngoại tổng quát, phẫu thuật, không có biên bản PT trong bảng kê -> cần kiểm tra', () => {
  const data = baseData({
    profile: { khoa: 'Khoa Ngoại tổng quát' },
    discharge: { chan_doan_chinh: 'Phẫu thuật cắt ruột thừa viêm' },
    surgery: null,
    billing: null,
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.ok(result.tier4_findings.some(f => f.rule_id === 'BHYT_T4_GS_SURGERY_NO_OP_NOTE'));
});

test('27. CTCH đặt nẹp vít: thiếu biên bản PT (Tầng 4) nhưng KHÔNG lẫn rule VTYT (Tầng 5)', () => {
  const data = baseData({
    profile: { khoa: 'Khoa Chấn thương chỉnh hình' },
    discharge: { chan_doan_chinh: 'Đặt nẹp vít kết hợp xương cẳng chân' },
    surgery: null,
    billing: null,
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.ok(result.tier4_findings.some(f => f.rule_id === 'BHYT_T4_CTCH_SURGERY_NO_OP_NOTE'));
  assert.ok(!result.tier4_findings.some(f => f.rule_id === 'BHYT_T4_CTCH_IMPLANT_NO_SUPPLY'));
});

// ── Tầng 5: VTYT (placeholder trung thực) ────────────────────────────────────

test('28. Có dòng VTYT thanh toán BHYT khớp danh mục nội bộ -> khoanh vùng cần kiểm, không tự đúng/sai', () => {
  const data = baseData({
    surgery: null,
    billing: { rows: [
      { name: 'Găng tay khám Latex có bột hiệu I-Med', tg_ylenh: '04/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 40000 },
    ] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  const f = result.tier5_findings.find(x => x.rule_id === 'BHYT_T5_VTYT_UNVERIFIABLE');
  assert.ok(f);
  assert.strictEqual(f.severity, BHYT_SEVERITY.INFO);
  assert.strictEqual(f.amount_at_risk, 40000);
  // INFO không kéo trạng thái tổng xuống mức cảnh báo khi không có finding nặng hơn.
  assert.strictEqual(result.assessment.code, ASSESSMENT.SAFE.code);
});

test('29. Không có dòng VTYT nào trong bảng kê -> Tầng 5 im lặng', () => {
  const data = baseData({
    surgery: null,
    billing: { rows: [
      { name: 'Khám nội khoa', tg_ylenh: '04/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 50000 },
    ] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.strictEqual(result.tier5_findings.length, 0);
});

test('30. VTYT nhưng người bệnh tự trả (không phải BHYT) -> không thuộc phạm vi Tầng 5', () => {
  const data = baseData({
    surgery: null,
    billing: { rows: [
      { name: 'Găng tay khám Latex có bột hiệu I-Med', tg_ylenh: '04/09/2026', payment_group: 'self_pay', muc_huong: '', thanh_tien: 40000 },
    ] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.strictEqual(result.tier5_findings.length, 0);
});

// ── Tầng 7: Trùng dịch vụ (phạm vi thu hẹp: chỉ cùng ngày, 2 chỉ định) ────────

test('31. Cùng dịch vụ BHYT xuất hiện 2 lần cùng ngày (mã khác dòng) -> cần kiểm tra', () => {
  const data = baseData({
    surgery: null,
    billing: { rows: [
      { name: 'X-quang khung chậu', ma_dv: 'XQ001', loai_yc: 'Chẩn đoán hình ảnh', tg_ylenh: '08:00 04/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 150000 },
      { name: 'X-quang khung chậu', ma_dv: 'XQ001', loai_yc: 'Chẩn đoán hình ảnh', tg_ylenh: '14:00 04/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 150000 },
    ] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.strictEqual(result.assessment.code, ASSESSMENT.NEEDS_REVIEW.code);
  const f = result.tier7_findings.find(x => x.rule_id === 'BHYT_T7_DUPLICATE_SERVICE_SAME_DAY');
  assert.ok(f);
  assert.strictEqual(f.amount_at_risk, 150000); // chỉ tính dòng "thêm", không cộng cả 2
});

test('32. Cùng dịch vụ nhưng KHÁC ngày -> không cảnh báo', () => {
  const data = baseData({
    surgery: null,
    billing: { rows: [
      { name: 'X-quang khung chậu', ma_dv: 'XQ001', tg_ylenh: '08:00 04/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 150000 },
      { name: 'X-quang khung chậu', ma_dv: 'XQ001', tg_ylenh: '08:00 06/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 150000 },
    ] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.strictEqual(result.tier7_findings.length, 0);
});

test('33. Cùng dịch vụ, cùng ngày, nhưng 1 BHYT 1 tự trả -> không đủ 2 dòng BHYT để cảnh báo', () => {
  const data = baseData({
    surgery: null,
    billing: { rows: [
      { name: 'X-quang khung chậu', ma_dv: 'XQ001', tg_ylenh: '08:00 04/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 150000 },
      { name: 'X-quang khung chậu', ma_dv: 'XQ001', tg_ylenh: '14:00 04/09/2026', payment_group: 'self_pay', thanh_tien: 150000 },
    ] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.strictEqual(result.tier7_findings.length, 0);
});

test('34. Nhiều dòng ngày giường cùng ngày -> không tính là trùng dịch vụ (đã có Tầng 2 lo)', () => {
  const data = baseData({
    surgery: null,
    billing: { rows: [
      { name: 'Ngày giường ngoại 1', loai_yc: 'Ngày giường', tg_ylenh: '08:00 04/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 200000 },
      { name: 'Ngày giường ngoại 1', loai_yc: 'Ngày giường', tg_ylenh: '08:00 04/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 200000 },
    ] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.strictEqual(result.tier7_findings.length, 0);
});

test('35. Hai dịch vụ khác nhau cùng ngày -> không cảnh báo', () => {
  const data = baseData({
    surgery: null,
    billing: { rows: [
      { name: 'X-quang khung chậu', ma_dv: 'XQ001', tg_ylenh: '08:00 04/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 150000 },
      { name: 'Siêu âm bụng tổng quát', ma_dv: 'SA002', tg_ylenh: '09:00 04/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 100000 },
    ] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.strictEqual(result.tier7_findings.length, 0);
});

// ── Tầng 6: Thuốc (chỉ phần cảnh báo lâm sàng) ────────────────────────────────

test('36. Kháng sinh BHYT nhưng chưa có chẩn đoán nhiễm khuẩn -> cần kiểm tra', () => {
  const data = baseData({
    discharge: { chan_doan_chinh: 'S72.0 Gãy cổ xương đùi' },
    surgery: null,
    billing: { rows: [
      { name: 'Ceftriaxone 1g', tg_ylenh: '04/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 60000 },
    ] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.strictEqual(result.assessment.code, ASSESSMENT.NEEDS_REVIEW.code);
  const f = result.tier6_findings.find(x => x.rule_id === 'BHYT_T6_ANTIBIOTIC_NO_INFECTION_DX');
  assert.ok(f);
  assert.strictEqual(f.amount_at_risk, 60000);
});

test('37. Kháng sinh BHYT có chẩn đoán nhiễm khuẩn phù hợp -> không cảnh báo', () => {
  const data = baseData({
    discharge: { chan_doan_chinh: 'Viêm phổi cộng đồng' },
    surgery: null,
    billing: { rows: [
      { name: 'Ceftriaxone 1g', tg_ylenh: '04/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 60000 },
    ] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.ok(!result.tier6_findings.some(f => f.rule_id === 'BHYT_T6_ANTIBIOTIC_NO_INFECTION_DX'));
});

test('38. Kháng sinh nhưng người bệnh tự trả (không phải BHYT) -> ngoài phạm vi Tầng 6', () => {
  const data = baseData({
    discharge: { chan_doan_chinh: 'S72.0 Gãy cổ xương đùi' },
    surgery: null,
    billing: { rows: [
      { name: 'Ceftriaxone 1g', tg_ylenh: '04/09/2026', payment_group: 'self_pay', thanh_tien: 60000 },
    ] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.strictEqual(result.tier6_findings.length, 0);
});

test('39. Không có bảng kê -> Tầng 6 im lặng, không lỗi', () => {
  const data = baseData({ surgery: null, billing: null });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.strictEqual(result.tier6_findings.length, 0);
});

// ── Tầng 6 (mở rộng): thuốc chống chỉ định + DVKT cần chẩn đoán hỗ trợ ──────

test('40. Diclofenac + bệnh tim thiếu máu cục bộ (I25) -> nguy cơ cao (contraindication)', () => {
  const data = baseData({
    discharge: { chan_doan_chinh: 'S72.0 Gãy cổ xương đùi', benh_kem: ['Bệnh tim thiếu máu cục bộ - (I25.9)'] },
    surgery: null,
    billing: { rows: [
      { name: 'Diclofenac 75mg', tg_ylenh: '04/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 30000 },
    ] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.strictEqual(result.assessment.code, ASSESSMENT.HIGH_RISK.code);
  const f = result.tier6_findings.find(x => x.rule_id === 'BHYT_T6_DICLOFENAC_CARDIOVASCULAR_CONTRAINDICATION');
  assert.ok(f);
  assert.strictEqual(f.severity, BHYT_SEVERITY.HIGH_RISK);
  assert.strictEqual(f.amount_at_risk, 30000);
});

test('41. Diclofenac không kèm bệnh tim mạch/mạch máu não -> không cảnh báo chống chỉ định', () => {
  const data = baseData({
    discharge: { chan_doan_chinh: 'S72.0 Gãy cổ xương đùi' },
    surgery: null,
    billing: { rows: [
      { name: 'Diclofenac 75mg', tg_ylenh: '04/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 30000 },
    ] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.ok(!result.tier6_findings.some(f => f.rule_id === 'BHYT_T6_DICLOFENAC_CARDIOVASCULAR_CONTRAINDICATION'));
});

test('42. Levofloxacin + động kinh (G40) -> nguy cơ cao', () => {
  const data = baseData({
    discharge: { chan_doan_chinh: 'Viêm phổi cộng đồng', benh_kem: ['Động kinh - (G40.9)'] },
    surgery: null,
    billing: { rows: [
      { name: 'Levofloxacin 500mg', tg_ylenh: '04/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 45000 },
    ] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.ok(result.tier6_findings.some(f => f.rule_id === 'BHYT_T6_LEVOFLOXACIN_SEIZURE_CONTRAINDICATION'));
});

test('43. KT47 (vận động trị liệu hô hấp) không có chẩn đoán bệnh phổi mạn -> cần kiểm tra', () => {
  const data = baseData({
    discharge: { chan_doan_chinh: 'Viêm phổi cấp' },
    surgery: null,
    billing: { rows: [
      { name: 'Vận động trị liệu hô hấp', tg_ylenh: '04/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 80000 },
    ] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.ok(result.tier6_findings.some(f => f.rule_id === 'BHYT_T6_KT47_RESPIRATORY_THERAPY_NO_COPD_DX'));
});

test('44. KT47 với chẩn đoán COPD (J44) -> không cảnh báo', () => {
  const data = baseData({
    discharge: { chan_doan_chinh: 'Đợt cấp COPD - (J44.1)' },
    surgery: null,
    billing: { rows: [
      { name: 'Vận động trị liệu hô hấp', tg_ylenh: '04/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 80000 },
    ] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.ok(!result.tier6_findings.some(f => f.rule_id === 'BHYT_T6_KT47_RESPIRATORY_THERAPY_NO_COPD_DX'));
});

// ── Tầng 8: Dịch vụ kỹ thuật — trùng/cấu phần & bằng chứng liên kết ─────────

test('45. Mở sào bào-thượng nhĩ + tạo hình tai giữa cùng ngày -> cần kiểm tra (bundled)', () => {
  const data = baseData({
    surgery: null,
    billing: { rows: [
      { name: 'Phẫu thuật tạo hình tai giữa', tg_ylenh: '08:00 04/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 5000000 },
      { name: 'Mở sào bào, thượng nhĩ', tg_ylenh: '08:30 04/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 1200000 },
    ] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  const f = result.tier8_findings.find(x => x.rule_id === 'BHYT_T8_KT01_1_OPEN_MASTOID_VS_TYMPANOPLASTY');
  assert.ok(f);
  assert.strictEqual(f.severity, BHYT_SEVERITY.REVIEW);
  assert.strictEqual(f.amount_at_risk, 5000000);
});

test('46. Chỉ có phẫu thuật tạo hình tai giữa, không có mở sào bào -> không cảnh báo', () => {
  const data = baseData({
    surgery: null,
    billing: { rows: [
      { name: 'Phẫu thuật tạo hình tai giữa', tg_ylenh: '08:00 04/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 5000000 },
    ] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.ok(!result.tier8_findings.some(f => f.rule_id === 'BHYT_T8_KT01_1_OPEN_MASTOID_VS_TYMPANOPLASTY'));
});

test('47. Nuôi cấy + nhuộm soi khác ngày -> không cảnh báo (chỉ xét cùng ngày)', () => {
  const data = baseData({
    surgery: null,
    billing: { rows: [
      { name: 'Nuôi cấy - định danh vi khuẩn', tg_ylenh: '04/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 150000 },
      { name: 'Nhuộm soi', tg_ylenh: '06/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 30000 },
    ] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.ok(!result.tier8_findings.some(f => f.rule_id === 'BHYT_T8_KT01_04_GRAM_STAIN_VS_CULTURE'));
});

test('48. CT có cản quang nhưng không có thuốc cản quang cùng ngày -> cần kiểm tra (missing_support)', () => {
  const data = baseData({
    surgery: null,
    billing: { rows: [
      { name: 'Chụp CT sọ não có tiêm thuốc cản quang', tg_ylenh: '04/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 1500000 },
    ] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  const f = result.tier8_findings.find(x => x.rule_id === 'BHYT_T8_KT183_CT_CONTRAST_NO_DRUG_EVIDENCE');
  assert.ok(f);
  assert.strictEqual(f.amount_at_risk, 1500000);
});

test('49. CT có cản quang KÈM thuốc cản quang cùng ngày -> không cảnh báo', () => {
  const data = baseData({
    surgery: null,
    billing: { rows: [
      { name: 'Chụp CT sọ não có tiêm thuốc cản quang', tg_ylenh: '04/09/2026', payment_group: 'bhyt', muc_huong: '80%', thanh_tien: 1500000 },
      { name: 'Thuốc cản quang Xenetix 300', tg_ylenh: '04/09/2026', payment_group: 'self_pay', thanh_tien: 400000 },
    ] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.ok(!result.tier8_findings.some(f => f.rule_id === 'BHYT_T8_KT183_CT_CONTRAST_NO_DRUG_EVIDENCE'));
});

test('50. Không có bảng kê -> Tầng 8 im lặng, không lỗi', () => {
  const data = baseData({ surgery: null, billing: null });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.strictEqual(result.tier8_findings.length, 0);
});

// ── Tầng 8: nhiều lần PT/TT -> nêu ekip/phương pháp + tỷ lệ 100%/50%/80% theo ─────
// Điều 4đ Khoản 2, Thông tư 35/2016/TT-BYT (bổ sung bởi TT 39/2024/TT-BYT, không tự tính số tiền cụ thể) ──

test('50a. 2 lần PT cùng ekip -> finding REVIEW nêu "cùng ekip" + tỷ lệ 50%', () => {
  const data = baseData({
    billing: null,
    surgery: { surgeries: [
      { ten: 'Kết hợp xương đùi', thoi_gian: '05/09/2026 08:00', phuong_phap_pt: 'KHX nẹp vít', bs_mo_chinh: 'BS Nguyễn Văn A', gay_me_chinh: 'BS Trần Thị B', ptv_phu_1: 'BS Lê C', ptv_phu_2: '', dd_dung_cu: 'ĐD D', ktv_phu_me: 'KTV E' },
      { ten: 'Kết hợp xương chày', thoi_gian: '05/09/2026 10:00', phuong_phap_pt: 'KHX đinh nội tủy', bs_mo_chinh: 'BS Nguyễn Văn A', gay_me_chinh: 'BS Trần Thị B', ptv_phu_1: 'BS Lê C', ptv_phu_2: '', dd_dung_cu: 'ĐD D', ktv_phu_me: 'KTV E' },
    ] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  const f = result.tier8_findings.find(x => x.rule_id === 'BHYT_T8_MULTI_SURGERY_EKIP_COMPOSITION');
  assert.ok(f);
  assert.strictEqual(f.severity, BHYT_SEVERITY.REVIEW);
  assert.ok(f.title.includes('cùng ekip'));
  assert.ok(f.action.includes('50%'));
  assert.ok(f.legal_source.includes('35/2016/TT-BYT'));
});

test('50b. 2 lần PT khác ekip -> finding REVIEW nêu "N ekip khác nhau" + tỷ lệ 80%', () => {
  const data = baseData({
    billing: null,
    surgery: { surgeries: [
      { ten: 'Kết hợp xương đùi', thoi_gian: '05/09/2026 08:00', phuong_phap_pt: 'KHX nẹp vít', bs_mo_chinh: 'BS Nguyễn Văn A', gay_me_chinh: 'BS Trần Thị B' },
      { ten: 'Kết hợp xương chày', thoi_gian: '06/09/2026 08:00', phuong_phap_pt: 'KHX đinh nội tủy', bs_mo_chinh: 'BS Phạm Văn X', gay_me_chinh: 'BS Hoàng Thị Y' },
    ] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  const f = result.tier8_findings.find(x => x.rule_id === 'BHYT_T8_MULTI_SURGERY_EKIP_COMPOSITION');
  assert.ok(f);
  assert.ok(f.title.includes('2 ekip khác nhau'));
  assert.ok(f.action.includes('80%'));
});

test('50c. Chỉ 1 lần PT -> không cảnh báo (cần >=2 lần mới so sánh)', () => {
  const data = baseData({ billing: null });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.ok(!result.tier8_findings.some(f => f.rule_id === 'BHYT_T8_MULTI_SURGERY_EKIP_COMPOSITION'));
});

test('50d. 2 lần PT nhưng không có trường ekip nào -> không suy đoán, không cảnh báo', () => {
  const data = baseData({
    billing: null,
    surgery: { surgeries: [
      { ten: 'Kết hợp xương đùi', thoi_gian: '05/09/2026 08:00' },
      { ten: 'Kết hợp xương chày', thoi_gian: '06/09/2026 08:00' },
    ] },
  });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.ok(!result.tier8_findings.some(f => f.rule_id === 'BHYT_T8_MULTI_SURGERY_EKIP_COMPOSITION'));
});

// ── Bước 4: chỉ số "tỷ lệ đạt" theo Tầng ─────────────────────────────────────

test('51. Hồ sơ sạch -> readiness 8/8 tầng không có cảnh báo', () => {
  const data = baseData();
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.ok(result.readiness);
  assert.strictEqual(result.readiness.total_count, 8);
  assert.strictEqual(result.readiness.clean_count, 8);
  assert.ok(result.readiness.items.every(i => i.clean));
});

test('52. Hồ sơ có 1 finding ở Tầng 1 -> readiness giảm đúng 1 tầng, các tầng khác không đổi', () => {
  const data = baseData({ profile: { ngay_vao_vien: '09/09/2026', ngay_ra_vien: '03/09/2026' } });
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data });
  assert.strictEqual(result.readiness.clean_count, 7);
  const tier1Item = result.readiness.items.find(i => i.tier === 1);
  assert.strictEqual(tier1Item.clean, false);
  assert.ok(tier1Item.count >= 1);
  assert.strictEqual(tier1Item.label, 'Toàn vẹn dữ liệu');
});

test('53. Chưa đủ dữ liệu -> readiness = null, không suy đoán tỷ lệ đạt', () => {
  const result = runBhytPreAudit({ meta: { scope_default: 'discharge' }, data: {} });
  assert.strictEqual(result.readiness, null);
});

console.log(`\n${passed} test(s) passed.`);
if (process.exitCode) console.error('\nCó test thất bại.');
