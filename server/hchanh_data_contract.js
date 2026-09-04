// server/hchanh_data_contract.js
// Hợp đồng dữ liệu riêng cho module Hành chánh.
//
// Nguyên tắc thiết kế:
//   - Hoàn toàn độc lập với data/ (của Trực/Bệnh phòng).
//   - Mỗi bệnh nhân có thư mục riêng: hchanh/patients/{ma_bn}/
//   - Mỗi loại dữ liệu là 1 file riêng → lấy lại 1 file không ảnh hưởng file khác.
//   - index.json lưu trạng thái tổng: BN nào có, scope nào đã fetch, fetch lúc nào.
//
// Cấu trúc thư mục:
//   .runtime/sessions/{sid}/
//   └── hchanh/
//       ├── index.json                      ← danh sách BN + trạng thái fetch
//       ├── patients/
//       │   └── {ma_bn}/
//       │       ├── thong_tin_nen.json      ← thông tin nền (tên, phòng, BS, BHYT...)
//       │       ├── ra_vien.json            ← xử trí ra viện/ra khoa, ngày giờ, chẩn đoán
//       │       ├── bang_ke.json            ← bảng kê chi phí chi tiết
//       │       ├── ngay_giuong.json        ← timeline ngày giường
//       │       ├── phau_thuat.json         ← phân loại phẫu thuật
//       │       └── lich_su_y_lenh.json     ← lịch sử y lệnh và y lệnh chưa hoàn tất
//       ├── tickets/
//       │   └── ticket_store.json           ← phiếu sửa hồ sơ
//       └── snapshots/
//           ├── snapshot_morning.json
//           └── snapshot_afternoon.json

'use strict';

const fs   = require('fs');
const path = require('path');
const { ensureDir, readJsonSafe, writeJsonAtomic } = require('./utils/file');

const HCHANH_DATA_VERSION = 'hchanh-v1.2.0';

// ── Tên file dữ liệu Hành chánh ─────────────────────────────────────────────
//
// Trước đây file được lưu theo tên kỹ thuật tiếng Anh (profile.json,
// discharge.json...). Sau nhiều lần chỉnh, cách đặt tên này dễ gây nhầm giữa
// "file dữ liệu", "tab hiển thị" và "phiếu/giấy tờ". Từ v1.1.0 trở đi
// mỗi file có tên tiếng Việt không dấu, cùng nhãn hiển thị rõ ràng.
//
// Lưu ý tương thích:
//   - key nội bộ vẫn giữ nguyên: profile/discharge/billing/... để API và UI không vỡ.
//   - storageName là tên file mới.
//   - legacyNames là tên file cũ; khi đọc sẽ tự nhận, khi xóa cache sẽ xóa cả cũ lẫn mới.

const HCHANH_FILE_DEFS = Object.freeze({
  profile: {
    label: 'Thông tin nền',
    storageName: 'thong_tin_nen',
    legacyNames: ['profile'],
  },
  discharge: {
    label: 'Ra viện / ra khoa',
    storageName: 'ra_vien',
    legacyNames: ['discharge'],
  },
  billing: {
    label: 'Bảng kê chi phí',
    storageName: 'bang_ke',
    legacyNames: ['billing'],
  },
  bed_days: {
    label: 'Ngày giường',
    storageName: 'ngay_giuong',
    legacyNames: ['bed_days'],
  },
  surgery: {
    label: 'Phẫu thuật',
    storageName: 'phau_thuat',
    legacyNames: ['surgery'],
  },
  order_history: {
    label: 'Lịch sử y lệnh',
    storageName: 'lich_su_y_lenh',
    legacyNames: ['order_history'],
  },
  cls: {
    label: 'Xem kết quả CĐHA',
    storageName: 'xem_ket_qua_cdha',
    legacyNames: ['cls', 'can_lam_sang', 'lich_su_cdha'],
  },
});

const HCHANH_FILE_KEYS = Object.freeze(Object.keys(HCHANH_FILE_DEFS));

