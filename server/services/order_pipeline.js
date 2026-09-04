// server/services/order_pipeline.js — Các bước xử lý y lệnh độc lập, tái sử dụng bởi route/workflow.

'use strict';

const { runScript, fmtPyError } = require('./python_runner');
const { registerCancel, unregisterCancel } = require('./task_queue');
const { refreshRuntimeV2 } = require('./runtime_v2');

function pipelineError(message, { status = 500, code = 'ORDER_POSTPROCESS_FAILED', details = null } = {}) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.details = details;
  return err;
}

async function postprocessOrders(ctx, { reason = 'postprocess' } = {}) {
  let result;
  try {
    result = await runScript('post_process.py', [], {
      cwd: ctx.dir,
      runtimeDir: ctx.dir,
      onSpawn: killFn => registerCancel(ctx.sid, killFn),
    });
  } finally {
    unregisterCancel(ctx.sid);
  }

  if (result.spawnError) {
    throw pipelineError(`Không khởi động được Python: ${result.spawnError}`, {
      code: 'ORDER_POSTPROCESS_SPAWN_FAILED',
      details: result,
    });
  }
  if (result.killedByTimeout) {
    throw pipelineError('Timeout khi xử lý phân loại y lệnh.', {
      status: 504,
      code: 'ORDER_POSTPROCESS_TIMEOUT',
      details: result,
    });
  }
  if (result.code !== 0) {
    throw pipelineError(fmtPyError('Python lỗi khi xử lý phân loại y lệnh.', result), {
      code: 'ORDER_POSTPROCESS_WORKER_FAILED',
      details: result,
    });
  }

  const v2 = await refreshRuntimeV2(ctx, reason);
  return {
    status: 'succeeded',
    message: 'Đã phân loại y lệnh.',
    worker_code: result.code,
    v2: v2?.indexes || null,
    v2_ok: Boolean(v2?.ok),
  };
}

module.exports = { postprocessOrders, pipelineError };
