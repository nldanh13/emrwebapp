#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const migrationsDir = path.join(root, 'database', 'migrations');
const databaseUrl = String(process.env.DATABASE_URL || '').trim();

if (!databaseUrl) {
  console.error('[db:migrate] Thiếu DATABASE_URL. Không có thay đổi nào được thực hiện.');
  process.exit(2);
}

const files = fs.readdirSync(migrationsDir).filter((name) => /^\d+.*\.sql$/i.test(name)).sort();
if (!files.length) {
  console.error('[db:migrate] Không tìm thấy migration SQL.');
  process.exit(3);
}

for (const name of files) {
  const fullPath = path.join(migrationsDir, name);
  console.log(`[db:migrate] Applying ${name}`);
  const result = spawnSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', fullPath], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, PGAPPNAME: 'emr-dashboard-migrator' },
  });
  if (result.error?.code === 'ENOENT') {
    console.error('[db:migrate] Không tìm thấy lệnh psql. Hãy cài PostgreSQL client.');
    process.exit(4);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('[db:migrate] Hoàn tất.');
