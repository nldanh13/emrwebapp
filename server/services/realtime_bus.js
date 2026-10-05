'use strict';

// Event bus chỉ sống trong tiến trình Node. Trạng thái bền vững vẫn nằm trong
// task_journal/files; bus này chỉ giúp các trình duyệt đang mở nhận thay đổi ngay.
const { EventEmitter } = require('events');

const emitter = new EventEmitter();
emitter.setMaxListeners(200);

function safeTaskEvent(event = {}) {
  const eventName = String(event.event || 'task_changed');
  const derivedStatus = eventName.startsWith('task_') ? eventName.slice(5) : '';
  return {
    event: eventName,
    at: String(event.at || new Date().toISOString()),
    task_id: String(event.task_id || ''),
    sid: String(event.sid || 'default'),
    task_type: String(event.task_type || ''),
    status: String(event.status || derivedStatus || ''),
    queue_type: String(event.queue_type || ''),
    error_code: String(event.error_code || ''),
  };
}

function safeResourceEvent(event = {}) {
  return {
    event: 'resource_changed',
    at: String(event.at || new Date().toISOString()),
    sid: String(event.sid || 'default'),
    resource: String(event.resource || '').slice(0, 120),
    version: String(event.version || '').slice(0, 100),
    actor_id: String(event.actor_id || '').slice(0, 120),
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

function publishResourceEvent(event) {
  const payload = safeResourceEvent(event);
  if (!payload.resource) return payload;
  emitter.emit('resource', payload);
  return payload;
}

function subscribeResourceEvents(listener) {
  emitter.on('resource', listener);
  return () => emitter.off('resource', listener);
}

module.exports = {
  publishTaskEvent,
  subscribeTaskEvents,
  safeTaskEvent,
  publishResourceEvent,
  subscribeResourceEvents,
  safeResourceEvent,
};
