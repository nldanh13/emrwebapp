#!/usr/bin/env node
'use strict';
// Cú pháp SPSS đi kèm file "Biến đã chọn": cột trong cú pháp phải khớp đúng header file CSV xuất
// (cùng cách ẩn định danh), cột số chỉ khi mọi ô là số, nhãn biến/nhãn giá trị lấy từ Từ điển biến.
// Danh sách ca thiếu dữ liệu chỉ có Mã NC và tên biến, tính từ cùng dataset với thống kê.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.EMR_RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'study_spss_'));
const { writeCsv } = require('../server/research/table_io');
const { archiveRunsDir, ensureArchiveStore, studyMetaPath, runsDir, studyDir } = require('../server/research/store_paths');
const { readStudy } = require('../server/research/run_registry');
const { buildStudySpssSyntax, buildStudyCodebook } = require('../server/research/study_variables');
const { buildSpssSyntax, spssVariableNames, columnFormat, parseValueLabels } = require('../server/research/spss_syntax');
const { missingVariablesByCase } = require('../server/research/variable_selection');
const { summarizeSelectionForRun } = require('../server/research/selection_runtime');
const { sendCsvFile } = require('../server/research/research_http');

let failed = 0;
let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
console.log('research_spss_syntax_test');

// Lấy header của file CSV mà nút Xuất CSV thật sự gửi về (qua sendCsvFile).
function exportedHeader(filePath, redact) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const { Writable } = require('stream');
    const res = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
    res.setHeader = () => {};
    res.status = () => res;
    res.json = (body) => reject(new Error(JSON.stringify(body)));
    res.on('finish', () => {
      const text = Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '');
      resolve(text.split(/\r?\n/)[0].split(','));
    });
    res.on('error', reject);
    sendCsvFile(res, filePath, 'x', { redact });
  });
}

test('tên biến SPSS hợp lệ: không dấu, bắt đầu bằng chữ, ≤ 64 byte, không trùng, tránh từ khóa', () => {
  const names = spssVariableNames(['Tuổi', 'tuoi', '1_ngay', 'BY', 'x'.repeat(90), 'x'.repeat(90), 'đường huyết']);
  assert.deepStrictEqual(names.slice(0, 4), ['Tuoi', 'tuoi_2', 'v_1_ngay', 'BY_']);
  assert.ok(names.every(n => /^[A-Za-z][A-Za-z0-9_]*$/.test(n) && Buffer.byteLength(n) <= 64), names.join(' | '));
  assert.notStrictEqual(names[4], names[5]);
  assert.strictEqual(names[6], 'duong_huyet');
});

test('cột "Liệt kê giá trị" có ô "5; 6" đọc dạng chuỗi, không thành số (không mất dữ liệu)', () => {
  assert.strictEqual(columnFormat(['5', '6.25', '']).kind, 'number');
  assert.strictEqual(columnFormat(['5', '6.25']).format, 'F8.2');
  assert.strictEqual(columnFormat(['5; 6', '7']).kind, 'string');
  assert.strictEqual(columnFormat(['2026-01-02']).kind, 'string');
  assert.strictEqual(columnFormat(['Nữ']).format, `A${Buffer.byteLength('Nữ')}`);
  assert.strictEqual(columnFormat(['', '']).format, 'A1');
});

test('nhãn giá trị đọc từ cột Mã hóa', () => {
  assert.deepStrictEqual(parseValueLabels('1 = Có, 0 = Không'), [['1', 'Có'], ['0', 'Không']]);
  assert.deepStrictEqual(parseValueLabels(''), []);
});

test('cú pháp: GET DATA đủ cột theo thứ tự, nhãn biến tiếng Việt, nhãn giá trị 0/1, nháy đơn được thoát', () => {
  const syntax = buildSpssSyntax({
    columns: ['research_code', 'tuoi', 'co_dung_statin'],
    rows: [{ research_code: 'NC1', tuoi: '70', co_dung_statin: '1' }, { research_code: 'NC2', tuoi: '', co_dung_statin: '0' }],
    codebook: [
      { cot: 'research_code', nhan: 'Mã nghiên cứu', don_vi: '', ma_hoa: '' },
      { cot: 'tuoi', nhan: "Tuổi lúc vào viện (bệnh nhân's)", don_vi: 'năm', ma_hoa: '' },
      { cot: 'co_dung_statin', nhan: 'Dùng statin', don_vi: '', ma_hoa: '1 = Có, 0 = Không' },
    ],
    csvFilename: 'nc_analysis_selected.csv',
  });
  assert.ok(syntax.startsWith('* Encoding: UTF-8.'));
  const vars = syntax.split('/VARIABLES=')[1].split('\r\n.\r\n')[0].trim().split(/\r?\n/).map(l => l.trim().split(' ')[0]);
  assert.deepStrictEqual(vars, ['research_code', 'tuoi', 'co_dung_statin']);
  assert.match(syntax, /tuoi F8\.0/);
  assert.match(syntax, /research_code A3/);
  assert.match(syntax, /tuoi 'Tuổi lúc vào viện \(bệnh nhân''s\) \(năm\)'/);
  assert.match(syntax, /VALUE LABELS\r\n {2}co_dung_statin 1 'Có' 0 'Không'\r\n\./);
  assert.match(syntax, /FILE HANDLE duLieu \/NAME='nc_analysis_selected\.csv'\./);
  assert.match(syntax, /EXECUTE\.\r\n$/);
});

