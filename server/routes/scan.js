// server/routes/scan.js — /api/run-scan, /api/get-raw

'use strict';

const router = require('express').Router();
const fs     = require('fs');
const path   = require('path');

const { getRuntimePaths, ensureSessionAssets, clearSessionDerivedState } = require('../services/session');
const { ROOT_DIR } = require('../constants');
const { runWorker }                   = require('../services/python_runner');
const { enqueueHeavy, registerCancel, unregisterCancel } = require('../services/task_queue');
const { fmtPyError } = require('../services/python_runner');
const { writeScanLog }                = require('../services/scan_logger');
const { appendActivity }              = require('../services/activity_logger');
const { refreshRuntimeV2 }             = require('../services/runtime_v2');
const { sync_index_from_patients }      = require('../hchanh_data_contract');
const { readJsonSafe, safeUnlink, writeJsonAtomic } = require('../utils/file');

function getScannedPatientId(row) {
  return String(
    row?.ma_bn || row?.MaBN || row?.Ma_BN || row?.mabn || row?.maBenhNhan ||
    row?.['Mã BN'] || row?.['Ma BN'] || row?.['Mã bệnh nhân'] || row?.['Ma benh nhan'] ||
    row?.ma_yt || row?.MaYT || row?.Ma_YT || row?.['Mã YT'] || row?.['Ma YT'] || row?.id || ''
  ).trim();
}

function mergeScanWithExistingBoard(oldSorted, rawData) {
  const rows = Array.isArray(rawData) ? rawData.filter(x => x && typeof x === 'object' && !Array.isArray(x)) : [];
  const oldRows = Array.isArray(oldSorted) ? oldSorted.filter(x => x && typeof x === 'object' && !Array.isArray(x)) : [];

  const oldById = new Map();
  for (const row of oldRows) {
    const id = getScannedPatientId(row);
    if (id && !oldById.has(id)) oldById.set(id, row);
  }

  const rawById = new Map();
  const rawNoId = [];
  for (const row of rows) {
    const id = getScannedPatientId(row);
    if (!id) {
      rawNoId.push({ ...row, Vi_Tri: '' });
      continue;
    }
    if (!rawById.has(id)) rawById.set(id, row);
  }

  const keptIds = [];
  const seenKept = new Set();
  for (const oldRow of oldRows) {
    const id = getScannedPatientId(oldRow);
    if (id && rawById.has(id) && !seenKept.has(id)) {
      keptIds.push(id);
      seenKept.add(id);
    }
  }

  const newIds = [];
  for (const row of rows) {
    const id = getScannedPatientId(row);
    if (id && !seenKept.has(id) && !newIds.includes(id)) newIds.push(id);
  }

  const merged = [];
  for (const id of keptIds) {
    const oldRow = oldById.get(id) || {};
    const rawRow = rawById.get(id) || {};
    merged.push({
      ...oldRow,
      ...rawRow,
      // Giữ nguyên phòng đã xếp. Các thông tin hành chính mới từ lần scan vẫn được cập nhật.
      Vi_Tri: String(oldRow.Vi_Tri || '').trim(),
    });
  }

  for (const id of newIds) {
    const rawRow = rawById.get(id) || {};
    // Người bệnh mới luôn đưa vào khu chờ xếp, không tự lấy phòng/giường từ raw scan.
    merged.push({ ...rawRow, Vi_Tri: '' });
  }

  merged.push(...rawNoId);

  const removedIds = oldRows
    .map(row => getScannedPatientId(row))
    .filter(id => id && !rawById.has(id));

  return {
    rows: merged,
    kept: keptIds.length,
    added: newIds.length + rawNoId.length,
    removed: removedIds.length,
    removed_ids: removedIds.slice(0, 50),
  };
}

