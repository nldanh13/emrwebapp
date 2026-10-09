// server/services/shared_workspace.js — Kho chung: một workspace mà mọi máy mở mặc định.
//
// Trước đây mỗi trình duyệt mới tự tạo một workspace trống; muốn dùng chung dữ liệu phải gửi link
// "Mở cùng dữ liệu trên thiết bị khác" cho từng máy. Ở đây máy chủ ghi nhớ một workspace làm kho
// chung (.runtime/shared_workspace.json). Máy chưa có dữ liệu riêng thì tự vào kho chung; máy đang
// có dữ liệu riêng thì được hỏi, không tự chuyển (dữ liệu riêng vẫn nằm nguyên trên máy chủ).

'use strict';

const fs = require('fs');
const path = require('path');

const { RUNTIME_ROOT, SESSIONS_DIR } = require('../constants');
const { buildRuntimeDataPaths } = require('../data_contract');
const { readJsonSafe, writeJsonAtomic } = require('../utils/file');
const { sanitizeSessionId } = require('../utils/validation');

// Các file cho biết workspace đã có dữ liệu người dùng (danh sách quét, xếp phòng, y lệnh...).
const DATA_KEYS = ['RAW_PATH', 'SORTED_PATH', 'FINAL_PATH', 'PROCESSED_PATH', 'BOARD_STATE_PATH'];

function sharedWorkspaceFile() {
  return path.join(RUNTIME_ROOT, 'shared_workspace.json');
}

function workspaceDir(sid) {
  const clean = sanitizeSessionId(sid);
  return clean === 'default' ? RUNTIME_ROOT : path.join(SESSIONS_DIR, clean);
}

/** Workspace đã có dữ liệu chưa. Chỉ kiểm tra file tồn tại, không tạo thư mục hay manifest. */
function workspaceHasData(sid) {
  const paths = buildRuntimeDataPaths(workspaceDir(sid));
  return DATA_KEYS.some((key) => {
    const candidates = [paths[key], ...(paths.LEGACY_PATHS?.[key] || [])].filter(Boolean);
    return candidates.some((p) => {
      try { return fs.statSync(p).size > 2; } catch (_) { return false; }
    });
  });
}

function getSharedWorkspace() {
  const raw = readJsonSafe(sharedWorkspaceFile(), null);
  if (!raw || typeof raw !== 'object' || !raw.sid) return null;
  const sid = sanitizeSessionId(raw.sid);
  if (sid !== String(raw.sid)) return null;
  return {
    sid,
    set_at: String(raw.set_at || ''),
    set_by: String(raw.set_by || ''),
  };
}

function setSharedWorkspace(sid, actor = null) {
  const clean = sanitizeSessionId(sid);
  if (clean !== String(sid || '').trim()) throw new Error('Mã workspace không hợp lệ.');
  const value = {
    sid: clean,
    set_at: new Date().toISOString(),
    set_by: String(actor?.name || actor?.id || ''),
  };
  writeJsonAtomic(sharedWorkspaceFile(), value);
  return value;
}

function clearSharedWorkspace() {
  try { fs.unlinkSync(sharedWorkspaceFile()); } catch (err) { if (err.code !== 'ENOENT') throw err; }
}

module.exports = {
  getSharedWorkspace,
  setSharedWorkspace,
  clearSharedWorkspace,
  workspaceHasData,
};
