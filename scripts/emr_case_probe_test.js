'use strict';

// Dò theo ca: đánh giá từng màn hình + chạy trọn một lượt với worker giả (không mở EMR/Chrome).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const probe = require('../server/services/emr_case_probe');

let passed = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const screen = key => probe.PROBE_SCREENS.find(s => s.key === key);

test('kiểm tra ca nhập vào: tối đa 3 ca, không trùng, mã và ngày hợp lệ', () => {
  assert.throws(() => probe.normalizeCases([]), /ít nhất một Mã BN/);
  assert.throws(() => probe.normalizeCases([{ ma_bn: 'A1' }, { ma_bn: 'A2' }, { ma_bn: 'A3' }, { ma_bn: 'A4' }]), /tối đa 3 ca/);
  assert.throws(() => probe.normalizeCases([{ ma_bn: 'A1' }, { ma_bn: 'A1' }]), /hai lần/);
  assert.throws(() => probe.normalizeCases([{ ma_bn: "A1'; DROP" }]), /ký tự lạ/);
  assert.throws(() => probe.normalizeCases([{ ma_bn: 'A1', admission: '31-02' }]), /ngày vào viện/);
  assert.throws(() => probe.normalizeCases([{ ma_bn: 'A1', admission: '2026-05-10', discharge: '2026-05-01' }]), /đứng trước/);
  const [c] = probe.normalizeCases([{ ma_bn: ' 2401234 ', discharged: true, admission: '01/05/2026', discharge: '2026-05-09' }]);
  assert.deepStrictEqual(c, { ma_bn: '2401234', discharged: true, admission: '2026-05-01', discharge: '2026-05-09' });
  const row = probe.workerRow(c);
  assert.strictEqual(row.inpatient_status, 'Hoàn tất');
  assert.strictEqual(row.research_mode, true);
  assert.strictEqual(row._progress_key, '2401234');
});

test('đếm dữ liệu: bỏ khóa kỹ thuật, đếm dòng trong danh sách và ô có chữ', () => {
  const m = probe.measurePayload('rows', {
    _fetch_status: 'ok', ma_bn: 'X', matched_inpatient_status: 'Hoàn tất',
    ho_ten: 'A', chan_doan: '', tong_tien: 0,
    rows: [1, 2, 3], groups: { dich_vu: [1], thuoc: [1, 2] },
  });
  assert.deepStrictEqual(m, { lists: { rows: 3, 'groups.dich_vu': 1, 'groups.thuoc': 2 }, rows: 3, fields: 2 });
  assert.deepStrictEqual(probe.measurePayload('rows', null), { lists: {}, rows: 0, fields: 0 });
});

test('đánh giá màn hình: đọc được, hỏng, chưa chạy, không có dữ liệu', () => {
  assert.strictEqual(probe.judgeScreen(screen('profile'), { _fetch_status: 'ok', ho_ten: 'A' }, null).verdict, 'ok');
  const noUrl = probe.judgeScreen(screen('surgery'), { _fetch_status: 'no_url' }, null);
  assert.strictEqual(noUrl.verdict, 'broken');
  assert.match(noUrl.message, /đường vào màn hình/);
  assert.strictEqual(probe.judgeScreen(screen('billing'), { _fetch_status: 'error', _error: 'boom\ntrace' }, null).message.includes('boom'), true);
  assert.strictEqual(probe.judgeScreen(screen('billing'), undefined, null).verdict, 'not_run');
  const empty = probe.judgeScreen(screen('surgery'), { _fetch_status: 'empty', surgeries: [] }, null);
  assert.strictEqual(empty.verdict, 'empty');
  const notDischarged = probe.judgeScreen(screen('discharge'), { _fetch_status: 'empty', _reason: 'patient_not_completed_currently' }, null);
  assert.match(notDischarged.message, /Bình thường/);
});

test('nghi hỏng: kho có dữ liệu mà lần này đọc ra 0, hoặc ít hơn hẳn', () => {
  const zero = probe.judgeScreen(screen('billing'), { _fetch_status: 'ok', rows: [] }, { rows: [1, 2, 3] });
  assert.strictEqual(zero.verdict, 'suspect');
  assert.strictEqual(zero.stored_rows, 3);
  // Còn phần thông tin chung nhưng 0 dòng chi tiết trong khi kho có dòng: vẫn nghi hỏng.
  const headerOnly = probe.judgeScreen(screen('billing'), { _fetch_status: 'ok', tong_tien: 100, rows: [] }, { tong_tien: 100, rows: [1] });
  assert.strictEqual(headerOnly.verdict, 'suspect');
  const fewer = probe.judgeScreen(screen('order_history'), { _fetch_status: 'ok', rows: [1, 2] }, { rows: [1, 2, 3, 4, 5, 6] });
  assert.strictEqual(fewer.verdict, 'suspect');
  assert.strictEqual(probe.judgeScreen(screen('order_history'), { _fetch_status: 'ok', rows: [1, 2, 3, 4, 5] }, { rows: [1, 2, 3, 4, 5, 6] }).verdict, 'ok');
});

