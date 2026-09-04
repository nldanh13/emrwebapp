import { DEFAULT_QUANTITY_CONFIG } from '../config/constants.js';
import { VTYT_CATALOG } from '../config/vtytCatalog.js';
import { ANTIBIOTIC_KEYWORDS, SURGERY_VTYT_RULES } from '../config/vtytRules.js';
import { includesAny, normalizeText, toNumber } from '../utils/text.js';
import { diffCalendarDays, parseVNDateTime } from '../utils/date.js';

export function isAntibioticDrug(text) {
  return includesAny(text, ANTIBIOTIC_KEYWORDS);
}

export function isInfusionItem(item) {
  return includesAny(`${item.duong_dung || ''} ${item.ten_thuoc_vtyt || ''}`, ['truyền', 'tiêm truyền', 'tiêm truyền tĩnh mạch']);
}

export function isTmcItem(item) {
  return includesAny(`${item.duong_dung || ''} ${item.raw || ''}`, ['tmc', 'tĩnh mạch chậm', 'tiêm tĩnh mạch']);
}

export function isIntramuscularItem(item) {
  return includesAny(`${item.duong_dung || ''} ${item.raw || ''}`, ['tiêm bắp', 'tb']);
}

export function isMixedWithNacl(item, allOrderItems = []) {
  const raw = `${item.ten_thuoc_vtyt || ''} ${item.raw || ''}`;
  if (includesAny(raw, ['pha nacl', 'pha natri clorid', 'natri clorid 0,9%'])) return true;
  return allOrderItems.some((x) => includesAny(x.ten_thuoc_vtyt, ['natri clorid', 'nacl']) && x.so_luong > 0);
}

export function getDoseCount(item) {
  const qty = toNumber(item.so_luong, 0);
  return qty > 0 ? qty : 1;
}

export function addRequirement(map, key, quantity, reason, context = {}) {
  if (!key || !VTYT_CATALOG[key]) return;
  const existing = map.get(key) || {
    key,
    code: VTYT_CATALOG[key].code,
    name: VTYT_CATALOG[key].name,
    searchKeyword: VTYT_CATALOG[key].searchKeyword,
    required_quantity: 0,
    reasons: [],
    contexts: [],
  };
  existing.required_quantity += Number(quantity || 0);
  if (reason) existing.reasons.push(reason);
  if (context) existing.contexts.push(context);
  map.set(key, existing);
}

export function buildExistingSupplyMap({ popupOrders = [], declarations = [], addedRows = [] } = {}) {
  const map = new Map();

  const add = (item) => {
    const name = item.ten_thuoc_vtyt || item.name || '';
    const code = item.ma_thuoc_vtyt || item.code || '';
    const qty = toNumber(item.so_luong || item.quantity || 0);
    const key = detectCatalogKeyFromNameOrCode(name, code);
    if (!key) return;
    const current = map.get(key) || 0;
    map.set(key, current + qty);
  };

  for (const order of popupOrders) for (const item of order.items || []) if (item.is_vtyt && item.is_active) add(item);
  for (const declaration of declarations) for (const item of declaration.items || []) add(item);
  for (const item of addedRows) add(item);
  return map;
}

export function detectCatalogKeyFromNameOrCode(name = '', code = '') {
  const normalized = normalizeText(`${name} ${code}`);
  for (const [key, item] of Object.entries(VTYT_CATALOG)) {
    if (item.code && normalized.includes(normalizeText(item.code))) return key;
    if ((item.aliases || []).some((alias) => normalized.includes(normalizeText(alias)))) return key;
    if (item.name && normalized.includes(normalizeText(item.name).slice(0, 18))) return key;
  }
  return '';
}

export function findLastUsedDate(previousVTYTItems = [], catalogAliases = []) {
  const candidates = previousVTYTItems
    .filter((item) => includesAny(`${item.ten_thuoc_vtyt || ''} ${item.name || ''}`, catalogAliases))
    .map((item) => parseVNDateTime(item.thoi_gian || item.date || item.ngay || ''))
    .filter(Boolean)
    .sort((a, b) => b - a);
  return candidates[0] || null;
}

export function needNewIVCatheter({ currentDate = new Date(), previousVTYTItems = [], patientAge = 0, config = DEFAULT_QUANTITY_CONFIG } = {}) {
  const catheter = VTYT_CATALOG.KIM_LUON_TM;
  const lastDate = findLastUsedDate(previousVTYTItems, catheter.aliases || []);
  const quantity = Number(patientAge) >= 55 ? config.ivCatheterAge55PlusQuantity : config.ivCatheterDefaultQuantity;

  if (!lastDate) return { need: true, quantity, reason: 'Có TMC/truyền dịch nhưng chưa thấy lên kim luồn trước đó.' };

  const days = diffCalendarDays(lastDate, currentDate);
  if (days === null || days >= config.ivCatheterCycleDays) {
    return { need: true, quantity, reason: `Kim luồn đã dùng ${days ?? '?'} ngày, cần thay theo chu kỳ ${config.ivCatheterCycleDays}-4 ngày.` };
  }

  return { need: false, quantity: 0, reason: `Đã có kim luồn trong ${days} ngày gần đây.` };
}

