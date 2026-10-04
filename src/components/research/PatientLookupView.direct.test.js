import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

function source(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

describe('direct patient Research Store collection', () => {
  it('accepts one or many patient codes in the patient lookup UI', () => {
    const ui = source('src/components/research/PatientLookupView.jsx');
    expect(ui).toContain('Lấy trực tiếp từ EMR theo Mã BN');
    expect(ui).toContain('<textarea');
    expect(ui).toContain('patientCodes: codes');
    expect(ui).toContain('Lấy ${parsedDirectCodes.length} ca này');
    expect(ui).toContain('Ctrl+Enter để gửi');
  });

  it('mounts batch collection before single-patient async collection and the legacy research router', () => {
    const routes = source('server/routes/index.js');
    const batchAt = routes.indexOf("require('./research_collection_batch')");
    const asyncAt = routes.indexOf("require('./research_collection_async')");
    const legacyAt = routes.indexOf("require('./research')");
    expect(batchAt).toBeGreaterThan(-1);
    expect(asyncAt).toBeGreaterThan(batchAt);
    expect(legacyAt).toBeGreaterThan(asyncAt);
  });

  it('acknowledges long single-patient collection requests immediately and keeps the scope lock until background completion', () => {
    const backend = source('server/routes/research_collection_async.js');
    expect(backend).toContain('res.status(202).json');
    expect(backend).toContain('const queued = enqueueHeavy');
    expect(backend).toContain('void queued.catch');
    expect(backend).toContain('RESEARCH_SCOPE_LOCKS.set');
    expect(backend).toContain(".finally(() =>");
    expect(backend).toContain('directPatientCode');
  });

  it('runs pasted patient codes sequentially, counts case errors, and queues one background normalize after the batch', () => {
    const backend = source('server/routes/research_collection_batch.js');
    expect(backend).toContain('MAX_BATCH_PATIENTS = 200');
    expect(backend).toContain('for (let index = 0; index < cases.length; index += 1)');
    expect(backend).toContain('await runDirectPatientNoFinalize');
    expect(backend).toContain("one case failed");
    // Chuẩn hóa một lần sau cả lô, chạy nền ở tiến trình riêng (không chặn máy chủ).
    expect(backend).toContain('scheduleNormalizeAfterCollection({');
    expect(backend).not.toContain('normalizeRunOutputs(');
    // Ca có bước lấy dữ liệu báo lỗi (không ném lỗi) vẫn được tính là lỗi.
    expect(backend).toContain('caseErrorsFromResults(one?.results)');
    expect(backend).toContain('Ca ${index + 1}/${cases.length}: ${step}');
    expect(backend).toContain("taskType: 'research_collect_patient_batch'");
    expect(backend).toContain('isCancelRequested(ctx.sid)');
  });
});
