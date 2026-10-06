// server/routes/medication_catalog.js
// Quản lý danh mục thuốc (config/medication_catalog.json) — tên chuẩn, alias,
// hoạt chất, hàm lượng/thể tích mặc định — dùng cho worker và nghiên cứu.
// GET    /api/medication-catalog          → đọc toàn bộ danh mục
// POST   /api/medication-catalog          → thêm thuốc mới
// POST   /api/medication-catalog/resolve-active-ingredients → đổi hoạt chất thành các tên có thể gặp trong EMR
// GET    /api/medication-catalog/archive-drug-names → tên thuốc trong kho + đã/chưa gắn hoạt chất
// POST   /api/medication-catalog/assign-ingredient  → gắn một hoạt chất cho nhiều tên thuốc
// POST   /api/medication-catalog/dilution-check  → quy tắc pha đang áp dụng + kiểm tra thử (chạy worker)
// GET    /api/medication-catalog/dilution-stats → cách pha thực tế trong dữ liệu đã có (Kho nghiên cứu + phiên)
// GET    /api/medication-catalog/builtin → kiến thức thuốc sẵn có (config/medication_builtin.json, chỉ đọc)
// PATCH  /api/medication-catalog/:key     → sửa thuốc đã có (key = canonical)
// DELETE /api/medication-catalog/:key     → xoá thuốc

'use strict';

const router = require('express').Router();
const path   = require('path');

const { readJsonSafe, writeJsonAtomic } = require('../utils/file');
const { getRuntimePaths } = require('../services/session');
const { appendActivity } = require('../services/activity_logger');
const routeModel = require('../utils/routeModel');
const fs     = require('fs');
const os     = require('os');
const crypto = require('crypto');
const { runScript, fmtPyError } = require('../services/python_runner');
const { resolveIngredientTargets } = require('../research/medication_ingredient_catalog');
const { buildDrugNameInventory, assignIngredientToNames } = require('../research/drug_name_inventory');
const { readCsvTable } = require('../research/table_io');
const { archiveRunsDir } = require('../research/store_paths');
const { resolveArchiveRunId } = require('../research/run_registry');

const CATALOG_PATH = path.join(__dirname, '..', '..', 'config', 'medication_catalog.json');

function loadCatalog() {
  const data = readJsonSafe(CATALOG_PATH, null);
  if (!data || typeof data !== 'object') throw new Error(`Không đọc được ${CATALOG_PATH}`);
  if (!Array.isArray(data.medications)) data.medications = [];
  return data;
}

function saveCatalog(data) {
  data._updated = new Date().toISOString().slice(0, 10);
  writeJsonAtomic(CATALOG_PATH, data);
}

function keyOf(med) {
  return String(med?.canonical || '').trim();
}

