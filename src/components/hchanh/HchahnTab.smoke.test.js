// Smoke test: mount thật HchahnTab (createRoot + act) rồi chọn một bệnh nhân
// để mở DetailPanel — chạy cả useEffect bên trong (VD: reset state khi đổi
// bệnh nhân). Lỗi kiểu "biến X is not defined" trong các effect này không bị
// esbuild/build bắt (không phải lỗi cú pháp) và renderToString cũng bỏ sót
// (SSR không chạy effect, và DetailPanel chỉ mount khi có bệnh nhân được
// chọn). Mock toàn bộ api để không gọi mạng thật trong test.

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

vi.mock('../../features/hchanh/api.js', () => {
  const stub = () => vi.fn(async () => ({}));
  return {
    getHchanh_Index: stub(),
    syncHchanh: vi.fn(async () => ({ total: 1 })),
    getHchanh_Dashboard: vi.fn(async () => ({ total: 1, patients: [FAKE_CARD], counts: {} })),
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

describe('HchahnTab smoke', () => {
  test('mount, chạy effect mount, và chọn 1 bệnh nhân (mở DetailPanel) không ném lỗi', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(React.createElement(HchahnTab, { toast: () => {}, workDateRange: {} }));
      });
      // Chờ effect mount (đồng bộ + load dashboard) chạy xong.
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      const row = container.querySelector('tbody tr');
      expect(row).toBeTruthy(); // phải thấy dòng bệnh nhân từ dashboard mock

      await act(async () => {
        row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      // Chờ effect reset state khi đổi bệnh nhân (bên trong DetailPanel) chạy xong.
      await act(async () => { await Promise.resolve(); });
    } finally {
      act(() => { root.unmount(); });
      container.remove();
    }
  });
});
