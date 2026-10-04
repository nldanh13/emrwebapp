'use strict';

// Nhật ký quy trình dữ liệu của một kho/nghiên cứu, cho tab Tổng quát: quét danh sách EMR →
// thu thập chi tiết → chuẩn hóa → lưu trữ. Chỉ đọc metadata đã ghi sẵn (manifest, trạng thái
// chuẩn hóa, báo cáo thu thập, QA, SQLite manifest); không đọc dữ liệu người bệnh, không quét EMR.

const fs = require('fs');
const path = require('path');
const { RUNTIME_ROOT } = require('../constants');
const { readJsonSafe } = require('../utils/file');

function relPath(p) {
  const rel = path.relative(RUNTIME_ROOT, p);
  return rel && !rel.startsWith('..') ? rel.split(path.sep).join('/') : path.basename(p);
}

function fileInfo(filePath) {
  try {
    const st = fs.statSync(filePath);
    return { exists: true, size_bytes: st.size, updated_at: new Date(st.mtimeMs).toISOString() };
  } catch (_) {
    return { exists: false, size_bytes: 0, updated_at: '' };
  }
}

// Đọc vài dòng cuối của file JSONL (lịch sử), bỏ qua dòng hỏng.
function tailJsonl(filePath, limit = 5) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).map(line => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean).reverse();
  } catch (_) {
    return [];
  }
}

function countLines(filePath) {
  try { return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).length; } catch (_) { return 0; }
}

// Bảng chính được ghi sau chuẩn hóa: khóa trong normalized_outputs → tên hiển thị + file CSV.
const STORED_TABLES = [
  ['initial_list', 'Danh sách quét từ EMR', 'du_lieu_ban_dau.csv'],
  ['patients', 'Người bệnh', 'patients.csv'],
  ['encounters', 'Đợt điều trị', 'encounters.csv'],
  ['diagnoses', 'Chẩn đoán', 'diagnoses.csv'],
  ['lab_results', 'Xét nghiệm', 'lab_results.csv'],
  ['imaging_results', 'CĐHA', 'imaging_results.csv'],
  ['surgery_results', 'Phẫu thuật/thủ thuật', 'surgery_results.csv'],
  ['medication_orders', 'Y lệnh thuốc', 'medication_orders.csv'],
  ['clinical_notes', 'Diễn biến', 'clinical_notes.csv'],
  ['analysis_ready', 'Bảng phân tích', 'analysis_ready.csv'],
];

const UNMATCHED_KEYS = [
  ['unmatched_lab_results', 'Xét nghiệm'],
  ['unmatched_imaging_results', 'CĐHA'],
  ['unmatched_surgery_results', 'Phẫu thuật'],
  ['unmatched_medication_orders', 'Y lệnh'],
];

// File tiến độ thô mà các nút lấy dữ liệu ghi mỗi khi lấy xong một ca (trước khi chuẩn hóa).
const RAW_PROGRESS_FILES = [
  ['progress.json', 'XN & CĐHA'],
  ['hchanh_auto_progress.json', 'Hồ sơ nền, ra viện, phẫu thuật'],
  ['order_history_auto_progress.json', 'Y lệnh'],
  ['collection_report.json', 'Thu thập tự động'],
];

const latestIso = (...values) => values.filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0] || '';

