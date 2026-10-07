'use strict';

// Lấy dữ liệu hành chánh (hồ sơ nền, ra viện, phẫu thuật, lịch sử y lệnh) cho các lượt của một run nghiên cứu qua worker EMR.

const path = require('path');
const { ensureDir, readJsonSafe, writeJsonAtomic } = require('../utils/file');
const { uniqueResearchHchanhRows, researchHchanhMeta, hchanhFetchOutputToRows, removeResearchSourceKey } = require('./research_source');
const { readCsvTable, writeCsvUnion, patientCode } = require('./table_io');
const { appendResearchRunLog, appendResearchCaseTrace, CASE_TRACE_RECENT_JSON } = require('./case_trace');
const { appendActivity } = require('../services/activity_logger');
const { isoDate, firstNonEmpty } = require('./encounter_context');
const { findStoredStay, recordHchanhFetch } = require('../services/hchanh_stay_store');
const { isCancelRequested, registerCancel, unregisterCancel } = require('../services/task_queue');
const { nowIso } = require('./store_paths');
const { dedupeRowsByStableKey } = require('./dataset_store');
const { runScript, fmtPyError } = require('../services/python_runner');
const fs = require('fs');

const VERIFIED_FETCH_WINDOW_VERSION = 3;

function hchanhDefaultFiles(files) {
  const allowed = new Set(['profile', 'discharge', 'surgery', 'order_history']);
  const requested = Array.isArray(files) ? files.map(x => String(x || '').trim()).filter(Boolean) : [];
  const filtered = requested.filter(x => allowed.has(x));
  // Mặc định lấy profile + discharge + surgery (không lấy y lệnh vì không phải NC nào cũng cần).
  // Nếu caller truyền order_history vào files thì gộp luôn vào 1 lần fetch.
  return filtered.length ? filtered : ['profile', 'discharge', 'surgery'];
}

function orderHistoryDefaultFiles(files) {
  const requested = Array.isArray(files) ? files.map(x => String(x || '').trim()).filter(Boolean) : [];
  return requested.includes('order_history') ? ['order_history'] : ['order_history'];
}

function orderHistoryRunLabel(files) {
  const joined = (files || []).join(',');
  return joined === 'order_history' ? 'lịch sử y lệnh' : `lịch sử y lệnh (${joined})`;
}

function parseResearchHeadless(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (['0', 'false', 'no', 'n', 'off', 'visible', 'show'].includes(text)) return false;
  if (['1', 'true', 'yes', 'y', 'on', 'hidden', 'headless'].includes(text)) return true;
  return defaultValue;
}

function researchHeadlessFromBody(body) {
  // Riêng module nghiên cứu mặc định chạy ẩn để không bật nhiều cửa sổ Chrome khi quét dài.
  // Vẫn cho phép bật lại cửa sổ bằng body.headless=false nếu cần debug.
  return parseResearchHeadless(body?.headless, true);
}

function statusCountsFromHchanhOutput(output) {
  const counts = { ok: 0, attention: 0, error: 0, total: 0 };
  for (const payload of Object.values(output || {})) {
    const st = String(payload?._fetch_status || '').toLowerCase();
    counts.total += 1;
    if (st === 'ok') counts.ok += 1;
    else if (['empty', 'partial'].includes(st)) counts.attention += 1;
    else if (['error', 'no_url', 'no_session', 'timeout'].includes(st)) counts.error += 1;
  }
  return counts;
}

// Dòng danh sách nội trú có thể mang T/G vào của lần CHUYỂN KHOA, không phải
// ngày vào viện đầu tiên. Khi profile/discharge EMR đã xác minh một khoảng nằm
// viện bao trùm mốc đó, mọi lần lấy tiếp (đặc biệt Lịch sử y lệnh) phải dùng
// toàn bộ khoảng thật, nếu không sẽ mất y lệnh trước ngày chuyển khoa.
function verifiedStayWindowForSource(meta, profileRows = [], dischargeRows = []) {
  const code = String(meta?.ma_bn || '').trim();
  const anchor = isoDate(meta?.admission_raw || meta?.date_from || '');
  if (!code || !anchor) return null;

  const byAdmission = new Map();
  const touch = row => {
    if (String(patientCode(row) || '').trim() !== code) return;
    const from = isoDate(firstNonEmpty(row, [
      'Ngày vào viện', 'Ngay vao vien', 'Ngày nhập viện', 'Ngay nhap vien',
      'T/G vào', 'TG vao', 'admission_date', 'ngay_vao_vien', 'ngay_vao',
    ]));
    const to = isoDate(firstNonEmpty(row, [
      'Ngày ra viện', 'Ngay ra vien', 'Ngày xuất viện', 'Ngay xuat vien',
      'T/G ra', 'TG ra', 'discharge_date', 'ngay_ra_vien', 'ngay_ra',
    ]));
    if (!from) return;
    const current = byAdmission.get(from) || { from, to: '' };
    if (to && (!current.to || to > current.to)) current.to = to;
    byAdmission.set(from, current);
  };
  for (const row of profileRows || []) touch(row);
  for (const row of dischargeRows || []) touch(row);

  const matches = [...byAdmission.values()]
    .filter(stay => stay.to && stay.from <= anchor && anchor <= stay.to);
  const unique = [...new Map(matches.map(stay => [`${stay.from}|${stay.to}`, stay])).values()];
  return unique.length === 1 ? unique[0] : null;
}

function hchanhFailureCacheKey(meta, wantedFiles, status = 'Hoàn tất') {
  const maBn = String(meta?.ma_bn || '').trim();
  const filesKey = [...(wantedFiles || [])].map(v => String(v || '').trim()).filter(Boolean).sort().join(',');
  return `${maBn}|${String(status || '').trim()}|${filesKey}`;
}

