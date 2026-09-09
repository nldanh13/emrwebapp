// Smoke test: HchahnTab phải render được (renderToString chạy toàn bộ thân
// hàm component + khởi tạo hook, kể cả các dependency array của useCallback)
// mà không ném lỗi kiểu "biến X is not defined" — lớp lỗi này không bị
// esbuild/build bắt vì tham chiếu biến chưa khai báo không phải lỗi cú pháp,
// chỉ lộ ra khi thực thi. useEffect không chạy trong renderToString nên test
// này không gọi API thật.

import { describe, test, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';
import HchahnTab from './HchahnTab.jsx';

describe('HchahnTab smoke', () => {
  test('render không ném ReferenceError', () => {
    expect(() => renderToString(React.createElement(HchahnTab, { toast: () => {}, workDateRange: {} }))).not.toThrow();
  });
});
