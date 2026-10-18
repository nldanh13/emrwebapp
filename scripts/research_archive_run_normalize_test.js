#!/usr/bin/env node
'use strict';

// /research/archive/run (Quét danh sách / Lấy XN-CĐHA của kho gốc) không được chuẩn hóa thẳng
// trong máy chủ: chuẩn hóa đọc/ghi đồng bộ nhiều file, chạy trong máy chủ khi vẫn giữ khóa
// "Lấy dữ liệu" thì máy chủ bị chặn — terminal đã "Phiên kết thúc" mà giao diện vẫn "Đang chạy".
// Phải xếp hàng Chuẩn hóa ở tiến trình con (runNormalizeJob) như sau Thu thập tự động.
// Chạy: node scripts/research_archive_run_normalize_test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'research.js'), 'utf-8');
const start = src.indexOf("lockedResearchRoute(router, 'post', '/research/archive/run'");
assert.ok(start >= 0, 'không tìm thấy route /research/archive/run');
const next = src.indexOf('lockedResearchRoute(router,', start + 10);
const block = src.slice(start, next > 0 ? next : undefined);

assert.ok(!/normalizeRunOutputs\s*\(/.test(block), 'archive/run không được gọi normalizeRunOutputs() ngay trong máy chủ');
assert.ok(/runNormalizeJob\s*\(/.test(block), 'archive/run phải xếp hàng Chuẩn hóa bằng runNormalizeJob()');
console.log('  ok - archive/run chuẩn hóa ở tiến trình con, không chặn máy chủ');
