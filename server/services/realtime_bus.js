'use strict';

// Event bus chỉ sống trong tiến trình Node. Trạng thái bền vững vẫn nằm trong
// task_journal; bus này chỉ giúp các trình duyệt đang mở nhận thay đổi ngay.
const { EventEmitter } = require('events');

const emitter = new EventEmitter();
emitter.setMaxListeners(200);

function safeTaskEvent(event = {}) {
  return {
    event: String(event.event || 'task_changed'),
    at: String(event.at || new Date().toISOString()),
    task_id: String(event.task_id || ''),
    sid: String(event.sid || 'default'),
    task_type: String(event.task_type || ''),
    status: String(event.status || '').replace(/^task_/, ''),
    queue_type: String(event.queue_type || ''),
    error_code: String(event.error_code || ''),
  };
}

function publishTaskEvent(event) {
  const payload = safeTaskEvent(event);
  emitter.emit('task', payload);
  return payload;
}

function subscribeTaskEvents(listener) {
  emitter.on('task', listener);
  return () => emitter.off('task', listener);
}

module.exports = { publishTaskEvent, subscribeTaskEvents, safeTaskEvent };
