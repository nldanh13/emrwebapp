#!/usr/bin/env node
'use strict';

// Quy trình dữ liệu cho tab Tổng quát: đọc đúng metadata các bước (quét, thu thập, chuẩn hóa,
// lưu trữ) từ thư mục đợt; không đọc nội dung dữ liệu người bệnh.
// Chạy: node scripts/research_pipeline_info_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.EMR_RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'research_pipeline_info_test_'));
const { buildPipelineInfo } = require('../server/research/pipeline_info');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); } catch (err) { console.error(`  FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}

const scopeDir = path.join(process.env.EMR_RUNTIME_ROOT, 'research', 'research_store', 'du_lieu_goc');
const runDir = path.join(scopeDir, 'runs', 'r1');
fs.mkdirSync(runDir, { recursive: true });
const write = (file, value) => fs.writeFileSync(path.join(runDir, file), typeof value === 'string' ? value : JSON.stringify(value));

test('chưa có đợt chạy → exists=false', () => {
  assert.deepStrictEqual(buildPipelineInfo(scopeDir, path.join(scopeDir, 'runs', 'khong_co')), { exists: false });
});

test('đọc đủ 4 bước từ manifest, normalize_state, qa_report, collection_report', () => {
  write('manifest.json', {
    created_at: '2026-05-29T09:26:15Z', from_date: '2026-01-01', to_date: '2026-05-29',
    normalized_at: '2026-05-30T01:05:00Z', normalized_schema_version: 15,
    normalized_outputs: { initial_list: 3127, encounters: 3100, lab_results: 90000, unmatched_lab_results: 12, kho_nguoi_benh: { cases: 5, provisional: 2, replaced_by_goc: 3 } },
    normalized_database: { database_file: 'research.sqlite3', size_bytes: 9000000, updated_at: '2026-05-30T01:05:00Z', tables: [{}, {}] },
    normalized_database_status: 'ok',
  });
  write('normalize_state.json', { status: 'complete', started_at: '2026-05-30T01:04:55.000Z', finished_at: '2026-05-30T01:05:00.000Z' });
  write('qa_report.json', { status: 'warning', blocking_count: 0, warning_count: 2 });
  write('collection_report.json', { finished_at: '2026-05-30T01:00:00Z', fetched_encounters: 120, skipped_unchanged: 2980, parts_backfilled: 14, selenium_errors_open: 3, unmatched_encounters: 2, diagnostics: [{ stage: 'patient_search', stage_label: '1. Tìm người bệnh', message: 'Không tìm thấy người bệnh theo Mã BN trên EMR.', rows: 2, encounters: 2 }] });
  write('collection_history.jsonl', '{"a":1}\n{"a":2}\n');
  write('normalize_history.jsonl', '{"at":"2026-05-29T10:00:00Z","counts":{"encounters":3000}}\nhỏng\n{"at":"2026-05-30T01:05:00Z","counts":{"encounters":3100,"lab_results":90000}}\n');
  write('encounters.csv', 'encounter_id\ne1\n');

  const p = buildPipelineInfo(scopeDir, runDir);
  assert.strictEqual(p.scan.rows, 3127);
  assert.strictEqual(p.scan.from_date, '2026-01-01');
  assert.strictEqual(p.collect.fetched_encounters, 120);
  assert.strictEqual(p.collect.selenium_errors_open, 3);
  assert.strictEqual(p.collect.diagnostics[0].stage, 'patient_search');
  assert.strictEqual(p.collect.diagnostics[0].encounters, 2);
  assert.strictEqual(p.collect_runs, 2);
  assert.deepStrictEqual(p.reused_from_patient_db, { cases: 5, provisional: 2, replaced_by_goc: 3 });
  assert.strictEqual(p.normalize.duration_ms, 5000);
  assert.deepStrictEqual(p.normalize.qa, { status: 'warning', blocking: 0, warning: 2, review: 0 });
  assert.deepStrictEqual(p.normalize.unmatched, [{ key: 'unmatched_lab_results', label: 'Xét nghiệm', rows: 12 }]);
  assert.deepStrictEqual(p.normalize.history.map(h => h.encounters), [3100, 3000], 'mới nhất trước, bỏ dòng hỏng');
  assert.strictEqual(p.storage.run_dir, 'research/research_store/du_lieu_goc/runs/r1', 'đường dẫn tương đối, không lộ đường dẫn máy');
  assert.strictEqual(p.storage.sqlite.table_count, 2);
  const enc = p.storage.tables.find(t => t.key === 'encounters');
  assert.strictEqual(enc.rows, 3100);
  assert.strictEqual(enc.exists, true);
  assert.strictEqual(p.storage.tables.find(t => t.key === 'lab_results').exists, false);
});

test('lấy dữ liệu sau lần chuẩn hóa: báo thời điểm lấy gần nhất và cần chuẩn hóa lại; quét lại lấy giờ ghi danh sách', () => {
  const setTime = (file, iso) => { const t = new Date(iso); fs.utimesSync(path.join(runDir, file), t, t); };
  write('du_lieu_ban_dau.csv', 'ma_bn\n1\n');
  setTime('du_lieu_ban_dau.csv', '2026-09-23T10:50:00Z');
  write('hchanh_auto_progress.json', {});
  setTime('hchanh_auto_progress.json', '2026-10-04T08:00:00Z');
  setTime('collection_report.json', '2026-05-30T01:00:00Z');
  let p = buildPipelineInfo(scopeDir, runDir);
  assert.strictEqual(p.scan.at, '2026-09-23T10:50:00.000Z', 'quét lại trong cùng đợt: không hiện ngày tạo đợt 29/05');
  assert.strictEqual(p.scan.first_at, '2026-05-29T09:26:15Z');
  assert.strictEqual(p.fetch.last_at, '2026-10-04T08:00:00.000Z');
  assert.strictEqual(p.fetch.pending_normalize, true, 'lấy 4/10, chuẩn hóa 30/05 → chưa gồm dữ liệu mới');
  assert.ok(p.fetch.parts.some(x => x.label.startsWith('Hồ sơ nền')));
  // Chuẩn hóa sau lần lấy → hết báo.
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8'));
  write('manifest.json', { ...manifest, normalized_at: '2026-10-04T09:00:00Z' });
  p = buildPipelineInfo(scopeDir, runDir);
  assert.strictEqual(p.fetch.pending_normalize, false);
});

console.log(`${passed} test(s) passed`);
