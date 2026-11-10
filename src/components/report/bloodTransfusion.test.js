// Truyền máu không bàn giao: dòng chế phẩm máu và xét nghiệm đi kèm phải ra khỏi "Chưa rõ giờ",
// "Cữ trong ca" và "Bàn giao ca trực", và có các mốc chăm sóc tạo từ giờ bắt đầu/kết thúc.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { bloodKind, buildCareText, buildTransfusionPrintHtml, buildTransfusionTimeline, groupTransfusions } from './bloodTransfusion.js';
import { DutyReport } from './DutyReport.jsx';

describe('bloodKind', () => {
  it('nhận chế phẩm máu và xét nghiệm trước truyền', () => {
    expect(bloodKind({ drugName: 'Khối hồng cầu từ 350ml máu toàn phần' })).toBe('product');
    expect(bloodKind({ drugName: 'Huyết tương tươi đông lạnh 250ml' })).toBe('product');
    expect(bloodKind({ drugName: 'Định nhóm máu hệ ABO' })).toBe('test');
    expect(bloodKind({ drugName: 'Định nhóm máu hệ Rh' })).toBe('test');
    expect(bloodKind({ drugName: 'Phản ứng hòa hợp trong môi trường nước muối ở 22°C' })).toBe('test');
  });
  it('không nhầm thuốc thường', () => {
    for (const name of ['Paracetamol 10mg/ml', 'Nước cất pha tiêm', 'NATRI CLORID 0,9%', 'Gemapaxane', 'Tranexamic acid']) {
      expect(bloodKind({ drugName: name })).toBe('');
    }
  });
});

describe('buildTransfusionTimeline', () => {
  it('đúng các mốc của ví dụ 14:00 → 16:33', () => {
    const { slots, endMissing } = buildTransfusionTimeline('14:00', '16:33');
    expect(endMissing).toBe(false);
    expect(slots.map(s => s.time)).toEqual(['13:50', '14:00', '14:15', '15:00', '16:00', '16:33']);
    expect(slots.map(s => s.kind)).toEqual(['pre', 'start', 'check', 'check', 'check', 'end']);
  });
  it('mốc theo giờ không vượt quá giờ kết thúc', () => {
    expect(buildTransfusionTimeline('14:00', '15:00').slots.map(s => s.time)).toEqual(['13:50', '14:00', '14:15', '15:00']);
    expect(buildTransfusionTimeline('14:00', '14:10').slots.map(s => s.time)).toEqual(['13:50', '14:00', '14:10']);
  });
  it('truyền qua nửa đêm', () => {
    const { slots } = buildTransfusionTimeline('23:30', '01:00');
    expect(slots.map(s => s.time)).toEqual(['23:20', '23:30', '23:45', '00:30', '01:00']);
    expect(slots.at(-1).dayOffset).toBe(1);
  });
  it('chưa có giờ kết thúc: chỉ các mốc trong 4 giờ, không có mốc kết thúc', () => {
    const { slots, endMissing } = buildTransfusionTimeline('14:00', '');
    expect(endMissing).toBe(true);
    expect(slots.map(s => s.time)).toEqual(['13:50', '14:00', '14:15', '15:00', '16:00', '17:00']);
  });
  it('giờ bắt đầu sai thì không tạo mốc', () => {
    expect(buildTransfusionTimeline('', '16:00').slots).toEqual([]);
    expect(buildTransfusionTimeline('25:00', '').slots).toEqual([]);
  });
});

describe('buildCareText', () => {
  it('đúng định dạng khoa đang ghi', () => {
    const { slots } = buildTransfusionTimeline('14:00', '16:33');
    expect(buildCareText(slots)).toBe([
      '13:50', 'Diễn biến:', 'Người bệnh tỉnh', 'Tiếp xúc tốt', 'Da niêm nhợt',
      'Chăm sóc:', 'Thử phản ứng thuận hợp tại giường', 'Lấy dấu hiệu sinh tồn', 'Trình Bs',
      '14:00', 'Người bệnh tỉnh -> Bắt đầu truyền máu',
      '14:15', 'Người bệnh tỉnh -> Chưa xảy ra phản ứng lạ, Lấy dấu hiệu sinh tồn',
      '15:00', 'Người bệnh tỉnh -> Chưa xảy ra phản ứng lạ, Lấy dấu hiệu sinh tồn',
      '16:00', 'Người bệnh tỉnh -> Chưa xảy ra phản ứng lạ, Lấy dấu hiệu sinh tồn',
      '16:33', 'Người bệnh tỉnh -> Kết thúc truyền máu, Lấy dấu hiệu sinh tồn',
    ].join('\n'));
  });
  it('dùng chữ người làm đã sửa', () => {
    const { slots } = buildTransfusionTimeline('14:00', '14:30');
    expect(buildCareText(slots, { m15: { note: 'Người bệnh lạnh run -> Ngừng truyền, báo Bs' } })).toContain('14:15\nNgười bệnh lạnh run -> Ngừng truyền, báo Bs');
  });
});

