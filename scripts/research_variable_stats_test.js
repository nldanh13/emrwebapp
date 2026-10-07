#!/usr/bin/env node
'use strict';

// Thống kê mô tả biến cho màn hình Tạo nghiên cứu / Thống kê nghiên cứu: đúng số liệu, đúng
// loại đo lường, và văn bản tự do không bị đưa giá trị ra màn hình.
// Chạy: node scripts/research_variable_stats_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Thư mục runtime tạm, đặt trước khi nạp module server (constants đọc biến này lúc nạp).
process.env.EMR_RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'research_variable_stats_test_'));
const { describeValues, summarizeSelectedDataset, buildSelectedAnalysisDataset } = require('../server/research/variable_selection');
const { extractTScore } = require('../server/research/value_normalizers');
const { buildVariableCatalog } = require('../server/research/variable_catalog');
const { writeCsv } = require('../server/research/table_io');
const { summarizeSelectionForRun } = require('../server/research/selection_runtime');

let passed = 0;
const pending = [];
function test(name, fn) {
  pending.push((async () => {
    try { await fn(); passed += 1; console.log(`  ok - ${name}`); } catch (err) { console.error(`  FAIL - ${name}`); console.error(err); process.exitCode = 1; }
  })());
}

test('biến số: n, trung bình, SD, trung vị, tứ phân vị, khoảng; đếm giá trị không phải số', () => {
  const s = describeValues({ type: 'number' }, ['10', '20', '30', '40', 'âm tính', '']);
  assert.strictEqual(s.kind, 'number');
  assert.strictEqual(s.n, 5);
  assert.strictEqual(s.n_numeric, 4);
  assert.strictEqual(s.non_numeric, 1);
  assert.strictEqual(s.mean, 25);
  assert.strictEqual(s.median, 25);
  assert.strictEqual(s.min, 10);
  assert.strictEqual(s.max, 40);
  assert.strictEqual(s.sd, 12.91);
});

