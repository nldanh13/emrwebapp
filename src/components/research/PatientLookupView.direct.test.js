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
  it('offers a patient-code action in the patient lookup UI', () => {
    const ui = source('src/components/research/PatientLookupView.jsx');
    expect(ui).toContain('Lấy trực tiếp từ EMR theo Mã BN');
    expect(ui).toContain("patientCode: code");
    expect(ui).toContain('Lấy ca này');
  });

  it('mounts the asynchronous collect-auto handler before the legacy research router', () => {
    const routes = source('server/routes/index.js');
    const asyncAt = routes.indexOf("require('./research_collection_async')");
    const legacyAt = routes.indexOf("require('./research')");
    expect(asyncAt).toBeGreaterThan(-1);
    expect(legacyAt).toBeGreaterThan(asyncAt);
  });

  it('acknowledges long collection requests immediately and keeps the scope lock until background completion', () => {
    const backend = source('server/routes/research_collection_async.js');
    expect(backend).toContain('res.status(202).json');
    expect(backend).toContain('const queued = enqueueHeavy');
    expect(backend).toContain('void queued.catch');
    expect(backend).toContain('RESEARCH_SCOPE_LOCKS.set');
    expect(backend).toContain(".finally(() =>");
    expect(backend).toContain('directPatientCode');
  });
});
