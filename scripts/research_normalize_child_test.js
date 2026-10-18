#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.EMR_RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'research_normalize_child_'));
delete process.env.EMR_NORMALIZE_INLINE;
const { runNormalizeJob, normalizeRunning } = require('../server/research/normalize_runner');
const { RESEARCH_SCOPE_LOCKS, listRunningResearch } = require('../server/research/research_http');
const { captureNormalizeInputs, changedNormalizeInputs, evaluateNormalizationIntegrity } = require('../server/research/normalization_integrity');

function writeCsv(file, cols, rows) {
  const esc = v => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
  fs.writeFileSync(file, `﻿${[cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n')}\n`);
}

(async () => {
  const runDir = path.join(process.env.EMR_RUNTIME_ROOT, 'store', 'kho', 'runs', 'r1');
  fs.mkdirSync(runDir, { recursive: true });
  const rows = Array.from({ length: 60 }, (_, i) => ({
    'T/G vào': `08:00 ${String(1 + (i % 27)).padStart(2, '0')}/02/2026`, 'Mã BN': `10${String(i).padStart(5, '0')}`,
    'Mã nội trú': `nt-${i}`, 'Họ tên': `BN GIA LAP ${i}`, 'Ngày ra viện': '28/02/2026',
  }));
  writeCsv(path.join(runDir, 'du_lieu_ban_dau.csv'), ['T/G vào', 'Mã BN', 'Mã nội trú', 'Họ tên', 'Ngày ra viện'], rows);

  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 5);
  const started = Date.now();
  const result = await runNormalizeJob({ kind: 'run', runDir, options: { sourceRunId: 'r1', force: true } });
  const elapsed = Date.now() - started;
  clearInterval(timer);

  assert.ok(result && result.cached === false, 'trả về kết quả chuẩn hóa từ tiến trình con');
  assert.strictEqual(Number(result.encounters), 60);
  assert.ok(fs.existsSync(path.join(runDir, 'analysis_ready.csv')), 'đã ghi bảng chuẩn');
  const normalizedState = JSON.parse(fs.readFileSync(path.join(runDir, 'normalize_state.json'), 'utf8'));
  assert.strictEqual(normalizedState.status, 'complete');
  assert.ok(['completed_clean', 'completed_with_warnings'].includes(normalizedState.integrity_status), `integrity state hợp lệ: ${normalizedState.integrity_status}`);
  assert.ok(fs.existsSync(path.join(runDir, 'integrity_report.json')), 'đã ghi integrity_report.json');
  assert.ok(result.integrity && result.integrity.status === normalizedState.integrity_status, 'API trả cùng integrity status với normalize_state');
  assert.ok(ticks >= Math.floor(elapsed / 5) * 0.3, `event loop không bị chặn (${ticks} tick trong ${elapsed} ms)`);
  console.log(`  ok - chuẩn hóa ở tiến trình riêng + integrity gate: ${result.encounters} lượt, ${elapsed} ms, ${ticks} tick`);

  const snap1 = captureNormalizeInputs(runDir);
  fs.appendFileSync(path.join(runDir, 'du_lieu_ban_dau.csv'), '\n');
  const snap2 = captureNormalizeInputs(runDir);
  assert.ok(changedNormalizeInputs(snap1, snap2).includes('du_lieu_ban_dau.csv'));
  console.log('  ok - fingerprint phát hiện nguồn thu thập thay đổi giữa chừng');

  // Bước repair raw PT trong chính tiến trình Chuẩn hóa ghi lại hchanh_surgery.csv. Lần ghi đó
  // không phải "Thu thập đổi nguồn giữa chừng" nên không được thành lỗi chặn.
  const surgeryDir = path.join(process.env.EMR_RUNTIME_ROOT, 'store', 'kho', 'runs', 'r_surgery');
  fs.mkdirSync(surgeryDir, { recursive: true });
  fs.copyFileSync(path.join(runDir, 'du_lieu_ban_dau.csv'), path.join(surgeryDir, 'du_lieu_ban_dau.csv'));
  writeCsv(path.join(surgeryDir, 'hchanh_surgery.csv'), ['Mã BN', 'Ngày phẫu thuật', 'Raw JSON'], [
    { 'Mã BN': '1000000', 'Ngày phẫu thuật': '08:15', 'Raw JSON': JSON.stringify({ thoi_gian: '05/02/2026 07:30', detail: { bat_dau: '08:15' } }) },
  ]);
  const surgeryBefore = captureNormalizeInputs(surgeryDir);
  const surgeryResult = await runNormalizeJob({ kind: 'run', runDir: surgeryDir, options: { sourceRunId: 'r_surgery', force: true } });
  assert.strictEqual(Number(surgeryResult.surgery_raw_repair?.changed), 1, 'repair raw PT đã ghi lại file nguồn');
  assert.notStrictEqual(captureNormalizeInputs(surgeryDir).files['hchanh_surgery.csv'].sha256, surgeryBefore.files['hchanh_surgery.csv'].sha256);
  const surgeryIntegrity = JSON.parse(fs.readFileSync(path.join(surgeryDir, 'integrity_report.json'), 'utf8'));
  assert.ok(!surgeryIntegrity.critical.some(x => x.code === 'input_changed_during_normalize'),
    `lần ghi của chính repair không bị báo là nguồn đổi: ${JSON.stringify(surgeryIntegrity.input_snapshot)}`);
  assert.notStrictEqual(surgeryResult.integrity.status, 'failed_integrity');
  console.log('  ok - repair raw PT trong Chuẩn hóa không tự gây lỗi chặn input_changed_during_normalize');

  // Nhưng nếu Thu thập ghi chen vào sau bước repair thì hash sau khác hash repair đã ghi: vẫn chặn.
  const repairWrite = { file: 'hchanh_surgery.csv', sha256_before: 'a', sha256_after: 'b' };
  const snapA = { files: { 'hchanh_surgery.csv': { exists: true, sha256: 'a' } } };
  assert.deepStrictEqual(changedNormalizeInputs(snapA, { files: { 'hchanh_surgery.csv': { exists: true, sha256: 'b' } } }, [repairWrite]), []);
  assert.deepStrictEqual(changedNormalizeInputs(snapA, { files: { 'hchanh_surgery.csv': { exists: true, sha256: 'c' } } }, [repairWrite]), ['hchanh_surgery.csv']);
  assert.deepStrictEqual(changedNormalizeInputs({ files: { 'hchanh_surgery.csv': { exists: true, sha256: 'x' } } }, { files: { 'hchanh_surgery.csv': { exists: true, sha256: 'b' } } }, [repairWrite]), ['hchanh_surgery.csv']);
  assert.deepStrictEqual(changedNormalizeInputs(snapA, { files: { 'hchanh_surgery.csv': { exists: true, sha256: 'b' } } }, [{ ...repairWrite, sha256_before: '' }]), ['hchanh_surgery.csv']);
  console.log('  ok - nguồn bị Thu thập ghi chen trước/sau bước repair vẫn bị báo đổi');

  const badDir = path.join(process.env.EMR_RUNTIME_ROOT, 'integrity_bad');
  fs.mkdirSync(badDir, { recursive: true });
  writeCsv(path.join(badDir, 'encounters.csv'), ['encounter_id', 'research_code', 'patient_code', 'admission_date', 'discharge_date', 'emr_treatment_id'], [
    { encounter_id: 'e1', research_code: 'NC1', patient_code: 'BN1', admission_date: '2026-01-01', discharge_date: '2026-01-03', emr_treatment_id: 'T1' },
    { encounter_id: 'e2', research_code: 'NC2', patient_code: 'BN2', admission_date: '2026-02-01', discharge_date: '2026-02-03', emr_treatment_id: 'T1' },
  ]);
  writeCsv(path.join(badDir, 'surgery_results.csv'), ['surgery_id', 'patient_code', 'encounter_id', 'encounter_match_status', 'surgery_datetime', 'surgery_name', 'is_within_encounter'], [
    { surgery_id: 's1', patient_code: 'BN1', encounter_id: 'e1', encounter_match_status: 'matched', surgery_datetime: '2026-10-04 18:39', surgery_name: 'Rút đinh', is_within_encounter: '0' },
  ]);
  for (const file of ['lab_results.csv', 'imaging_results.csv', 'medication_orders.csv', 'clinical_notes.csv']) writeCsv(path.join(badDir, file), ['patient_code'], []);
  fs.writeFileSync(path.join(badDir, 'qa_report.json'), JSON.stringify({ status: 'ok', blocking: [], warnings: [], blocking_count: 0, warning_count: 0 }));
  fs.writeFileSync(path.join(badDir, 'normalize_state.json'), JSON.stringify({ status: 'complete' }));
  const integrity = evaluateNormalizationIntegrity(badDir);
  assert.strictEqual(integrity.status, 'failed_integrity');
  assert.ok(integrity.critical.some(x => x.code === 'strong_id_cross_patient'));
  assert.ok(integrity.critical.some(x => x.code === 'event_outside_encounter' && x.table === 'surgery_results'));
  const badQa = JSON.parse(fs.readFileSync(path.join(badDir, 'qa_report.json'), 'utf8'));
  assert.strictEqual(badQa.status, 'blocked');
  const badState = JSON.parse(fs.readFileSync(path.join(badDir, 'normalize_state.json'), 'utf8'));
  assert.strictEqual(badState.status, 'failed');
  assert.strictEqual(badState.integrity_status, 'failed_integrity');
  console.log('  ok - strong ID dùng chéo BN và PT ngoài đợt bị chặn ở tầng chuẩn hóa');

  const p1 = runNormalizeJob({ kind: 'run', runDir, options: { sourceRunId: 'r1', force: true }, scopeKey: 'archive' }, { reason: 'Sau thu thập tự động' });
  const p2 = runNormalizeJob({ kind: 'run', runDir, options: { sourceRunId: 'r1', force: true }, scopeKey: 'archive' });
  assert.strictEqual(p1, p2, 'yêu cầu trùng khi đang chờ thì gộp làm một');
  await new Promise(r => setTimeout(r, 20));
  assert.ok(normalizeRunning('archive'), 'đang chuẩn hóa có khóa archive:normalize');
  assert.ok(!RESEARCH_SCOPE_LOCKS.has('archive'), 'không giữ khóa Thu thập');
  const item = listRunningResearch().find(x => x.lane === 'normalize');
  assert.strictEqual(item.scope, 'archive');
  assert.strictEqual(item.reason, 'Sau thu thập tự động');
  await p1;
  assert.ok(!normalizeRunning('archive'), 'xong thì nhả khóa');
  console.log('  ok - chuẩn hóa có hàng đợi và khóa riêng, không đụng khóa Thu thập');

  await assert.rejects(runNormalizeJob({ kind: 'study', studyId: 'khong_ton_tai' }), 'lỗi ở tiến trình con được trả về');
  console.log('  ok - lỗi trong tiến trình con được báo lại cho máy chủ');

  fs.rmSync(process.env.EMR_RUNTIME_ROOT, { recursive: true, force: true });
  console.log('\n7 nhóm kiểm thử pass.');
})().catch(err => { console.error(err); process.exitCode = 1; });
