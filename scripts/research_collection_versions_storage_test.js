#!/usr/bin/env node
'use strict';

// collection_versions.jsonl (lịch sử phiên bản thu thập) chỉ được thêm, không xóa. Trên máy
// vận hành file đã hơn 300 MB. Hai bảo đảm:
// 1. Đọc id/đếm dòng theo từng khúc, không đọc cả file thành một chuỗi (Node giới hạn chuỗi
//    khoảng 512 MB: vượt ngưỡng thì thu thập dừng vì lỗi).
// 2. Phiên bản sau lần đầu chỉ lưu phần khác (dòng thêm/bớt) so với phiên bản trước, và
//    dựng lại được đúng nội dung (cùng content_hash) — kể cả với file định dạng cũ (lưu đủ rows).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const collection = require('../server/research/collection');
const R = require('../server/research/collection_runtime');
const { countLines } = require('../server/research/pipeline_info')._test || {};

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); } catch (err) { failed += 1; console.error(`  ✗ ${name}\n${err.stack}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-versions-'));
const VERSIONS = path.join(tmp, 'collection_versions.jsonl');

function withoutWholeFileRead(fn) {
  const orig = fs.readFileSync;
  fs.readFileSync = function patched(p, ...rest) {
    if (String(p).endsWith('collection_versions.jsonl')) throw new RangeError('Invalid string length (giả lập file > 512 MB)');
    return orig.call(this, p, ...rest);
  };
  try { return fn(); } finally { fs.readFileSync = orig; }
}

function xnRows(values) {
  return values.map((v, i) => ({ 'Mã NC': 'NC1', 'Chỉ số': `CS${i}`, 'Kết quả': String(v) }));
}

function versionsFor(oldRows, newRows, pb = {}) {
  const key = 'K1';
  const before = { encounters: { [key]: { research_code: 'NC1', parts: { xn: { status: 'done', result_at: 't1', content_hash: collection.contentHash(oldRows), content_version: 1, ...pb } } } } };
  const after = { encounters: { [key]: { research_code: 'NC1', parts: { xn: { status: 'done', result_at: 't2' } } } } };
  const id = `${key}|xn`;
  return collection.applyContentVersions({
    before, after, targets: [{ key, part: 'xn' }],
    beforeRows: new Map([[id, oldRows]]), afterRows: new Map([[id, newRows]]), now: 't2',
  });
}

try {
  test('Đọc id lịch sử không đọc cả file một lần, dòng dài vượt khúc đọc vẫn đúng', () => {
    const big = { version_id: 'K|xn|v1|h1', key: 'K', part: 'xn', version: 1, rows: [{ x: 'a'.repeat(3 * 1024 * 1024) }] };
    fs.writeFileSync(VERSIONS, `${JSON.stringify(big)}\n${JSON.stringify({ key: 'K', part: 'xn', version: 2, content_hash: 'h2' })}\n{"version_id":"cut`);
    const ids = withoutWholeFileRead(() => R.readCollectionVersionIds(tmp));
    assert.deepStrictEqual([...ids].sort(), ['K|xn|v1|h1', 'K|xn|v2|h2']);
    const written = withoutWholeFileRead(() => R.appendCollectionVersions(tmp, [{ version_id: 'K|xn|v3|h3', key: 'K', part: 'xn', version: 3 }]));
    assert.strictEqual(written, 1);
    assert.strictEqual(withoutWholeFileRead(() => R.appendCollectionVersions(tmp, [{ version_id: 'K|xn|v3|h3' }])), 0, 'không ghi trùng');
  });

  test('Đếm số phiên bản đã ghi không đọc cả file một lần', () => {
    assert.strictEqual(typeof countLines, 'function');
    assert.strictEqual(withoutWholeFileRead(() => countLines(VERSIONS)), 4);
    assert.strictEqual(countLines(path.join(tmp, 'khong_co.jsonl')), 0);
  });

  test('Phiên bản sau chỉ lưu dòng thêm/bớt, không chép lại toàn bộ', () => {
    const oldRows = xnRows(Array.from({ length: 50 }, (_, i) => i + 1));
    const newRows = [...oldRows.slice(0, 49), { 'Mã NC': 'NC1', 'Chỉ số': 'CS49', 'Kết quả': '500' }];
    const cv = versionsFor(oldRows, newRows);
    const [vBefore, vAfter] = cv.versions;
    assert.strictEqual(vBefore.role, 'before_change');
    assert.strictEqual(vBefore.rows.length, 50, 'bản đầu tiên vẫn lưu đủ để làm gốc');
    assert.strictEqual(vAfter.role, 'after_change');
    assert.strictEqual(vAfter.rows, undefined, 'bản sau không lưu lại toàn bộ dòng');
    assert.strictEqual(vAfter.base_version, 1);
    assert.deepStrictEqual(vAfter.rows_added, [newRows[49]]);
    assert.deepStrictEqual(vAfter.rows_removed, [oldRows[49]]);
    assert.ok(JSON.stringify(vAfter).length < JSON.stringify(vBefore).length / 5, 'bản sau nhỏ hơn nhiều so với bản đầy đủ');
  });

  test('Dựng lại đúng nội dung từng phiên bản qua chuỗi phần khác', () => {
    const r1 = xnRows([1, 2, 3]);
    const r2 = xnRows([1, 2, 30]);
    const r3 = [...xnRows([1, 2, 30]), { 'Mã NC': 'NC1', 'Chỉ số': 'CS9', 'Kết quả': '9' }];
    const v12 = versionsFor(r1, r2).versions;
    const v23 = versionsFor(r2, r3, { content_version: 2, history_stored_version: 2 }).versions;
    assert.strictEqual(v23.length, 1, 'bản 2 đã có trong lịch sử thì không ghi lại');
    assert.strictEqual(v23[0].version, 3);
    const all = [...v12, ...v23];
    for (const [ver, rows] of [[1, r1], [2, r2], [3, r3]]) {
      const got = collection.rowsAtVersion(all, 'K1', 'xn', ver);
      assert.strictEqual(collection.contentHash(got), collection.contentHash(rows), `phiên bản ${ver}`);
    }
  });

  test('File định dạng cũ (bản sau lưu đủ rows) vẫn dựng lại được', () => {
    const legacy = [
      { key: 'K1', part: 'xn', version: 1, role: 'before_change', rows: xnRows([1]) },
      { key: 'K1', part: 'xn', version: 2, role: 'after_change', rows: xnRows([2]) },
    ];
    assert.deepStrictEqual(collection.rowsAtVersion(legacy, 'K1', 'xn', 2), xnRows([2]));
    assert.strictEqual(collection.rowsAtVersion(legacy, 'K1', 'xn', 5), null, 'không có phiên bản thì trả null, không tự điền');
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failed) { console.error(`research_collection_versions_storage_test: ${failed} lỗi`); process.exit(1); }
console.log('research_collection_versions_storage_test: OK');