test('biến phân loại: top giá trị kèm %, gom phần còn lại thành "nhóm khác"', () => {
  const values = ['A', 'A', 'A', 'B', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const s = describeValues({ type: 'category' }, values);
  assert.strictEqual(s.kind, 'category');
  assert.deepStrictEqual(s.top[0], { value: 'A', count: 3, pct: 27.3 });
  assert.strictEqual(s.top.length, 6);
  assert.deepStrictEqual(s.other, { groups: 2, count: 2, pct: 18.2 });
});

test('cách lấy "Có / không" và "Số lần" đổi loại đo lường tương ứng', () => {
  assert.strictEqual(describeValues({ type: 'text', aggregation: 'any' }, ['1', '0']).kind, 'category');
  assert.strictEqual(describeValues({ type: 'text', aggregation: 'count' }, ['3', '0']).kind, 'number');
});

test('ngày: khoảng từ–đến; văn bản tự do: không trả giá trị', () => {
  const d = describeValues({ type: 'date' }, ['05/03/2026', '2026-01-02', '']);
  assert.deepStrictEqual([d.kind, d.min, d.max], ['date', '02/01/2026', '05/03/2026']);
  const t = describeValues({ type: 'text' }, Array.from({ length: 25 }, (_, i) => `BN GIA LAP ${i}`));
  assert.strictEqual(t.kind, 'text');
  assert.strictEqual(t.distinct, 25);
  assert.ok(!('top' in t), 'không có danh sách giá trị');
  assert.ok(!JSON.stringify(t).includes('GIA LAP'), 'không lộ nội dung văn bản');
});

test('CĐHA xuất nội dung kết quả; DXA tách T-score thành biến số', () => {
  assert.strictEqual(extractTScore('L1-L4 T-score: -2,7; Z-score: -1,1'), '-2.7');
  assert.strictEqual(extractTScore('Z-score: -1.1'), '');
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imaging_catalog_'));
  writeCsv(path.join(runDir, 'imaging_results.csv'), [
    'imaging_id', 'research_code', 'encounter_id', 'patient_code', 'encounter_match_status',
    'is_within_encounter', 'modality', 'result_text', 'conclusion_text'
  ], [
    { imaging_id: 'i1', research_code: 'NC1', encounter_id: 'e1', patient_code: 'P1', encounter_match_status: 'matched', is_within_encounter: '1', modality: 'DEXA', result_text: 'T-score: -2.7', conclusion_text: 'Loãng xương' },
    { imaging_id: 'i2', research_code: 'NC1', encounter_id: 'e1', patient_code: 'P1', encounter_match_status: 'matched', is_within_encounter: '1', modality: 'CT', result_text: 'Không thấy tổn thương cấp', conclusion_text: '' },
  ]);
  const catalog = buildVariableCatalog(runDir);
  const variables = catalog.groups.find(g => g.key === 'imaging_results').variables;
  const dexaResult = variables.find(v => v.name === 'imaging:DEXA');
  const tScore = variables.find(v => v.virtual_kind === 'imaging_t_score');
  assert.strictEqual(dexaResult.type, 'text');
  assert.match(dexaResult.label, /Kết quả/);
  assert.strictEqual(tScore.type, 'number');
  assert.strictEqual(tScore.aggregation, 'mean');

  const built = buildSelectedAnalysisDataset([
    { research_code: 'NC1', encounter_id: 'e1', patient_code: 'P1' },
  ], { selected_variables: [dexaResult, tScore] }, { imaging_results: [
    { research_code: 'NC1', encounter_id: 'e1', patient_code: 'P1', encounter_match_status: 'matched', is_within_encounter: '1', modality: 'DEXA', result_text: 'T-score: -2.7', conclusion_text: 'Loãng xương' },
    { research_code: 'NC1', encounter_id: 'e1', patient_code: 'P1', encounter_match_status: 'matched', is_within_encounter: '1', modality: 'CT', result_text: 'Không thấy tổn thương cấp', conclusion_text: '' },
  ] });
  const scoreCol = built.manifest.variables.find(v => v.virtual_kind === 'imaging_t_score').output_column;
  const reportCol = built.manifest.variables.find(v => v.virtual_kind === 'imaging_modality').output_column;
  assert.strictEqual(built.rows[0][scoreCol], '-2.7');
  assert.match(built.rows[0][reportCol], /T-score: -2.7.*Loãng xương/);
  assert.ok(!built.rows[0][reportCol].includes('Không thấy tổn thương cấp'), 'không lấy kết quả CT vào biến DXA');
});

test('summary có thống kê từng biến và tóm tắt mẫu (tuổi, giới, số người bệnh)', () => {
  const dataset = {
    rows: [
      { patient_key: 'P1', age: '60', sex: 'Nam', hospital_stay_days: '5', var_hb: '120', encounter_id: 'e1' },
      { patient_key: 'P1', age: '61', sex: 'Nam', hospital_stay_days: '7', var_hb: '', encounter_id: 'e2' },
      { patient_key: 'P2', age: '70', sex: 'Nữ', hospital_stay_days: '9', var_hb: '100', encounter_id: 'e3' },
    ],
    manifest: { variables: [{ id: 'lab.hb', label: 'Hb', survey_label: 'Hb trước mổ', type: 'number', output_column: 'var_hb' }] },
  };
  const s = summarizeSelectedDataset(dataset);
  assert.strictEqual(s.cohort.encounters, 3);
  assert.strictEqual(s.cohort.patients, 2);
  assert.strictEqual(s.cohort.age.median, 61);
  assert.strictEqual(s.cohort.sex.top[0].value, 'Nam');
  assert.strictEqual(s.variables[0].fill_rate, 66.7);
  assert.strictEqual(s.variables[0].stats.mean, 110);
});

test('summarizeSelectionForRun đọc run thật: có và không có điều kiện chọn mẫu', () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'research_variable_stats_'));
  fs.writeFileSync(path.join(runDir, 'analysis_ready.csv'), [
    'research_code,encounter_id,patient_key,sex,age',
    'NC1,e1,P1,Nam,60',
    'NC2,e2,P2,Nữ,72',
    'NC3,e3,P3,Nam,45',
  ].join('\n'));
  const variable = { id: 'analysis_ready.age', table: 'analysis_ready', name: 'age', label: 'Tuổi', type: 'number' };
  const all = summarizeSelectionForRun(runDir, { selected_variables: [variable] });
  assert.strictEqual(all.summary.total, 3);
  assert.strictEqual(all.summary.variables[0].stats.median, 60);
  const filtered = summarizeSelectionForRun(runDir, {
    selected_variables: [variable],
    conditions: [{ variable_id: variable.id, table: 'analysis_ready', name: 'age', type: 'number', operator: '>=', value: '50' }],
  });
  assert.strictEqual(filtered.summary.total, 2, 'điều kiện tuổi ≥ 50 giữ 2 lượt');
  assert.strictEqual(filtered.source_total, 3);
  // Sàng lọc từng bước: toàn kho 3 lượt → tuổi ≥ 50 còn 2; nhãn điều kiện đọc được.
  assert.deepStrictEqual(filtered.summary.funnel.map(f => f.encounters), [3, 2]);
  assert.strictEqual(filtered.summary.funnel[1].label, 'Tuổi ≥ 50');
  assert.strictEqual(filtered.summary.funnel[0].patients, 3);
});

