'use strict';
const assert = require('node:assert/strict');
const { infusionItemKey, parsePositiveInfusionValue, matchAndUpdateInfusions } = require('../server/utils/infusion_edit_validation');

assert.equal(parsePositiveInfusionValue('2,5', 'Thể tích'), 2.5);
assert.equal(parsePositiveInfusionValue('30', 'Tốc độ'), 30);
for (const bad of ['', '0', '-5', '20giọt', 'Infinity', 'NaN']) {
  assert.throws(() => parsePositiveInfusionValue(bad, 'Thể tích'));
}
const example = {
  ten_thuoc: 'TEST-DRUG', bac_si: 'DOCTOR',
  tg_bat_dau: '08:00 15/10/2026', tg_ket_thuc: '09:07 15/10/2026',
  the_tich: 100, toc_do: 30, toc_do_inferred: true,
};
const row = (list, bn = 'FAKE001') => ({ma_bn: bn, ngay_lam: '15/10/2026', thuoc: {dich_truyen:list}});
const id = r => r.ma_bn;
const date = r => r.ngay_lam;
const wrong = [row([{...example}])];
assert.deepEqual(matchAndUpdateInfusions(wrong, 'FAKE002', '15/10/2026', example,
  {toc_do:25}, id, date), {matched:0, updated:false});
const duplicate = [row([{...example},{...example}])];
assert.deepEqual(matchAndUpdateInfusions(duplicate, 'FAKE001', '15/10/2026', example,
  {toc_do:25}, id,date), {matched:2, updated:false});
assert.equal(duplicate[0].thuoc.dich_truyen[0].toc_do, 30);
const selected = [row([{...example}])];
assert.deepEqual(matchAndUpdateInfusions(selected, 'FAKE001', '15/10/2026', example,
  {toc_do:25,the_tich:120}, id,date), {matched:1, updated:true});
assert.equal(selected[0].thuoc.dich_truyen[0].toc_do, 25);
assert.equal(selected[0].thuoc.dich_truyen[0].toc_do_inferred, false);
assert.equal(selected[0].thuoc.dich_truyen[0].infusion_schedule_stale, true);
assert.equal(selected[0].thuoc.dich_truyen[0].tg_ket_thuc, '09:07 15/10/2026');
assert.ok(infusionItemKey(example).includes('test-drug'));
const { validateInfusionTargetsComplete } = require('../server/routes/patients');
const simulated = infusion => [{
  ma_bn: 'FAKE001', ngay_lam: '15/10/2026', thuoc: {dich_truyen: [infusion]},
}];
const scoped = {patientIds: ['FAKE001'], selectedDates: ['15/10/2026']};
const valid = {the_tich:100,toc_do:30,tg_bat_dau:'08:00 15/10/2026'};
assert.equal(validateInfusionTargetsComplete(simulated(valid), scoped).ok, true);
for (const [change, expected] of [
  [{...valid, toc_do_inferred:true}, 'Tốc độ'],
  [{...valid, infusion_schedule_stale:true}, 'Lịch'],
  [{...valid, tg_bat_dau:''}, 'giờ'],
  [{...valid, the_tich:0}, 'thể tích'],
]) {
  const check = validateInfusionTargetsComplete(simulated(change), scoped);
  assert.equal(check.ok, false, 'blocked unsafe infusion scenario');
  assert.match(check.message, new RegExp(expected,'i'));
  assert.equal(check.details.length, 1);
}
// Lỗi 09/11/2026: NEFOPAM có cờ missing_infusion_time (y lệnh không ghi giờ dùng)
// nhưng thông báo chỉ nói chung chung "Thiếu giờ bắt đầu", che mất nguyên nhân thật.
const noOrderHour = {
  ten_thuoc: 'NEFOPAM MEDISOL 20MG/2ML', the_tich: 100, toc_do: '30', gio_dung: '',
  missing_infusion_time: true, raw_usage_line: 'TTM khi đau',
};
const noHourCheck = validateInfusionTargetsComplete(simulated(noOrderHour), scoped);
assert.equal(noHourCheck.ok, false);
assert.match(noHourCheck.message, /Y lệnh không ghi giờ dùng/);
assert.match(noHourCheck.message, /TTM khi đau/, 'phải trích dòng y lệnh gốc để đối chiếu');
assert.doesNotMatch(noHourCheck.message, /Thiếu giờ bắt đầu/);
// Thiếu cả giờ dùng lẫn tốc độ: phải nói đủ cả hai, không chỉ một.
const noHourNoRate = {
  ten_thuoc: 'NEFOPAM MEDISOL 20MG/2ML', the_tich: 100, toc_do: '', gio_dung: '',
  missing_infusion_rate: true, raw_usage_line: 'Pha natri clorid 0,9% 100ml TTM',
};
const bothCheck = validateInfusionTargetsComplete(simulated(noHourNoRate), scoped);
assert.match(bothCheck.message, /Y lệnh không ghi giờ dùng/);
assert.match(bothCheck.message, /tốc độ/i);
// Có giờ dùng + tốc độ nhưng vẫn không có giờ bắt đầu → lịch chưa được tính.
const notScheduled = {the_tich: 100, toc_do: '30', gio_dung: '8 giờ', tg_bat_dau: ''};
assert.match(validateInfusionTargetsComplete(simulated(notScheduled), scoped).message,
  /Chưa tính được giờ bắt đầu/);

