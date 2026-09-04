// server/data_contract.js — Chuẩn tên file và hợp đồng dữ liệu runtime.
//
// Nguyên tắc:
// - Tên file canonical dùng tiếng Anh, có thứ tự pipeline rõ ràng.
// - Tên file cũ vẫn được nhận khi import/migrate để không mất dữ liệu cũ.
// - Các route chỉ dùng ctx.RAW_PATH/SORTED_PATH/FINAL_PATH/PROCESSED_PATH;
//   ctx này trỏ về file canonical sau khi migration.

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_CONTRACT_VERSION = 'emr-dashboard-data-v2.1.0';

const RUNTIME_FILE_SPECS = {
  RAW: {
    ctxKey: 'RAW_PATH',
    canonical: path.join('data', '01_raw_patient_rows.json'),
    legacy: ['data_raw.json'],
    description: 'Dữ liệu danh sách người bệnh lấy trực tiếp từ EMR, chưa chuẩn hóa sâu.',
  },
  SORTED: {
    ctxKey: 'SORTED_PATH',
    canonical: path.join('data', '02_selected_patient_rows.json'),
    legacy: ['data_sorted.json'],
    description: 'Danh sách người bệnh đã chọn/sắp xếp để lấy chi tiết.',
  },
  FINAL: {
    ctxKey: 'FINAL_PATH',
    canonical: path.join('data', '03_order_text_by_patient_day.json'),
    legacy: ['KetQua_YLenh.json'],
    description: 'Dữ liệu y lệnh/diễn biến dạng text theo người bệnh/ngày.',
  },
  PROCESSED: {
    ctxKey: 'PROCESSED_PATH',
    canonical: path.join('data', '04_classified_patient_day_records.json'),
    legacy: ['DuLieu_PhanLoai.json'],
    description: 'Dữ liệu đã phân loại thuốc, dịch truyền, chăm sóc, DVKT, VTYT.',
  },
  PATIENTS: {
    ctxKey: 'PATIENTS_PATH',
    canonical: path.join('data', 'patients.json'),
    legacy: [],
    description: 'Schema v2: thông tin hành chính người bệnh, chỉ lưu một lần theo patient_id.',
  },
  BOARD_STATE: {
    ctxKey: 'BOARD_STATE_PATH',
    canonical: path.join('data', 'board_state.json'),
    legacy: [],
    description: 'Schema v2: danh sách đã chọn, thứ tự và xếp phòng; không copy nguyên raw rows.',
  },
  ORDER_DAYS: {
    ctxKey: 'ORDER_DAYS_PATH',
    canonical: path.join('data', 'order_days.json'),
    legacy: [],
    description: 'Schema v2: y lệnh thô gộp theo patient-day; bridge ngày sau là segment.',
  },
  CLASSIFIED_DAYS: {
    ctxKey: 'CLASSIFIED_DAYS_PATH',
    canonical: path.join('data', 'classified_days.json'),
    legacy: [],
    description: 'Schema v2: dữ liệu phân loại gọn theo patient-day, bỏ metadata/debug lặp.',
  },
  WARNINGS: {
    ctxKey: 'WARNINGS_PATH',
    canonical: path.join('data', 'warnings.json'),
    legacy: [],
    description: 'Schema v2: cảnh báo tổng hợp sau xử lý.',
  },
  INDEXES: {
    ctxKey: 'INDEXES_PATH',
    canonical: path.join('data', 'indexes.json'),
    legacy: [],
    description: 'Schema v2: chỉ mục và thống kê nhanh của session.',
  },
  CARE_DONE: {
    ctxKey: 'CARE_DONE_PATH',
    canonical: path.join('state', 'care_done.json'),
    legacy: ['care_done.json'],
    description: 'Trạng thái đã nhập chăm sóc.',
  },
  INFUSIONS_DONE: {
    ctxKey: 'INFUSIONS_DONE_PATH',
    canonical: path.join('state', 'infusions_done.json'),
    legacy: ['infusions_done.json'],
    description: 'Trạng thái đã nhập dịch truyền.',
  },
  PROCEDURES_DONE: {
    ctxKey: 'PROCEDURES_DONE_PATH',
    canonical: path.join('state', 'procedures_done.json'),
    legacy: ['procedures_done.json'],
    description: 'Trạng thái đã nhập thủ thuật/DVKT.',
  },
  VTYT_DONE: {
    ctxKey: 'VTYT_DONE_PATH',
    canonical: path.join('state', 'vtyt_done.json'),
    legacy: ['vtyt_done.json'],
    description: 'Trạng thái đã nhập vật tư y tế.',
  },
  TASK_PROGRESS: {
    ctxKey: 'TASK_PROGRESS_PATH',
    canonical: path.join('state', 'task_progress.json'),
    legacy: ['task_progress.json'],
    description: 'Tiến độ tác vụ đang chạy.',
  },
};

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function buildRuntimeDataPaths(dir) {
  const out = {};
  out.DATA_CONTRACT_VERSION = DATA_CONTRACT_VERSION;
  out.DATA_DIR = path.join(dir, 'data');
  out.STATE_DIR = path.join(dir, 'state');
  out.MANIFEST_PATH = path.join(dir, 'manifest.json');
  out.LEGACY_PATHS = {};
  for (const spec of Object.values(RUNTIME_FILE_SPECS)) {
    out[spec.ctxKey] = path.join(dir, spec.canonical);
    out.LEGACY_PATHS[spec.ctxKey] = (spec.legacy || []).map(name => path.join(dir, name));
  }
  return out;
}