function normalizeStringList(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,;\n]/)
      : [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const text = String(item || '').trim();
    const key = text.toLocaleLowerCase('vi-VN');
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

// Đường dùng cho phép: mã chuẩn theo model đường dùng chung, bỏ trùng, bỏ mã lạ.
// Y lệnh ghi đường dùng ngoài danh sách này → worker cảnh báo ROUTE_MISMATCH.
function normalizeRouteList(value) {
  const out = [];
  for (const item of normalizeStringList(value)) {
    const code = routeModel.normalizeRouteCode(item);
    if (code && !out.includes(code)) out.push(code);
  }
  return out;
}

function normalizeDefaultRoute(value) {
  const raw = String(value || '').trim();
  return routeModel.normalizeRouteCode(raw) || raw;
}

// Quy tắc pha thuốc (worker dựa vào khi y lệnh không ghi rõ dung môi/thể tích — xem
// worker/processing/medication_catalog.py catalog_dilution_rule). Dung môi theo mã cố định.
// config/solvents.json: một nguồn với worker và giao diện.
const DILUTION_SOLVENTS = Object.fromEntries(
  ((readJsonSafe(path.join(__dirname, '..', '..', 'config', 'solvents.json'), {}) || {}).solvents || [])
    .filter(x => x && x.code && x.label && x.in_rule).map(x => [x.code, x.label]),
);
const DILUTION_APPLY = ['always', 'infusion_only'];

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// null/'' → bỏ quy tắc; sai dữ liệu → lỗi tiếng Việt.
function normalizeDilution(value) {
  if (value == null || value === '' || (typeof value === 'object' && !value.solvent)) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw badRequest('Quy tắc pha không hợp lệ.');
  const solvent = String(value.solvent || '').trim().toUpperCase();
  if (!DILUTION_SOLVENTS[solvent]) throw badRequest(`Dung môi pha không hợp lệ. Chọn: ${Object.values(DILUTION_SOLVENTS).join(', ')}.`);
  const out = { solvent };
  if (solvent !== 'KHONG_PHA') {
    const raw = value.volume_ml;
    if (raw !== '' && raw != null) {
      const n = Number(String(raw).replace(',', '.'));
      if (!Number.isFinite(n) || n <= 0 || n > 1000) throw badRequest('Thể tích pha phải là số ml từ 1 đến 1000.');
      out.volume_ml = n;
    }
    const apply = String(value.apply || 'always').trim();
    out.apply = DILUTION_APPLY.includes(apply) ? apply : 'always';
    const rawRate = value.rate;
    if (rawRate !== '' && rawRate != null) {
      const r = Number(String(rawRate).replace(',', '.'));
      if (!Number.isFinite(r) || r <= 0 || r > 300) throw badRequest('Tốc độ truyền phải là số giọt/phút từ 1 đến 300.');
      out.rate = r;
    }
  }
  const note = String(value.note || '').trim().slice(0, 300);
  if (note) out.note = note;
  if (solvent !== 'KHONG_PHA' && Array.isArray(value.variants) && value.variants.length) {
    if (value.variants.length > 10) throw badRequest('Tối đa 10 cách pha cho một thuốc.');
    const variants = value.variants.map((v, i) => normalizeVariant(v, i + 1)).filter(Boolean);
    if (variants.length) out.variants = variants;
  }
  return out;
}

const ROUTE_CODE = /^[A-Z_]{1,20}$/;

// Một "cách pha" có điều kiện (đường dùng và/hoặc khoảng liều mỗi lần, mg). Worker chọn cách khớp
// với y lệnh; không chắc thì đánh dấu "cần xác nhận cách pha" (medication_catalog.resolve_dilution_for_drug).
function normalizeVariant(v, n) {
  if (!v || typeof v !== 'object') return null;
  const solvent = String(v.solvent || '').trim().toUpperCase();
  if (!solvent) return null;
  if (!DILUTION_SOLVENTS[solvent] || solvent === 'KHONG_PHA') throw badRequest(`Cách pha ${n}: dung môi không hợp lệ.`);
  const out = { solvent };
  const route = String(v.route || '').trim().toUpperCase();
  if (route) {
    if (!ROUTE_CODE.test(route)) throw badRequest(`Cách pha ${n}: đường dùng không hợp lệ.`);
    out.route = route;
  }
  const num = (raw, label, max) => {
    if (raw === '' || raw == null) return undefined;
    const x = Number(String(raw).replace(',', '.'));
    if (!Number.isFinite(x) || x <= 0 || x > max) throw badRequest(`Cách pha ${n}: ${label} không hợp lệ.`);
    return x;
  };
  const lo = num(v.dose_min_mg, 'liều từ (mg)', 1e6);
  const hi = num(v.dose_max_mg, 'liều đến (mg)', 1e6);
  if (lo !== undefined && hi !== undefined && lo > hi) throw badRequest(`Cách pha ${n}: "liều từ" lớn hơn "liều đến".`);
  if (lo !== undefined) out.dose_min_mg = lo;
  if (hi !== undefined) out.dose_max_mg = hi;
  if (!out.route && lo === undefined && hi === undefined) throw badRequest(`Cách pha ${n}: cần ít nhất một điều kiện (đường dùng hoặc liều).`);
  const vol = num(v.volume_ml, 'thể tích (ml)', 1000);
  if (vol !== undefined) out.volume_ml = vol;
  const rate = num(v.rate, 'tốc độ (giọt/phút)', 300);
  if (rate !== undefined) out.rate = rate;
  const note = String(v.note || '').trim().slice(0, 200);
  if (note) out.note = note;
  return out;
}

function pruneEmpty(med) {
  for (const k of Object.keys(med)) {
    const v = med[k];
    if (v === '' || v === undefined || v === null || (Array.isArray(v) && !v.length)) delete med[k];
  }
  return med;
}

// GET /api/medication-catalog
router.get('/medication-catalog', (req, res) => {
  try {
    const data = loadCatalog();
    return res.json({ status: 'ok', medications: data.medications.map(med => ({ ...med, key: keyOf(med) })) });
  } catch (e) {
    return res.status(500).json({ status: 'error', message: String(e.message) });
  }
});

// POST /api/medication-catalog/resolve-active-ingredients
// Dùng cho nghiên cứu: người dùng chọn một hoặc nhiều hoạt chất, server trả toàn bộ tên chuẩn/alias
// đã khai báo trong danh mục. Không đồng nghĩa với "đã dùng thuốc"; đây chỉ là từ khóa nhận diện.
router.post('/medication-catalog/resolve-active-ingredients', (req, res) => {
  try {
    const activeIngredients = normalizeStringList(req.body?.active_ingredients).slice(0, 100);
    if (!activeIngredients.length) {
      return res.status(400).json({ status: 'error', message: 'Cần ít nhất một hoạt chất.' });
    }
    const data = loadCatalog();
    const resolved = resolveIngredientTargets(activeIngredients, data.medications);
    return res.json({ status: 'ok', ...resolved });
  } catch (e) {
    return res.status(500).json({ status: 'error', message: String(e.message) });
  }
});

// GET /api/medication-catalog/archive-drug-names
// Tên thuốc (tên thương mại như EMR ghi) trong y lệnh của kho, gom theo tên, kèm số lượt/người bệnh
// và trạng thái: đã nhận ra hoạt chất / có trong danh mục nhưng chưa ghi hoạt chất / chưa có trong danh mục.
router.get('/medication-catalog/archive-drug-names', (req, res) => {
  try {
    const runId = resolveArchiveRunId(String(req.query.runId || 'latest'));
    const file = runId ? path.join(archiveRunsDir(), runId, 'medication_orders.csv') : '';
    if (!file || !fs.existsSync(file)) {
      return res.json({ status: 'ok', run_id: runId || '', counts: { total: 0, mapped: 0, catalog_no_ingredient: 0, not_in_catalog: 0 }, unmapped_encounters: 0, items: [] });
    }
    const rows = readCsvTable(file, Number.MAX_SAFE_INTEGER).rows || [];
    const inventory = buildDrugNameInventory(rows, loadCatalog().medications);
    return res.json({ status: 'ok', run_id: runId, ...inventory });
  } catch (e) {
    return res.status(500).json({ status: 'error', message: String(e.message) });
  }
});

// POST /api/medication-catalog/assign-ingredient { active_ingredient, items: [{ name, catalog_keys }] }
// Thuốc đã có trong danh mục thì thêm hoạt chất; chưa có thì tạo mới với tên chuẩn = tên thuốc trong EMR.
router.post('/medication-catalog/assign-ingredient', (req, res) => {
  try {
    const ctx = getRuntimePaths(req);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ status: 'error', message: 'Chọn ít nhất một tên thuốc.' });
    const data = loadCatalog();
    const changes = assignIngredientToNames(data.medications, items, req.body?.active_ingredient);
    data.medications = data.medications.map(pruneEmpty);
    saveCatalog(data);
    appendActivity(ctx, { kind: 'medication_catalog.assign_ingredient', active_ingredient: String(req.body?.active_ingredient || '').trim(), count: changes.length });
    return res.json({ status: 'ok', changes });
  } catch (e) {
    return res.status(e.status || 500).json({ status: 'error', message: String(e.message) });
  }
});

