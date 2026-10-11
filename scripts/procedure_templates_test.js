#!/usr/bin/env node
'use strict';

// Mẫu thủ thuật – phẫu thuật: chưa sửa thì dùng mẫu mặc định; lưu thì chuẩn hoá từng mẫu
// (worker/procedure_templates.py đọc cùng file).
// Chạy: node scripts/procedure_templates_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sanitizeTemplates, loadTemplates, saveTemplates } = require('../server/routes/procedure_templates');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-tpl-'));
const file = path.join(dir, 'procedure_templates.json');
const defaults = path.join(__dirname, '..', 'config', 'procedure_templates.default.json');

try {
  const first = loadTemplates(file, defaults);
  assert.strictEqual(first.is_default, true);
  assert.deepStrictEqual(first.templates.map(t => t.kind).sort(), ['phau_thuat', 'thu_thuat']);

  const [tt] = sanitizeTemplates([{
    id: 'a b', kind: 'thu_thuat', name: '  Khâu   vết thương ', keywords: 'khâu vết thương, Khâu vết thương;  khâu da',
    performer: 'bac_si', minutes: '999', report: ' Dòng 1\r\nDòng 2 ', applies_to: 'xyz', auto: false,
  }]);
  assert.strictEqual(tt.id, 'a-b');
  assert.strictEqual(tt.name, 'Khâu vết thương');
  assert.deepStrictEqual(tt.keywords, ['khâu vết thương', 'khâu da']);
  assert.strictEqual(tt.performer, 'bac_si');
  assert.strictEqual(tt.minutes, 240);
  assert.strictEqual(tt.report, 'Dòng 1\nDòng 2', 'giữ xuống dòng của nội dung tường trình');
  assert.strictEqual(tt.applies_to, 'all');
  assert.strictEqual(tt.auto, false);
  assert.strictEqual(tt.enabled, true);

  const [pt] = sanitizeTemplates([{ kind: 'phau_thuat' }]);
  assert.strictEqual(pt.performer, 'bac_si');
  assert.strictEqual(pt.minutes, 15);
  assert.ok(pt.id);

  const dupIds = sanitizeTemplates([{ id: 'x' }, { id: 'x' }]);
  assert.notStrictEqual(dupIds[0].id, dupIds[1].id);

  assert.throws(() => sanitizeTemplates('abc'), /danh sách/);
  assert.throws(() => sanitizeTemplates(new Array(301).fill({})), /Tối đa/);

  saveTemplates([{ kind: 'thu_thuat', name: 'Cắt chỉ', keywords: ['cắt chỉ'] }], file);
  const again = loadTemplates(file, defaults);
  assert.strictEqual(again.is_default, false);
  assert.strictEqual(again.templates.length, 1);
  assert.strictEqual(again.templates[0].name, 'Cắt chỉ');
  assert.ok(again.updated_at);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('procedure_templates_test: ok');
