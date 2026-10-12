import { describe, expect, it } from 'vitest';
import {
  completionGroups, dayTotals, drugLabel, isoDay, monitorDay, rowInGroup, SHORT_LIST_LIMIT, shortList, stageCounts, todoCounts, todoItems,
} from './clinicBoard.js';

const row = (over = {}) => ({
  khambenhid: 'k1', ma_bn: '99000001', ho_ten: 'NGUOI A', nam_sinh: '1990', thoi_gian: '08:00 11/10/2026',
  stage: 'dang_kham', case: 'cho_ve', ...over,
});

describe('clinicBoard', () => {
  it('đếm lượt khám theo 3 nhóm và cộng lại khớp tổng', () => {
    const c = stageCounts([row({ stage: 'cho_kham' }), row({ stage: 'dang_lam_dv' }), row({ stage: 'chua_hoan_tat' }), row({ stage: 'xong' })]);
    expect(c).toEqual({ cho_kham: 1, dang: 2, xong: 1, total: 4 });
    expect(c.cho_kham + c.dang + c.xong).toBe(c.total);
  });

  it('chia người chờ hoàn tất theo đơn thuốc', () => {
    const g = completionGroups([
      row({ khambenhid: 'a', eligible: true, check: { status: 'ready', drugs: 2 } }),
      row({ khambenhid: 'b', eligible: true, check: { status: 'no_drug', drugs: 0 } }),
      row({ khambenhid: 'c', eligible: true, check: null }),
      row({ khambenhid: 'd', eligible: true, check: { status: 'need_weight' }, weight_entered: 50 }),
      row({ khambenhid: 'e', eligible: true, check: { status: 'done' } }),
      row({ khambenhid: 'f', eligible: false }),
    ]);
    expect(g.ready.map(r => r.khambenhid)).toEqual(['a', 'c', 'd']);  // c: chưa mở màn khám, kiểm tra khi bấm Hoàn tất
    expect(g.noDrug.map(r => r.khambenhid)).toEqual(['b']);
    expect(g.pending.map(r => r.khambenhid)).toEqual([]);
    expect(drugLabel(g.ready[0])).toBe('Có 2 thuốc');
    expect(drugLabel(g.noDrug[0])).toBe('Chưa có thuốc');
    expect(drugLabel(g.ready[1])).toBe('Kiểm tra thuốc khi bấm Hoàn tất');
  });

  it('liệt kê thủ thuật, phẫu thuật, SBBHC cần làm', () => {
    const items = todoItems([
      row({ khambenhid: 'a', pending_tt: 1, procedure_task: true }),
      row({ khambenhid: 'b', pending_tt: 1, procedure_task: true, tt_task: { status: 'waiting', message: 'Chờ tới 09:10' } }),
      row({ khambenhid: 'c', pending_pt: 1, ngoaitru: true, ngoaitru_state: null }),
      row({ khambenhid: 'd', bbhc: ['Chụp CT'], bbhc_state: { status: 'draft' } }),
      row({ khambenhid: 'e', bbhc: ['Chuyển viện'], bbhc_state: { status: 'done' } }),
      row({ khambenhid: 'f', pending_tt: 1, stage: 'cho_kham' }),
      row({ khambenhid: 'g', pending_tt: 1, stage: 'xong' }),
    ]);
    expect(items.map(i => i.key)).toEqual(['a:tt', 'b:tt', 'c:pt', 'd:sbbhc']);
    expect(items[1]).toMatchObject({ status: 'Chờ tới 09:10', tone: 'muted' });
    expect(items[3].status).toBe('Đã soạn nháp, chờ duyệt');
    expect(todoCounts(items)).toEqual({ tt: 2, pt: 1, sbbhc: 1, cs: 0 });
  });
});

