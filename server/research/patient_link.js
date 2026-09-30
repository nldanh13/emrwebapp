'use strict';

// Bảng liên kết Mã BN ↔ mã người bệnh giả danh (patient_key) của một kho nghiên cứu.
//
// - Mỗi kho (kho gốc / từng nghiên cứu) có một file patient_link.csv ở thư mục kho, KHÔNG
//   nằm trong run hay dataset. Đây là nơi duy nhất nối patient_key về Mã BN.
// - patient_key cấp tuần tự (P000001, P000002...) khi gặp Mã BN lần đầu và giữ nguyên
//   qua các lần Chuẩn hóa, nên dataset xuất ở các thời điểm khác nhau vẫn nối được.
// - Mã tuần tự không chứa thông tin gì về Mã BN; không có file liên kết thì không suy
//   ngược được (khác với băm Mã BN, vốn dò lại được vì Mã BN chỉ có vài chục triệu giá trị).

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('../utils/file');
const { rowsToCsvRaw } = require('../utils/csv');
const { readCsvFileRows } = require('./csv_reader');

const PATIENT_LINK_FILE = 'patient_link.csv';
const PATIENT_LINK_COLUMNS = ['patient_code', 'patient_key', 'first_seen_at'];
const KEY_RE = /^P(\d{6,})$/;

// Thư mục kho của một run: <kho>/runs/<run> → <kho>. Run nằm ngoài cấu trúc này (test,
// thư mục tạm) thì dùng chính thư mục run.
function patientLinkDirForRun(runDir) {
  const parent = path.dirname(path.resolve(runDir));
  return path.basename(parent) === 'runs' ? path.dirname(parent) : path.resolve(runDir);
}

function patientLinkPath(runDir) {
  return path.join(patientLinkDirForRun(runDir), PATIENT_LINK_FILE);
}

function normalizeCode(value) {
  return String(value ?? '').trim();
}

function loadPatientLink(filePath) {
  const byCode = new Map();
  let maxSeq = 0;
  if (fs.existsSync(filePath)) {
    readCsvFileRows(filePath, Number.MAX_SAFE_INTEGER, {
      onRow(row) {
        const code = normalizeCode(row.patient_code);
        const key = normalizeCode(row.patient_key);
        const m = KEY_RE.exec(key);
        if (!code || !m || byCode.has(code)) return;
        byCode.set(code, { patient_code: code, patient_key: key, first_seen_at: normalizeCode(row.first_seen_at) });
        maxSeq = Math.max(maxSeq, Number(m[1]));
      },
    });
  }
  return { filePath, byCode, maxSeq, added: 0 };
}

function keyFor(link, code, now = new Date().toISOString()) {
  const c = normalizeCode(code);
  if (!c) return '';
  const hit = link.byCode.get(c);
  if (hit) return hit.patient_key;
  link.maxSeq += 1;
  const entry = { patient_code: c, patient_key: `P${String(link.maxSeq).padStart(6, '0')}`, first_seen_at: now };
  link.byCode.set(c, entry);
  link.added += 1;
  return entry.patient_key;
}

// Gắn patient_key cho mọi dòng có patient_code (sửa trực tiếp các object).
function applyPatientKeys(link, rows, now = new Date().toISOString()) {
  for (const row of rows || []) {
    if (!row || typeof row !== 'object') continue;
    row.patient_key = keyFor(link, row.patient_code, now);
  }
  return rows;
}

function savePatientLink(link) {
  if (!link.added && fs.existsSync(link.filePath)) return false;
  fs.mkdirSync(path.dirname(link.filePath), { recursive: true });
  const rows = [...link.byCode.values()].sort((a, b) => a.patient_key.localeCompare(b.patient_key));
  writeFileAtomic(link.filePath, `﻿${rowsToCsvRaw(PATIENT_LINK_COLUMNS, rows)}`, 'utf-8');
  try { fs.chmodSync(link.filePath, 0o600); } catch (_) { /* Windows: theo quyền thư mục */ }
  link.added = 0;
  return true;
}

module.exports = {
  PATIENT_LINK_FILE,
  PATIENT_LINK_COLUMNS,
  patientLinkDirForRun,
  patientLinkPath,
  loadPatientLink,
  applyPatientKeys,
  keyFor,
  savePatientLink,
};
