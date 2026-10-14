// Tab Mẫu thủ thuật – PT: sửa mẫu tự lưu sau giây lát; rời tab khi còn thay đổi thì lưu ngay;
// từ khoá trùng giữa hai mẫu thì báo.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';

const TEMPLATES = [
  { id: 'tb', kind: 'thu_thuat', name: 'Thay băng', keywords: ['thay băng'], performer: 'dieu_duong', minutes: 10,
    anesthesia: 'Không', position: '', emr_template: 'CTCH-thay băng', phuong_phap: '', mo_ta: '', report: '', dan_do: '',
    applies_to: 'all', auto: true, enabled: true, note: '' },
  { id: 'pt', kind: 'phau_thuat', name: 'PT mặc định', keywords: [], performer: 'bac_si', minutes: 15,
    anesthesia: 'Gây Tê Tại Chỗ', position: 'Nằm ngửa', emr_template: '', phuong_phap: '', mo_ta: '', report: '', dan_do: '',
    applies_to: 'all', auto: true, enabled: true, note: '' },
];

vi.mock('../api.js', () => ({
  getProcedureTemplates: vi.fn(async () => ({ status: 'ok', templates: TEMPLATES })),
  saveProcedureTemplates: vi.fn(async (templates) => ({ status: 'ok', templates })),
  getClinicMonitorState: vi.fn(async () => ({ status: 'ok', monitor: { missing_templates: [
    { kind: 'thu_thuat', name: 'Khâu vết thương phần mềm', count: 2, ho_ten: 'NGUOI A', at: '2026-10-11T08:00:00' },
    { kind: 'thu_thuat', name: 'Thay băng vết mổ', count: 1, ho_ten: 'NGUOI B', at: '2026-10-11T07:00:00' },
  ] } })),
}));
const api = await import('../api.js');
const { default: ProcedureTemplatesTab } = await import('./ProcedureTemplatesTab.jsx');
const { keywordConflicts, foldText } = await import('./procedureTemplates/templateModel.js');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host; let root;
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  api.saveProcedureTemplates.mockClear();
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });
const flush = async () => { for (let i = 0; i < 5; i += 1) await act(async () => { await Promise.resolve(); }); };

