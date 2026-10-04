#!/usr/bin/env node
'use strict';

// Kiểm tra khóa theo phạm vi của Kho nghiên cứu (lockedResearchRoute):
//  1. Khi kho gốc đang chạy một thao tác ghi, thao tác ghi khác trên kho gốc bị 409 (trừ Chuẩn
//     hóa: quy trình riêng có khóa riêng).
//  2. Nghiên cứu riêng không bị khóa bởi kho gốc (khóa theo từng kho).
//  3. Thao tác chỉ đọc không bị khóa.
//  4. Thao tác xong (kể cả khi lỗi) thì khóa được nhả.
//  5. Lấy lại chỗ thiếu (/research/refetch-missing) khóa đúng kho theo body.scope.
// Chạy: node scripts/research_scope_lock_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.EMR_RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'research_scope_lock_test_'));

const express = require('express');
const research = require('../server/routes/research');
const R = research._test;

async function main() {
  const app = express();
  app.use(express.json());
  app.use('/api', research);
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const post = (p, body = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let passed = 0;
  const test = async (name, fn) => {
    try { await fn(); passed += 1; console.log(`  ok - ${name}`); } catch (err) { console.error(`  FAIL - ${name}`); console.error(err); process.exitCode = 1; }
  };

  try {
    await test('Kho gốc đang bận: thao tác ghi khác trên kho gốc trả 409, kho riêng không bị chặn', async () => {
      R.RESEARCH_SCOPE_LOCKS.set('archive', { label: 'Thu thập tự động', since: '2026-09-30T12:00:00Z' });
      const busy = await post('/research/archive/finalize-dataset');
      assert.strictEqual(busy.status, 409);
      const body = await busy.json();
      assert.strictEqual(body.code, 'RESEARCH_SCOPE_BUSY');
      assert.match(body.message, /Thu thập tự động/);
      const refetch = await post('/research/refetch-missing', { scope: 'archive' });
      assert.strictEqual(refetch.status, 409);
      const other = await post('/research/studies/nc_khac/normalize');
      assert.notStrictEqual(other.status, 409, 'nghiên cứu riêng không bị khóa bởi kho gốc');
      // Chuẩn hóa là quy trình riêng (khóa "archive:normalize"): đang thu thập vẫn chuẩn hóa được.
      const normalize = await post('/research/archive/normalize');
      assert.notStrictEqual((await normalize.json()).code, 'RESEARCH_SCOPE_BUSY', 'chuẩn hóa không bị khóa Thu thập chặn');
      const read = await fetch(`${base}/research/archive`);
      assert.strictEqual(read.status, 200, 'thao tác chỉ đọc không bị khóa');
      R.RESEARCH_SCOPE_LOCKS.delete('archive');
    });

    await test('Khóa được nhả sau khi thao tác xong, kể cả khi thao tác lỗi', async () => {
      const first = await post('/research/studies/nc_khac/normalize');
      assert.notStrictEqual(first.status, 409);
      assert.strictEqual(R.RESEARCH_SCOPE_LOCKS.size, 0);
      const second = await post('/research/studies/nc_khac/normalize');
      assert.notStrictEqual(second.status, 409);
    });

    await test('Khóa theo scope trong body cho /research/refetch-missing', async () => {
      assert.strictEqual(R.researchScopeKey({ params: {}, path: '/research/refetch-missing', body: { scope: 'NC_A' } }), 'study:nc_a');
      assert.strictEqual(R.researchScopeKey({ params: {}, path: '/research/refetch-missing', body: {} }), 'archive');
      assert.strictEqual(R.researchScopeKey({ params: { studyId: 'NC_A' }, path: '/x' }), 'study:nc_a');
    });
  } finally {
    server.close();
  }
  console.log(`\n${passed} kịch bản pass.`);
}

main().catch(err => { console.error(err); process.exit(1); });
