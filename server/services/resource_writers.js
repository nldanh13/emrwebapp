// server/services/resource_writers.js — Ai lưu dữ liệu dùng chung lần cuối.
//
// Khi hai người cùng sửa một dữ liệu (xếp phòng, lịch, bản nháp VTYT...) và người sau bị chặn vì
// đang cầm bản cũ, thông báo phải nói được ai vừa lưu và lúc nào, thay vì chỉ "thiết bị khác".
// Chỉ lưu tên hiển thị và thời điểm; không lưu nội dung.

'use strict';

const path = require('path');

const { RUNTIME_ROOT } = require('../constants');
const { readJsonSafe, writeJsonAtomic } = require('../utils/file');

const MAX_ENTRIES = 500;
let cache = null;

function storePath() {
  return path.join(RUNTIME_ROOT, 'state', 'resource_writers.json');
}

function load() {
  if (!cache) {
    const raw = readJsonSafe(storePath(), {});
    cache = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  }
  return cache;
}

function writerName(principal) {
  return String(principal?.name || principal?.id || '').trim().slice(0, 80);
}

function recordWriter(sid, resource, principal, at = new Date().toISOString()) {
  const store = load();
  const key = `${sid || 'default'}:${resource}`;
  store[key] = { name: writerName(principal), id: String(principal?.id || '').slice(0, 80), at };
  const keys = Object.keys(store);
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => String(store[a].at).localeCompare(String(store[b].at)));
    for (const old of keys.slice(0, keys.length - MAX_ENTRIES)) delete store[old];
  }
  try { writeJsonAtomic(storePath(), store); } catch (_) { /* chỉ để hiển thị; không chặn việc lưu */ }
  return store[key];
}

function getWriter(sid, resource) {
  return load()[`${sid || 'default'}:${resource}`] || null;
}

function timeLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const opts = { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', hour12: false };
  try {
    return d.toLocaleString('vi-VN', { ...opts, timeZone: 'Asia/Ho_Chi_Minh' });
  } catch (_) {
    return d.toLocaleString('vi-VN', opts);
  }
}

/** "Nguyễn A lưu lúc 14:05 09/10" — rỗng nếu không biết ai. */
function describeWriter(writer) {
  if (!writer?.at) return '';
  const who = writer.name || 'Một người dùng khác';
  const when = timeLabel(writer.at);
  return when ? `${who} lưu lúc ${when}` : `${who} vừa lưu`;
}

function resetForTests() { cache = null; }

module.exports = { recordWriter, getWriter, describeWriter, writerName, resetForTests };
