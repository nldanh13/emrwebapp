#!/usr/bin/env node
'use strict';

// Lệnh `npm run inspect:data` được dán ra ngoài để chẩn đoán, nên không được in
// mã BN hay họ tên người bệnh nằm trong tên file (ví dụ PDF in ra viện).

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-runtime-'));
function put(rel, bytes = 10) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(bytes));
}

try {
  put('print_bundles/IN_RA_VIEN_99000001_TRẦN_THỊ_MẪU.pdf', 100);
  put('print_bundles/IN_RA_VIEN_99000002_PHẠM_VĂN_THỬ.pdf', 200);
  put('print_bundles/ĐỖ VĂN GIẢ.pdf', 50);
  put('sessions/abc/KetQua_YLenh_one_99000003.json', 30);
  put('sessions/abc/KetQua_YLenh_one_99000004.json', 30);
  put('sessions/abc/hchanh/index.json', 5);
  put('sessions/abc/HỒ_VĂN_ĐỊNH/a.json', 5);
  put('records_check/patients/99000005__2026-01-01/a.json', 7);
  put('sessions/abc/config.json', 1024);
  put('kho_benh_nhan/kho.sqlite3', 2048);

  const res = spawnSync(process.execPath, [path.join(__dirname, 'inspect_runtime_data.js'), '--fanout=30', '--depth=4'], {
    env: { ...process.env, EMR_RUNTIME_ROOT: root },
    encoding: 'utf-8',
  });
  assert.strictEqual(res.status, 0, res.stderr);
  const out = res.stdout;

  for (const secret of ['99000001', '99000002', '99000003', '99000004', '99000005', 'MẪU', 'THỬ', 'GIẢ', 'ĐỊNH']) {
    assert.ok(!out.includes(secret), `output không được chứa "${secret}"`);
  }
  assert.match(out, /\[2 file IN_RA_VIEN_…\.pdf — đã ẩn tên\] tổng ~300 B/);
  assert.match(out, /\[1 file \[tên có dấu\]\.pdf — đã ẩn tên\]/);
  assert.match(out, /\[2 file KetQua_YLenh_one_…\.json — đã ẩn tên\]/);
  assert.match(out, /📁 \[1 thư mục \[tên có dấu\] — đã ẩn tên\] tổng ~5 B, 1 file bên trong/);
  // Thư mục dạng bản ghi chỉ tính dung lượng các thư mục con, không cộng file nằm cạnh.
  assert.match(out, /📁 \[1 thư mục con — dạng bản ghi lặp lại, đã ẩn tên\] tổng ~7 B, 1 file bên trong/);
  // Tên an toàn vẫn in, kèm dung lượng thư mục.
  assert.match(out, /📄 config\.json \(1\.0 KB\)/);
  assert.match(out, /📁 kho_benh_nhan\/ \(~2\.0 KB, 1 file\)/);
  console.log('inspect_runtime_data_test: OK');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
