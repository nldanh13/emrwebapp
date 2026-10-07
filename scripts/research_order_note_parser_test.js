#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const parser = require('../server/research/order_note_parser');
const normalizers = require('../server/research/value_normalizers');
const tableIo = require('../server/research/table_io');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

test('thuốc phối hợp "25/5 mg": giữ đủ hàm lượng, tên thuốc không dính "01 viên uống 8h" (chữ có dấu)', () => {
  // Ca thật (kiểm tra ngẫu nhiên): "Mactapro 25/5 mg 01 viên uống 8h" ra liều "5 mg" và tên thuốc dính cả câu.
  const med = parser.parseMedicationLine('Mactapro 25/5 mg 01 viên uống 8h');
  assert.strictEqual(med.strength_raw, '25/5 mg');
  assert.strictEqual(med.drug_name_raw, 'Mactapro');
  assert.strictEqual(med.route_norm, 'uống');
  const single = parser.parseMedicationLine('(TT) Eperison 50mg 01 viên x3 (u) 8h-14h-20h');
  assert.strictEqual(single.strength_raw, '50 mg');
  assert.strictEqual(single.drug_name_raw, 'Eperison');
});

test('dedupe: diễn biến copy sang Tên y lệnh không còn là order độc lập', () => {
  const text = 'Bệnh nhân tỉnh\nTiếp xúc tốt\nVết mổ khô';
  const result = parser.dedupeOrderFields({
    'Diễn biến': text,
    'Tên y lệnh': text,
    'Y lệnh khác': '',
  });
  assert.strictEqual(result.clinical_text, text);
  assert.deepStrictEqual(result.order_blocks, []);
});

test('dedupe: Tên y lệnh và Y lệnh khác giống nhau chỉ giữ một bản', () => {
  const med = '(TT) Eperison 50mg 01v x3 (u) 8h-14h-20h';
  const result = parser.dedupeOrderFields({
    'Diễn biến': 'Dự trù thuốc',
    'Tên y lệnh': med,
    'Y lệnh khác': med,
  });
  assert.strictEqual(result.order_blocks.length, 1);
  assert.strictEqual(result.order_blocks[0].text, med);
});

test('phân loại: placeholder không được coi là thuốc cụ thể', () => {
  const c = parser.classifyOrderLine('Y lệnh thuốc đã có');
  assert.strictEqual(c.kind, 'medication_reference');
  assert.strictEqual(parser.parseMedicationLine('Y lệnh thuốc đã có'), null);
});

test('thuốc: tách Eperison, hàm lượng, số lần, đường uống và giờ dùng', () => {
  const p = parser.parseMedicationLine('(TT) Eperison 50mg 01v x3 (u) 8h-14h-20h');
  assert.ok(p);
  assert.strictEqual(p.order_action, 'order');
  assert.strictEqual(p.drug_name_raw, 'Eperison');
  assert.strictEqual(p.drug_name_norm, 'eperison');
  assert.strictEqual(p.strength_raw, '50 mg');
  assert.strictEqual(p.times_per_day, '3');
  assert.strictEqual(p.schedule, '08:00;14:00;20:00');
});

test('thuốc: B12 trong tên không bị nhầm thành giờ dùng', () => {
  const p = parser.parseMedicationLine('(TT) B12 Ankermann 01v x2(u) 8h-20h');
  assert.ok(p);
  assert.strictEqual(p.drug_name_raw, 'B12 Ankermann');
  assert.strictEqual(p.schedule, '08:00;20:00');
});

test('ngưng thuốc: nhận action stop và vẫn tách được tên thuốc', () => {
  const p = parser.parseMedicationLine('Ngưng y lệnh Aspirin 81mg 8h');
  assert.ok(p);
  assert.strictEqual(p.order_action, 'stop');
  assert.strictEqual(p.drug_name_raw, 'Aspirin');
});

test('duy trì kháng sinh mơ hồ không tự dựng tên thuốc', () => {
  assert.strictEqual(parser.parseMedicationLine('Duy trì y lệnh kháng sinh truyền tĩnh mạch trong ngày'), null);
});

test('chăm sóc: rút dẫn lưu không phải medication', () => {
  const c = parser.classifyOrderLine('Rút dẫn lưu 16h');
  assert.strictEqual(c.kind, 'care_order');
});

test('normalizeDrugName: không biến nguyên câu y lệnh thành tên thuốc', () => {
  assert.strictEqual(normalizers.normalizeDrugName('(TT) Leolen fort 01v x 2(u) 8h-20h'), 'leolen_fort');
  assert.strictEqual(normalizers.normalizeDrugName('Y lệnh thuốc đã có'), '');
});

test('clinical events: chỉ ghi nhận điều có bằng chứng rõ và giữ source text', () => {
  const events = parser.extractClinicalEvents([
    'Bệnh nhân tỉnh',
    'Vết mổ rỉ ít dịch thấm băng',
    'Không nôn ói',
    'Đau vết mổ VAS 6/10',
    'Dự kiến 07/05/2026 xuất viện',
  ].join('\n'));
  const byType = new Map(events.map(e => [e.event_type, e]));
  assert.strictEqual(byType.get('consciousness').value_norm, 'alert');
  assert.strictEqual(byType.get('wound_drainage').value_norm, 'small');
  assert.strictEqual(byType.get('nausea_vomiting').negated, '1');
  assert.strictEqual(byType.get('pain_vas').value_norm, '6');
  assert.strictEqual(byType.get('pain_vas').source_text, 'Đau vết mổ VAS 6/10');
  assert.strictEqual(byType.get('discharge_plan').value_norm, 'planned');
});

test('table_io: raw giữ nguyên, getCell mới dedupe cho parser', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'order_history_parser_'));
  const file = path.join(dir, 'hchanh_order_history.csv');
  const clinical = 'Bệnh nhân tỉnh';
  const med = '(TT) Eperison 50mg 01v x3 (u) 8h-14h-20h';
  const csv = [
    'Mã BN,Diễn biến,Tên y lệnh,Y lệnh khác',
    `BN1,"${clinical}","${clinical}",`,
    `BN2,Dự trù thuốc,"${med}","${med}"`,
    'BN3,Hậu phẫu,"Y lệnh thuốc đã có","Y lệnh thuốc đã có"',
  ].join('\n');
  fs.writeFileSync(file, csv, 'utf8');
  const before = fs.readFileSync(file, 'utf8');
  const t = tableIo.readCsvTable(file, 100);

  assert.strictEqual(t.rows[0]['Tên y lệnh'], clinical, 'bảng raw không bị sửa');
  assert.strictEqual(t.rows[1]['Y lệnh khác'], med, 'bảng raw vẫn giữ duplicate nguồn');
  assert.strictEqual(tableIo.getCell(t.rows[0], ['Tên y lệnh']), '', 'copy từ diễn biến bị bỏ khi parser đọc');
  assert.strictEqual(tableIo.getCell(t.rows[1], ['Tên y lệnh']), med);
  assert.strictEqual(tableIo.getCell(t.rows[1], ['Y lệnh khác']), '', 'duplicate order_other bị bỏ');
  assert.strictEqual(tableIo.getCell(t.rows[2], ['Tên y lệnh']), '', 'placeholder không tạo thuốc giả');
  assert.strictEqual(tableIo.getCell(t.rows[2], ['Y lệnh khác']), '');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'raw CSV trên đĩa phải giữ nguyên');
});

console.log(`${passed} test(s) passed`);