// POST /api/medication-catalog — thêm thuốc mới
router.post('/medication-catalog', (req, res) => {
  try {
    const ctx = getRuntimePaths(req);
    const body = req.body || {};
    const canonical = String(body.canonical || '').trim();
    if (!canonical) return res.status(400).json({ status: 'error', message: 'Cần nhập tên chuẩn (canonical).' });

    const data = loadCatalog();
    if (data.medications.some(m => keyOf(m).toLowerCase() === canonical.toLowerCase())) {
      return res.status(409).json({ status: 'error', message: `Đã có thuốc với tên chuẩn "${canonical}".` });
    }

    const volumeRaw = body.default_volume_ml;
    const volumeNum = Number(volumeRaw);
    const med = pruneEmpty({
      canonical,
      active_ingredients: normalizeStringList(body.active_ingredients ?? body.active_ingredient),
      aliases: normalizeStringList(body.aliases),
      semantic_aliases: normalizeStringList(body.semantic_aliases),
      category: String(body.category || '').trim(),
      default_route: normalizeDefaultRoute(body.default_route),
      routes: normalizeRouteList(body.routes),
      default_route_text: String(body.default_route_text || '').trim(),
      default_volume_ml: (volumeRaw === '' || volumeRaw == null || !Number.isFinite(volumeNum)) ? undefined : volumeNum,
      default_rate: String(body.default_rate ?? '').trim(),
      default_rate_text: String(body.default_rate_text || '').trim(),
      schedule_rule: String(body.schedule_rule || '').trim(),
      dilution: normalizeDilution(body.dilution),
      ten_hien_thi: String(body.ten_hien_thi || '').trim().slice(0, 200),
      co_dung_moi_di_kem: body.co_dung_moi_di_kem === true ? true : undefined,
      // Sửa/thêm tay → bước tự học từ dữ liệu (sync_catalog_from_processed_records) không ghi đè.
      sua_tay: true,
    });

    data.medications.push(med);
    saveCatalog(data);
    appendActivity(ctx, { kind: 'medication_catalog.create', canonical });
    return res.json({ status: 'ok', medication: { ...med, key: canonical } });
  } catch (e) {
    return res.status(e.status || 500).json({ status: 'error', message: String(e.message) });
  }
});

