// server/routes/report.js — /api/run-report-infusion

'use strict';

const router = require('express').Router();
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { getRuntimePaths }  = require('../services/session');
const { runScript, fmtPyError } = require('../services/python_runner');
const { enqueueHeavy, registerCancel, unregisterCancel } = require('../services/task_queue');
const { ensureDir, safeFilePart } = require('../utils/file');
const { appendActivity } = require('../services/activity_logger');
const { isValidDmy, clampHour }   = require('../utils/validation');


const MAX_REPORT_ROWS = 5000;

function cleanSnapshotText(value, maxLen = 500) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLen);
}

function sanitizeReportSnapshot(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const rows = Array.isArray(input.rows) ? input.rows : null;
  if (!rows) return null;
  if (rows.length > MAX_REPORT_ROWS) {
    const err = new Error(`Báo cáo vượt quá ${MAX_REPORT_ROWS} dòng thuốc.`);
    err.status = 400;
    throw err;
  }

  const date = cleanSnapshotText(input.date, 10);
  if (date && !isValidDmy(date)) {
    const err = new Error('Ngày snapshot báo cáo không đúng định dạng dd/mm/yyyy.');
    err.status = 400;
    throw err;
  }

  return {
    version: 1,
    source: cleanSnapshotText(input.source, 40) || 'ward',
    date,
    rows: rows.map((row, index) => ({
      id: cleanSnapshotText(row?.id, 240) || `row-${index + 1}`,
      room: cleanSnapshotText(row?.room, 80),
      patientName: cleanSnapshotText(row?.patientName, 240),
      patientId: cleanSnapshotText(row?.patientId, 120),
      drugName: cleanSnapshotText(row?.drugName, 500),
      route: cleanSnapshotText(row?.route, 40),
      time: cleanSnapshotText(row?.time, 12),
      date: cleanSnapshotText(row?.date, 10),
      quantity: Number.isFinite(Number(row?.quantity)) ? Number(row.quantity) : 0,
      unit: cleanSnapshotText(row?.unit, 40),
      note: cleanSnapshotText(row?.note, 500),
      mixWith: cleanSnapshotText(row?.mixWith, 500),
      noTime: Boolean(row?.noTime),
      tuTuc: Boolean(row?.tuTuc),
      category: cleanSnapshotText(row?.category, 80),
    })).filter(row => row.drugName && (!row.date || isValidDmy(row.date))),
  };
}

// GET /api/run-report-infusion — Tạo PDF từ snapshot đang hiển thị ở Báo cáo trực.
// Nếu không có snapshot (client cũ / gọi trực tiếp), vẫn giữ fallback đọc processed.json.
router.get('/run-report-infusion', requireOttOrAppToken, async (req, res) => {
  const ctx = getRuntimePaths(req);
  const reportSnapshot = req._ottReport && Array.isArray(req._ottReport.rows)
    ? req._ottReport
    : null;

  if (!reportSnapshot && !fs.existsSync(ctx.PROCESSED_PATH)) {
    return res.status(400).send("Chưa có file phân loại. Hãy chạy 'Xử Lý' trước.");
  }

  const q        = req.query;
  const date     = String(q.date      || reportSnapshot?.date || '').trim();
  const dateFrom = String(q.date_from || '').trim();
  const dateTo   = String(q.date_to   || '').trim();
  const start    = clampHour(q.start,  0);
  const end      = clampHour(q.end,   23);
  const excludeZero = (String(q.no0 || '0') === '1') || (String(q.include0 || '1') === '0');

  if (date     && !isValidDmy(date))     return res.status(400).send('date không đúng định dạng dd/mm/yyyy');
  if (dateFrom && !isValidDmy(dateFrom)) return res.status(400).send('date_from không đúng định dạng dd/mm/yyyy');
  if (dateTo   && !isValidDmy(dateTo))   return res.status(400).send('date_to không đúng định dạng dd/mm/yyyy');

  const tag     = (dateFrom || dateTo) ? `${dateFrom || 'ALL'}-${dateTo || 'ALL'}` : (date || 'ALL');
  const caLabel = (start === 0  && end === 23) ? 'ca-ngay'
                : (start === 6  && end === 11) ? 'ca-sang'
                : (start === 12 && end === 17) ? 'ca-chieu'
                : (start === 17 && end === 22) ? 'ca-toi'
                : (start >= 20 || end <= 7)    ? 'ca-dem'
                : `ca-${start}-${end}`;

  ensureDir(ctx.REPORTS_DIR);
  const outName = `Phieu_Tiem_Truyen_${safeFilePart(tag).replaceAll('/', '-')}_${caLabel}.pdf`;
  const outPath = path.join(ctx.REPORTS_DIR, outName);
  let snapshotPath = '';

  const args = ['--out', outPath];
  if (reportSnapshot) {
    snapshotPath = path.join(ctx.REPORTS_DIR, `.report_snapshot_${crypto.randomBytes(8).toString('hex')}.json`);
    fs.writeFileSync(snapshotPath, JSON.stringify(reportSnapshot), { encoding: 'utf8', mode: 0o600 });
    args.push('--rows-input', snapshotPath);
  } else {
    args.push('--input', ctx.PROCESSED_PATH);
  }
  if (dateFrom) { args.push('--from', dateFrom); args.push('--to', dateTo || dateFrom); }
  else if (date) args.push('--date', date);
  args.push('--start', String(start), '--end', String(end));
  if (excludeZero) args.push('--no0');

  try {
    await enqueueHeavy(ctx.sid, async () => {
      let result;
      try {
        result = await runScript('generate_report.py', args, {
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
          runtimeDir: ctx.dir,
        });
      } finally {
        unregisterCancel(ctx.sid);
        if (snapshotPath) {
          try { fs.unlinkSync(snapshotPath); } catch (_) {}
        }
      }
      if (result.spawnError)      return res.status(500).send(`Không khởi động được Python: ${result.spawnError}`);
      if (result.killedByTimeout) return res.status(504).send('Timeout khi tạo báo cáo');

      if (result.code === 0 && fs.existsSync(outPath)) {
        appendActivity(ctx, {
          kind: 'workflow.report.success',
          source: reportSnapshot?.source || 'processed',
          snapshot_rows: reportSnapshot?.rows?.length || 0,
          date, date_from: dateFrom, date_to: dateTo, start, end, exclude_zero: excludeZero,
        });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${outName}"`);
        return res.sendFile(outPath);
      }
      return res.status(500).send(fmtPyError('Không tạo được file báo cáo.', result));
    });
  } catch (err) {
    console.error(err);
    if (snapshotPath) {
      try { fs.unlinkSync(snapshotPath); } catch (_) {}
    }
    if (!res.headersSent) res.status(500).send(String(err.message || err));
  }
});

