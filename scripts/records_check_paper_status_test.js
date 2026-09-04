#!/usr/bin/env node
'use strict';

// Kiểm thử logic thuần cho quy định bàn giao hồ sơ giấy KHTH (48 giờ, KSĐ/GPB,
// checklist hồ sơ giấy, điều kiện "Sẵn sàng nộp"). Không cần server/session.
// Chạy: node scripts/records_check_paper_status_test.js

const assert = require('assert');
const {
  KSD_GPB_STATUS,
  ksdGpbInfo,
  applyChecklistPatch,
  paperRecordStatus,
  computeHandover,
  submissionReadiness,
} = require('../server/services/hchanh/paper_record_status');
const { getKsdGpbStatus, registerKsdGpbFetcher, resetKsdGpbFetcher } = require('../server/services/hchanh/lab_result_adapter');
const {
  addRecords,
  submitBatch,
} = require('../server/services/hchanh/records_submission_store');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

function ksdGpb(ksdStatus, gpbStatus) {
  return { ksd: ksdGpbInfo(ksdStatus), gpb: ksdGpbInfo(gpbStatus) };
}

console.log('records_check_paper_status_test');

// ── Kịch bản 1: hồ sơ không có chỉ định KSĐ/GPB ──────────────────────────────
test('1. Không chỉ định KSĐ/GPB -> NOT_ORDERED, không cần note bìa', () => {
  const info = ksdGpb(KSD_GPB_STATUS.NOT_ORDERED, KSD_GPB_STATUS.NOT_ORDERED);
  const checklist = applyChecklistPatch(null, { checked: true, doctor_signed: true, nurse_signed: true, head_signed: true }, 'DD A', '2026-09-01T00:00:00Z');
  const status = paperRecordStatus(checklist, info);
  assert.strictEqual(status.code, 'COMPLETE');
  const readiness = submissionReadiness({ hasDischargeDate: true, hasStorage: true, checklist, ksdGpb: info });
  assert.strictEqual(readiness.ready, true);
});

// ── Kịch bản 2: KSĐ đã có kết quả ────────────────────────────────────────────
test('2. KSĐ đã có kết quả -> COMPLETED, không chặn hoàn thiện', () => {
  const info = ksdGpb(KSD_GPB_STATUS.COMPLETED, KSD_GPB_STATUS.NOT_ORDERED);
  const checklist = applyChecklistPatch(null, { checked: true, doctor_signed: true, nurse_signed: true, head_signed: true }, 'DD A', '2026-09-01T00:00:00Z');
  assert.strictEqual(paperRecordStatus(checklist, info).code, 'COMPLETE');
});

// ── Kịch bản 3: nợ GPB, chưa ghi note ────────────────────────────────────────
test('3. Nợ GPB, chưa ghi note -> chặn MISSING_COVER_NOTE và chặn Sẵn sàng nộp', () => {
  const info = ksdGpb(KSD_GPB_STATUS.NOT_ORDERED, KSD_GPB_STATUS.PENDING);
  const checklist = applyChecklistPatch(null, { checked: true, doctor_signed: true, nurse_signed: true, head_signed: true }, 'DD A', '2026-09-01T00:00:00Z');
  const status = paperRecordStatus(checklist, info);
  assert.strictEqual(status.code, 'MISSING_COVER_NOTE');
  const readiness = submissionReadiness({ hasDischargeDate: true, hasStorage: true, checklist, ksdGpb: info });
  assert.strictEqual(readiness.ready, false);
  assert.ok(readiness.missing.some(m => /note ngoài bìa/.test(m)));
});

// ── Kịch bản 4: nợ GPB nhưng đã ghi note -> vẫn được nộp ────────────────────
test('4. Nợ GPB nhưng đã ghi note bìa -> vẫn Sẵn sàng nộp dù chưa có kết quả', () => {
  const info = ksdGpb(KSD_GPB_STATUS.NOT_ORDERED, KSD_GPB_STATUS.PENDING);
  const checklist = applyChecklistPatch(null, {
    checked: true, doctor_signed: true, nurse_signed: true, head_signed: true, cover_note_done: true,
  }, 'DD A', '2026-09-01T00:00:00Z');
  const status = paperRecordStatus(checklist, info);
  assert.strictEqual(status.code, 'COMPLETE');
  const readiness = submissionReadiness({ hasDischargeDate: true, hasStorage: true, checklist, ksdGpb: info });
  assert.strictEqual(readiness.ready, true, JSON.stringify(readiness.missing));
});