// Kiểm tra quy tắc pha: chạy worker/dilution_check.py — ĐÚNG hàm bước xử lý dữ liệu dùng, nên
// điều màn hình nói khớp điều xử lý làm. Không mở EMR, không ghi gì.
function cleanCheckItems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 20).filter(x => x && typeof x === 'object').map(x => {
    const out = {};
    for (const k of ['ten_thuoc', 'hoat_chat', 'dang', 'duong_dung_goc', 'gio_dung', 'toc_do', 'so_luong']) {
      const v = String(x[k] ?? '').trim().slice(0, 300);
      if (v) out[k] = v;
    }
    return out;
  });
}

async function runDilutionCheck(ctx, payload) {
  const tag = crypto.randomBytes(6).toString('hex');
  const inFile = path.join(os.tmpdir(), `dilution_check_${tag}_in.json`);
  const outFile = path.join(os.tmpdir(), `dilution_check_${tag}_out.json`);
  try {
    fs.writeFileSync(inFile, JSON.stringify(payload), 'utf8');
    const result = await runScript('dilution_check.py', ['--in', inFile, '--out', outFile], {
      runtimeDir: ctx?.dir, extraEnv: {},
    });
    if (result.code !== 0 || !fs.existsSync(outFile)) {
      const err = new Error(fmtPyError('Không kiểm tra được quy tắc pha. Thử lại; nếu vẫn lỗi, khởi động lại máy chủ.', result));
      err.status = 500;
      throw err;
    }
    return JSON.parse(fs.readFileSync(outFile, 'utf8'));
  } finally {
    for (const f of [inFile, outFile]) { try { fs.unlinkSync(f); } catch (_) { /* đã xoá */ } }
  }
}

// Kiến thức thuốc sẵn có: hiện ở mục "Sẵn có" để người dùng thấy và chép vào Danh mục để sửa.
// Ứng dụng không ghi file này (cập nhật theo phiên bản), nên sửa trong Danh mục thuốc.
const BUILTIN_PATH = path.join(__dirname, '..', '..', 'config', 'medication_builtin.json');
router.get('/medication-catalog/builtin', (req, res) => {
  const data = readJsonSafe(BUILTIN_PATH, null);
  if (!data || typeof data !== 'object') {
    return res.status(500).json({ status: 'error', message: 'Không đọc được kiến thức thuốc sẵn có (config/medication_builtin.json). Cập nhật lại bản cài đặt.' });
  }
  return res.json({ status: 'ok', builtin: data });
});

