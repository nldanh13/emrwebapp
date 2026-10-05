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
    'T/G vào': `08:00 ${String(1 + (i % 27)).padStart(2, '0')}/02/2026`, 'Mã BN': `10${String(i % 40).padStart(5, '0')}`,
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
  console.log('\n5 nhóm kiểm thử pass.');
})().catch(err => { console.error(err); process.exitCode = 1; });