function resetSessionAfterNewScan(ctx, rawData) {
  const oldSorted = readJsonSafe(ctx.SORTED_PATH, []);
  const merged = mergeScanWithExistingBoard(oldSorted, rawData);

  try {
    writeJsonAtomic(ctx.SORTED_PATH, merged.rows);
  } catch (err) {
    console.error('[SCAN] Không ghi được data_sorted:', err.message);
  }

  // Các file bên dưới thuộc lần lấy y lệnh/cũ. Giữ lại sẽ làm tab bệnh nhân
  // tiếp tục hiển thị dữ liệu cũ dù raw scan mới đã có.
  clearSessionDerivedState(ctx, { clearReports: true });
  [
    ctx.FINAL_PATH,
    ctx.PROCESSED_PATH,
    ctx.CARE_DONE_PATH,
    ctx.INFUSIONS_DONE_PATH,
    ctx.PROCEDURES_DONE_PATH,
    ctx.VTYT_DONE_PATH,
    ctx.TASK_PROGRESS_PATH,
    ctx.PATIENTS_PATH,
    ctx.BOARD_STATE_PATH,
    ctx.ORDER_DAYS_PATH,
    ctx.CLASSIFIED_DAYS_PATH,
    ctx.WARNINGS_PATH,
    ctx.INDEXES_PATH,
    path.join(ctx.dir, 'admin_nurse_state.json'),
  ].forEach(safeUnlink);

  return merged;
}

// GET /api/run-scan — Quét danh sách bệnh nhân nội trú từ EMR
router.get('/run-scan', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    ensureSessionAssets(ctx.dir, ROOT_DIR);
    await enqueueHeavy(ctx.sid, async () => {
      let result;
      try {
        result = await runWorker('scan', ['--out', ctx.RAW_PATH], {
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
          runtimeDir: ctx.dir,
        });
      } finally {
        unregisterCancel(ctx.sid);
      }

      if (result.spawnError)      return res.status(500).json({ status: 'error', message: `Không khởi động được Python: ${result.spawnError}` });
      if (result.killedByTimeout) return res.status(504).json({ status: 'error', message: 'Timeout khi quét (scan)' });

      if (result.code === 0) {
        const rawData = readJsonSafe(ctx.RAW_PATH, []);
        const mergeInfo = resetSessionAfterNewScan(ctx, rawData);
        const logInfo = writeScanLog(ctx, rawData);
        const v2Sync = await refreshRuntimeV2(ctx, 'scan');
        let hchanhSync = null;
        try {
          hchanhSync = sync_index_from_patients(ctx, mergeInfo.rows || rawData);
        } catch (err) {
          console.warn('[SCAN] Không đồng bộ được index hành chánh:', String(err.message || err));
        }
        appendActivity(ctx, {
          kind: 'workflow.scan.success',
          count: Array.isArray(rawData) ? rawData.length : 0,
          board: { kept: mergeInfo.kept, added: mergeInfo.added, removed: mergeInfo.removed },
        });
        return res.json({
          status:   'ok',
          message:  'Thành công! Đã quét lại danh sách, giữ phòng cũ theo mã bệnh nhân.',
          count:    Array.isArray(rawData) ? rawData.length : 0,
          board:    { kept: mergeInfo.kept, added: mergeInfo.added, removed: mergeInfo.removed, removed_ids: mergeInfo.removed_ids || [] },
          hchanh:   hchanhSync?.lastSync || null,
          v2:       v2Sync?.indexes || null,
          scan_log: logInfo ? { count: logInfo.count } : null,
        });
      }
      return res.status(500).json({ status: 'error', message: fmtPyError('Python lỗi khi quét danh sách BN.', result) });
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

// GET /api/get-raw — Trả về dữ liệu thô vừa quét
router.get('/get-raw', (req, res) => {
  const ctx  = getRuntimePaths(req);
  const data = readJsonSafe(ctx.RAW_PATH, []);
  return res.json(Array.isArray(data) ? data : []);
});

module.exports = router;
