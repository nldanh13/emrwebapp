// Y lệnh ghi buổi bằng chữ (sáng/trưa/chiều/tối) thay vì giờ số: máy quy về giờ cữ của khoa và
// ĐÁNH DẤU là giờ suy từ chữ, thay vì xếp vào "Chưa rõ giờ".
// Lỗi cũ: "Permethrine 01 chai tắm hàng ngày vào buổi trưa" nằm ở "Chưa rõ giờ".
import { describe, it, expect } from 'vitest';
import { extractTimes, SESSION_TIMES } from './reportBaseUtils.js';

const D = '05/10/2026';
const times = (item) => extractTimes(item, D).map(t => (t.noTime ? 'chưa rõ' : `${t.time}${t.guessFrom ? `~${t.guessFrom}` : ''}`));

describe('giờ theo chữ buổi', () => {
  it('"buổi trưa" trong tên/hướng dẫn thuốc → 12:00 (trực trưa), đánh dấu suy từ chữ', () => {
    expect(times({ ten_thuoc: 'Permethrine 01 chai tắm hàng ngày vào buổi trưa' })).toEqual(['12:00~trưa']);
  });

  it('lịch dùng "Sáng" → 08:00; "Sáng, Chiều" → 08:00 và 16:00; "Tối" → 20:00', () => {
    expect(times({ lich_dung: 'Sáng' })).toEqual(['08:00~sáng']);
    expect(times({ lich_dung: 'Sáng, Chiều' })).toEqual(['08:00~sáng', '16:00~chiều']);
    expect(times({ cach_dung: 'uống tối trước khi ngủ' })).toEqual(['20:00~tối']);
  });

  it('có giờ số thì dùng giờ số, bỏ qua chữ buổi', () => {
    expect(times({ gio_dung: '08:00', ten_thuoc: 'Thuốc X uống sáng' })).toEqual(['08:00']);
  });

  it('không nhầm "tối đa", "tối thiểu", "sáng tạo" là buổi', () => {
    expect(times({ ten_thuoc: 'Paracetamol tối đa 4g/ngày, tối thiểu cách 6 giờ' })).toEqual(['chưa rõ']);
  });

  it('không có giờ số, không có chữ buổi → vẫn "Chưa rõ giờ"', () => {
    expect(times({ ten_thuoc: 'VINSOLON 40mg' })).toEqual(['chưa rõ']);
  });

  it('giờ cữ của từng buổi khớp lịch thuốc của khoa', () => {
    expect(SESSION_TIMES).toEqual({ 'sáng': '08:00', 'trưa': '12:00', 'chiều': '16:00', 'tối': '20:00' });
  });
});
