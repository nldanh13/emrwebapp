// server/services/hchanh/dashboard.js
// Build dashboard hành chánh từ dữ liệu trong hchanh/.
//
// Khác với adminWorkflow cũ (đọc data/04_classified...):
//   - Đọc hchanh/index.json để lấy danh sách BN
//   - Đọc hchanh/patients/{ma_bn}/*.json để lấy dữ liệu từng loại
//   - Chạy QA trực tiếp trên dữ liệu đã lấy theo đúng scope

'use strict';

const {
  read_index,
  read_patient_all,
  check_missing_files,
  FETCH_SCOPES,
  resolve_scope_from_tags,
} = require('../../hchanh_data_contract');

const { readJsonSafe }                    = require('../../utils/file');
const { readTicketStore }                 = require('./ticket_store');
const { runDischargeQA_Hchanh }           = require('./discharge_qa');

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeArray(v) { return Array.isArray(v) ? v : []; }
function text(v, fb = '') { return String(v ?? '').replace(/\s+/g, ' ').trim() || fb; }

function countIssues(issues) {
  const list = safeArray(issues);
  return {
    errors:   list.filter(x => x?.severity === 'error').length,
    warnings: list.filter(x => x?.severity === 'warn').length,
    info:     list.filter(x => x?.severity === 'info').length,
  };
}

function workflowStatus(issues, ticket) {
  const c = countIssues(issues);
  if (ticket?.status === 'VERIFIED') return 'green';
  if (c.errors)   return 'red';
  if (c.warnings) return 'amber';
  return 'gray';
}

function priorityScore(issues, scope, ticket) {
  const c = countIssues(issues);
  let score = c.errors * 100 + c.warnings * 20;
  if (scope === 'discharge') score += 50;
  if (scope === 'surgery')   score += 25;
  if (scope === 'admission') score += 10;
  if (ticket && !['VERIFIED', 'CLOSED', 'NO_ISSUE'].includes(ticket?.status)) score += 30;
  return score;
}

function isNotFetchedIssue(issue) {
  const code = String(issue?.code || issue?.id || '').toUpperCase();
  return code.endsWith('_NOT_FETCHED') || code === 'PROFILE_NOT_FETCHED';
}

function normalizeIssuesForDashboard(issues) {
  // Thiếu file do chưa bấm lấy dữ liệu đã được thể hiện riêng bằng missing_files.
  // Không tính các issue *_NOT_FETCHED là lỗi đỏ, tránh màn hình báo lỗi giả khi BN mới đồng bộ từ danh sách quét.
  return safeArray(issues).map(issue => {
    if (!isNotFetchedIssue(issue)) return issue;
    return {
      ...issue,
      severity: 'info',
      transient: true,
      title: text(issue.title || 'Chưa lấy dữ liệu hành chánh'),
    };
  });
}

function hasAnyFetchedSignal(meta, check) {
  if (safeArray(check?.present).length > 0) return true;
  return Object.values(meta?.fetched || {}).some(Boolean);
}

function dataStateFromCheck(meta, check) {
  if (!safeArray(check?.missing).length) return 'complete';
  if (hasAnyFetchedSignal(meta, check)) return 'partial';
  return 'not_started';
}

const HOUSEKEEPING_DATA_KEYS = new Set([
  '_meta', '_source', '_fetch_status', '_error',
  'ma_bn', 'patient_id', 'patientId', 'id',
]);
const TECHNICAL_FETCH_STATUSES = new Set(['error', 'no_session', 'no_url', 'timeout', 'spawn_error']);

