#!/usr/bin/env node
'use strict';
// Lỗi Python hiện cho người dùng phải là câu tiếng Việt nói rõ lý do, không kèm traceback trần
// (đường dẫn file, số dòng, mã nguồn) — CLAUDE.md / docs/UX_RULES.md.
const assert = require('assert');
const { fmtPyError } = require('../server/services/python_runner');

let failed = 0;
const test = (name, fn) => { try { fn(); console.log(`  ok - ${name}`); } catch (e) { failed += 1; console.error(`  FAIL - ${name}\n`, e); } };
console.log('python_error_format_test');

// Đúng 9 dòng cuối trong ảnh chụp lỗi thật (Python 3.13, Windows).
const REAL_TAIL = [
  'Traceback (most recent call last):',
  '  File "E:\\web app\\research\\nghien_cuu_1\\lay_lich_su_xn_cdha.py", line 5423, in <module>',
  '    main()',
  '  File "E:\\web app\\research\\nghien_cuu_1\\lay_lich_su_xn_cdha.py", line 5423, in main',
  '    vao_noi_tru(driver, wait)',
  '    ~~~~~~~~~~~^^^^^^^^^^^^^^',
  '  File "E:\\web app\\research\\nghien_cuu_1\\lay_lich_su_xn_cdha.py", line 2330, in vao_noi_tru',
  '    raise RuntimeError(',
  '    ...<2 lines>...',
  '    )',
  'RuntimeError: Đăng nhập EMR chưa thành công: sau 20 giây vẫn ở trang đăng nhập. Kiểm tra tài khoản/mật khẩu EMR, hoặc tài khoản đang bị khóa/đăng nhập ở nơi khác.',
];

test('traceback thật → chỉ còn câu lý do tiếng Việt, không đường dẫn/số dòng/mã nguồn', () => {
  const msg = fmtPyError('Python lỗi khi quét dữ liệu ban đầu.', { stderrTail: REAL_TAIL });
  assert.ok(msg.startsWith('Python lỗi khi quét dữ liệu ban đầu.'), msg);
  assert.match(msg, /Đăng nhập EMR chưa thành công: sau 20 giây vẫn ở trang đăng nhập/);
  for (const bad of ['Traceback', 'File "', 'line 5423', 'E:\\web app', '^^^', 'raise RuntimeError', 'RuntimeError:']) {
    assert.ok(!msg.includes(bad), `không được còn "${bad}": ${msg}`);
  }
});

test('không có dòng ngoại lệ → giữ vài dòng log có nghĩa, bỏ dòng traceback', () => {
  const msg = fmtPyError('Lấy XN/CĐHA lỗi', { stderrTail: ['ERROR: Không mở được Chrome', '  File "x.py", line 3, in f', '    f()'] });
  assert.match(msg, /Không mở được Chrome/);
  assert.ok(!msg.includes('File "'), msg);
});

test('ngoại lệ có module (selenium.common.exceptions.TimeoutException) → lấy phần lý do', () => {
  const msg = fmtPyError('Lỗi', { stderrTail: ['Traceback (most recent call last):', '  File "a.py", line 1', 'selenium.common.exceptions.TimeoutException: Message: hết giờ chờ'] });
  assert.match(msg, /hết giờ chờ/);
  assert.ok(!msg.includes('selenium.common'), msg);
});

test('không có log → giữ nguyên câu gốc', () => {
  assert.strictEqual(fmtPyError('Lỗi X', { stderrTail: [] }), 'Lỗi X');
});

if (failed) process.exit(1);
console.log('4 test(s) passed.');
