import { HCHANH_VTYT_ITEMS } from '../config/hchanhLists.js';

const SUPPLY_KEYS = Object.freeze({
  PILL_BOX: { code: 'VTYT.000004231', name: 'Hộp phân liều thuốc', searchKeyword: 'Hộp phân liều thuốc' },
  INFUSION_SET: { code: 'VTYT.000004114', name: 'Dây truyền dịch', searchKeyword: 'Dây truyền dịch' },
  MIXING_NEEDLE: { code: 'VTYT.000004280', name: 'Kim tiêm Tanaphar', searchKeyword: 'Kim tiêm' },
  SYRINGE_5: { code: 'VTYT.000004033', name: 'Bơm tiêm vô trùng 5ml', searchKeyword: 'Bơm tiêm 5ml' },
  SYRINGE_10: { code: 'VTYT.000004009', name: 'Bơm tiêm vô trùng 10ml', searchKeyword: 'Bơm tiêm 10ml' },
  SYRINGE_20: { code: 'VTYT.000004017', name: 'Bơm tiêm vô trùng 20ml', searchKeyword: 'Bơm tiêm 20ml' },
  ELASTIC_BANDAGE: { code: 'VTYT.000003914', name: 'Băng thun 3 móc', searchKeyword: 'Băng thun 3 móc' },
  ADHESIVE_250: { code: 'VTYT.000003860', name: 'Băng dính vô trùng 250x90 mm', searchKeyword: 'Băng dính 250x90' },
});

const ANTIBIOTIC_WORDS = [
  'cef', 'cefa', 'cefo', 'ceft', 'cefix', 'cefuro', 'ceftria', 'cefox', 'cefaz',
  'meropenem', 'imipenem', 'ertapenem', 'vancomycin', 'amikacin', 'gentamicin',
  'ciprofloxacin', 'levofloxacin', 'moxifloxacin', 'metronidazole', 'clindamycin',
  'amoxicillin', 'augmentin', 'piperacillin', 'tazobactam', 'kháng sinh', 'khang sinh',
];
const ANALGESIC_WORDS = [
  'paracetamol', 'acetaminophen', 'diclofenac', 'ketorolac', 'meloxicam', 'celecoxib',
  'tramadol', 'morphin', 'fentanyl', 'pethidin', 'nefopam', 'giảm đau', 'giam dau',
];
const DILUENT_WORDS = ['nacl', 'natri clorid', 'sodium chloride', 'nước cất', 'nuoc cat', 'glucose 5%', 'ringer'];
const ORAL_WORDS = ['uống', 'uong', 'po', 'viên', 'vien', 'gói', 'goi', 'ống uống', 'ong uong'];
const TMC_WORDS = ['tmc', 'tĩnh mạch chậm', 'tinh mach cham', 'tiêm tĩnh mạch', 'tiem tinh mach'];
const INFUSION_WORDS = ['truyền', 'truyen', 'tiêm truyền', 'tiem truyen', 'truyền tĩnh mạch', 'truyen tinh mach'];
const DRESSING_WORDS = ['thay băng', 'thay bang', 'chăm sóc vết mổ', 'cham soc vet mo'];
const INFECTION_WORDS = ['nhiễm trùng', 'nhiem trung', 'áp xe', 'ap xe', 'viêm mủ', 'viem mu', 'mủ', 'mu '];
const LIMB_WORDS = ['tay', 'cánh tay', 'canh tay', 'cẳng tay', 'cang tay', 'bàn tay', 'ban tay', 'chân', 'chan', 'đùi', 'dui', 'cẳng chân', 'cang chan', 'bàn chân', 'ban chan', 'gối', 'goi', 'cổ chân', 'co chan', 'cổ tay', 'co tay'];
const AXIAL_WORDS = ['cột sống', 'cot song', 'thắt lưng', 'that lung', 'khớp háng', 'khop hang', 'thay khớp háng', 'thay khop hang', 'xương đòn', 'xuong don', 'khớp vai', 'khop vai', 'vai'];
const BACK_BUTTOCK_WORDS = ['lưng', 'lung', 'mông', 'mong', 'cùng cụt', 'cung cut'];

