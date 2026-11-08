// server/services/emr_case_probe.js — "Dò theo ca": đi qua mọi màn hình EMR mà app đang lấy dữ liệu,
// cho 1–3 người bệnh do người dùng chọn, và báo màn hình nào còn đọc được, màn hình nào hỏng.
//
// Cách làm: chạy ĐÚNG worker lấy dữ liệu thật (hchanh_fetch.py qua entrypoint an toàn, cùng chế độ
// Kho nghiên cứu) với đủ các phần dữ liệu, vào một thư mục RIÊNG trong runtime. Kết quả chỉ được đếm
// (bao nhiêu dòng / bao nhiêu ô có chữ ở mỗi màn hình) rồi so với đợt đã có trong Kho người bệnh.
//
// An toàn:
// - Chỉ đọc EMR (worker hchanh_fetch chỉ đọc); không ghi gì vào kho (không gọi recordHchanhFetch).
// - Tối đa MAX_CASES ca/lần, một tiến trình, một Chrome cho cả lô; chạy trong hàng đợi tác vụ nặng.
// - Dữ liệu bệnh án thô bị xoá khi xong; báo cáo chỉ giữ số đếm, trạng thái và mã người bệnh
//   do chính người dùng nhập.

'use strict';

const fs = require('fs');
const path = require('path');
const { readJsonSafe, writeJsonAtomic } = require('../utils/file');

const MAX_CASES = 3;
const REPORT_FILE = 'emr_case_probe_report.json';
const WORK_DIR = 'emr_case_probe';
// Tên progress file trùng với Kho nghiên cứu để worker chạy đúng nhánh nghiên cứu (xem
// worker/hchanh_fetch_entry.py), tức là dò đúng đường mà Kho nghiên cứu dùng để lấy dữ liệu.
const PROGRESS_FILE = 'hchanh_auto_progress.json';
const STATUS_INPATIENT = 'Đang thực hiện';
const STATUS_DISCHARGED = 'Hoàn tất';

// Thứ tự = thứ tự worker đi qua các màn hình.
const PROBE_SCREENS = [
  { key: 'profile', label: 'Hồ sơ người bệnh', where: 'Trang bác sĩ / điều dưỡng của người bệnh' },
  { key: 'discharge', label: 'Ra viện / Xử trí', where: 'Nhóm Ra viện → Xử trí' },
  { key: 'billing', label: 'Bảng kê chi phí', where: 'Bảng kê chi phí (Dịch vụ / Thuốc / Vật tư)' },
  { key: 'bed_days', label: 'Ngày giường', where: 'Chăm sóc → Ngày giường' },
  { key: 'order_history', label: 'Lịch sử y lệnh', where: 'Lịch sử y lệnh (hiển thị Tất cả)' },
  { key: 'surgery', label: 'Phẫu thuật', where: 'Danh sách phẫu thuật → Chi tiết phẫu thuật' },
  { key: 'cls', label: 'Kết quả cận lâm sàng', where: 'Kết quả → tab Chẩn đoán hình ảnh' },
  { key: 'documents', label: 'Giấy tờ kèm theo', where: 'Giấy tờ / tài liệu kèm theo' },
];
const PROBE_FILES = PROBE_SCREENS.map(s => s.key);

// Khóa kỹ thuật worker gắn vào mọi phần, không phải dữ liệu đọc từ màn hình.
const META_KEYS = new Set([
  'ma_bn', 'requested_inpatient_status', 'matched_inpatient_status', 'status_fallback_used', 'status', 'source',
]);
const BROKEN_STATUSES = new Set(['error', 'no_url', 'no_session', 'timeout']);

function text(v) { return String(v ?? '').trim(); }

function cleanCode(value) {
  const code = text(value);
  return /^[A-Za-z0-9._-]{1,40}$/.test(code) ? code : '';
}