function hchanh_file_def(fileKey) {
  return HCHANH_FILE_DEFS[fileKey] || { label: String(fileKey || ''), storageName: String(fileKey || ''), legacyNames: [] };
}

function hchanh_file_stem(fileKey) {
  return hchanh_file_def(fileKey).storageName || String(fileKey || '');
}

function hchanh_file_label(fileKey) {
  return hchanh_file_def(fileKey).label || String(fileKey || '');
}

function hchanh_file_candidate_stems(fileKey) {
  const def = hchanh_file_def(fileKey);
  const stems = [def.storageName, ...(def.legacyNames || []), String(fileKey || '')]
    .filter(Boolean);
  return [...new Set(stems)];
}

// ── Scope định nghĩa ─────────────────────────────────────────────────────────
// Mỗi scope tương ứng 1 nhóm trạng thái bệnh nhân.
// files: danh sách file cần fetch khi chạy scope này.
// label: tên hiển thị trên UI.

const FETCH_SCOPES = Object.freeze({
  // Tiếp tục điều trị hàng ngày — chỉ cần profile cập nhật
  daily: {
    label: 'Cập nhật hàng ngày',
    files: ['profile'],
    workerScope: 'daily',
  },
  // Mới nhập khoa — cần thêm BHYT, giấy chuyển tuyến
  admission: {
    label: 'Nhập khoa mới',
    files: ['profile'],
    workerScope: 'admission',
  },
  // Phẫu thuật / thủ thuật
  surgery: {
    label: 'Phẫu thuật / Thủ thuật',
    files: ['profile', 'surgery'],
    workerScope: 'surgery',
  },
  // Ra viện / Chuyển khoa / Chuyển viện / Tử vong
  // → cần đầy đủ nhất: giấy ra viện, bảng kê, ngày giường, phẫu thuật
  discharge: {
    label: 'Kiểm hồ sơ ra viện',
    files: ['profile', 'discharge', 'billing', 'bed_days', 'surgery', 'order_history', 'cls'],
    workerScope: 'discharge',
  },
});

// Ánh xạ workflow tag → scope mặc định
// UI dùng để tự chọn scope phù hợp khi bấm "Cập nhật hành chánh"
const TAG_TO_SCOPE = Object.freeze({
  DISCHARGE:          'discharge',
  TRANSFER_WARD:      'discharge',
  TRANSFER_HOSPITAL:  'discharge',
  DEATH:              'discharge',
  PRE_OP:             'surgery',
  POST_OP:            'surgery',
  POST_OP_RETURN:     'surgery',
  NEW_ADMISSION:      'admission',
  CONTINUE_CARE:      'daily',
});

// ── Path helpers ─────────────────────────────────────────────────────────────

function hchanh_dir(ctx) {
  const dir = path.join(ctx.dir, 'hchanh');
  ensureDir(dir);
  return dir;
}

function hchanh_index_path(ctx) {
  return path.join(hchanh_dir(ctx), 'index.json');
}

