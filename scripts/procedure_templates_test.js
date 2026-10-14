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
  // Source catalog is NOT auto-installed or active. Every draft needs review.
  const catalog = require('../config/procedure_templates.ctch_neuro.suggestions.json');
  assert.strictEqual(catalog.suggestions.length, 40);
  assert.strictEqual(catalog.suggestions.filter(t => t.priority === 'A').length, 16);
  assert.strictEqual(new Set(catalog.suggestions.map(t => t.code)).size, 40);
  const item = catalog.suggestions.find(t => t.code === '2.349');
  const draft = {
    id: 'ctch-2-349', kind: item.kind, name: item.name, keywords: [item.name],
    catalog_code: item.code, reviewed: false,
    performer: 'bac_si', report: '', emr_template: '',
    auto: true, enabled: true,
  };
  const [disabled] = sanitizeTemplates([draft]);
  assert.strictEqual(disabled.enabled, false);
  assert.strictEqual(disabled.auto, false);
  assert.strictEqual(disabled.reviewed, false);
  assert.strictEqual(disabled.catalog_code, '2.349');
  const stored = saveTemplates([draft], file);
  assert.strictEqual(stored.templates[0].enabled, false);
  assert.strictEqual(loadTemplates(file, defaults).templates[0].reviewed, false);
  assert.throws(() => sanitizeTemplates([{ ...draft, reviewed: true }]), /chưa có đủ/);
  assert.throws(() => sanitizeTemplates([{ ...draft, catalog_code: '2.9999' }]), /không còn khớp/);
  assert.throws(() => sanitizeTemplates([{ ...draft, name: 'Tiêm khớp gối' }]), /không còn khớp/);
  const approved = {
    ...draft, reviewed: true, report: 'Nội dung do bệnh viện duyệt.',
    emr_template: 'Mẫu EMR đã đối chiếu', auto: true, enabled: true,
  };
  assert.strictEqual(sanitizeTemplates([approved])[0].enabled, true);
  assert.throws(() => sanitizeTemplates([
    approved,
    { id: 'legacy', kind: 'thu_thuat', name: 'Hút dịch khớp gối cũ',
      keywords: ['Hút dịch khớp gối'], auto: true, enabled: true },
  ]), /trùng từ khóa/);
  // Existing hand-crafted templates retain prior behavior.
  assert.strictEqual(sanitizeTemplates([{ id: 'legacy', kind: 'thu_thuat', name: 'Mẫu cũ' }])[0].enabled, true);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log('procedure_templates_test: ok');
