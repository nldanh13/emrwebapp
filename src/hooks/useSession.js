import { useMemo } from 'react';

const SESSION_KEY = 'emr_session_id_v1';
const TAB_ID_KEY  = 'emr_tab_id_v1';
const LOCK_KEY    = 'emr_session_lock_v1'; // { tabId, ts } — tab nào đang giữ session
const WORKSPACE_QUERY_KEY = 'workspace';

// Heartbeat chỉ dùng để ghi nhận tab đang mở, KHÔNG dùng để tự tạo session mới.
// Trước đây nếu mở lại Chrome trong vài giây sau khi tắt đột ngột, lock cũ còn "tươi"
// nên app tạo session mới và nhìn vào thư mục dữ liệu rỗng. Dữ liệu cũ không mất nhưng
// người dùng thấy như bị mất. Vì vậy luôn ưu tiên session đã lưu trong localStorage.
const HEARTBEAT_MS = 4_000;

function createSessionId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isValidSid(s) {
  return typeof s === 'string' && /^[a-zA-Z0-9_-]{6,60}$/.test(s);
}

/**
 * Cho phép cùng một "workspace" được mở trên điện thoại/máy tính bằng URL:
 *   https://host/?workspace=<session-id>
 *
 * Session/workspace ID không phải mật khẩu; API vẫn bắt x-app-token riêng. Link chỉ
 * giúp hai thiết bị nhìn cùng dữ liệu runtime và dùng cùng hàng đợi tác vụ.
 */
function workspaceFromUrl() {
  try {
    const params = new URLSearchParams(window.location.search || '');
    const sid = params.get(WORKSPACE_QUERY_KEY) || params.get('sid') || '';
    return isValidSid(sid) ? sid : '';
  } catch {
    return '';
  }
}

export function setSessionId(sid) {
  if (!isValidSid(sid)) throw new Error('Session ID không hợp lệ');
  const tabId = getTabId();
  localStorage.setItem(SESSION_KEY, sid);
  sessionStorage.setItem(SESSION_KEY, sid);
  writeLock(tabId);
  return sid;
}

export function createAndSetSessionId() {
  return setSessionId(createSessionId());
}

/** Lấy ID session hiện tại nếu có. Không tự tạo mới. */
export function peekSessionId() {
  try {
    const fromUrl = workspaceFromUrl();
    if (fromUrl) return fromUrl;
    const fromTab = sessionStorage.getItem(SESSION_KEY);
    if (isValidSid(fromTab)) return fromTab;
    const fromStorage = localStorage.getItem(SESSION_KEY);
    return isValidSid(fromStorage) ? fromStorage : '';
  } catch {
    return '';
  }
}

/** Lấy/tạo ID duy nhất cho tab hiện tại (tồn tại trong sessionStorage). */
function getTabId() {
  let id = sessionStorage.getItem(TAB_ID_KEY);
  if (!id) {
    id = Math.random().toString(36).slice(2, 12);
    sessionStorage.setItem(TAB_ID_KEY, id);
  }
  return id;
}

function readLock() {
  try { return JSON.parse(localStorage.getItem(LOCK_KEY) || 'null'); } catch { return null; }
}

function writeLock(tabId) {
  try { localStorage.setItem(LOCK_KEY, JSON.stringify({ tabId, ts: Date.now() })); } catch { /* ignore */ }
}

/**
 * Chiến lược session/workspace:
 *
 * 1. URL có ?workspace=<sid> (hoặc ?sid= legacy) → tham gia đúng workspace đó,
 *    đồng thời lưu lại để các lần mở sau trên thiết bị này vẫn ở cùng workspace.
 * 2. Tab reload: sessionStorage còn session ID → dùng lại.
 * 3. Đóng/mở lại Chrome: sessionStorage mất nhưng localStorage còn session ID → dùng lại.
 * 4. Chưa từng có session → tạo session mới.
 *
 * Không tự tạo session mới chỉ vì lock còn tươi. Chrome có thể bị tắt đột ngột khi người dùng
 * đang nhập liệu, lock cũ vẫn còn vài giây và việc tạo session mới sẽ làm giao diện trống.
 */
export function getSessionId() {
  try {
    const tabId = getTabId();

    const fromUrl = workspaceFromUrl();
    if (fromUrl) {
      localStorage.setItem(SESSION_KEY, fromUrl);
      sessionStorage.setItem(SESSION_KEY, fromUrl);
      writeLock(tabId);
      return fromUrl;
    }

    const fromTab = sessionStorage.getItem(SESSION_KEY);
    if (isValidSid(fromTab)) {
      writeLock(tabId);
      return fromTab;
    }

    const fromStorage = localStorage.getItem(SESSION_KEY);
    const sid = isValidSid(fromStorage) ? fromStorage : createSessionId();
    if (!isValidSid(fromStorage)) localStorage.setItem(SESSION_KEY, sid);
    sessionStorage.setItem(SESSION_KEY, sid);
    writeLock(tabId);
    return sid;
  } catch {
    return `fallback-${Date.now().toString(36)}`;
  }
}

/** URL dùng để mở CHÍNH workspace hiện tại trên thiết bị khác. */
export function getWorkspaceShareUrl() {
  const sid = getSessionId();
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('sid');
    url.searchParams.set(WORKSPACE_QUERY_KEY, sid);
    // Không mang hash/tab riêng sang thiết bị khác; workspace mới là phần cần chia sẻ.
    url.hash = '';
    return url.toString();
  } catch {
    return `?${WORKSPACE_QUERY_KEY}=${encodeURIComponent(sid)}`;
  }
}

export function getWorkspaceId() {
  return getSessionId();
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────
// Cập nhật lock timestamp định kỳ để log/debug biết tab nào vừa hoạt động.
(function startHeartbeat() {
  try {
    setInterval(() => {
      const tabId = sessionStorage.getItem(TAB_ID_KEY);
      if (!tabId) return;
      const lock = readLock();
      if (!lock || lock.tabId === tabId) writeLock(tabId);
    }, HEARTBEAT_MS);
  } catch { /* ignore trong test / SSR */ }
})();

export function useSessionId() {
  return useMemo(() => getSessionId(), []);
}