// Lấy ngày trong chuỗi có kèm giờ: "13:00 28/09/2026", "28/09/2026 13:00", "2026-09-28".
function dayOf(value) {
  const s = text(value);
  let m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

function isoDate(value) {
  const s = text(value);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
}

function probeError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Kiểm tra danh sách ca người dùng nhập. Trả về ca đã chuẩn hóa, hoặc ném lỗi tiếng Việt.
 * @param {Array<{ma_bn:string, discharged?:boolean, admission?:string, discharge?:string}>} cases
 */
function normalizeCases(cases) {
  if (!Array.isArray(cases) || !cases.length) throw probeError('Nhập ít nhất một Mã BN để dò.');
  if (cases.length > MAX_CASES) throw probeError(`Mỗi lần chỉ dò tối đa ${MAX_CASES} ca để không làm nặng EMR. Bớt ca rồi bấm lại.`);
  const seen = new Set();
  return cases.map((raw, i) => {
    const ma_bn = cleanCode(raw?.ma_bn);
    if (!ma_bn) throw probeError(`Ca thứ ${i + 1}: Mã BN trống hoặc có ký tự lạ. Chỉ nhập chữ, số, dấu chấm, gạch ngang.`);
    if (seen.has(ma_bn)) throw probeError(`Mã BN ${ma_bn} bị nhập hai lần. Xoá bớt một dòng rồi bấm lại.`);
    seen.add(ma_bn);
    const admission = isoDate(raw?.admission);
    const discharge = isoDate(raw?.discharge);
    if (text(raw?.admission) && !admission) throw probeError(`Ca ${ma_bn}: ngày vào viện không đúng dạng dd/mm/yyyy.`);
    if (text(raw?.discharge) && !discharge) throw probeError(`Ca ${ma_bn}: ngày ra viện không đúng dạng dd/mm/yyyy.`);
    if (admission && discharge && discharge < admission) throw probeError(`Ca ${ma_bn}: ngày ra viện đứng trước ngày vào viện.`);
    return { ma_bn, discharged: Boolean(raw?.discharged), admission, discharge };
  });
}

/** Đếm dữ liệu thật trong một phần output của worker: số dòng trong các danh sách + số ô có chữ. */
function measurePayload(data) {
  const lists = {};
  let fields = 0;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { lists, rows: 0, fields: 0 };
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith('_') || META_KEYS.has(key)) continue;
    if (Array.isArray(value)) lists[key] = value.length;
    else if (value && typeof value === 'object') {
      for (const [subKey, sub] of Object.entries(value)) {
        if (Array.isArray(sub)) lists[`${key}.${subKey}`] = sub.length;
      }
    } else if (typeof value === 'number' ? Number.isFinite(value) : text(value) !== '') {
      fields += 1;
    }
  }
  const rows = Object.values(lists).reduce((a, b) => a + b, 0);
  return { lists, rows, fields };
}

function fetchStatus(data) {
  if (!data || typeof data !== 'object') return 'missing';
  return text(data._fetch_status || 'ok').toLowerCase();
}

function brokenMessage(status, data) {
  const err = text(data?._error || data?.error).split('\n')[0].slice(0, 300);
  if (status === 'no_url') {
    return 'Không tìm được đường vào màn hình này cho người bệnh. Nếu người bệnh đúng trạng thái và khoảng ngày thì nút hoặc đường dẫn trên EMR đã đổi: báo người phát triển kèm ảnh màn hình EMR chỗ này.';
  }
  if (status === 'no_session') return 'Không đăng nhập được EMR. Kiểm tra tài khoản hành chánh trong Cài đặt rồi dò lại.';
  if (status === 'timeout') return 'EMR phản hồi quá chậm ở màn hình này. Dò lại lúc EMR rảnh; nếu lần nào cũng chậm ở đúng chỗ này thì báo người phát triển.';
  return `Lỗi khi đọc màn hình này${err ? `: ${err}` : ''}. Báo người phát triển kèm thông báo này.`;
}

/**
 * Đánh giá một màn hình của một ca.
 * verdict: ok | empty | partial | suspect | broken | not_run
 */
