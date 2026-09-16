// server/routes/emr_structure_scan.js — /api/run-emr-structure-scan
//
// Dò cấu trúc EMR (ONEMES HIS), so với config/hchanh/emr_structure_manifest.json —
// chỉ đọc, dùng để phát hiện khi EMR đổi cấu trúc (đổi id field, bảng, wpid) làm
// worker/hchanh_fetch.py có thể fetch sai mà không báo lỗi rõ. Không tự sửa code,
// chỉ trả báo cáo cho người dùng xem và quyết định.

'use strict';

const router = require('express').Router();
const path   = require('path');

const { getRuntimePaths, ensureSessionAssets } = require('../services/session');
const { ROOT_DIR } = require('../constants');
const { runScript, fmtPyError } = require('../services/python_runner');
const { enqueueHeavy, registerCancel, unregisterCancel } = require('../services/task_queue');
const { appendActivity } = require('../services/activity_logger');
const { readJsonSafe } = require('../utils/file');

// GET /api/run-emr-structure-scan — Dò cấu trúc EMR, so với danh mục đã biết
router.get('/run-emr-structure-scan', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    ensureSessionAssets(ctx.dir, ROOT_DIR);
    const outPath = path.join(ctx.dir, 'emr_structure_report.json');

    await enqueueHeavy(ctx.sid, async () => {
      let result;
      try {
        result = await runScript('emr_structure_scan.py', ['--out', outPath], {
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
          runtimeDir: ctx.dir,
        });
      } finally {
        unregisterCancel(ctx.sid);
      }

      if (result.spawnError)      return res.status(500).json({ status: 'error', message: `Không khởi động được Python: ${result.spawnError}` });
      if (result.killedByTimeout) return res.status(504).json({ status: 'error', message: 'Timeout khi dò cấu trúc EMR' });

      const report = readJsonSafe(outPath, null);
      if (result.code === 0 && report?.status === 'ok') {
        appendActivity(ctx, {
          kind: 'workflow.emr_structure_scan.success',
          known_pages_changed: report?.summary?.known_pages_changed ?? null,
          discovered_pages_new: report?.summary?.discovered_pages_new ?? null,
        });
        return res.json({ status: 'ok', report });
      }
      if (report?.status === 'error') {
        return res.status(500).json({ status: 'error', message: report.message || 'Lỗi khi dò cấu trúc EMR.' });
      }
      return res.status(500).json({ status: 'error', message: fmtPyError('Python lỗi khi dò cấu trúc EMR.', result) });
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

module.exports = router;
