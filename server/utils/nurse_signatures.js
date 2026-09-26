// server/utils/nurse_signatures.js — Ảnh chữ ký riêng theo TÊN điều dưỡng/bác sĩ.
//
// Dùng để tự động chèn chữ ký vào bộ phiếu "IN RA VIỆN" (xem
// worker/sign_discharge_bundle.py) — người chưa cấu hình ảnh chữ ký thì giữ
// nguyên, không đụng tới. File ảnh lưu ở config/signatures/, con trỏ
// "signature_file" lưu chung trong secrets/nurse_emr_accounts.json (cùng
// file với tài khoản EMR theo điều dưỡng — xem nurse_emr_accounts.js) để
// không phải quản lý 2 nơi.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROOT_DIR } = require('../constants');
const { ensureDir, safeFilePart } = require('./file');
const { readNurseEmrAccounts, writeNurseEmrAccounts } = require('./nurse_emr_accounts');

const DEFAULT_SIGNATURES_DIR = path.join(ROOT_DIR, 'config', 'signatures');
const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024; // 2MB — chữ ký chỉ là 1 ảnh nhỏ.

// Cho phép override đường dẫn khi test (giống EMR_NURSE_ACCOUNTS_FILE ở
// nurse_emr_accounts.js) — đọc lại mỗi lần gọi, không cache ở module scope.
function signaturesDirPath() {
  const configured = String(process.env.EMR_NURSE_SIGNATURES_DIR || '').trim();
  if (!configured) return DEFAULT_SIGNATURES_DIR;
  return path.isAbsolute(configured) ? configured : path.join(ROOT_DIR, configured);
}

function extForMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m === 'jpeg' || m === 'jpg') return '.jpg';
  return '.png';
}

function mimeForExt(ext) {
  return String(ext || '').toLowerCase() === '.jpg' || String(ext).toLowerCase() === '.jpeg'
    ? 'image/jpeg'
    : 'image/png';
}

function unlinkSignatureFile(fileName) {
  if (!fileName) return;
  try { fs.unlinkSync(path.join(signaturesDirPath(), path.basename(fileName))); } catch (_) {}
}

/** Lưu ảnh chữ ký cho 1 người (data URL base64) — ghi đè ảnh cũ nếu có, cập
 * nhật/tạo dòng tương ứng trong nurse_emr_accounts.json. Trả về danh sách
 * accounts đã lưu. */
function saveSignatureImage(name, dataUrl) {
  const nameTrim = String(name || '').trim();
  if (!nameTrim) throw new Error('Thiếu tên điều dưỡng/bác sĩ.');
  const match = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(String(dataUrl || '').trim());
  if (!match) throw new Error('Ảnh chữ ký phải là PNG hoặc JPEG.');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) throw new Error('Ảnh chữ ký rỗng.');
  if (buffer.length > MAX_SIGNATURE_BYTES) throw new Error('Ảnh chữ ký quá lớn (tối đa 2MB).');

  ensureDir(signaturesDirPath());
  const ext = extForMime(match[1]);
  const fileName = `${safeFilePart(nameTrim).toLowerCase()}_${crypto.randomBytes(4).toString('hex')}${ext}`;

  const rows = readNurseEmrAccounts();
  const existing = rows.find(r => r.name === nameTrim);
  fs.writeFileSync(path.join(signaturesDirPath(), fileName), buffer);
  if (existing?.signature_file) unlinkSignatureFile(existing.signature_file);

  const nextRows = existing
    ? rows.map(r => (r.name === nameTrim ? { ...r, signature_file: fileName } : r))
    : [...rows, { name: nameTrim, emr_username: '', emr_password: '', signature_file: fileName }];
  return writeNurseEmrAccounts(nextRows);
}

/** Xóa ảnh chữ ký đã cấu hình cho 1 người (không xóa tài khoản EMR của họ
 * nếu có). Trả về danh sách accounts đã lưu. */
function removeSignatureImage(name) {
  const nameTrim = String(name || '').trim();
  const rows = readNurseEmrAccounts();
  const existing = rows.find(r => r.name === nameTrim);
  if (existing?.signature_file) unlinkSignatureFile(existing.signature_file);
  const nextRows = rows.map(r => {
    if (r.name !== nameTrim) return r;
    const { signature_file, ...rest } = r;
    return rest;
  });
  return writeNurseEmrAccounts(nextRows);
}

/** Đọc ảnh chữ ký đã lưu, trả data URL base64 (null nếu không có/không đọc được). */
function readSignatureDataUrl(fileName) {
  const safe = path.basename(String(fileName || '').trim());
  if (!safe) return null;
  const filePath = path.join(signaturesDirPath(), safe);
  if (!fs.existsSync(filePath)) return null;
  try {
    const buffer = fs.readFileSync(filePath);
    return `data:${mimeForExt(path.extname(safe))};base64,${buffer.toString('base64')}`;
  } catch (_) {
    return null;
  }
}

/** Gắn signature_data_url (nếu có) vào từng dòng account để trả về client. */
function withSignatureDataUrls(accounts) {
  return (accounts || []).map(row => ({
    ...row,
    signature_data_url: row.signature_file ? readSignatureDataUrl(row.signature_file) : null,
  }));
}

module.exports = {
  signaturesDirPath,
  saveSignatureImage,
  removeSignatureImage,
  readSignatureDataUrl,
  withSignatureDataUrls,
};
