// Giao diện mới gọi đường dẫn mà máy chủ (bản cũ, chưa khởi động lại) không có: báo rõ cách sửa.
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as api from './api.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('lỗi 404 do máy chủ chưa khởi động lại', () => {
  it('404 trang HTML của Express → nhắc khởi động lại máy chủ', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!DOCTYPE html><pre>Cannot POST /api/x</pre>', { status: 404, statusText: 'Not Found', headers: { 'content-type': 'text/html' } })));
    await expect(api.fetchResearchStudyFromArchive('zol')).rejects.toThrow(/khởi động lại/);
  });

  it('404 có thông báo JSON của app → giữ nguyên thông báo đó', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'error', message: 'Không tìm thấy nghiên cứu.' }), { status: 404, headers: { 'content-type': 'application/json' } })));
    await expect(api.fetchResearchStudyFromArchive('zol')).rejects.toThrow('Không tìm thấy nghiên cứu.');
  });
});
