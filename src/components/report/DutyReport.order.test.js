// "Chưa rõ giờ" là việc phải làm trước (hỏi lại bác sĩ) nên đứng ĐẦU cột, ở cả hai vai trò.
// Lỗi cũ: mục này nằm cuối trang, phải cuộn qua mọi mục mới thấy.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { DutyReport } from './DutyReport.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host; let root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear(); });

const DATE = '06/10/2026'; // Thứ 3, ngày làm
const rows = [
  { id: 'a', date: DATE, time: '08:00', patientName: 'A', room: 'P11', drugName: 'PARACETAMOL', route: 'TTM', quantity: 1, unit: 'túi' },
  { id: 'b', date: DATE, time: '20:00', patientName: 'A', room: 'P11', drugName: 'AMIPAREN', route: 'TTM', quantity: 1, unit: 'túi' },
  { id: 'c', date: DATE, time: '—', noTime: true, patientName: 'B', room: 'P11', drugName: 'VINSOLON', route: 'TMC', quantity: 1, unit: 'ống' },
];

function headings() {
  return [...host.querySelectorAll('h3')].map(h => h.textContent);
}

describe('DutyReport: mục Chưa rõ giờ đứng đầu', () => {
  for (const role of ['work', 'duty']) {
    it(`vai trò ${role === 'work' ? 'Người làm bệnh phòng' : 'Người trực'}`, () => {
      localStorage.setItem('emr_report_role_v1', JSON.stringify(role));
      act(() => root.render(createElement(DutyReport, { date: DATE, rows, nurseState: {} })));
      expect(headings()[0]).toBe('Chưa rõ giờ');
      expect(host.textContent).toContain('VINSOLON');
    });
  }
});
