// Truyền máu không bàn giao: dòng chế phẩm máu và xét nghiệm đi kèm phải ra khỏi "Chưa rõ giờ",
// "Cữ trong ca" và "Bàn giao ca trực", và có các mốc chăm sóc tạo từ giờ bắt đầu/kết thúc.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  bloodKind, buildCareText, buildTransfusionPrintHtml, buildTransfusionTimeline, defaultVitals, endTimeOf, entryVitalsFor,
  formKey, groupTransfusions, readTransfusionForms, saveTransfusionStart, seedBaseOf, slotValues, writeTransfusionForms,
} from './bloodTransfusion.js';
import FIXTURE from '../../../tests/fixtures/blood_transfusion_times.json' with { type: 'json' };
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
  it('đúng các mốc của ví dụ: bắt đầu 14:00, truyền 2 giờ 33 phút', () => {
    const slots = buildTransfusionTimeline('14:00');
    expect(slots.map(s => s.time)).toEqual(['13:50', '14:00', '14:15', '15:00', '16:00', '16:33']);
    expect(slots.map(s => s.kind)).toEqual(['pre', 'start', 'check', 'check', 'check', 'end']);
    expect(endTimeOf('14:00')).toBe('16:33');
  });
  it('cùng mốc giờ với worker nhập chăm sóc (fixture chung)', () => {
    const addDays = (dmy, n) => {
      const [d, m, y] = dmy.split('/').map(Number);
      const dt = new Date(y, m - 1, d + n);
      return `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;
    };
    for (const c of FIXTURE.cases) {
      const got = buildTransfusionTimeline(c.start).map(s => `${s.time} ${addDays(c.date, s.dayOffset)}`);
      expect(got).toEqual(c.times);
    }
  });
  it('giờ bắt đầu sai thì không tạo mốc', () => {
    expect(buildTransfusionTimeline('')).toEqual([]);
    expect(buildTransfusionTimeline('25:00')).toEqual([]);
  });
});

describe('sinh hiệu', () => {
  afterEach(() => localStorage.clear());
  it('số mặc định cố định theo người bệnh/ngày/giờ/mốc, trong dải worker', () => {
    const a = defaultVitals('p1|10/11/2026|14:00|pre');
    expect(defaultVitals('p1|10/11/2026|14:00|pre')).toEqual(a);
    expect(a.resp).toBe('20');
    expect(a.temp).toBe('37');
    expect(Number(a.pulse)).toBeGreaterThanOrEqual(75);
    expect(Number(a.pulse)).toBeLessThanOrEqual(85);
    expect(['120/80', '110/70', '130/80']).toContain(a.bp);
  });
  it('mốc không lấy sinh hiệu thì để trống, ô đã sửa thì dùng số đã sửa', () => {
    const [pre, start] = buildTransfusionTimeline('14:00');
    expect(slotValues(start, {}, 'x')).toMatchObject({ resp: '', pulse: '', bp: '', temp: '' });
    expect(slotValues(pre, { pre: { pulse: '96' } }, 'x').pulse).toBe('96');
  });
  it('dữ liệu gửi nhập EMR đúng bằng số trên bảng', () => {
    const date = '10/11/2026';
    writeTransfusionForms({ [formKey(date, 'p1')]: { start: '14:00', cells: { m15: { bp: '100/60' } } } });
    const vit = entryVitalsFor(date, 'p1', '14:00');
    expect(Object.keys(vit)).toEqual(['pre', 'm15', 'h1', 'h2', 'end']);
    const forms = readTransfusionForms();
    const seed = seedBaseOf(date, 'p1', '14:00');
    for (const slot of buildTransfusionTimeline('14:00').filter(s => s.needsVitals)) {
      const v = slotValues(slot, forms[formKey(date, 'p1')].cells, seed);
      expect(vit[slot.key]).toEqual({ nhip_tho: v.resp, nhiet_do: v.temp, mach: v.pulse, huyet_ap: v.bp });
    }
    expect(vit.m15.huyet_ap).toBe('100/60');
  });
  it('giờ bắt đầu nhập ở Nhập chăm sóc được lưu cho bảng', () => {
    saveTransfusionStart('10/11/2026', 'p1', '09:30');
    expect(readTransfusionForms()[formKey('10/11/2026', 'p1')].start).toBe('09:30');
  });
});

describe('buildCareText', () => {
  it('đúng định dạng khoa đang ghi', () => {
    expect(buildCareText(buildTransfusionTimeline('14:00'))).toBe([
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
    expect(buildCareText(buildTransfusionTimeline('14:00'), { m15: { note: 'Người bệnh lạnh run -> Ngừng truyền, báo Bs' } }))
      .toContain('14:15\nNgười bệnh lạnh run -> Ngừng truyền, báo Bs');
  });
});

describe('phiếu in và màn hình dùng chung mốc giờ', () => {
  it('phiếu in có đủ các mốc và chỉ số', () => {
    const group = { room: 'P10', patientId: 'p1', patientName: 'NGƯỜI BỆNH A', products: [{ drugName: 'Khối hồng cầu 350ml' }], tests: [] };
    const html = buildTransfusionPrintHtml(group, { start: '14:00', cells: { start: { pulse: '88', bp: '120/70' } } }, '10/11/2026');
    for (const t of buildTransfusionTimeline('14:00').map(s => s.time)) expect(html).toContain(`>${t}<`);
    expect(html).toContain('PHẦN II. THEO DÕI TRUYỀN MÁU LÂM SÀNG');
    expect(html).toContain('<td>88</td>');
    expect(html).toContain('120/70');
    const pre = defaultVitals(`${seedBaseOf('10/11/2026', 'p1', '14:00')}|pre`);
    expect(html).toContain(`<td>${pre.pulse}</td>`);
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

  it('nhập giờ bắt đầu thì giờ ngừng tự tính, hiện bảng mốc và sinh hiệu, và tự lưu', () => {
    localStorage.setItem('emr_report_role_v1', JSON.stringify('work'));
    act(() => root.render(createElement(DutyReport, { date: DATE, rows, nurseState: {} })));
    const setValue = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    act(() => setValue(host.querySelector('input[aria-label="Giờ bắt đầu truyền máu"]'), '14:00'));
    expect(host.querySelector('[aria-label="Giờ ngừng truyền máu"]').textContent).toBe('16:33');
    const times = [...host.querySelectorAll('tbody tr td:first-child')].map(td => td.textContent);
    expect(times).toEqual(['13:50', '14:00', '14:15', '15:00', '16:00', '16:33']);
    const saved = JSON.parse(localStorage.getItem('emr_report_blood_transfusion_v1'));
    expect(saved[`${DATE}|p1`]).toMatchObject({ start: '14:00' });
    const pulse = host.querySelector('input[aria-label="Mạch (l/ph) lúc 13:50"]').value;
    expect(pulse).toBe(entryVitalsFor(DATE, 'p1', '14:00').pre.mach);
  });
});
