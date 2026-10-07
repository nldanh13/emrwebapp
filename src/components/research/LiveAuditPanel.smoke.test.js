// Smoke test: mount thật LiveAuditPanel với api giả (một lượt đã so xong có khác biệt), mở chi tiết.
// Bắt lỗi chạy thật trong effect/render mà build không bắt.

import { describe, test, expect, vi } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

const DONE = {
  id: 'live_1', status: 'done', patient_code: '777', admission_date: '2026-03-01 08:00', discharge_date: '2026-03-05',
  result: {
    overall: { matched: 4, compared: 6, match_rate: 4 / 6 },
    all_match: false,
    kinds: [
      { kind: 'labs', label: 'Xét nghiệm', archive_count: 2, emr_count: 3, matched: 1, mismatched: 1, archive_only: 0, emr_only: 1, compared: 3,
        examples: { mismatched: [{ label: '2026-03-03 06:30 · HGB', archive: '120 g/l', emr: '118 g/l' }], archive_only: [], emr_only: [{ label: '2026-03-04 06:30 · CRP', value: '5 mg/l' }] } },
    ],
  },
};

vi.mock('../../api.js', () => ({
  getResearchLiveAuditSummary: vi.fn(async () => ({
    case_count: 1, all_match_count: 0, running: null,
    kinds: [{ kind: 'labs', label: 'Xét nghiệm', matched: 1, mismatched: 1, archive_only: 0, emr_only: 1, compared: 3, accuracy: 1 / 3, ci95: { low: 0.06, high: 0.79 } }],
    overall: { matched: 1, compared: 3, accuracy: 1 / 3, ci95: { low: 0.06, high: 0.79 } },
    recent: [{ id: 'live_1', status: 'done', patient_code: '777', admission_date: '2026-03-01 08:00', discharge_date: '2026-03-05', match_rate: 4 / 6, all_match: false }],
  })),
  getResearchLiveAudit: vi.fn(async () => ({ audit: DONE })),
  startResearchLiveAudit: vi.fn(),
}));

const { LiveAuditPanel } = await import('./LiveAuditPanel.jsx');

describe('LiveAuditPanel', () => {
  test('hiện bảng tỉ lệ khớp và chi tiết khác biệt của một lượt', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(React.createElement(LiveAuditPanel)); });
      expect(container.textContent).toContain('Đối chiếu tự động với EMR');
      expect(container.textContent).toContain('Tỉ lệ khớp');
      const row = [...container.querySelectorAll('button')].find(b => b.textContent.includes('Mã BN 777'));
      await act(async () => { row.click(); });
      expect(container.textContent).toContain('120 g/l');
      expect(container.textContent).toContain('Kho thiếu (EMR có, kho không có)');
      expect(container.textContent).toContain('1 lệch · 1 kho thiếu');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