// ── Kịch bản 5: đủ dữ liệu EMR nhưng chưa kiểm hồ sơ giấy ───────────────────
test('5. Đủ dữ liệu EMR nhưng chưa kiểm hồ sơ giấy -> chưa Sẵn sàng nộp', () => {
  const info = ksdGpb(KSD_GPB_STATUS.NOT_ORDERED, KSD_GPB_STATUS.NOT_ORDERED);
  const checklist = applyChecklistPatch(null, {}, '', '2026-09-01T00:00:00Z');
  const readiness = submissionReadiness({ hasDischargeDate: true, hasStorage: true, checklist, ksdGpb: info });
  assert.strictEqual(readiness.ready, false);
  assert.ok(readiness.missing.includes('Chưa kiểm hồ sơ giấy'));
  assert.strictEqual(paperRecordStatus(checklist, info).code, 'NOT_CHECKED');
});

// ── Kịch bản 6: hồ sơ giấy đủ nhưng thiếu chữ ký Trưởng khoa ────────────────
test('6. Thiếu chữ ký Trưởng khoa -> WAITING_HEAD_SIGN, chặn nộp', () => {
  const info = ksdGpb(KSD_GPB_STATUS.NOT_ORDERED, KSD_GPB_STATUS.NOT_ORDERED);
  const checklist = applyChecklistPatch(null, { checked: true, doctor_signed: true, nurse_signed: true }, 'DD A', '2026-09-01T00:00:00Z');
  const status = paperRecordStatus(checklist, info);
  assert.strictEqual(status.code, 'WAITING_HEAD_SIGN');
  const readiness = submissionReadiness({ hasDischargeDate: true, hasStorage: true, checklist, ksdGpb: info });
  assert.strictEqual(readiness.ready, false);
  assert.ok(readiness.missing.some(m => /Trưởng khoa/.test(m)));
});

// ── Kịch bản 7: còn dưới 12 giờ ──────────────────────────────────────────────
test('7. Còn dưới 12 giờ -> tone orange, state due_12h', () => {
  const now = '2026-09-01T12:00:00Z';
  const dischargedAt = '2026-08-30T05:00:00Z'; // deadline 2026-09-01T05:00:00Z đã qua? tính lại
  // deadline = dischargedAt + 48h = 2026-09-01T05:00:00Z -> đã quá hạn so với now 12:00, chỉnh lại còn 10 giờ
  const discharged10hLeft = '2026-08-30T14:00:00Z'; // +48h = 2026-09-01T14:00:00Z, còn 2h so với now? need <=12h and >0
  const out = computeHandover({ dischargedAtIso: discharged10hLeft, dischargeHasTime: true, handedOverAt: null, nowIso: now });
  assert.strictEqual(out.state, 'due_12h');
  assert.strictEqual(out.tone, 'orange');
  assert.ok(out.remaining_ms > 0 && out.remaining_ms <= 12 * 60 * 60 * 1000);
  void dischargedAt;
});

// ── Kịch bản 8: đã quá 48 giờ ────────────────────────────────────────────────
test('8. Quá 48 giờ và chưa nộp -> state overdue, tone red', () => {
  const out = computeHandover({ dischargedAtIso: '2026-08-28T00:00:00Z', dischargeHasTime: true, handedOverAt: null, nowIso: '2026-09-01T00:00:00Z' });
  assert.strictEqual(out.state, 'overdue');
  assert.strictEqual(out.tone, 'red');
  assert.ok(out.remaining_ms < 0);
});

// ── Kịch bản 9: nộp đúng hạn ─────────────────────────────────────────────────
test('9. Nộp đúng hạn -> submitted_on_time, tone green', () => {
  const out = computeHandover({
    dischargedAtIso: '2026-08-30T08:00:00Z',
    dischargeHasTime: true,
    handedOverAt: '2026-09-01T00:00:00Z', // trong vòng 48h
    nowIso: '2026-09-02T00:00:00Z',
  });
  assert.strictEqual(out.state, 'submitted_on_time');
  assert.strictEqual(out.tone, 'green');
});

// ── Kịch bản 10: nộp quá hạn ─────────────────────────────────────────────────
test('10. Nộp quá hạn -> submitted_late, hiển thị số giờ trễ', () => {
  const out = computeHandover({
    dischargedAtIso: '2026-08-28T00:00:00Z',
    dischargeHasTime: true,
    handedOverAt: '2026-08-31T00:00:00Z', // deadline 2026-08-30T00:00 -> trễ 24h
    nowIso: '2026-09-02T00:00:00Z',
  });
  assert.strictEqual(out.state, 'submitted_late');
  assert.strictEqual(out.tone, 'red');
  assert.strictEqual(out.late_hours, 24);
  assert.ok(/trễ 24 giờ/.test(out.label));
});

// ── Kịch bản 16: EMR không có giờ ra viện -> không tự tạo hạn giả ───────────
test('16. Không có giờ ra viện thật -> unknown_deadline, không tự đặt hạn', () => {
  const out = computeHandover({ dischargedAtIso: '2026-08-30T00:00:00Z', dischargeHasTime: false, handedOverAt: null, nowIso: '2026-09-01T00:00:00Z' });
  assert.strictEqual(out.state, 'unknown_deadline');
  assert.strictEqual(out.handover_deadline, null);
});

