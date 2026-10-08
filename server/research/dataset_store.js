'use strict';

// Dataset cuối: tạo, lưu bản bất biến có checksum (datasets/), kiểm tra, dọn dữ liệu sinh ra.

const path = require('path');
const fs = require('fs');
const { readJsonSafe, ensureDir, nowFileStamp, writeJsonAtomic, writeFileAtomic } = require('../utils/file');
const quality = require('./quality');
const { RESEARCH_PROCESS_INSTANCE_ID, buildCoverageSummary } = require('./progress_snapshot');
const collection = require('./collection');
const crypto = require('crypto');
const { nowIso } = require('./store_paths');
const { readCsvTable, writeCsv } = require('./table_io');
const dataDictionary = require('./data_dictionary');
const { loadAnalysisConfig } = require('./analysis_presets');
const { ROOT_DIR } = require('../constants');
const { stableHash, normalizeSimple } = require('./encounter_context');
const { isSensitiveColumn, analysisDatasetColumns } = require('./export_utils');
const { forceSyncDatabaseAfterDerivedOutput } = require('./research_db');
const { mergeRowsPreferFilled } = require('./source_merge');

// Mỗi dataset cuối được lưu thành một phiên bản bất biến trong datasets/<tên>/ kèm
// dataset_manifest.json ghi cách tạo ra nó (nguồn, chữ ký input đã chuẩn hóa, phiên
// bản schema/code, cấu hình biến, yêu cầu dữ liệu và chọn biến của nghiên cứu, QA). File
// analysis_final.csv ở gốc run chỉ là bản "hiện hành" và có thể bị Chuẩn hóa gỡ đi.
//
// Ghi an toàn: mọi file được ghi vào thư mục tạm datasets/.tmp_<tên>_<ngẫu nhiên>/, kiểm
// lại SHA-256 từng file, ghi SHA256SUMS (có cả checksum của manifest), rồi mới đổi tên
// (rename, nguyên tử trên cùng ổ) thành thư mục chính thức. Thư mục chính thức vì vậy
// luôn là snapshot đã hoàn tất; thư mục tạm bị bỏ lại sau sự cố được dọn ở lần sau.
const DATASET_STAGING_PREFIX = '.tmp_';

const DATASET_SUMS_FILE = 'SHA256SUMS';

const DATASET_MANIFEST_FILE = 'dataset_manifest.json';

const DATASET_MANIFEST_VERSION = 2;

// Thư mục tạm của tiến trình khác có thể còn đang ghi: chỉ dọn khi đã cũ hơn ngưỡng này.
const DATASET_STAGING_STALE_MS = 10 * 60 * 1000;

function datasetSnapshotsDir(runDir) {
  return path.join(runDir, 'datasets');
}

function listDatasetSnapshots(runDir) {
  const dir = datasetSnapshotsDir(runDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => readJsonSafe(path.join(dir, e.name, DATASET_MANIFEST_FILE), null))
    .filter(Boolean)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

function parseSha256Sums(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (m) out[m[2]] = m[1];
  }
  return out;
}

