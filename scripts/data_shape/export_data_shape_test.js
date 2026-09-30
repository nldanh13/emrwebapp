#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildDataShapeBundle } = require('./export_data_shape');

function findCoverageRow(csvText, tableName, fieldName) {
  const lines = csvText.trim().split(/\r?\n/);
  const headers = lines[0].split(',');
  for (const line of lines.slice(1)) {
    const values = line.split(',');
    const row = Object.fromEntries(headers.map((header, idx) => [header, values[idx]]));
    if (row.table_name === tableName && row.field_name === fieldName) return row;
  }
  return null;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'data-shape-test-'));
try {
  const sourceRoot = path.join(tmp, 'source');
  const dataDir = path.join(sourceRoot, 'research_store');
  const outDir = path.join(tmp, 'bundle');
  fs.mkdirSync(dataDir, { recursive: true });

  const csvFile = path.join(dataDir, 'large_patients.csv');
  const lines = ['patient_code,sex,note'];
  for (let i = 0; i < 70000; i += 1) {
    const code = `2600${String(i).padStart(6, '0')}`;
    const sex = i % 2 ? 'Nam' : '';
    const note = i === 10 ? '"ghi chú có dấu phẩy, và\nxuống dòng"' : `"Nội dung riêng ${i}"`;
    lines.push(`${code},${sex},${note}`);
  }
  fs.writeFileSync(csvFile, lines.join('\r\n') + '\r\n', 'utf8');
  assert(fs.statSync(csvFile).size > 2 * 1024 * 1024, 'Dữ liệu test phải lớn hơn giới hạn cũ 2 MB');

  const result = buildDataShapeBundle({ sourceRoot, outDir });
  assert.strictEqual(result.manifest.bundle_version, 2);
  assert.strictEqual(result.manifest.files_scanned, 1);
  assert.strictEqual(result.manifest.safety.large_csv_streamed, true);

  const group = result.manifest.groups.find(item => item.group_key === 'research_store/large_patients.csv');
  assert(group, 'Phải có nhóm CSV lớn');
  assert.strictEqual(group.records_observed, 70000, 'Dòng có xuống hàng trong dấu nháy không được tính thành bản ghi mới');
  assert.strictEqual(group.full_scan, true);

  const coverageText = fs.readFileSync(path.join(outDir, 'coverage_summary.csv'), 'utf8');
  const patientCode = findCoverageRow(coverageText, group.group_key, 'patient_code');
  const sex = findCoverageRow(coverageText, group.group_key, 'sex');
  assert(patientCode, 'Phải có coverage cho patient_code');
  assert(sex, 'Phải có coverage cho sex');
  assert.strictEqual(Number(patientCode.total_rows), 70000);
  assert.strictEqual(Number(patientCode.non_empty_rows), 70000);
  assert.strictEqual(Number(patientCode.coverage_pct), 100);
  assert.strictEqual(patientCode.distinct_count_capped, 'true');
  assert.strictEqual(Number(sex.non_empty_rows), 35000);
  assert.strictEqual(Number(sex.empty_rows), 35000);
  assert.strictEqual(Number(sex.coverage_pct), 50);

  const allBundleText = fs.readdirSync(outDir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => fs.readFileSync(path.join(entry.parentPath || entry.path, entry.name), 'utf8'))
    .join('\n');
  assert(!allBundleText.includes('Nội dung riêng 69999'), 'Bundle không được chứa nội dung thật');
  assert(!result.redactionReport.excluded_files.some(item => item.path.endsWith('large_patients.csv')), 'CSV lớn không được loại trừ');

  console.log('export_data_shape_test: OK');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
