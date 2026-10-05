'use strict';

const path = require('path');
const { CONFIG_PATH } = require('../constants');
const { getRuntimePaths } = require('../services/session');
const { revisionForFiles, setRevisionHeaders, checkRevision } = require('../services/resource_revision');
const { publishResourceEvent } = require('../services/realtime_bus');

// Một mutation đang chạy trên cùng resource thì mutation thứ hai bị từ chối ngay.
// Cách này tránh race "hai request cùng đọc version cũ rồi cùng ghi".
const ACTIVE_WRITES = new Map();

function resourceSpec(req) {
  const p = String(req.path || '');
  const ctx = getRuntimePaths(req);

  if (p === '/data' || p === '/save') {
    return { key: 'board', files: [ctx.SORTED_PATH], readPath: '/data' };
  }
  if (p === '/nurse-settings') {
    return {
      key: 'nurse-settings',
      files: [CONFIG_PATH, path.join(ctx.dir, 'config.json')],
      readPath: '/nurse-settings',
    };
  }
  if (p === '/admin-nurse-state') {
    return {
      key: 'admin-nurse-state',
      files: [path.join(ctx.dir, 'admin_nurse_state.json')],
      readPath: '/admin-nurse-state',
    };
  }
  if (p === '/sick-leave-state') {
    return {
      key: 'sick-leave-state',
      files: [path.join(ctx.dir, 'sick_leave_state.json')],
      readPath: '/sick-leave-state',
    };
  }
  if (p === '/sick-leave-import' || p === '/sick-leave-import/delete-row') {
    return {
      key: 'sick-leave-import',
      files: [path.join(ctx.dir, 'sick_leave_import.json')],
      readPath: '/sick-leave-import',
    };
  }
  return null;
}

function isMutation(req) {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(req.method || '').toUpperCase());
}

function resourceConcurrency(req, res, next) {
  const spec = resourceSpec(req);
  if (!spec) return next();

  const ctx = getRuntimePaths(req);
  const lockKey = `${ctx.sid}:${spec.key}`;
  const current = revisionForFiles(spec.files);
  setRevisionHeaders(res, current);
  res.setHeader('X-Resource-Key', spec.key);

  if (!isMutation(req)) return next();

  if (ACTIVE_WRITES.has(lockKey)) {
    return res.status(409).json({
      status: 'conflict',
      code: 'RESOURCE_WRITE_BUSY',
      resource: spec.key,
      message: 'Dữ liệu này đang được lưu từ thiết bị khác. Hãy chờ thao tác đó hoàn tất rồi tải lại.',
    });
  }

  if (!checkRevision(req, res, current, { resource: spec.key, requireForModernClient: true })) return undefined;

  const token = Symbol(lockKey);
  ACTIVE_WRITES.set(lockKey, token);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (ACTIVE_WRITES.get(lockKey) === token) ACTIVE_WRITES.delete(lockKey);
  };
  res.once('finish', release);
  res.once('close', release);

  const originalJson = res.json.bind(res);
  res.json = function wrappedJson(body) {
    // Route đã hoàn tất ghi file trước khi gọi res.json. Tính revision mới ngay lúc này
    // để response và các thiết bị khác nhận đúng phiên bản vừa commit.
    if (res.statusCode >= 200 && res.statusCode < 400) {
      const version = revisionForFiles(spec.files);
      setRevisionHeaders(res, version);
      publishResourceEvent({
        sid: ctx.sid,
        resource: spec.key,
        version,
        actor_id: req.auth?.id || '',
      });
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        body = { ...body, resource_version: version };
      }
    }
    return originalJson(body);
  };

  return next();
}

function getActiveResourceWrites() {
  return [...ACTIVE_WRITES.keys()];
}

module.exports = { resourceConcurrency, resourceSpec, getActiveResourceWrites };
