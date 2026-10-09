// server/routes/workspace.js — /api/workspace: kho chung mà mọi máy mở mặc định.

'use strict';

const router = require('express').Router();

const { getRuntimePaths, getSessionId } = require('../services/session');
const { appendActivity } = require('../services/activity_logger');
const { canAccessSession, hasRole } = require('../services/authz');
const {
  getSharedWorkspace,
  setSharedWorkspace,
  clearSharedWorkspace,
  workspaceHasData,
} = require('../services/shared_workspace');
const { sanitizeSessionId } = require('../utils/validation');

const MANAGE_ROLE = 'supervisor';

function workspaceState(req) {
  const currentSid = getSessionId(req);
  const shared = getSharedWorkspace();
  // Người bị giới hạn session không được biết/được đưa vào kho chung mà họ không có quyền.
  const visibleShared = shared && canAccessSession(req.auth, shared.sid) ? shared : null;
  return {
    status: 'ok',
    shared: visibleShared ? { ...visibleShared, has_data: workspaceHasData(visibleShared.sid) } : null,
    current: {
      sid: currentSid,
      is_shared: Boolean(visibleShared && visibleShared.sid === currentSid),
      has_data: workspaceHasData(currentSid),
    },
    can_manage: hasRole(req.auth, MANAGE_ROLE),
  };
}

// GET /api/workspace — kho chung là workspace nào, máy này đang ở đâu.
router.get('/workspace', (req, res) => res.json(workspaceState(req)));

// PUT /api/workspace/shared — đặt workspace (mặc định: workspace đang mở) làm kho chung.
router.put('/workspace/shared', (req, res) => {
  const requested = String(req.body?.sid || getSessionId(req)).trim();
  const sid = sanitizeSessionId(requested);
  if (sid !== requested) {
    return res.status(400).json({ status: 'error', message: 'Mã dữ liệu không hợp lệ. Mở đúng dữ liệu cần dùng chung rồi bấm lại.' });
  }
  if (!canAccessSession(req.auth, sid)) {
    return res.status(403).json({ status: 'error', message: 'Tài khoản này không có quyền với dữ liệu đó, nên không đặt làm kho chung được.' });
  }
  const previous = getSharedWorkspace();
  setSharedWorkspace(sid, req.auth);
  appendActivity(getRuntimePaths(req), {
    kind: 'workspace.shared.set',
    actor: req.auth,
    target_sid: sid,
    previous_sid: previous?.sid || '',
  });
  return res.json({ ...workspaceState(req), message: 'Đã đặt dữ liệu này làm kho chung.' });
});

// DELETE /api/workspace/shared — bỏ kho chung; mỗi máy giữ workspace đang mở, không xoá dữ liệu nào.
router.delete('/workspace/shared', (req, res) => {
  const previous = getSharedWorkspace();
  clearSharedWorkspace();
  appendActivity(getRuntimePaths(req), {
    kind: 'workspace.shared.clear',
    actor: req.auth,
    previous_sid: previous?.sid || '',
  });
  return res.json({ ...workspaceState(req), message: 'Đã bỏ kho chung. Dữ liệu không bị xoá.' });
});

module.exports = router;
module.exports.MANAGE_ROLE = MANAGE_ROLE;