// ── Short-lived report token ──────────────────────────────────────────────────
// Vấn đề: GET /api/run-report-infusion?token=... lộ APP_TOKEN vào browser
// history và server access log. Giải pháp: đổi APP_TOKEN lấy một short-lived
// token (SLT) qua POST (header), rồi dùng SLT trên URL GET thay thế.
//
// Flow:
//  1. Frontend POST /api/report-token → nhận { ott }
//  2. Frontend mở URL /api/run-report-infusion?ott=<ott>&... (không có APP_TOKEN)
//  3. Backend kiểm tra SLT còn hạn → pass; hết hạn → 401.
//
// Lý do cho phép nhiều lần dùng trong TTL:
//   Trình duyệt khi hiển thị PDF inline có thể gửi nhiều request đến cùng URL
//   (HEAD probe, HTTP Range request của PDF viewer, prefetch...). Nếu xoá token
//   sau lần đầu, các request sau sẽ thất bại dù cùng một lượt mở. Token ngắn
//   hạn (OTT_TTL_MS) đã đủ bảo vệ — không cần giới hạn thêm số lần dùng.

const OTT_TTL_MS = 2 * 60 * 1000; // 2 phút — đủ ngắn để không bị tái sử dụng sau này

/** Map ott → { sid, expiresAt } */
const ottStore = new Map();

// Dọn token hết hạn mỗi 5 phút
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ottStore) {
    if (now > v.expiresAt) ottStore.delete(k);
  }
}, 5 * 60_000).unref();

/**
 * POST /api/report-token
 * Yêu cầu: APP_TOKEN đã được xác thực bởi requireAppToken middleware.
 * Trả về: { ott } — short-lived token cho GET /api/run-report-infusion.
 * Không cần body.
 */
router.post('/report-token', (req, res) => {
  const ctx = getRuntimePaths(req);
  let report = null;
  try {
    report = sanitizeReportSnapshot(req.body?.report);
  } catch (err) {
    return res.status(Number(err.status) || 400).json({
      status: 'error',
      code: 'INVALID_REPORT_SNAPSHOT',
      message: String(err.message || err),
    });
  }
  const ott = crypto.randomBytes(24).toString('hex');
  ottStore.set(ott, { sid: ctx.sid, report, expiresAt: Date.now() + OTT_TTL_MS });
  return res.json({ ott });
});

/** Middleware: kiểm tra ?ott=... trên request GET report (nếu APP_TOKEN bật). */
function requireOttOrAppToken(req, res, next) {
  // Request đã được xác thực bằng header (fetch nội bộ hoặc localhost-only) được phép đi tiếp.
  if (req.auth && req.auth.auth_type !== 'one_time_token') return next();

  // Link mở tab/PDF chỉ được dùng OTT đã cấp bởi POST /api/report-token.
  const ott = String(req.query.ott || '').trim();
  if (ott) {
    const entry = ottStore.get(ott);
    if (!entry || Date.now() > entry.expiresAt) {
      ottStore.delete(ott);
      return res.status(401).send('Link báo cáo đã hết hạn. Vui lòng bấm nút in lại.');
    }
    // Token hợp lệ — gán sid, KHÔNG xoá ngay để browser PDF viewer có thể
    // gửi nhiều request (Range, HEAD...) đến cùng URL trong cùng một lượt mở.
    // Token sẽ tự hết hạn sau OTT_TTL_MS.
    req._ottSid = entry.sid;
    req._ottReport = entry.report || null;
    return next();
  }

  // Không chấp nhận token ứng dụng trực tiếp trên URL.

  return res.status(401).send('Cần mã truy cập. Tải lại trang và thử lại.');
}

module.exports = router;
module.exports.requireOttOrAppToken = requireOttOrAppToken;
