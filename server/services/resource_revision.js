'use strict';

const crypto = require('crypto');
const fs = require('fs');

const EMPTY_REVISION = 'sha256-empty';

function normalizeRevision(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  return s.replace(/^W\//, '').replace(/^"|"$/g, '');
}

function revisionForBuffer(buffer) {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  if (!b.length) return EMPTY_REVISION;
  return `sha256-${crypto.createHash('sha256').update(b).digest('hex')}`;
}

function revisionForFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return EMPTY_REVISION;
    return revisionForBuffer(fs.readFileSync(filePath));
  } catch {
    return EMPTY_REVISION;
  }
}

function setRevisionHeaders(res, revision) {
  const rev = normalizeRevision(revision) || EMPTY_REVISION;
  res.setHeader('ETag', `"${rev}"`);
  res.setHeader('X-Resource-Version', rev);
  return rev;
}

function requestRevision(req) {
  return normalizeRevision(
    req.get('if-match') ||
    req.get('x-resource-version') ||
    req.body?._resource_version ||
    '',
  );
}

function checkRevision(req, res, currentRevision, { resource = 'resource' } = {}) {
  const expected = requestRevision(req);
  const current = normalizeRevision(currentRevision) || EMPTY_REVISION;
  setRevisionHeaders(res, current);

  // Tương thích client cũ: chỉ bật optimistic concurrency khi client gửi version.
  if (!expected || expected === '*') return true;
  if (expected === current) return true;

  res.status(409).json({
    status: 'conflict',
    code: 'RESOURCE_VERSION_CONFLICT',
    resource,
    expected_version: expected,
    current_version: current,
    message: 'Dữ liệu đã được thay đổi trên thiết bị khác. Hãy tải lại dữ liệu mới nhất trước khi lưu để tránh ghi đè.',
  });
  return false;
}

module.exports = {
  EMPTY_REVISION,
  normalizeRevision,
  revisionForBuffer,
  revisionForFile,
  setRevisionHeaders,
  requestRevision,
  checkRevision,
};
