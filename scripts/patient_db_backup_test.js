#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'emr-patient-backup-'));
process.env.EMR_RUNTIME_ROOT = path.join(root, 'runtime');
process.env.EMR_PATIENT_DB_PATH = path.join(root, 'source', 'kho.sqlite3');

const patientDb = require('../server/services/patient_db');

try {
  patientDb.recordClinicVisit({
    khambenhid: 'BACKUP1', ma_bn: 'BN-BACKUP', ho_ten: 'Dữ liệu kiểm thử',
    thoi_gian: '08:00 28/09/2026', stage: 'xong', services: [],
  }, { now: '2026-09-28T08:10:00Z' });
  assert.deepStrictEqual(patientDb.integrityCheck(), { ok: true, messages: ['ok'] });

  const dest = path.join(root, 'backup', 'kho.sqlite3');
  const result = patientDb.backupTo(dest);
  assert.strictEqual(result.ok, true);
  assert.ok(fs.statSync(dest).size > 0);

  const { DatabaseSync } = require('node:sqlite');
  const copy = new DatabaseSync(dest, { readOnly: true });
  assert.strictEqual(Number(copy.prepare('SELECT COUNT(*) n FROM benh_nhan').get().n), 1);
  assert.strictEqual(copy.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  copy.close();
  console.log('patient_db_backup_test: pass');
} finally {
  patientDb.close();
  fs.rmSync(root, { recursive: true, force: true });
}