function fetchStatusOf(value) {
  return String(value?._fetch_status || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function hasPayloadData(value) {
  if (!value || typeof value !== 'object') return false;
  if (TECHNICAL_FETCH_STATUSES.has(fetchStatusOf(value))) return false;
  return Object.entries(value).some(([key, val]) => {
    if (HOUSEKEEPING_DATA_KEYS.has(key)) return false;
    if (val === undefined || val === null) return false;
    if (Array.isArray(val)) return val.length > 0;
    if (typeof val === 'object') return Object.keys(val).length > 0;
    return String(val).replace(/\s+/g, ' ').trim() !== '';
  });
}

function fileFetchStatusText(status, fileKey) {
  if (status === 'empty' && fileKey === 'discharge') {
    return 'Đã mở được màn hình ra viện/ra khoa nhưng EMR chưa có thông tin ra viện.';
  }
  if (status === 'empty') return 'Đã lấy được file nhưng nội dung đang rỗng.';
  if (status === 'partial') return 'Đã lấy được một phần dữ liệu, còn thiếu trường quan trọng.';
  if (status === 'no_url') return 'Không tìm được URL hồ sơ người bệnh.';
  if (status === 'no_session') return 'Chưa có phiên đăng nhập EMR hợp lệ.';
  if (status === 'error') return 'Worker báo lỗi khi lấy file này.';
  return '';
}

function countFileAttention(fileStatuses) {
  return Object.values(fileStatuses || {}).filter(s =>
    s?.required && ['empty', 'partial', 'missing', 'content_error', 'content_warning'].includes(s?.state)
  ).length;
}

function issueFileKeys(issue) {
  const code = String(issue?.code || issue?.id || '').toUpperCase();
  const group = normForIssue(issue?.group || '');
  const title = normForIssue(issue?.title || '');
  const detail = normForIssue(issue?.detail || '');
  const action = normForIssue(issue?.action || '');
  const owner = normForIssue(issue?.owner || '');
  const blob = [group, title, detail, action, owner].filter(Boolean).join(' | ');
  const keys = new Set();

  const hasAny = words => words.some(w => blob.includes(w));

  // Không chỉ dựa vào group/code. Nhiều issue QA sinh ra từ title/detail tiếng Việt
  // như “Thiếu xử trí / tình trạng ra viện” hoặc “Ngày giường chưa khớp quy tắc”.
  // Nếu không map các chuỗi này, bảng bên trái vẫn hiện ✓ dù panel phải báo lỗi.
  if (
    code.includes('PROFILE') || code.includes('BHYT') ||
    hasAny(['thong tin nen', 'hanh chinh', 'bhyt', 'doi tuong', 'ngay sinh', 'dia chi'])
  ) keys.add('profile');

  if (
    code.includes('DISCHARGE') || code.includes('FOLLOWUP') || code.includes('NGT') || code.includes('CLS_') ||
    hasAny([
      'ra vien', 'ra khoa', 'xuat vien', 'xuat khoa', 'xu tri', 'tinh trang ra', 'tinh trang bn ra',
      'ket qua dieu tri', 'ly do cho ve', 'loi dan', 'tai kham', 'hen kham', 'nghi ngt', 'so luu tru',
      'chan doan chinh', 'chan doan ra', 'icd10', 'chan doan vao khoa', 'chuyen khoa', 'can lam sang'
    ])
  ) keys.add('discharge');

  if (
    code.includes('BILLING') || code.includes('INVOICE') || code.includes('FEE') ||
    hasAny(['bang ke', 'chi phi', 'vien phi', 'tong tien', 'bhyt', 'mien giam', 'dong chi tra'])
  ) keys.add('billing');

  if (
    code.includes('BED_DAYS') || code.includes('BEDDAY') || code.includes('BED_') ||
    hasAny(['tien giuong', 'ngay giuong', 'giuong', 'ngay ke', 'so ngay thuc', 'so ngay tinh', 'hau phau'])
  ) keys.add('bed_days');

  if (
    code.includes('SURGERY') || code.includes('OPERATION') || code.includes('PTTT') ||
    hasAny(['phau thuat', 'thu thuat', 'pt/tt', 'phan loai pt', 'ds phau thuat', 'icd9', 'vo cam'])
  ) keys.add('surgery');

  if (
    code.includes('ORDER') || code.includes('Y_LENH') || code.includes('YLENH') ||
    hasAny(['y lenh', 'lich su y lenh', 'chua hoan tat', 'sau ra vien', 'phieu y lenh', 'chi dinh'])
  ) keys.add('order_history');

  return [...keys];
}

function normForIssue(value) {
  return String(value ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

function groupIssuesByFile(issues) {
  const out = {};
  for (const key of FETCH_SCOPES.discharge.files) out[key] = [];
  for (const issue of safeArray(issues).filter(i => i?.severity !== 'info')) {
    for (const key of issueFileKeys(issue)) {
      if (!out[key]) out[key] = [];
      out[key].push(issue);
    }
  }
  return out;
}

function fileStatusFor({ fileKey, data, meta, check, dataState, fetchErrorActive, issuesByFile }) {
  const required = safeArray(check?.files_required).includes(fileKey);
  const fileData = data?.[fileKey];
  const present = safeArray(check?.present).includes(fileKey) || Boolean(fileData);
  const fetchedAt = meta?.fetched?.[fileKey] || fileData?._meta?.fetched_at || null;
  const fetchStatus = fetchStatusOf(fileData);
  const hasPayload = hasPayloadData(fileData);
  const issues = safeArray(issuesByFile?.[fileKey]);
  const issueErrors = issues.filter(i => i?.severity === 'error').length;
  const issueWarnings = issues.filter(i => i?.severity === 'warn').length;
  const firstIssue = issues[0] || null;

  if (TECHNICAL_FETCH_STATUSES.has(fetchStatus)) {
    return { state:'fetch_error', tone:'red', symbol:'×', label:'Lỗi lấy', title: fileData?._error || fileFetchStatusText(fetchStatus, fileKey) || 'Lỗi khi lấy dữ liệu', required, present, fetchedAt, issueErrors, issueWarnings, issues };
  }
  if (fetchErrorActive && required && !present) {
    return { state:'fetch_error', tone:'red', symbol:'×', label:'Lỗi lấy', title: text(meta?.fetch_error || 'Lỗi khi lấy dữ liệu'), required, present, fetchedAt, issueErrors, issueWarnings, issues };
  }
  if (!required && !present) {
    return { state:'not_required', tone:'gray', symbol:'·', label:'Không cần', title:'Không thuộc nhóm cần lấy của người bệnh này', required, present, fetchedAt, issueErrors, issueWarnings, issues: [] };
  }
  if (!present) {
    if (dataState === 'not_started') return { state:'not_started', tone:'gray', symbol:'·', label:'Chưa lấy', title:'Chưa lấy dữ liệu', required, present, fetchedAt, issueErrors, issueWarnings, issues: [] };
    return { state:'missing', tone:'amber', symbol:'—', label:'Thiếu file', title:'Thiếu file dữ liệu cần lấy', required, present, fetchedAt, issueErrors, issueWarnings, issues: [] };
  }
  if (!hasPayload) {
    const emptyTitle = fileFetchStatusText(fetchStatus, fileKey) || 'Có file nhưng nội dung rỗng hoặc chưa đọc được trường chính';
    const emptyLabel = fetchStatus === 'empty' && fileKey === 'discharge' ? 'Chưa nhập' : 'Rỗng';
    return { state:'empty', tone:'amber', symbol:'!', label: emptyLabel, title: emptyTitle, required, present, fetchedAt, issueErrors, issueWarnings, issues };
  }
  if (fetchStatus === 'partial' && !issueErrors && !issueWarnings) {
    return { state:'partial', tone:'amber', symbol:'!', label:'Một phần', title: fileFetchStatusText(fetchStatus, fileKey), required, present, fetchedAt, issueErrors, issueWarnings, issues };
  }
  if (issueErrors || issueWarnings) {
    return {
      state: issueErrors ? 'content_error' : 'content_warning',
      tone:'amber',
      symbol:'!',
      label: issueErrors ? `${issueErrors} vấn đề` : `${issueWarnings} cảnh báo`,
      title: firstIssue?.title || 'Có vấn đề cần xử lý trong dữ liệu đã lấy',
      required, present, fetchedAt, issueErrors, issueWarnings, issues,
    };
  }
  return { state:'ok', tone:'green', symbol:'✓', label:'Đạt', title:'Đã có dữ liệu và chưa phát hiện vấn đề QA', required, present, fetchedAt, issueErrors, issueWarnings, issues: [] };
}

function computeWorkflowStatus({ fetchErrorActive, issueCounts, dataState, dataComplete, fileAttentionCount }) {
  if (fetchErrorActive) return 'red';              // lỗi kỹ thuật/Python/Selenium
  if (dataState === 'not_started') return 'gray';  // mới đồng bộ từ phiên quét, chưa lấy hành chánh
  if (issueCounts.errors || issueCounts.warnings || fileAttentionCount > 0) return 'amber'; // có dữ liệu nhưng cần xử lý nội dung
  if (dataComplete || dataState === 'complete') return 'green';
  return 'amber';                                  // đã lấy một phần nhưng còn thiếu file
}

function statusLabelFor({ workflowStatus, issueCounts, dataState, missingCount, fileAttentionCount }) {
  if (workflowStatus === 'red') return 'Lỗi máy';
  if (workflowStatus === 'green') return 'Đủ dữ liệu';
  if (workflowStatus === 'gray') return 'Chưa lấy';
  if (issueCounts.errors || issueCounts.warnings) {
    const total = issueCounts.errors + issueCounts.warnings;
    return `Cần xử lý ${total}`;
  }
  if (fileAttentionCount > 0) return `Cần xử lý ${fileAttentionCount}`;
  if (missingCount > 0) return `Thiếu ${missingCount}`;
  if (dataState === 'partial') return 'Thiếu nội dung';
  return 'Cần xem';
}


// ── Billing overview ─────────────────────────────────────────────────────────

function moneyNum(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function hasOwnBillingValue(obj, keys) {
  if (!obj || typeof obj !== 'object') return false;
  return keys.some(k => Object.prototype.hasOwnProperty.call(obj, k) && String(obj[k] ?? '').trim() !== '');
}

function moneyValueOrNull(obj, keys) {
  if (!hasOwnBillingValue(obj, keys)) return null;
  const key = keys.find(k => Object.prototype.hasOwnProperty.call(obj, k) && String(obj[k] ?? '').trim() !== '');
  return moneyNum(obj[key]);
}

function normalizeBillingLabel(value, fallback = 'Khác') {
  const raw = text(value, fallback);
  return raw.replace(/^\d+\.?\s*/, '').replace(/\s+/g, ' ').trim() || fallback;
}

function billingSourceKey(value) {
  const n = normForIssue(value);
  if (n.includes('bao hiem') || n === 'bhyt') return 'insurance';
  if (n.includes('vien phi') || n.includes('tu tuc') || n.includes('tu tra')) return 'self_pay';
  if (n.includes('trong goi') || n.includes('goi')) return 'package';
  if (n.includes('mien')) return 'exempt';
  return n || 'other';
}

function sourceLabelFor(key, fallback) {
  return ({
    insurance: 'Bảo hiểm',
    self_pay: 'Viện phí / tự trả',
    package: 'Trong gói',
    exempt: 'Miễn giảm',
    other: 'Khác',
  })[key] || text(fallback, 'Khác');
}

function classifyBillingRow(row) {
  const amount = moneyNum(row?.thanh_tien ?? row?.amount ?? row?.tong_tien);
  const payment = normForIssue(row?.payment_group || row?.doi_tuong || '');
  const sourceKey = billingSourceKey(row?.doi_tuong || row?.payment_group || 'other');
  const out = { total: amount, bhyt: 0, patient: 0, self_pay: 0, co_pay: 0, other: 0, package: 0, exempt: 0 };

  if (payment.includes('bhyt') || payment.includes('bao hiem')) out.bhyt = amount;
  else if (payment.includes('self') || payment.includes('tu tra') || payment.includes('tu tuc') || payment.includes('vien phi')) {
    out.patient = amount;
    out.self_pay = amount;
  } else if (sourceKey === 'package') {
    out.package = amount;
  } else if (sourceKey === 'exempt') {
    out.exempt = amount;
  } else if (payment.includes('zero')) {
    // Dòng zero vẫn giữ trong số dòng nhưng không cộng tiền.
  } else {
    out.other = amount;
  }
  return out;
}

function addBillingMoney(target, money) {
  for (const k of ['total', 'bhyt', 'patient', 'self_pay', 'co_pay', 'other', 'package', 'exempt']) {
    target[k] = moneyNum(target[k]) + moneyNum(money?.[k]);
  }
}

function sortBillingRows(rows, key = 'total') {
  return safeArray(rows).sort((a, b) => moneyNum(b?.[key]) - moneyNum(a?.[key]) || String(a?.label || a?.name || '').localeCompare(String(b?.label || b?.name || ''), 'vi'));
}

function buildBillingOverview(billing, issues) {
  if (!billing || typeof billing !== 'object') return null;
  const rows = safeArray(billing.rows);
  const sources = new Map();
  const groups = new Map();
  const departments = new Map();
  const topRows = [];

  for (const row of rows) {
    const money = classifyBillingRow(row);
    const srcKey = billingSourceKey(row?.doi_tuong || row?.payment_group || 'other');
    const src = sources.get(srcKey) || { key: srcKey, label: sourceLabelFor(srcKey, row?.doi_tuong), total: 0, bhyt: 0, patient: 0, self_pay: 0, co_pay: 0, other: 0, package: 0, exempt: 0, lines: 0 };
    addBillingMoney(src, money); src.lines += 1; sources.set(srcKey, src);

    const groupLabel = normalizeBillingLabel(row?.loai_yc || row?.group || row?.nhom || 'Khác');
    const groupKey = normForIssue(groupLabel) || 'other';
    const group = groups.get(groupKey) || { key: groupKey, label: groupLabel, total: 0, bhyt: 0, patient: 0, self_pay: 0, co_pay: 0, other: 0, package: 0, exempt: 0, lines: 0, sources: {} };
    addBillingMoney(group, money); group.lines += 1;
    group.sources[srcKey] = (group.sources[srcKey] || 0) + money.total;
    groups.set(groupKey, group);

    const deptLabel = text(row?.khoa, 'Không rõ khoa/phòng');
    const deptKey = normForIssue(deptLabel) || 'unknown';
    const dept = departments.get(deptKey) || { key: deptKey, label: deptLabel, total: 0, bhyt: 0, patient: 0, self_pay: 0, co_pay: 0, other: 0, package: 0, exempt: 0, lines: 0 };
    addBillingMoney(dept, money); dept.lines += 1; departments.set(deptKey, dept);

    if (money.total > 0 || money.patient > 0 || money.package > 0) {
      topRows.push({
        name: text(row?.name || row?.ten || row?.ma_dv, 'Khoản mục'),
        group: groupLabel,
        source: sourceLabelFor(srcKey, row?.doi_tuong),
        department: deptLabel,
        quantity: row?.sl ?? row?.so_luong ?? null,
        unit_price: moneyNum(row?.don_gia),
        total: money.total,
        bhyt: money.bhyt,
        patient: money.patient,
        package: money.package,
        payment_group: row?.payment_group || '',
      });
    }
  }

  const advanceValue = moneyValueOrNull(billing, ['tam_ung', 'tien_tam_ung', 'advance']);
  const summary = {
    total: moneyNum(billing.tong_cong) || rows.reduce((sum, r) => sum + moneyNum(r?.thanh_tien), 0),
    bhyt: moneyNum(billing.tong_bhyt),
    patient: moneyNum(billing.tong_tu_tuc),
    exempt: moneyNum(billing.tong_mien),
    other: 0,
    package: Array.from(sources.values()).find(s => s.key === 'package')?.total || 0,
    advance: advanceValue,
    advance_known: advanceValue !== null,
    rowsCount: rows.length,
  };
  summary.remaining = summary.advance_known ? Math.max(0, summary.patient - moneyNum(summary.advance)) : null;
  summary.remaining_estimated = summary.advance_known ? summary.remaining : Math.max(0, summary.patient);

  const attention = [];
  for (const issue of safeArray(issues)) {
    if (issue?.severity === 'info') continue;
    const keys = issueFileKeys(issue);
    if (keys.includes('billing') || keys.includes('bed_days') || keys.includes('order_history')) {
      attention.push({
        severity: issue.severity || 'warn',
        title: text(issue.title || issue.code || 'Cần kiểm tra'),
        detail: text(issue.detail || issue.action || ''),
        owner: text(issue.owner || ''),
      });
    }
  }
  const highPatientRows = sortBillingRows(topRows.filter(r => moneyNum(r.patient) > 0), 'patient').slice(0, 8);
  if (highPatientRows.length && highPatientRows[0].patient >= 1000000) {
    attention.unshift({
      severity: 'warn',
      title: `Khoản người bệnh tự trả cao: ${highPatientRows[0].patient.toLocaleString('vi-VN')} đ`,
      detail: highPatientRows[0].name,
      owner: 'Hành chính / viện phí',
    });
  }

  return {
    summary,
    sources: sortBillingRows(Array.from(sources.values()), 'total'),
    groups: sortBillingRows(Array.from(groups.values()), 'total'),
    departments: sortBillingRows(Array.from(departments.values()), 'total'),
    top_total: sortBillingRows(topRows, 'total').slice(0, 10),
    top_patient_pay: highPatientRows,
    attention,
  };
}

// ── Build card cho 1 BN ───────────────────────────────────────────────────────

function buildPatientCard(ctx, meta, ticket) {
  const ma_bn  = meta.ma_bn;
  const scope  = meta.scope_default || 'daily';
  const data   = read_patient_all(ctx, ma_bn);
  const check  = check_missing_files(ctx, ma_bn, scope);

  // Chạy QA chỉ với scope discharge. Các lỗi kiểu *_NOT_FETCHED được hạ xuống info
  // vì phần thiếu/chưa lấy đã có missing_files và data_state thể hiện rõ hơn.
  let qa     = null;
  let issues = [];
  if (scope === 'discharge') {
    const qa_result = runDischargeQA_Hchanh({ ma_bn, meta, data });
    qa     = qa_result.qa;
    issues = normalizeIssuesForDashboard(qa_result.issues);
  }

  const ic     = countIssues(issues);
  const complete = check.missing.length === 0;
  const state    = dataStateFromCheck(meta, check);
  const fetch_error_active = Boolean(meta.fetch_error && !complete);
  const issuesByFile = groupIssuesByFile(issues);
  const file_statuses = Object.fromEntries(
    FETCH_SCOPES.discharge.files.map(fileKey => [fileKey, fileStatusFor({
      fileKey, data, meta, check, dataState: state, fetchErrorActive: fetch_error_active, issuesByFile,
    })])
  );
  const fileAttentionCount = countFileAttention(file_statuses);
  const hasFileFetchError = Object.values(file_statuses || {}).some(s => s?.state === 'fetch_error');
  const status = computeWorkflowStatus({ fetchErrorActive: fetch_error_active || hasFileFetchError, issueCounts: ic, dataState: state, dataComplete: complete, fileAttentionCount });
  const status_label = statusLabelFor({ workflowStatus: status, issueCounts: ic, dataState: state, missingCount: check.missing.length, fileAttentionCount });
  const score  = priorityScore(issues, scope, ticket) + ((fetch_error_active || hasFileFetchError) ? 120 : 0);
  const billing_overview = buildBillingOverview(data.billing, issues);
  const billing_with_overview = data.billing && typeof data.billing === 'object'
    ? { ...data.billing, overview: billing_overview }
    : data.billing;

  return {
    ma_bn,
    ho_ten:          text(meta.ho_ten),
    phong:           text(meta.phong),
    department:      text(meta.department),
    admission_time:  text(meta.admission_time),
    inpatient_status: text(meta.inpatient_status),
    scope,
    scope_label:     FETCH_SCOPES[scope]?.label || scope,
    workflow_tags:   meta.workflow_tags || [],
    active:          meta.active !== false,
    stale:           Boolean(meta.stale),
    encounter_key:   meta.encounter_key || '',
    last_seen_at:    meta.last_seen_at || '',
    // Trạng thái fetch
    fetched:         meta.fetched || {},
    data_complete:   complete,
    data_state:      state,        // not_started | partial | complete
    has_started_fetch: state !== 'not_started',
    missing_files:   check.missing,
    present_files:   check.present,
    file_statuses,
    status_label,
    status_tone:     status,
    fetch_error:     (fetch_error_active || hasFileFetchError) ? (meta.fetch_error || 'Có file lấy bị lỗi kỹ thuật.') : null,
    fetch_error_raw: meta.fetch_error || null,
    fetch_error_active: fetch_error_active || hasFileFetchError,
    file_attention_count: fileAttentionCount,
    // Dữ liệu đã lấy
    has_profile:     Boolean(data.profile),
    has_discharge:   Boolean(data.discharge),
    has_billing:     Boolean(data.billing),
    has_bed_days:    Boolean(data.bed_days),
    has_surgery:     Boolean(data.surgery),
    has_order_history: Boolean(data.order_history),
    // QA & issues
    issues,
    issueCounts:     ic,
    qa,
    // Worklist
    workflowStatus:  status,
    priorityScore:   score,
    ticket:          ticket || null,
    ticketStatus:    ticket?.status || 'NONE',
    // Raw data (UI có thể dùng để hiển thị chi tiết)
    profile:   data.profile,
    discharge: data.discharge,
    billing:   billing_with_overview,
    billing_overview,
    bed_days:  data.bed_days,
    surgery:   data.surgery,
    order_history: data.order_history,
  };
}

// ── buildHchanh_Dashboard ─────────────────────────────────────────────────────

function buildHchanh_Dashboard(ctx) {
  const index    = read_index(ctx);
  const all_patients_meta = Object.values(index.patients || {});
  const patients_meta = all_patients_meta.filter(meta => !meta || meta.active !== false);

  const ticket_store = readTicketStore(ctx);
  const tickets_by_patient = {};
  for (const t of safeArray(ticket_store.tickets)) {
    if (!tickets_by_patient[t.ma_bn]) tickets_by_patient[t.ma_bn] = t;
  }

  const patients = patients_meta
    .map(meta => {
      try {
        return buildPatientCard(ctx, meta, tickets_by_patient[meta.ma_bn] || null);
      } catch (err) {
        console.error(`[HCHANH/dashboard] Lỗi build card ${meta.ma_bn}:`, err.message);
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) =>
      (b.priorityScore - a.priorityScore) ||
      String(a.phong).localeCompare(String(b.phong), 'vi') ||
      String(a.ho_ten).localeCompare(String(b.ho_ten), 'vi')
    );

  // Thống kê
  const counts = {
    total:          patients.length,
    all_indexed:     all_patients_meta.length,
    stale:           all_patients_meta.filter(p => p && p.active === false).length,
    discharge:      patients.filter(p => p.scope === 'discharge').length,
    surgery:        patients.filter(p => p.scope === 'surgery').length,
    admission:      patients.filter(p => p.scope === 'admission').length,
    daily:          patients.filter(p => p.scope === 'daily').length,

    // Các nhóm dưới đây là nhóm loại trừ theo trạng thái cuối cùng trên bảng.
    quality_ready:  patients.filter(p => p.workflowStatus === 'green').length,
    needs_review:   patients.filter(p => p.workflowStatus === 'amber').length,
    not_started:    patients.filter(p => p.workflowStatus === 'gray').length,
    machine_error:  patients.filter(p => p.workflowStatus === 'red').length,

    // Giữ tên cũ để không vỡ nơi khác, nhưng data_complete giờ ưu tiên “đủ và đạt QA”.
    data_complete:  patients.filter(p => p.workflowStatus === 'green').length,
    data_missing:   patients.filter(p => p.workflowStatus !== 'green').length,
    data_not_started: patients.filter(p => p.workflowStatus === 'gray').length,
    data_partial:   patients.filter(p => p.data_state === 'partial').length,
    content_issue:  patients.filter(p => p.workflowStatus === 'amber' && (p.issueCounts.errors > 0 || p.issueCounts.warnings > 0)).length,
    missing_file:   patients.filter(p => p.workflowStatus === 'amber' && !(p.issueCounts.errors > 0 || p.issueCounts.warnings > 0)).length,
    has_error:      patients.filter(p => p.issueCounts.errors > 0).length,
    has_warning:    patients.filter(p => p.issueCounts.warnings > 0).length,
    ready_to_print: patients.filter(p => p.qa?.canPrint).length,
    open_tickets:   patients.filter(p => p.ticket && !['VERIFIED', 'CLOSED', 'NO_ISSUE'].includes(p.ticketStatus)).length,
    fetch_error:    patients.filter(p => p.fetch_error_active).length,
  };

  return {
    status:       'ok',
    version:      2,
    generatedAt:  new Date().toISOString(),
    indexUpdatedAt: index.updatedAt || null,
    syncInfo:     index.lastSync || null,
    counts,
    total:        patients.length,
    patients,
  };
}

module.exports = { buildHchanh_Dashboard, buildPatientCard };