// ── Kịch bản 17: nút Sẵn sàng nộp bị khóa, nêu rõ lý do thiếu ───────────────
test('17. Thiếu nhiều điều kiện -> liệt kê đầy đủ lý do', () => {
  const info = ksdGpb(KSD_GPB_STATUS.NOT_ORDERED, KSD_GPB_STATUS.PENDING);
  const checklist = applyChecklistPatch(null, {}, '', '2026-09-01T00:00:00Z');
  const readiness = submissionReadiness({ hasDischargeDate: false, hasStorage: false, checklist, ksdGpb: info });
  assert.strictEqual(readiness.ready, false);
  assert.ok(readiness.missing.length >= 5);
});

// ── KSĐ/GPB adapter: không đọc được dữ liệu thật -> UNKNOWN, không phải COMPLETED
test('Adapter chưa nối nguồn EMR -> UNKNOWN với lý do rõ ràng, không bịa COMPLETED', () => {
  resetKsdGpbFetcher();
  const out = getKsdGpbStatus({});
  assert.strictEqual(out.ksd.status, KSD_GPB_STATUS.UNKNOWN);
  assert.strictEqual(out.gpb.status, KSD_GPB_STATUS.UNKNOWN);
  assert.ok(out.ksd.reason.length > 0);
});

test('Adapter khi có fetcher thật -> trả đúng trạng thái từ fetcher', () => {
  registerKsdGpbFetcher(() => ({ ksd: { status: KSD_GPB_STATUS.COMPLETED }, gpb: { status: KSD_GPB_STATUS.PENDING } }));
  const out = getKsdGpbStatus({});
  assert.strictEqual(out.ksd.status, KSD_GPB_STATUS.COMPLETED);
  assert.strictEqual(out.gpb.status, KSD_GPB_STATUS.PENDING);
  resetKsdGpbFetcher();
});

// ── Audit lịch sử checklist: lưu người/thời gian/trước-sau ──────────────────
test('applyChecklistPatch ghi lịch sử trước/sau, người, thời gian cho từng lần đổi', () => {
  let checklist = applyChecklistPatch(null, { checked: true }, 'DD A', '2026-09-01T08:00:00Z');
  assert.strictEqual(checklist.history.length, 1);
  assert.strictEqual(checklist.history[0].field, 'checked');
  assert.strictEqual(checklist.history[0].from, false);
  assert.strictEqual(checklist.history[0].to, true);
  assert.strictEqual(checklist.history[0].by, 'DD A');
  checklist = applyChecklistPatch(checklist, { doctor_signed: true }, 'DD B', '2026-09-01T09:00:00Z');
  assert.strictEqual(checklist.history.length, 2);
  assert.strictEqual(checklist.doctor_signed, true);
  // Không mất lịch sử cũ khi patch tiếp — mô phỏng reload không mất trạng thái (13).
  assert.strictEqual(checklist.history[0].field, 'checked');
});

test('Hồ sơ không nợ KSĐ/GPB -> cover_note_done không bắt buộc (N/A ở tầng UI)', () => {
  const info = ksdGpb(KSD_GPB_STATUS.NOT_ORDERED, KSD_GPB_STATUS.NOT_ORDERED);
  const checklist = applyChecklistPatch(null, { checked: true, doctor_signed: true, nurse_signed: true, head_signed: true }, 'DD A', '2026-09-01T00:00:00Z');
  const readiness = submissionReadiness({ hasDischargeDate: true, hasStorage: true, checklist, ksdGpb: info });
  assert.strictEqual(readiness.ready, true);
});

// ── Kịch bản 14 (đợt nộp): hồ sơ đã nộp không xuất hiện lại trong đợt mới ───
test('14. Hồ sơ đã nộp không tự xuất hiện lại trong đợt nộp mới', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'records-submission-test-'));
  try {
    const record = { record_id: 'BN01::20260101', aliases: ['BN01::20260101'], snapshot: { ho_ten: 'Nguyễn Văn A', so_luu_tru: '123' } };
    addRecords(dir, '2026-09-01', [record], ['BN01::20260101']);
    submitBatch(dir, '2026-09-01');
    // Cùng record_id/alias cố thêm lại vào ngày khác -> phải bị skip vì đã active ở đợt cũ (đã nộp = vẫn active theo status batch).
    const result = addRecords(dir, '2026-09-02', [record], ['BN01::20260101']);
    assert.strictEqual(result.added.length, 0);
    assert.strictEqual(result.skipped.length, 1);
    assert.strictEqual(result.skipped[0].reason, 'already_active');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${passed} kịch bản pass.`);
if (process.exitCode) {
  console.error('CÓ KỊCH BẢN FAIL.');
  process.exit(1);
}