export function buildRequiredSuppliesForOrders({ popupOrders = [], patient = {}, previousVTYTItems = [], currentDate = new Date(), config = DEFAULT_QUANTITY_CONFIG } = {}) {
  const required = new Map();

  addRequirement(
    required,
    'GANG_TAY_KHAM',
    config.glovesPerPatientPerDayMax,
    `Mỗi người bệnh dự kiến ${config.glovesPerPatientPerDayMin}-${config.glovesPerPatientPerDayMax} đôi găng/ngày`,
    { type: 'daily_patient' }
  );

  let hasTmcOrInfusion = false;

  for (const order of popupOrders) {
    const activeItems = (order.items || []).filter((x) => x.is_active && !x.is_vtyt);
    for (const item of activeItems) {
      const dose = getDoseCount(item);
      const raw = `${item.ten_thuoc_vtyt || ''} ${item.duong_dung || ''} ${item.raw || ''}`;

      if (isInfusionItem(item)) {
        hasTmcOrInfusion = true;
        addRequirement(required, 'DAY_TRUYEN_DICH', dose * config.infusionSetPerMedicationTime, 'Có thuốc/dịch truyền: tính dây truyền theo cử thuốc', { orderId: order.y_lenh_id, item });
      }

      if (isTmcItem(item) || includesAny(item.duong_dung, ['tiêm tĩnh mạch'])) {
        hasTmcOrInfusion = true;
        if (isAntibioticDrug(raw)) {
          addRequirement(required, 'BOM_TIEM_20ML', dose * config.antibioticTmcSyringe20mlPerDose, 'Kháng sinh TMC: bơm tiêm 20ml mỗi cử', { orderId: order.y_lenh_id, item });
          addRequirement(required, 'KIM_TIEM_PHA', dose * config.mixingNeedlePerDose, 'Kháng sinh TMC: kim pha mỗi cử', { orderId: order.y_lenh_id, item });
        } else {
          addRequirement(required, 'BOM_TIEM_10ML', dose * config.otherTmcSyringe10mlPerDose, 'Thuốc TMC khác: bơm tiêm 10ml mỗi cử', { orderId: order.y_lenh_id, item });
          addRequirement(required, 'KIM_TIEM_PHA', dose * config.mixingNeedlePerDose, 'Thuốc TMC khác: kim pha mỗi cử', { orderId: order.y_lenh_id, item });
        }
      }

      if (isIntramuscularItem(item)) {
        addRequirement(required, 'BOM_TIEM_5ML', dose * config.imSyringe5mlPerDose, 'Tiêm bắp: bơm tiêm 5ml mỗi cử', { orderId: order.y_lenh_id, item });
        addRequirement(required, 'KIM_TIEM_PHA', dose * config.mixingNeedlePerDose, 'Tiêm bắp: kim pha mỗi cử', { orderId: order.y_lenh_id, item });
      }

      if (isMixedWithNacl(item, activeItems)) {
        addRequirement(required, 'BOM_TIEM_10ML', dose * config.naclMixSyringe10mlPerDose, 'Thuốc pha NaCl: bơm tiêm 10ml mỗi cử', { orderId: order.y_lenh_id, item });
        addRequirement(required, 'KIM_TIEM_PHA', dose * config.mixingNeedlePerDose, 'Thuốc pha NaCl: kim pha mỗi cử', { orderId: order.y_lenh_id, item });
      }
    }

    const text = activeItems.map((x) => x.raw || x.ten_thuoc_vtyt || '').join(' ');
    addOrderKeywordRequirements(required, text, order);
  }

  if (hasTmcOrInfusion) {
    addRequirement(required, 'NUT_KIM_LUON_OR_KHOA_3_NGA', config.ivCatheterPlugPerDay, 'Có TMC/truyền dịch: lên nút/khóa kim luồn mỗi ngày', { type: 'daily_iv' });
    const iv = needNewIVCatheter({ currentDate, previousVTYTItems, patientAge: patient.tuoi || patient.age || 0, config });
    if (iv.need) {
      addRequirement(required, 'KIM_LUON_TM', iv.quantity, iv.reason, { type: 'iv_catheter' });
      addRequirement(required, 'BANG_DINH_KIM_LUON', iv.quantity, 'Băng dính kim luồn theo số kim luồn', { type: 'iv_catheter_dressing' });
    }
  }

  return Array.from(required.values());
}