test('tóm tắt ca: không tìm thấy người bệnh, nhật ký lỗi không mang mã/tên người bệnh', () => {
  const out = {
    profile: { _fetch_status: 'no_url' },
    _case_trace: [
      { tag: 'CASE.START', step: 'x', takes: 'Mã BN=123; Họ tên=Nguyễn A' },
      { tag: 'ERROR.NO_PATIENT_LINK', step: 'Không lấy được URL hồ sơ BN', screen: 'D/s Điều trị nội trú', takes: 'Mã BN=123' },
    ],
  };
  const s = probe.summarizeCase({ ma_bn: '123', discharged: false }, out, null);
  assert.match(s.headline, /Không tìm thấy người bệnh/);
  assert.strictEqual(s.screens.length, probe.PROBE_SCREENS.length);
  assert.deepStrictEqual(s.problems, [{ tag: 'ERROR.NO_PATIENT_LINK', step: 'Không lấy được URL hồ sơ BN', screen: 'D/s Điều trị nội trú' }]);
  assert.ok(!JSON.stringify(s.problems).includes('Nguyễn'));
  assert.strictEqual(s.counts.broken, 1);
  assert.strictEqual(s.counts.not_run, probe.PROBE_SCREENS.length - 1);
});

test('chạy trọn một lượt với worker giả: đúng tham số, so với kho, xoá dữ liệu thô', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'case_probe_'));
  const cases = probe.normalizeCases([{ ma_bn: 'BN1', discharged: true, admission: '2026-05-01', discharge: '2026-05-09' }, { ma_bn: 'BN2' }]);
  probe.beginReport(dir, cases, { by: 'test' });
  assert.strictEqual(probe.readReport(dir).status, 'running');

  let seenArgs = null;
  let seenInput = null;
  const runScript = async (script, args) => {
    assert.strictEqual(script, 'hchanh_fetch.py');
    seenArgs = args;
    const inputPath = args[args.indexOf('--input') + 1];
    seenInput = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
    const outPath = args[args.indexOf('--out') + 1];
    fs.writeFileSync(outPath, JSON.stringify({
      BN1: {
        profile: { _fetch_status: 'ok', ho_ten: 'A', ngay_vao_vien: '08:00 01/05/2026' },
        billing: { _fetch_status: 'ok', rows: [] },
        order_history: { _fetch_status: 'ok', rows: [1, 2, 3] },
      },
    }));
    return { code: 0 };
  };
  const lookups = [];
  const findStored = (maBn, day) => { lookups.push([maBn, day]); return { billing: { rows: [1, 2] } }; };

  const report = await probe.runCaseProbe(dir, cases, { runScript, findStored, headless: true });
  assert.ok(seenArgs.includes('--headless'));
  assert.strictEqual(seenArgs[seenArgs.indexOf('--files') + 1], probe.PROBE_FILES.join(','));
  assert.ok(seenArgs[seenArgs.indexOf('--progress-file') + 1].endsWith('hchanh_auto_progress.json'));
  assert.ok(!seenArgs.includes('--status'), 'trạng thái lấy theo từng ca, không ép chung cả lô');
  assert.deepStrictEqual(seenInput.map(r => [r.ma_bn, r.inpatient_status]), [['BN1', 'Hoàn tất'], ['BN2', 'Đang thực hiện']]);
  assert.deepStrictEqual(lookups, [['BN1', '2026-05-01']]);

  assert.strictEqual(report.status, 'done');
  const [bn1, bn2] = report.cases;
  assert.strictEqual(bn1.compared_with_store, true);
  assert.strictEqual(bn1.screens.find(s => s.key === 'billing').verdict, 'suspect');
  assert.strictEqual(bn1.screens.find(s => s.key === 'order_history').verdict, 'ok');
  assert.match(bn2.headline, /không trả kết quả/);
  assert.ok(report.totals.suspect >= 1);
  assert.ok(!fs.existsSync(path.join(dir, 'emr_case_probe')), 'dữ liệu bệnh án thô phải bị xoá');
  assert.ok(!JSON.stringify(report).includes('"ho_ten"'), 'báo cáo chỉ giữ số đếm, không giữ nội dung bệnh án');
  assert.strictEqual(probe.readReport(dir).status, 'done');
});

