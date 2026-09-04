// server/services/activity_logger.js — Ghi audit vận hành theo session, đã giảm dữ liệu định danh.

'use strict';

const crypto = require('crypto');
const fs   = require('fs');
const path = require('path');

const { APP_TOKEN } = require('../constants');
const { ensureDir } = require('../utils/file');
const { getRuntimePaths } = require('./session');
const { appendSecurityAudit } = require('./security_audit');

const MAX_STRING_LEN = 180;
const MAX_KEYS       = 30;
const MAX_SAMPLE     = 3;
const VERBOSE_CLIENT_AUDIT = ['1', 'true', 'yes', 'on'].includes(String(process.env.EMR_VERBOSE_CLIENT_AUDIT || '').toLowerCase());
const LOG_SALT = String(process.env.EMR_LOG_HASH_SALT || APP_TOKEN || crypto.randomBytes(32).toString('hex'));

const SECRET_KEY_RE = /password|passwd|pass|token|ott|secret|cookie|authorization|credential|api[_-]?key|mat_khau|mật khẩu/i;
const PATIENT_ID_KEY_RE = /^(?:id|ma_bn|mabn|ma_yt|patient_?id|medical_?code|so_benh_an|so_vao_vien|storage_(?:key|number|full_key)|case_key)$/i;
const PATIENT_NAME_KEY_RE = /^(?:ho_ten|ten_bn|ten_benh_nhan|patient_name|patient_name_normalized|full_name)$/i;
const CONTACT_KEY_RE = /phone|dien_thoai|điện thoại|email|address|dia_chi|địa chỉ|cccd|cmnd/i;

