#!/usr/bin/env node
'use strict';

// Phiếu nhập tay (CRF) của nghiên cứu: thiết kế phiếu, nhập theo Mã NC, kiểm kiểu giá trị,
// mốc theo dõi (T24/T48/...), trường định danh không ra file phân tích, phân quyền nhập.
// Chạy: node scripts/research_crf_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.EMR_RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'research_crf_test_'));
const crf = require('../server/research/crf_store');
const { studyDir } = require('../server/research/store_paths');
const { readCsvTable } = require('../server/research/table_io');
const { requiredRoleForRequest } = require('../server/services/authz');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); } catch (err) { console.error(`  FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}

const STUDY = 'apr_zoledronic';
fs.mkdirSync(studyDir(STUDY), { recursive: true });
fs.writeFileSync(path.join(studyDir(STUDY), 'cohort.csv'), 'Mã NC,Mã BN\nNC0001,BN1\nNC0002,BN2\n');

const FORM = {
  timepoints: [{ id: 'T24', label: '24 giờ', offset_hours: 24 }, { id: 'T48', label: '48 giờ', offset_hours: 48 }],
  fields: [
    { label: 'Số điện thoại', type: 'text', identifier: true, section: 'Nhân khẩu' },
    { label: 'Chiều cao', type: 'number', unit: 'cm', min: 50, max: 250, section: 'Nhân khẩu' },
    { label: 'Hút thuốc lá', type: 'choice', options: 'Không; Đang hút/Cai < 6 tháng', section: 'Lối sống' },
    { label: 'Nhiệt độ max', type: 'number', unit: '°C', timepoint: 'T24' },
    { label: 'Nhiệt độ max', type: 'number', unit: '°C', timepoint: 'T48' },
  ],
};

test('thiết kế phiếu: tạo mã trường không dấu, không trùng; lựa chọn tách theo dấu ;', () => {
  const { form } = crf.saveForm(STUDY, FORM);
  assert.deepStrictEqual(form.fields.map(f => f.id), ['so_dien_thoai', 'chieu_cao', 'hut_thuoc_la', 'nhiet_do_max', 'nhiet_do_max'], 'cùng câu hỏi ở 2 mốc dùng chung mã');
  assert.deepStrictEqual(crf.sanitizeForm({ fields: [{ label: 'A' }, { label: 'A' }] }).fields.map(f => f.id), ['a', 'a_2'], 'trùng trong cùng mốc thì thêm hậu tố');
  assert.deepStrictEqual(form.fields[2].options, ['Không', 'Đang hút/Cai < 6 tháng']);
  assert.strictEqual(form.fields[3].timepoint, 'T24');
  assert.throws(() => crf.saveForm(STUDY, { fields: [{ label: 'X', type: 'choice', options: 'A' }] }), /ít nhất 2 lựa chọn/);
});

test('nhập phiếu: kiểm kiểu số/khoảng/lựa chọn, Mã NC phải thuộc danh sách mẫu', () => {
  assert.throws(() => crf.saveEntry(STUDY, 'NC0001', { values: { chieu_cao: 'abc' } }), /phải là số/);
  assert.throws(() => crf.saveEntry(STUDY, 'NC0001', { values: { chieu_cao: '300' } }), /lớn hơn 250/);
  assert.throws(() => crf.saveEntry(STUDY, 'NC0001', { values: { hut_thuoc_la: 'Có' } }), /không có trong danh sách/);
  assert.throws(() => crf.saveEntry(STUDY, 'NC9999', { values: {} }), /không có trong danh sách mẫu/);
});

test('lưu giá trị gốc + mốc theo dõi; lần sau chỉ đổi trường có gửi, giữ số điện thoại cũ', () => {
  crf.saveEntry(STUDY, 'NC0001', {
    anchor_at: '2026-03-10T14:00',
    values: { so_dien_thoai: '0900000000', chieu_cao: '155,5', hut_thuoc_la: 'Không' },
    timepoints: { T24: { status: 'done', values: { nhiet_do_max: '38.2' } } },
  }, 'nv01');
  crf.saveEntry(STUDY, 'NC0001', { values: { chieu_cao: '156' }, timepoints: { T48: { status: 'unreachable', note: 'không nghe máy' } } });
  const view = crf.readCrfView(STUDY, { includeIdentifiers: true });
  const s = view.samples.find(x => x.research_code === 'NC0001');
  assert.deepStrictEqual(s.values, { so_dien_thoai: '0900000000', chieu_cao: '156', hut_thuoc_la: 'Không' });
  assert.strictEqual(s.anchor_at, '2026-03-10T14:00');
  assert.strictEqual(s.timepoints.T24.status, 'done');
  assert.strictEqual(s.timepoints.T24.values.nhiet_do_max, '38.2');
  assert.strictEqual(s.timepoints.T48.status, 'unreachable');
  assert.strictEqual(s.timepoints.T48.attempts, 1);
  assert.strictEqual(view.samples.length, 2, 'mọi Mã NC trong danh sách mẫu đều có dòng');
});

test('không được xem định danh: ẩn số điện thoại nhưng báo đã lưu', () => {
  const s = crf.readCrfView(STUDY, { includeIdentifiers: false }).samples.find(x => x.research_code === 'NC0001');
  assert.ok(!('so_dien_thoai' in s.values));
  assert.deepStrictEqual(s.identifiers_saved, ['so_dien_thoai']);
});

test('crf_data.csv để phân tích: mỗi Mã NC một dòng, cột theo mốc, không có số điện thoại', () => {
  const t = readCsvTable(path.join(studyDir(STUDY), crf.DATA_FILE), 100);
  assert.deepStrictEqual(t.columns, ['research_code', 'anchor_at', 'chieu_cao', 'hut_thuoc_la', 'T24_status', 'T24_nhiet_do_max', 'T48_status', 'T48_nhiet_do_max']);
  assert.strictEqual(t.rows[0].T24_nhiet_do_max, '38.2');
  assert.ok(!JSON.stringify(t.rows).includes('0900000000'));
});

test('phân quyền: researcher nhập phiếu từng mẫu; thiết kế phiếu cần supervisor', () => {
  assert.strictEqual(requiredRoleForRequest({ method: 'PUT', path: '/research/studies/apr/crf/entries/NC0001' }), 'researcher');
  assert.strictEqual(requiredRoleForRequest({ method: 'PUT', path: '/research/studies/apr/crf/form' }), 'supervisor');
  assert.strictEqual(requiredRoleForRequest({ method: 'POST', path: '/research/studies/apr/crf/entries/NC0001' }), 'supervisor');
  assert.strictEqual(requiredRoleForRequest({ method: 'PUT', path: '/research/studies/apr/crf/entries/NC0001/x' }), 'supervisor');
});

const ORTHO = 'ortho_psych_sleep_pain';
fs.mkdirSync(studyDir(ORTHO), { recursive: true });
fs.writeFileSync(path.join(studyDir(ORTHO), 'cohort.csv'), 'Mã NC,Mã BN\nNC1001,BN1001\n');
const orthoFields = [
  ...['hads_a1','hads_a3','hads_a5','hads_a7','hads_a9','hads_a11','hads_a13'].map(id => ({ id, label: id, type: 'number', min: 0, max: 3 })),
  ...['hads_d2','hads_d4','hads_d6','hads_d8','hads_d10','hads_d12','hads_d14'].map(id => ({ id, label: id, type: 'number', min: 0, max: 3 })),
  ...['ais_1','ais_2','ais_3','ais_4','ais_5'].map(id => ({ id, label: id, type: 'number', min: 0, max: 3 })),
  { id: 'psqi_total', label: 'PSQI', type: 'number', min: 0, max: 21 },
  { id: 'vas', label: 'VAS N1', type: 'number', min: 0, max: 10, timepoint: 'N1' },
];
crf.saveForm(ORTHO, { timepoints: [{ id: 'N1', label: 'Hậu phẫu ngày 1', offset_hours: 24 }], fields: orthoFields });

test('CTCH: tự tính HADS-A/HADS-D/AIS và phân loại PSQI từ tổng điểm đã nhập', () => {
  const values = {
    hads_a1: '1', hads_a3: '1', hads_a5: '1', hads_a7: '1', hads_a9: '1', hads_a11: '1', hads_a13: '1',
    hads_d2: '2', hads_d4: '2', hads_d6: '2', hads_d8: '2', hads_d10: '2', hads_d12: '2', hads_d14: '2',
    ais_1: '1', ais_2: '1', ais_3: '1', ais_4: '1', ais_5: '1', psqi_total: '6',
  };
  crf.saveEntry(ORTHO, 'NC1001', { values, timepoints: { N1: { status: 'done', values: { vas: '4' } } } });
  const d = crf.derivedValues(values);
  assert.deepStrictEqual(d, {
    hads_a_total: 7, hads_a_class: 'Bình thường',
    hads_d_total: 14, hads_d_class: 'Có rối loạn',
    ais_total: 5, ais_class: 'Rối loạn giấc ngủ',
    psqi_class: 'Rối loạn giấc ngủ',
  });
  const t = readCsvTable(path.join(studyDir(ORTHO), crf.DATA_FILE), 100);
  assert.strictEqual(t.rows[0].hads_a_total, '7');
  assert.strictEqual(t.rows[0].hads_d_total, '14');
  assert.strictEqual(t.rows[0].ais_total, '5');
  assert.strictEqual(t.rows[0].psqi_class, 'Rối loạn giấc ngủ');
  assert.strictEqual(t.rows[0].N1_vas, '4');
});

test('CTCH: ngày mổ từ dataset tự trở thành mốc CRF để tính N1/N2/N3', () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'research_crf_run_'));
  fs.writeFileSync(path.join(runDir, 'analysis_ready.csv'), 'research_code,surgery_date\nNC1001,2026-10-03\n');
  const sample = crf.readCrfView(ORTHO, { runDir }).samples[0];
  assert.strictEqual(sample.anchor_auto, '2026-10-03T00:00');
});

test('CTCH: không cộng điểm nếu bộ câu hỏi chưa đủ, tránh biến thiếu thành 0', () => {
  const d = crf.derivedValues({ hads_a1: '1', ais_1: '0' });
  assert.strictEqual(d.hads_a_total, undefined);
  assert.strictEqual(d.ais_total, undefined);
});

console.log(`${passed} test(s) passed`);
