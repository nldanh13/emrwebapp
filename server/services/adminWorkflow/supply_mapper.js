'use strict';

const { TAGS } = require('./constants');
const {
  normText,
  safeArray,
  uniq,
  collectDrugsFromSource,
  collectServicesFromRecord,
  collectCareOrders,
  collectVtytPlan,
  aggregateSupplyPlan,
  isSurgicalServiceName,
  hasMedicationAtHour,
} = require('./common');
const { loadAdminWorkflowRules } = require('./config_loader');

function textForOrder(order) {
  return normText([
    order?.name,
    order?.ten_thuoc,
    order?.ten_hien_thi,
    order?.routeLabel,
    order?.duong_dung,
    order?.duong_dung_goc,
    order?.cach_dung,
    order?.ghi_chu,
    order?.note,
    order?.source,
    order?.raw_text,
    order?.raw,
  ].join(' '));
}

function orderDateKey(order) {
  return normText(order?.date || order?.ngay || order?.ngay_lam || order?.time || '');
}

function matchesRule(text, matchers) {
  const ms = safeArray(matchers).map(normText).filter(Boolean);
  return ms.length ? ms.some(m => text.includes(m)) : false;
}

function qtyFromOrder(order, fallback = 1) {
  const candidates = [order?.so_lan, order?.lan, order?.times, order?.qty, order?.quantity, order?.so_luong];
  for (const c of candidates) {
    const n = Number(String(c ?? '').replace(',', '.'));
    if (Number.isFinite(n) && n > 0) return n;
  }
  const t = normText([order?.gio_dung, order?.time, order?.raw_text, order?.raw].join(' '));
  const count = (t.match(/\b\d{1,2}:\d{2}\b/g) || []).length;
  return count > 1 ? count : fallback;
}

function mapOrderToSupplies(order, dictionary) {
  const text = textForOrder(order);
  const out = [];
  for (const rule of safeArray(dictionary)) {
    if (!matchesRule(text, rule.match || rule.keywords)) continue;
    const multiplier = rule.perDose === false ? 1 : qtyFromOrder(order, 1);
    for (const sup of safeArray(rule.supplies)) {
      out.push({
        ...sup,
        label: sup.label || sup.name,
        qty: (Number(sup.qty ?? sup.quantity ?? 1) || 1) * multiplier,
        sourceOrder: order?.name || order?.ten_thuoc || order?.ten_hien_thi || order?.raw_text || '',
        source: sup.source || rule.source || 'dictionary',
        date: order?.date || '',
        category: sup.category || 'required',
        alert: sup.alert !== false,
        required: sup.required !== false,
      });
    }
  }
  return out;
}

function detectDrugSignals(drugs) {
  const text = normText(safeArray(drugs).map(textForOrder).join(' '));
  return {
    has6h: hasMedicationAtHour(drugs, 6),
    hasInjection: /tiem|tmc|tinh mach|iv|truyen|infusion|tb|bap/.test(text),
    hasInfusion: /truyen|dich truyen|natri clorid|ringer|glucose|mannitol|infusion/.test(text),
    hasAntibiotic: /cef|penem|cillin|mycin|quinolon|metronidazol|vancomycin|amikacin|gentamicin/.test(text),
    hasSelfPaidMarker: /tt0|tu tuc|tự túc|ngoai bhyt|khong bhyt/.test(text),
  };
}

function detectServiceSignals(services) {
  const text = normText(safeArray(services).map(s => `${s.name} ${s.source}`).join(' '));
  const surgicalServices = safeArray(services).filter(s => isSurgicalServiceName(s.name));
  return {
    hasSurgery: surgicalServices.length > 0 || /phau thuat|pttt|mo xuong|nep vit|ket hop xuong/.test(text),
    hasSurgicalTechnicalService: surgicalServices.length > 0,
    surgicalServices,
    hasContrast: /can quang|can tu|contrast|omnipaque|gadolinium/.test(text),
    hasBlood: /truyen mau|khoi hong cau|huyet tuong|tieu cau/.test(text),
    hasCls: /xet nghiem|sieu am|x quang|ct|mri|dien tim|cls|cdha|xn/.test(text),
  };
}

function isRoutineSuppressed(state, order) {
  if (!state?.skipRoutineInpatientSupplies) return false;
  const text = textForOrder(order);
  return /gang tay|thuong quy|cham soc hang ngay|mac dinh/.test(text);
}

function mapSuppliesForRecords(records, state, ctx) {
  const rules = loadAdminWorkflowRules(ctx);
  const drugs = [];
  const services = [];
  const cares = [];
  const explicitSupplies = [];
  for (const record of safeArray(records)) {
    drugs.push(...collectDrugsFromSource(record));
    services.push(...collectServicesFromRecord(record));
    cares.push(...collectCareOrders(record));
    explicitSupplies.push(...collectVtytPlan(record));
  }

  const drugSignals = detectDrugSignals(drugs);
  const serviceSignals = detectServiceSignals(services);
  const dictionaryOrders = [...drugs, ...services, ...cares];
  const mapped = [];
  for (const order of dictionaryOrders) {
    if (isRoutineSuppressed(state, order)) continue;
    mapped.push(...mapOrderToSupplies(order, rules.supplyDictionary));
  }

  const routine = [];
  if (!state?.skipRoutineInpatientSupplies && !safeArray(state?.tags).includes(TAGS.POST_OP)) {
    for (const item of safeArray(rules.routineSupplies)) {
      routine.push({ ...item, label: item.label || item.name, category: 'routine', routine: true, alert: false, required: false });
    }
  }

  const supplyPlan = aggregateSupplyPlan([...explicitSupplies, ...mapped, ...routine]);
  const alertSupplies = supplyPlan.filter(x => x.alert !== false && x.category !== 'routine' && x.required !== false);

  return {
    drugs,
    services,
    cares,
    drugSignals,
    serviceSignals,
    supplyPlan,
    alertSupplies,
    explicitSupplies,
    mappedSupplies: aggregateSupplyPlan(mapped),
    routineSupplies: aggregateSupplyPlan(routine),
    surgeryPackageRules: rules.surgeryPackages,
    rules,
    orderDates: uniq(dictionaryOrders.map(orderDateKey).filter(Boolean)),
  };
}

module.exports = {
  mapSuppliesForRecords,
  detectDrugSignals,
  detectServiceSignals,
  mapOrderToSupplies,
  matchesRule,
  textForOrder,
};
