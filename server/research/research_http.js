'use strict';

// Hỗ trợ HTTP của Kho nghiên cứu: che/ghi nhận truy cập định danh, xuất CSV theo dòng, khóa theo kho cho thao tác ghi.

const { ALLOW_IDENTIFIED_RESEARCH_EXPORT } = require('../constants');
const { hasRole } = require('../services/authz');
const { appendSecurityAudit } = require('../services/security_audit');
const fs = require('fs');
const { safeDownloadName } = require('./table_io');
const path = require('path');
const crypto = require('crypto');
const { readCsvFileRows } = require('./csv_reader');
const { redactCsvTable } = require('./export_utils');
const { EXPORT_SENSITIVE_COLUMNS, cleanStudyId, ARCHIVE_ID, nowIso } = require('./store_paths');
const { rowsToCsv, csvEscape } = require('../utils/csv');
const { verifyAllDatasetSnapshots } = require('./dataset_store');

function researchResponseShouldRedact(req) {
  const requestedIdentified = String(req.query?.identified || '') === '1'
    || String(req.query.redact || '').toLowerCase() === '0'
    || String(req.query.redact || '').toLowerCase() === 'false';
  if (!requestedIdentified) return true;
  if (!ALLOW_IDENTIFIED_RESEARCH_EXPORT) {
    const err = new Error('Xuất dữ liệu nghiên cứu có định danh đang bị khóa. Chỉ bật EMR_ALLOW_IDENTIFIED_RESEARCH_EXPORT sau khi có phê duyệt và kiểm soát truy cập.');
    err.status = 403;
    err.code = 'IDENTIFIED_ACCESS_LOCKED';
    throw err;
  }
  if (!hasRole(req.auth, 'supervisor')) {
    const err = new Error('Chỉ supervisor/admin được xuất dữ liệu nghiên cứu có định danh.');
    err.status = 403;
    err.code = 'IDENTIFIED_ACCESS_ROLE';
    throw err;
  }
  auditIdentifiedResearchAccess(req);
  return false;
}

// Mọi request /research đã có dòng audit chung (activity_logger), nhưng lần xem/xuất
// dữ liệu CÓ ĐỊNH DANH cần một sự kiện riêng dễ lọc: ai, lúc nào, bảng/run/nghiên cứu
// nào và mục đích (tham số ?purpose=, nếu giao diện gửi). Không ghi từ khóa tra cứu.
function auditIdentifiedResearchAccess(req) {
  const q = req.query || {};
  appendSecurityAudit({
    kind: 'research.identified_access',
    actor: { id: String(req.auth?.id || ''), role: String(req.auth?.role || '') },
    method: String(req.method || ''),
    path: String(req.path || ''),
    scope: {
      study_id: String(req.params?.studyId || ''),
      table: String(q.table || ''),
      run_id: String(q.runId || ''),
      has_query: Boolean(String(q.q || '').trim()),
    },
    purpose: String(q.purpose || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200),
  });
}

// Xuất theo từng dòng ra file tạm cạnh file nguồn rồi stream về trình duyệt: bảng XN/CĐHA
// vài trăm MB không còn bị nạp trọn thành object + một chuỗi CSV khổng lồ (hết RAM).
// File tạm có thể chứa định danh (khi được phép xuất có định danh) nên đặt cạnh dữ liệu
// gốc, quyền 600, và xóa ngay khi gửi xong/ngắt kết nối.
function sendCsvFile(res, filePath, filenameBase, { redact = true } = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ status: 'error', message: 'Bảng chưa có file CSV để xuất.' });
  }
  const filename = `${safeDownloadName(filenameBase)}.csv`;
  const tmpPath = path.join(path.dirname(filePath), `.export_tmp_${process.pid}_${crypto.randomBytes(6).toString('hex')}.csv`);
  let fd = null;
  try {
    fd = fs.openSync(tmpPath, 'w', 0o600);
    let buffer = '\ufeff';
    const flush = (force = false) => {
      if (buffer.length && (force || buffer.length >= 1024 * 1024)) {
        fs.writeSync(fd, buffer, null, 'utf-8');
        buffer = '';
      }
    };
    let columns = [];
    readCsvFileRows(filePath, Number.MAX_SAFE_INTEGER, {
      onHeader(header) {
        columns = redact ? redactCsvTable(header, [], EXPORT_SENSITIVE_COLUMNS).columns : header;
        buffer += rowsToCsv(columns, []);
      },
      onRow(row) {
        buffer += `${columns.map(col => csvEscape(row[col] ?? '')).join(',')}\n`;
        flush();
      },
    });
    flush(true);
    fs.closeSync(fd);
    fd = null;
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* bỏ qua */ } }
    try { fs.unlinkSync(tmpPath); } catch (_) { /* bỏ qua */ }
    throw err;
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  const cleanup = () => { fs.unlink(tmpPath, () => {}); };
  const stream = fs.createReadStream(tmpPath);
  stream.on('error', (err) => {
    cleanup();
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
    else res.destroy(err);
  });
  res.on('close', cleanup);
  return stream.pipe(res);
}

