'use strict';

// Tái hiện ca thật BN 26084418 (dữ liệu giả, cùng hình dạng):
// 1) Dòng y lệnh lấy lần trước còn ghi ra viện 2026-09-23, trong khi trang ra viện EMR ghi 13:00 22/08
//    → đợt bị kéo tới 23/09 dù "Thời gian điều trị" là 6 ngày.
// 2) EMR để trống giờ bắt đầu mổ nên worker đọc ra giờ lúc lấy dữ liệu (14:11 06/10/2026);
//    ngày thật của ca mổ nằm ở danh sách phẫu thuật (thoi_gian 18/08/2026).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'case_dates_'));
process.env.EMR_RUNTIME_ROOT = ROOT;
const { RESEARCH_STORE_DIR } = require('../server/constants');
const { writeCsv, readCsvTable } = require('../server/research/table_io');
const R = require('../server/routes/research')._test;

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

const put = (dir, file, rows) => writeCsv(path.join(dir, file), [...new Set(rows.flatMap(Object.keys))], rows);

function buildRun() {
  const dir = path.join(RESEARCH_STORE_DIR, 'du_lieu_goc', 'runs', 'r1');
  fs.mkdirSync(dir, { recursive: true });
  const code = '900001';
  put(dir, 'du_lieu_ban_dau.csv', [
    { 'T/G vào': '13:58 17/08/2026', 'Mã BN': code, 'Họ tên': 'A' },
    { 'T/G vào': '13:33 18/08/2026', 'Mã BN': code, 'Họ tên': 'A' },
  ]);
  put(dir, 'hchanh_profile.csv', ['enc_k1', 'enc_k2'].map(k => ({
    'Mã BN': code, 'Ngày vào viện': '13:58 17-08-2026', 'Ngày ra viện': '13:00 22-08-2026', 'Thời gian điều trị': '6', 'Research key': k,
  })));
  put(dir, 'hchanh_discharge.csv', [
    { 'Mã BN': code, 'Ngày vào viện': '13:33 18/08/2026', 'Ngày ra viện': '13:00 22/08/2026', 'Thời gian điều trị': '6', 'Research key': 'enc_k1' },
    { 'Mã BN': code, 'Ngày vào viện': '13:58 17-08-2026', 'Ngày ra viện': '13:00 22/08/2026', 'Thời gian điều trị': '6', 'Research key': 'enc_k2' },
  ]);
  const raw = JSON.stringify({ thoi_gian: '18/08/2026', bat_dau: '14:11 06/10/2026', detail: { bat_dau: '14:11 06/10/2026' } });
  put(dir, 'hchanh_surgery.csv', [
    { 'Mã BN': code, 'Ngày vào viện': '13:33 18/08/2026', 'Ngày ra viện': '2026-09-23', 'Ngày phẫu thuật': '06/10/2026 14:11', 'Tên phẫu thuật': 'Phẫu thuật kết hợp xương', 'Nguồn': 'hchanh_auto_surgery', 'Research key': 'enc_k1', 'Raw JSON': raw },
    { 'Mã BN': code, 'Ngày vào viện': '13:58 17-08-2026', 'Ngày ra viện': '13:00 22/08/2026', 'Ngày phẫu thuật': '06/10/2026 14:11', 'Tên phẫu thuật': 'Phẫu thuật kết hợp xương', 'Nguồn': 'hchanh_auto_surgery', 'Research key': 'enc_k2', 'Raw JSON': raw },
  ]);
  put(dir, 'hchanh_order_history.csv', [
    { 'Mã BN': code, 'Ngày vào viện': '13:33 18/08/2026', 'Ngày ra viện': '2026-09-23', 'TG y lệnh': '05:00 19/08/2026', 'Tên y lệnh': 'Ibuprofen 400mg uống', 'Research key': 'enc_k1' },
    { 'Mã BN': code, 'Ngày vào viện': '13:58 17-08-2026', 'Ngày ra viện': '13:00 22/08/2026', 'TG y lệnh': '05:00 19/08/2026', 'Tên y lệnh': 'Ibuprofen 400mg uống', 'Research key': 'enc_k2' },
  ]);
  R.normalizeRunOutputs(dir, { sourceRunId: 'r1', force: true });
  return dir;
}

const dir = buildRun();
const rows = file => readCsvTable(path.join(dir, file), Number.MAX_SAFE_INTEGER).rows || [];

test('ngày ra viện lấy theo trang ra viện EMR (22/08), không theo khoảng cũ trên dòng y lệnh (23/09)', () => {
  const enc = rows('encounters.csv');
  assert.strictEqual(enc.length, 1, JSON.stringify(enc.map(e => [e.admission_date, e.discharge_date])));
  assert.match(enc[0].discharge_date, /^2026-08-22/);
  assert.match(enc[0].admission_date, /^2026-08-17 13:58/);
});

test('giờ mổ bằng giờ lấy dữ liệu (sau ra viện) thì dùng ngày trong danh sách phẫu thuật và ghép vào đợt', () => {
  const surg = rows('surgery_results.csv');
  assert.strictEqual(surg.length, 1);
  assert.strictEqual(surg[0].surgery_date, '2026-08-18');
  assert.ok(!surg[0].surgery_datetime.includes('14:11'), surg[0].surgery_datetime);
  assert.strictEqual(surg[0].encounter_match_status, 'matched');
  assert.strictEqual(surg[0].is_within_encounter, '1');
  assert.strictEqual(surg[0].surgery_time_source, 'surgery_list_date');
});

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${passed} test(s) passed.`);