describe('phiếu in và màn hình dùng chung mốc giờ', () => {
  it('phiếu in có đủ các mốc và chỉ số đã nhập', () => {
    const group = { room: 'P10', patientName: 'NGƯỜI BỆNH A', products: [{ drugName: 'Khối hồng cầu 350ml' }], tests: [] };
    const html = buildTransfusionPrintHtml(group, { start: '14:00', end: '16:33', cells: { start: { pulse: '88', bp: '120/70' } } }, '10/11/2026');
    for (const t of buildTransfusionTimeline('14:00', '16:33').slots.map(s => s.time)) expect(html).toContain(`>${t}<`);
    expect(html).toContain('PHẦN II. THEO DÕI TRUYỀN MÁU LÂM SÀNG');
    expect(html).toContain('<td>88</td>');
    expect(html).toContain('120/70');
    expect(html).toContain('<b>16:33</b> giờ, ngày <b>10</b> tháng <b>11</b> năm <b>2026</b>');
  });
  it('escape tên người bệnh', () => {
    const html = buildTransfusionPrintHtml({ room: 'P1', patientName: '<script>', products: [], tests: [] }, {}, '10/11/2026');
    expect(html).not.toContain('<script>');
  });
});

describe('groupTransfusions', () => {
  it('gom chế phẩm và xét nghiệm theo người bệnh', () => {
    const rows = [
      { patientId: 'x', patientName: 'A', room: 'P10', drugName: 'Khối hồng cầu từ 350ml máu toàn phần' },
      { patientId: 'x', patientName: 'A', room: 'P10', drugName: 'Định nhóm máu hệ ABO' },
      { patientId: 'y', patientName: 'B', room: 'P04', drugName: 'Định nhóm máu hệ Rh' },
      { patientId: 'z', patientName: 'C', room: 'P04', drugName: 'Paracetamol' },
    ];
    const groups = groupTransfusions(rows, '10/11/2026');
    expect(groups.map(g => [g.room, g.products.length, g.tests.length])).toEqual([['P04', 0, 1], ['P10', 1, 1]]);
  });
});

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
describe('DutyReport: truyền máu không bàn giao', () => {
  let host; let root;
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 10, 10, 9, 0, 0)); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
  afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear(); vi.useRealTimers(); });

  const DATE = '10/11/2026';
  const rows = [
    { id: 'a', date: DATE, time: '20:00', patientId: 'p1', patientName: 'A', room: 'P10', drugName: 'PARACETAMOL', route: 'TTM', quantity: 1, unit: 'túi' },
    { id: 'b', date: DATE, time: '—', noTime: true, patientId: 'p1', patientName: 'A', room: 'P10', drugName: 'Khối hồng cầu từ 350ml máu toàn phần', route: 'Khác', quantity: 1, unit: '' },
    { id: 'c', date: DATE, time: '—', noTime: true, patientId: 'p1', patientName: 'A', room: 'P10', drugName: 'Định nhóm máu hệ ABO', route: 'Khác', quantity: 1, unit: 'ống' },
    { id: 'd', date: DATE, time: '20:00', patientId: 'p1', patientName: 'A', room: 'P10', drugName: 'Phản ứng hòa hợp trong môi trường nước muối ở 22°C', route: 'Khác', quantity: 1, unit: 'ống' },
  ];
  const sectionText = title => [...host.querySelectorAll('section')].find(s => s.querySelector('h3')?.textContent === title)?.textContent || '';

  for (const role of ['work', 'duty']) {
    it(`vai trò ${role}`, () => {
      localStorage.setItem('emr_report_role_v1', JSON.stringify(role));
      act(() => root.render(createElement(DutyReport, { date: DATE, rows, nurseState: {} })));
      const headings = [...host.querySelectorAll('h3')].map(h => h.textContent);
      expect(headings).toContain('Truyền máu');
      expect(headings).not.toContain('Chưa rõ giờ');
      expect(sectionText('Truyền máu')).toContain('Khối hồng cầu');
      for (const h of headings.filter(h => h !== 'Truyền máu')) {
        expect(sectionText(h)).not.toMatch(/Khối hồng cầu|Định nhóm máu|Phản ứng hòa hợp/);
      }
    });
  }

  it('nhập giờ bắt đầu và kết thúc thì hiện bảng mốc, và tự lưu', () => {
    localStorage.setItem('emr_report_role_v1', JSON.stringify('work'));
    act(() => root.render(createElement(DutyReport, { date: DATE, rows, nurseState: {} })));
    const setValue = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    act(() => setValue(host.querySelector('input[aria-label="Giờ bắt đầu truyền máu"]'), '14:00'));
    act(() => setValue(host.querySelector('input[aria-label="Giờ ngừng truyền máu"]'), '16:33'));
    const times = [...host.querySelectorAll('tbody tr td:first-child')].map(td => td.textContent);
    expect(times).toEqual(['13:50', '14:00', '14:15', '15:00', '16:00', '16:33']);
    const saved = JSON.parse(localStorage.getItem('emr_report_blood_transfusion_v1'));
    expect(saved[`${DATE}|p1`]).toMatchObject({ start: '14:00', end: '16:33' });
  });
});
