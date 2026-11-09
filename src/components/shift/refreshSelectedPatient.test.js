import { describe, expect, it } from 'vitest';
import { refreshSelectedPatient } from './shiftUtils.js';

// Lỗi 09/11/2026: bấm "Bổ sung giờ" lưu thành công, danh sách tải lại nhưng chi tiết BN
// đang mở vẫn là bản chụp cũ nên dòng NEFOPAM vẫn hiện "Chưa xác định giờ truyền".
describe('refreshSelectedPatient', () => {
  const stale = { ma_bn: 'FAKE001', day_map: { '15/10/2026': { thuoc: { dich_truyen: [{ tg_bat_dau: '' }] } } } };
  const fresh = { ma_bn: 'FAKE001', day_map: { '15/10/2026': { thuoc: { dich_truyen: [{ tg_bat_dau: '09:26 15/10/2026' }] } } } };

  it('thay bằng bản mới cùng mã BN sau khi tải lại', () => {
    expect(refreshSelectedPatient(stale, [{ ma_bn: 'OTHER' }, fresh])).toBe(fresh);
  });
  it('giữ nguyên khi chưa chọn BN hoặc BN không còn trong danh sách', () => {
    expect(refreshSelectedPatient(null, [fresh])).toBe(null);
    expect(refreshSelectedPatient(stale, [{ ma_bn: 'OTHER' }])).toBe(stale);
  });
});