function judgeScreen(screen, fresh, stored) {
  const status = fetchStatus(fresh);
  const got = measurePayload(fresh);
  const before = stored ? measurePayload(stored) : null;
  const base = {
    key: screen.key, label: screen.label, where: screen.where, fetch_status: status,
    rows: got.rows, fields: got.fields, lists: got.lists,
    stored_rows: before ? before.rows : null, stored_fields: before ? before.fields : null,
    reason: text(fresh?._reason),
  };
  if (status === 'missing') {
    return { ...base, verdict: 'not_run', message: 'Chưa chạy tới màn hình này (tác vụ dừng hoặc lỗi trước đó).' };
  }
  if (BROKEN_STATUSES.has(status)) return { ...base, verdict: 'broken', message: brokenMessage(status, fresh) };

  const hasData = got.rows + got.fields > 0;
  const storedHad = Boolean(before && before.rows + before.fields > 0);
  if (!hasData) {
    if (storedHad) {
      return {
        ...base, verdict: 'suspect',
        message: `Kho đang có ${before.rows ? `${before.rows} dòng` : `${before.fields} ô dữ liệu`} cho đợt này nhưng lần đọc này ra 0. Nghi bộ đọc không còn vào đúng chỗ trên EMR: mở EMR xem màn hình này còn dữ liệu không.`,
      };
    }
    if (base.reason === 'patient_not_completed_currently') {
      return { ...base, verdict: 'empty', message: 'Người bệnh chưa ra viện nên chưa có dữ liệu ra viện. Bình thường.' };
    }
    return {
      ...base, verdict: 'empty',
      message: 'Không đọc được gì. Có thể ca này thật sự không có dữ liệu ở đây; nếu mở EMR thấy có thì bộ đọc đã hỏng.',
    };
  }
  if (before && before.rows > 0 && got.rows === 0) {
    return {
      ...base, verdict: 'suspect',
      message: `Kho đang có ${before.rows} dòng nhưng lần này chỉ đọc được phần thông tin chung, 0 dòng chi tiết. Nghi bảng trên EMR đã đổi hoặc chưa tải xong khi đọc.`,
    };
  }
  if (before && before.rows >= 4 && got.rows < before.rows / 2) {
    return {
      ...base, verdict: 'suspect',
      message: `Đọc được ${got.rows} dòng, ít hơn hẳn ${before.rows} dòng đang có trong kho. Có thể EMR chỉ hiện một phần (phân trang, bộ lọc) hoặc bộ đọc bỏ sót.`,
    };
  }
  if (status === 'partial') {
    return { ...base, verdict: 'partial', message: 'Đọc được một phần. Xem lại màn hình này trên EMR để biết phần nào còn thiếu.' };
  }
  return { ...base, verdict: 'ok', message: '' };
}

// Bước lỗi/cảnh báo trong nhật ký worker của ca: chỉ giữ tên bước và màn hình (không có mã/tên BN).
function traceProblems(output) {
  const trace = Array.isArray(output?._case_trace) ? output._case_trace : [];
  return trace
    .filter(ev => /^(ERROR|WARN)/.test(text(ev?.tag)))
    .slice(-20)
    .map(ev => ({ tag: text(ev.tag), step: text(ev.step).slice(0, 220), screen: text(ev.screen).slice(0, 220) }));
}

/** Tóm tắt một ca: kết quả từng màn hình + vấn đề chung (không tìm thấy người bệnh, ...). */
function summarizeCase(probeCase, fresh, stored) {
  const output = fresh && typeof fresh === 'object' ? fresh : null;
  const screens = PROBE_SCREENS.map(s => judgeScreen(s, output?.[s.key], stored?.[s.key]));
  const problems = traceProblems(output);
  const notFound = problems.some(p => p.tag === 'ERROR.NO_PATIENT_LINK');
  const counts = {};
  for (const s of screens) counts[s.verdict] = (counts[s.verdict] || 0) + 1;
  let headline = '';
  if (!output) headline = 'Worker không trả kết quả cho ca này. Xem nhật ký máy chủ hoặc dò lại.';
  else if (output._fetch_status === 'error') headline = `Ca này lỗi trước khi vào EMR: ${text(output._error).split('\n')[0].slice(0, 200)}`;
  else if (notFound) headline = 'Không tìm thấy người bệnh trên Danh sách điều trị nội trú. Kiểm tra Mã BN, trạng thái (đang nằm / đã ra viện) và ngày vào viện.';
  return {
    ma_bn: probeCase.ma_bn,
    discharged: probeCase.discharged,
    compared_with_store: Boolean(stored),
    headline,
    counts,
    screens,
    problems,
  };
}

function workerRow(c) {
  return {
    ma_bn: c.ma_bn,
    date_from: c.admission,
    date_to: c.discharge || c.admission,
    inpatient_status: c.discharged ? STATUS_DISCHARGED : STATUS_INPATIENT,
    research_mode: true,
    _progress_key: c.ma_bn,
  };
}

function paths(runtimeDir) {
  const work = path.join(runtimeDir, WORK_DIR);
  return {
    report: path.join(runtimeDir, REPORT_FILE),
    work,
    input: path.join(work, 'input.json'),
    output: path.join(work, 'output.json'),
    progress: path.join(work, PROGRESS_FILE),
  };
}

function nowIso() { return new Date().toISOString(); }

function readReport(runtimeDir) {
  const p = paths(runtimeDir);
  const report = readJsonSafe(p.report, null);
  if (!report || report.status !== 'running') return report;
  // Đang chạy: ghép ca nào đang được đọc từ progress file của worker.
  const progress = readJsonSafe(p.progress, {}) || {};
  return {
    ...report,
    cases: (report.cases || []).map(c => ({ ...c, state: text(progress[c.ma_bn]?.status) || c.state })),
  };
}