test('route xuất theo biến: tên cột theo phiếu, có Mã NC, không có Mã BN/họ tên', async () => {
  const express = require('express');
  const http = require('http');
  const { archiveRunsDir } = require('../server/research/store_paths');
  const runDir = path.join(archiveRunsDir(), '20260101_000000');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({ created_at: '2026-01-01T00:00:00Z' }));
  fs.writeFileSync(path.join(runDir, 'analysis_ready.csv'), [
    'research_code,encounter_id,patient_key,patient_code,patient_name,sex,age',
    'NC1,e1,P1,BN001,NGUYEN VAN A,Nam,60',
    'NC2,e2,P2,BN002,TRAN THI B,Nữ,40',
  ].join('\n'));
  const app = express();
  app.use(express.json());
  app.use('/api', require('../server/routes/research'));
  const server = http.createServer(app).listen(0);
  try {
    const port = server.address().port;
    const body = JSON.stringify({ variable_selection: {
      selected_variables: [
        { id: 'analysis_ready.sex', table: 'analysis_ready', name: 'sex', label: 'Giới tính', survey_label: '2. Giới tính', type: 'category' },
        { id: 'analysis_ready.patient_name', table: 'analysis_ready', name: 'patient_name', label: 'Họ tên', survey_label: 'Họ tên', type: 'text' },
      ],
      conditions: [{ variable_id: 'analysis_ready.age', table: 'analysis_ready', name: 'age', type: 'number', operator: '>=', value: '50' }],
    } });
    const csv = await new Promise((resolve, reject) => {
      const req = http.request({ port, path: '/api/research/archive/variable-export', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
        let data = ''; res.setEncoding('utf8'); res.on('data', c => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, data }));
      });
      req.on('error', reject); req.end(body);
    });
    assert.strictEqual(csv.status, 200, csv.data);
    const [header, ...lines] = csv.data.replace(/^\ufeff/, '').trim().split(/\r?\n/);
    assert.ok(header.split(',').includes('2. Giới tính'), header);
    assert.deepStrictEqual(header.split(','), ['Mã NC', 'Mã người bệnh (giả danh)', '2. Giới tính'], 'chỉ cột nhận diện + đúng biến đã chọn');
    assert.ok(!/Họ tên|BN00|NGUYEN/.test(csv.data), 'không có định danh');
    assert.strictEqual(lines.length, 1, 'chỉ lượt tuổi ≥ 50');
  } finally {
    server.close();
  }
});

Promise.all(pending).then(() => console.log(`${passed} test(s) passed`));
