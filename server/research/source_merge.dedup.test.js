import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  aliasesIntersect,
  encounterIdentityAliases,
  combineEncounterSources,
} = require('./source_merge.js');

describe('research encounter anti-duplicate aliases', () => {
  it('recognizes the same stay through alternative strong aliases', () => {
    const left = {
      'Mã BN': 'BN001',
      'Mã điều trị': 'DT-123',
      'T/G vào': '08:00 01/10/2026',
    };
    const right = {
      'Mã BN': 'BN001',
      emr_treatment_id: 'DT-123',
      admission_date: '2026-10-01 08:00',
    };

    expect(aliasesIntersect(encounterIdentityAliases(left), encounterIdentityAliases(right))).toBe(true);
  });

  it('merges duplicate rows for one stay and keeps complementary data', () => {
    const rows = combineEncounterSources({
      initialRows: [{
        'Mã BN': 'BN001',
        'Mã điều trị': 'DT-123',
        'T/G vào': '08:00 01/10/2026',
        'Họ tên': 'Người bệnh A',
      }],
      hchanhProfileRows: [{
        'Mã BN': 'BN001',
        emr_treatment_id: 'DT-123',
        admission_date: '2026-10-01 08:00',
        address: 'Địa chỉ từ hồ sơ',
      }],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].address).toBe('Địa chỉ từ hồ sơ');
    expect(rows[0].__source_status).toContain('initial');
    expect(rows[0].__source_status).toContain('hchanh_profile');
  });

  it('collapses duplicate initial rows with the same patient and admission time', () => {
    const rows = combineEncounterSources({
      initialRows: [
        {
          'Mã BN': 'BN001',
          'T/G vào': '20:26 05/03/2026',
          'Chẩn đoán': 'Gãy xương',
        },
        {
          'Mã BN': 'BN001',
          'T/G vào': '20:26 05/03/2026',
          'Ngày ra viện': '13:00 09/03/2026',
          'Chẩn đoán': 'Gãy xương',
        },
      ],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]['Ngày ra viện']).toBe('13:00 09/03/2026');
  });

  it('collapses exact duplicate initial encounters instead of showing two visits', () => {
    const same = {
      'Mã BN': 'BN001',
      'T/G vào': '09:55 21/04/2026',
      'Ngày ra viện': '13:00 23/04/2026',
      'Chẩn đoán': 'Khám theo dõi sau điều trị gãy xương',
    };
    const rows = combineEncounterSources({ initialRows: [same, { ...same }] });
    expect(rows).toHaveLength(1);
  });

  it('does not merge separate admissions of the same patient just because research code is reused', () => {
    const rows = combineEncounterSources({
      initialRows: [
        {
          'Mã BN': 'BN001',
          'Mã NC': 'NC0001',
          'T/G vào': '08:00 01/09/2026',
          'Ngày ra viện': '05/09/2026',
        },
        {
          'Mã BN': 'BN001',
          'Mã NC': 'NC0001',
          'T/G vào': '09:00 01/10/2026',
          'Ngày ra viện': '05/10/2026',
        },
      ],
    });

    expect(rows).toHaveLength(2);
  });

  it('does not merge different patients when a legacy research code is duplicated', () => {
    const rows = combineEncounterSources({
      initialRows: [
        { 'Mã BN': 'BN001', 'Mã NC': 'NC0001', 'Họ tên': 'Người bệnh A' },
        { 'Mã BN': 'BN002', 'Mã NC': 'NC0001', 'Họ tên': 'Người bệnh B' },
      ],
    });

    expect(rows).toHaveLength(2);
    expect(rows.map(row => row['Mã BN']).sort()).toEqual(['BN001', 'BN002']);
  });

  it('does not merge same-time rows when strong treatment ids conflict', () => {
    const rows = combineEncounterSources({
      initialRows: [
        { 'Mã BN': 'BN001', 'Mã điều trị': 'DT-A', 'T/G vào': '08:00 01/10/2026' },
        { 'Mã BN': 'BN001', 'Mã điều trị': 'DT-B', 'T/G vào': '08:00 01/10/2026' },
      ],
    });
    expect(rows).toHaveLength(2);
  });

  it('does not use patient code alone as a duplicate key', () => {
    const first = encounterIdentityAliases({ 'Mã BN': 'BN001', 'T/G vào': '01/09/2026' });
    const second = encounterIdentityAliases({ 'Mã BN': 'BN001', 'T/G vào': '01/10/2026' });
    expect(aliasesIntersect(first, second)).toBe(false);
  });
});
