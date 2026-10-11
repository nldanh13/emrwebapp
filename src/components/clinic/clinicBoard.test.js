import { describe, expect, it } from 'vitest';
import {
  completionGroups, drugLabel, sickLeaveKey, sickLeavePayload, sickLeaveSuggestions, stageCounts, todoCounts, todoItems,
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
    expect(g.ready.map(r => r.khambenhid)).toEqual(['a', 'd']);
    expect(g.noDrug.map(r => r.khambenhid)).toEqual(['b']);
    expect(g.pending.map(r => r.khambenhid)).toEqual(['c']);
    expect(drugLabel(g.ready[0])).toBe('Có 2 thuốc');
    expect(drugLabel(g.noDrug[0])).toBe('Chưa có thuốc');
    expect(drugLabel(g.pending[0])).toBe('Đang kiểm tra thuốc…');
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
    expect(todoCounts(items)).toEqual({ tt: 2, pt: 1, sbbhc: 1 });
  });

  it('gợi ý nghỉ ốm: đã vào khám, còn tuổi lao động, chưa đánh dấu', () => {
    const rows = [
      row({ khambenhid: 'a' }),
      row({ khambenhid: 'b', nam_sinh: '1940' }),
      row({ khambenhid: 'c', stage: 'cho_kham' }),
      row({ khambenhid: 'd' }),
    ];
    const out = sickLeaveSuggestions(rows, new Set(['d']), 2026);
    expect(out.map(r => r.khambenhid)).toEqual(['a']);
  });

  it('khóa nghỉ ốm khớp cách máy chủ đặt', () => {
    expect(sickLeaveKey(row())).toBe('k1');
    expect(sickLeaveKey(row({ khambenhid: '' }))).toBe('99000001:2026-10-11');
    expect(sickLeavePayload(row({ details: { cd_chinh: 'S52 Gãy xương' } }))).toMatchObject({ ma_bn: '99000001', chan_doan: 'S52 Gãy xương' });
  });
});
