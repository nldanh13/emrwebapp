// Giờ bắt đầu thực tế (tg_bat_dau) gần một cữ trong giờ dùng là CHÍNH cữ đó, không phải cữ mới.
// Lỗi cũ: tg_bat_dau 08:20 + giờ dùng "08:00, 20:00" → 3 cữ 08:00, 08:20, 20:00 (dư cữ 08:20,
// người làm thấy AMIPAREN/VANCOMYCIN hai lần lúc 8h).
import { describe, it, expect } from 'vitest';
import { extractTimes } from './reportBaseUtils.js';

const times = (item) => extractTimes(item, '05/10/2026').map(t => `${t.time} ${t.date}`);

describe('extractTimes: giờ bắt đầu và giờ dùng', () => {
  it('giờ bắt đầu lệch cữ trong giờ dùng dưới 60 phút → gộp, không thành cữ riêng', () => {
    expect(times({ tg_bat_dau: '05/10/2026 08:20', gio_dung: '08:00, 20:00' }))
      .toEqual(['08:00 05/10/2026', '20:00 05/10/2026']);
  });

  it('giờ bắt đầu sớm hơn cữ một chút cũng gộp', () => {
    expect(times({ tg_bat_dau: '05/10/2026 07:45', gio_dung: '08:00' })).toEqual(['08:00 05/10/2026']);
  });

  it('giờ bắt đầu xa mọi cữ trong giờ dùng → vẫn giữ (không mất giờ nào)', () => {
    expect(times({ tg_bat_dau: '05/10/2026 14:00', gio_dung: '08:00, 20:00' }))
      .toEqual(['14:00 05/10/2026', '08:00 05/10/2026', '20:00 05/10/2026']);
  });

  it('chỉ có giờ bắt đầu → dùng giờ bắt đầu', () => {
    expect(times({ tg_bat_dau: '05/10/2026 08:20' })).toEqual(['08:20 05/10/2026']);
  });

  it('giờ bắt đầu ngày khác (cùng giờ) không bị gộp nhầm vào cữ hôm nay', () => {
    expect(times({ tg_bat_dau: '04/10/2026 08:10', gio_dung: '08:00' }))
      .toEqual(['08:10 04/10/2026', '08:00 05/10/2026']);
  });

  it('không có giờ → Chưa rõ giờ', () => {
    expect(extractTimes({ gio_dung: '' }, '05/10/2026')[0].noTime).toBe(true);
  });
});
