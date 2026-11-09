// server/services/order_pipeline.js — Các bước xử lý y lệnh độc lập, tái sử dụng bởi route/workflow.

'use strict';

const { runScript, fmtPyError } = require('./python_runner');
const { registerCancel, unregisterCancel } = require('./task_queue');
const { refreshRuntimeV2 } = require('./runtime_v2');
const { readJsonSafe, writeJsonAtomic } = require('../utils/file');
const { collectManualStarts, reapplyManualStarts } = require('../utils/manual_infusion_starts');

function pipelineError(message, { status = 500, code = 'ORDER_POSTPROCESS_FAILED', details = null } = {}) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  err.details = details;
  return err;
}

async function postprocessOrders(ctx, { reason = 'postprocess' } = {}) {
  // Giờ "Bổ sung giờ" nằm trong dữ liệu đã xử lý; post_process.py tạo lại file này nên
  // phải giữ lại trước và khôi phục sau, nếu không bấm nhập (tiền kiểm thấy YL mới) sẽ mất giờ.
  const manualStarts = ctx.PROCESSED_PATH ? collectManualStarts(readJsonSafe(ctx.PROCESSED_PATH, [])) : new Map();
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

  let manualRestore = null;
  if (manualStarts.size) {
    const rows = readJsonSafe(ctx.PROCESSED_PATH, []);
    manualRestore = reapplyManualStarts(rows, manualStarts);
    if (manualRestore.restored.length) writeJsonAtomic(ctx.PROCESSED_PATH, rows);
  }

  const v2 = await refreshRuntimeV2(ctx, reason);
  return {
    status: 'succeeded',
    message: 'Đã phân loại y lệnh.',
    worker_code: result.code,
    v2: v2?.indexes || null,
    v2_ok: Boolean(v2?.ok),
    manual_infusion_starts: manualRestore
      ? { restored: manualRestore.restored.length, skipped: manualRestore.skipped }
      : null,
  };
}

module.exports = { postprocessOrders, pipelineError };