test('đếm đúng danh sách chính của từng màn hình, không cộng danh sách phụ', () => {
  const surgery = probe.judgeScreen(screen('surgery'), {
    _fetch_status: 'ok', surgeries: [1], phan_loai_pt_list: [1], order_history_surgery_markers: [1, 2, 3],
    ward_admissions: [1, 2, 3], postop_ward_admissions: [1],
  }, null);
  assert.strictEqual(surgery.rows, 1);
  const orders = probe.judgeScreen(screen('order_history'), { _fetch_status: 'ok', rows: new Array(51).fill(1), khoa_list: [1, 2, 3], ward_admissions: [1, 2, 3] }, null);
  assert.strictEqual(orders.rows, 51);
  assert.strictEqual(probe.judgeScreen(screen('cls'), { _fetch_status: 'ok', results: [1, 2] }, null).rows, 2);
  // Hồ sơ / ra viện không có danh sách chính: chỉ đếm ô có dữ liệu (danh sách khác rỗng tính là một ô).
  const discharge = probe.judgeScreen(screen('discharge'), { _fetch_status: 'ok', ngay_ra: '09/05/2026', benh_kem: [1, 2], chan_doan_vao_list: [] }, null);
  assert.deepStrictEqual([discharge.rows, discharge.fields, discharge.verdict], [0, 2, 'ok']);
});

test('ngày vào viện dạng "HH:MM dd-mm-yyyy" của EMR vẫn tìm được đợt trong kho để so', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'case_probe_'));
  const cases = probe.normalizeCases([{ ma_bn: 'BN9' }]);
  probe.beginReport(dir, cases);
  const runScript = async (_s, args) => {
    fs.writeFileSync(args[args.indexOf('--out') + 1], JSON.stringify({
      BN9: { profile: { _fetch_status: 'ok', ngay_vao_vien: '08:00 20-09-2026' }, billing: { _fetch_status: 'error', _reason: 'not_billing_page', rows: [] } },
    }));
    return { code: 0 };
  };
  const lookups = [];
  const report = await probe.runCaseProbe(dir, cases, {
    runScript, findStored: (m, d) => { lookups.push(d); return { billing: { rows: [1, 2, 3] } }; },
  });
  assert.deepStrictEqual(lookups, ['2026-09-20']);
  const billing = report.cases[0].screens.find(s => s.key === 'billing');
  assert.strictEqual(billing.stored_rows, 3);
  assert.strictEqual(report.cases[0].compared_with_store, true);
});

test('không có ngày vào thì dùng ngày ra viện để tìm đợt trong kho', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'case_probe_'));
  const cases = probe.normalizeCases([{ ma_bn: 'BN8' }]);
  probe.beginReport(dir, cases);
  const runScript = async (_s, args) => {
    fs.writeFileSync(args[args.indexOf('--out') + 1], JSON.stringify({ BN8: { discharge: { _fetch_status: 'ok', ngay_ra: '10:15 25-09-2026' } } }));
    return { code: 0 };
  };
  const lookups = [];
  await probe.runCaseProbe(dir, cases, { runScript, findStored: (m, d) => { lookups.push(d); return null; } });
  assert.deepStrictEqual(lookups, ['2026-09-25']);
});

test('worker không khởi động được / lần dò bị bỏ dở được báo rõ', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'case_probe_'));
  const cases = probe.normalizeCases([{ ma_bn: 'BN1' }]);
  probe.beginReport(dir, cases);
  const r = await probe.runCaseProbe(dir, cases, { runScript: async () => ({ spawnError: 'ENOENT' }) });
  assert.strictEqual(r.status, 'error');
  assert.match(r.message, /Python/);

  probe.beginReport(dir, cases);
  assert.strictEqual(probe.markInterrupted(dir, true).status, 'running', 'đang chạy thật thì không đánh dấu bỏ dở');
  assert.strictEqual(probe.markInterrupted(dir, false).status, 'interrupted');

  probe.beginReport(dir, cases);
  const c = await probe.runCaseProbe(dir, cases, { runScript: async () => ({ code: 1 }), isCancelled: () => true });
  assert.strictEqual(c.status, 'cancelled');
});

(async () => {
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
    } catch (err) {
      console.error(`✗ ${t.name}\n`, err);
      process.exit(1);
    }
  }
  console.log(`emr_case_probe_test: ${passed}/${tests.length} OK`);
})();
