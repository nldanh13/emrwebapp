'use strict';

const { TAGS } = require('./constants');
const { safeArray, normText, stableHash, toNumber } = require('./common');
const { activeDrugs, drugName } = require('./medication_rules');
const { dailyQuantity, isInfusionRoute, isInjectionRoute } = require('./business_helpers');

function includePatientForForecast(card) {
  if (!card) return false;
  const tags = new Set(safeArray(card.workflowTags || card.workflow?.tags));
  if (tags.has(TAGS.DISCHARGE) || tags.has(TAGS.TRANSFER_WARD) || tags.has(TAGS.TRANSFER_HOSPITAL) || tags.has(TAGS.DEATH)) return false;
  return true;
}

function forecastDateLabels(days) {
  return Array.from({ length: Math.max(1, Number(days) || 1) }, (_, idx) => `N+${idx + 1}`);
}

function normalizeForecastItem({ card, name, itemType, qtyPerDay, days, source, category, note }) {
  const totalQty = Number((toNumber(qtyPerDay, 1) * days).toFixed(2));
  return {
    key: stableHash([card.patientId, itemType, normText(name), normText(source), days], 16),
    patientId: card.patientId,
    patientName: card.profile?.name || card.patientName || '',
    room: card.profile?.room || '',
    doctor: card.profile?.doctor || '',
    itemType,
    name,
    qtyPerDay: Number(toNumber(qtyPerDay, 1).toFixed(2)),
    days,
    totalQty,
    source: source || '',
    category: category || '',
    note: note || '',
    action: 'DU_TRU',
  };
}

function buildPatientForecast(card, { days = 1 } = {}) {
  const d = Math.max(1, Math.min(7, Number(days) || 1));
  if (!includePatientForForecast(card)) {
    return { required: false, reason: 'Người bệnh thuộc nhóm đóng hồ sơ nên không dự trù tiếp.', days: d, dateLabels: forecastDateLabels(d), items: [], aggregate: [] };
  }
  const tags = new Set(safeArray(card.workflowTags || card.workflow?.tags));
  const skipRoutine = tags.has(TAGS.POST_OP) && !tags.has(TAGS.CONTINUE_CARE);
  const items = [];

  for (const drug of activeDrugs(card.drugs)) {
    const name = drugName(drug);
    if (!name) continue;
    const qty = dailyQuantity(drug, 1);
    items.push(normalizeForecastItem({
      card,
      name,
      itemType: 'drug',
      qtyPerDay: qty,
      days: d,
      source: drug.routeLabel || drug.category || 'drug',
      category: drug.category || '',
      note: isInfusionRoute(drug) ? 'Dự trù thuốc truyền' : isInjectionRoute(drug) ? 'Dự trù thuốc tiêm' : 'Dự trù thuốc',
    }));
  }

  for (const sup of safeArray(card.supplyPlan)) {
    if (sup.category === 'routine' && skipRoutine) continue;
    const name = String(sup.label || sup.name || '').trim();
    if (!name) continue;
    const qty = toNumber(sup.qty, 1);
    items.push(normalizeForecastItem({
      card,
      name,
      itemType: 'supply',
      qtyPerDay: qty,
      days: d,
      source: sup.source || sup.sourceOrder || '',
      category: sup.category || '',
      note: sup.routine ? 'VTYT thường quy' : 'VTYT ánh xạ từ y lệnh',
    }));
  }

  const aggregate = aggregateForecast(items);
  return { required: true, days: d, dateLabels: forecastDateLabels(d), skipRoutine, items, aggregate };
}

function aggregateForecast(items) {
  const map = new Map();
  for (const item of safeArray(items)) {
    const key = `${item.itemType}|${normText(item.name)}`;
    if (!map.has(key)) map.set(key, { itemType: item.itemType, name: item.name, totalQty: 0, patients: [], category: item.category || '', sources: [] });
    const prev = map.get(key);
    prev.totalQty += Number(item.totalQty) || 0;
    prev.patients.push({ patientId: item.patientId, patientName: item.patientName, room: item.room, qty: item.totalQty });
    prev.sources.push(item.source || item.note || '');
  }
  return [...map.values()].map(x => ({ ...x, totalQty: Number(x.totalQty.toFixed(2)), sources: [...new Set(x.sources.filter(Boolean))] }))
    .sort((a, b) => String(a.itemType).localeCompare(String(b.itemType)) || String(a.name).localeCompare(String(b.name), 'vi'));
}

function buildGlobalForecast(patients, { days = 1 } = {}) {
  const patientForecasts = safeArray(patients).map(card => ({ patientId: card.patientId, patientName: card.profile?.name || card.patientName || '', room: card.profile?.room || '', forecast: buildPatientForecast(card, { days }) }));
  const items = patientForecasts.flatMap(p => safeArray(p.forecast.items));
  return {
    version: 1,
    days: Math.max(1, Math.min(7, Number(days) || 1)),
    createdAt: new Date().toISOString(),
    dateLabels: forecastDateLabels(days),
    patientCount: patientForecasts.filter(p => p.forecast.required).length,
    patients: patientForecasts,
    items,
    aggregate: aggregateForecast(items),
  };
}

module.exports = { buildPatientForecast, buildGlobalForecast, aggregateForecast };
