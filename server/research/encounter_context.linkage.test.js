import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildEncounterId,
  buildContextMap,
  contextForRow,
} = require('./encounter_context.js');

describe('research encounter linkage safety', () => {
  it('keeps encounter id stable when discharge date appears later', () => {
    const openStay = {
      'Mã BN': 'BN001',
      'T/G vào': '20:26 05/03/2026',
    };
    const completedStay = {
      'Mã BN': 'BN001',
      'T/G vào': '20:26 05/03/2026',
      'Ngày ra viện': '13:00 09/03/2026',
    };

    expect(buildEncounterId(openStay)).toBe(buildEncounterId(completedStay));
  });

  it('does not create the same encounter id for different patients sharing a research code', () => {
    const a = { 'Mã BN': 'BN001', 'Mã NC': 'NC0001' };
    const b = { 'Mã BN': 'BN002', 'Mã NC': 'NC0001' };
    expect(buildEncounterId(a)).not.toBe(buildEncounterId(b));
  });

  it('scopes research-code matching to the same patient code', () => {
    const ctxMap = buildContextMap([
      { 'Mã BN': 'BN001', 'Mã NC': 'NC0001', 'T/G vào': '08:00 01/09/2026' },
      { 'Mã BN': 'BN002', 'Mã NC': 'NC0001', 'T/G vào': '09:00 02/09/2026' },
    ]);

    const matched = contextForRow(ctxMap, { 'Mã BN': 'BN002', 'Mã NC': 'NC0001' }, 'BN002');
    expect(matched.patient_code).toBe('BN002');
    expect(matched._encounter_match_method).toBe('research_code_patient_scoped');
  });

  it('rejects a foreign encounter id even if it is otherwise unique', () => {
    const rows = [
      { 'Mã BN': 'BN001', encounter_id: 'enc-shared', 'T/G vào': '08:00 01/09/2026' },
      { 'Mã BN': 'BN002', 'T/G vào': '09:00 02/09/2026' },
    ];
    const ctxMap = buildContextMap(rows);
    const matched = contextForRow(ctxMap, { 'Mã BN': 'BN002', encounter_id: 'enc-shared' }, 'BN002');
    expect(matched.patient_code).toBe('BN002');
    expect(matched._encounter_match_method).not.toBe('encounter_id');
  });
});
