#!/usr/bin/env node
'use strict';

// Kiểm thử: dữ liệu đã lấy ở tab Hành chánh / Kiểm hồ sơ (kho dùng chung hchanh_stays) được Kho nghiên cứu
// dùng lại — đủ file thì không mở EMR; thiếu thì chỉ lấy phần còn thiếu (_files_override) rồi ghép lại.
// Chạy: node scripts/research_hchanh_stay_store_reuse_test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'research_stay_store_test_'));
process.env.EMR_RUNTIME_ROOT = RUNTIME_ROOT;

const spawned = [];
const runnerPath = require.resolve('../server/services/python_runner');
const realRunner = require(runnerPath);
require.cache[runnerPath].exports = {
  ...realRunner,
  runScript: async (_script, args) => {
    const input = JSON.parse(fs.readFileSync(args[args.indexOf('--input') + 1], 'utf-8'));
    const out = {};
    for (const item of input) {
      const files = item._files_override || args[args.indexOf('--files') + 1].split(',');
      spawned.push(`${item.ma_bn}:${files.join('+')}`);
      const all = {
        profile: { _fetch_status: 'ok', ngay_vao_vien: '08:00 20/09/2026', bhyt_code: `EMR-${item.ma_bn}`, _admission_vitals_status: 'ok', mach_vao_vien: '80' },
        discharge: { _fetch_status: 'ok', ngay_ra: '28/09/2026', xu_tri: 'Ra viện (EMR)' },
        surgery: { _fetch_status: 'ok', surgeries: [] },
        billing: { _fetch_status: 'ok', rows: [{ name: 'Ngày giường', thanh_tien: 100000, payment_group: 'bhyt' }], tong_hop: { tong_chi_phi: 100000 } },
      };
      out[item._progress_key] = Object.fromEntries(files.map(f => [f, all[f]]));
    }
    fs.writeFileSync(args[args.indexOf('--out') + 1], JSON.stringify(out), 'utf-8');
    return { code: 0 };
  },
};

const store = require('../server/services/hchanh_stay_store');
const router = require('../server/routes/research');
const fetchRun = router._fetchHchanhForResearchRun;

