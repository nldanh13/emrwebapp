// Smoke test: PatientPreview phải hiện được mục "Nhập VTYT" (đọc từ
// patientDay.vtyt.items) — trước đây component chỉ hiện chăm sóc/dịch truyền,
// khiến người dùng không xem trước được nhập VTYT là gì dù dữ liệu đã có sẵn.

import { describe, test, expect } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import PatientPreview from './PatientPreview.jsx';

const PATIENT_DAY = {
  preview: { care: [], infusions: [] },
  vtyt: {
    items: [
      { key: 'BOM_TIEM_20ML', name: 'Bơm tiêm 20ml', required_quantity: 2, reasons: ['Kháng sinh TMC: bơm tiêm 20ml mỗi cử'] },
      { key: 'KIM_LUON_TM', name: 'Kim luồn TM', required_quantity: 1, needs_review: true, reasons: ['thiếu dữ liệu lịch sử nên cần kiểm lại trước khi nhập'] },
    ],
    warnings: ['Cảnh báo mẫu'],
  },
};

describe('PatientPreview', () => {
  test('hiện danh sách VTYT khi patientDay.vtyt.items có dữ liệu', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => { root.render(React.createElement(PatientPreview, { patientDay: PATIENT_DAY })); });

    const text = container.textContent;
    expect(text).toContain('Nhập VTYT (2)');
    expect(text).toContain('Bơm tiêm 20ml');
    expect(text).toContain('Kim luồn TM');
    expect(text).toContain('Cần kiểm lại');
    expect(text).toContain('Cảnh báo mẫu');

    act(() => { root.unmount(); });
  });

  test('hiện thông báo trống khi không có VTYT', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => { root.render(React.createElement(PatientPreview, { patientDay: { preview: {} } })); });

    expect(container.textContent).toContain('Không có dữ liệu xem trước cho nhập VTYT');

    act(() => { root.unmount(); });
  });
});
