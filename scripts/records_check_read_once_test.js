#!/usr/bin/env node
'use strict';

// Bảng Kiểm hồ sơ: mỗi người bệnh đọc 2 loại file (ra viện, CLS), mỗi loại tra Kho người bệnh tới
// 2 lần (bản gốc rồi bản tạm thời), mỗi lần lại giải mã dữ liệu của CẢ đợt (gồm bảng kê, y lệnh —
// thường lớn nhất). Trước đây cùng một đợt bị giải mã lại 4 lần cho mỗi lần tải bảng. Kiểm: trong
// một lần dựng bảng mỗi bản quét chỉ giải mã một lần, và bảng vẫn hiện đúng dữ liệu.
// Chạy: node scripts/records_check_read_once_test.js  (cần Node.js >= 22.13)

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'records_check_read_once_test_'));
process.env.EMR_RUNTIME_ROOT = RUNTIME_ROOT;

const patientDb = require('../server/services/patient_db');
if (!patientDb.available()) {
  console.log(`records_check_read_once_test: bỏ qua — ${patientDb.unavailableReason()}`);
  process.exit(process.env.REQUIRE_PATIENT_DB === '1' ? 1 : 0);
}

const express = require('express');

const MARKER = 'BANG_KE_LON_DANH_DAU';
const PATIENTS = ['RO001', 'RO002', 'RO003'];

function seed() {
  const metas = {};
  for (const maBn of PATIENTS) {
    // Bản gốc (Kho nghiên cứu) chỉ có bảng kê; ra viện + CLS là bản tạm thời → mỗi loại file phải
    // tra kho cả 2 lượt (gốc trượt, rồi tạm thời).
    patientDb.recordInpatient(maBn, { billing: { rows: [{ ten: MARKER, thanh_tien: 1 }], _fetch_status: 'ok' } },
      { from: '2026-09-01', to: '2026-09-05', source: 'kho_nghien_cuu', now: '2026-09-06T00:00:00Z' });
    patientDb.recordInpatient(maBn, {
      discharge: { so_luu_tru: `SLT-${maBn}`, raw_time: '05/09/2026 09:30', ngay_ra: '05/09/2026', _fetch_status: 'ok' },
      cls: { rows: [{ ten: 'X-quang' }], _fetch_status: 'ok' },
    }, { from: '2026-09-01', to: '2026-09-05', source: 'kiem_ho_so', now: '2026-09-06T00:00:00Z' });
    const caseKey = `${maBn}::k`;
    metas[caseKey] = {
      ma_bn: maBn, case_key: caseKey, ho_ten: `Người bệnh ${maBn}`, active: true,
      admission_time: '2026-09-01T08:00:00', discharge_time: '2026-09-05T09:30:00', fetched: {}, checked: false,
    };
  }
  const dir = path.join(RUNTIME_ROOT, 'records_check');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'records_check_index.json'), JSON.stringify({
    patients: metas, checked: {}, checked_aliases: {}, checklist: {}, checklist_aliases: {},
  }));
}

async function main() {
  seed();
  const app = express();
  app.use(express.json());
  app.use('/api', require('../server/routes/hchanh'));
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    const originalParse = JSON.parse;
    let markerParses = 0;
    JSON.parse = function countingParse(text, ...rest) {
      if (typeof text === 'string' && text.includes(MARKER) && !text.includes('"patients"')) markerParses += 1;
      return originalParse.call(this, text, ...rest);
    };
    let dash;
    try {
      const res = await fetch(`${base}/hchanh/records-check/dashboard`);
      dash = await res.json();
    } finally {
      JSON.parse = originalParse;
    }
    const cards = dash.patients || [];
    assert.strictEqual(cards.length, PATIENTS.length);
    for (const maBn of PATIENTS) {
      const card = cards.find(c => c.ma_bn === maBn);
      assert.strictEqual(card?.discharge?.so_luu_tru, `SLT-${maBn}`, 'vẫn hiện dữ liệu ra viện từ kho');
      assert.ok(card?.cls, 'vẫn hiện CLS từ kho');
    }
    console.log(`  bảng kê bị giải mã ${markerParses} lần cho ${PATIENTS.length} người bệnh`);
    // Mỗi người bệnh: 1 lần cho lượt tra "chỉ bản gốc" + 1 lần cho lượt tra "mọi bản".
    assert.ok(markerParses <= PATIENTS.length * 2, `giải mã ${markerParses} lần, tối đa ${PATIENTS.length * 2}`);
    console.log('  ✓ mỗi bản quét chỉ giải mã một lần trong một lần dựng bảng');

    // Lần tải sau vẫn thấy dữ liệu mới (bộ nhớ tạm không giữ qua các yêu cầu).
    patientDb.recordInpatient('RO001', {
      discharge: { so_luu_tru: 'SLT-MOI', raw_time: '05/09/2026 09:30', ngay_ra: '05/09/2026', _fetch_status: 'ok' },
    }, { from: '2026-09-01', to: '2026-09-05', source: 'kiem_ho_so', now: '2026-09-07T00:00:00Z' });
    const again = await (await fetch(`${base}/hchanh/records-check/dashboard`)).json();
    assert.strictEqual(again.patients.find(c => c.ma_bn === 'RO001')?.discharge?.so_luu_tru, 'SLT-MOI');
    console.log('  ✓ lần tải sau thấy dữ liệu mới');
    console.log('records_check_read_once_test: ok');
  } finally {
    server.close();
    patientDb.close?.();
    fs.rmSync(RUNTIME_ROOT, { recursive: true, force: true });
  }
}

main().catch(err => { console.error(err); process.exit(1); });