// ── Dựng nghiên cứu thật trong thư mục tạm ────────────────────────────────
ensureArchiveStore();
fs.mkdirSync(path.join(archiveRunsDir(), '20260101_000000'), { recursive: true });
const STUDY = 'nc_spss';
fs.mkdirSync(studyDir(STUDY), { recursive: true });
const sexVar = { id: 'analysis_ready.sex', table: 'analysis_ready', name: 'sex', label: 'Giới tính', type: 'category' };
const ageVar = { id: 'analysis_ready.age', table: 'analysis_ready', name: 'age', label: 'Tuổi', type: 'number' };
const selection = { selected_variables: [sexVar, ageVar], conditions: [] };
fs.writeFileSync(studyMetaPath(STUDY), JSON.stringify({ id: STUDY, name: 'NC SPSS', analysis_config: { preset: 'general', custom_fields: [], variable_selection: selection }, variable_selection: selection }));
const runDir = path.join(runsDir(STUDY), '20260102_000000');
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({ run_id: '20260102_000000' }));
writeCsv(path.join(runDir, 'analysis_ready.csv'), ['research_code', 'encounter_id', 'patient_code', 'patient_key', 'sex', 'age'], [
  { research_code: 'NC1', encounter_id: 'e1', patient_code: '1001', patient_key: 'p1', sex: 'Nữ', age: '70' },
  { research_code: 'NC2', encounter_id: 'e2', patient_code: '1002', patient_key: 'p2', sex: '', age: '' },
  { research_code: 'NC3', encounter_id: 'e3', patient_code: '1003', patient_key: 'p3', sex: 'Nam', age: '' },
]);

test('cột của cú pháp khớp đúng header file CSV xuất (ẩn định danh: không có Mã BN)', async () => {
  const study = readStudy(STUDY);
  const out = buildStudySpssSyntax(study, { redact: true });
  const header = await exportedHeader(path.join(runDir, 'analysis_selected.csv'), true);
  assert.deepStrictEqual(out.columns, header);
  assert.ok(!out.columns.includes('patient_code'));
  assert.ok(!/1001|1002|1003/.test(out.syntax), 'cú pháp không chứa Mã BN');
  assert.ok(!/Nữ'|NC1/.test(out.syntax.split('VARIABLE LABELS')[0]), 'cú pháp không chứa giá trị dữ liệu');
  const vars = out.syntax.split('/VARIABLES=')[1].split('\r\n.\r\n')[0].trim().split(/\r?\n/).length;
  assert.strictEqual(vars, header.length);
  assert.match(out.syntax, new RegExp(`/NAME='${out.base_name}\\.csv'`));
});

test('xuất có định danh: cột khớp header có Mã BN', async () => {
  const out = buildStudySpssSyntax(readStudy(STUDY), { redact: false });
  const header = await exportedHeader(path.join(runDir, 'analysis_selected.csv'), false);
  assert.deepStrictEqual(out.columns, header);
  assert.ok(out.columns.includes('patient_code'));
});

test('nhãn biến lấy từ Từ điển biến của cùng file', () => {
  const study = readStudy(STUDY);
  const book = buildStudyCodebook(study);
  const out = buildStudySpssSyntax(study, { redact: true });
  const age = book.rows.find(r => r.ma_bien_nguon === 'analysis_ready.age');
  assert.ok(out.syntax.includes(`'${age.nhan}'`), out.syntax);
});

test('ca thiếu dữ liệu: cùng dataset với thống kê, chỉ Mã NC và tên biến, ca thiếu nhiều lên trước', () => {
  const { summary } = summarizeSelectionForRun(runDir, readStudy(STUDY).variable_selection);
  assert.strictEqual(summary.missing_by_case_total, 2);
  assert.deepStrictEqual(summary.missing_by_case.map(c => c.research_code), ['NC2', 'NC3']);
  assert.deepStrictEqual(summary.missing_by_case[0].missing, ['Giới tính', 'Tuổi']);
  assert.strictEqual(summary.missing_by_case[1].missing_count, 1);
  const keys = new Set(summary.missing_by_case.flatMap(c => Object.keys(c)));
  assert.deepStrictEqual([...keys].sort(), ['missing', 'missing_count', 'needs_review', 'research_code']);
  assert.strictEqual(summary.partial + summary.empty, summary.missing_by_case_total);
});

test('ca thiếu dữ liệu: giới hạn số dòng nhưng vẫn báo đủ tổng số', () => {
  const vars = [{ output_column: 'a', survey_label: 'A' }];
  const rows = Array.from({ length: 5 }, (_, i) => ({ research_code: `NC${i}`, a: '' }));
  const r = missingVariablesByCase(rows, vars, 2);
  assert.strictEqual(r.total, 5);
  assert.strictEqual(r.cases.length, 2);
  assert.strictEqual(missingVariablesByCase([{ research_code: 'X', a: '1' }], vars).total, 0);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed += 1; console.log(`  ok - ${name}`); } catch (e) { failed += 1; console.error(`  FAIL - ${name}\n`, e); }
  }
  if (failed) process.exit(1);
  console.log(`${passed} test(s) passed.`);
})();
