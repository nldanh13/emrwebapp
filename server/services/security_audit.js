// server/services/security_audit.js — Audit append-only toàn hệ thống, có chuỗi hash.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { RUNTIME_ROOT } = require('../constants');
const { ensureDir } = require('../utils/file');

const AUDIT_DIR = path.join(RUNTIME_ROOT, 'audit');
const lastHashByFile = new Map();

function monthKey(date = new Date()) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function auditPath(date = new Date()) {
  return path.join(AUDIT_DIR, `security_audit_${monthKey(date)}.jsonl`);
}

function readLastHash(file) {
  if (lastHashByFile.has(file)) return lastHashByFile.get(file);
  let hash = '';
  try {
    if (fs.existsSync(file)) {
      const data = fs.readFileSync(file, 'utf8').trimEnd();
      const lastLine = data.slice(Math.max(0, data.lastIndexOf('\n') + 1));
      if (lastLine) hash = String(JSON.parse(lastLine).event_hash || '');
    }
  } catch (err) {
    console.warn(`[SECURITY_AUDIT] Không đọc được hash cuối: ${String(err.message || err)}`);
  }
  lastHashByFile.set(file, hash);
  return hash;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function appendSecurityAudit(event) {
  try {
    ensureDir(AUDIT_DIR);
    const file = auditPath();
    const prevHash = readLastHash(file);
    const base = {
      at: new Date().toISOString(),
      version: 1,
      prev_hash: prevHash,
      ...event,
    };
    const eventHash = crypto.createHash('sha256').update(JSON.stringify(canonical(base))).digest('hex');
    const row = { ...base, event_hash: eventHash };
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' });
    try { fs.chmodSync(file, 0o600); } catch (_) {}
    lastHashByFile.set(file, eventHash);
    return row;
  } catch (err) {
    console.warn(`[SECURITY_AUDIT] Không ghi được audit: ${String(err.message || err)}`);
    return null;
  }
}

function verifyAuditFile(file) {
  const errors = [];
  let previous = '';
  const rows = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  lines.forEach((line, index) => {
    try {
      const row = JSON.parse(line);
      const claimed = String(row.event_hash || '');
      const base = { ...row };
      delete base.event_hash;
      const expected = crypto.createHash('sha256').update(JSON.stringify(canonical(base))).digest('hex');
      if (String(row.prev_hash || '') !== previous) errors.push({ line: index + 1, code: 'PREV_HASH_MISMATCH' });
      if (claimed !== expected) errors.push({ line: index + 1, code: 'EVENT_HASH_MISMATCH' });
      previous = claimed;
      rows.push(row);
    } catch (err) {
      errors.push({ line: index + 1, code: 'INVALID_JSON', message: String(err.message || err) });
    }
  });
  return { ok: errors.length === 0, rows: rows.length, errors, last_hash: previous };
}

module.exports = { appendSecurityAudit, verifyAuditFile, auditPath };
