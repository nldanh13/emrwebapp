'use strict';

const { doneKey } = require('../validation');
const { getNurseByShift } = require('../nurse_config');
const { buildTimeline } = require('./timeline');
const { buildPreview } = require('./preview');
const { fingerprintRecords, getDoneInfo, normalizeDoneState } = require('../done_state');

function collectMedicationCategory(records, key) {
  return (Array.isArray(records) ? records : [])
    .flatMap(x => (x.thuoc && Array.isArray(x.thuoc[key])) ? x.thuoc[key] : []);
}

function collectExtraMedicationCategories(records, knownKeys = new Set()) {
  const out = {};
  for (const rec of (Array.isArray(records) ? records : [])) {
    const thuoc = rec?.thuoc || {};
    for (const [key, list] of Object.entries(thuoc)) {
      if (knownKeys.has(key) || !Array.isArray(list) || !list.length) continue;
      if (!out[key]) out[key] = [];
      out[key].push(...list);
    }
  }
  return out;
}

function collectRecordList(records, key) {
  return (Array.isArray(records) ? records : [])
    .flatMap(x => Array.isArray(x?.[key]) ? x[key] : []);
}

function normText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

function hasTargetProcedure(records) {
  const rows = Array.isArray(records) ? records : [];
  for (const r of rows) {
    const ck = r?.chi_dinh_khac || {};
    if (Array.isArray(ck.thay_bang_cat_chi) && ck.thay_bang_cat_chi.length) return true;
    const dvkt = Array.isArray(r?.chi_dinh_dvkt) ? r.chi_dinh_dvkt : [];
    for (const item of dvkt) {
      const text = normText(item?.ten || item?.name || item);
      if (/(thay bang|cat chi|cat chi vet mo|thay bang vet mo)/.test(text)) return true;
    }
  }
  return false;
}

// Y lệnh có chữ "thay băng" nhưng bác sĩ chưa lên mã DVKT: bộ phân loại cũ để
// lại mục giữ chỗ "Thay băng vết mổ (CHƯA LÊN MÃ)". Không đưa mục này vào phiếu
// chăm sóc/thủ thuật; chỉ báo cảnh báo bên ngoài (worker/input_care.py cùng quy tắc).
const UNCODED_DRESSING_RE = /ch(ư|u)a\s+l(ê|e)n\s+m(ã|a)/i;

function isUncodedDressingItem(item) {
  return UNCODED_DRESSING_RE.test(String(item?.ten || item?.name || item || ''));
}

function stripUncodedDressing(records) {
  let found = false;
  const rows = (Array.isArray(records) ? records : []).map(rec => {
    const items = rec?.chi_dinh_khac?.thay_bang_cat_chi;
    if (!Array.isArray(items) || !items.some(isUncodedDressingItem)) return rec;
    found = true;
    return { ...rec, chi_dinh_khac: { ...rec.chi_dinh_khac, thay_bang_cat_chi: items.filter(x => !isUncodedDressingItem(x)) } };
  });
  // Dữ liệu xử lý theo bộ phân loại mới chỉ còn dòng cảnh báo, không còn mục giữ chỗ.
  if (!found) {
    found = rows.some(rec => (Array.isArray(rec?.chi_dinh_khac?.canh_bao) ? rec.chi_dinh_khac.canh_bao : [])
      .some(isUncodedDressingItem));
  }
  if (!found) return { rows, warning: null };
  const codedDressing = rows.some(rec => (Array.isArray(rec?.chi_dinh_dvkt) ? rec.chi_dinh_dvkt : [])
    .some(item => /(thay bang|cat chi)/.test(normText(item?.ten || item?.name || item))));
  const warning = codedDressing ? null : {
    code: 'dressing_without_dvkt',
    message: 'Có y lệnh thay băng nhưng chưa lên mã DVKT. Không ghi vào phiếu chăm sóc; nhờ bác sĩ lên mã nếu cần.',
  };
  return { rows, warning };
}