(async () => {
  // 333: tab Hành chánh đã lấy đủ 4 file (gồm bảng kê); 444: Kiểm hồ sơ mới có ra viện.
  store.recordHchanhFetch('333', {
    profile: { _fetch_status: 'ok', bhyt_code: 'HC-333', _admission_vitals_status: 'ok' },
    discharge: { _fetch_status: 'ok', ngay_ra: '28/09/2026', tong_so_ngay_dt: '9', xu_tri: 'Ra viện (HC)' },
    surgery: { _fetch_status: 'ok', surgeries: [{ noi_dung_phau_thuat: 'Kết hợp xương' }] },
    billing: { _fetch_status: 'ok', rows: [{ name: 'Ngày giường', thanh_tien: 300000, payment_group: 'bhyt' }], tong_hop: { tong_chi_phi: 300000 } },
  }, { admission: '08:00 20/09/2026', source: 'hanh_chanh' });
  store.recordHchanhFetch('444', {
    discharge: { _fetch_status: 'ok', ngay_ra: '28/09/2026', tong_so_ngay_dt: '9', xu_tri: 'Ra viện (KHS)' },
  }, { admission: '20/09/2026', source: 'kiem_ho_so' });

  const runDir = fs.mkdtempSync(path.join(RUNTIME_ROOT, 'run_'));
  const row = (bn, nc) => ({ 'Mã BN': bn, 'Họ tên': `BN ${bn}`, 'Mã NC': nc, 'Ngày vào viện': '21/09/2026', 'Ngày ra viện': '' });
  const sourceRows = [row('333', 'NC3'), row('444', 'NC4'), row('555', 'NC5')];
  const ctx = { sid: 'test_stay_store', dir: runDir, LOGS_DIR: path.join(runDir, 'logs') };
  const stats = await fetchRun(ctx, runDir, { sourceRows, sourceRunId: 'r1' });

  assert.deepStrictEqual(spawned.sort(), ['444:profile+surgery+billing', '555:profile+discharge+surgery+billing'],
    `Chỉ mở EMR cho phần còn thiếu, thực tế: ${spawned.join(', ')}`);
  assert.strictEqual(stats.reused, 1);
  assert.strictEqual(stats.error, 0);

  const discharge = fs.readFileSync(path.join(runDir, 'hchanh_discharge.csv'), 'utf-8');
  assert.ok(discharge.includes('Ra viện (HC)'), 'NC3 phải lấy ra viện từ kho Hành chánh');
  assert.ok(discharge.includes('Ra viện (KHS)'), 'NC4 phải giữ ra viện đã có từ Kiểm hồ sơ');
  const profile = fs.readFileSync(path.join(runDir, 'hchanh_profile.csv'), 'utf-8');
  assert.ok(profile.includes('EMR-444') && profile.includes('HC-333'));

  const log = fs.readFileSync(path.join(runDir, 'action_log.txt'), 'utf-8');
  assert.ok(log.includes('tab Hành chánh / Kiểm hồ sơ (dữ liệu tạm thời), không mở EMR lại'));
  assert.ok(log.includes('DÙNG MỘT PHẦN'));

  // Đánh dấu dữ liệu tạm thời: 333 dùng lại toàn bộ từ Hành chánh, 444 còn phần ra viện từ Kiểm hồ sơ.
  const progress = JSON.parse(fs.readFileSync(path.join(runDir, 'hchanh_auto_progress.json'), 'utf-8'));
  const byBn = bn => Object.values(progress).find(p => p.ma_bn === bn);
  assert.deepStrictEqual(byBn('333').provisional_files, ['profile', 'discharge', 'surgery', 'billing']);
  assert.deepStrictEqual(byBn('444').provisional_files, ['discharge']);
  assert.deepStrictEqual(byBn('555').provisional_files, []);

  // Phần Kho nghiên cứu tự quét là dữ liệu gốc: Hành chánh quét sau KHÔNG được ghi đè.
  const kept = store.recordHchanhFetch('555', { profile: { _fetch_status: 'ok', bhyt_code: 'HC-MOI' } }, { admission: '21/09/2026', source: 'hanh_chanh' });
  assert.strictEqual(kept.saved, false);
  assert.strictEqual(store.findStoredStay('555', '2026-09-21', ['profile']).output.profile.bhyt_code, 'EMR-555');
  // Ngược lại, quét của Kho nghiên cứu thay dữ liệu tạm thời.
  assert.strictEqual(store.findStoredStay('444', '2026-09-21', ['profile']).tiers.profile, 'goc');
  assert.strictEqual(store.findStoredStay('444', '2026-09-21', ['discharge']).tiers.discharge, 'tam_thoi');

  // Quét lại dữ liệu tạm thời: chỉ 333 và 444 được mở EMR lại, 555 (đã là gốc) giữ nguyên.
  spawned.length = 0;
  await fetchRun(ctx, runDir, { sourceRows, sourceRunId: 'r1', refreshProvisional: true });
  assert.deepStrictEqual(spawned.sort(), ['333:profile+discharge+surgery+billing', '444:discharge'],
    `Quét lại tạm thời, thực tế: ${spawned.join(', ')}`);
  const after = JSON.parse(fs.readFileSync(path.join(runDir, 'hchanh_auto_progress.json'), 'utf-8'));
  assert.ok(Object.values(after).every(p => (p.provisional_files || []).length === 0), 'sau khi quét lại không còn dữ liệu tạm thời');
  assert.strictEqual(store.findStoredStay('444', '2026-09-21', ['discharge']).tiers.discharge, 'goc');

  // force=true: bỏ qua kho, lấy lại toàn bộ từ EMR.
  spawned.length = 0;
  await fetchRun(ctx, runDir, { sourceRows: [row('333', 'NC3')], sourceRunId: 'r1', force: true });
  assert.deepStrictEqual(spawned, ['333:profile+discharge+surgery+billing']);

  // 666: tab Hành chánh lấy đủ 4 file nhưng bằng worker cũ: hồ sơ chưa đọc Phiếu vào viện (không có
  // sinh hiệu), bảng kê chưa có khối Tổng hợp chi phí. Không được dùng lại hai phần đó; chỉ mở EMR
  // lấy lại đúng hai phần, ra viện/phẫu thuật vẫn dùng lại.
  store.recordHchanhFetch('666', {
    profile: { _fetch_status: 'ok', bhyt_code: 'HC-666' },
    discharge: { _fetch_status: 'ok', ngay_ra: '28/09/2026', tong_so_ngay_dt: '9', xu_tri: 'Ra viện (HC)' },
    surgery: { _fetch_status: 'ok', surgeries: [] },
    billing: { _fetch_status: 'ok', rows: [{ name: 'Ngày giường', thanh_tien: 300000, payment_group: 'bhyt' }] },
  }, { admission: '08:00 20/09/2026', source: 'hanh_chanh' });
  spawned.length = 0;
  const runDir2 = fs.mkdtempSync(path.join(RUNTIME_ROOT, 'run_'));
  await fetchRun({ ...ctx, dir: runDir2 }, runDir2, { sourceRows: [row('666', 'NC6')], sourceRunId: 'r2' });
  assert.deepStrictEqual(spawned, ['666:profile+billing'], `Bản cũ thiếu sinh hiệu/Tổng hợp chi phí, thực tế: ${spawned.join(', ')}`);
  const p666 = Object.values(JSON.parse(fs.readFileSync(path.join(runDir2, 'hchanh_auto_progress.json'), 'utf-8')))[0];
  assert.strictEqual(p666.file_status.profile.payload_version, 2);
  assert.strictEqual(p666.file_status.billing.payload_version, 2);
  assert.ok(fs.readFileSync(path.join(runDir2, 'hchanh_profile.csv'), 'utf-8').includes('EMR-666'));

  fs.rmSync(RUNTIME_ROOT, { recursive: true, force: true });
  console.log('research_hchanh_stay_store_reuse_test: OK');
})().catch(err => { console.error(err); process.exit(1); });
