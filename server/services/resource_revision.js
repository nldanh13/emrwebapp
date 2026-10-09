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

function revisionForFiles(filePaths) {
  const hash = crypto.createHash('sha256');
  let seen = 0;
  for (const filePath of (Array.isArray(filePaths) ? filePaths : [filePaths])) {
    const name = String(filePath || '');
    hash.update(`path:${name}\n`);
    try {
      if (name && fs.existsSync(name)) {
        hash.update(fs.readFileSync(name));
        seen += 1;
      } else {
        hash.update('<missing>');
      }
    } catch {
      hash.update('<unreadable>');
    }
    hash.update('\n');
  }
  return seen ? `sha256-${hash.digest('hex')}` : EMPTY_REVISION;
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

function checkRevision(req, res, currentRevision, { resource = 'resource', requireForModernClient = false, lastWriter = null, lastWriterText = '' } = {}) {
  const expected = requestRevision(req);
  const current = normalizeRevision(currentRevision) || EMPTY_REVISION;
  setRevisionHeaders(res, current);

  if (!expected) {
    if (requireForModernClient && String(req.get('x-client-concurrency') || '') === '1') {
      res.status(428).json({
        status: 'conflict',
        code: 'RESOURCE_VERSION_REQUIRED',
        resource,
        current_version: current,
        message: 'Thiết bị này chưa có phiên bản dữ liệu hiện tại. Hãy tải lại màn hình trước khi lưu.',
      });
      return false;
    }
    // Tương thích client cũ chưa có cơ chế version.
    return true;
  }
  if (expected === '*' || expected === current) return true;

  res.status(409).json({
    status: 'conflict',
    code: 'RESOURCE_VERSION_CONFLICT',
    resource,
    expected_version: expected,
    current_version: current,
    last_writer: lastWriter || undefined,
    message: lastWriterText
      ? `Dữ liệu này vừa được ${lastWriterText} trên máy khác. Hãy tải lại bản mới nhất rồi sửa tiếp, để không ghi đè thay đổi của họ.`
      : 'Dữ liệu đã được thay đổi trên thiết bị khác. Hãy tải lại dữ liệu mới nhất trước khi lưu để tránh ghi đè.',
  });
  return false;
}

module.exports = {
  EMPTY_REVISION,
  normalizeRevision,
  revisionForBuffer,
  revisionForFile,
  revisionForFiles,
  setRevisionHeaders,
  requestRevision,
  checkRevision,
};
