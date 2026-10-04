'use strict';

// "Tên thuốc trong kho chưa gắn hoạt chất": gom y lệnh thuốc của kho theo tên thuốc (tên thương mại
// như EMR ghi), đếm số lượt/người bệnh, và cho biết tên đó đã nhận ra hoạt chất qua Danh mục thuốc
// chưa. Người dùng gắn hoạt chất ngay tại danh sách; điều kiện "Dùng hoạt chất: …" khi tạo nghiên
// cứu dựa hoàn toàn vào các tên đã gắn này.

const { getCell } = require('./table_io');
const { extractDrugNameFromOrderText } = require('./value_normalizers');
const { normalizeText, activeIngredientsOf, namesOf, uniqueStrings } = require('./medication_ingredient_catalog');

const MAX_VARIANTS = 5;

function compileCatalogNames(medications) {
  return (medications || []).map(med => ({
    key: String(med?.canonical || '').trim(),
    canonical: String(med?.canonical || '').trim(),
    ingredients: activeIngredientsOf(med),
    names: namesOf(med).map(normalizeText).filter(Boolean),
  })).filter(m => m.key);
}

// Thuốc trong danh mục có tên (tên chuẩn/tên khác) nằm trọn trong chuỗi — cùng cách so khớp khi chọn mẫu.
function catalogMatchesFor(text, compiled) {
  const hay = ` ${normalizeText(text)} `;
  if (hay.trim() === '') return [];
  return compiled.filter(m => m.names.some(n => hay.includes(` ${n} `)));
}

function buildDrugNameInventory(medicationRows = [], medications = [], { limit = 1500 } = {}) {
  const groups = new Map();
  for (const row of medicationRows || []) {
    const raw = getCell(row, ['drug_name_raw', 'Tên thuốc']) || '';
    const name = extractDrugNameFromOrderText(raw) || raw.trim();
    const key = getCell(row, ['drug_name_norm']) || normalizeText(name).replace(/ /g, '_');
    if (!key) continue;
    let g = groups.get(key);
    if (!g) {
      g = { key, names: new Map(), variants: new Map(), rows: 0, encounters: new Set(), patients: new Set(), explicit: new Set() };
      groups.set(key, g);
    }
    g.rows += 1;
    g.names.set(name, (g.names.get(name) || 0) + 1);
    if (g.variants.size < 50 || g.variants.has(raw)) g.variants.set(raw, (g.variants.get(raw) || 0) + 1);
    const enc = getCell(row, ['encounter_id']) || getCell(row, ['research_code']);
    if (enc) g.encounters.add(enc);
    const patient = getCell(row, ['patient_key', 'patient_code', 'research_code']);
    if (patient) g.patients.add(patient);
    for (const ing of String(getCell(row, ['active_ingredient', 'Hoạt chất']) || '').split(/[;+]/).map(x => x.trim()).filter(Boolean)) g.explicit.add(ing);
  }

  const compiled = compileCatalogNames(medications);
  const byCount = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
  const items = [];
  for (const g of groups.values()) {
    const name = byCount(g.names)[0] || g.key;
    const variants = byCount(g.variants).slice(0, MAX_VARIANTS);
    // Theo tên thuốc trước; không thấy thì theo cả dòng y lệnh gốc (vd. "Aclasta (Acid zoledronic)").
    let matches = catalogMatchesFor(name, compiled);
    if (!matches.length) matches = catalogMatchesFor(variants.join(' ; '), compiled);
    const ingredients = uniqueStrings([...g.explicit, ...matches.flatMap(m => m.ingredients)]);
    const status = ingredients.length ? 'mapped' : matches.length ? 'catalog_no_ingredient' : 'not_in_catalog';
    items.push({
      key: g.key,
      name,
      variants,
      rows: g.rows,
      encounters: g.encounters.size,
      patients: g.patients.size,
      status,
      active_ingredients: ingredients,
      catalog_keys: matches.map(m => m.key).slice(0, 5),
    });
  }
  items.sort((a, b) => b.encounters - a.encounters || b.rows - a.rows || a.name.localeCompare(b.name));
  const counts = { total: items.length, mapped: 0, catalog_no_ingredient: 0, not_in_catalog: 0 };
  for (const it of items) counts[it.status] += 1;
  const unmappedEncounters = new Set();
  for (const g of groups.values()) {
    const it = items.find(x => x.key === g.key);
    if (it && it.status !== 'mapped') for (const e of g.encounters) unmappedEncounters.add(e);
  }
  return { counts, unmapped_encounters: unmappedEncounters.size, items: items.slice(0, limit), truncated: items.length > limit };
}

// Gắn hoạt chất cho các tên thuốc: thuốc đã có trong danh mục (catalog_key hoặc trùng tên chuẩn) thì
// thêm hoạt chất; chưa có thì tạo thuốc mới với tên chuẩn = tên thuốc như EMR ghi. Trả danh sách thay đổi.
function assignIngredientToNames(medications, items, activeIngredient) {
  const ingredient = String(activeIngredient || '').trim();
  if (!ingredient) {
    const err = new Error('Cần nhập hoạt chất.');
    err.status = 400;
    throw err;
  }
  const changes = [];
  const findByKey = (k) => medications.find(m => String(m?.canonical || '').trim().toLocaleLowerCase('vi-VN') === String(k || '').trim().toLocaleLowerCase('vi-VN'));
  for (const item of (items || []).slice(0, 500)) {
    const name = String(item?.name || '').trim().slice(0, 160);
    const keys = Array.isArray(item?.catalog_keys) ? item.catalog_keys : item?.catalog_key ? [item.catalog_key] : [];
    let med = keys.map(findByKey).find(Boolean) || findByKey(name);
    if (!med) {
      if (!name) continue;
      med = { canonical: name };
      medications.push(med);
      changes.push({ action: 'create', canonical: name });
    } else {
      changes.push({ action: 'update', canonical: med.canonical });
    }
    const current = activeIngredientsOf(med);
    if (!current.some(x => normalizeText(x) === normalizeText(ingredient))) current.push(ingredient);
    med.active_ingredients = current;
    delete med.active_ingredient;
  }
  return changes;
}

module.exports = { buildDrugNameInventory, assignIngredientToNames, catalogMatchesFor, compileCatalogNames };