/** Mọi lần mở lại máy chủ: báo cáo còn "đang chạy" là của tiến trình đã chết. */
function markInterrupted(runtimeDir, isActive) {
  const p = paths(runtimeDir);
  const report = readJsonSafe(p.report, null);
  if (!report || report.status !== 'running' || isActive) return report;
  const next = { ...report, status: 'interrupted', finished_at: nowIso(), message: 'Lần dò trước bị dừng giữa chừng (máy chủ khởi động lại hoặc bị dừng). Bấm dò lại.' };
  writeJsonAtomic(p.report, next);
  cleanupWork(runtimeDir);
  return next;
}

function cleanupWork(runtimeDir) {
  try { fs.rmSync(paths(runtimeDir).work, { recursive: true, force: true }); } catch (_) {}
}

/** Ghi báo cáo "đang chờ" ngay khi người dùng bấm, để tải lại trang vẫn thấy. */
function beginReport(runtimeDir, cases, { by = '' } = {}) {
  const report = {
    status: 'running',
    started_at: nowIso(),
    by,
    files: PROBE_FILES,
    cases: cases.map(c => ({ ma_bn: c.ma_bn, discharged: c.discharged, state: 'queued' })),
    message: 'Đang chờ tới lượt mở EMR.',
  };
  writeJsonAtomic(paths(runtimeDir).report, report);
  return report;
}

/**
 * Chạy dò theo ca. deps.runScript là python_runner.runScript (thay được trong test);
 * deps.findStored(ma_bn, day) trả output đợt trong kho hoặc null.
 */
async function runCaseProbe(runtimeDir, cases, { headless = true, runScript, findStored, onSpawn, isCancelled = () => false, fmtError = r => String(r?.stderr || '').split('\n').filter(Boolean).pop() || '' } = {}) {
  const p = paths(runtimeDir);
  const started = readJsonSafe(p.report, null) || beginReport(runtimeDir, cases);
  writeJsonAtomic(p.report, { ...started, message: 'Đang mở EMR và đọc từng màn hình.' });
  cleanupWork(runtimeDir);
  fs.mkdirSync(p.work, { recursive: true });
  writeJsonAtomic(p.input, cases.map(workerRow));

  const args = [
    '--input', p.input, '--out', p.output, '--scope', 'discharge',
    '--files', PROBE_FILES.join(','), '--batch-size', String(cases.length),
    '--progress-file', p.progress,
  ];
  if (headless) args.push('--headless');

  let result;
  let outputs = {};
  try {
    result = await runScript('hchanh_fetch.py', args, { onSpawn, runtimeDir });
    outputs = readJsonSafe(p.output, {}) || {};
  } finally {
    cleanupWork(runtimeDir);
  }

  const summaries = cases.map(c => {
    const fresh = outputs[c.ma_bn] || null;
    let stored = null;
    if (fresh && typeof findStored === 'function') {
      const day = dayOf(fresh.profile?.ngay_vao_vien || fresh.profile?.ngay_vao) || c.admission;
      try { stored = day ? findStored(c.ma_bn, day) : null; } catch (_) { stored = null; }
    }
    return summarizeCase(c, fresh, stored);
  });

  let status = 'done';
  let message = '';
  if (isCancelled()) { status = 'cancelled'; message = 'Đã dừng theo yêu cầu. Ca nào chưa kịp đọc sẽ ghi "Chưa chạy tới".'; }
  else if (result?.spawnError) { status = 'error'; message = `Không khởi động được Python: ${result.spawnError}`; }
  else if (result?.killedByTimeout) { status = 'error'; message = 'Dò quá lâu nên đã dừng. Dò lại với ít ca hơn.'; }
  else if (result && result.code !== 0 && !Object.keys(outputs).length) { status = 'error'; message = `Worker lỗi khi dò: ${fmtError(result)}`.slice(0, 400); }

  const totals = {};
  for (const s of summaries) for (const [k, v] of Object.entries(s.counts)) totals[k] = (totals[k] || 0) + v;
  const report = { ...started, status, finished_at: nowIso(), message, totals, cases: summaries };
  writeJsonAtomic(p.report, report);
  return report;
}

module.exports = {
  MAX_CASES, PROBE_SCREENS, PROBE_FILES, REPORT_FILE,
  normalizeCases, measurePayload, judgeScreen, summarizeCase, workerRow,
  beginReport, readReport, markInterrupted, runCaseProbe,
};