function hchanhFailureSignatureFromTrace(workerTrace = [], output = {}) {
  const tags = new Set((Array.isArray(workerTrace) ? workerTrace : []).map(ev => String(ev?.tag || '')));
  if (tags.has('ERROR.NO_PATIENT_LINK')) return 'no_patient_link';
  if (tags.has('ERROR.NO_URL_PROFILE') || tags.has('ERROR.NO_URL_DISCHARGE') || tags.has('ERROR.NO_URL_ORDER_HISTORY') || tags.has('ERROR.NO_URL_SURGERY')) return 'no_url';
  const statuses = Object.entries(output || {})
    .filter(([k, v]) => !String(k).startsWith('_') && v && typeof v === 'object')
    .map(([, v]) => String(v?._fetch_status || '').toLowerCase())
    .filter(Boolean);
  if (statuses.length && statuses.every(st => st === 'no_url')) return 'no_url';
  if (statuses.includes('no_session')) return 'no_session';
  if (statuses.includes('timeout')) return 'timeout';
  if (statuses.includes('error')) return 'error';
  return '';
}

// Trạng thái RIÊNG từng file của một ca (profile/discharge/surgery/order_history) để sổ
// thu thập biết phần nào có dữ liệu, phần nào EMR không có, phần nào lỗi.
function hchanhFileStatusPatch(output, rowCounts, wantedFiles, previousCounts, at, fallbackStatus = '') {
  const out = {};
  for (const f of wantedFiles || []) {
    const payload = output && typeof output === 'object' ? output[f] : null;
    const rows = Number(rowCounts?.[f]) || 0;
    const fetchStatus = payload && typeof payload === 'object' ? String(payload._fetch_status || '') : '';
    const entry = { fetch_status: fetchStatus || fallbackStatus || 'pending', rows, at };
    if (payload?._reason) entry.reason = String(payload._reason).slice(0, 120);
    if (payload?._error) entry.detail = String(payload._error).split('\n')[0].slice(0, 300);
    if (entry.fetch_status === 'ok' && rows === 0 && (Number(previousCounts?.[f]) || 0) > 0) {
      // EMR nay rỗng mà lần trước có dữ liệu: dữ liệu cũ được giữ, cần người xem.
      entry.override_status = 'blocked';
      entry.override_reason = 'emr_now_empty_previously_had_data';
    }
    out[f] = entry;
  }
  return out;
}