function pad2(n) { return String(n).padStart(2, '0'); }
function dateKey(d = new Date()) { return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`; }
function timeStamp(d = new Date()) { return d.toISOString(); }

function pseudonymize(value, prefix = 'subject') {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const digest = crypto.createHmac('sha256', LOG_SALT).update(raw).digest('hex').slice(0, 12);
  return `${prefix}_${digest}`;
}

function redactLogText(value) {
  return String(value ?? '')
    .replace(/([?&](token|ott|password|pass|secret)=)[^&\s]+/gi, '$1[hidden]')
    .replace(/\b(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[hidden]')
    .replace(/\b((?:password|pass|mat_khau|mật khẩu|token|secret|cookie|set-cookie)\s*[:=]\s*)[^,;\s]+/gi, '$1[hidden]')
    .replace(/\b((?:ma_bn|mabn|mã\s*bn|mã\s*yt|patient[_-]?id|BN)\s*[:=]\s*)[a-z0-9_.-]+/gi, (_m, lead, id) => `${lead}${pseudonymize(id, 'patient')}`)
    .replace(/\b((?:họ\s*tên|ho_ten|patient_name)\s*[:=]\s*)[^|,;]+/gi, '$1[redacted]');
}

function truncate(value, max = MAX_STRING_LEN) {
  const s = redactLogText(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function safeValueForKey(key, value) {
  const cleanKey = String(key || '');
  if (SECRET_KEY_RE.test(cleanKey)) return '[hidden]';
  if (PATIENT_ID_KEY_RE.test(cleanKey)) return pseudonymize(value, 'patient');
  if (PATIENT_NAME_KEY_RE.test(cleanKey) || CONTACT_KEY_RE.test(cleanKey)) return '[redacted]';
  if (value == null) return value;
  if (typeof value === 'string') return truncate(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return truncate(JSON.stringify(value));
}

function sanitizeQuery(query = {}) {
  const out = {};
  for (const [key, value] of Object.entries(query || {})) out[key] = safeValueForKey(key, value);
  return out;
}

function summarizeRecord(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return safeValueForKey('', row);
  const out = {};
  const preferred = [
    'id', 'ma_bn', 'patientId', 'patient_id', 'Mã BN', 'Mã YT',
    'so_phong', 'room', 'Vi_Tri', 'phong_giuong',
    'ngay_lam', 'date', 'dateFrom', 'dateTo', 'scope', 'partial',
  ];
  for (const key of preferred) {
    if (Object.prototype.hasOwnProperty.call(row, key) && row[key] !== undefined && row[key] !== '') {
      const normalizedKey = /^(?:patientId|Mã BN|Mã YT)$/i.test(key) ? 'patient_id' : key;
      out[normalizedKey] = safeValueForKey(normalizedKey, row[key]);
    }
  }
  const keys = Object.keys(row).filter(key => !SECRET_KEY_RE.test(key));
  out._keys = keys.slice(0, MAX_KEYS);
  if (keys.length > MAX_KEYS) out._more_keys = keys.length - MAX_KEYS;
  return out;
}

function summarizeBody(body) {
  if (body == null) return null;
  if (Array.isArray(body)) return { type: 'array', count: body.length, sample: body.slice(0, MAX_SAMPLE).map(summarizeRecord) };
  if (typeof body !== 'object') return safeValueForKey('', body);

  const keys = Object.keys(body).filter(key => !SECRET_KEY_RE.test(key));
  const out = { type: 'object', keys: keys.slice(0, MAX_KEYS) };
  if (keys.length > MAX_KEYS) out.more_keys = keys.length - MAX_KEYS;

  for (const key of ['targets', 'rows', 'patients', 'bundle', 'patient']) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const value = body[key];
    if (Array.isArray(value)) out[key] = { type: 'array', count: value.length, sample: value.slice(0, MAX_SAMPLE).map(summarizeRecord) };
    else if (value && typeof value === 'object') out[key] = summarizeRecord(value);
    else out[key] = safeValueForKey(key, value);
  }

  for (const key of ['date', 'date_from', 'date_to', 'dateFrom', 'dateTo', 'rooms', 'scope', 'partial']) {
    if (Object.prototype.hasOwnProperty.call(body, key)) out[key] = safeValueForKey(key, body[key]);
  }
  return out;
}

function sanitizeClientEvent(event) {
  if (!event || typeof event !== 'object') return { value: safeValueForKey('', event) };
  const out = {};
  const safeKeys = ['kind', 'at', 'tab', 'path', 'tag', 'action', 'disabled', 'type', 'role'];
  const verboseKeys = ['label', 'id', 'name', 'title', 'href', 'details'];
  for (const key of [...safeKeys, ...(VERBOSE_CLIENT_AUDIT ? verboseKeys : [])]) {
    if (!Object.prototype.hasOwnProperty.call(event, key)) continue;
    const value = event[key];
    if (key === 'details' && value && typeof value === 'object') out.details = summarizeBody(value);
    else if (key === 'href') out.href = truncate(value || '');
    else out[key] = safeValueForKey(key, value);
  }
  if (!VERBOSE_CLIENT_AUDIT && (event.label || event.title || event.details)) out.details_redacted = true;
  return out;
}

function activityPaths(ctx) {
  const key = dateKey();
  return {
    jsonl: path.join(ctx.LOGS_DIR, `activity_${key}.jsonl`),
    text:  path.join(ctx.LOGS_DIR, `activity_${key}.log`),
  };
}

function formatTextLine(entry) {
  const parts = [`[${entry.at}]`, `[${entry.sid || 'default'}]`, entry.kind || entry.type || 'activity'];
  if (entry.actor?.id) parts.push(`actor=${entry.actor.id}`);
  if (entry.method || entry.path) parts.push(`${entry.method || ''} ${entry.path || ''}`.trim());
  if (entry.status) parts.push(`status=${entry.status}`);
  if (entry.duration_ms != null) parts.push(`${entry.duration_ms}ms`);
  if (entry.label) parts.push(`label="${truncate(entry.label, 120)}"`);
  if (entry.tab) parts.push(`tab=${entry.tab}`);
  if (entry.message) parts.push(`message="${truncate(entry.message, 160)}"`);
  if (entry.error) parts.push(`error="${truncate(entry.error, 160)}"`);
  const detail = entry.summary || entry.query || entry.details || null;
  if (detail) parts.push(`data=${truncate(JSON.stringify(detail), 600)}`);
  return parts.join(' | ');
}

function deepSanitize(value, key = '', depth = 0) {
  if (depth > 8) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 100).map(item => deepSanitize(item, key, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [childKey, child] of Object.entries(value)) out[childKey] = deepSanitize(child, childKey, depth + 1);
    return out;
  }
  return safeValueForKey(key, value);
}

function appendActivity(ctx, entry) {
  try {
    ensureDir(ctx.LOGS_DIR);
    const paths = activityPaths(ctx);
    const clean = deepSanitize({ at: timeStamp(), sid: ctx.sid || 'default', ...entry });
    fs.appendFileSync(paths.jsonl, JSON.stringify(clean) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'a' });
    fs.appendFileSync(paths.text, formatTextLine(clean) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'a' });
    try { fs.chmodSync(paths.jsonl, 0o600); fs.chmodSync(paths.text, 0o600); } catch (_) {}
  } catch (err) {
    console.warn('[ACTIVITY_LOG] Không ghi được log:', String(err.message || err));
  }
}

function logClientEvents(req, events) {
  const ctx = getRuntimePaths(req);
  const arr = Array.isArray(events) ? events : [events];
  for (const event of arr.slice(0, 50)) appendActivity(ctx, { kind: 'ui.event', actor: req.auth, ...sanitizeClientEvent(event) });
  return { count: Math.min(arr.length, 50) };
}

function requestAuditMiddleware(req, res, next) {
  if (req.path === '/client-log') return next();
  const started = Date.now();
  let ctx;
  try { ctx = getRuntimePaths(req); } catch (_) { ctx = null; }

  res.on('finish', () => {
    if (!ctx) return;
    const entry = {
      kind: 'api.request',
      actor: req.auth ? { id: req.auth.id, role: req.auth.role, auth_type: req.auth.auth_type } : null,
      method: req.method,
      path: req.path,
      query: sanitizeQuery(req.query),
      status: res.statusCode,
      duration_ms: Date.now() - started,
      summary: summarizeBody(req.body),
    };
    appendActivity(ctx, entry);

    const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || '').toUpperCase());
    const isSensitiveRead = /(?:export|session-logs|diagnostics|research)/.test(String(req.path || ''));
    if (isMutation || isSensitiveRead || res.statusCode >= 400) {
      appendSecurityAudit({
        kind: 'api.request',
        actor: entry.actor,
        sid: ctx.sid || 'default',
        method: entry.method,
        path: entry.path,
        status: entry.status,
        duration_ms: entry.duration_ms,
        query: entry.query,
        summary: entry.summary,
      });
    }
  });
  next();
}

function readLatestActivity(ctx, maxLines = 200) {
  const files = [];
  try {
    if (fs.existsSync(ctx.LOGS_DIR)) {
      for (const file of fs.readdirSync(ctx.LOGS_DIR)) {
        if (/^activity_\d{8}\.log$/i.test(file)) {
          const p = path.join(ctx.LOGS_DIR, file);
          const st = fs.statSync(p);
          files.push({ path: p, name: file, mtime: st.mtimeMs });
        }
      }
    }
  } catch (_) {}
  files.sort((a, b) => b.mtime - a.mtime);
  const lines = [];
  for (const file of files.slice(0, 5)) {
    try {
      const chunk = fs.readFileSync(file.path, 'utf8').split('\n').filter(Boolean);
      lines.unshift(...chunk.slice(-maxLines));
    } catch (_) {}
  }
  return redactLogText(lines.slice(-maxLines).join('\n'));
}

module.exports = {
  appendActivity,
  logClientEvents,
  requestAuditMiddleware,
  readLatestActivity,
  summarizeBody,
  redactLogText,
  pseudonymize,
};
