import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { buildCollectionIntegrityReport } = require('./collection_integrity.js');

function tempRun() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'research-integrity-'));
}

describe('research collection integrity', () => {
  it('does not treat ok + zero surgery rows as verified absence', () => {
    const dir = tempRun();
    fs.writeFileSync(path.join(dir, 'hchanh_auto_progress.json'), JSON.stringify({
      case1: { file_status: { surgery: { fetch_status: 'ok', rows: 0 } } },
    }), 'utf8');
    const report = buildCollectionIntegrityReport(dir, { phase: 'test' });
    expect(report.surgery_progress.ok_zero_unverified).toBe(1);
    expect(report.warnings.some(x => x.code === 'SURGERY_ZERO_UNVERIFIED')).toBe(true);
  });

  it('blocks incomplete surgery collection errors', () => {
    const dir = tempRun();
    fs.writeFileSync(path.join(dir, 'hchanh_auto_progress.json'), JSON.stringify({
      case1: { file_status: { surgery: { fetch_status: 'error', rows: 0 } } },
    }), 'utf8');
    const report = buildCollectionIntegrityReport(dir, { phase: 'test' });
    expect(report.ready_for_analysis).toBe(false);
    expect(report.blocking.some(x => x.code === 'SURGERY_COLLECTION_INCOMPLETE')).toBe(true);
  });

  it('blocks invalid Raw JSON instead of silently losing provenance', () => {
    const dir = tempRun();
    fs.writeFileSync(path.join(dir, 'hchanh_surgery.csv'), 'Mã BN,Ngày phẫu thuật,Raw JSON\nX,01/01/2026 08:00,"{bad}"\n', 'utf8');
    const report = buildCollectionIntegrityReport(dir, { phase: 'test' });
    expect(report.raw_surgery.invalid_raw_json).toBe(1);
    expect(report.ready_for_analysis).toBe(false);
  });
});