function hchanh_patient_dir(ctx, ma_bn) {
  const safeId = String(ma_bn || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const dir = path.join(hchanh_dir(ctx), 'patients', safeId);
  ensureDir(dir);
  return dir;
}

function hchanh_patient_file(ctx, ma_bn, fileKey) {
  return path.join(hchanh_patient_dir(ctx, ma_bn), `${hchanh_file_stem(fileKey)}.json`);
}

function hchanh_patient_file_candidates(ctx, ma_bn, fileKey) {
  const dir = hchanh_patient_dir(ctx, ma_bn);
  return hchanh_file_candidate_stems(fileKey).map(stem => path.join(dir, `${stem}.json`));
}

function hchanh_tickets_path(ctx) {
  const dir = path.join(hchanh_dir(ctx), 'tickets');
  ensureDir(dir);
  return path.join(dir, 'ticket_store.json');
}

function hchanh_snapshot_path(ctx, kind) {
  const dir = path.join(hchanh_dir(ctx), 'snapshots');
  ensureDir(dir);
  const safeKind = kind === 'afternoon' ? 'afternoon' : 'morning';
  return path.join(dir, `snapshot_${safeKind}.json`);
}

// ── Index: danh sách BN + trạng thái fetch ───────────────────────────────────
//
// Schema index.json:
// {
//   version: "hchanh-v1.0.0",
//   updatedAt: "ISO",
//   patients: {
//     "{ma_bn}": {
//       ma_bn: "...",
//       ho_ten: "...",
//       phong: "...",
//       workflow_tags: [...],        ← tag trạng thái hiện tại
//       scope_default: "discharge",  ← scope nên dùng dựa trên tag
//       fetched: {                   ← file nào đã fetch, lấy lúc nào
//         profile:   "2026-05-31T...",
//         discharge: null,
//         billing:   null,
//         bed_days:  null,
//       },
//       fetch_error: null,           ← lỗi fetch gần nhất nếu có
//     }
//   }
// }

function read_index(ctx) {
  const data = readJsonSafe(hchanh_index_path(ctx), null);
  // Chấp nhận index cũ v1.0.0 để không mất danh sách BN sau khi đổi tên file.
  if (data && typeof data === 'object' && data.patients && typeof data.patients === 'object') {
    return { ...data, version: HCHANH_DATA_VERSION };
  }
  return { version: HCHANH_DATA_VERSION, updatedAt: null, patients: {} };
}

function write_index(ctx, index) {
  const out = { ...index, version: HCHANH_DATA_VERSION, updatedAt: new Date().toISOString() };
  writeJsonAtomic(hchanh_index_path(ctx), out);
  return out;
}

// Đồng bộ index từ danh sách BN đã scan (raw/sorted).
// Gọi khi mở tab Hành chánh hoặc sau khi scan xong.
// Bệnh nhân mới → thêm vào index với fetched rỗng.
// Bệnh nhân cũ → giữ nguyên fetched, chỉ cập nhật tên/phòng/tags.
function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return '';
}

