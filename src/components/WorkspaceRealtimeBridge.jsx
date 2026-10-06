import { useEffect, useRef } from 'react';
import { getWorkspaceId } from '../hooks/useSession.js';
import { invalidate } from '../hooks/useServerData.js';

const TOKEN_KEY = 'emr_app_token_v1';
const ACTIVE_TAB_KEY = 'emr_active_tab_v2';
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'unknown_after_restart']);

function getToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

function parseSseChunk(buffer, onMessage) {
  let rest = buffer;
  while (true) {
    const idx = rest.indexOf('\n\n');
    if (idx < 0) break;
    const block = rest.slice(0, idx).replace(/\r/g, '');
    rest = rest.slice(idx + 2);
    if (!block.trim()) continue;
    let eventName = 'message';
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) continue;
    try { onMessage(eventName, JSON.parse(dataLines.join('\n'))); } catch { /* bỏ event lỗi */ }
  }
  return rest;
}

function nudgeActiveScreen(detail) {
  let tab = '';
  try { tab = localStorage.getItem(ACTIVE_TAB_KEY) || ''; } catch {}
  window.dispatchEvent(new CustomEvent('emr:data-invalidated', { detail }));
  if (tab) window.dispatchEvent(new CustomEvent('emr:tab-active', { detail: tab }));
}

/**
 * Giữ mọi thiết bị trong cùng workspace bám theo trạng thái ở SERVER.
 * Không dùng EventSource vì EventSource không gửi được x-app-token header; dùng fetch
 * streaming để token không nằm trong URL/log.
 */
export default function WorkspaceRealtimeBridge({ children }) {
  const retryRef = useRef(1000);

  useEffect(() => {
    let stopped = false;
    let controller = null;
    let retryTimer = null;

    const connect = async () => {
      if (stopped) return;
      controller = new AbortController();
      const workspace = getWorkspaceId();
      const token = getToken();
      try {
        const res = await fetch('/api/events', {
          method: 'GET',
          headers: {
            Accept: 'text/event-stream',
            'x-session-id': workspace,
            ...(token ? { 'x-app-token': token } : {}),
          },
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`Realtime HTTP ${res.status}`);
        retryRef.current = 1000;
        window.dispatchEvent(new CustomEvent('emr:realtime-status', { detail: { connected: true, workspace } }));

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          buffer = parseSseChunk(buffer, (eventName, payload) => {
            if (eventName === 'workspace_snapshot') {
              window.dispatchEvent(new CustomEvent('emr:workspace-snapshot', { detail: payload }));
              return;
            }
            if (eventName === 'screen') {
              // Số liệu một màn hình của workspace này đổi (máy chủ tự theo dõi file nguồn):
              // tải lại đúng gói đó trong kho dùng chung, mọi khung đang hiện đổi cùng lúc.
              invalidate(`screen:${String(payload?.key || '')}`);
              window.dispatchEvent(new CustomEvent('emr:screen-changed', { detail: payload }));
              return;
            }
            if (eventName === 'bridge') {
              // Cầu nối tab EMR (máy bệnh viện) nối/mất nối/EMR đăng xuất.
              window.dispatchEvent(new CustomEvent('emr:bridge-status', { detail: payload }));
              return;
            }
            if (eventName === 'research') {
              // Số liệu Kho nghiên cứu đổi (máy chủ tự theo dõi file tiến độ) hoặc danh sách tác vụ
              // đang chạy đổi: màn hình nghiên cứu tải lại đúng gói đó, không cần hẹn giờ hỏi lại.
              window.dispatchEvent(new CustomEvent('emr:research-changed', { detail: payload }));
              return;
            }
            if (eventName === 'resource') {
              window.dispatchEvent(new CustomEvent('emr:server-resource', { detail: payload }));
              nudgeActiveScreen(payload);
              return;
            }
            if (eventName !== 'task') return;
            window.dispatchEvent(new CustomEvent('emr:server-task', { detail: payload }));
            if (TERMINAL.has(String(payload?.status || ''))) nudgeActiveScreen(payload);
          });
        }
      } catch (err) {
        if (!stopped && err?.name !== 'AbortError') {
          window.dispatchEvent(new CustomEvent('emr:realtime-status', {
            detail: { connected: false, workspace, message: String(err?.message || err) },
          }));
        }
      }
      if (!stopped) {
        const delay = retryRef.current;
        retryRef.current = Math.min(15000, Math.round(delay * 1.7));
        retryTimer = window.setTimeout(connect, delay);
      }
    };

    connect();
    return () => {
      stopped = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      controller?.abort();
    };
  }, []);

  return children;
}

export { parseSseChunk };
