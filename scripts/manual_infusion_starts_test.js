'use strict';
// Lỗi 09/11/2026: "Bổ sung giờ" 2 cữ NEFOPAM xong, bấm nhập → tiền kiểm thấy "YL mới",
// xử lý lại y lệnh và giờ bổ sung bị mất. Giờ phải được khôi phục khi dòng y lệnh không đổi.
const assert = require('node:assert/strict');
const { matchAndUpdateInfusions } = require('../server/utils/infusion_edit_validation');
const { collectManualStarts, reapplyManualStarts } = require('../server/utils/manual_infusion_starts');

const usage = 'Pha Natriclorid 0.9% 100ml x2 TTM 30g/ph | Thuốc pha: Natri clorid 0,9%';
const nef = () => ({ ten_thuoc: 'NEFOPAM MEDISOL 20MG/2ML', raw_usage_line: usage, so_luong: '2',
  gio_dung: '', the_tich: 100, toc_do: '30', missing_infusion_time: true });
const vanco = () => ({ ten_thuoc: 'Vancomycin', gio_dung: '20 giờ', the_tich: 100, toc_do: '30',
  tg_bat_dau: '20:00 09/11/2026', tg_ket_thuc: '21:06 09/11/2026' });
const freshRows = () => [{ ma_bn: 'FAKE001', ngay_lam: '09/11/2026', thuoc: { dich_truyen: [nef(), vanco()] } }];
const id = r => r.ma_bn;
const date = r => r.ngay_lam;

const before = freshRows();
const saved0 = matchAndUpdateInfusions(before, 'FAKE001', '09/11/2026', nef(),
  { tg_bat_dau: ['08:00 09/11/2026', '20:00 09/11/2026'] }, id, date);
assert.equal(saved0.updated, true);

const saved = collectManualStarts(before);
assert.equal(saved.size, 1);
assert.deepEqual([...saved.values()][0].starts, ['08:00 09/11/2026', '20:00 09/11/2026'], 'lưu giờ đã chọn, không phải giờ sau nối tiếp');

// Sau post_process.py: dữ liệu tạo lại, dòng NEFOPAM lại chưa có giờ.
const after = freshRows();
const r = reapplyManualStarts(after, saved);
assert.equal(r.restored.length, 1);
const doses = after[0].thuoc.dich_truyen.filter(d => d.ten_thuoc.startsWith('NEFOPAM'));
assert.deepEqual(doses.map(d => [d.tg_bat_dau, d.tg_ket_thuc]), [
  ['08:00 09/11/2026', '09:06 09/11/2026'],
  ['21:06 09/11/2026', '22:12 09/11/2026'],
]);

// Bác sĩ đã ghi giờ trong y lệnh mới → không ghi đè.
const doctorTimed = freshRows();
Object.assign(doctorTimed[0].thuoc.dich_truyen[0], { gio_dung: '9 giờ', tg_bat_dau: '09:00 09/11/2026',
  tg_ket_thuc: '10:06 09/11/2026', missing_infusion_time: false });
const r2 = reapplyManualStarts(doctorTimed, saved);
assert.equal(r2.restored.length, 0);
assert.equal(doctorTimed[0].thuoc.dich_truyen[0].tg_bat_dau, '09:00 09/11/2026');

// Dòng y lệnh đã đổi (vd. số lượng) → không khôi phục, báo bỏ qua.
const changed = freshRows();
changed[0].thuoc.dich_truyen[0].so_luong = '3';
const r3 = reapplyManualStarts(changed, saved);
assert.equal(r3.restored.length, 0);
assert.equal(r3.skipped.length, 1);
assert.equal(changed[0].thuoc.dich_truyen[0].tg_bat_dau, undefined);

console.log('manual infusion starts survive reprocess: OK');
