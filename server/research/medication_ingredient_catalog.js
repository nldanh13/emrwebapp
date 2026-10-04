'use strict';

// Ánh xạ hoạt chất <-> tên thuốc/tên thương mại từ config/medication_catalog.json.
// Phần này chỉ dùng để nhận diện/tìm kiếm nghiên cứu; KHÔNG suy ra rằng thuốc đã được thực hiện
// chỉ vì xuất hiện trong y lệnh.

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

function loadCatalog() {
  const data = readJsonSafe(CATALOG_PATH, {}) || {};
  return Array.isArray(data.medications) ? data.medications.filter(x => x && typeof x === 'object') : [];
}

function activeIngredientsOf(med) {
  const value = med?.active_ingredients ?? med?.active_ingredient ?? [];
  return uniqueStrings(Array.isArray(value) ? value : [value]);
}

function namesOf(med) {
  return uniqueStrings([
    med?.canonical,
    ...(Array.isArray(med?.aliases) ? med.aliases : []),
    ...(Array.isArray(med?.semantic_aliases) ? med.semantic_aliases : []),
  ]);
}

function resolveIngredientTargets(targets, medications = loadCatalog()) {
  const wanted = uniqueStrings(Array.isArray(targets) ? targets : [targets]);
  const resolved = [];

  for (const target of wanted) {
    const targetKey = normalizeText(target);
    const matching = medications.filter(med => activeIngredientsOf(med).some(x => normalizeText(x) === targetKey));
    const names = uniqueStrings(matching.flatMap(namesOf));
    resolved.push({
      active_ingredient: target,
      catalog_matches: matching.length,
      medication_names: names,
      canonical_names: uniqueStrings(matching.map(m => m.canonical)),
    });
  }

  return {
    targets: resolved,
    active_ingredients: wanted,
    medication_names: uniqueStrings(resolved.flatMap(x => x.medication_names)),
  };
}

function textMatchesAnyName(text, names) {
  const hay = ` ${normalizeText(text)} `;
  if (!hay.trim()) return false;
  return (names || []).some(name => {
    const needle = normalizeText(name);
    if (!needle) return false;
    return hay.includes(` ${needle} `) || hay.includes(` ${needle}`) || hay.includes(`${needle} `);
  });
}

function ingredientEvidence(text, targets, medications = loadCatalog()) {
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

module.exports = {
  CATALOG_PATH,
  normalizeText,
  uniqueStrings,
  loadCatalog,
  activeIngredientsOf,
  namesOf,
  resolveIngredientTargets,
  textMatchesAnyName,
  ingredientEvidence,
};