// Nguyên văn ô "Y lệnh khác" từng phiếu trong ngày (Báo cáo in riêng), theo giờ phiếu.
function collectOtherOrderText(records) {
  const seen = new Set();
  const out = [];
  for (const item of collectRecordList(records, 'y_lenh_khac_goc')) {
    const noiDung = String(item?.noi_dung || '').trim();
    if (!noiDung) continue;
    const gio = String(item?.gio_y_lenh || '').trim();
    const bacSi = String(item?.bac_si || '').trim();
    const key = `${gio}\u0001${bacSi}\u0001${noiDung}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ gio_y_lenh: gio, bac_si: bacSi, noi_dung: noiDung });
  }
  return out.sort((a, b) => (a.gio_y_lenh || '99:99').localeCompare(b.gio_y_lenh || '99:99'));
}

function warningCount(records) {
  return collectRecordList(records, 'processing_warnings').length + collectRecordList(records, 'unparsed_orders').length;
}

// Dịch truyền lấy từ EMR đôi khi thiếu thể tích (chỉ đọc được tên/giờ, không
// đọc được số ml). Nhập thẳng vào EMR với thể tích rỗng sẽ bị worker coi là
// 0ml — nguy hiểm cho người bệnh — nên phải cảnh báo và chặn nhập cho tới khi
// điều dưỡng bổ sung thủ công ở tab "Sửa dịch truyền".
function hasValidVolume(item) {
  const raw = String(item?.the_tich ?? '').trim().replace(',', '.');
  if (!raw) return false;
  const num = Number(raw);
  return Number.isFinite(num) && num > 0;
}

function buildInfusionVolumeWarnings(dichTruyen = []) {
  return (Array.isArray(dichTruyen) ? dichTruyen : [])
    .filter(item => !hasValidVolume(item))
    .map(item => ({
      code: 'infusion_missing_volume',
      gio_y_lenh: item?.tg_bat_dau || item?.gio_dung || '',
      message: `Thiếu thể tích (ml) của "${item?.ten_hien_thi || item?.ten_thuoc || 'dịch truyền'}" — vào tab "Sửa dịch truyền" để nhập trước khi nhập dịch truyền.`,
    }));
}

function collectVtytPlan(records) {
  const itemsByKey = new Map();
  const warnings = [];
  let source = '';
  for (const rec of (Array.isArray(records) ? records : [])) {
    const v = rec?.vtyt && typeof rec.vtyt === 'object' ? rec.vtyt : null;
    if (!v) continue;
    if (v.source && !source) source = String(v.source);
    if (Array.isArray(v.warnings)) warnings.push(...v.warnings.filter(Boolean));
    for (const item of (Array.isArray(v.items) ? v.items : [])) {
      if (!item) continue;
      const key = String(item.key || item.code || item.name || item.searchKeyword || '').trim();
      if (!key) continue;
      const prev = itemsByKey.get(key) || { ...item, required_quantity: 0, reasons: [] };
      const qty = Number(item.required_quantity ?? item.qty ?? item.so_luong ?? 0);
      if (Number.isFinite(qty) && qty > 0) prev.required_quantity = Number(prev.required_quantity || 0) + qty;
      for (const reason of (Array.isArray(item.reasons) ? item.reasons : [])) {
        if (reason && !prev.reasons.includes(reason)) prev.reasons.push(reason);
      }
      itemsByKey.set(key, prev);
    }
  }
  return {
    items: [...itemsByKey.values()].sort((a, b) => String(a.name || a.searchKeyword || '').localeCompare(String(b.name || b.searchKeyword || ''), 'vi')),
    warnings: [...new Set(warnings.map(String))],
    source: source || 'none',
  };
}

function taskDoneInfo(doneStates = {}, key, hash, taskName) {
  const state = doneStates && doneStates[taskName] ? doneStates[taskName] : normalizeDoneState({});
  return getDoneInfo(state, key, hash);
}

// ── Build patient day bundle ───────────────────────────────────────────────────

function buildPatientDayBundle(records, patientId, date, nurseSchedule, doneStates = {}) {
  // Dấu vân tay "đã nhập" vẫn tính trên bản ghi gốc để không làm mọi ngày cũ thành "YL mới".
  const sourceRows = Array.isArray(records) ? records : [];
  const { rows, warning: dressingWarning } = stripUncodedDressing(sourceRows);
  const r    = rows[0] || {};

  const knownMedicationKeys = new Set(['dich_truyen', 'thuoc_tiem', 'thuoc_uong', 'thuoc_tra', 'khac']);
  const allDichTruyen = collectMedicationCategory(rows, 'dich_truyen');
  const allThuocTiem  = collectMedicationCategory(rows, 'thuoc_tiem');
  const allThuocUong  = collectMedicationCategory(rows, 'thuoc_uong');
  const allThuocTra   = collectMedicationCategory(rows, 'thuoc_tra');
  const allKhac       = collectMedicationCategory(rows, 'khac');
  const extraThuoc    = collectExtraMedicationCategories(rows, knownMedicationKeys);
  const rawOrderEvents = collectRecordList(rows, 'raw_order_events');
  const unparsedOrders = collectRecordList(rows, 'unparsed_orders');
  const processingWarnings = collectRecordList(rows, 'processing_warnings');
  if (dressingWarning) processingWarnings.push(dressingWarning);
  const hasInfusion   = allDichTruyen.length > 0;
  const hasProcedure  = hasTargetProcedure(rows);

  const doneK = doneKey(patientId, date);
  const hashes = {
    care: fingerprintRecords(sourceRows, 'care'),
    infusions: fingerprintRecords(sourceRows, 'infusions'),
    procedures: fingerprintRecords(sourceRows, 'procedures'),
    vtyt: fingerprintRecords(sourceRows, 'vtyt'),
  };

  const careInfo = taskDoneInfo(doneStates, doneK, hashes.care, 'care');
  // care: fallback bare ma_bn giữ tương thích ngược với care_done.json cũ (trước v2.1), nhưng không dùng fallback nếu key theo ngày đã stale.
  const careBareInfo = taskDoneInfo(doneStates, patientId, hashes.care, 'care');
  const care_done = careInfo.done || (!careInfo.stale && careBareInfo.done);
  const care_stale = careInfo.stale || careBareInfo.stale;

  const infusInfo = taskDoneInfo(doneStates, doneK, hashes.infusions, 'infusions');
  const infus_done = hasInfusion && infusInfo.done;
  const infus_stale = hasInfusion && infusInfo.stale;

  const procInfo = taskDoneInfo(doneStates, doneK, hashes.procedures, 'procedures');
  const proc_done = hasProcedure && procInfo.done;
  const proc_stale = hasProcedure && procInfo.stale;

  const vtytInfo = taskDoneInfo(doneStates, doneK, hashes.vtyt, 'vtyt');

  const dtWithNurse = allDichTruyen.map(d => ({
    ...d,
    dieu_duong: getNurseByShift(d.tg_bat_dau || d.gio_dung || '', nurseSchedule),
  }));
  const infusionVolumeWarnings = buildInfusionVolumeWarnings(dtWithNurse);
  const infusIncomplete = infusionVolumeWarnings.length > 0;

  const preview = buildPreview(r, dtWithNurse, nurseSchedule);
  const careRequired = Array.isArray(preview.care) && preview.care.length > 0;
  const warnCount = warningCount(rows) + infusionVolumeWarnings.length + (dressingWarning ? 1 : 0);
  const vtytPlan = collectVtytPlan(rows);

  const doneEnough = (!careRequired || care_done) && (!hasInfusion || infus_done) && (!hasProcedure || proc_done);
  const staleAny = care_stale || infus_stale || proc_stale;
  const status = staleAny || warnCount > 0 ? 'amber'
    : doneEnough ? 'green'
      : (care_done || infus_done || proc_done) ? 'amber' : 'gray';

  const dieu_duong_cs = getNurseByShift(date ? `08:00 ${date}` : '', nurseSchedule);
  const admissionTime = r.thoi_gian_vao_khoa || r.tg_vao || r.thoi_gian_vao || r.admission_time || '';
  const departmentName = r.ten_khoa_dieu_tri || r.khoa_dieu_tri || r.khoa_chuyen_den || r.department_name || r.department || '';
  const wardHistory = Array.isArray(r.lich_su_khoa_dieu_tri) ? r.lich_su_khoa_dieu_tri
    : Array.isArray(r.khoa_dieu_tri_history) ? r.khoa_dieu_tri_history
      : Array.isArray(r.ward_admissions) ? r.ward_admissions : [];

  return {
    date,
    bac_si:           r.bac_si           || '',
    xu_tri:           r.xu_tri           || '',
    tg_vao:           admissionTime,
    thoi_gian_vao_khoa: admissionTime,
    khoa_chuyen_den:  departmentName,
    khoa_dieu_tri:    departmentName,
    ten_khoa_dieu_tri: departmentName,
    lich_su_khoa_dieu_tri: wardHistory,
    chan_doan:        r.chan_doan         || '',
    care_mode:        r.care_mode        || '',
    ngay_ra_vien:     r.ngay_ra_vien     || '',
    gio_ra_vien:      r.gio_ra_vien      || '',
    ngay_ra_vien_date:r.ngay_ra_vien_date|| '',
    ra_vien_hom_nay:  Boolean(r.ra_vien_hom_nay),
    care_special_events: r.care_special_events || [],
    surgery_out:      Boolean(r.surgery_out),
    surgery_out_time: r.surgery_out_time || '',
    surgery_out_reason: r.surgery_out_reason || '',
    has_infusion:     hasInfusion,
    has_procedure:    hasProcedure,
    care_required:    careRequired,
    care_done,
    care_stale,
    infus_done,
    infus_stale,
    infus_incomplete: infusIncomplete,
    infus_incomplete_count: infusionVolumeWarnings.length,
    procedure_done:   proc_done,
    procedure_stale:  proc_stale,
    vtyt_done:        vtytInfo.done,
    vtyt_stale:       vtytInfo.stale,
    task_hashes:      hashes,
    done_key:         doneK,
    warning_count:    warnCount,
    status,
    timeline: buildTimeline(allDichTruyen, allThuocTiem, allThuocUong, allThuocTra, rows),
    preview,
    raw_order_events: rawOrderEvents,
    y_lenh_khac_goc: collectOtherOrderText(rows),
    unparsed_orders: unparsedOrders,
    processing_warnings: [...processingWarnings, ...infusionVolumeWarnings],
    vtyt: vtytPlan,
    // Giữ toàn bộ nhóm thuốc để tab Báo cáo không bị mất TMC/TB/TDD/Khác.
    thuoc:    {
      ...extraThuoc,
      dich_truyen: dtWithNurse,
      thuoc_tiem: allThuocTiem,
      thuoc_uong: allThuocUong,
      thuoc_tra: allThuocTra,
      khac: allKhac,
    },
    ncs:      { ...(r.nhap_cham_soc || {}), dieu_duong: dieu_duong_cs },
    cs_extra: r.chi_dinh_khac || {},
    dressing_without_dvkt: Boolean(dressingWarning),
  };
}

// ── Kế hoạch chăm sóc cho worker nhập EMR ─────────────────────────────────────
//
// Màn "Xem trước khi nhập" và worker/input_care.py phải ra CÙNG một danh sách
// phiếu (giờ, diễn biến, chăm sóc). Trước đây worker tự tính lại bằng Python nên
// thiếu "Thực hiện cận lâm sàng", "Xét nghiệm đường máu mao mạch…", "Mời bác sĩ
// khám"… và lệch giờ thuốc. Nay máy chủ gắn đúng preview.care (lấy qua chính
// buildPatientDayBundle mà màn hình dùng) vào dữ liệu gửi cho worker.
const CARE_PREVIEW_PLAN_SOURCE = 'preview.care';
const CARE_PREVIEW_PLAN_VERSION = 1;

function carePreviewPlanForDay(dayRecords, patientId, date, nurseSchedule = {}) {
  const bundle = buildPatientDayBundle(dayRecords, patientId, date, nurseSchedule, {});
  const items = Array.isArray(bundle?.preview?.care) ? bundle.preview.care : [];
  return {
    source: CARE_PREVIEW_PLAN_SOURCE,
    version: CARE_PREVIEW_PLAN_VERSION,
    items: items.map(item => ({
      time_full: String(item.time_full || ''),
      time_label: String(item.time_label || ''),
      dien_bien: String(item.dien_bien || ''),
      cham_soc: String(item.cham_soc || ''),
      ...(item.special_type ? { special_type: String(item.special_type), needs_vitals: item.needs_vitals !== false } : {}),
    })),
  };
}

// Trả về bản sao các dòng, mỗi dòng có `care_preview_plan` của BN/ngày đó.
// Nhóm giống hệt route /get-patients (theo ma_bn rồi ngay_lam) để dòng đầu
// của ngày là cùng một dòng màn hình dùng dựng Xem trước.
function attachCarePreviewPlans(rows, nurseSchedule = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const groups = new Map();
  for (const row of list) {
    const id = String(row?.ma_bn || '').trim();
    const date = String(row?.ngay_lam || '').trim();
    if (!id || !date) continue;
    const key = `${id}::${date}`;
    if (!groups.has(key)) groups.set(key, { id, date, rows: [] });
    groups.get(key).rows.push(row);
  }
  const plans = new Map();
  for (const [key, g] of groups) plans.set(key, carePreviewPlanForDay(g.rows, g.id, g.date, nurseSchedule));
  return list.map(row => {
    const key = `${String(row?.ma_bn || '').trim()}::${String(row?.ngay_lam || '').trim()}`;
    const plan = plans.get(key);
    return plan ? { ...row, care_preview_plan: plan } : row;
  });
}

module.exports = { collectOtherOrderText, stripUncodedDressing, collectMedicationCategory, collectExtraMedicationCategories, collectRecordList, hasTargetProcedure, hasValidVolume, buildInfusionVolumeWarnings, buildPatientDayBundle, carePreviewPlanForDay, attachCarePreviewPlans, CARE_PREVIEW_PLAN_SOURCE };
