'use strict';

// Kênh báo "số liệu nghiên cứu đã đổi" (docs/UX_RULES.md mục 9).
//
// Trước đây giao diện tự hỏi máy chủ mỗi 2,5–3 giây (tiến độ, danh sách tác vụ đang chạy) dù không
// có gì đổi. Giờ máy chủ tự theo dõi: mỗi ~1,5 giây so "phiên bản" của các phạm vi đang có người
// xem (giờ sửa + kích thước file nguồn, rất rẻ) và chữ ký danh sách khóa đang chạy; chỉ khi đổi mới
// phát sự kiện qua /api/events. Giao diện nhận sự kiện rồi tải lại đúng gói số liệu đó.
//
// Sự kiện không chứa dữ liệu người bệnh: chỉ phạm vi (archive / mã nghiên cứu), loại, phiên bản.

const { EventEmitter } = require('events');
const { screenVersion } = require('../research/screen_model');

const emitter = new EventEmitter();
emitter.setMaxListeners(200);

const WATCH_TTL_MS = 30 * 60 * 1000;   // phạm vi không ai xem 30 phút thì thôi theo dõi
const TICK_MS = 1500;

const watched = new Map(); // scope → { runDir, version, seenAt }
let lastRunningSig = null;
let timer = null;
let runningSignatureFn = () => '';

function publishResearchEvent(event = {}) {
  const payload = {
    event: 'research_changed',
    at: new Date().toISOString(),
    kind: String(event.kind || 'data'),
    scope: String(event.scope || '').slice(0, 120),
    version: String(event.version || '').slice(0, 64),
  };
  emitter.emit('research', payload);
  return payload;
}

function subscribeResearchEvents(listener) {
  emitter.on('research', listener);
  ensureTimer();
  return () => {
    emitter.off('research', listener);
    if (!emitter.listenerCount('research')) stopTimer();
  };
}

// Gọi khi có người mở gói số liệu của một phạm vi: từ giờ theo dõi phạm vi này.
function watchResearchScope(scope, runDir) {
  if (!scope || !runDir) return;
  const cur = watched.get(scope);
  if (cur && cur.runDir === runDir) { cur.seenAt = Date.now(); return; }
  watched.set(scope, { runDir, version: screenVersion(runDir), seenAt: Date.now() });
}

// Hàm cho chữ ký danh sách tác vụ đang chạy (đặt từ routes để tránh vòng require).
function setRunningSignature(fn) {
  if (typeof fn === 'function') runningSignatureFn = fn;
}

function tick(now = Date.now()) {
  const events = [];
  for (const [scope, w] of watched) {
    if (now - w.seenAt > WATCH_TTL_MS) { watched.delete(scope); continue; }
    const version = screenVersion(w.runDir);
    if (version !== w.version) {
      w.version = version;
      events.push(publishResearchEvent({ kind: 'data', scope, version }));
    }
  }
  let sig = '';
  try { sig = String(runningSignatureFn() || ''); } catch (_) { sig = ''; }
  if (lastRunningSig !== null && sig !== lastRunningSig) events.push(publishResearchEvent({ kind: 'running', scope: '', version: sig.slice(0, 64) }));
  lastRunningSig = sig;
  return events;
}

function ensureTimer() {
  if (timer) return;
  timer = setInterval(() => { try { tick(); } catch (_) { /* không để lỗi đọc file làm dừng kênh */ } }, TICK_MS);
  timer.unref?.();
}

function stopTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

// Chỉ dùng trong test.
function __resetResearchWatch() {
  stopTimer();
  watched.clear();
  lastRunningSig = null;
  emitter.removeAllListeners('research');
  runningSignatureFn = () => '';
}

module.exports = {
  publishResearchEvent,
  subscribeResearchEvents,
  watchResearchScope,
  setRunningSignature,
  tick,
  __resetResearchWatch,
};
