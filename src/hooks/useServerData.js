// Kho dữ liệu dùng chung phía trình duyệt — kiểu "stale-while-revalidate" của SWR/TanStack Query,
// viết gọn cho app này (docs/UX_RULES.md mục 9).
//
//   const { data, error, loading, refreshing, refresh } = useServerData(key, fetcher);
//
// - Mỗi màn hình tải MỘT gói số liệu đã tính sẵn ở máy chủ (screen model), theo một khóa.
// - Nhiều khung cùng khóa dùng chung một bản, một lần gọi (gộp các lời gọi đang bay).
// - Mở lại / quay lại tab: hiện ngay bản đang có, cập nhật ngầm; có bản mới thì mọi khung đổi CÙNG LÚC.
// - Lỗi khi tải lại: giữ bản cũ, báo lỗi (không xóa trắng màn hình).
// - invalidate(prefix): kênh sự kiện (useResearchEvents) gọi khi máy chủ báo số liệu đã đổi.
import { useEffect, useReducer, useRef } from 'react';
import { useOnTabReturn } from './useTabActivity.js';

const entries = new Map();   // key → { data, error, updatedAt, promise, version }
const listeners = new Map(); // key → Set(rerender)
const fetchers = new Map();  // key → fetcher mới nhất

function entry(key) {
  if (!entries.has(key)) entries.set(key, { data: undefined, error: null, updatedAt: 0, promise: null });
  return entries.get(key);
}

function notify(key) {
  for (const fn of listeners.get(key) || []) fn();
}

export function revalidate(key) {
  const fetcher = fetchers.get(key);
  const e = entry(key);
  if (!fetcher) return Promise.resolve(e.data);
  if (e.promise) return e.promise;
  e.promise = (async () => {
    try {
      const data = await fetcher();
      e.data = data;
      e.error = null;
      e.updatedAt = Date.now();
      return data;
    } catch (err) {
      e.error = err;
      return e.data;
    } finally {
      e.promise = null;
      notify(key);
    }
  })();
  notify(key);
  return e.promise;
}

// Báo các khóa bắt đầu bằng prefix là đã cũ: khóa nào đang có màn hình dùng thì tải lại ngay.
export function invalidate(prefix) {
  const jobs = [];
  for (const key of fetchers.keys()) {
    if (key.startsWith(prefix) && (listeners.get(key)?.size || 0) > 0) jobs.push(revalidate(key));
  }
  return Promise.all(jobs);
}

export function peekServerData(key) {
  return entries.get(key)?.data;
}

// Chỉ dùng trong test.
export function __resetServerData() {
  entries.clear();
  listeners.clear();
  fetchers.clear();
}

export function useServerData(key, fetcher, { enabled = true } = {}) {
  const [, rerender] = useReducer(x => x + 1, 0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!enabled || !key) return undefined;
    fetchers.set(key, () => fetcherRef.current());
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(rerender);
    const e = entry(key);
    // Chưa có bản nào, hoặc bản đang có đã hơn 2 giây: tải (cập nhật ngầm nếu đã có bản).
    if (e.data === undefined || Date.now() - e.updatedAt > 2000) revalidate(key);
    return () => { listeners.get(key)?.delete(rerender); };
  }, [key, enabled]);

  useOnTabReturn(() => { if (enabled && key) revalidate(key); });

  const e = (enabled && key) ? entry(key) : { data: undefined, error: null, promise: null, updatedAt: 0 };
  return {
    data: e.data,
    error: e.error,
    loading: e.data === undefined && !e.error,
    refreshing: Boolean(e.promise),
    updatedAt: e.updatedAt,
    refresh: () => (key ? revalidate(key) : Promise.resolve()),
  };
}
