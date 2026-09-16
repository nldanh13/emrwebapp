import { describe, expect, it } from 'vitest';
import { normalizeRoomCode, patientRoom, getUniqueRooms } from './patientScope.js';

describe('normalizeRoomCode', () => {
  it('chuẩn hoá đúng khi TOÀN BỘ chuỗi chỉ là "P" + số', () => {
    expect(normalizeRoomCode('P2')).toBe('P02');
    expect(normalizeRoomCode('P 09')).toBe('P09');
    expect(normalizeRoomCode('p02')).toBe('P02');
  });

  it('giữ nguyên tên phòng tự do bắt đầu bằng "P<số>..." thay vì gộp nhầm vào mã P## (khớp Xếp phòng)', () => {
    expect(normalizeRoomCode('P2 Sản')).toBe('P2 Sản');
    expect(normalizeRoomCode('P2 Sản')).not.toBe('P02');
  });

  it('trả về rỗng cho giá trị rỗng', () => {
    expect(normalizeRoomCode('')).toBe('');
    expect(normalizeRoomCode(null)).toBe('');
  });
});

describe('patientRoom / getUniqueRooms', () => {
  it('phòng tự do "P2 Sản" xuất hiện như 1 phòng riêng để chọn lấy dữ liệu, không lẫn với P02', () => {
    const patients = [
      { Vi_Tri: 'P02' },
      { Vi_Tri: 'P2 Sản' },
      { Vi_Tri: 'P2 Sản' },
    ];
    expect(patientRoom(patients[0])).toBe('P02');
    expect(patientRoom(patients[1])).toBe('P2 Sản');
    expect(getUniqueRooms(patients).sort()).toEqual(['P02', 'P2 Sản'].sort());
  });
});
