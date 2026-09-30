#!/usr/bin/env node
'use strict';

// Dữ liệu giả, không chứa thông tin người bệnh thật.
// Chặn hồi quy O(số lượt × toàn bộ kết quả) trong bước chuẩn hoá Kho nghiên cứu.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');

process.env.EMR_RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'research_normalize_perf_'));
const R = require('../server/routes/research')._test;
const patientDb = require('../server/services/patient_db');

const resultRows = [];
for (let patient = 0; patient < 1500; patient += 1) {
  const code = `P${String(patient).padStart(5, '0')}`;
  for (let day = 1; day <= 30; day += 1) {
    resultRows.push({
      'Mã BN': code,
      'TG chỉ định': `08:00 ${String(day).padStart(2, '0')}/09/2026`,
      'Chỉ số': 'HGB',
      'Kết quả': '120',
    });
  }
}

const startedAt = performance.now();
const index = R.buildResultDayIndex(resultRows);
for (let visit = 0; visit < 3127; visit += 1) {
  const code = `P${String(visit % 1500).padStart(5, '0')}`;
  assert.strictEqual(R.resultDayIndexHasRange(index, code, '2026-09-10', '2026-09-20'), true);
}
assert.strictEqual(R.resultDayIndexHasRange(index, 'P99999', '2026-09-10', '2026-09-20'), false);

R.addRowsToResultDayIndex(index, [{ 'Mã BN': 'P99999', 'TG chỉ định': '08:00 15/09/2026' }]);
assert.strictEqual(R.resultDayIndexHasRange(index, 'P99999', '2026-09-10', '2026-09-20'), true);

const elapsedMs = performance.now() - startedAt;
assert.ok(elapsedMs < 5000, `Chỉ mục ngày quá chậm: ${Math.round(elapsedMs)} ms`);

let overlayMs = 0;
if (patientDb.available()) {
  const sourceRows = Array.from({ length: 3127 }, (_, visit) => ({
    'Mã NC': `NC${String(visit + 1).padStart(5, '0')}`,
    'Mã BN': `P${String(visit % 1500).padStart(5, '0')}`,
    'Ngày vào viện': '10/09/2026',
    'Ngày ra viện': '20/09/2026',
  }));
  const overlayStartedAt = performance.now();
  const overlaid = R.overlayResultsFromPatientDb(process.env.EMR_RUNTIME_ROOT, sourceRows, 'perf', resultRows, []);
  overlayMs = performance.now() - overlayStartedAt;
  assert.strictEqual(overlaid.labRaw.length, resultRows.length, 'ca đã có XN không được lấy/nhân đôi');
  assert.ok(overlayMs < 15000, `Đối chiếu XN/CĐHA thực tế quá chậm: ${Math.round(overlayMs)} ms`);
  patientDb.close();
}

fs.rmSync(process.env.EMR_RUNTIME_ROOT, { recursive: true, force: true });
console.log(`research_normalization_performance_test: OK (${resultRows.length} kết quả, 3127 lượt, index ${Math.round(elapsedMs)} ms${overlayMs ? `, overlay ${Math.round(overlayMs)} ms` : ''})`);