function buildPipelineInfo(scopeDir, runDir) {
  if (!runDir || !fs.existsSync(runDir)) return { exists: false };
  const manifest = readJsonSafe(path.join(runDir, 'manifest.json'), {}) || {};
  const outputs = manifest.normalized_outputs || {};
  const normalizeState = readJsonSafe(path.join(runDir, 'normalize_state.json'), {}) || {};
  const qa = readJsonSafe(path.join(runDir, 'qa_report.json'), {}) || {};
  const report = readJsonSafe(path.join(runDir, 'collection_report.json'), null);
  const db = manifest.normalized_database || {};
  const dbFile = path.join(scopeDir, db.database_file || 'research.sqlite3');
  const linkFile = path.join(scopeDir, 'patient_link.csv');
  const overlay = outputs.kho_nguoi_benh || {};

  // Lần lấy dữ liệu gần nhất (bất kỳ nút nào), để biết bảng chuẩn hóa đã gồm dữ liệu mới chưa.
  const rawParts = RAW_PROGRESS_FILES
    .map(([file, label]) => ({ file, label, updated_at: fileInfo(path.join(runDir, file)).updated_at }))
    .filter(x => x.updated_at);
  const lastFetchAt = latestIso(...rawParts.map(x => x.updated_at));
  const normalizedAt = manifest.normalized_at || normalizeState.finished_at || '';
  const initialListFile = fileInfo(path.join(runDir, 'du_lieu_ban_dau.csv'));

  const startedAt = Date.parse(normalizeState.started_at || '');
  const finishedAt = Date.parse(normalizeState.finished_at || '');

  return {
    exists: true,
    run_id: path.basename(runDir),
    scan: {
      // Quét lại ghi đè danh sách trong cùng đợt: lấy thời điểm ghi danh sách, không phải lúc tạo đợt.
      at: latestIso(manifest.created_at, initialListFile.updated_at),
      first_at: manifest.created_at || '',
      from_date: manifest.from_date || manifest.research_source_scan_from_date || '',
      to_date: manifest.to_date || manifest.research_source_scan_to_date || '',
      rows: Number(outputs.initial_list ?? manifest.research_source_rows ?? manifest.patients_count ?? 0),
      file: manifest.research_source_file || 'du_lieu_ban_dau.csv',
    },
    collect: report ? {
      at: report.finished_at || report.started_at || '',
      cancelled: Boolean(report.cancelled),
      fetched_encounters: Number(report.fetched_encounters || 0),
      skipped_unchanged: Number(report.skipped_unchanged || 0),
      parts_backfilled: Number(report.parts_backfilled || 0),
      selenium_errors_open: Number(report.selenium_errors_open || 0),
      unmatched_encounters: Number(report.unmatched_encounters || 0),
    } : null,
    fetch: {
      last_at: lastFetchAt,
      parts: rawParts.map(({ label, updated_at }) => ({ label, updated_at })),
      // Có dữ liệu lấy sau lần chuẩn hóa gần nhất: số liệu và bảng chuẩn hóa chưa gồm phần này.
      pending_normalize: Boolean(lastFetchAt && (!normalizedAt || Date.parse(lastFetchAt) > Date.parse(normalizedAt) + 1000)),
    },
    collect_runs: countLines(path.join(runDir, 'collection_history.jsonl')),
    versions_written: countLines(path.join(runDir, 'collection_versions.jsonl')),
    reused_from_patient_db: {
      cases: Number(overlay.cases || 0),
      provisional: Number(overlay.provisional || 0),
      replaced_by_goc: Number(overlay.replaced_by_goc || 0),
    },
    normalize: {
      status: normalizeState.status || (manifest.normalized_at ? 'complete' : 'not_run'),
      at: manifest.normalized_at || normalizeState.finished_at || '',
      duration_ms: Number.isFinite(startedAt) && Number.isFinite(finishedAt) ? finishedAt - startedAt : null,
      schema_version: manifest.normalized_schema_version || normalizeState.schema_version || null,
      app_version: manifest.normalized_code_version?.app_version || '',
      qa: {
        status: qa.status || manifest.normalized_qa?.status || '',
        blocking: Number(qa.blocking_count ?? manifest.normalized_qa?.blocking_count ?? 0),
        warning: Number(qa.warning_count ?? manifest.normalized_qa?.warning_count ?? 0),
        review: Number(manifest.normalized_qa?.review_count ?? 0),
      },
      unmatched: UNMATCHED_KEYS.map(([key, label]) => ({ key, label, rows: Number(outputs[key] || 0) })).filter(x => x.rows > 0),
      history: tailJsonl(path.join(runDir, 'normalize_history.jsonl'), 5).map(h => ({
        at: h.at || '',
        encounters: Number(h.counts?.encounters || 0),
        lab_results: Number(h.counts?.lab_results || 0),
        imaging_results: Number(h.counts?.imaging_results || 0),
      })),
    },
    storage: {
      run_dir: relPath(runDir),
      tables: STORED_TABLES.map(([key, label, file]) => ({
        key, label, file, rows: Number(outputs[key] || 0), ...fileInfo(path.join(runDir, file)),
      })),
      sqlite: {
        file: relPath(dbFile),
        status: manifest.normalized_database_status || (db.exists ? 'ok' : 'missing'),
        size_bytes: Number(db.size_bytes || fileInfo(dbFile).size_bytes || 0),
        updated_at: db.updated_at || fileInfo(dbFile).updated_at,
        table_count: Array.isArray(db.tables) ? db.tables.length : 0,
      },
      patient_link: { file: relPath(linkFile), ...fileInfo(linkFile) },
    },
  };
}

module.exports = { buildPipelineInfo };