function migrateLegacyRuntimeFiles(ctx) {
  ensureDir(ctx.DATA_DIR);
  ensureDir(ctx.STATE_DIR);
  for (const spec of Object.values(RUNTIME_FILE_SPECS)) {
    const canonicalPath = ctx[spec.ctxKey];
    if (fs.existsSync(canonicalPath)) continue;
    const legacyPaths = ctx.LEGACY_PATHS?.[spec.ctxKey] || [];
    const legacyPath = legacyPaths.find(p => fs.existsSync(p));
    if (!legacyPath) continue;
    try {
      ensureDir(path.dirname(canonicalPath));
      fs.copyFileSync(legacyPath, canonicalPath);
    } catch (err) {
      console.warn(`[DATA-CONTRACT] Không migrate được ${legacyPath} -> ${canonicalPath}:`, String(err.message || err));
    }
  }
}

function buildManifest(ctx) {
  const files = {};
  for (const [logicalName, spec] of Object.entries(RUNTIME_FILE_SPECS)) {
    const filePath = ctx[spec.ctxKey];
    files[logicalName] = {
      path: path.relative(ctx.dir, filePath).replace(/\\/g, '/'),
      legacy: (spec.legacy || []),
      description: spec.description,
      exists: fs.existsSync(filePath),
    };
  }
  return {
    schema: DATA_CONTRACT_VERSION,
    sid: ctx.sid,
    created_at: new Date().toISOString(),
    files,
  };
}

function writeManifest(ctx) {
  try {
    ensureDir(ctx.dir);
    fs.writeFileSync(ctx.MANIFEST_PATH, JSON.stringify(buildManifest(ctx), null, 2), 'utf-8');
  } catch (err) {
    console.warn('[DATA-CONTRACT] Không ghi được manifest:', String(err.message || err));
  }
}

function canonicalBundleNameForCtxKey(ctxKey) {
  const spec = Object.values(RUNTIME_FILE_SPECS).find(s => s.ctxKey === ctxKey);
  return spec ? spec.canonical.replace(/\\/g, '/') : null;
}

function legacyBundleNamesForCtxKey(ctxKey) {
  const spec = Object.values(RUNTIME_FILE_SPECS).find(s => s.ctxKey === ctxKey);
  return spec ? [...(spec.legacy || [])] : [];
}

module.exports = {
  DATA_CONTRACT_VERSION,
  RUNTIME_FILE_SPECS,
  buildRuntimeDataPaths,
  migrateLegacyRuntimeFiles,
  buildManifest,
  writeManifest,
  canonicalBundleNameForCtxKey,
  legacyBundleNamesForCtxKey,
};