// Bổ sung giờ bắt đầu khi y lệnh không ghi giờ dùng: tự tính giờ kết thúc,
// dòng qua được kiểm tra trước khi nhập mà không cần lấy lại dữ liệu.
const { parseManualStart } = require('../server/utils/infusion_edit_validation');
assert.equal(parseManualStart('8:05 15/10/2026', '15/10/2026'), '08:05 15/10/2026');
assert.equal(parseManualStart('01:30 16/10/2026', '15/10/2026'), '01:30 16/10/2026');
for (const bad of ['08:00', '25:00 15/10/2026', '08:00 14/10/2026', '08:00 17/10/2026', '08:00 31/02/2026']) {
  assert.throws(() => parseManualStart(bad, '15/10/2026'), undefined, bad);
}
const nef = () => ({ ten_thuoc: 'NEFOPAM', gio_dung: '', the_tich: 100, toc_do: '30',
  missing_infusion_time: true, raw_usage_line: 'TTM khi đau' });
const other = { ten_thuoc: 'PARACETAMOL', tg_bat_dau: '08:00 15/10/2026', tg_ket_thuc: '08:40 15/10/2026',
  the_tich: 100, toc_do: 50, gio_dung: '8 giờ' };
const addRows = () => [row([nef(), {...other}])];
const okRows = addRows();
const added = matchAndUpdateInfusions(okRows, 'FAKE001', '15/10/2026', nef(),
  {tg_bat_dau: '09:00 15/10/2026'}, id, date);
assert.equal(added.updated, true);
const fixed = okRows[0].thuoc.dich_truyen[0];
assert.equal(fixed.tg_bat_dau, '09:00 15/10/2026');
assert.equal(fixed.tg_ket_thuc, '10:06 15/10/2026', '100 ml × 20 / 30 giọt = 66 phút');
assert.equal(fixed.missing_infusion_time, undefined);
assert.equal(fixed.infusion_schedule_stale, false);
assert.equal(fixed.tg_bat_dau_nhap_tay, true);
assert.equal(fixed.gio_dung, '9 giờ');
assert.equal(validateInfusionTargetsComplete(okRows, scoped).ok, true);
assert.equal(validateInfusionTargetsComplete(okRows, scoped).skipped.length, 0);
// Lỗi 09/11/2026: chọn 08:00 trùng Paracetamol 08:00→08:20 bị từ chối. Cùng cữ thì
// nối tiếp sau dịch đang truyền (như worker xếp lịch), không bắt người dùng tự tính.
const clashRows = addRows();
const queued = matchAndUpdateInfusions(clashRows, 'FAKE001', '15/10/2026', nef(),
  {tg_bat_dau: '08:00 15/10/2026'}, id, date);
assert.equal(queued.updated, true);
const q = clashRows[0].thuoc.dich_truyen[0];
assert.equal(q.tg_bat_dau, '08:40 15/10/2026');
assert.equal(q.tg_ket_thuc, '09:46 15/10/2026');
assert.equal(q.gio_dung, '8 giờ', 'giữ cữ người dùng chọn');
assert.equal(queued.schedule.noi_tiep_sau, 'PARACETAMOL');
assert.equal(queued.schedule.gio_chon, '08:00 15/10/2026');
// Nối tiếp qua nhiều dịch liên tiếp.
const chainRows = [row([nef(), {...other}, { ten_thuoc: 'CEFAZOLIN', tg_bat_dau: '08:40 15/10/2026',
  tg_ket_thuc: '09:00 15/10/2026', the_tich: 100, toc_do: 100, gio_dung: '8 giờ' }])];