// Cách pha thực tế: worker/dilution_stats.py chạy lại ĐÚNG bước xử lý thuốc trên y lệnh nguyên văn của
// Kho nghiên cứu (clinical_notes.csv) + dữ liệu đã xử lý của phiên. Không mở EMR. Kết quả lưu đệm theo
// thời điểm sửa của dữ liệu/danh mục, nên chỉ tính lại khi có gì đổi.
const statsInFlight = new Map();
function fileSig(file) {
  try { const st = fs.statSync(file); return `${st.size}:${Math.round(st.mtimeMs)}`; } catch (_) { return '-'; }
}

async function computeDilutionStats(ctx, { refresh = false } = {}) {
  const runId = resolveArchiveRunId('latest');
  const notes = runId ? path.join(archiveRunsDir(), runId, 'clinical_notes.csv') : '';
  const processed = ctx?.PROCESSED_PATH || '';
  const key = [notes, fileSig(notes), processed, fileSig(processed), fileSig(CATALOG_PATH), fileSig(BUILTIN_PATH)].join('|');
  const cacheFile = path.join(ctx.dir, 'dilution_stats_cache.json');
  const cached = readJsonSafe(cacheFile, null);
  if (!refresh && cached && cached.key === key) return cached.data;
  if (statsInFlight.has(key)) return statsInFlight.get(key);
  const job = (async () => {
    const outFile = path.join(os.tmpdir(), `dilution_stats_${crypto.randomBytes(6).toString('hex')}.json`);
    try {
      const args = ['--out', outFile];
      if (notes && fs.existsSync(notes)) args.push('--notes', notes);
      if (processed && fs.existsSync(processed)) args.push('--processed', processed);
      const result = await runScript('dilution_stats.py', args, { runtimeDir: ctx.dir });
      if (result.code !== 0 || !fs.existsSync(outFile)) {
        const err = new Error(fmtPyError('Không thống kê được cách pha thực tế. Thử lại sau; nếu vẫn lỗi, khởi động lại máy chủ.', result));
        err.status = 500;
        throw err;
      }
      const data = { ...JSON.parse(fs.readFileSync(outFile, 'utf8')), run_id: runId || '', computed_at: new Date().toISOString() };
      try { writeJsonAtomic(cacheFile, { key, data }); } catch (_) { /* đệm không ghi được vẫn trả kết quả */ }
      return data;
    } finally {
      try { fs.unlinkSync(outFile); } catch (_) { /* đã xoá */ }
      statsInFlight.delete(key);
    }
  })();
  statsInFlight.set(key, job);
  return job;
}

router.get('/medication-catalog/dilution-stats', async (req, res) => {
  try {
    const ctx = getRuntimePaths(req);
    const data = await computeDilutionStats(ctx, { refresh: String(req.query.refresh || '') === '1' });
    return res.json({ status: 'ok', ...data });
  } catch (e) {
    return res.status(e.status || 500).json({ status: 'error', message: String(e.message) });
  }
});

router.post('/medication-catalog/dilution-check', async (req, res) => {
  try {
    const ctx = getRuntimePaths(req);
    const body = req.body || {};
    const items = cleanCheckItems(body.items);
    const catalogNames = body.include_catalog
      ? loadCatalog().medications.map(m => String(m?.canonical || '').trim()).filter(Boolean)
      : [];
    const data = await runDilutionCheck(ctx, { items, catalog_names: catalogNames });
    return res.json({ status: 'ok', ...data });
  } catch (e) {
    return res.status(e.status || 500).json({ status: 'error', message: String(e.message) });
  }
});

