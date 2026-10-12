import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';

// Dữ liệu giả.
const RECORDS = [
  { id: 1, doc_type: 'GRV03', source_file: 'EMR-phieu', patient_name: 'TRẦN THỊ MẪU', status: 'error', ready: false,
    issues: ['Thẻ DN: hỏi người bệnh có nghỉ ốm không'], fields: { hoi_nghi_om: 'can_hoi', ma_the: 'DN4929201234567' } },
  { id: 2, doc_type: 'BHXH07', source_file: 'EMR-phieu', patient_name: 'NGUYỄN VĂN AN', status: 'success', ready: true,
    issues: [], fields: { tu_ngay: '10/10/2026', den_ngay: '12/10/2026' } },
];
let TOOL_UP = true;
let TOOL_ERROR = '';
const calls = [];
// Công cụ giả, gọi qua máy chủ (/api/bhyt-tool/...): trình duyệt không gọi thẳng cổng 5005.
async function fakeTool(method, path, body) {
  calls.push([method, path, body ?? null]);
  if (TOOL_ERROR) throw new Error(TOOL_ERROR);
  if (!TOOL_UP) throw new Error('Công cụ nhập cổng BHXH chưa chạy. Bấm "Lấy mã CAPTCHA" để khởi động.');
  return {
    '/api/summary': { summary: {}, worker: { running: false }, auto: null },
    '/api/records': { records: RECORDS },
    '/api/browser/status': { logged_in: false },
    '/api/emr/status': { logged_in: false },
    '/api/emr/grv-defaults': { ma_khoa: 'K24', doctor_text: 'Nguyễn Lê Hoan', doctors: ['Nguyễn Lê Hoan'] },
    '/api/browser/captcha': { image: 'data:image/png;base64,AAAA' },
    '/api/auto-run': { running: true, phase: 'clinic', results: {} },
  }[path.split('?')[0]] || {};
}
vi.mock('../api.js', () => ({
  getBhytTool: vi.fn((path) => fakeTool('GET', path)),
  postBhytTool: vi.fn((path, body) => fakeTool('POST', path, body || {})),
  getBhytPortalAccount: vi.fn(async () => ({ status: 'ok', account: { ready: true, username: 'bv', facility_code: '92001', has_password: true } })),
  getClinicDoctorAccounts: vi.fn(async () => ({ status: 'ok', doctors: [] })),
  saveBhytPortalAccount: vi.fn(),
  loginBhytPortal: vi.fn(async () => ({ status: 'ok', portal: { logged_in: true }, emr: { logged_in: true } })),
  launchBhytTool: vi.fn(async () => ({ status: 'ok' })),
}));
const api = await import('../api.js');
const { default: SickLeaveAutoPanel } = await import('./SickLeaveAutoPanel.jsx');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host; let root;
beforeEach(() => {
  calls.length = 0;
  TOOL_UP = true;
  TOOL_ERROR = '';
  globalThis.fetch = vi.fn(async () => { throw new Error('không được gọi thẳng công cụ'); });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const flush = async () => { for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve(); }); };
const button = (text) => [...host.querySelectorAll('button')].find(b => b.textContent.includes(text));

describe('Nghỉ ốm tự động', () => {
  it('hai danh sách ra viện và phòng khám, ca thẻ DN chờ hỏi lên trước', async () => {
    await act(async () => { root.render(createElement(SickLeaveAutoPanel, { toast: () => {} })); });
    await flush();
    const text = host.textContent;
    expect(text).toContain('Ra viện (giấy ra viện)');
    expect(text).toContain('Phòng khám (phiếu nghỉ)');
    expect(text).toContain('Cần hỏi người bệnh');
    expect(text).toContain('Đã nhập lên cổng');
    expect(button('Có nghỉ')).toBeTruthy();
    expect(text).not.toContain('Công cụ cũ');
  });

  it('chỉ gõ CAPTCHA: đăng nhập xong tự bắt đầu lượt nhập', async () => {
    await act(async () => { root.render(createElement(SickLeaveAutoPanel, { toast: () => {} })); });
    await flush();
    await act(async () => { button('Lấy mã CAPTCHA').click(); });
    await flush();
    const input = host.querySelector('input[placeholder="Gõ mã nhìn thấy bên trái"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'ab12');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { button('Đăng nhập và nhập tự động').click(); });
    await flush();
    expect(api.loginBhytPortal).toHaveBeenCalledWith('ab12');
    const run = calls.find(([m, p]) => m === 'POST' && p === '/api/auto-run');
    expect(run[2]).toMatchObject({ ma_khoa: 'K24', doctor_text: 'Nguyễn Lê Hoan' });
  });

  it('công cụ chưa chạy: hướng dẫn bấm Lấy mã CAPTCHA, không lỗi trần', async () => {
    TOOL_UP = false;
    await act(async () => { root.render(createElement(SickLeaveAutoPanel, { toast: () => {} })); });
    await flush();
    expect(host.textContent).toContain('Công cụ nhập cổng chưa chạy');
  });

  it('công cụ lỗi sau khi khởi động: báo đúng lý do, không báo chung "chưa sẵn sàng"', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      TOOL_ERROR = 'Công cụ nhập cổng BHXH bị lỗi khi xử lý (mã 500). Xem cửa sổ "BHYT Selenium".';
      const toasts = [];
      await act(async () => { root.render(createElement(SickLeaveAutoPanel, { toast: (m) => toasts.push(m) })); });
      await flush();
      await act(async () => { button('Lấy mã CAPTCHA').click(); });
      for (let i = 0; i < 12; i += 1) {
        await act(async () => { vi.advanceTimersByTime(600); });
        await flush();
      }
      expect(api.launchBhytTool).toHaveBeenCalled();
      expect(toasts.at(-1)).toContain('bị lỗi khi xử lý (mã 500)');
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
