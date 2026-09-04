// src/utils/activityLogger.js — Log thao tác giao diện để debug flow UI → API

import { getSessionId } from '../hooks/useSession.js';

const APP_TOKEN_KEY = 'emr_app_token_v1';
const MAX_LABEL_LEN = 160;
const MAX_QUEUE     = 20;

let activeTab = '';
let queue = [];
let flushTimer = null;
let flushing = false;

function getStoredAppToken() {
  try {
    const sessionToken = sessionStorage.getItem(APP_TOKEN_KEY) || '';
    if (sessionToken) return sessionToken;

    const legacyToken = localStorage.getItem(APP_TOKEN_KEY) || '';
    if (legacyToken) {
      sessionStorage.setItem(APP_TOKEN_KEY, legacyToken);
      localStorage.removeItem(APP_TOKEN_KEY);
      return legacyToken;
    }
  } catch {}
  return '';
}

function headers() {
  const token = getStoredAppToken();
  return {
    'Content-Type': 'application/json',
    'x-session-id': getSessionId(),
    ...(token ? { 'x-app-token': token } : {}),
  };
}

function truncate(value, max = MAX_LABEL_LEN) {
  const s = redactText(value).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function currentPath() {
  if (typeof window === 'undefined') return '';
  return `${window.location.pathname}${window.location.hash || ''}`;
}

function redactText(value) {
  return String(value ?? '')
    .replace(/([?&](token|ott|password|pass|secret)=)[^&\s]+/gi, '$1[hidden]')
    .replace(/\b(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[hidden]')
    .replace(/\b((?:password|pass|mat_khau|mật khẩu|token|secret|cookie|set-cookie)\s*[:=]\s*)[^,;\s]+/gi, '$1[hidden]');
}

function safeHref(href) {
  if (!href) return '';
  return redactText(href);
}

function describeElement(el) {
  if (!el) return {};
  const label = truncate(
    el.getAttribute('aria-label')
    || el.getAttribute('title')
    || el.innerText
    || el.textContent
    || el.value
    || el.name
    || el.id
    || el.tagName
  );
  return {
    tag: String(el.tagName || '').toLowerCase(),
    label,
    id: truncate(el.id || '', 80),
    name: truncate(el.getAttribute('name') || '', 80),
    title: truncate(el.getAttribute('title') || '', 120),
    type: truncate(el.getAttribute('type') || '', 40),
    role: truncate(el.getAttribute('role') || '', 40),
    disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
    href: safeHref(el.getAttribute('href') || ''),
  };
}

function emitActivityToScreen(item) {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent('emr:activity', { detail: item }));
  } catch (_) {}
}

function enqueue(event) {
  const item = {
    at: new Date().toISOString(),
    tab: activeTab,
    path: currentPath(),
    ...event,
  };
  queue.push(item);
  emitActivityToScreen(item);

  // Log luôn trong DevTools để nhìn tức thì khi đang chạy app.
  try { console.info('[EMR activity]', item); } catch {}

  if (queue.length >= MAX_QUEUE) return flushActivityLogs();
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushActivityLogs, 800);
}

export function setActivityTab(tab) {
  activeTab = String(tab || '');
}

export function logActivity(kind, details = {}) {
  enqueue({ kind, details });
}

export function logButtonClick(el, extra = {}) {
  enqueue({
    kind: 'ui.click',
    ...describeElement(el),
    details: extra,
  });
}

export function installGlobalClickLogger(getTab) {
  const handler = (event) => {
    const target = event.target?.closest?.('button,a,[role="button"],input[type="button"],input[type="submit"]');
    if (!target) return;
    if (typeof getTab === 'function') setActivityTab(getTab());
    logButtonClick(target);
  };
  document.addEventListener('click', handler, true);
  return () => document.removeEventListener('click', handler, true);
}

export async function flushActivityLogs() {
  if (flushing || queue.length === 0) return;
  const events = queue.splice(0, MAX_QUEUE);
  flushing = true;
  try {
    await fetch('/api/client-log', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ events }),
      keepalive: true,
    });
  } catch (err) {
    // Không làm hỏng flow chính chỉ vì log lỗi; giữ lại một phần để thử lần sau.
    queue = events.slice(-MAX_QUEUE).concat(queue).slice(-MAX_QUEUE);
    try { console.warn('[EMR activity] Không gửi được log:', err); } catch {}
  } finally {
    flushing = false;
  }
}
