// Trả HSBA: mở PDF vừa xuất. Trước đây giao diện mở thẳng /api/.../print-pdf/... bằng window.open —
// tab mới không mang mã đăng nhập (x-app-token) nên khi máy chủ bật đăng nhập, người dùng chỉ thấy
// lỗi 401 thay vì file PDF. Giờ tải PDF có kèm mã đăng nhập rồi mới mở.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as api from './api.js';

const PDF_URL = '/api/hchanh/records-check/print-pdf/nop_ho_so_20261012_x.pdf';

beforeEach(() => {
  sessionStorage.setItem('emr_app_token_v1', 'token-thu');
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:pdf-1');
  globalThis.URL.revokeObjectURL = vi.fn();
});
afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); });

describe('mở PDF Trả HSBA', () => {
  it('tải PDF có kèm mã đăng nhập rồi mở trong tab đã mở sẵn', async () => {
    const fetchMock = vi.fn(async () => new Response('%PDF-1.4', { status: 200, headers: { 'content-type': 'application/pdf' } }));
    vi.stubGlobal('fetch', fetchMock);
    const popup = { location: { replace: vi.fn() }, close: vi.fn(), document: { write: vi.fn(), close: vi.fn() } };

    await api.openRecordsCheckPdf(PDF_URL, popup);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(PDF_URL);
    expect(new Headers(init.headers).get('x-app-token')).toBe('token-thu');
    expect(popup.location.replace).toHaveBeenCalledWith('blob:pdf-1');
  });

  it('máy chủ báo lỗi → đóng tab chờ và báo lỗi tiếng Việt, không mở trang lỗi', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'error', message: 'Không tìm thấy PDF kiểm hồ sơ.' }), { status: 404, headers: { 'content-type': 'application/json' } })));
    const popup = { location: { replace: vi.fn() }, close: vi.fn(), document: { write: vi.fn(), close: vi.fn() } };

    await expect(api.openRecordsCheckPdf(PDF_URL, popup)).rejects.toThrow('Không tìm thấy PDF kiểm hồ sơ.');
    expect(popup.close).toHaveBeenCalled();
    expect(popup.location.replace).not.toHaveBeenCalled();
  });
});
