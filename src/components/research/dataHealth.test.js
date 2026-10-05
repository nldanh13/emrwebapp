// Kho nghiên cứu: mỗi con số phải nói nó là gì và phải làm gì; chỉ hai tiêu chí Đủ / Chính xác.
// Số liệu lấy từ mô hình màn hình (một nguồn: sổ thu thập), các nhóm chia rời nhau.
import { describe, it, expect } from 'vitest';
import { buildDataHealth } from './dataHealth.js';

const PARTS = [
  { key: 'xn', label: 'Xét nghiệm', total: 2997, done: 802 },
  { key: 'cdha', label: 'CĐHA', total: 2997, done: 900 },
  { key: 'profile', label: 'Hồ sơ nền', total: 2997, done: 2580 },
  { key: 'discharge', label: 'Ra viện', total: 2997, done: 2593 },
  { key: 'surgery', label: 'Phẫu thuật', total: 2997, done: 2578 },
  { key: 'order_history', label: 'Y lệnh', total: 2997, done: 1423 },
];
const SCREEN = {
  total: 3041,
  counts: { done: 309, missing: 2600, error: 70, waiting: 18, unmatched: 44 },
  parts: PARTS,
  plan: { max_attempts: 3 },
};

describe('buildDataHealth', () => {
  it('các nhóm cộng lại đúng bằng tổng lượt (một mẫu số)', () => {
    const h = buildDataHealth(SCREEN);
    const sum = h.complete.reduce((s, i) => s + (i.value || 0), 0);
    expect(sum).toBe(3041);
    expect(h.total).toBe(3041);
  });

  it('mỗi con số có nghĩa, và con số cần xử lý có việc phải làm', () => {
    const h = buildDataHealth(SCREEN);
    for (const item of [...h.complete, ...h.accurate]) {
      expect(item.meaning).toBeTruthy();
      if (item.key !== 'done' && item.key !== 'clean') expect(item.action).toBeTruthy();
    }
  });

  it('nói rõ thiếu phần nào nhiều nhất', () => {
    const missing = buildDataHealth(SCREEN).complete.find(i => i.key === 'missing');
    expect(missing.meaning).toContain('Xét nghiệm (2.195)');
    expect(missing.meaning).toContain('Y lệnh (1.574)');
  });

  it('đang chạy tự động thì không bảo người dùng bấm gì cho phần thiếu/lỗi', () => {
    const running = buildDataHealth(SCREEN, { autoRunning: true });
    expect(running.complete.find(i => i.key === 'missing').action).toMatch(/không cần làm gì/);
    expect(running.complete.find(i => i.key === 'error').action).toMatch(/Không cần làm gì/);
    const idle = buildDataHealth(SCREEN).complete.find(i => i.key === 'missing');
    expect(idle.action).toMatch(/Thu thập tự động/);
  });

  it('"Chờ người xem" và "Chưa ghép chắc" là việc của người, có việc cụ thể', () => {
    const h = buildDataHealth(SCREEN);
    expect(h.complete.find(i => i.key === 'waiting').action).toMatch(/Làm mới/);
    expect(h.complete.find(i => i.key === 'unmatched').action).toMatch(/Rà soát ghép lượt/);
    expect(h.verdict.text).toMatch(/Có việc cần bạn xử lý/);
  });

  it('chưa chuẩn hóa: báo chưa kiểm tra độ chính xác và chỉ cách làm', () => {
    const h = buildDataHealth(SCREEN);
    expect(h.accuracyChecked).toBe(false);
    expect(h.accurate[0].action).toMatch(/Chuẩn hóa/);
  });

  it('có báo cáo kiểm tra: tóm tắt loại sai lệch bằng lời', () => {
    const h = buildDataHealth({
      ...SCREEN,
      qa: { blocking: [], review_count: 15, review_by_issue: { possible_same_stay: 12, discharge_before_admission: 3 }, stale: true },
    });
    const review = h.accurate.find(i => i.key === 'review');
    expect(review.value).toBe(15);
    expect(review.meaning).toContain('Có thể cùng một đợt nằm viện (chuyển khoa): 12');
    expect(h.accurate.some(i => i.key === 'stale')).toBe(true);
  });

  it('đủ hết và không sai lệch: kết luận sẵn sàng phân tích', () => {
    const h = buildDataHealth({ total: 10, counts: { done: 10 }, parts: [], qa: { blocking: [], review_count: 0, stale: false } });
    expect(h.verdict.tone).toBe('ok');
    expect(h.accurate[0].key).toBe('clean');
  });
});
