#!/usr/bin/env node
'use strict';

// Kiểm tra xuất CSV theo dòng (sendCsvFile):
//  1. Nội dung giống cách xuất cũ: che cột định danh, chặn công thức Excel (=, +, -, @).
//  2. File tạm được xóa sau khi gửi xong.
//  3. Xuất bảng lớn không làm heap tăng theo kích thước bảng (trước đây nạp trọn bảng
//     thành object rồi ghép thành một chuỗi CSV, dễ hết RAM với bảng XN vài trăm MB).
// Chạy: node --expose-gc scripts/research_export_stream_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.EMR_RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'research_export_stream_test_'));

const express = require('express');
const research = require('../server/routes/research');
const { redactCsvTable, DEFAULT_SENSITIVE_COLUMNS } = require('../server/research/export_utils');
const { rowsToCsv } = require('../server/utils/csv');
const R = research._test;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research_export_stream_data_'));

async function main() {
  const app = express();
  app.get('/export', (req, res) => R.sendCsvFile(res, path.join(dir, String(req.query.file)), 'xuat', { redact: req.query.redact !== '0' }));
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let passed = 0;
  const test = async (name, fn) => {
    try { await fn(); passed += 1; console.log(`  ok - ${name}`); } catch (err) { console.error(`  FAIL - ${name}`); console.error(err); process.exitCode = 1; }
  };
  try {
    await test('Nội dung giống cách xuất cũ: che định danh, chặn công thức', async () => {
      const columns = ['research_code', 'patient_name', 'patient_code', 'result_num', 'note'];
      const rows = [
        { research_code: 'NC0001', patient_name: 'BN GIA LAP', patient_code: '111', result_num: '-3.5', note: '=SUM(A1)' },
        { research_code: 'NC0002', patient_name: 'BN GIA LAP 2', patient_code: '222', result_num: '4', note: 'có, dấu "phẩy"' },
      ];
      const esc = v => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      fs.writeFileSync(path.join(dir, 'small.csv'), `﻿${[columns.join(','), ...rows.map(r => columns.map(c => esc(r[c])).join(','))].join('\n')}\n`);
      const res = await fetch(`${base}/export?file=small.csv`);
      assert.strictEqual(res.status, 200);
      assert.match(res.headers.get('content-disposition'), /xuat\.csv/);
      // So trên byte: TextDecoder của fetch().text() tự bỏ BOM.
      const bytes = Buffer.from(await res.arrayBuffer());
      const legacy = redactCsvTable(columns, rows, DEFAULT_SENSITIVE_COLUMNS);
      assert.ok(bytes.equals(Buffer.from('\uFEFF' + rowsToCsv(legacy.columns, legacy.rows), 'utf-8')), 'giống từng byte cách xuất cũ (kể cả BOM cho Excel)');
      const text = bytes.toString('utf-8');
      assert.ok(!text.includes('BN GIA LAP'), 'đã che họ tên');
      assert.ok(text.includes("'-3.5") && text.includes("'=SUM"), 'file tải về vẫn chặn công thức');
      await new Promise(r => setTimeout(r, 50));
      assert.deepStrictEqual(fs.readdirSync(dir).filter(f => f.startsWith('.export_tmp_')), [], 'file tạm đã bị xóa');
    });

    await test('Xuất bảng lớn không làm heap tăng theo kích thước bảng', async () => {
      const file = path.join(dir, 'big.csv');
      const fd = fs.openSync(file, 'w');
      fs.writeSync(fd, '﻿research_code,test_name_raw,result_num,unit,row_hash\n');
      for (let chunk = 0; chunk < 40; chunk += 1) {
        const lines = [];
        for (let i = 0; i < 5000; i += 1) {
          const n = chunk * 5000 + i;
          lines.push(`NC${n % 3000},Huyết sắc tố ${n % 50},${(n % 170) + 0.5},g/L,h${n.toString(16)}abcdef0123456789`);
        }
        fs.writeSync(fd, `${lines.join('\n')}\n`);
      }
      fs.closeSync(fd);
      if (typeof global.gc === 'function') global.gc();
      let peak = 0;
      const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().heapUsed); }, 5);
      const before = process.memoryUsage().heapUsed;
      const res = await fetch(`${base}/export?file=big.csv`);
      let lines = 0;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const ch of decoder.decode(value, { stream: true })) if (ch === '\n') lines += 1;
      }
      clearInterval(timer);
      assert.strictEqual(lines, 200001);
      if (typeof global.gc === 'function') {
        const grown = peak - before;
        const size = fs.statSync(file).size;
        // Cách cũ (nạp trọn bảng + ghép một chuỗi CSV) làm heap tăng ~7,5 lần kích thước file;
        // xuất theo dòng thường dưới 2 lần. Ngưỡng 4 lần để không chập chờn theo lúc GC chạy.
        assert.ok(grown < size * 4, `heap đỉnh tăng ${Math.round(grown / 1048576)} MB khi xuất file ${Math.round(size / 1048576)} MB`);
      }
    });
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${passed} kịch bản pass.`);
}

main().catch(err => { console.error(err); process.exit(1); });