// PATCH /api/medication-catalog/:key — sửa thuốc đã có
router.patch('/medication-catalog/:key', (req, res) => {
  try {
    const ctx = getRuntimePaths(req);
    const { key } = req.params;
    const data = loadCatalog();
    const idx = data.medications.findIndex(m => keyOf(m) === key);
    if (idx === -1) return res.status(404).json({ status: 'error', message: `Không tìm thấy thuốc: ${key}` });

    const body = req.body || {};
    const med = { ...data.medications[idx] };

    if (body.canonical !== undefined) {
      const nextCanonical = String(body.canonical || '').trim();
      if (!nextCanonical) return res.status(400).json({ status: 'error', message: 'Tên chuẩn không được để trống.' });
      const clashes = data.medications.some((m, i) => i !== idx && keyOf(m).toLowerCase() === nextCanonical.toLowerCase());
      if (clashes) return res.status(409).json({ status: 'error', message: `Đã có thuốc với tên chuẩn "${nextCanonical}".` });
      med.canonical = nextCanonical;
    }
    if (body.active_ingredients !== undefined || body.active_ingredient !== undefined) {
      med.active_ingredients = normalizeStringList(body.active_ingredients ?? body.active_ingredient);
      delete med.active_ingredient;
    }
    if (body.aliases !== undefined) med.aliases = normalizeStringList(body.aliases);
    if (body.semantic_aliases !== undefined) med.semantic_aliases = normalizeStringList(body.semantic_aliases);
    if (body.category !== undefined) med.category = String(body.category || '').trim();
    if (body.default_route !== undefined) med.default_route = normalizeDefaultRoute(body.default_route);
    if (body.routes !== undefined) med.routes = normalizeRouteList(body.routes);
    if (body.default_route_text !== undefined) med.default_route_text = String(body.default_route_text || '').trim();
    if (body.default_volume_ml !== undefined) {
      if (body.default_volume_ml === '' || body.default_volume_ml === null) {
        delete med.default_volume_ml;
      } else {
        const n = Number(body.default_volume_ml);
        if (Number.isFinite(n)) med.default_volume_ml = n;
      }
    }
    if (body.default_rate !== undefined) med.default_rate = String(body.default_rate ?? '').trim();
    if (body.default_rate_text !== undefined) med.default_rate_text = String(body.default_rate_text || '').trim();
    if (body.schedule_rule !== undefined) med.schedule_rule = String(body.schedule_rule || '').trim();
    if (body.dilution !== undefined) {
      const dilution = normalizeDilution(body.dilution);
      if (dilution) med.dilution = dilution; else delete med.dilution;
    }

    if (body.ten_hien_thi !== undefined) med.ten_hien_thi = String(body.ten_hien_thi || '').trim().slice(0, 200);
    if (body.co_dung_moi_di_kem !== undefined) {
      if (body.co_dung_moi_di_kem === true) med.co_dung_moi_di_kem = true; else delete med.co_dung_moi_di_kem;
    }
    med.sua_tay = true;
    data.medications[idx] = pruneEmpty(med);
    saveCatalog(data);
    appendActivity(ctx, { kind: 'medication_catalog.update', key, canonical: med.canonical });
    return res.json({ status: 'ok', medication: { ...data.medications[idx], key: keyOf(data.medications[idx]) } });
  } catch (e) {
    return res.status(e.status || 500).json({ status: 'error', message: String(e.message) });
  }
});

// DELETE /api/medication-catalog/:key
router.delete('/medication-catalog/:key', (req, res) => {
  try {
    const ctx = getRuntimePaths(req);
    const { key } = req.params;
    const data = loadCatalog();
    const idx = data.medications.findIndex(m => keyOf(m) === key);
    if (idx === -1) return res.status(404).json({ status: 'error', message: `Không tìm thấy thuốc: ${key}` });
    data.medications.splice(idx, 1);
    saveCatalog(data);
    appendActivity(ctx, { kind: 'medication_catalog.delete', key });
    return res.json({ status: 'ok', key });
  } catch (e) {
    return res.status(500).json({ status: 'error', message: String(e.message) });
  }
});

module.exports = router;
module.exports.normalizeDilution = normalizeDilution;
module.exports.cleanCheckItems = cleanCheckItems;
module.exports.runDilutionCheck = runDilutionCheck;
module.exports.computeDilutionStats = computeDilutionStats;
module.exports.DILUTION_SOLVENTS = DILUTION_SOLVENTS;
