'use strict';

// Ánh xạ hoạt chất <-> tên thuốc/tên thương mại từ config/medication_catalog.json.
// Chỉ dùng để nhận diện/tìm kiếm nghiên cứu. Việc một tên thuốc xuất hiện trong y lệnh
// KHÔNG tự động được diễn giải là người bệnh đã được thực hiện/cấp dùng thuốc.

const path = require('path');
const { readJsonSafe } = require('../utils/file');

const CATALOG_PATH = path.join(__dirname, '..', '..', 'config', 'medication_catalog.json');

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const raw = String(value ?? '').trim();
    const key = normalizeText(raw);
    if (!raw || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

// Với tên thuốc/tên thương mại, giữ các cách viết khác nhau (vd. TRADE-B và TRADE B)
// vì đây là các chuỗi có thể xuất hiện thật trong EMR. Chỉ bỏ trùng chính xác không phân biệt hoa/thường.
function uniqueMedicationNames(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const raw = String(value ?? '').trim();
    const key = raw.toLocaleLowerCase('vi-VN');
    if (!raw || seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

function loadCatalog() {
  const data = readJsonSafe(CATALOG_PATH, {}) || {};
  return Array.isArray(data.medications) ? data.medications.filter(x => x && typeof x === 'object') : [];
}

function activeIngredientsOf(med) {
  const value = med?.active_ingredients ?? med?.active_ingredient ?? [];
  return uniqueStrings(Array.isArray(value) ? value : [value]);
}

function namesOf(med) {
  return uniqueMedicationNames([
    med?.canonical,
    ...(Array.isArray(med?.aliases) ? med.aliases : []),
    ...(Array.isArray(med?.semantic_aliases) ? med.semantic_aliases : []),
  ]);
}

function allActiveIngredients(medications = loadCatalog()) {
  return uniqueStrings(medications.flatMap(activeIngredientsOf));
}

function resolveIngredientTargets(targets, medications = loadCatalog()) {
  const wanted = uniqueStrings(Array.isArray(targets) ? targets : [targets]);
  const resolved = [];

  for (const target of wanted) {
    const targetKey = normalizeText(target);
    const matching = medications.filter(med => activeIngredientsOf(med).some(x => normalizeText(x) === targetKey));
    const names = uniqueMedicationNames(matching.flatMap(namesOf));
    resolved.push({
      active_ingredient: target,
      catalog_matches: matching.length,
      medication_names: names,
      canonical_names: uniqueMedicationNames(matching.map(m => m.canonical)),
    });
  }

  return {
    targets: resolved,
    active_ingredients: wanted,
    medication_names: uniqueMedicationNames(resolved.flatMap(x => x.medication_names)),
  };
}

function textMatchesAnyName(text, names) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  const hay = ` ${normalized} `;
  return (names || []).some(name => {
    const needle = normalizeText(name);
    return needle ? hay.includes(` ${needle} `) : false;
  });
}

function ingredientEvidence(text, targets = allActiveIngredients(), medications = loadCatalog()) {
  const resolved = resolveIngredientTargets(targets, medications);
  const hits = [];
  for (const item of resolved.targets) {
    const directIngredient = textMatchesAnyName(text, [item.active_ingredient]);
    const matchedNames = item.medication_names.filter(name => textMatchesAnyName(text, [name]));
    if (directIngredient || matchedNames.length) {
      hits.push({
        active_ingredient: item.active_ingredient,
        direct_active_ingredient: directIngredient,
        matched_names: matchedNames,
      });
    }
  }
  return hits;
}

function firstValue(row, names) {
  for (const name of names) {
    const value = row?.[name];
    if (String(value ?? '').trim()) return String(value).trim();
  }
  return '';
}

function augmentMedicationRowsForResearch(medicationRows = [], clinicalNoteRows = [], medications = loadCatalog()) {
  const ingredients = allActiveIngredients(medications);
  if (!ingredients.length) return Array.isArray(medicationRows) ? medicationRows.slice() : [];
  const out = [];

  for (const row of medicationRows || []) {
    const explicit = firstValue(row, ['active_ingredient', 'Hoạt chất', 'Hoat chat']);
    if (explicit) {
      out.push(row);
      continue;
    }
    const text = [
      firstValue(row, ['drug_name_raw', 'Tên thuốc', 'ten_thuoc']),
      firstValue(row, ['drug_name_norm']),
      firstValue(row, ['raw_line']),
    ].filter(Boolean).join(' ');
    const hits = ingredientEvidence(text, ingredients, medications);
    if (!hits.length) {
      out.push(row);
      continue;
    }
    // Một chế phẩm phối hợp có thể có nhiều hoạt chất. Tách thành các dòng ảo chỉ trong lúc
    // chọn mẫu để toán tử '='/'in' hoạt động đúng; không sửa medication_orders.csv gốc.
    for (const hit of hits) {
      out.push({
        ...row,
        active_ingredient: hit.active_ingredient,
        active_ingredient_source: 'medication_catalog',
        catalog_matched_name: hit.matched_names[0] || (hit.direct_active_ingredient ? hit.active_ingredient : ''),
      });
    }
  }

  // "Y lệnh khác" có thể chứa tên thương mại nhưng không được parser tách thành thuốc.
  // Tạo bằng chứng y lệnh ảo cho bước chọn mẫu; source cho biết đây không phải medication order chuẩn.
  for (const note of clinicalNoteRows || []) {
    const text = [
      firstValue(note, ['order_text', 'Y lệnh', 'y_lenh']),
      firstValue(note, ['clinical_text', 'Diễn biến', 'dien_bien']),
    ].filter(Boolean).join(' ');
    if (!text) continue;
    const hits = ingredientEvidence(text, ingredients, medications);
    for (const hit of hits) {
      out.push({
        research_code: firstValue(note, ['research_code']),
        patient_code: firstValue(note, ['patient_code', 'Mã BN', 'Ma BN']),
        patient_key: firstValue(note, ['patient_key']),
        encounter_id: firstValue(note, ['encounter_id']),
        order_datetime: firstValue(note, ['note_datetime', 'order_datetime']),
        order_date: firstValue(note, ['note_date', 'order_date']),
        drug_name_raw: hit.matched_names.join('; ') || hit.active_ingredient,
        drug_name_norm: hit.matched_names[0] || hit.active_ingredient,
        active_ingredient: hit.active_ingredient,
        active_ingredient_source: 'medication_catalog_from_other_order',
        raw_line: text,
        source: 'clinical_notes_order_text',
        source_run_id: firstValue(note, ['source_run_id']),
      });
    }
  }

  return out;
}

module.exports = {
  CATALOG_PATH,
  normalizeText,
  uniqueStrings,
  uniqueMedicationNames,
  loadCatalog,
  activeIngredientsOf,
  namesOf,
  allActiveIngredients,
  resolveIngredientTargets,
  textMatchesAnyName,
  ingredientEvidence,
  augmentMedicationRowsForResearch,
};