function addOrderKeywordRequirements(required, text, order) {
  if (includesAny(text, ['sonde tiểu', 'đặt sonde tiểu', 'foley', 'thông tiểu'])) {
    addRequirement(required, 'TUI_NUOC_TIEU', 1, 'Có đặt sonde tiểu: túi nước tiểu', { orderId: order.y_lenh_id });
    addRequirement(required, 'SONDE_FOLEY_2_NHANH', 1, 'Có đặt sonde tiểu: sonde Foley 2 nhánh', { orderId: order.y_lenh_id });
    addRequirement(required, 'BOM_TIEM_10ML', 1, 'Có đặt sonde tiểu: bơm tiêm 10ml', { orderId: order.y_lenh_id });
  }
  if (includesAny(text, ['thở oxy', 'oxy'])) addRequirement(required, 'DAY_OXY', 1, 'Có thở oxy: dây oxy', { orderId: order.y_lenh_id });
  if (includesAny(text, ['phun khí dung', 'xông khí dung', 'khí dung'])) addRequirement(required, 'MAT_NA_KHI_DUNG', 1, 'Có khí dung: mặt nạ khí dung', { orderId: order.y_lenh_id });
  if (includesAny(text, ['bơm rửa bàng quang', 'rửa bàng quang'])) addRequirement(required, 'BOM_TIEM_50ML_CHO_AN', 1, 'Có bơm rửa bàng quang: bơm 50ml cho ăn', { orderId: order.y_lenh_id });
  if (includesAny(text, ['sonde dạ dày', 'đặt thông dạ dày', 'ống thông dạ dày'])) {
    addRequirement(required, 'BOM_TIEM_50ML_CHO_AN', 1, 'Có sonde dạ dày: bơm 50ml cho ăn', { orderId: order.y_lenh_id });
    addRequirement(required, 'ONG_THONG_DA_DAY', 1, 'Có sonde dạ dày: ống thông dạ dày', { orderId: order.y_lenh_id });
  }
}

export function addSurgerySupplies(requiredList, { surgeryRecords = [], currentDate = new Date(), config = DEFAULT_QUANTITY_CONFIG } = {}) {
  const map = new Map(requiredList.map((x) => [x.key, { ...x }]));

  for (const surgery of surgeryRecords) {
    const text = `${surgery.ten_dich_vu_phau_thuat || ''} ${surgery.chan_doan_sau_pt || ''} ${surgery.phuong_phap_phau_thuat || ''}`;
    const surgeryDate = parseVNDateTime(surgery.gio_bat_dau_raw || surgery.ngay_phau_thuat || '');
    const postopDay = surgeryDate ? diffCalendarDays(surgeryDate, currentDate) : null;

    for (const rule of SURGERY_VTYT_RULES) {
      const matchLocation = !rule.locationIncludes || includesAny(text, rule.locationIncludes);
      const excluded = rule.excludeIncludes && includesAny(text, rule.excludeIncludes);
      const matchMethod = !rule.methodIncludes || includesAny(text, rule.methodIncludes);
      if (!matchLocation || excluded || !matchMethod) continue;

      const supplies = [];
      if (rule.earlySupplies && postopDay !== null && postopDay <= config.postopElasticBandageDays) supplies.push(...rule.earlySupplies);
      if (rule.lateSupplies && postopDay !== null && postopDay > config.postopElasticBandageDays) supplies.push(...rule.lateSupplies);
      if (rule.supplies) supplies.push(...rule.supplies);

      for (const supply of supplies) {
        const qty = supply.max || supply.value || 1;
        addRequirement(map, supply.item, qty, `Sau phẫu thuật: ${rule.label}`, { surgery, postopDay });
      }
    }
  }

  return Array.from(map.values());
}

export function compareRequiredWithExisting(required = [], existingMap = new Map()) {
  return required.map((item) => {
    const existing = existingMap.get(item.key) || 0;
    const missing = Math.max(0, Number(item.required_quantity || 0) - existing);
    return {
      ...item,
      existing_quantity: existing,
      missing_quantity: missing,
      status: missing > 0 ? 'missing' : 'ok',
    };
  });
}

export function buildVTYTPreviewPlan({ patient = {}, popupOrders = [], declarations = [], addedRows = [], previousVTYTItems = [], surgeryRecords = [], currentDate = new Date(), config = DEFAULT_QUANTITY_CONFIG } = {}) {
  const requiredBase = buildRequiredSuppliesForOrders({ popupOrders, patient, previousVTYTItems, currentDate, config });
  const required = addSurgerySupplies(requiredBase, { surgeryRecords, currentDate, config });
  const existingMap = buildExistingSupplyMap({ popupOrders, declarations, addedRows });
  const comparison = compareRequiredWithExisting(required, existingMap);
  return {
    status: comparison.some((x) => x.status === 'missing') ? 'warning' : 'ok',
    required,
    existingMap,
    comparison,
    missing: comparison.filter((x) => x.status === 'missing'),
  };
}
