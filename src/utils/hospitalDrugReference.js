// Hospital EMR snapshot is a read-only lookup table. It must never implicitly
// set administration route, diluent, infusion volume/rate, or clinical dose.
import reference from '../../config/hospital_drug_reference.json';

export const hospitalDrugReference = reference;

export function findHospitalDrugStatus(row, medications = []) {
  const code = String(row?.code || '').trim();
  const byCode = medications.find(m => String(m?.hospital_code || '').trim() === code);
  if (byCode) return { state: 'linked', medication: byCode };
  const name = String(row?.name || '').trim().toLocaleLowerCase('vi-VN');
  const byName = medications.find(m =>
    String(m?.canonical || '').trim().toLocaleLowerCase('vi-VN') === name);
  if (byName) return { state: 'same_name', medication: byName };
  return { state: 'missing', medication: null };
}

export function referenceMedicationDraft(row) {
  // Longer strength fields are often full chemical compositions and need manual
  // review. Never silently truncate a clinical strength/composition.
  const strength = String(row?.strength || '').trim();
  return {
    canonical: row.name,
    hospital_code: row.code,
    preparation: {
      strength: strength.length <= 100 ? strength : '',
      dosage_form: '', original_volume_ml: '', reconstitution_volume_ml: '',
      reconstitution_note: '',
    },
    // The label "Tiêm" does not distinguish IM/IV/SC; even "Tiêm truyền"
    // is not evidence that both TMC and TTM are approved.
    active_ingredients: [],
    aliases: [],
    semantic_aliases: [],
    category: '',
    default_route: '',
    routes: [],
    default_volume_ml: '',
    default_rate: '',
    default_route_text: '',
    default_rate_text: '',
    dilution: null,
  };
}

export function searchHospitalDrugs(rows, query) {
  const q = String(query || '').trim().toLocaleLowerCase('vi-VN');
  if (!q) return rows;
  return rows.filter(r => [r.code, r.name, r.strength, r.ingredient, r.presentation, r.route_label]
    .some(v => String(v || '').toLocaleLowerCase('vi-VN').includes(q)));
}
