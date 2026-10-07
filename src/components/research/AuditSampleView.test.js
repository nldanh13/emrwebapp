// Màn Kiểm tra ngẫu nhiên: chọn ca, bấm Đúng/Sai lưu ngay (không có nút Lưu), tỉ lệ đạt cập nhật.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';

const audit = {
  id: 'aud_1', patient_code: '801', patient_name: 'BN GIA LAP', admission_date: '2026-03-01 08:00', discharge_date: '2026-03-10',
  items: [
    { id: 'enc_admission', group: 'encounter', label: 'Ngày giờ vào viện', detail: '2026-03-01 08:00', question: 'Đúng với EMR?', verdict: '', note: '' },
    { id: 'labs_x', group: 'labs', label: '2026-03-02 07:00 · WBC', detail: '9 G/L', period: 'Trong đợt', question: 'Đúng?', verdict: '', note: '' },
  ],
};
const summary = { audit_count: 1, completed_count: 0, groups: [], overall: { checked: 0 }, failures: [], recent: [] };

vi.mock('../../api.js', () => ({
  getResearchAuditSummary: vi.fn(async () => summary),
  getResearchAudit: vi.fn(async () => ({ audit })),
  createResearchAuditSample: vi.fn(async () => ({ audit })),
  saveResearchAuditItem: vi.fn(async (id, itemId, body) => ({
    audit: { ...audit, items: audit.items.map(i => (i.id === itemId ? { ...i, ...body } : i)) },
  })),
}));

const api = await import('../../api.js');
const { AuditSampleView } = await import('./AuditSampleView.jsx');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host; let root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const button = label => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === label);

describe('AuditSampleView', () => {
  it('chọn ca ngẫu nhiên, bấm Sai lưu ngay cho đúng mục', async () => {
    act(() => root.render(createElement(AuditSampleView)));
    await flush();
    expect(host.textContent).toContain('Chưa có mục nào được kiểm');
    await act(async () => { button('Chọn ca ngẫu nhiên').click(); });
    await flush();
    expect(host.textContent).toContain('Mã BN 801');
    expect(host.textContent).toContain('0/2 mục đã kiểm');
    await act(async () => { button('Sai').click(); });
    await flush();
    expect(api.saveResearchAuditItem).toHaveBeenCalledWith('aud_1', 'enc_admission', { verdict: 'sai', note: '' });
    expect(host.textContent).toContain('1/2 mục đã kiểm');
    expect(host.textContent).toContain('Đã lưu');
  });
});