matchAndUpdateInfusions(chainRows, 'FAKE001', '15/10/2026', nef(), {tg_bat_dau: '08:10 15/10/2026'}, id, date);
assert.equal(chainRows[0].thuoc.dich_truyen[0].tg_bat_dau, '09:00 15/10/2026');
// Giờ trống thì giữ nguyên, không ghi chú nối tiếp.
const freeRows = addRows();
const free = matchAndUpdateInfusions(freeRows, 'FAKE001', '15/10/2026', nef(), {tg_bat_dau: '06:30 15/10/2026'}, id, date);
assert.equal(freeRows[0].thuoc.dich_truyen[0].tg_bat_dau, '06:30 15/10/2026');
assert.equal(free.schedule.noi_tiep_sau, undefined);
// Bắt đầu lúc trống nhưng chạy lấn sang dịch đã có lịch sau đó → từ chối, gợi ý giờ trống.
const intoRows = addRows();
const into = matchAndUpdateInfusions(intoRows, 'FAKE001', '15/10/2026', nef(), {tg_bat_dau: '07:30 15/10/2026'}, id, date);
assert.equal(into.updated, false);
assert.match(into.error, /PARACETAMOL/);
assert.match(into.error, /08:40 15\/10\/2026/);
assert.equal(intoRows[0].thuoc.dich_truyen[0].tg_bat_dau, undefined);
// Tốc độ chưa xác nhận → phải nhập tốc độ cùng lúc.
const noRate = () => ({ ...nef(), toc_do: '', missing_infusion_rate: true });
const noRateRows = [row([noRate()])];
const refused = matchAndUpdateInfusions(noRateRows, 'FAKE001', '15/10/2026', noRate(),
  {tg_bat_dau: '09:00 15/10/2026'}, id, date);
assert.equal(refused.updated, false);
assert.match(refused.error, /tốc độ/);
const withRate = matchAndUpdateInfusions(noRateRows, 'FAKE001', '15/10/2026', noRate(),
  {tg_bat_dau: '09:00 15/10/2026', toc_do: 40}, id, date);
assert.equal(withRate.updated, true);
assert.equal(noRateRows[0].thuoc.dich_truyen[0].tg_ket_thuc, '09:50 15/10/2026');
assert.equal(validateInfusionTargetsComplete(noRateRows, scoped).ok, true);
const inferred = () => ({ ...nef(), toc_do_inferred: true });
assert.match(matchAndUpdateInfusions([row([inferred()])], 'FAKE001', '15/10/2026', inferred(),
  {tg_bat_dau: '09:00 15/10/2026'}, id, date).error, /tự đoán/);

// Lỗi 09/11/2026: NEFOPAM "x 2 (Ống) ... 100ml x2 TTM 30g/ph" (2 cữ/ngày, không ghi giờ)
// bổ sung giờ chỉ ra 1 cữ. Nhập nhiều giờ → tách thành đủ số cữ, mỗi cữ một dòng.
const nef2 = () => ({ ...nef(), so_luong: '2', raw_usage_line: 'Pha Natriclorid 0.9% 100ml x2 TTM 30g/ph' });
const twoRows = [row([nef2(), {...other}])];
const two = matchAndUpdateInfusions(twoRows, 'FAKE001', '15/10/2026', nef2(),
  {tg_bat_dau: ['20:00 15/10/2026', '08:00 15/10/2026']}, id, date);
assert.equal(two.updated, true, two.error);
const doses = twoRows[0].thuoc.dich_truyen.filter(d => d.ten_thuoc === 'NEFOPAM');
assert.equal(doses.length, 2);
assert.deepEqual(doses.map(d => [d.tg_bat_dau, d.tg_ket_thuc, d.gio_dung]), [
  ['08:40 15/10/2026', '09:46 15/10/2026', '8 giờ'],
  ['20:00 15/10/2026', '21:06 15/10/2026', '20 giờ'],
]);
assert.ok(doses.every(d => !d.missing_infusion_time && d.the_tich === 100));
assert.equal(two.schedules.length, 2);
assert.equal(validateInfusionTargetsComplete(twoRows, scoped).ok, true);
// Hai giờ chồng nhau của chính thuốc này → cữ sau nối tiếp cữ trước.
const seqRows = [row([nef2()])];
matchAndUpdateInfusions(seqRows, 'FAKE001', '15/10/2026', nef2(),
  {tg_bat_dau: ['08:00 15/10/2026', '08:30 15/10/2026']}, id, date);
assert.deepEqual(seqRows[0].thuoc.dich_truyen.map(d => d.tg_bat_dau), ['08:00 15/10/2026', '09:06 15/10/2026']);
// Một giờ lỗi → không ghi cữ nào.
const badRows = [row([nef2(), {...other}])];
const bad = matchAndUpdateInfusions(badRows, 'FAKE001', '15/10/2026', nef2(),
  {tg_bat_dau: ['20:00 15/10/2026', '07:30 15/10/2026']}, id, date);
assert.equal(bad.updated, false);
assert.equal(badRows[0].thuoc.dich_truyen.length, 2);
assert.equal(badRows[0].thuoc.dich_truyen[0].tg_bat_dau, undefined);
assert.throws(() => parseManualStart(['08:00 15/10/2026'], '15/10/2026'));
console.log('infusion edit safety: OK');
