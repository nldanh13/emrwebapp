// Ảnh người dùng: "Lần chạy tới: lấy 2.965 lượt…, bỏ qua 32…, 44 lượt chưa ghép chắc đã được chặn"
// trong khi đang chạy, không khớp tổng, và "chưa ghép chắc" không có việc cần làm.
import { describe, it, expect } from 'vitest';
import { buildPlanView } from './collectionPlanText.js';

const PLAN = { encounters: 3041, to_fetch: 2965, parts_to_fetch: 10306, unchanged: 32, waiting_encounters: 0, unmatched_encounters: 44 };

describe('buildPlanView', () => {
  it('các nhóm cộng lại đúng bằng tổng lượt', () => {
    const v = buildPlanView(PLAN);
    expect(v.sum).toBe(v.total);
    expect(v.total).toBe(3041);
  });

  it('đang chạy thì gọi là "Lần này", không phải "Lần chạy tới"', () => {
    expect(buildPlanView(PLAN, { running: true }).title).toBe('Lần này');
    expect(buildPlanView(PLAN).title).toBe('Lần chạy tới');
  });

  it('"chưa ghép chắc" và "chờ người xem" có nghĩa và việc cần làm', () => {
    const v = buildPlanView({ ...PLAN, to_fetch: 2960, waiting_encounters: 5 }, { busy: true });
    expect(v.sum).toBe(v.total);
    const unmatched = v.notes.find(x => x.key === 'unmatched');
    expect(unmatched.meaning).toMatch(/không tự lấy/);
    expect(unmatched.action).toMatch(/Đợi lượt thu thập này xong/);
    expect(v.notes.find(x => x.key === 'waiting').action).toMatch(/Làm mới/);
  });
});