async function fetchHchanhForResearchRun(ctx, runDir, {
  sourceRows = [], sourceRunId = '', files = null, headless = true, force = false,
  fallbackDateFrom = '', fallbackDateTo = '', limit = 0,
  mode = 'hchanh_auto', saveRaw = false, forceKeys = null, refreshProvisional = false,
  // false: không ghi vào kho dùng chung (đối chiếu với EMR lấy vào thư mục riêng, không đè dữ liệu gốc).
  recordStore = true,
} = {}) {
  const normalizedMode = String(mode || '').trim() === 'order_history_auto' ? 'order_history_auto' : 'hchanh_auto';
  const wantedFiles = normalizedMode === 'order_history_auto' ? orderHistoryDefaultFiles(files) : hchanhDefaultFiles(files);
  const runLabel = normalizedMode === 'order_history_auto' ? orderHistoryRunLabel(wantedFiles) : 'hành chánh tự động';
  const progressFile = normalizedMode === 'order_history_auto' ? 'order_history_auto_progress.json' : 'hchanh_auto_progress.json';
  const rawFolder = normalizedMode === 'order_history_auto' ? 'order_history_auto_raw' : 'hchanh_auto_raw';
  const logPrefix = normalizedMode === 'order_history_auto' ? 'ORDER AUTO' : 'HC AUTO';

  const runPath = path.resolve(runDir);
  ensureDir(runPath);
  const progressPath = path.join(runPath, progressFile);
  const rawDir = path.join(runPath, rawFolder);
  ensureDir(rawDir);

  const rows = uniqueResearchHchanhRows(sourceRows, sourceRunId);
  const selectedRows = limit > 0 ? rows.slice(0, limit) : rows;
  let progress = readJsonSafe(progressPath, {}) || {};
  const failureCachePath = path.join(runPath, `${normalizedMode}_failure_cache.json`);
  let failureCache = readJsonSafe(failureCachePath, {}) || {};

  let profileRows = readCsvTable(path.join(runPath, 'hchanh_profile.csv'), Number.MAX_SAFE_INTEGER).rows;
  let dischargeRows = readCsvTable(path.join(runPath, 'hchanh_discharge.csv'), Number.MAX_SAFE_INTEGER).rows;
  let surgeryRows = readCsvTable(path.join(runPath, 'hchanh_surgery.csv'), Number.MAX_SAFE_INTEGER).rows;
  let orderRows = readCsvTable(path.join(runPath, 'hchanh_order_history.csv'), Number.MAX_SAFE_INTEGER).rows;

  // hchanh_fetch.py gộp nhiều BN vào 1 phiên Chrome/đăng nhập theo lô (xem
  // HCHANH_BATCH_SIZE bên dưới), giống cách script XN&CĐHA dùng lại 1 Chrome
  // cho cả lô. Đo lại tổng số lô + thời gian mỗi lô, ghi vào action_log.txt để
  // có số liệu cụ thể đánh giá tải lên server EMR, thay vì chỉ ước lượng cảm tính.
  const stats = { total: selectedRows.length, processed: 0, skipped: 0, reused: 0, ok: 0, attention: 0, error: 0, cancelled: false, chromeCycles: 0, chromeCycleMs: 0 };
  appendResearchRunLog(runPath, `[${new Date().toLocaleString('vi-VN')}] Bắt đầu lấy ${runLabel}: ${selectedRows.length} ca | files=${wantedFiles.join(',')}`);
  appendActivity(ctx, {
    kind: 'workflow.research.fetch_hchanh.start',
    mode: normalizedMode,
    run_dir: path.basename(runPath),
    total: selectedRows.length,
    files: wantedFiles,
  });

  // hchanh_fetch.py hỗ trợ gộp nhiều BN vào 1 phiên Chrome/đăng nhập khi --input là
  // JSON array (xem run_hchanh_fetch_batch). Thay vì spawn 1 tiến trình/ca (mỗi ca
  // 1 Chrome + 1 lần đăng nhập EMR), gộp tối đa HCHANH_BATCH_SIZE ca liên tiếp vào
  // 1 tiến trình worker — Chrome chỉ đóng+mở lại (đăng nhập lại) sau mỗi lô, giảm
  // hẳn số lần mở/tắt Chrome và đăng nhập dồn dập lên server EMR.
  // Mặc định 25 ca/lô: lô 20 ca chỉ đăng nhập EMR 1 lần. Đổi bằng EMR_HCHANH_BATCH_SIZE nếu máy yếu
  // (Chrome giữ lâu tốn RAM hơn) hoặc muốn ít lần đăng nhập hơn nữa.
  const HCHANH_BATCH_SIZE = Math.max(1, Math.min(200, Number(process.env.EMR_HCHANH_BATCH_SIZE) || 25));

  // Danh sách chờ tìm lại: BN từng không tìm thấy trên HIS (no_url/no_patient_link,
  // ghi trong failure cache) bị dời xuống cuối. Chỉ tìm lại khi mọi ca còn lại đã
  // lấy xong (done/partial) — tránh tốn Chrome dò đi dò lại BN không có trên danh
  // sách nội trú trong khi các ca khác còn chưa có dữ liệu. force=true bỏ qua cơ chế này.
  const DEFERRED_FAILURE_REASONS = ['no_patient_link', 'no_url'];
  const mainEntries = [];
  const deferredEntries = [];
  selectedRows.forEach((row, idx) => {
    const meta = researchHchanhMeta(row, sourceRunId);
    const previousFailure = failureCache[hchanhFailureCacheKey(meta, wantedFiles, 'Hoàn tất')];
    const deferred = !force && !forceKeys?.has(meta.source_key)
      && progress[meta.source_key]?.status !== 'done'
      && previousFailure && DEFERRED_FAILURE_REASONS.includes(String(previousFailure.reason || ''));
    (deferred ? deferredEntries : mainEntries).push({ row, idx });
  });
  if (deferredEntries.length) {
    appendResearchRunLog(runPath, `[${logPrefix}] ${deferredEntries.length} ca trong danh sách chờ tìm lại (từng không tìm thấy BN trên HIS) — dời xuống cuối, chỉ tìm lại khi các ca khác đã lấy đủ.`);
  }

  // Nguồn thường có nhiều dòng cho CÙNG một đợt nằm viện (mỗi khoa/lần chuyển khoa
  // một dòng, ngày vào lệch vài ngày). Worker tìm theo mã BN nên các dòng này đều mở
  // ra đúng một hồ sơ EMR và cho kết quả y hệt. Nhớ các đợt đã lấy trong lần chạy
  // này (ngày vào/ra THẬT do EMR trả về) để dòng sau cùng đợt dùng lại kết quả thay
  // vì mở Chrome lấy lại. BN có đợt nằm viện khác (ngày vào ngoài khoảng) vẫn lấy riêng.
  const fetchedStays = new Map();
  const rememberFetchedStay = (meta, key, output) => {
    const from = isoDate(output?.profile?.ngay_vao_vien || output?.profile?.ngay_vao || '');
    const to = isoDate(output?.discharge?.ngay_ra || '');
    if (!meta.ma_bn || !from || !to || from > to) return;
    const list = fetchedStays.get(meta.ma_bn) || [];
    list.push({ from, to, output, sourceKey: key });
    fetchedStays.set(meta.ma_bn, list);
  };
  const findFetchedStay = (meta, { allowStored = true } = {}) => {
    const admission = isoDate(meta.admission_raw || '');
    if (!admission) return null;
    const fresh = (fetchedStays.get(meta.ma_bn) || []).find(st => st.from <= admission && admission <= st.to);
    if (fresh) return fresh;
    if (!allowStored) return null;
    // Đợt đã lấy ở tab Hành chánh / Kiểm hồ sơ (kho dùng chung) — dùng lại, không mở EMR.
    return findStoredStay(meta.ma_bn, admission, wantedFiles, { onlyGoc: refreshProvisional }) || null;
  };
  const writeHchanhCsvs = () => {
    writeCsvUnion(path.join(runPath, 'hchanh_profile.csv'), profileRows, ['Mã NC', 'Mã BN', 'Họ tên', 'Giới', 'Ngày sinh', 'Tuổi', 'Địa chỉ', 'Điện thoại', 'Số CMND', 'Đối tượng', 'Số thẻ', 'Ngày vào viện', 'Ngày ra viện', 'Chẩn đoán', 'Mạch vào viện', 'Nhiệt độ vào viện', 'HA tâm thu vào viện', 'HA tâm trương vào viện', 'Nhịp thở vào viện', 'Cân nặng vào viện', 'Chiều cao vào viện', 'Research key']);
    writeCsvUnion(path.join(runPath, 'hchanh_discharge.csv'), dischargeRows, ['Mã NC', 'Mã BN', 'Họ tên', 'Ngày vào viện', 'Ngày ra viện', 'Thời gian điều trị', 'Chẩn đoán', 'Chẩn đoán ra viện', 'Bệnh kèm', 'Biến chứng', 'Tai biến', 'Tình trạng ra', 'Research key']);
    writeCsvUnion(path.join(runPath, 'hchanh_surgery.csv'), surgeryRows, ['Mã NC', 'Mã BN', 'Họ tên', 'Ngày vào viện', 'Ngày ra viện', 'Ngày phẫu thuật', 'Kết thúc phẫu thuật', 'Tên phẫu thuật', 'Đối tượng DV', 'Phương pháp phẫu thuật', 'PPVC', 'Phân loại PT', 'Trạng thái', 'ICD9', 'Chẩn đoán trước mổ', 'ICD10 trước mổ', 'Chẩn đoán sau mổ', 'ICD10 sau mổ', 'Mô tả PPPT', 'Trình tự phẫu thuật', 'Phẫu thuật viên chính', 'Bác sĩ gây mê chính', 'Phụ mổ 1', 'Phụ mổ 2', 'Điều dưỡng dụng cụ', 'KTV phụ mê', 'Diễn biến bệnh', 'Dặn dò sau PT', 'Bệnh kèm sau PT', 'Người hoàn tất', 'Phòng mổ', 'Research key']);
    writeCsvUnion(path.join(runPath, 'hchanh_order_history.csv'), orderRows, ['Mã NC', 'Mã BN', 'Họ tên', 'TG y lệnh', 'Ngày', 'Bác sĩ', 'Diễn biến', 'Tên y lệnh', 'Y lệnh khác', 'KQ', 'Trạng thái', 'Research key']);
  };

  let batchNo = 0;
  let passEntries = mainEntries;
  let retryingDeferred = false;
  for (let pass = 0; pass < 2; pass += 1) {
    const queue = passEntries.slice();
    while (queue.length) {
      if (isCancelRequested(ctx.sid)) {
        stats.cancelled = true;
        appendResearchRunLog(runPath, `[${logPrefix}] ĐÃ DỪNG theo yêu cầu trước lô ${batchNo + 1}; không spawn worker mới.`);
        break;
      }

      const chunkEntries = queue.splice(0, HCHANH_BATCH_SIZE);
      // Dòng cùng mã BN với 1 ca đã có trong lô này được dời sang lô sau: khi đó
      // ca trước đã lấy xong và dòng này có thể dùng lại kết quả (xem findFetchedStay).
      const postponed = [];
      // Trong lô, vẫn lọc bỏ các ca đã done giống hệt logic cũ (từng ca), chỉ những
      // ca THỰC SỰ cần fetch mới được đưa vào batchItems để gộp 1 Chrome.
      const batchItems = [];
      let chunkReused = 0;
      for (const { row, idx } of chunkEntries) {
        const meta = researchHchanhMeta(row, sourceRunId);
        const key = meta.source_key;
        // Không đưa họ tên vào log/trace (action_log.txt hay bị gửi ra ngoài để xem lỗi).
        const display = `${idx + 1}/${selectedRows.length} ${meta.ma_bn}${meta.research_code ? ` (${meta.research_code})` : ''}`;
        const sourceDateFrom = meta.date_from || fallbackDateFrom || '';
        const sourceDateTo = meta.date_to || fallbackDateTo || sourceDateFrom || '';
        const verifiedStay = verifiedStayWindowForSource(meta, profileRows, dischargeRows);
        const dateFrom = verifiedStay?.from || sourceDateFrom;
        const dateTo = verifiedStay?.to || sourceDateTo;
        const startCorrected = Boolean(verifiedStay && dateFrom !== sourceDateFrom);
        const windowCorrected = Boolean(
          verifiedStay && (startCorrected || dateTo !== sourceDateTo)
        );
        // Migration dữ liệu CŨ chỉ áp dụng cho tác vụ Lịch sử y lệnh. Với hành chánh/
        // phẫu thuật, worker đã sửa cửa sổ ngay trong lần lấy MỚI sau khi đọc profile,
        // không ép quét lại các phần đã có/tạm thời.
        const windowSensitive = normalizedMode === 'order_history_auto' && wantedFiles.includes('order_history');
        const previousWindowVersion = Number(progress[key]?.fetch_window_version || 0);
        // v3 thêm lọc sau-parse theo cửa sổ đợt điều trị. Dữ liệu v1/v2 có thể đã
        // chứa lịch sử y lệnh của các đợt cũ dù from/to đúng, nên phải lấy lại đúng
        // một lần để thay file thô bằng bản đã lọc. Sau v3, chỉ sửa lại khi mốc bắt
        // đầu từng bị cắt bởi dòng chuyển khoa; date_to đổi đơn thuần không ép quét.
        const windowFilterMigrationNeeded = windowSensitive
          && previousWindowVersion < VERIFIED_FETCH_WINDOW_VERSION;
        const windowNeedsRepair = windowSensitive && (
          windowFilterMigrationNeeded
          || (startCorrected && String(progress[key]?.fetch_date_from || '') !== dateFrom)
        );

        // forceKeys: điều phối tự động yêu cầu lấy lại đúng ca này (thiếu/lỗi/đã đổi)
        // dù progress cũ ghi done.
        // refreshProvisional: ca đang dùng dữ liệu tạm thời (Hành chánh / Kiểm hồ sơ) được quét lại để lấy dữ liệu gốc.
        // windowNeedsRepair: bản cũ đã lấy theo ngày chuyển khoa; tự lấy lại một lần bằng lượt thật.
        const forcedCase = force || Boolean(forceKeys?.has(key))
          || windowNeedsRepair
          || (refreshProvisional && (progress[key]?.provisional_files || []).length > 0);
        if (!forcedCase && progress[key]?.status === 'done') {
          stats.skipped += 1;
          continue;
        }
        if (windowNeedsRepair) {
          appendResearchRunLog(
            runPath,
            `[${logPrefix}] LẤY LẠI ${display}: bản cũ dùng cửa sổ trước sửa lỗi chuyển khoa; ${sourceDateFrom || '—'} → ${sourceDateTo || '—'} sẽ đổi thành ${dateFrom} → ${dateTo}.`,
          );
        }

        const failKey = hchanhFailureCacheKey(meta, wantedFiles, 'Hoàn tất');
        const previousFailure = failureCache[failKey];
        // Lượt chính gặp ca trong danh sách chờ không bao giờ xảy ra (đã tách ở trên);
        // nhánh này giữ cho ca chờ KHÔNG được tìm lại (các ca khác chưa đủ) được ghi
        // progress/trace rõ ràng thay vì im lặng.
        if (!forcedCase && !retryingDeferred && previousFailure && DEFERRED_FAILURE_REASONS.includes(String(previousFailure.reason || ''))) {
          stats.skipped += 1;
          progress[key] = {
            ...(progress[key] || {}),
            ma_bn: meta.ma_bn, ho_ten: meta.ho_ten, research_code: meta.research_code,
            encounter_id: key, admission_date: meta.admission_raw || '', discharge_date: meta.discharge_raw || '',
            status: 'skipped_recent_failure',
            skipped_at: nowIso(),
            skipped_reason: previousFailure.reason,
            previous_failure_at: previousFailure.ts,
            files: wantedFiles,
          };
          writeJsonAtomic(progressPath, progress);
          appendResearchRunLog(runPath, `[${logPrefix}] CHỜ TÌM LẠI ${display}: từng không tìm thấy (${previousFailure.reason}) lúc ${previousFailure.ts}; sẽ tìm lại khi các ca khác đã lấy đủ.`);
          appendResearchCaseTrace(runPath, {
            case_id: key, source_key: key, index: idx + 1, total: selectedRows.length, ma_bn: meta.ma_bn, ho_ten: meta.ho_ten, research_code: meta.research_code, date_from: meta.date_from || fallbackDateFrom || '', date_to: meta.date_to || fallbackDateTo || '', files: wantedFiles, mode: normalizedMode,
          }, [
            { ts: nowIso(), tag: 'CASE.START', step: 'Bắt đầu case nhưng phát hiện lỗi lặp gần đây', screen: 'server/routes/research.js', sees: display, takes: wantedFiles.join(','), writes: 'skip case', target: progressPath },
            { ts: nowIso(), tag: 'WARN', step: 'Dời vào danh sách chờ tìm lại: BN từng không tìm thấy trên HIS', screen: 'failure_cache', sees: `reason=${previousFailure.reason}; previous=${previousFailure.ts}`, takes: 'failure cache', writes: 'progress.status=skipped_recent_failure', target: failureCachePath },
          ], { mode: normalizedMode, status: 'skipped_recent_failure', files: wantedFiles, counts: {} });
          continue;
        }

        const reuse = force ? null : findFetchedStay(meta, { allowStored: !windowNeedsRepair });
        if (reuse) {
          const flat = hchanhFetchOutputToRows(reuse.output, row, sourceRunId);
          if (flat.profileRows.length) profileRows = dedupeRowsByStableKey(removeResearchSourceKey(profileRows, key).concat(flat.profileRows), ['Research key', 'Mã BN', 'Ngày vào viện', 'Ngày ra viện']);
          if (flat.dischargeRows.length) dischargeRows = dedupeRowsByStableKey(removeResearchSourceKey(dischargeRows, key).concat(flat.dischargeRows), ['Research key', 'Mã BN', 'Ngày vào viện', 'Ngày ra viện', 'Chẩn đoán ra viện']);
          if (flat.surgeryRows.length) surgeryRows = dedupeRowsByStableKey(removeResearchSourceKey(surgeryRows, key).concat(flat.surgeryRows), ['Research key', 'Mã BN', 'Ngày phẫu thuật', 'Tên phẫu thuật', 'Phương pháp phẫu thuật']);
          if (flat.orderRows.length) orderRows = dedupeRowsByStableKey(removeResearchSourceKey(orderRows, key).concat(flat.orderRows), ['Research key', 'Mã BN', 'TG y lệnh', 'Tên y lệnh', 'Y lệnh khác']);
          const sc = statusCountsFromHchanhOutput(reuse.output);
          const reuseCounts = { profile: flat.profileRows.length, discharge: flat.dischargeRows.length, surgery: flat.surgeryRows.length, order_history: flat.orderRows.length };
          stats.processed += 1;
          stats.reused += 1;
          if (sc.attention) stats.attention += 1;
          else stats.ok += 1;
          progress[key] = {
            ...(progress[key] || {}),
            ma_bn: meta.ma_bn, ho_ten: meta.ho_ten, research_code: meta.research_code,
            encounter_id: key, admission_date: meta.admission_raw || '', discharge_date: meta.discharge_raw || '',
            status: sc.attention ? 'partial' : 'done', finished_at: nowIso(), files: [...new Set([...(progress[key]?.files || []), ...wantedFiles])], counts: sc,
            file_status: { ...(progress[key]?.file_status || {}), ...hchanhFileStatusPatch(reuse.output, reuseCounts, wantedFiles, {}, nowIso()) },
            reused_from: reuse.sourceKey,
            fetch_window_version: VERIFIED_FETCH_WINDOW_VERSION,
            fetch_date_from: dateFrom,
            fetch_date_to: dateTo,
            // Dùng lại từ tab Hành chánh / Kiểm hồ sơ → dữ liệu tạm thời; lần quét lại của Kho nghiên cứu sẽ thay.
            provisional_files: reuse.provisional_files || [],
            rows: { profile: flat.profileRows.length, discharge: flat.dischargeRows.length, surgery: flat.surgeryRows.length, order_history: flat.orderRows.length },
          };
          chunkReused += 1;
          appendResearchRunLog(runPath, `[${logPrefix}] DÙNG LẠI ${display}: cùng đợt nằm viện ${reuse.from} → ${reuse.to} đã lấy ở ${String(reuse.sourceKey).startsWith('kho_hanh_chanh') ? 'tab Hành chánh / Kiểm hồ sơ (dữ liệu tạm thời)' : reuse.sourceKey === 'kho_nghien_cuu_goc' ? 'lần quét trước của Kho nghiên cứu (dữ liệu gốc)' : reuse.sourceKey}, không mở EMR lại.`);
          continue;
        }

        if (!force && batchItems.some(it => it.meta.ma_bn === meta.ma_bn)) {
          postponed.push({ row, idx });
          continue;
        }

        if (windowCorrected) {
          appendResearchRunLog(
            runPath,
            `[${logPrefix}] SỬA KHOẢNG ${display}: dòng nguồn ${sourceDateFrom || '—'} → ${sourceDateTo || '—'} là mốc khoa/quét; hồ sơ EMR xác minh lượt thật ${dateFrom} → ${dateTo}. Dùng lượt thật để không mất y lệnh trước chuyển khoa.`,
          );
        }
        // Kho dùng chung có sẵn một phần (vd ra viện từ Kiểm hồ sơ): dùng phần đó, chỉ mở EMR lấy file còn thiếu.
        let storedFiles = null;
        let storedTiers = null;
        let filesOverride = null;
        const storedPart = (force || windowNeedsRepair) ? null : findStoredStay(meta.ma_bn, isoDate(meta.admission_raw || ''), [], { onlyGoc: refreshProvisional });
        if (storedPart) {
          const have = wantedFiles.filter(k => storedPart.output?.[k]);
          if (have.length) {
            storedFiles = Object.fromEntries(have.map(k => [k, storedPart.output[k]]));
            storedTiers = storedPart.tiers || {};
            filesOverride = wantedFiles.filter(k => !storedPart.output?.[k]);
            appendResearchRunLog(runPath, `[${logPrefix}] DÙNG MỘT PHẦN ${display}: đã có ${have.join(',')} từ tab Hành chánh / Kiểm hồ sơ; chỉ lấy ${filesOverride.join(',')}.`);
          }
        }
        batchItems.push({ idx, row, meta, key, failKey, display, dateFrom, dateTo, storedFiles, storedTiers, filesOverride });
      }
      if (postponed.length) queue.unshift(...postponed);

      if (chunkReused) {
        // CSV trước, progress sau: progress "done" chỉ được ghi khi dữ liệu đã nằm trong CSV.
        writeHchanhCsvs();
        writeJsonAtomic(progressPath, progress);
      }
      if (!batchItems.length) continue;

      batchNo += 1;
      const batchInputPath = path.join(rawDir, `batch_input_${String(batchNo).padStart(4, '0')}.json`);
      const batchOutputPath = path.join(rawDir, `batch_output_${String(batchNo).padStart(4, '0')}.json`);
      const batchPayload = batchItems.map(({ row, meta, key, dateFrom, dateTo, filesOverride }) => ({
        ...row,
        ...(filesOverride?.length ? { _files_override: filesOverride } : {}),
        ma_bn: meta.ma_bn,
        ho_ten: meta.ho_ten,
        research_code: meta.research_code,
        date_from: dateFrom,
        date_to: dateTo,
        inpatient_status: 'Hoàn tất',
        research_mode: true,
        _progress_key: key,
      }));
      writeJsonAtomic(batchInputPath, batchPayload);
      appendResearchRunLog(runPath, `[${logPrefix}] Lô ${batchNo}: ${batchItems.length} ca (${batchItems[0].display} … ${batchItems[batchItems.length - 1].display}) | ${wantedFiles.join(',')} | 1 Chrome dùng chung cho cả lô`);

      for (const item of batchItems) {
        progress[item.key] = {
          ...(progress[item.key] || {}),
          ma_bn: item.meta.ma_bn, ho_ten: item.meta.ho_ten, research_code: item.meta.research_code,
          encounter_id: item.key, admission_date: item.meta.admission_raw || '', discharge_date: item.meta.discharge_raw || '',
          status: 'queued', files: [...new Set([...(progress[item.key]?.files || []), ...wantedFiles])],
          fetch_window_version: VERIFIED_FETCH_WINDOW_VERSION,
          fetch_date_from: item.dateFrom,
          fetch_date_to: item.dateTo,
        };
      }
      writeJsonAtomic(progressPath, progress);

      // Không truyền --from/--to chung cho cả lô: mỗi ca trong batchPayload đã có
      // date_from/date_to riêng, worker Python dùng giá trị của từng dòng khi field
      // top-level rỗng (xem _run_hchanh_fetch_core).
      const args = [
        '--input', batchInputPath, '--out', batchOutputPath, '--scope', 'discharge',
        '--files', wantedFiles.join(','), '--status', 'Hoàn tất',
        '--batch-size', String(HCHANH_BATCH_SIZE), '--progress-file', progressPath,
      ];
      if (headless) args.push('--headless');

      let result;
      const chromeCycleStartedAt = Date.now();
      try {
        result = await runScript('hchanh_fetch.py', args, {
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
          runtimeDir: ctx.dir,
        });
      } finally {
        unregisterCancel(ctx.sid);
      }
      // Không biết chính xác Chrome đã mở lại mấy lần trong lô (chỉ worker Python biết
      // khi nào phải soft-switch thất bại và mở lại) — coi tối thiểu 1 Chrome/lô để có
      // con số tham khảo trong log, số thật có thể cao hơn nếu EMR lỗi giữa lô.
      stats.chromeCycles += 1;
      stats.chromeCycleMs += Date.now() - chromeCycleStartedAt;

      const cancelRequested = isCancelRequested(ctx.sid);
      const batchOutput = readJsonSafe(batchOutputPath, {}) || {};
      if (!saveRaw) {
        try { fs.rmSync(batchInputPath, { force: true }); } catch (_) {}
        try { fs.rmSync(batchOutputPath, { force: true }); } catch (_) {}
      }

      for (const item of batchItems) {
        const { idx, row, meta, key, failKey, display, dateFrom, dateTo } = item;
        stats.processed += 1;
        const fetchedOutput = batchOutput[key];
        // Ghép phần đã có trong kho dùng chung; file vừa lấy từ EMR được ưu tiên.
        const output = fetchedOutput && item.storedFiles ? { ...item.storedFiles, ...fetchedOutput } : fetchedOutput;

        // Nếu worker bị kill vì người dùng bấm Dừng và ca này chưa kịp có kết quả
        // trong batchOutput, đây không phải lỗi dữ liệu của BN — đưa về pending_refetch.
        if (cancelRequested && !output) {
          stats.cancelled = true;
          progress[key] = { ...progress[key], status: 'pending_refetch', cancelled_at: nowIso(), error: '' };
          continue;
        }

        if (!output) {
          stats.error += 1;
          const message = result.spawnError || (result.killedByTimeout ? 'timeout' : (result.code !== 0 ? fmtPyError('hchanh_fetch.py lỗi', result) : 'không có kết quả trong output lô (worker có thể đã dừng giữa chừng)'));
          progress[key] = {
            ...progress[key], status: 'error', finished_at: nowIso(), error: message,
            file_status: { ...(progress[key]?.file_status || {}), ...hchanhFileStatusPatch(null, {}, wantedFiles, {}, nowIso(), result.killedByTimeout ? 'timeout' : 'error') },
          };
          appendResearchRunLog(runPath, `[${logPrefix}] LỖI ${display}: ${String(message).split('\n')[0]}`);
          appendResearchCaseTrace(runPath, {
            case_id: key, source_key: key, index: idx + 1, total: selectedRows.length, ma_bn: meta.ma_bn, ho_ten: meta.ho_ten, research_code: meta.research_code, date_from: dateFrom, date_to: dateTo, files: wantedFiles, mode: normalizedMode,
          }, [
            { ts: nowIso(), tag: 'CASE.START', step: 'Bắt đầu xử lý case nhưng worker lỗi', screen: 'server/routes/research.js', sees: display, takes: wantedFiles.join(','), writes: 'progress error', target: progressPath },
            { ts: nowIso(), tag: 'ERROR', step: 'hchanh_fetch.py (lô) trả lỗi', screen: 'worker/hchanh_fetch.py', sees: String(message).split('\n')[0], takes: 'stderr/stdout', writes: 'progress.status=error', target: progressPath },
          ], { mode: normalizedMode, status: 'error', files: wantedFiles, counts: {} });
          writeJsonAtomic(progressPath, progress);
          continue;
        }

        const workerTrace = Array.isArray(output?._case_trace) ? output._case_trace : [];
        const flat = hchanhFetchOutputToRows(output, row, sourceRunId);
        const countForKey = rows => rows.filter(r => String(r?.['Research key'] || '') === String(key)).length;
        const previousCounts = { profile: countForKey(profileRows), discharge: countForKey(dischargeRows), surgery: countForKey(surgeryRows), order_history: countForKey(orderRows) };
        // Chỉ thay dữ liệu cũ của case này khi lần fetch này THỰC SỰ có dòng mới
        // cho đúng bảng đó. Một lần scrape lỗi/rỗng (worker vẫn thoát code 0 nhưng
        // _fetch_status = empty/no_session/timeout) không được phép xóa mất dữ
        // liệu tốt đã lấy được ở lần trước — status của case vẫn có thể đọc là
        // partial/done trong khi dữ liệu thật đã bị thay bằng rỗng nếu không giữ.
        if (flat.profileRows.length) profileRows = dedupeRowsByStableKey(removeResearchSourceKey(profileRows, key).concat(flat.profileRows), ['Research key', 'Mã BN', 'Ngày vào viện', 'Ngày ra viện']);
        if (flat.dischargeRows.length) dischargeRows = dedupeRowsByStableKey(removeResearchSourceKey(dischargeRows, key).concat(flat.dischargeRows), ['Research key', 'Mã BN', 'Ngày vào viện', 'Ngày ra viện', 'Chẩn đoán ra viện']);
        if (flat.surgeryRows.length) surgeryRows = dedupeRowsByStableKey(removeResearchSourceKey(surgeryRows, key).concat(flat.surgeryRows), ['Research key', 'Mã BN', 'Ngày phẫu thuật', 'Tên phẫu thuật', 'Phương pháp phẫu thuật']);
        if (flat.orderRows.length) orderRows = dedupeRowsByStableKey(removeResearchSourceKey(orderRows, key).concat(flat.orderRows), ['Research key', 'Mã BN', 'TG y lệnh', 'Tên y lệnh', 'Y lệnh khác']);

        const sc = statusCountsFromHchanhOutput(output);
        const csvTraceEvents = [
          { ts: nowIso(), tag: 'OUTPUT.WRITE_CSV', step: 'Backend ghi bảng hchanh_profile.csv', screen: 'server/routes/research.js', sees: `profileRows=${flat.profileRows.length}; total=${profileRows.length}`, takes: 'output.profile', writes: 'hchanh_profile.csv', target: path.join(runPath, 'hchanh_profile.csv') },
          { ts: nowIso(), tag: 'OUTPUT.WRITE_CSV', step: 'Backend ghi bảng hchanh_discharge.csv', screen: 'server/routes/research.js', sees: `dischargeRows=${flat.dischargeRows.length}; total=${dischargeRows.length}`, takes: 'output.discharge', writes: 'hchanh_discharge.csv', target: path.join(runPath, 'hchanh_discharge.csv') },
          { ts: nowIso(), tag: 'OUTPUT.WRITE_CSV', step: 'Backend ghi bảng hchanh_surgery.csv', screen: 'server/routes/research.js', sees: `surgeryRows=${flat.surgeryRows.length}; total=${surgeryRows.length}`, takes: 'output.surgery.surgeries', writes: 'hchanh_surgery.csv', target: path.join(runPath, 'hchanh_surgery.csv') },
          { ts: nowIso(), tag: 'OUTPUT.WRITE_CSV', step: 'Backend ghi bảng hchanh_order_history.csv', screen: 'server/routes/research.js', sees: `orderRows=${flat.orderRows.length}; total=${orderRows.length}`, takes: 'output.order_history.rows', writes: 'hchanh_order_history.csv', target: path.join(runPath, 'hchanh_order_history.csv') },
        ];
        const failureSignature = hchanhFailureSignatureFromTrace(workerTrace, output);
        if (sc.error && failureSignature) {
          failureCache[failKey] = {
            ts: nowIso(), reason: failureSignature, ma_bn: meta.ma_bn, ho_ten: meta.ho_ten, files: wantedFiles, source_key: key,
            rows: { profile: flat.profileRows.length, discharge: flat.dischargeRows.length, surgery: flat.surgeryRows.length, order_history: flat.orderRows.length },
          };
          writeJsonAtomic(failureCachePath, failureCache);
        } else if (!sc.error && failureCache[failKey]) {
          delete failureCache[failKey];
          writeJsonAtomic(failureCachePath, failureCache);
        }
        if (sc.error) stats.error += 1;
        else if (sc.attention) stats.attention += 1;
        else stats.ok += 1;
        if (!sc.error) rememberFetchedStay(meta, key, output);
        // Phần Kho nghiên cứu vừa tự quét là dữ liệu gốc: ghi vào kho dùng chung, thay dữ liệu tạm thời.
        try {
          if (recordStore && fetchedOutput && !sc.error) recordHchanhFetch(meta.ma_bn, fetchedOutput, { admission: meta.admission_raw || dateFrom || '', source: 'kho_nghien_cuu' });
        } catch (err) {
          appendResearchRunLog(runPath, `[${logPrefix}] CẢNH BÁO ${display}: không ghi được vào kho dùng chung: ${String(err.message || err)}`);
        }
        const provisionalFromStore = item.storedFiles
          ? Object.keys(item.storedFiles).filter(k => !(fetchedOutput && fetchedOutput[k]) && item.storedTiers?.[k] !== 'goc')
          : [];
        const rowCounts = { profile: flat.profileRows.length, discharge: flat.dischargeRows.length, surgery: flat.surgeryRows.length, order_history: flat.orderRows.length };
        progress[key] = {
          ...progress[key], status: sc.error ? 'error' : (sc.attention ? 'partial' : 'done'),
          finished_at: nowIso(), output: path.basename(batchOutputPath), counts: sc,
          files: [...new Set([...(progress[key]?.files || []), ...wantedFiles])],
          fetch_window_version: VERIFIED_FETCH_WINDOW_VERSION,
          fetch_date_from: dateFrom,
          fetch_date_to: dateTo,
          rows: { ...(progress[key]?.rows || {}), ...Object.fromEntries(wantedFiles.map(f => [f, rowCounts[f] || 0])) },
          file_status: { ...(progress[key]?.file_status || {}), ...hchanhFileStatusPatch(output, rowCounts, wantedFiles, previousCounts, nowIso()) },
          provisional_files: provisionalFromStore,
        };
        // Progress của cả lô được ghi SAU khi CSV đã ghi xong (xem cuối lô). Nếu tiến trình
        // chết giữa hai bước, progress còn cũ → ca được lấy lại, không có "done" mà thiếu CSV.
        const savedTrace = appendResearchCaseTrace(runPath, {
          case_id: key,
          source_key: key,
          index: idx + 1,
          total: selectedRows.length,
          ma_bn: meta.ma_bn,
          ho_ten: meta.ho_ten,
          research_code: meta.research_code,
          date_from: dateFrom,
          date_to: dateTo,
          files: wantedFiles,
          mode: normalizedMode,
        }, workerTrace.concat(csvTraceEvents), {
          mode: normalizedMode,
          status: progress[key].status,
          files: wantedFiles,
          counts: { profile: flat.profileRows.length, discharge: flat.dischargeRows.length, surgery: flat.surgeryRows.length, order_history: flat.orderRows.length },
          output: saveRaw ? batchOutputPath : path.basename(batchOutputPath),
        });
        appendResearchRunLog(runPath, `[TRACE][CASE.END] ${display}: ghi case trace ${savedTrace?.events?.length || 0} bước vào ${CASE_TRACE_RECENT_JSON}`);
        appendResearchRunLog(runPath, `[${logPrefix}] Xong ${display}: status=${progress[key].status} | profile=${flat.profileRows.length}, discharge=${flat.dischargeRows.length}, surgery=${flat.surgeryRows.length}, order=${flat.orderRows.length}`);
      }

      // CSV union được ghi 1 lần sau khi xử lý xong cả lô (đủ, vì mỗi ca trong lô đã
      // gộp dòng của nó vào profileRows/dischargeRows/surgeryRows/orderRows ở trên),
      // rồi mới ghi progress của cả lô.
      writeHchanhCsvs();
      writeJsonAtomic(progressPath, progress);

      // Trường hợp người dùng bấm Dừng đúng lúc lô vừa hoàn tất: giữ kết quả các ca đã
      // xong trong lô nhưng tuyệt đối không chuyển sang lô tiếp theo.
      if (cancelRequested) {
        stats.cancelled = true;
        appendResearchRunLog(runPath, `[${logPrefix}] ĐÃ DỪNG sau lô ${batchNo}; kết quả các ca đã hoàn tất trong lô đã được giữ.`);
        break;
      }
    }
    if (pass > 0 || !deferredEntries.length) break;
    // Hết lượt chính: chỉ tìm lại danh sách chờ khi MỌI ca khác đã có dữ liệu
    // (done/partial). Còn ca lỗi/dừng giữa chừng thì ca chờ vẫn bị bỏ qua lần này.
    const pendingOthers = stats.cancelled ? mainEntries.length : mainEntries.filter(({ row }) => {
      const st = String(progress[researchHchanhMeta(row, sourceRunId).source_key]?.status || '');
      return st !== 'done' && st !== 'partial';
    }).length;
    retryingDeferred = pendingOthers === 0;
    if (retryingDeferred) {
      appendResearchRunLog(runPath, `[${logPrefix}] Các ca khác đã lấy đủ — tìm lại ${deferredEntries.length} ca trong danh sách chờ.`);
    } else if (!stats.cancelled) {
      appendResearchRunLog(runPath, `[${logPrefix}] Còn ${pendingOthers} ca khác chưa lấy đủ — chưa tìm lại ${deferredEntries.length} ca trong danh sách chờ.`);
    }
    if (stats.cancelled) break;
    passEntries = deferredEntries;
  }

  appendResearchRunLog(runPath, `[${new Date().toLocaleString('vi-VN')}] ${stats.cancelled ? 'Đã dừng' : 'Kết thúc'} lấy ${runLabel}: ok=${stats.ok}, partial=${stats.attention}, error=${stats.error}, skipped=${stats.skipped}, dùng lại=${stats.reused}`);
  if (stats.chromeCycles) {
    const avgSec = (stats.chromeCycleMs / stats.chromeCycles / 1000).toFixed(1);
    const totalMin = (stats.chromeCycleMs / 60000).toFixed(1);
    appendResearchRunLog(runPath, `[${logPrefix}] 🔐 Đã chạy ${stats.chromeCycles} lô (gộp tối đa ${HCHANH_BATCH_SIZE} ca/Chrome/lô, chỉ đăng nhập lại EMR khi sang lô mới) trong ${totalMin} phút — trung bình ${avgSec} giây/lô.`);
  }
  appendActivity(ctx, {
    kind: 'workflow.research.fetch_hchanh.finish',
    mode: normalizedMode,
    run_dir: path.basename(runPath),
    ok: stats.ok,
    partial: stats.attention,
    error: stats.error,
    skipped: stats.skipped,
    cancelled: stats.cancelled,
    chrome_cycles: stats.chromeCycles,
    chrome_cycle_ms_total: stats.chromeCycleMs,
  });
  const manifestPath = path.join(runPath, 'manifest.json');
  const manifest = readJsonSafe(manifestPath, {}) || {};
  writeJsonAtomic(manifestPath, {
    ...manifest,
    ...(normalizedMode === 'order_history_auto'
      ? { order_history_auto_at: nowIso(), order_history_auto_files: wantedFiles, order_history_auto_stats: stats }
      : { hchanh_auto_at: nowIso(), hchanh_auto_files: wantedFiles, hchanh_auto_stats: stats }),
  });
  return { ...stats, files: wantedFiles, progress_path: progressPath };
}

module.exports = {
  hchanhDefaultFiles,
  orderHistoryDefaultFiles,
  orderHistoryRunLabel,
  parseResearchHeadless,
  researchHeadlessFromBody,
  statusCountsFromHchanhOutput,
  hchanhFailureCacheKey,
  hchanhFailureSignatureFromTrace,
  hchanhFileStatusPatch,
  verifiedStayWindowForSource,
  fetchHchanhForResearchRun,
};
