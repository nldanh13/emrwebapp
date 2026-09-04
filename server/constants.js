// server/constants.js — Hằng số toàn ứng dụng

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_DIR   = path.resolve(__dirname, '..');
const DIST_DIR   = path.join(ROOT_DIR, 'dist');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const WORKER_DIR = path.join(ROOT_DIR, 'worker');
const CONFIG_DIR = path.join(ROOT_DIR, 'config');

const RUNTIME_ROOT = path.resolve(process.env.EMR_RUNTIME_ROOT || path.join(ROOT_DIR, '.runtime'));
const SESSIONS_DIR = path.join(RUNTIME_ROOT, 'sessions');

function dirEntryCount(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true }).length;
  } catch {
    return 0;
  }
}

function researchStoreScore(dirPath) {
  const archiveDir = path.join(dirPath, 'du_lieu_goc');
  const runsDir = path.join(archiveDir, 'runs');
  let score = 0;
  if (fs.existsSync(path.join(archiveDir, 'archive.json'))) score += 10;
  if (fs.existsSync(path.join(archiveDir, 'source.csv'))) score += 5;
  score += dirEntryCount(runsDir) * 100;
  score += dirEntryCount(dirPath);
  return score;
}

function chooseResearchStoreDir() {
  // Các bản cũ lưu kho tại .runtime/research/research_store.
  // Một số bản mới hơn lỡ đổi sang .runtime/research nên UI nhìn thấy kho rỗng.
  // Chọn thư mục có dữ liệu thật nhiều hơn, và mặc định quay về đường dẫn cũ ổn định.
  const legacyDir = path.join(RUNTIME_ROOT, 'research', 'research_store');
  const flatDir = path.join(RUNTIME_ROOT, 'research');
  const legacyScore = researchStoreScore(legacyDir);
  const flatScore = researchStoreScore(flatDir);
  if (flatScore > legacyScore) return flatDir;
  return legacyDir;
}

const RESEARCH_STORE_DIR = chooseResearchStoreDir();
const CARE_STORE_DIR     = path.join(RUNTIME_ROOT, 'care_baseline');

const CONFIG_PATH = path.join(ROOT_DIR, 'config', 'config.json');

function intEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const PORT           = intEnv('PORT', 3001, { min: 1, max: 65535 });
// Mặc định chỉ lắng nghe localhost để tránh máy khác trong LAN gọi API khi chưa cấu hình bảo vệ.
// Nếu thật sự cần truy cập từ máy khác: đặt HOST=0.0.0.0 và nên đặt thêm EMR_APP_TOKEN.
const HOST           = String(process.env.HOST || process.env.BIND_HOST || '127.0.0.1').trim();
const PY_TIMEOUT_MS  = intEnv('PY_TIMEOUT_MS', 1800000, { min: 5000, max: 6 * 60 * 60 * 1000 });
const IS_DEV         = process.env.NODE_ENV !== 'production';
const APP_TOKEN      = String(process.env.EMR_APP_TOKEN || '').trim();
const APP_TOKEN_MIN_LENGTH = intEnv('EMR_APP_TOKEN_MIN_LENGTH', 16, { min: 8, max: 128 });
const ALLOW_INPUT_WITHOUT_PRECHECK = ['1', 'true', 'yes'].includes(String(process.env.EMR_ALLOW_INPUT_WITHOUT_PRECHECK || '').toLowerCase());

const SESSION_RETENTION_MODE = String(process.env.EMR_SESSION_RETENTION_MODE || 'disabled').trim().toLowerCase();
const SESSION_RETENTION_DAYS = intEnv('EMR_SESSION_RETENTION_DAYS', 30, { min: 1, max: 3650 });
const SESSION_MAX_AGE_MS = SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const SESSION_ARCHIVE_DIR = path.resolve(process.env.EMR_SESSION_ARCHIVE_DIR || path.join(RUNTIME_ROOT, 'session_archive'));
const ALLOW_PERMANENT_SESSION_DELETE = ['1', 'true', 'yes', 'on'].includes(String(process.env.EMR_ALLOW_PERMANENT_SESSION_DELETE || '').toLowerCase());
const ALLOW_IDENTIFIED_RESEARCH_EXPORT = ['1', 'true', 'yes', 'on'].includes(String(process.env.EMR_ALLOW_IDENTIFIED_RESEARCH_EXPORT || '').toLowerCase());
const ALLOW_PUBLIC_GOOGLE_SHEET = ['1', 'true', 'yes', 'on'].includes(String(process.env.EMR_ALLOW_PUBLIC_GOOGLE_SHEET || '').toLowerCase());

const DAY_KEYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'Default'];

// Danh sách mặc định — chỉ dùng khi config.json chưa có ds_dieu_duong.
// Tên thật được lưu trong config/config.json (ds_dieu_duong), không hardcode ở đây.
const DEFAULT_NURSE_LIST = [];

module.exports = {
  ROOT_DIR, DIST_DIR, PUBLIC_DIR, WORKER_DIR, CONFIG_DIR, RESEARCH_STORE_DIR, CARE_STORE_DIR,
  RUNTIME_ROOT, SESSIONS_DIR, CONFIG_PATH,
  PORT, HOST, PY_TIMEOUT_MS, IS_DEV, APP_TOKEN, APP_TOKEN_MIN_LENGTH, ALLOW_INPUT_WITHOUT_PRECHECK,
  SESSION_RETENTION_MODE, SESSION_RETENTION_DAYS, SESSION_MAX_AGE_MS, SESSION_ARCHIVE_DIR, ALLOW_PERMANENT_SESSION_DELETE,
  ALLOW_IDENTIFIED_RESEARCH_EXPORT, ALLOW_PUBLIC_GOOGLE_SHEET,
  DAY_KEYS, DEFAULT_NURSE_LIST,
};