// Kiểm tra một snapshot: valid | missing | modified. Chỉ đọc, KHÔNG sửa hay ghi đè gì.
function verifyDatasetSnapshot(runDir, name) {
  const dir = path.join(datasetSnapshotsDir(runDir), path.basename(String(name || '')));
  const result = { name: path.basename(String(name || '')), status: 'valid', legacy: false, files: [] };
  const check = (file, expected) => {
    const fp = path.join(dir, file);
    if (!fs.existsSync(fp)) { result.files.push({ file, status: 'missing', expected }); return; }
    const actual = quality.fileSha256(fp);
    result.files.push({ file, status: expected && actual !== expected ? 'modified' : 'valid', expected, actual });
  };
  if (!fs.existsSync(dir)) {
    result.status = 'missing';
    result.files.push({ file: '', status: 'missing' });
    return result;
  }
  const manifestPath = path.join(dir, DATASET_MANIFEST_FILE);
  const sumsPath = path.join(dir, DATASET_SUMS_FILE);
  const manifest = readJsonSafe(manifestPath, null);
  if (!fs.existsSync(manifestPath)) {
    result.files.push({ file: DATASET_MANIFEST_FILE, status: 'missing' });
  } else if (!manifest) {
    result.files.push({ file: DATASET_MANIFEST_FILE, status: 'modified', detail: 'manifest không đọc được' });
  }
  if (fs.existsSync(sumsPath)) {
    const sums = parseSha256Sums(fs.readFileSync(sumsPath, 'utf-8'));
    const expectedFiles = new Set([
      ...Object.keys(sums),
      ...Object.keys(manifest?.files || {}),
      DATASET_MANIFEST_FILE,
    ]);
    for (const file of expectedFiles) {
      const fromSums = sums[file];
      const fromManifest = manifest?.files?.[file]?.sha256;
      if (fromSums && fromManifest && fromSums !== fromManifest) {
        result.files.push({ file, status: 'modified', detail: 'SHA256SUMS và manifest ghi khác nhau' });
        continue;
      }
      if (!fromSums && !fromManifest) { result.files.push({ file, status: 'modified', detail: 'không có checksum' }); continue; }
      if (result.files.some(f => f.file === file)) continue;
      check(file, fromSums || fromManifest);
    }
  } else if (manifest && manifest.manifest_version >= DATASET_MANIFEST_VERSION) {
    result.files.push({ file: DATASET_SUMS_FILE, status: 'missing' });
    for (const [file, info] of Object.entries(manifest.files || {})) check(file, info.sha256);
  } else if (manifest) {
    // Snapshot tạo trước khi có SHA256SUMS: chỉ kiểm được CSV theo sha256 trong manifest.
    result.legacy = true;
    check(manifest.file || 'analysis_final.csv', manifest.sha256);
  }
  if (result.files.some(f => f.status === 'missing')) result.status = 'missing';
  if (result.files.some(f => f.status === 'modified')) result.status = 'modified';
  return result;
}

function verifyAllDatasetSnapshots(runDir) {
  const dir = datasetSnapshotsDir(runDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => verifyDatasetSnapshot(runDir, e.name));
}

// Dọn thư mục tạm bị bỏ lại sau sự cố. Không bao giờ đụng tới snapshot đã hoàn tất
// (thư mục không có tiền tố .tmp_).
function cleanupStaleDatasetStaging(runDir, { now = Date.now() } = {}) {
  const dir = datasetSnapshotsDir(runDir);
  if (!fs.existsSync(dir)) return [];
  const removed = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.startsWith(DATASET_STAGING_PREFIX)) continue;
    const fp = path.join(dir, e.name);
    let age = 0;
    try { age = now - fs.statSync(fp).mtimeMs; } catch (_) { continue; }
    const owner = readJsonSafe(path.join(fp, '.owner.json'), null);
    const fromThisProcess = owner?.process_instance_id === RESEARCH_PROCESS_INSTANCE_ID;
    // Ghi snapshot là đồng bộ: thư mục tạm của chính tiến trình này còn lại = đã hỏng.
    if (!fromThisProcess && age < DATASET_STAGING_STALE_MS) continue;
    fs.rmSync(fp, { recursive: true, force: true });
    removed.push(e.name);
  }
  return removed;
}

// Thông tin truy nguồn của nghiên cứu: yêu cầu dữ liệu, chọn biến.
// Kho gốc không có study.json → null.
function studyTraceInfo(studyMeta) {
  if (!studyMeta) return null;
  return {
    id: studyMeta.id,
    name: studyMeta.name,
    data_requirements: studyMeta.data_requirements || null,
    requirements: collection.requirementsFromStudy(studyMeta),
    variable_selection: studyMeta.variable_selection || studyMeta.analysis_config?.variable_selection || null,
  };
}

