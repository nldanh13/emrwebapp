#!/usr/bin/env node
'use strict';

const path = require('path');
const { RUNTIME_ROOT } = require('../server/constants');
const patientDb = require('../server/services/patient_db');

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function main() {
  if (!patientDb.available()) throw new Error(patientDb.unavailableReason());
  const check = patientDb.integrityCheck();
  if (process.argv.includes('--check')) {
    console.log(check.ok ? 'Kho người bệnh: toàn vẹn.' : `Kho người bệnh có lỗi: ${check.messages.join('; ')}`);
    if (!check.ok) process.exitCode = 1;
    return;
  }
  const custom = String(process.env.EMR_PATIENT_DB_BACKUP_DIR || '').trim();
  const dir = custom ? path.resolve(custom) : path.join(RUNTIME_ROOT, 'backups', 'kho_benh_nhan');
  const dest = path.join(dir, `kho-${stamp()}.sqlite3`);
  const result = patientDb.backupTo(dest);
  console.log(`Đã sao lưu Kho người bệnh: ${result.path} (${result.size_bytes} byte).`);
}

try {
  main();
} catch (err) {
  console.error(`Không thể sao lưu Kho người bệnh: ${err.message}`);
  process.exitCode = 1;
} finally {
  patientDb.close();
}
