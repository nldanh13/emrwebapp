// Hồi quy: ô ghi chú checklist là input không kiểm soát (defaultValue). Khi
// chuyển hồ sơ bằng nút trước/tiếp theo, ô phải hiện ghi chú của người bệnh
// mới — không được giữ ghi chú của người trước (blur sẽ lưu nhầm hồ sơ).

import { describe, test, expect, vi } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import HchahnTab from './HchahnTab.jsx';

const FAKE_CARD = {
  ma_bn: 'BN001',
  ho_ten: 'Nguyễn Văn A',
  phong: 'P101',
  department: 'CTCH',
  scope: 'discharge',
  scope_label: 'Ra viện',
  admission_time: '',
  inpatient_status: '',
  active: true,
  fetched: {},
  data_complete: false,
  data_state: 'not_started',
  missing_files: [],
  present_files: [],
  file_statuses: {},
  status_label: 'Chưa lấy',
  status_tone: 'gray',
  fetch_error: null,
  fetch_error_active: false,
  file_attention_count: 0,
  issues: [],
  issueCounts: { errors: 0, warnings: 0 },
  qa: null,
  workflowStatus: 'gray',
  priorityScore: 0,
  ticket: null,
  ticketStatus: 'NONE',
};

function cardWithNote(ma_bn, note) {
  const rows = [{ key:'signatures', label:'Giấy ra viện', status:'pending', note, updated_at:'', stale:false }];
  return {
    ...FAKE_CARD,
    ma_bn,
    ho_ten: `BN ${ma_bn}`,
    manual_review: { rows, total_count:1, pending_count:1, stale_count:0, remaining_count:1, issue_count:0 },
  };
}

vi.mock('../../features/hchanh/api.js', () => {
  const stub = () => vi.fn(async () => ({}));
  return {
    getHchanh_Index: stub(),
    syncHchanh: vi.fn(async () => ({ total: 1 })),
    getHchanh_Dashboard: vi.fn(async () => ({ total: 1, patients: [cardWithNote('BN001', 'Thiếu chữ ký BS'), cardWithNote('BN002', '')], counts: {} })),
    getHchanh_VtytDraft: vi.fn(async () => ({ draft: null })),
    saveHchanh_VtytDraft: stub(),
    clearHchanh_VtytDraft: stub(),
    getHchanh_Patient: stub(),
    fetchHchanh: stub(),
    getHchanh_Tickets: stub(),
    createHchanh_Ticket: stub(),
    updateHchanh_Ticket: stub(),
    createHchanh_Snapshot: stub(),
    getHchanh_Snapshot: stub(),
    clearHchanh_Patient: stub(),
    clearHchanh: stub(),
    rescanHchanh: stub(),
    openHchanh_BedEdit: stub(),
    printHchanh_BillingPdf: stub(),
    downloadHchanh_BillingPdf: stub(),
    printHchanh_Ticket: stub(),
    exportHchanh_Issues: stub(),
    previewInputVTYT: stub(),
    runInputVTYT: stub(),
  };
});

describe('HchahnTab checklist', () => {
  test('chuyển hồ sơ thì ô ghi chú hiện ghi chú của người bệnh mới', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const noteValue = () => container.querySelector('input[placeholder^="Ghi chú nội dung"]')?.value;
    try {
      await act(async () => {
        root.render(React.createElement(HchahnTab, { toast: () => {}, workDateRange: {} }));
      });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      await act(async () => {
        container.querySelector('tbody tr').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      // Còn mục chưa kiểm nên panel tự mở tab Checklist cho cả hai người bệnh.
      expect(noteValue()).toBe('Thiếu chữ ký BS');

      await act(async () => {
        container.querySelector('[aria-label="Mở hồ sơ tiếp theo"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(noteValue()).toBe('');
    } finally {
      act(() => { root.unmount(); });
      container.remove();
    }
  });
});