function writeDatasetSnapshot(runDir, { csvPath, kind, extra = {}, faults = null } = {}) {
  const crash = point => {
    if (faults?.crashAt === point) {
      const err = new Error(`SIMULATED_CRASH:${point}`);
      err.code = 'SIMULATED_CRASH';
      throw err;
    }
  };
  cleanupStaleDatasetStaging(runDir);
  const sha = quality.fileSha256(csvPath);
  // Chỉ dùng lại snapshot cùng nội dung khi nó còn nguyên vẹn. Snapshot sai checksum hay
  // thiếu file được giữ nguyên để điều tra; tạo snapshot mới bên cạnh.
  const existing = listDatasetSnapshots(runDir).find(m => m.sha256 === sha && verifyDatasetSnapshot(runDir, m.name).status === 'valid');
  if (existing) return existing;
  const manifest = readJsonSafe(path.join(runDir, 'manifest.json'), {}) || {};
  const studyRoot = path.dirname(path.dirname(runDir));
  const studyMeta = readJsonSafe(path.join(studyRoot, 'study.json'), null);
  const datasetsDir = datasetSnapshotsDir(runDir);
  ensureDir(datasetsDir);
  let name = `${kind}_${nowFileStamp()}_${sha.slice(0, 8)}`;
  if (fs.existsSync(path.join(datasetsDir, name))) name = `${name}_${crypto.randomBytes(3).toString('hex')}`;
  const staging = path.join(datasetsDir, `${DATASET_STAGING_PREFIX}${name}_${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    writeJsonAtomic(path.join(staging, '.owner.json'), { process_instance_id: RESEARCH_PROCESS_INSTANCE_ID, started_at: nowIso() });
    fs.copyFileSync(csvPath, path.join(staging, 'analysis_final.csv'));
    crash('after_csv');
    const table = readCsvTable(path.join(staging, 'analysis_final.csv'), Number.MAX_SAFE_INTEGER);
    // Mỗi dataset đi kèm đúng phiên bản từ điển dữ liệu đã dùng để tạo ra nó.
    writeJsonAtomic(path.join(staging, 'data_dictionary.json'), {
      version: dataDictionary.DICTIONARY_VERSION,
      conventions: dataDictionary.CONVENTIONS,
      tables: { analysis_ready: dataDictionary.TABLES.analysis_ready },
    });
    crash('after_dictionary');
    const files = {};
    for (const file of ['analysis_final.csv', 'data_dictionary.json']) {
      const fp = path.join(staging, file);
      files[file] = { sha256: quality.fileSha256(fp), bytes: fs.statSync(fp).size };
    }
    if (files['analysis_final.csv'].sha256 !== sha) {
      throw new Error('Bản sao analysis_final.csv khác bản gốc (file gốc thay đổi trong lúc sao chép).');
    }
    const analysisConfig = loadAnalysisConfig(runDir) || null;
    const snapshot = {
      name,
      kind,
      manifest_version: DATASET_MANIFEST_VERSION,
      created_at: nowIso(),
      run_id: path.basename(runDir),
      file: 'analysis_final.csv',
      sha256: sha,
      files,
      rows: table.rows.length,
      columns: table.columns,
      normalized_input_signature: manifest.normalized_input_signature || '',
      normalized_schema_version: manifest.normalized_schema_version || '',
      normalized_at: manifest.normalized_at || '',
      code_version: quality.codeVersion(ROOT_DIR),
      analysis_config: analysisConfig,
      variable_selection_hash: stableHash(analysisConfig?.variable_selection || null),
      study: studyTraceInfo(studyMeta),
      qa: manifest.normalized_qa || null,
      data_dictionary_version: dataDictionary.DICTIONARY_VERSION,
      data_dictionary_sha256: files['data_dictionary.json'].sha256,
      ...extra,
    };
    writeJsonAtomic(path.join(staging, DATASET_MANIFEST_FILE), snapshot);
    crash('after_manifest');
    const sums = {
      ...Object.fromEntries(Object.entries(files).map(([f, info]) => [f, info.sha256])),
      [DATASET_MANIFEST_FILE]: quality.fileSha256(path.join(staging, DATASET_MANIFEST_FILE)),
    };
    writeFileAtomic(path.join(staging, DATASET_SUMS_FILE), Object.entries(sums).map(([f, h]) => `${h}  ${f}`).join('\n') + '\n', 'utf-8');
    // Kiểm lại toàn bộ trên đĩa trước khi công nhận.
    for (const [file, expected] of Object.entries(sums)) {
      if (quality.fileSha256(path.join(staging, file)) !== expected) throw new Error(`Snapshot tạm lỗi checksum: ${file}`);
    }
    crash('before_rename');
    // Bỏ dấu sở hữu ngay trước khi đổi tên để snapshot chính thức chỉ có file đã ghi checksum.
    fs.rmSync(path.join(staging, '.owner.json'), { force: true });
    fs.renameSync(staging, path.join(datasetsDir, name));
    return snapshot;
  } catch (err) {
    // Lỗi thật (không phải dừng mô phỏng): bỏ thư mục tạm, snapshot chính thức không bị đụng.
    if (err.code !== 'SIMULATED_CRASH') fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

function snapshotFinalDatasetIfUnsaved(runDir, kind) {
  const csvPath = path.join(runDir, 'analysis_final.csv');
  if (!fs.existsSync(csvPath)) return null;
  try {
    return writeDatasetSnapshot(runDir, { csvPath, kind });
  } catch (err) {
    // Không lưu được bản sao thì không được gỡ file: dừng Chuẩn hóa để giữ dữ liệu.
    const e = new Error(`Không lưu được bản sao analysis_final.csv trước khi chuẩn hóa lại: ${err.message}`);
    e.status = 500;
    throw e;
  }
}

function finalizeAnalysisDataset(runDir) {
  const coverage = buildCoverageSummary(runDir);
  if (!coverage.exists) {
    const err = new Error('Chưa có run để tạo dataset cuối.');
    err.status = 400;
    throw err;
  }
  if (!coverage.final_dataset_ready) {
    const err = new Error(`Chưa thể tạo dataset cuối: ${coverage.blockers.join(' ')}`);
    err.status = 409;
    err.coverage = coverage;
    throw err;
  }
  const selectedSrc = path.join(runDir, 'analysis_selected.csv');
  const readySrc = path.join(runDir, 'analysis_ready.csv');
  const src = fs.existsSync(selectedSrc) ? selectedSrc : readySrc;
  const dst = path.join(runDir, 'analysis_final.csv');
  const table = readCsvTable(src, Number.MAX_SAFE_INTEGER);
  const rows = (table.rows || []).filter(row => !String(row.needs_manual_review || '').trim());
  // Giữ Mã BN để đối chiếu hồ sơ theo yêu cầu; các định danh trực tiếp khác vẫn bị loại.
  // patient_key vẫn đi kèm để nối dữ liệu qua các bảng đã ẩn danh.
  const finalColumns = analysisDatasetColumns(table.columns || []);
  writeCsv(dst, finalColumns, rows);
  const manifestPath = path.join(runDir, 'manifest.json');
  const manifest = readJsonSafe(manifestPath, {});
  const outputs = { ...(manifest.outputs || {}), analysis_final: rows.length };
  const snapshot = writeDatasetSnapshot(runDir, {
    csvPath: dst,
    kind: 'final',
    extra: {
      source_file: path.basename(src),
      source_sha256: quality.fileSha256(src),
      excluded_manual_review_rows: (table.rows || []).length - rows.length,
      rule: 'Lấy từ analysis_selected.csv (nếu có) hoặc analysis_ready.csv, bỏ các dòng needs_manual_review; giữ patient_code để đối chiếu hồ sơ, loại các định danh trực tiếp khác.',
    },
  });
  writeJsonAtomic(manifestPath, {
    ...manifest,
    outputs,
    final_dataset_created_at: nowIso(),
    final_dataset_source: path.basename(src),
    final_dataset_snapshot: snapshot.name,
  });
  let database = null;
  let database_warning = '';
  try {
    database = forceSyncDatabaseAfterDerivedOutput(runDir);
  } catch (err) {
    database_warning = String(err?.message || err);
    console.warn('[RESEARCH][SQLITE] Dataset cuối đã tạo nhưng chưa sync SQLite:', database_warning);
  }
  return { count: rows.length, source: path.basename(src), coverage: buildCoverageSummary(runDir), database, database_warning };
}

function pathSizeBytes(targetPath) {
  try {
    const st = fs.statSync(targetPath);
    if (st.isDirectory()) {
      return fs.readdirSync(targetPath).reduce((sum, name) => sum + pathSizeBytes(path.join(targetPath, name)), 0);
    }
    return st.size || 0;
  } catch (_) {
    return 0;
  }
}

function removePathSafe(baseDir, relativePath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(baseDir, relativePath);
  if (!target.startsWith(base + path.sep)) return { path: relativePath, removed: false, bytes: 0, skipped: true };
  const bytes = pathSizeBytes(target);
  try {
    if (!fs.existsSync(target)) return { path: relativePath, removed: false, bytes: 0 };
    fs.rmSync(target, { recursive: true, force: true });
    return { path: relativePath, removed: true, bytes };
  } catch (err) {
    return { path: relativePath, removed: false, bytes: 0, error: err.message };
  }
}

function dedupeRowsByHash(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const key = row.row_hash || stableHash(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function dedupeRowsByStableKey(rows, keyColumns = []) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const key = keyColumns.length
      ? keyColumns.map(col => String(row?.[col] ?? '').trim()).join('|')
      : stableHash(row || {});
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function dedupeSurgeryRows(rows) {
  const byKey = new Map();
  for (const row of rows || []) {
    const encounter = String(row?.encounter_id || row?.patient_code || '').trim();
    const time = String(row?.surgery_datetime || row?.surgery_date || '').trim().slice(0, 16);
    const procedure = normalizeSimple(row?.surgery_name || row?.surgery_method || '');
    const room = normalizeSimple(row?.operating_room || '');
    const key = [encounter, time, procedure, room].join('|');
    if (!key.replace(/\|/g, '')) continue;
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, { ...row });
      continue;
    }
    const merged = mergeRowsPreferFilled(current, row);
    merged.source = [...new Set([current.source, row.source].filter(Boolean).join(';').split(';').map(x => x.trim()).filter(Boolean))].join('; ');
    merged.row_hash = stableHash({ ...merged, source_run_id: undefined, source: undefined });
    merged.surgery_id = `surg_${merged.row_hash}`;
    byKey.set(key, merged);
  }
  return Array.from(byKey.values());
}

function cleanResearchGenerated(runDir, { encoded = true, debug = true, derived = false } = {}) {
  if (!runDir || !fs.existsSync(runDir)) {
    const err = new Error('Chưa có run để dọn dữ liệu.');
    err.status = 400;
    throw err;
  }
  const before_bytes = pathSizeBytes(runDir);
  const removed = [];
  if (encoded) removed.push(removePathSafe(runDir, ENCODED_DIRNAME));
  if (debug) {
    for (const item of RESEARCH_DEBUG_PATHS) removed.push(removePathSafe(runDir, item));
  }
  if (derived) {
    for (const item of RESEARCH_DERIVED_FILES) removed.push(removePathSafe(runDir, item));
  }
  const after_bytes = pathSizeBytes(runDir);
  const manifestPath = path.join(runDir, 'manifest.json');
  const manifest = readJsonSafe(manifestPath, {});
  writeJsonAtomic(manifestPath, {
    ...manifest,
    cleaned_generated_at: nowIso(),
    cleaned_generated_options: { encoded: Boolean(encoded), debug: Boolean(debug), derived: Boolean(derived) },
  });
  return {
    before_bytes,
    after_bytes,
    removed_bytes: Math.max(0, before_bytes - after_bytes),
    removed: removed.filter(x => x.removed || x.error || x.skipped),
  };
}

const ENCODED_DIRNAME = 'encoded';

const RESEARCH_DERIVED_FILES = [
  'patients.csv', 'encounters.csv', 'diagnoses.csv', 'lab_results.csv', 'imaging_results.csv',
  'surgery_results.csv', 'medication_orders.csv', 'medication_day_summary.csv', 'clinical_notes.csv', 'clinical_events.csv',
  'patient_day.csv', 'analysis_ready.csv', 'analysis_selected.csv', 'analysis_final.csv', 'extract_status.csv',
];

const RESEARCH_DEBUG_PATHS = [
  'hchanh_auto_raw', 'order_history_auto_raw',
  'resource_log.jsonl', 'browser_restarts.jsonl', 'browser_restart_status.json', 'action_log.txt',
];

module.exports = {
  DATASET_STAGING_PREFIX,
  DATASET_SUMS_FILE,
  DATASET_MANIFEST_FILE,
  DATASET_MANIFEST_VERSION,
  DATASET_STAGING_STALE_MS,
  datasetSnapshotsDir,
  listDatasetSnapshots,
  parseSha256Sums,
  verifyDatasetSnapshot,
  verifyAllDatasetSnapshots,
  cleanupStaleDatasetStaging,
  studyTraceInfo,
  writeDatasetSnapshot,
  snapshotFinalDatasetIfUnsaved,
  finalizeAnalysisDataset,
  pathSizeBytes,
  removePathSafe,
  dedupeRowsByHash,
  dedupeRowsByStableKey,
  dedupeSurgeryRows,
  cleanResearchGenerated,
  ENCODED_DIRNAME,
  RESEARCH_DERIVED_FILES,
  RESEARCH_DEBUG_PATHS,
};
