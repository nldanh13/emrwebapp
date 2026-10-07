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
  it('màn chính chỉ có 3 nhóm Sẵn sàng / Máy xử lý / Cần bạn kiểm tra và cộng đúng tổng', () => {
    const h = buildDataHealth(SCREEN);
    expect(h.complete.map(i => i.key)).toEqual(['ready', 'automatic', 'manual']);
    expect(h.complete.map(i => i.value)).toEqual([309, 2670, 62]);
    expect(h.complete.reduce((sum, i) => sum + (i.value || 0), 0)).toBe(3041);
    expect(h.total).toBe(3041);
  });

  it('mỗi con số có nghĩa, và con số cần xử lý có việc phải làm', () => {
    const h = buildDataHealth(SCREEN);
    for (const item of [...h.complete, ...h.accurate]) {
      expect(item.meaning).toBeTruthy();
      if (item.key !== 'done' && item.key !== 'clean') expect(item.action).toBeTruthy();
    }
  });

  it('nhóm máy xử lý nói rõ phần nào còn phải hoàn thiện', () => {
    const automatic = buildDataHealth(SCREEN).complete.find(i => i.key === 'automatic');
    expect(automatic.meaning).toContain('Xét nghiệm (2.195)');
    expect(automatic.meaning).toContain('Y lệnh (1.574)');
  });

  it('đang chạy tự động thì nhóm Máy xử lý không yêu cầu người dùng thao tác', () => {
    const running = buildDataHealth(SCREEN, { autoRunning: true });
    expect(running.complete.find(i => i.key === 'automatic').action).toMatch(/không cần làm gì/i);
    const idle = buildDataHealth(SCREEN).complete.find(i => i.key === 'automatic');
    expect(idle.action).toMatch(/Thu thập tự động/);
  });

  it('hết lượt thử và chưa ghép chắc gộp thành một nhóm Cần bạn kiểm tra', () => {
    const h = buildDataHealth(SCREEN);
    const manual = h.complete.find(i => i.key === 'manual');
    expect(manual.value).toBe(62);
    expect(manual.action).toMatch(/danh sách/i);
    expect(h.verdict.text).toMatch(/cần bạn/i);
  });

  it('chưa chuẩn hóa: báo chưa kiểm tra độ chính xác và chỉ cách làm', () => {
    const h = buildDataHealth(SCREEN);
    expect(h.accuracyChecked).toBe(false);
    expect(h.accurate[0].action).toMatch(/Chuẩn hóa/);
  });

  it('đang thu thập thì không trình bày số QA cũ như kết quả hiện hành', () => {
    const h = buildDataHealth({
      ...SCREEN,
      qa: { blocking: [{ code: 'input_changed_during_normalize', message: 'Nguồn thay đổi' }], review_count: 668, stale: true },
    }, { autoRunning: true });
    expect(h.accurate).toHaveLength(1);
    expect(h.accurate[0].key).toBe('quality_pending');
    expect(h.accurate[0].meaning).toMatch(/thu thập/i);
    expect(h.accurate[0].value).toBeNull();
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
