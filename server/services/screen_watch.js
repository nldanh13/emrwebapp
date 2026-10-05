'use strict';

// Bộ theo dõi màn hình dùng chung cho mọi tab (docs/UX_RULES.md mục 9).
//
// Route trả số liệu cho một màn hình gọi watchScreen({ sid, key, files, extra }) để đăng ký: từ đó
// máy chủ tự so "phiên bản" các file/thư mục nguồn của màn hình đó (giờ sửa + kích thước — rất rẻ)
// mỗi ~1,5 giây, chỉ khi có trình duyệt đang nối /api/events. Đổi thì phát sự kiện 'screen'
// cho đúng workspace; giao diện tải lại đúng gói đó (useServerData, khóa `screen:<key>`), không
// phải hẹn giờ hỏi lại.
//
// Thư mục: ghi file kiểu atomic (ghi tạm rồi đổi tên) làm đổi giờ sửa của thư mục, nên theo dõi
// thư mục là bắt được file mới/sửa ngay trong thư mục đó.
//
// Sự kiện không chứa dữ liệu người bệnh: chỉ workspace, khóa màn hình, phiên bản.

const crypto = require('crypto');
const fs = require('fs');
const { EventEmitter } = require('events');

const emitter = new EventEmitter();
emitter.setMaxListeners(200);

const WATCH_TTL_MS = 30 * 60 * 1000;
const TICK_MS = 1500;
const MAX_WATCHES = 500;

const watched = new Map(); // `${sid}|${key}` → { sid, key, files, extra, version, seenAt }
let timer = null;

function fileSignature(files = [], extra = null) {
  const h = crypto.createHash('sha1');
  for (const file of files) {
    try {
      const st = fs.statSync(file);
      h.update(`${file}:${st.mtimeMs}:${st.size};`);
    } catch (_) {
      h.update(`${file}:-;`);
    }
  }
  if (typeof extra === 'function') {
    try { h.update(String(extra() ?? '')); } catch (_) { h.update('extra:-'); }
  }
  return h.digest('hex').slice(0, 16);
}

function publishScreenEvent({ sid, key, version }) {
  const payload = {
    event: 'screen_changed',
    at: new Date().toISOString(),
    sid: String(sid || 'default'),
    key: String(key || '').slice(0, 120),
    version: String(version || '').slice(0, 64),
  };
  emitter.emit('screen', payload);
  return payload;
}

function subscribeScreenEvents(listener) {
  emitter.on('screen', listener);
  ensureTimer();
  return () => {
    emitter.off('screen', listener);
    if (!emitter.listenerCount('screen')) stopTimer();
  };
}

// files: đường dẫn tuyệt đối (file hoặc thư mục); extra: hàm trả chuỗi cho trạng thái trong bộ nhớ
// (vd. tiến trình còn chạy không). Gọi lại mỗi lần route được gọi để gia hạn theo dõi.
function watchScreen({ sid = 'default', key, files = [], extra = null } = {}) {
  if (!key) return;
  const id = `${sid}|${key}`;
  const list = [...new Set(files.filter(Boolean).map(String))];
  const cur = watched.get(id);
  if (cur && cur.files.join('\n') === list.join('\n')) {
    // Trình duyệt vừa nhận bản mới nhất: lấy mốc phiên bản lúc này (lần dựng có thể vừa tự sửa file).
    cur.seenAt = Date.now();
    cur.extra = extra;
    cur.version = fileSignature(list, extra);
    return;
  }
  if (!cur && watched.size >= MAX_WATCHES) {
    const oldest = [...watched.entries()].sort((a, b) => a[1].seenAt - b[1].seenAt)[0];
    if (oldest) watched.delete(oldest[0]);
  }
  watched.set(id, { sid: String(sid || 'default'), key: String(key), files: list, extra, version: fileSignature(list, extra), seenAt: Date.now() });
}

function tick(now = Date.now()) {
  const events = [];
  for (const [id, w] of watched) {
    if (now - w.seenAt > WATCH_TTL_MS) { watched.delete(id); continue; }
    const version = fileSignature(w.files, w.extra);
    if (version !== w.version) {
      w.version = version;
      events.push(publishScreenEvent(w));
    }
  }
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
function __resetScreenWatch() {
  stopTimer();
  watched.clear();
  emitter.removeAllListeners('screen');
}

module.exports = { watchScreen, subscribeScreenEvents, publishScreenEvent, fileSignature, tick, __resetScreenWatch };