// ── Khóa theo phạm vi (kho gốc / từng nghiên cứu) ───────────────────────────
// Các thao tác ghi dữ liệu của một kho (lấy dữ liệu, thu thập tự động, chuẩn hóa, chốt
// dataset...) không được chạy chồng: server cho phép 2 tác vụ nặng song song, nên trước
// đây hai người (hoặc hai tab) có thể cùng ghi progress.json, sổ thu thập và các CSV của
// cùng một run. Khóa giữ tới khi handler xong hẳn (các handler này chờ worker chạy xong
// mới trả lời). Thao tác chỉ đọc và nút Dừng (/api/cancel) không bị khóa.
const RESEARCH_SCOPE_LOCKS = new Map();

function researchScopeKey(req) {
  const studyId = req.params?.studyId;
  if (studyId) {
    try { return `study:${cleanStudyId(studyId)}`; } catch (_) { return `study:${String(studyId)}`; }
  }
  if (req.path === '/research/refetch-missing') {
    const raw = String(req.body?.scope || ARCHIVE_ID).trim();
    if (raw === ARCHIVE_ID || raw === '__archive__' || raw === 'archive') return 'archive';
    try { return `study:${cleanStudyId(raw)}`; } catch (_) { return `study:${raw}`; }
  }
  return 'archive';
}

function researchScopeBusy(key) {
  return RESEARCH_SCOPE_LOCKS.get(key) || null;
}

function lockedResearchRoute(targetRouter, method, routePath, label, handler) {
  targetRouter[method](routePath, async (req, res, next) => {
    const key = researchScopeKey(req);
    const holder = RESEARCH_SCOPE_LOCKS.get(key);
    if (holder) {
      return res.status(409).json({
        status: 'error',
        code: 'RESEARCH_SCOPE_BUSY',
        message: `Kho này đang chạy "${holder.label}" (từ ${holder.since}). Chờ tác vụ đó xong hoặc bấm Dừng rồi thử lại.`,
        busy: { label: holder.label, since: holder.since },
      });
    }
    const token = { label, since: nowIso() };
    RESEARCH_SCOPE_LOCKS.set(key, token);
    try {
      return await handler(req, res, next);
    } finally {
      if (RESEARCH_SCOPE_LOCKS.get(key) === token) RESEARCH_SCOPE_LOCKS.delete(key);
    }
  });
}

// Trạng thái quyền xem dữ liệu có định danh, để giao diện hiện "đang khóa" thay vì gọi
// API rồi báo lỗi. Không trả dữ liệu nào; server vẫn tự chặn ở từng API như cũ.
function identifiedAccessStatus(req) {
  const envEnabled = Boolean(ALLOW_IDENTIFIED_RESEARCH_EXPORT);
  const roleOk = hasRole(req.auth, 'supervisor');
  return { allowed: envEnabled && roleOk, env_enabled: envEnabled, role_ok: roleOk };
}

// Kiểm tra toàn vẹn snapshot dataset: valid | missing | modified. Chỉ đọc — không sửa,
// không ghi đè, không dọn gì. Kết quả chỉ gồm tên snapshot, tên file và checksum.
function datasetVerifyResponse(runId, runDir) {
  const results = runDir ? verifyAllDatasetSnapshots(runDir) : [];
  const counts = { valid: 0, missing: 0, modified: 0 };
  for (const r of results) counts[r.status] += 1;
  return { status: 'ok', run_id: runId || '', counts, snapshots: results };
}

module.exports = {
  researchResponseShouldRedact,
  auditIdentifiedResearchAccess,
  sendCsvFile,
  RESEARCH_SCOPE_LOCKS,
  researchScopeKey,
  researchScopeBusy,
  lockedResearchRoute,
  identifiedAccessStatus,
  datasetVerifyResponse,
};