describe('ngày theo dõi', () => {
  const now = new Date(2026, 9, 11, 14, 30);
  it('lấy ngày của lần đọc danh sách, ghi thứ và ngày tháng', () => {
    expect(monitorDay({ updated_at: new Date(2026, 9, 11, 7, 5).toISOString() }, now))
      .toEqual({ label: 'Chủ nhật, 11/10/2026', short: '11/10/2026', iso: '2026-10-11', today: true });
    expect(monitorDay({ updated_at: new Date(2026, 9, 9, 16, 0).toISOString() }, now))
      .toEqual({ label: 'Thứ sáu, 09/10/2026', short: '09/10/2026', iso: '2026-10-09', today: false });
  });
  it('chọn xem lại ngày cũ thì lấy đúng ngày đã chọn', () => {
    expect(monitorDay({ list_date: '2026-10-09', updated_at: now.toISOString() }, now))
      .toEqual({ label: 'Thứ sáu, 09/10/2026', short: '09/10/2026', iso: '2026-10-09', today: false });
    expect(isoDay(new Date(2026, 0, 3))).toBe('2026-01-03');
  });
  it('chưa đọc lần nào thì dùng lúc bắt đầu, không có gì thì là hôm nay', () => {
    expect(monitorDay({ started_at: new Date(2026, 9, 12, 6, 0).toISOString() }, now).label).toBe('Thứ hai, 12/10/2026');
    expect(monitorDay(null, now)).toEqual({ label: 'Chủ nhật, 11/10/2026', short: '11/10/2026', iso: '2026-10-11', today: true });
    expect(monitorDay({ updated_at: 'không phải ngày' }, now).today).toBe(true);
  });
});

describe('Nhập viện trong Việc cần làm', () => {
  it('người bệnh nhập viện còn đang khám → nhắc nhập chăm sóc', () => {
    const items = todoItems([{ khambenhid: 'n', ma_bn: '1', case: 'nhap_vien', stage: 'dang_kham' },
      { khambenhid: 'x', ma_bn: '2', case: 'nhap_vien', stage: 'xong' }]);
    expect(items.map(i => i.kind)).toEqual(['cs']);
    expect(todoCounts(items).cs).toBe(1);
  });
});

describe('shortList', () => {
  const rows = Array.from({ length: 74 }, (_, i) => ({ khambenhid: String(i) }));
  it('chỉ hiện vài người đầu, còn lại thu gọn (danh sách dài 74 người kéo dài cả trang)', () => {
    const s = shortList(rows, false);
    expect(s.shown).toHaveLength(SHORT_LIST_LIMIT);
    expect(s.hidden).toBe(74 - SHORT_LIST_LIMIT);
  });
  it('bấm Xem tất cả thì hiện đủ', () => {
    const s = shortList(rows, true);
    expect(s.shown).toHaveLength(74);
    expect(s.hidden).toBe(0);
  });
  it('danh sách ngắn thì hiện hết, không có nút', () => {
    expect(shortList(rows.slice(0, 3), false)).toEqual({ shown: rows.slice(0, 3), hidden: 0 });
  });
});

describe('dayTotals', () => {
  it('tổng cả ngày: thủ thuật, phẫu thuật (số chỉ định và đã xong), chuyển viện, nhập viện', () => {
    const rows = [
      row({ khambenhid: 'a', services: [{ code: 'TT', done: 1, total: 2 }, { code: 'CDHA', done: 1, total: 1 }], case: 'cho_ve', stage: 'xong' }),
      row({ khambenhid: 'b', services: [{ code: 'TT', done: 1, total: 1 }, { code: 'PT', done: 0, total: 1 }], case: 'chuyen_vien' }),
      row({ khambenhid: 'c', services: [], case: 'nhap_vien' }),
      row({ khambenhid: 'd', services: [], case: 'chuyen_vien', stage: 'xong' }),
    ];
    expect(dayTotals(rows)).toEqual({ tt: { total: 3, done: 2 }, pt: { total: 1, done: 0 }, chuyen_vien: 2, nhap_vien: 1 });
  });
});

describe('rowInGroup', () => {
  it('mặc định "Chưa hoàn tất": bỏ người đã Hoàn tất / Đã tất toán', () => {
    expect(rowInGroup(row({ stage: 'xong' }), 'chua_xong')).toBe(false);
    expect(rowInGroup(row({ stage: 'dang_kham', case: 'cho_ve' }), 'chua_xong')).toBe(true);
    expect(rowInGroup(row({ stage: 'cho_kham' }), 'chua_xong')).toBe(true);
    expect(rowInGroup(row({ stage: 'xong' }), 'all')).toBe(true);
  });
});
