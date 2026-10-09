// Lấy hàng loạt ở Hành chánh: trước đây sau MỖI người bệnh lại tải lại cả bảng (máy chủ dựng lại
// toàn bộ: đọc hồ sơ + chạy QA cho mọi người bệnh) → N người bệnh = N lần dựng cả bảng. Kiểm: một
// lượt lấy nhiều người bệnh chỉ tải lại bảng vài lần, và các lần tải trùng lúc được gộp lại.

import { describe, test, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import * as api from '../../features/hchanh/api.js';
import { useHchanh } from './useHchanh.js';

const card = (i) => ({ ma_bn: `BN${i}`, ho_ten: `BN ${i}`, scope: 'discharge', data_complete: false, fetch_error_active: false });
const PATIENTS = Array.from({ length: 6 }, (_, i) => card(i));

vi.mock('../../features/hchanh/api.js', () => {
  const stub = () => vi.fn(async () => ({}));
  return {
    syncHchanh: vi.fn(async () => ({ total: 6 })),
    getHchanh_Dashboard: vi.fn(async () => ({ total: 6, patients: PATIENTS, counts: {} })),
    getHchanh_VtytDraft: vi.fn(async () => ({ draft: null })),
    fetchHchanh: stub(),
  };
});

async function mountHook() {
  const ref = { current: null };
  function Probe() { ref.current = useHchanh({ toast: () => {}, workDateRange: {} }); return null; }
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(Probe)); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
  return { ref, unmount: () => act(() => root.unmount()) };
}

describe('useHchanh tải lại bảng', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('confirm', () => true); });

  test('lấy hàng loạt 6 người bệnh không tải lại bảng sau từng người', async () => {
    const { ref, unmount } = await mountHook();
    api.getHchanh_Dashboard.mockClear();
    await act(async () => { await ref.current.batchFetchMissing(); });
    expect(api.fetchHchanh).toHaveBeenCalledTimes(6);
    expect(api.getHchanh_Dashboard.mock.calls.length).toBeLessThanOrEqual(2);
    await unmount();
  });

  test('nhiều lần gọi tải cùng lúc gộp thành tối đa 2 yêu cầu', async () => {
    const { ref, unmount } = await mountHook();
    api.getHchanh_Dashboard.mockClear();
    await act(async () => {
      await Promise.all([ref.current.load({ silent: true }), ref.current.load({ silent: true }), ref.current.load({ silent: true })]);
    });
    expect(api.getHchanh_Dashboard.mock.calls.length).toBeLessThanOrEqual(2);
    expect(ref.current.patients).toHaveLength(6);
    await unmount();
  });
});
