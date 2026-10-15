import { describe, expect, it } from 'vitest';
import { hospitalDrugReference, findHospitalDrugStatus, referenceMedicationDraft, searchHospitalDrugs } from './hospitalDrugReference.js';

const rows = hospitalDrugReference.medications;

describe('Hospital medication Select2 reference snapshot', () => {
  it('deduplicates the uploaded rows by exact source code without discarding different strengths', () => {
    expect(hospitalDrugReference.rows_in_source).toBe(252);
    expect(hospitalDrugReference.duplicate_rows_omitted).toBe(67);
    expect(rows).toHaveLength(185);
    expect(new Set(rows.map(r => r.code)).size).toBe(185);
    expect(rows.filter(r => r.name === 'Truxima').map(r => r.strength).sort())
      .toEqual(['100mg/ 10ml', '500mg/ 50ml']);
    expect(rows.filter(r => r.name === 'Natri clorid 0,9%')).toHaveLength(2);
  });

  it('preserves Nefopam ampoule and powder antibiotic label exactly as source', () => {
    const nefopam = rows.find(r => r.code === '26.328.726');
    const powder = rows.find(r => r.code === '26.328.357');
    expect(nefopam).toMatchObject({ name: 'NEFOPAM MEDISOL 20MG/2ML',
      strength: '20mg/2ml', unit: 'Ống', route_label: 'Tiêm' });
    expect(powder).toMatchObject({ name: 'Mizapenem 0,5g', strength: '0,5g', unit: 'Lọ' });
    for (const row of [nefopam, powder]) {
      const draft = referenceMedicationDraft(row);
      expect(draft.hospital_code).toBe(row.code);
      expect(draft.preparation.strength).toBe(row.strength);
      expect(draft.preparation.original_volume_ml).toBe('');
      expect(draft.preparation.reconstitution_volume_ml).toBe('');
      expect(draft.default_volume_ml).toBe('');
      expect(draft.default_rate).toBe('');
      expect(draft.default_route).toBe('');
      expect(draft.routes).toEqual([]);
      expect(draft.dilution).toBeNull();
      expect(draft.active_ingredients).toEqual([]);
    }
  });

  it('does not merge same-name different-code medicines or overwrite existing catalogs', () => {
    const truximas = rows.filter(r => r.name === 'Truxima');
    const medications = [{ canonical: 'Truxima', hospital_code: truximas[0].code }];
    expect(findHospitalDrugStatus(truximas[0], medications).state).toBe('linked');
    expect(findHospitalDrugStatus(truximas[1], medications).state).toBe('same_name');
    expect(findHospitalDrugStatus(rows.find(r => r.code === '26.328.726'), medications).state).toBe('missing');
    expect(medications).toEqual([{ canonical: 'Truxima', hospital_code: truximas[0].code }]);
  });

  it('searches names, source codes and active ingredient labels only in the read-only snapshot', () => {
    expect(searchHospitalDrugs(rows, '26.328.726').map(r => r.name)).toEqual(['NEFOPAM MEDISOL 20MG/2ML']);
    expect(searchHospitalDrugs(rows, 'Mizapenem 0,5g')).toHaveLength(1);
    expect(searchHospitalDrugs(rows, 'Nefopam Hydroclorid')).toHaveLength(1);
  });
});