function typeInto(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function open() {
  await act(async () => { root.render(createElement(ProcedureTemplatesTab, { toast: () => {} })); });
  await flush();
}

describe('Mẫu thủ thuật – PT', () => {
  it('sửa nội dung tường trình → tự lưu cả danh sách, không cần bấm Lưu', async () => {
    await open();
    expect(host.textContent).toContain('Thay băng');
    const report = [...host.querySelectorAll('label')].find(l => l.textContent.startsWith('Nội dung tường trình')).querySelector('textarea');
    await act(async () => { typeInto(report, 'Sát khuẩn\nThay băng vô khuẩn'); });
    expect(host.textContent).toContain('đang chờ tự lưu');
    await act(async () => { vi.advanceTimersByTime(900); });
    await flush();
    expect(api.saveProcedureTemplates).toHaveBeenCalledTimes(1);
    const saved = api.saveProcedureTemplates.mock.calls[0][0];
    expect(saved).toHaveLength(2);
    expect(saved.find(t => t.id === 'tb').report).toBe('Sát khuẩn\nThay băng vô khuẩn');
    expect(host.textContent).toContain('Đã tự lưu lúc');
  });

  it('thêm mẫu rồi chuyển tab ngay → lưu luôn', async () => {
    await open();
    const add = [...host.querySelectorAll('button')].find(b => b.textContent.includes('Thêm mẫu'));
    await act(async () => { add.click(); });
    await act(async () => { window.dispatchEvent(new CustomEvent('emr:tab-active', { detail: 'clinic' })); });
    await flush();
    expect(api.saveProcedureTemplates).toHaveBeenCalledTimes(1);
    expect(api.saveProcedureTemplates.mock.calls[0][0]).toHaveLength(3);
  });

  it('DVKT Phòng khám bỏ qua vì chưa có mẫu: liệt kê, bấm Tạo mẫu thì thêm mẫu theo tên DVKT và tự lưu', async () => {
    await open();
    expect(host.textContent).toContain('Khâu vết thương phần mềm');
    expect(host.textContent).not.toContain('Thay băng vết mổ');
    const create = [...host.querySelectorAll('button')].find(b => b.textContent.includes('Tạo mẫu'));
    await act(async () => { create.click(); });
    await act(async () => { vi.advanceTimersByTime(900); });
    await flush();
    const saved = api.saveProcedureTemplates.mock.calls.at(-1)[0];
    expect(saved).toHaveLength(3);
    expect(saved[2]).toMatchObject({ kind: 'thu_thuat', name: 'Khâu vết thương phần mềm', keywords: ['Khâu vết thương phần mềm'] });
  });

  it('gợi ý 40 kỹ thuật, thêm từng mẫu dưới dạng bản nháp không tự nhập', async () => {
    await open();
    expect(host.textContent).toContain('40 kỹ thuật');
    expect(host.textContent).toContain('Hút dịch khớp gối');
    const firstAdd = [...host.querySelectorAll('button')].find(b => b.textContent === 'Thêm bản nháp');
    await act(async () => { firstAdd.click(); });
    await act(async () => { vi.advanceTimersByTime(900); });
    await flush();
    const saved = api.saveProcedureTemplates.mock.calls.at(-1)[0];
    const draft = saved.find(t => t.catalog_code);
    expect(draft).toMatchObject({ name: 'Cắt chỉ', catalog_code: '10.1275',
      reviewed: false, enabled: false, auto: false });
    expect(host.textContent).toContain('Mẫu đang tắt và chưa được duyệt');
    const autoToggle = host.querySelector('input[aria-label="Tự nhập"]');
    expect(autoToggle.disabled).toBe(true);
  });

  it('duyệt mẫu phải có tường trình và mẫu EMR, sửa lại sau duyệt thì tự tắt', async () => {
    await open();
    await act(async () => {
      [...host.querySelectorAll('button')].find(b => b.textContent === 'Thêm bản nháp').click();
    });
    const review = [...host.querySelectorAll('button')].find(b => b.textContent.includes('Xác nhận đã duyệt mẫu'));
    expect(review.disabled).toBe(true);
    const report = [...host.querySelectorAll('label')].find(l => l.textContent.startsWith('Nội dung tường trình')).querySelector('textarea');
    const emr = [...host.querySelectorAll('label')].find(l => l.textContent.startsWith('Mẫu tường trình EMR')).querySelector('input');
    await act(async () => {
      typeInto(report, 'Nội dung đã được phê duyệt');
      typeInto(emr, 'Mẫu CTCH trên EMR');
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      const button = [...host.querySelectorAll('button')].find(b => b.textContent.includes('Xác nhận đã duyệt mẫu'));
      expect(button.disabled).toBe(false);
      await act(async () => { button.click(); });
      await act(async () => { vi.advanceTimersByTime(900); });
      await flush();
      const approved = api.saveProcedureTemplates.mock.calls.at(-1)[0].find(t => t.catalog_code);
      expect(approved).toMatchObject({ reviewed: true, enabled: false, auto: false });
      await act(async () => {
        typeInto(report, 'Đã sửa nội dung sau khi duyệt');
      });
      await act(async () => { vi.advanceTimersByTime(900); });
      await flush();
      const revised = api.saveProcedureTemplates.mock.calls.at(-1)[0].find(t => t.catalog_code);
      expect(revised).toMatchObject({ reviewed: false, enabled: false, auto: false });
      expect(confirm).toHaveBeenCalled();
    } finally {
      confirm.mockRestore();
    }
  });

  it('báo từ khoá trùng giữa hai mẫu cùng loại (không phân biệt dấu)', () => {
    const other = { ...TEMPLATES[0], id: 'x', name: 'Thay băng lớn', keywords: ['THAY BANG'] };
    expect(keywordConflicts([TEMPLATES[0], other], TEMPLATES[0])).toEqual([{ keyword: 'thay băng', other: 'Thay băng lớn' }]);
    expect(keywordConflicts([TEMPLATES[0], { ...other, enabled: false }], TEMPLATES[0])).toEqual([]);
    expect(foldText('  Đặt  Nẹp ')).toBe('dat nep');
  });
});
