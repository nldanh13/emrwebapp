import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

function source(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('research cancellation regression', () => {
  it('mounts scope-aware cancel before the legacy /cancel route', () => {
    const routes = source('server/routes/index.js');
    const scoped = routes.indexOf("require('./cancel_scope')");
    const legacy = routes.indexOf("require('./details')");
    expect(scoped).toBeGreaterThan(-1);
    expect(legacy).toBeGreaterThan(scoped);
  });

  it('records the owner session on asynchronous research scope locks', () => {
    const asyncRoute = source('server/routes/research_collection_async.js');
    expect(asyncRoute).toContain('sid: ctx.sid');
    expect(asyncRoute).toContain('isCancelRequested(ctx.sid)');
    expect(asyncRoute).toContain('queue_task_id');
  });

  it('can cancel the research owner session after reload or from another tab', () => {
    const cancelRoute = source('server/routes/cancel_scope.js');
    expect(cancelRoute).toContain('RESEARCH_SCOPE_LOCKS');
    expect(cancelRoute).toContain('cancelSession(target.holder.sid)');
    expect(cancelRoute).toContain('scope_key');
  });

  it('preserves cancel requests while a task is queued', () => {
    const queue = source('server/services/task_queue.js');
    expect(queue).toContain("['running', 'cancel_requested', 'queued']");
    expect(queue).toContain("before?.status === 'cancel_requested'");
    expect(queue).toContain("taskJournal.updateTask(taskId, 'cancelled')");
  });

  it('kills the Selenium process tree on Windows', () => {
    const runner = source('server/services/python_runner.js');
    expect(runner).toContain("spawn('taskkill'");
    expect(runner).toContain("'/T'");
    expect(runner).toContain('terminateProcessTree(py)');
  });
});
