import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { safeTaskEvent, subscribeTaskEvents, publishTaskEvent } = require('./realtime_bus.js');

describe('realtime_bus', () => {
  it('projects only safe task fields and derives status', () => {
    expect(safeTaskEvent({
      event: 'task_succeeded',
      at: '2026-10-05T00:00:00.000Z',
      task_id: 't1',
      sid: 'workspace1',
      task_type: 'scan',
      metadata: { patient_name: 'should not leak through event bus' },
    })).toEqual({
      event: 'task_succeeded',
      at: '2026-10-05T00:00:00.000Z',
      task_id: 't1',
      sid: 'workspace1',
      task_type: 'scan',
      status: 'succeeded',
      queue_type: '',
      error_code: '',
    });
  });

  it('subscribes and unsubscribes task events', () => {
    const rows = [];
    const stop = subscribeTaskEvents((event) => rows.push(event));
    publishTaskEvent({ event: 'task_running', task_id: 't2', sid: 'w2', task_type: 'collect' });
    stop();
    publishTaskEvent({ event: 'task_succeeded', task_id: 't2', sid: 'w2', task_type: 'collect' });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('running');
  });
});
