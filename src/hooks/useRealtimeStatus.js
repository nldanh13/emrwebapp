// Kênh sự kiện máy chủ (/api/events, WorkspaceRealtimeBridge) đang nối hay không.
// Đang nối: màn hình chờ sự kiện, không tự hỏi theo giờ; mất nối: quay về hỏi thưa (dự phòng).
import { useEffect, useRef, useState } from 'react';

let connected = false;
if (typeof window !== 'undefined') {
  window.addEventListener('emr:realtime-status', (e) => { connected = Boolean(e?.detail?.connected); });
}

export function isRealtimeConnected() {
  return connected;
}

export function useRealtimeConnected() {
  const [value, setValue] = useState(connected);
  useEffect(() => {
    const onStatus = (e) => setValue(Boolean(e?.detail?.connected));
    window.addEventListener('emr:realtime-status', onStatus);
    setValue(connected);
    return () => window.removeEventListener('emr:realtime-status', onStatus);
  }, []);
  return value;
}

// Nghe sự kiện "số liệu nghiên cứu đã đổi" từ máy chủ.
export function useResearchEvents(handler) {
  useEffect(() => {
    const onEvent = (e) => handler(e?.detail || {});
    window.addEventListener('emr:research-changed', onEvent);
    return () => window.removeEventListener('emr:research-changed', onEvent);
  }, [handler]);
}

// Nghe sự kiện "số liệu màn hình đã đổi" (khóa màn hình, vd. 'hchanh-dashboard') cho màn hình chưa
// chuyển hẳn sang kho dùng chung: tự tải lại im lặng khi máy chủ báo.
export function useScreenChanged(key, handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const onEvent = (e) => { if (String(e?.detail?.key || '') === key) ref.current(e.detail); };
    window.addEventListener('emr:screen-changed', onEvent);
    return () => window.removeEventListener('emr:screen-changed', onEvent);
  }, [key]);
}
