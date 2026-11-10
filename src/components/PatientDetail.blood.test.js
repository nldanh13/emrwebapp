// Tab "Truyền máu" ở Nhập bệnh phòng: chỉ người bệnh có chỉ định truyền máu ngày đang xem mới có.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('../api.js', () => ({ getSessionLogs: vi.fn(async () => ({})) }));
vi.mock('./patient/LabResultsPanel.jsx', () => ({ default: () => null, useLabResultsDay: () => ({ data: null }) }));

const { default: PatientDetail } = await import('./PatientDetail.jsx');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host; let root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear(); });

const DATE = '10/11/2026';
function patient(truyenMau) {
  const day = { ngay_lam: DATE, so_phong: 'P10', thuoc: {}, cs_extra: { truyen_mau: { co_truyen_mau: truyenMau } } };
  return { ma_bn: 'p1', ho_ten: 'NGƯỜI BỆNH A', so_phong: 'P10', ngay_lam: DATE, available_dates: [DATE], day_map: { [DATE]: day }, ...day };
}
const tabLabels = () => [...host.querySelectorAll('[role="tab"]')].map(t => t.textContent);

describe('PatientDetail: tab Truyền máu', () => {
  it('không có chỉ định truyền máu thì không có tab', () => {
    act(() => root.render(createElement(PatientDetail, { patient: patient(false), onClose() {} })));
    expect(tabLabels()).not.toContain('Truyền máu');
  });

  it('có dự trù khối hồng cầu thì có tab; mở tab thấy chọn dự trù/truyền và nhập được giờ', () => {
    act(() => root.render(createElement(PatientDetail, { patient: patient(true), onClose() {} })));
    expect(tabLabels()).toContain('Truyền máu');
    act(() => [...host.querySelectorAll('[role="tab"]')].find(t => t.textContent === 'Truyền máu').click());
    expect(host.textContent).toContain('Dự trù khối hồng cầu (theo y lệnh)');
    const radio = label => [...host.querySelectorAll('[role="radio"]')].find(b => b.textContent === label);
    expect(radio('Dự trù máu, chưa truyền').getAttribute('aria-checked')).toBe('true');
    act(() => radio('Truyền máu').click());
    expect(host.querySelector('input[aria-label="Giờ bắt đầu truyền máu"]')).not.toBeNull();
  });
});
