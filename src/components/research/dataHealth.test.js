// Kho nghiên cứu: mỗi con số phải nói nó là gì và phải làm gì; chỉ hai tiêu chí Đủ / Chính xác.
// Tái hiện màn hình người dùng chụp 05/10/2026: 3.015 lượt, 309 đủ, 2.650 thiếu, 26 lỗi, 30 đang lấy.
import { describe, it, expect } from 'vitest';
import { buildDataHealth } from './dataHealth.js';

const MODULES = [
  { key: 'xn_cdha', label: 'XN & CĐHA', total: 3015, done: 802 },
  { key: 'profile', label: 'Hồ sơ nền', total: 3015, done: 2580 },
  { key: 'discharge', label: 'Ra viện', total: 3015, done: 2593 },
  { key: 'surgery', label: 'Phẫu thuật', total: 3015, done: 2578 },
  { key: 'order_history', label: 'Y lệnh', total: 3015, done: 1423 },
];
const SNAP = {
  total: 3015,
  counts: { done: 309, missing: 2650, waiting: 0, error: 26, running: 30 },
  modules: MODULES,
  active_task: { label: 'Thu thập tự động' },
  unmatched_progress: 553,
};

describe('buildDataHealth', () => {
  it('mọi con số cộng lại đúng bằng tổng lượt (một mẫu số)', () => {
    const h = buildDataHealth(SNAP);
    const sum = h.complete.reduce((s, i) => s + (i.value || 0), 0);
    expect(sum).toBe(3015);
    expect(h.total).toBe(3015);
  });

  it('mỗi con số có nghĩa, và con số cần xử lý có việc phải làm', () => {
    const h = buildDataHealth(SNAP);
    for (const item of [...h.complete, ...h.accurate]) {
      expect(item.meaning).toBeTruthy();
      if (['missing', 'error', 'review', 'blocking', 'unchecked', 'stale'].includes(item.key)) expect(item.action).toBeTruthy();
    }
  });

  it('nói rõ thiếu phần nào nhiều nhất, thay vì chỉ "chưa đủ"', () => {
    const missing = buildDataHealth(SNAP).complete.find(i => i.key === 'missing');
    expect(missing.meaning).toContain('XN & CĐHA (2.213)');
    expect(missing.meaning).toContain('Y lệnh (1.592)');
  });

  it('đang chạy tự động thì không bảo người dùng bấm gì cho phần thiếu', () => {
    const missing = buildDataHealth(SNAP).complete.find(i => i.key === 'missing');
    expect(missing.action).toMatch(/không cần làm gì/);
    const idle = buildDataHealth({ ...SNAP, active_task: null }).complete.find(i => i.key === 'missing');
    expect(idle.action).toMatch(/Thu thập tự động/);
  });

  it('"Chưa ghép" không còn là con số ở phần chính', () => {
    const h = buildDataHealth(SNAP);
    expect(JSON.stringify([h.complete, h.accurate])).not.toMatch(/ghép/i);
  });

  it('chưa chuẩn hóa: báo chưa kiểm tra độ chính xác và chỉ cách làm', () => {
    const h = buildDataHealth(SNAP);
    expect(h.accuracyChecked).toBe(false);
    expect(h.accurate[0].action).toMatch(/Chuẩn hóa/);
  });

  it('có báo cáo kiểm tra: tóm tắt loại sai lệch bằng lời', () => {
    const h = buildDataHealth({
      ...SNAP,
      qa: { blocking: [], review_count: 15, review_by_issue: { possible_same_stay: 12, discharge_before_admission: 3 }, stale: true },
    });
    const review = h.accurate.find(i => i.key === 'review');
    expect(review.value).toBe(15);
    expect(review.meaning).toContain('Có thể cùng một đợt nằm viện (chuyển khoa): 12');
    expect(review.meaning).toContain('Ngày ra viện trước ngày vào viện: 3');
    expect(h.accurate.some(i => i.key === 'stale')).toBe(true);
  });

  it('đủ hết và không sai lệch: kết luận sẵn sàng phân tích', () => {
    const h = buildDataHealth({
      total: 10, counts: { done: 10 }, modules: [], qa: { blocking: [], review_count: 0, stale: false },
    });
    expect(h.verdict.tone).toBe('ok');
    expect(h.accurate[0].key).toBe('clean');
  });
});
