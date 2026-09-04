// server/services/task_queue.js — Hàng đợi tác vụ theo session (serial, có thể huỷ)

'use strict';

const taskJournal = require('./task_journal');

/** Map sid → Promise (chuỗi tác vụ đang chạy) */
const queues = new Map();

/** Map sid → { killFn, taskId } (để huỷ Python process đang chạy) */
const cancelMap = new Map();

/** Map sid → taskId đang thực thi (kể cả lúc chưa/không có Python process). */
const activeTaskMap = new Map();

/** Set taskId đã được người dùng yêu cầu huỷ. Giữ cờ tới khi task thật sự kết thúc. */
const cancelRequestedTasks = new Set();

const parsedMaxHeavyJobs = Number.parseInt(process.env.MAX_HEAVY_JOBS || '1', 10);
const MAX_HEAVY_JOBS = Number.isFinite(parsedMaxHeavyJobs) && parsedMaxHeavyJobs > 0
  ? parsedMaxHeavyJobs
  : 1;
let activeHeavyJobs = 0;
const heavyWaiters = [];

function _acquireHeavySlot() {
  return new Promise((resolve) => {
    if (activeHeavyJobs < MAX_HEAVY_JOBS) {
      activeHeavyJobs++;
      resolve();
    } else {
      heavyWaiters.push(resolve);
    }
  });
}

function _releaseHeavySlot() {
  if (heavyWaiters.length > 0) {
    const next = heavyWaiters.shift();
    next();
  } else {
    activeHeavyJobs = Math.max(0, activeHeavyJobs - 1);
  }
}

function safeError(err) {
  return {
    error_code: String(err?.code || 'TASK_FAILED').slice(0, 100),
    error_message: String(err?.message || err || 'Tác vụ thất bại').slice(0, 1000),
  };
}

/**
 * Xếp taskFn vào hàng đợi của session. options là tương thích ngược và cho phép
 * route mới gắn taskType/metadata mà không thay đổi chữ ký các route cũ.
 */
function enqueue(sid, taskFn, options = {}) {
  const id = sid || 'default';
  const prev = queues.get(id) || Promise.resolve();
  const taskId = taskJournal.createTask({
    sid: id,
    queue_type: options.queueType || 'standard',
    task_type: options.taskType || taskFn?.taskType || taskFn?.name || 'anonymous',
    metadata: options.metadata || {},
  });

  const run = async () => {
    activeTaskMap.set(id, taskId);
    taskJournal.updateTask(taskId, 'running');
    try {
      const result = await taskFn();
      const current = taskJournal.getTask(taskId);
      taskJournal.updateTask(taskId, current?.status === 'cancel_requested' ? 'cancelled' : 'succeeded');
      return result;
    } catch (err) {
      const current = taskJournal.getTask(taskId);
      taskJournal.updateTask(taskId, current?.status === 'cancel_requested' ? 'cancelled' : 'failed', safeError(err));
      throw err;
    } finally {
      if (activeTaskMap.get(id) === taskId) activeTaskMap.delete(id);
      cancelRequestedTasks.delete(taskId);
      const cancelEntry = cancelMap.get(id);
      if (cancelEntry?.taskId === taskId) cancelMap.delete(id);
    }
  };

  const next = prev.then(run, run);
  const guarded = next.catch((err) => {
    console.error(`[QUEUE][${id}] Tác vụ lỗi:`, err?.message || err);
  });
  const cleanup = guarded.finally(() => {
    if (queues.get(id) === cleanup) queues.delete(id);
  });
  queues.set(id, cleanup);
  Object.defineProperty(next, 'taskId', { value: taskId, enumerable: false });
  return next;
}

function enqueueHeavy(sid, taskFn, options = {}) {
  return enqueue(sid, async () => {
    await _acquireHeavySlot();
    try {
      return await taskFn();
    } finally {
      _releaseHeavySlot();
    }
  }, { ...options, queueType: 'heavy' });
}

function registerCancel(sid, killFn) {
  const id = sid || 'default';
  const taskId = activeTaskMap.get(id)
    || taskJournal.listTasks({ sid: id, limit: 5 }).find((task) => task.status === 'running' || task.status === 'cancel_requested')?.task_id
    || '';
  cancelMap.set(id, { killFn, taskId });

  // Đóng race: người dùng có thể bấm Dừng ngay giữa lúc vòng lặp chuẩn bị spawn worker kế tiếp.
  // Nếu task đã có cờ huỷ thì worker vừa spawn phải bị dừng ngay, không được chạy tiếp một ca mới.
  if (taskId && cancelRequestedTasks.has(taskId)) {
    try { killFn(); } catch (_) {}
  }
}

function unregisterCancel(sid) {
  const id = sid || 'default';
  cancelMap.delete(id);
}

function getQueueStatus() {
  return {
    max_heavy_jobs: MAX_HEAVY_JOBS,
    active_heavy_jobs: activeHeavyJobs,
    heavy_waiters: heavyWaiters.length,
    queued_sessions: queues.size,
    cancellable_sessions: cancelMap.size,
  };
}

function cancelSession(sid) {
  const id = sid || 'default';
  const entry = cancelMap.get(id);
  const taskId = activeTaskMap.get(id)
    || entry?.taskId
    || taskJournal.listTasks({ sid: id, limit: 5 }).find((task) => task.status === 'running' || task.status === 'cancel_requested')?.task_id
    || '';

  // Trước đây chỉ huỷ được khi đúng lúc có Python process trong cancelMap.
  // Với job nhiều ca, khoảng trống giữa hai worker khiến nút Dừng mất tác dụng và vòng lặp spawn ca tiếp.
  if (!taskId && !entry) return false;

  if (taskId) {
    cancelRequestedTasks.add(taskId);
    taskJournal.requestCancel(taskId);
  }
  if (entry) {
    try { entry.killFn(); } catch (_) {}
    cancelMap.delete(id);
  }
  return true;
}

/**
 * Cho task nhiều bước/ nhiều Python worker kiểm tra cooperative cancellation.
 * Cờ chỉ được xoá khi task queue thật sự rời khỏi task hiện tại.
 */
function isCancelRequested(sid) {
  const id = sid || 'default';
  const taskId = activeTaskMap.get(id);
  if (!taskId) return false;
  if (cancelRequestedTasks.has(taskId)) return true;
  return taskJournal.getTask(taskId)?.status === 'cancel_requested';
}

module.exports = {
  enqueue,
  enqueueHeavy,
  registerCancel,
  unregisterCancel,
  cancelSession,
  isCancelRequested,
  getQueueStatus,
  listDurableTasks: taskJournal.listTasks,
  getDurableTask: taskJournal.getTask,
};
