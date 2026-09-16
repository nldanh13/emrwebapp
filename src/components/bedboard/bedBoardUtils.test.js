import { describe, expect, it } from 'vitest';
import { normalizeRoom, canonicalRoomKey, matchesRoom, roomPriceTier } from './bedBoardUtils.js';

describe('normalizeRoom', () => {
  it('chuẩn hoá đúng khi TOÀN BỘ chuỗi chỉ là "P" + số', () => {
    expect(normalizeRoom('P2')).toBe('P02');
    expect(normalizeRoom('P 09')).toBe('P09');
    expect(normalizeRoom('p02')).toBe('P02');
    expect(normalizeRoom('P011')).toBe('P11');
  });

  it('KHÔNG chuẩn hoá tên phòng tự do bắt đầu bằng "P<số>..." (không được nhận nhầm thành trùng)', () => {
    expect(normalizeRoom('P2 Sản')).toBe('');
    expect(normalizeRoom('P1 VIP')).toBe('');
  });

  it('trả về rỗng cho chuỗi không có mẫu P+số hoặc rỗng', () => {
    expect(normalizeRoom('')).toBe('');
    expect(normalizeRoom('Phòng VIP A')).toBe('');
  });
});

describe('canonicalRoomKey', () => {
  it('dùng dạng chuẩn P## khi khớp, giữ nguyên văn khi là tên tự do', () => {
    expect(canonicalRoomKey('P2')).toBe('P02');
    expect(canonicalRoomKey('P2 Sản')).toBe('P2 Sản');
    expect(canonicalRoomKey('Phòng VIP A')).toBe('Phòng VIP A');
  });

  it('"P2" và "P2 Sản" phải là 2 khoá KHÁC nhau (không trùng khi thêm phòng)', () => {
    expect(canonicalRoomKey('P2')).not.toBe(canonicalRoomKey('P2 Sản'));
  });
});

describe('matchesRoom', () => {
  it('so khớp đúng bệnh nhân đã gán vào phòng tự do "P2 Sản", không lẫn với "P02"', () => {
    expect(matchesRoom('P2 Sản', 'P2 Sản')).toBe(true);
    expect(matchesRoom('P2 Sản', 'P02')).toBe(false);
    expect(matchesRoom('P02', 'P2 Sản')).toBe(false);
  });
});

describe('roomPriceTier', () => {
  it('P1 = 500k, P2-P7 = 600k, còn lại (kể cả phòng tự do) = 250k', () => {
    expect(roomPriceTier('P01')).toBe(500000);
    expect(roomPriceTier('P02')).toBe(600000);
    expect(roomPriceTier('P07')).toBe(600000);
    expect(roomPriceTier('P08')).toBe(250000);
    expect(roomPriceTier('P2 Sản')).toBe(250000);
    expect(roomPriceTier('Phòng VIP A')).toBe(250000);
  });
});