function norm(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

function includesAny(value, words) {
  const text = norm(value);
  return words.some(word => text.includes(norm(word)));
}

function number(value, fallback = 0) {
  const parsed = Number(String(value ?? '').replace(',', '.').match(/-?\d+(?:\.\d+)?/)?.[0]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function doseCount(drug = {}) {
  const text = norm(`${drug.content || ''} ${drug.route || ''} ${drug.order_text || ''}`);
  const explicit = text.match(/(\d+)\s*(?:lan|lần)\s*\/?\s*(?:ngay|ngày)/)
    || text.match(/x\s*(\d+)\s*(?:lan|lần)/)
    || text.match(/(\d+)\s*(?:cu|cử)/);
  if (explicit) return Math.max(1, Number(explicit[1] || 1));
  const times = [...text.matchAll(/(?:^|\s)([01]?\d|2[0-3])\s*(?::|h)\s*([0-5]\d)?/g)];
  if (times.length >= 2) return times.length;
  return Math.max(1, number(drug.quantity, 1));
}

function parseDate(value) {
  const raw = String(value || '').trim();
  let m = raw.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (m) {
    const year = Number(m[3].length === 2 ? `20${m[3]}` : m[3]);
    const date = new Date(year, Number(m[2]) - 1, Number(m[1]));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  m = raw.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function dayDiff(from, to) {
  const a = parseDate(from);
  const b = parseDate(to);
  if (!a || !b) return null;
  a.setHours(0, 0, 0, 0); b.setHours(0, 0, 0, 0);
  return Math.round((b - a) / 86400000);
}

function supplyFromCatalog(code, fallback) {
  const row = HCHANH_VTYT_ITEMS.find(item => String(item.code || '').trim() === code);
  return { ...fallback, ...(row ? { code: row.code, name: row.name, searchKeyword: row.name } : {}) };
}

function emptyRequirement(spec, reason) {
  const resolved = supplyFromCatalog(spec.code, spec);
  return {
    key: resolved.code,
    code: resolved.code,
    name: resolved.name,
    searchKeyword: resolved.searchKeyword || resolved.name,
    required_quantity: 0,
    existing_quantity: 0,
    input_quantity: 0,
    selected: true,
    manual: false,
    reasons: reason ? [reason] : [],
    warnings: [],
  };
}

function addRequirement(map, spec, qty, reason) {
  const value = Math.max(0, number(qty));
  if (!value) return;
  const current = map.get(spec.code) || emptyRequirement(spec, reason);
  current.required_quantity += value;
  if (reason && !current.reasons.includes(reason)) current.reasons.push(reason);
  map.set(spec.code, current);
}

function existingSupplyMap(job) {
  const map = new Map();
  for (const item of Array.isArray(job?.supplies) ? job.supplies : []) {
    const code = String(item.code || item.key || '').trim();
    const name = norm(item.name || '');
    const catalog = HCHANH_VTYT_ITEMS.find(row => code && row.code === code)
      || HCHANH_VTYT_ITEMS.find(row => name && norm(row.name).includes(name.slice(0, 18)));
    const key = catalog?.code || code;
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + number(item.required_quantity ?? item.quantity, 0));
  }
  return map;
}

function orderGroups(job) {
  const orders = Array.isArray(job?.orders) ? job.orders : [];
  if (orders.length) return orders.map(order => ({ ...order, drugs: Array.isArray(order.drugs) ? order.drugs : [] }));
  return [{ text: '', drugs: Array.isArray(job?.drugs) ? job.drugs : [] }];
}

function surgeryRows(card) {
  const surgery = card?.surgery || {};
  const direct = Array.isArray(surgery?.rows) ? surgery.rows : [];
  const nested = Array.isArray(surgery?.surgeries) ? surgery.surgeries : [];
  return direct.length ? direct : nested;
}

function surgeryText(row) {
  return [row?.ten_dich_vu_phau_thuat, row?.ten_phau_thuat, row?.phuong_phap_phau_thuat, row?.chan_doan_sau_pt, row?.chan_doan, row?.row_text].filter(Boolean).join(' ');
}

function surgeryDate(row) {
  return row?.gio_bat_dau_raw || row?.ngay_phau_thuat || row?.ngay_mo || row?.thoi_gian || '';
}

function mixingSyringeFor(text) {
  const normalized = norm(text);
  if (/\b5\s*ml\b/.test(normalized)) return SUPPLY_KEYS.SYRINGE_5;
  if (/\b10\s*ml\b/.test(normalized)) return SUPPLY_KEYS.SYRINGE_10;
  if (includesAny(normalized, ANALGESIC_WORDS)) return SUPPLY_KEYS.SYRINGE_5;
  return SUPPLY_KEYS.SYRINGE_10;
}

function applyMedicationRules(job, requirementMap) {
  let hasOral = false;
  let hasDressing = false;
  const allOrderText = [];

  for (const order of orderGroups(job)) {
    const drugs = Array.isArray(order.drugs) ? order.drugs : [];
    const orderText = [order.text, ...drugs.map(drug => `${drug.name || ''} ${drug.content || ''} ${drug.route || ''}`)].join(' ');
    allOrderText.push(orderText);
    if (includesAny(orderText, DRESSING_WORDS)) hasDressing = true;
    const hasDiluent = drugs.some(drug => includesAny(`${drug.name || ''} ${drug.content || ''}`, DILUENT_WORDS));
    const infusionItems = [];

    for (const drug of drugs) {
      const text = `${drug.name || ''} ${drug.content || ''} ${drug.route || ''} ${drug.order_text || ''}`;
      const dose = doseCount(drug);
      const oral = includesAny(text, ORAL_WORDS) && !includesAny(text, TMC_WORDS) && !includesAny(text, INFUSION_WORDS);
      const tmc = includesAny(text, TMC_WORDS);
      const infusion = includesAny(text, INFUSION_WORDS);
      if (oral) hasOral = true;

      if (tmc) {
        addRequirement(requirementMap, SUPPLY_KEYS.SYRINGE_20, dose, `${drug.name || 'Thuốc TMC'}: bơm 20ml theo ${dose} cử`);
        addRequirement(requirementMap, SUPPLY_KEYS.MIXING_NEEDLE, dose, `${drug.name || 'Thuốc TMC'}: kim pha theo ${dose} cử`);
      }
      if (infusion) infusionItems.push({ drug, text, dose, isDiluent: includesAny(`${drug.name || ''}`, DILUENT_WORDS) });
    }

    if (infusionItems.length) {
      const infusionDose = Math.max(...infusionItems.map(item => item.dose), 1);
      addRequirement(requirementMap, SUPPLY_KEYS.INFUSION_SET, infusionDose, `Dịch/thuốc truyền: dây truyền theo ${infusionDose} cử của y lệnh`);
      if (hasDiluent) {
        const additives = infusionItems.filter(row => (
          !row.isDiluent
          || includesAny(row.text, ANTIBIOTIC_WORDS)
          || includesAny(row.text, ANALGESIC_WORDS)
        ));
        for (const item of additives) {
          const antibiotic = includesAny(item.text, ANTIBIOTIC_WORDS);
          if (antibiotic) {
            addRequirement(requirementMap, SUPPLY_KEYS.SYRINGE_20, item.dose, `${item.drug.name}: pha kháng sinh, bơm 20ml theo ${item.dose} cử`);
          } else {
            const syringe = mixingSyringeFor(item.text);
            addRequirement(requirementMap, syringe, item.dose, `${item.drug.name}: thuốc pha truyền, bơm ${syringe === SUPPLY_KEYS.SYRINGE_5 ? '5ml' : '10ml'} theo ${item.dose} cử`);
          }
        }
      }
    }
  }
  return { hasOral, hasDressing, orderText: allOrderText.join(' ') };
}

function applySurgeryAndInfectionRules(job, card, requirementMap, medicationContext) {
  const jobDate = job?.ngay_lam || job?.input_time || '';
  const profileText = [
    card?.profile?.chan_doan, card?.profile?.chan_doan_vao_vien,
    card?.discharge?.chan_doan_ra_vien, card?.source_row?.chan_doan,
    medicationContext.orderText,
  ].filter(Boolean).join(' ');
  const infected = includesAny(profileText, INFECTION_WORDS);
  const allSurgery = surgeryRows(card);
  let hasSurgery = false;

  for (const surgery of allSurgery) {
    const text = surgeryText(surgery);
    const postopDay = dayDiff(surgeryDate(surgery), jobDate);
    if (postopDay === null || postopDay < 1) continue;
    hasSurgery = true;
    const axial = includesAny(text, AXIAL_WORDS);
    const limb = includesAny(text, LIMB_WORDS) && !axial;
    if (limb && postopDay >= 1 && postopDay <= 3) {
      addRequirement(requirementMap, SUPPLY_KEYS.ELASTIC_BANDAGE, 1, `Hậu phẫu ngày ${postopDay}, vùng chi: băng thun`);
    }
    if (axial && postopDay >= 1 && postopDay <= 3) {
      addRequirement(requirementMap, SUPPLY_KEYS.ADHESIVE_250, 2, `Hậu phẫu ngày ${postopDay}, cột sống/háng/xương đòn/vai: gợi ý 1-2 băng dính`);
    }
  }

  if (infected && includesAny(profileText, BACK_BUTTOCK_WORDS)) {
    addRequirement(requirementMap, SUPPLY_KEYS.ADHESIVE_250, 3, 'Nhiễm trùng vùng lưng/mông: gợi ý 2-3 băng dính');
  } else if (infected && includesAny(profileText, LIMB_WORDS) && (!hasSurgery || medicationContext.hasDressing)) {
    addRequirement(requirementMap, SUPPLY_KEYS.ELASTIC_BANDAGE, 1, hasSurgery ? 'Nhiễm trùng vùng chi sau mổ có y lệnh thay băng' : 'Nhiễm trùng vùng chi chưa mổ');
  }
}

function finalizeRequirements(requirementMap, existingMap) {
  return Array.from(requirementMap.values()).map(item => {
    const existing = number(existingMap.get(item.code), 0);
    const required = number(item.required_quantity, 0);
    const missing = Math.max(0, required - existing);
    const excess = Math.max(0, existing - required);
    const warnings = [...item.warnings];
    if (excess > 2) warnings.push(`Đang dư ${excess}; cần kiểm tra lại trước khi nhập.`);
    return {
      ...item,
      required_quantity: required,
      existing_quantity: existing,
      missing_quantity: missing,
      excess_quantity: excess,
      input_quantity: missing,
      selected: missing > 0,
      status: missing > 0 ? 'missing' : (excess > 2 ? 'excess' : 'enough'),
      warnings,
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
}

function safeJobHasContent(job) {
  return (Array.isArray(job?.drugs) && job.drugs.length > 0)
    || (Array.isArray(job?.supplies) && job.supplies.length > 0)
    || (Array.isArray(job?.orders) && job.orders.some(order => Array.isArray(order?.items) && order.items.length > 0));
}

export function buildHchanhVtytBatchDraft({ previewResult = {}, cards = [] } = {}) {
  const cardsById = new Map(cards.map(card => [String(card?.ma_bn || card?.patient_id || card?.id || '').trim(), card]));
  const rawJobs = Array.isArray(previewResult?.plan) && previewResult.plan.length ? previewResult.plan : (previewResult?.full_plan || []);
  const oralByPatient = new Map();
  const existingPillBoxByPatient = new Map();
  const staged = [];

  for (const rawJob of rawJobs) {
    const job = { ...rawJob };
    const patientId = String(job.ma_bn || '').trim();
    const card = cardsById.get(patientId) || {};
    const requirements = new Map();
    const medicationContext = job.no_orders
      ? { hasOral: false, hasDressing: false, orderText: '' }
      : applyMedicationRules(job, requirements);
    // Quy tắc hậu phẫu/nhiễm trùng áp dụng theo từng ngày trong toàn đợt,
    // kể cả ngày không có y lệnh thuốc.
    applySurgeryAndInfectionRules(job, card, requirements, medicationContext);
    const existingMap = existingSupplyMap(job);
    if (medicationContext.hasOral) oralByPatient.set(patientId, true);
    if ((existingMap.get(SUPPLY_KEYS.PILL_BOX.code) || 0) > 0) existingPillBoxByPatient.set(patientId, true);
    staged.push({ ...job, card, requirements, existingMap, medicationContext });
  }

  for (const [patientId, hasOral] of oralByPatient.entries()) {
    if (!hasOral || existingPillBoxByPatient.get(patientId)) continue;
    const candidates = staged.filter(item => String(item.ma_bn || '').trim() === patientId && item.medicationContext.hasOral);
    const target = candidates.sort((a, b) => (parseDate(b.ngay_lam)?.getTime() || 0) - (parseDate(a.ngay_lam)?.getTime() || 0))[0];
    if (target) addRequirement(target.requirements, SUPPLY_KEYS.PILL_BOX, 1, 'Có thuốc uống và từ đầu đợt điều trị chưa thấy hộp phân liều');
  }

  const patient_dates = {};
  for (const item of staged) {
    const id = String(item.ma_bn || '').trim();
    if (!id) continue;
    if (!patient_dates[id]) patient_dates[id] = [];
    if (item.ngay_lam && !patient_dates[id].includes(item.ngay_lam)) patient_dates[id].push(item.ngay_lam);
  }

  const jobs = staged.map(item => {
    const supplies = finalizeRequirements(item.requirements, item.existingMap);
    return {
      ...item,
      card: undefined,
      requirements: undefined,
      existingMap: undefined,
      medicationContext: undefined,
      original_supplies: item.supplies || [],
      supplies,
      reviewed: false,
    };
  }).filter(job => safeJobHasContent(job));

  const patients = cards.map(card => {
    const patientId = String(card?.ma_bn || card?.patient_id || card?.id || '').trim();
    const patientJobs = jobs.filter(job => String(job.ma_bn || '').trim() === patientId);
    return {
      ma_bn: patientId,
      ho_ten: card?.ho_ten || card?.name || '',
      phong: card?.phong || card?.so_phong || '',
      reviewed: false,
      job_count: patientJobs.length,
    };
  }).filter(patient => patient.ma_bn && Array.isArray(patient_dates[patient.ma_bn]) && patient_dates[patient.ma_bn].length > 0);

  return {
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    precheck_token: previewResult?.precheck_token || '',
    precheck_expires_at: previewResult?.precheck_expires_at || '',
    // Giữ đúng toàn bộ phạm vi BN đã quét để token precheck khi nhập khớp
    // tuyệt đối, kể cả BN không phát sinh vật tư cần nhập.
    selected_patient_ids: [...new Set(cards.map(card => String(card?.ma_bn || card?.patient_id || card?.id || '').trim()).filter(Boolean))],
    patient_dates,
    patients,
    jobs,
    failed: previewResult?.failed || {},
  };
}

export function catalogSuggestions(query = '') {
  const q = norm(query);
  const rows = q
    ? HCHANH_VTYT_ITEMS.filter(item => norm(`${item.code} ${item.name}`).includes(q))
    : HCHANH_VTYT_ITEMS;
  return rows.slice(0, 30);
}