function normText(value) {
  return String(value ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

function row_patient_id(row) {
  return firstText(
    row?.ma_bn,
    row?.patient_id,
    row?.patientId,
    row?.MaBN,
    row?.Ma_BN,
    row?.mabn,
    row?.maBenhNhan,
    row?.['Mã BN'],
    row?.['Ma BN'],
    row?.['Mã bệnh nhân'],
    row?.['Ma benh nhan'],
    row?.['Mã YT'],
    row?.['Ma YT'],
    row?.ma_yt,
    row?.id
  );
}

function row_patient_name(row, existing = {}) {
  return firstText(
    row?.ho_ten,
    row?.name,
    row?.patientName,
    row?.patient_name,
    row?.['Họ tên'],
    row?.['Ho ten'],
    row?.['Tên bệnh nhân'],
    row?.['Ten benh nhan'],
    existing.ho_ten
  );
}

function row_patient_room(row, existing = {}) {
  return firstText(
    row?.Vi_Tri,
    row?.vi_tri,
    row?.so_phong,
    row?.phong,
    row?.room,
    row?.bed,
    row?.phong_giuong,
    row?.['Phòng'],
    row?.['Phong'],
    row?.['Phòng/Giường'],
    row?.['Phong/Giuong'],
    row?.['Vị trí'],
    row?.['Vi tri'],
    existing.phong
  );
}

function row_department(row, existing = {}) {
  return firstText(
    row?.ten_khoa_dieu_tri,
    row?.department_name,
    row?.khoa_dieu_tri,
    row?.department,
    row?.khoa_chuyen_den,
    row?.['Tên khoa điều trị'],
    row?.['Khoa điều trị'],
    row?.['Khoa chuyển đến'],
    existing.department
  );
}

function row_admission_time(row, existing = {}) {
  return firstText(
    row?.thoi_gian_vao_khoa,
    row?.ward_admission_time,
    row?.admission_time,
    row?.tg_vao,
    row?.thoi_gian_vao,
    row?.['T/G vào'],
    row?.['Thời gian vào khoa'],
    existing.admission_time
  );
}

function row_inpatient_status(row, existing = {}) {
  return firstText(
    row?.inpatient_status,
    row?.research_inpatient_status,
    row?.trang_thai,
    row?.TrangThai,
    row?.['Trạng thái'],
    row?.status,
    row?.tinh_trang,
    existing.inpatient_status
  );
}

function infer_workflow_tags_from_row(row) {
  const explicit = Array.isArray(row?.workflow_tags) ? row.workflow_tags
    : Array.isArray(row?.workflowTags) ? row.workflowTags
    : [];
  const tags = new Set(explicit.filter(Boolean));
  const hay = normText([
    row?.xu_tri,
    row?.disposition,
    row?.trang_thai,
    row?.status,
    row?.tinh_trang,
    row?.tinh_trang_ra,
    row?.chan_doan,
    row?.diagnosis,
    row?.ngay_ra_vien,
    row?.gio_ra_vien,
    row?.ngay_ra,
  ].filter(Boolean).join(' '));

  if (/tu vong|death/.test(hay)) tags.add('DEATH');
  if (/chuyen vien|chuyen tuyen|transfer hospital/.test(hay)) tags.add('TRANSFER_HOSPITAL');
  if (/chuyen khoa|chuyen phong|transfer ward/.test(hay)) tags.add('TRANSFER_WARD');
  if (/ra vien|xuat vien|discharge|hoan tat|tat toan/.test(hay) || firstText(row?.ngay_ra_vien, row?.discharge_date, row?.ngay_ra)) tags.add('DISCHARGE');
  if (/sau mo|hau phau|post.?op/.test(hay)) tags.add('POST_OP');
  if (/phau thuat|thu thuat|pttt|truoc mo|pre.?op/.test(hay)) tags.add('PRE_OP');
  if (/nhap khoa|moi vao|new admission/.test(hay)) tags.add('NEW_ADMISSION');
  if (!tags.size) tags.add('CONTINUE_CARE');
  return [...tags];
}

function row_encounter_key(row, ma_bn, admissionTime, department) {
  return firstText(
    row?.encounter_key,
    row?.encounterKey,
    row?.ma_luot_dieu_tri,
    row?.treatment_id,
    row?.ma_dieu_tri,
    row?.so_vao_vien,
    row?.visit_id,
    row?.['Mã lượt điều trị']
  ) || (admissionTime || department ? `${ma_bn}::${admissionTime}::${department}` : ma_bn);
}

// Đồng bộ index từ danh sách BN đã scan (raw/sorted/v2 patients).
// Gọi khi mở tab Hành chánh hoặc sau khi scan xong.
// Bệnh nhân mới → thêm vào index với fetched rỗng.
// Bệnh nhân cũ → giữ nguyên fetched, chỉ cập nhật tên/phòng/tags.
function sync_index_from_patients(ctx, patient_rows) {
  const index = read_index(ctx);
  const now = new Date().toISOString();
  const scanRows = Array.isArray(patient_rows) ? patient_rows : [];
  const seen = new Set();

  // Không xóa hồ sơ cũ; chỉ đánh dấu stale để dashboard không hiểu nhầm là BN đang nằm khoa.
  for (const meta of Object.values(index.patients || {})) {
    if (meta && typeof meta === 'object') {
      meta.active = false;
      meta.stale = true;
    }
  }

  for (const row of scanRows) {
    if (!row || typeof row !== 'object') continue;
    const ma_bn = row_patient_id(row);
    if (!ma_bn) continue;
    seen.add(ma_bn);

    const existing = index.patients[ma_bn] || {};
    const tags = infer_workflow_tags_from_row(row);
    const scope_default = resolve_scope_from_tags(tags);
    const admissionTime = row_admission_time(row, existing);
    const department = row_department(row, existing);
    const inpatientStatus = row_inpatient_status(row, existing);
    const encounter_key = row_encounter_key(row, ma_bn, admissionTime, department);

    index.patients[ma_bn] = {
      ...existing,
      ma_bn,
      encounter_key,
      active: true,
      stale: false,
      last_seen_at: now,
      last_seen_session_id: ctx.sid || '',
      admission_time: admissionTime || existing.admission_time || '',
      department: department || existing.department || '',
      inpatient_status: inpatientStatus || existing.inpatient_status || '',
      ho_ten: row_patient_name(row, existing),
      phong: row_patient_room(row, existing),
      workflow_tags: tags.length ? tags : (existing.workflow_tags || []),
      scope_default,
      fetched: existing.fetched || {
        profile:   null,
        discharge: null,
        billing:   null,
        bed_days:  null,
        surgery:   null,
        order_history: null,
      },
      fetch_error: existing.fetch_error || null,
    };
  }

  index.lastSync = {
    at: now,
    scanned_count: scanRows.length,
    active_count: seen.size,
    stale_count: Object.values(index.patients || {}).filter(p => p && p.active === false).length,
  };
  return write_index(ctx, index);
}

// Đánh dấu 1 file đã fetch thành công
function mark_fetched(ctx, ma_bn, file_key) {
  const index = read_index(ctx);
  if (!index.patients[ma_bn]) return index;
  index.patients[ma_bn].fetched = {
    ...(index.patients[ma_bn].fetched || {}),
    [file_key]: new Date().toISOString(),
  };
  index.patients[ma_bn].fetch_error = null;
  return write_index(ctx, index);
}

// Đánh dấu lỗi fetch
function mark_fetch_error(ctx, ma_bn, error_msg) {
  const index = read_index(ctx);
  if (!index.patients[ma_bn]) return index;
  index.patients[ma_bn].fetch_error = String(error_msg || '').slice(0, 500);
  index.patients[ma_bn].fetch_error_at = new Date().toISOString();
  return write_index(ctx, index);
}

function clear_fetch_error(ctx, ma_bn) {
  const index = read_index(ctx);
  if (!index.patients[ma_bn]) return index;
  index.patients[ma_bn].fetch_error = null;
  index.patients[ma_bn].fetch_error_at = null;
  return write_index(ctx, index);
}

// ── Scope resolver ────────────────────────────────────────────────────────────

function resolve_scope_from_tags(tags) {
  const tag_list = Array.isArray(tags) ? tags : [];
  // Ưu tiên theo thứ tự: discharge > surgery > admission > daily
  const priority = ['DISCHARGE', 'TRANSFER_WARD', 'TRANSFER_HOSPITAL', 'DEATH',
                    'PRE_OP', 'POST_OP', 'POST_OP_RETURN',
                    'NEW_ADMISSION', 'CONTINUE_CARE'];
  for (const tag of priority) {
    if (tag_list.includes(tag)) return TAG_TO_SCOPE[tag] || 'daily';
  }
  return 'daily';
}

// ── Patient data readers/writers ─────────────────────────────────────────────

function read_patient_file(ctx, ma_bn, file_key) {
  for (const candidate of hchanh_patient_file_candidates(ctx, ma_bn, file_key)) {
    if (fs.existsSync(candidate)) return readJsonSafe(candidate, null);
  }
  return null;
}

function write_patient_file(ctx, ma_bn, file_key, data) {
  const canonicalPath = hchanh_patient_file(ctx, ma_bn, file_key);
  const out = {
    ...data,
    _meta: {
      ma_bn,
      file_key,
      file_label: hchanh_file_label(file_key),
      file_name: path.basename(canonicalPath),
      version: HCHANH_DATA_VERSION,
      fetched_at: new Date().toISOString(),
    },
  };
  writeJsonAtomic(canonicalPath, out);

  // Tránh lỗi UI/API đọc nhầm dữ liệu cũ: sau khi đã có file mới thì xóa bản legacy cùng key.
  for (const oldPath of hchanh_patient_file_candidates(ctx, ma_bn, file_key)) {
    if (oldPath !== canonicalPath) {
      try { if (fs.existsSync(oldPath)) fs.rmSync(oldPath, { force: true }); } catch (_) {}
    }
  }

  mark_fetched(ctx, ma_bn, file_key);
  return out;
}

// Đọc toàn bộ dữ liệu 1 BN (tất cả các file đã fetch)
function read_patient_all(ctx, ma_bn) {
  return {
    profile:   read_patient_file(ctx, ma_bn, 'profile'),
    discharge: read_patient_file(ctx, ma_bn, 'discharge'),
    billing:   read_patient_file(ctx, ma_bn, 'billing'),
    bed_days:  read_patient_file(ctx, ma_bn, 'bed_days'),
    surgery:   read_patient_file(ctx, ma_bn, 'surgery'),
    order_history: read_patient_file(ctx, ma_bn, 'order_history'),
    cls: read_patient_file(ctx, ma_bn, 'cls'),
  };
}

// Kiểm tra file nào đã có, file nào còn thiếu cho 1 scope
function check_missing_files(ctx, ma_bn, scope) {
  const scope_def = FETCH_SCOPES[scope] || FETCH_SCOPES.daily;
  const missing = [];
  const present = [];
  for (const file_key of scope_def.files) {
    const hasAny = hchanh_patient_file_candidates(ctx, ma_bn, file_key).some(p => fs.existsSync(p));
    if (hasAny) present.push(file_key);
    else missing.push(file_key);
  }
  return { missing, present, scope, files_required: scope_def.files };
}

// ── Xóa dữ liệu ─────────────────────────────────────────────────────────────

function clear_patient_data(ctx, ma_bn) {
  const dir = path.join(hchanh_dir(ctx), 'patients',
    String(ma_bn || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80));
  const removed = [];
  for (const key of HCHANH_FILE_KEYS) {
    for (const p of hchanh_file_candidate_stems(key).map(stem => path.join(dir, `${stem}.json`))) {
      try {
        if (fs.existsSync(p)) {
          fs.rmSync(p, { force: true });
          if (!removed.includes(key)) removed.push(key);
        }
      } catch (_) {}
    }
  }
  // Reset fetched trong index
  const index = read_index(ctx);
  if (index.patients[ma_bn]) {
    index.patients[ma_bn].fetched = Object.fromEntries(HCHANH_FILE_KEYS.map(k => [k, null]));
    index.patients[ma_bn].fetch_error = null;
    write_index(ctx, index);
  }
  return { ma_bn, removed };
}

function clear_all_hchanh_data(ctx) {
  const dir = hchanh_dir(ctx);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  ensureDir(dir);
  return { status: 'ok', message: 'Đã xóa toàn bộ dữ liệu hành chánh trong session.' };
}

// ── Export ───────────────────────────────────────────────────────────────────

module.exports = {
  HCHANH_DATA_VERSION,
  FETCH_SCOPES,
  TAG_TO_SCOPE,
  HCHANH_FILE_DEFS,
  HCHANH_FILE_KEYS,
  hchanh_file_label,
  hchanh_file_stem,

  // Paths
  hchanh_dir,
  hchanh_index_path,
  hchanh_patient_dir,
  hchanh_patient_file,
  hchanh_patient_file_candidates,
  hchanh_tickets_path,
  hchanh_snapshot_path,

  // Index
  read_index,
  write_index,
  sync_index_from_patients,
  mark_fetched,
  mark_fetch_error,
  clear_fetch_error,

  // Scope
  resolve_scope_from_tags,

  // Patient data
  read_patient_file,
  write_patient_file,
  read_patient_all,
  check_missing_files,

  // Cleanup
  clear_patient_data,
  clear_all_hchanh_data,
};
