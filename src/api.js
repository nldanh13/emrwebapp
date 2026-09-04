import { getSessionId } from './hooks/useSession.js';
import { logActivity } from './utils/activityLogger.js';

const APP_TOKEN_KEY = 'emr_app_token_v1';

function getStoredAppToken() {
  // Ưu tiên sessionStorage để mã truy cập tự mất khi đóng tab/trình duyệt.
  // Tương thích ngược: nếu bản cũ đã lưu ở localStorage thì migrate một lần rồi xoá.
  try {
    const sessionToken = sessionStorage.getItem(APP_TOKEN_KEY) || '';
    if (sessionToken) return sessionToken;

    const legacyToken = localStorage.getItem(APP_TOKEN_KEY) || '';
    if (legacyToken) {
      sessionStorage.setItem(APP_TOKEN_KEY, legacyToken);
      localStorage.removeItem(APP_TOKEN_KEY);
      return legacyToken;
    }
  } catch {}
  return '';
}

function setStoredAppToken(token) {
  try {
    if (token) sessionStorage.setItem(APP_TOKEN_KEY, token);
    else sessionStorage.removeItem(APP_TOKEN_KEY);
    localStorage.removeItem(APP_TOKEN_KEY);
  } catch {}
}

function promptForAppToken() {
  if (typeof window === 'undefined') return '';
  const token = window.prompt('Nhập mã truy cập nội bộ EMR_APP_TOKEN:');
  const cleaned = String(token || '').trim();
  if (cleaned) setStoredAppToken(cleaned);
  return cleaned;
}

function headers(extra = {}) {
  const token = getStoredAppToken();
  return {
    'Content-Type': 'application/json',
    'x-session-id': getSessionId(),
    ...(token ? { 'x-app-token': token } : {}),
    ...extra,
  };
}

function cleanApiPath(url) {
  try {
    const u = new URL(String(url), window.location.origin);
    for (const key of ['token', 'ott']) {
      if (u.searchParams.has(key)) u.searchParams.set(key, '[hidden]');
    }
    const qs = u.searchParams.toString();
    return u.pathname.replace(/^\/api\/?/, '/api/') + (qs ? `?${qs}` : '');
  } catch {
    return String(url || '').replace(/([?&](token|ott)=)[^&]+/gi, '$1[hidden]');
  }
}

function apiActionLabel(method, url) {
  const path = cleanApiPath(url).split('?')[0];
  const map = {
    'GET /api/run-scan': 'quét danh sách bệnh nhân',
    'GET /api/get-raw': 'tải dữ liệu thô',
    'GET /api/data': 'tải danh sách xếp phòng',
    'POST /api/save': 'lưu xếp phòng',
    'POST /api/run-details': 'lấy y lệnh/dữ liệu chi tiết',
    'POST /api/run-details-one': 'cập nhật y lệnh một người bệnh',
    'GET /api/run-postprocess': 'xử lý và phân loại dữ liệu',
    'GET /api/has-processed': 'kiểm tra dữ liệu đã xử lý',
    'GET /api/get-patients': 'tải danh sách người bệnh đã xử lý',
    'POST /api/check-input-changes': 'kiểm tra y lệnh mới trước khi nhập',
    'POST /api/run-input-care': 'nhập chăm sóc',
    'POST /api/run-input-infusions': 'nhập dịch truyền',
    'POST /api/run-input-procedures': 'nhập thủ thuật',
    'POST /api/run-input-vtyt': 'nhập/kiểm VTYT',
    'POST /api/preview-input-vtyt': 'quét xem trước VTYT',
    'POST /api/report-token': 'lấy quyền mở phiếu in',
    'GET /api/run-report-infusion': 'mở phiếu PDF',
    'GET /api/data-info': 'kiểm tra trạng thái dữ liệu',
    'GET /api/session-logs': 'tải log session',
    'GET /api/health': 'kiểm tra nhanh hệ thống',
    'GET /api/diagnostics': 'chẩn đoán hệ thống',
    'GET /api/runtime-health': 'kiểm tra trùng/lệch dữ liệu runtime',
    'POST /api/runtime-migrate': 'chuẩn hóa runtime và ticket store',
    'POST /api/clinic/preview': 'đọc danh sách phòng khám',
    'POST /api/clinic/care-preview': 'tìm người bệnh phòng khám cần nhập chăm sóc',
    'POST /api/clinic/care-order-seeds': 'lấy vị trí đau từ y lệnh đầu tiên cho danh sách',
    'GET /api/clinic/care-draft': 'tải bản nháp chăm sóc phòng khám',
    'POST /api/clinic/care-draft': 'lưu bản nháp chăm sóc phòng khám',
    'DELETE /api/clinic/care-draft': 'xoá bản nháp chăm sóc phòng khám',
    'POST /api/clinic/input-procedures': 'nhập thủ thuật phòng khám',
    'POST /api/clinic/input-care': 'nhập chăm sóc phòng khám',
    'GET /api/data-sessions': 'tải danh sách phiên dữ liệu',
    'DELETE /api/data-sessions': 'xoá phiên dữ liệu',
    'POST /api/cancel': 'huỷ tác vụ đang chạy',
    'GET /api/nurse-settings': 'tải lịch điều dưỡng',
    'POST /api/nurse-settings': 'lưu lịch điều dưỡng',
    'GET /api/admin-nurse-state': 'tải trạng thái kiểm hành chánh',
    'POST /api/admin-nurse-state': 'lưu trạng thái kiểm hành chánh',
    'POST /api/check-current-bed': 'kiểm buồng giường hiện tại',

    'GET /api/admin-workflow/dashboard': 'tải workflow hành chánh',
    'GET /api/admin-workflow/snapshot': 'tải snapshot hành chánh',
    'POST /api/admin-workflow/snapshot/morning': 'chốt snapshot sáng',
    'POST /api/admin-workflow/snapshot/afternoon': 'quét snapshot chiều',
    'POST /api/admin-workflow/diff': 'so chênh lệch hành chánh',
    'POST /api/admin-workflow/discharge-qa': 'QA hồ sơ xuất/chuyển',
    'GET /api/admin-workflow/forecast': 'tải dự trù thuốc/VTYT hành chánh',
    'GET /api/admin-workflow/billing-audit': 'rà bảng kê BHYT/tự túc',
    'GET /api/admin-workflow/surgery-package': 'rà gói dụng cụ phẫu thuật',
    'POST /api/admin-workflow/ticket': 'tạo phiếu sửa lỗi hành chánh',
    'PATCH /api/admin-workflow/ticket': 'cập nhật phiếu sửa lỗi hành chánh',
    'GET /api/admin-workflow/tickets': 'tải phiếu sửa lỗi hành chánh',
    'POST /api/admin-workflow/rescan': 'nghiệm thu lại lỗi hành chánh',
    'GET /api/admin-workflow/print-ready': 'kiểm điều kiện in hành chánh',
    'POST /api/admin-workflow/print-pack': 'tạo lệnh in nhanh hành chánh',
    'POST /api/hchanh/sync': 'đồng bộ danh sách kiểm hồ sơ',
    'GET /api/hchanh/dashboard': 'tải bảng hành chánh/kiểm hồ sơ',
    'POST /api/hchanh/fetch': 'lấy dữ liệu hành chánh/kiểm hồ sơ',
    'GET /api/hchanh/vtyt-draft': 'tải bản nháp VTYT hành chánh',
    'POST /api/hchanh/vtyt-draft': 'lưu bản nháp VTYT hành chánh',
    'DELETE /api/hchanh/vtyt-draft': 'xóa bản nháp VTYT hành chánh',
    'GET /api/hchanh/records-check/dashboard': 'tải danh sách kiểm hồ sơ hoàn tất',
    'POST /api/hchanh/records-check/scan-completed': 'quét danh sách hoàn tất kiểm hồ sơ',
    'POST /api/hchanh/records-check/export-pdf': 'xuất PDF kiểm hồ sơ đã kiểm',
    'POST /api/hchanh/records-check/google-sheet/update-row': 'sửa dòng Google Sheet kiểm hồ sơ',
    'POST /api/hchanh/records-check/paper-checklist': 'cập nhật checklist hồ sơ giấy',
    'GET /api/hchanh/records-check/submissions': 'tải lịch sử nộp hồ sơ',
    'POST /api/hchanh/records-check/submissions/add': 'xếp hồ sơ vào ngày nộp',
    'POST /api/hchanh/records-check/submissions/submit': 'chốt đợt hồ sơ đã nộp',
    'POST /api/hchanh/records-check/submissions/returned': 'đánh dấu hồ sơ bị trả về',
    'POST /api/hchanh/records-check/submissions/remove': 'bỏ hồ sơ khỏi đợt nộp chưa khóa',
    'POST /api/hchanh/records-check/submissions/export-pdf': 'xuất PDF theo ngày nộp hồ sơ',
    'POST /api/hchanh/records-check/submissions/discrepancy': 'ghi nhận sai sót sau bàn giao',
    'POST /api/hchanh/print-billing': 'in/lưu bảng kê hành chánh',
    'POST /api/hchanh/print-discharge-bundle': 'tổng hợp file in ra viện bệnh phòng',
    'GET /api/hchanh/print-ward-list': 'in danh sách xếp phòng',
    'POST /api/admin-workflow/clear': 'dọn dữ liệu hành chánh',
    'GET /api/export-data': 'xuất dữ liệu phiên',
    'POST /api/import-data': 'nhập dữ liệu phiên',
    'GET /api/research/studies': 'tải danh sách nghiên cứu',
    'POST /api/research/studies': 'tạo nghiên cứu mới',
    'POST /api/care-baseline/run': 'lấy lường cơ bản',
  };
  const exact = map[`${method} ${path}`];
  if (exact) return exact;
  if (method === 'DELETE' && path.startsWith('/api/data-sessions/')) return 'xoá phiên dữ liệu';
  if (path.startsWith('/api/research/studies/') && path.endsWith('/cohort')) return 'nạp danh sách nghiên cứu';
  if (path.startsWith('/api/research/studies/') && path.endsWith('/run')) return 'lấy dữ liệu nghiên cứu';
  if (path.startsWith('/api/research/studies/') && path.endsWith('/data')) return 'tải bảng nghiên cứu';
  if (path.startsWith('/api/research/studies/')) return 'tải nghiên cứu';
  return `${method} ${path}`;
}

function summarizeApiBody(body) {
  if (body == null) return null;
  if (Array.isArray(body)) return { type: 'array', count: body.length };
  if (typeof body !== 'object') return { type: typeof body };
  const visibleKeys = Object.keys(body).filter(k => !/password|pass|token|secret|cookie|authorization/i.test(k));
  const out = { type: 'object', keys: visibleKeys.slice(0, 20) };
  for (const key of ['targets', 'rows', 'patients']) {
    if (Array.isArray(body[key])) out[key] = { count: body[key].length };
  }
  if (body.patient) {
    out.patient = {
      ma_bn: body.patient.ma_bn || body.patient.id || body.patient['Mã BN'] || body.patient['Mã YT'] || '',
      so_phong: body.patient.so_phong || body.patient.room || body.patient.Vi_Tri || '',
    };
  }
  for (const key of ['date', 'dateFrom', 'dateTo', 'date_from', 'date_to', 'rooms', 'scope', 'partial']) {
    if (body[key] != null) out[key] = body[key];
  }
  return out;
}

function parseRequestBody(options = {}) {
  const raw = options.body;
  if (!raw || typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Đọc message lỗi từ response JSON của backend.
 * Tránh mất thông tin như "Python timeout", "thiếu file", "date_from sai định dạng".
 */
async function extractErrorMessage(res) {
  try {
    const data = await res.json();
    return data?.message || `${res.status} ${res.statusText}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

async function fetchWithAuth(url, options = {}, retryAuth = true, details = null) {
  const res = await fetch(url, options);
  if (res.status === 401 && retryAuth) {
    if (details) logActivity('api.auth.required', { ...details, status: res.status });
    const token = promptForAppToken();
    if (token) {
      const nextOptions = {
        ...options,
        headers: {
          ...(options.headers || {}),
          'x-app-token': token,
        },
      };
      return fetchWithAuth(url, nextOptions, false, details);
    }
  }
  return res;
}

async function request(url, options = {}, retryAuth = true) {
  const method = String(options.method || 'GET').toUpperCase();
  const label = apiActionLabel(method, url);
  const started = Date.now();
  const details = {
    method,
    url: cleanApiPath(url),
    label,
    body: summarizeApiBody(parseRequestBody(options)),
  };
  logActivity('api.request.start', details);

  let res;
  try {
    res = await fetchWithAuth(url, options, retryAuth, details);
  } catch (err) {
    logActivity('api.request.error', {
      ...details,
      duration_ms: Date.now() - started,
      message: String(err.message || err),
    });
    throw err;
  }

  if (res.ok) {
    const data = await res.json();
    logActivity('api.request.ok', {
      ...details,
      status: res.status,
      duration_ms: Date.now() - started,
      result: {
        status: data?.status || '',
        count: data?.count ?? data?.patients?.length ?? data?.rows?.length ?? data?.items?.length ?? '',
        message: data?.message || '',
      },
    });
    return data;
  }

  const msg = await extractErrorMessage(res);
  logActivity('api.request.error', {
    ...details,
    status: res.status,
    duration_ms: Date.now() - started,
    message: msg,
  });
  throw new Error(msg);
}

async function get(url) {
  return request(url, { headers: headers() });
}

async function post(url, body) {
  return request(url, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });
}

async function del(url) {
  return request(url, {
    method: 'DELETE',
    headers: headers(),
  });
}

function parseDownloadFilename(disposition, fallback) {
  const s = String(disposition || '');
  const utf = s.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf) { try { return decodeURIComponent(utf[1]); } catch {} }
  const plain = s.match(/filename=\"?([^\";]+)\"?/i);
  return plain?.[1] || fallback;
}

async function downloadBlob(url, fallbackFilename) {
  const method = 'GET';
  const label = apiActionLabel(method, url);
  const details = { method, url: cleanApiPath(url), label, body: null };
  logActivity('api.request.start', details);
  const started = Date.now();
  let res;
  try {
    res = await fetchWithAuth(url, { headers: headers() }, true, details);
  } catch (err) {
    logActivity('api.request.error', { ...details, duration_ms: Date.now() - started, message: String(err.message || err) });
    throw err;
  }
  if (!res.ok) {
    const msg = await extractErrorMessage(res);
    logActivity('api.request.error', { ...details, status: res.status, duration_ms: Date.now() - started, message: msg });
    throw new Error(msg);
  }
  const blob = await res.blob();
  const filename = parseDownloadFilename(res.headers.get('Content-Disposition'), fallbackFilename);
  logActivity('api.request.ok', { ...details, status: res.status, duration_ms: Date.now() - started, result: { filename, size: blob.size } });
  return { blob, filename };
}

async function openHtmlBlobInNewTab(url, fallbackTitle = 'emr_print.html') {
  const popup = typeof window !== 'undefined' ? window.open('', '_blank') : null;
  if (popup) {
    popup.document.write('<!doctype html><meta charset="utf-8"><title>Đang tải...</title><body>Đang tải phiếu in...</body>');
    popup.document.close();
  }

  const method = 'GET';
  const label = apiActionLabel(method, url);
  const details = { method, url: cleanApiPath(url), label, body: null };
  const started = Date.now();
  logActivity('api.request.start', details);

  let res;
  try {
    res = await fetchWithAuth(url, { headers: headers({ Accept: 'text/html' }) }, true, details);
  } catch (err) {
    if (popup) popup.close();
    logActivity('api.request.error', { ...details, duration_ms: Date.now() - started, message: String(err.message || err) });
    throw err;
  }

  if (!res.ok) {
    if (popup) popup.close();
    const msg = await extractErrorMessage(res);
    logActivity('api.request.error', { ...details, status: res.status, duration_ms: Date.now() - started, message: msg });
    throw new Error(msg);
  }

  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(new Blob([blob], { type: 'text/html;charset=utf-8' }));
  if (popup) {
    popup.location.replace(blobUrl);
  } else if (typeof window !== 'undefined') {
    window.open(blobUrl, '_blank');
  }
  setTimeout(() => URL.revokeObjectURL(blobUrl), 5 * 60 * 1000);
  logActivity('api.request.ok', { ...details, status: res.status, duration_ms: Date.now() - started, result: { filename: fallbackTitle, size: blob.size } });
  return { blobUrl, size: blob.size };
}

async function patch(url, body) {
  return request(url, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify(body),
  });
}

// ── Scan ──────────────────────────────────────────────────────────────────────
export const runScan = () => get('/api/run-scan');
export const getRaw = () => get('/api/get-raw');

// ── Board (room assignment) ───────────────────────────────────────────────────
export const getBoardData = () => get('/api/data');
export const saveBoardData = (rows) => post('/api/save', rows);

// ── Details (fetch Y lệnh per patient) ───────────────────────────────────────
export function runDetails(sortedRows, { dateFrom, dateTo, rooms, partial = false, scope = '' } = {}) {
  const params = new URLSearchParams();
  if (dateFrom) params.set('date_from', dateFrom);
  if (dateTo) params.set('date_to', dateTo);
  if (rooms?.length) params.set('rooms', rooms.join(','));
  if (partial) params.set('partial', '1');
  if (scope) params.set('scope', scope);
  return post(`/api/run-details?${params}`, sortedRows);
}


export function runDetailsOne(patient, { dateFrom, dateTo, selectedDates } = {}) {
  return post('/api/run-details-one', {
    patientId: patient?.ma_bn || patient?.id || patient?.['Mã BN'] || patient?.['Mã YT'],
    ho_ten: patient?.ho_ten || patient?.name || patient?.['Họ tên'],
    so_phong: patient?.so_phong || patient?.room || patient?.Vi_Tri,
    thoi_gian_vao_khoa: patient?.thoi_gian_vao_khoa || patient?.tg_vao || patient?.['T/G vào'] || patient?.thoi_gian_vao || patient?.admission_time,
    ten_khoa_dieu_tri: patient?.ten_khoa_dieu_tri || patient?.khoa_dieu_tri || patient?.khoa_chuyen_den || patient?.['Tên khoa điều trị'] || patient?.['Khoa điều trị'] || patient?.['Khoa chuyển đến'] || patient?.department_name || patient?.department,
    dateFrom,
    dateTo,
    selectedDates,
  });
}

// ── Post-process (classify Y lệnh) ───────────────────────────────────────────
export const runPostprocess = () => get('/api/run-postprocess');
export const hasProcessed = () => get('/api/has-processed');

// ── Patients (processed) ─────────────────────────────────────────────────────
export const getPatients = () => get('/api/get-patients');

// ── Research ────────────────────────────────────────────────────────────────
export const getResearchArchive = () => get('/api/research/archive');
export const uploadResearchArchiveSource = (payload) => post('/api/research/archive/source', payload);
export const getResearchArchiveData = ({ table = 'patients', runId = 'latest', redact = true } = {}) => {
  const params = new URLSearchParams();
  params.set('table', table);
  if (runId) params.set('runId', runId);
  params.set('redact', redact ? '1' : '0');
  return get(`/api/research/archive/data?${params}`);
};
export const getResearchArchiveCoverage = ({ runId = 'latest' } = {}) => {
  const params = new URLSearchParams();
  if (runId) params.set('runId', runId);
  return get(`/api/research/archive/coverage?${params}`);
};
export const getResearchArchiveProgress = ({ runId = 'latest' } = {}) => {
  const params = new URLSearchParams();
  if (runId) params.set('runId', runId);
  return get(`/api/research/archive/progress?${params}`);
};
export const getResearchArchivePatientHistory = ({ q = '', runId = 'latest' } = {}) => {
  const params = new URLSearchParams();
  if (runId) params.set('runId', runId);
  if (q) params.set('q', q);
  return get(`/api/research/archive/patient-history?${params}`);
};
export const getResearchArchiveVariableCatalog = ({ runId = 'latest' } = {}) => {
  const params = new URLSearchParams();
  if (runId) params.set('runId', runId);
  return get(`/api/research/archive/variable-catalog?${params}`);
};
export const downloadResearchArchiveCsv = ({ table = 'analysis_ready', runId = 'latest', redact = true } = {}) => {
  const params = new URLSearchParams();
  params.set('table', table);
  if (runId) params.set('runId', runId);
  params.set('redact', redact ? '1' : '0');
  return downloadBlob(`/api/research/archive/export?${params}`, `archive_${table}.csv`);
};
export const finalizeResearchArchiveDataset = () => post('/api/research/archive/finalize-dataset', {});
export const buildResearchArchiveEncodedDataset = () => post('/api/research/archive/build-encoded-dataset', {});
export const runResearchArchive = (options = {}) => post('/api/research/archive/run', options);
export const runResearchArchivePatientInfo = (options = {}) => post('/api/research/archive/patient-info', options);

export const getCareBaselineStatus = () => get('/api/care-baseline/status');
export const getCareBaselineLatest = () => get('/api/care-baseline/latest');
export const runCareBaseline = (options = {}) => post('/api/care-baseline/run', options);
export const exportCareBaseline = (runId = '') => downloadBlob(`/api/care-baseline/export${runId ? `?runId=${encodeURIComponent(runId)}` : ''}`, `care_baseline${runId ? `_${runId}` : ''}.csv`);
export const getResearchArchiveLog = ({ runId = 'latest', lines = 500 } = {}) => {
  const params = new URLSearchParams({ runId, lines });
  return get(`/api/research/archive/log?${params}`);
};
export const getResearchStudyLog = (studyId, { runId = 'latest', lines = 500 } = {}) => {
  const params = new URLSearchParams({ runId, lines });
  return get(`/api/research/studies/${encodeURIComponent(studyId)}/log?${params}`);
};
export const getResearchArchiveCaseTrace = ({ runId = 'latest', limit = 10, redact = true } = {}) => {
  const params = new URLSearchParams({ runId, limit, redact: redact ? '1' : '0' });
  return get(`/api/research/archive/case-trace?${params}`);
};
export const getResearchStudyCaseTrace = (studyId, { runId = 'latest', limit = 10, redact = true } = {}) => {
  const params = new URLSearchParams({ runId, limit, redact: redact ? '1' : '0' });
  return get(`/api/research/studies/${encodeURIComponent(studyId)}/case-trace?${params}`);
};
export const normalizeResearchArchive = () => post('/api/research/archive/normalize', {});
export const cleanResearchArchiveGenerated = (options = {}) => post('/api/research/archive/clean-generated', options);
export const importHchanhToResearchArchive = (options = {}) => post('/api/research/archive/import-hchanh', options);
export const fetchHchanhForResearchArchive = (options = {}) => post('/api/research/archive/fetch-hchanh', options);
export const fetchOrderHistoryForResearchArchive = (options = {}) => post('/api/research/archive/fetch-order-history', options);
export const listResearchStudies = () => get('/api/research/studies');
export const dismissFatalAlert = () => post('/api/research/archive/dismiss-alert', {});
export const deleteResearchStudy = (studyId) =>
  del(`/api/research/studies/${encodeURIComponent(studyId)}`);
export const saveCohortFromFiltered = (studyId, rows) =>
  post(`/api/research/studies/${encodeURIComponent(studyId)}/cohort-from-filtered`, { rows });
export const createResearchStudy = (payload) => post('/api/research/studies', payload);
export const getResearchStudy = (studyId) => get(`/api/research/studies/${encodeURIComponent(studyId)}`);
export const uploadResearchCohort = (studyId, payload) => post(`/api/research/studies/${encodeURIComponent(studyId)}/cohort`, payload);
export const getResearchData = (studyId, { table = 'patients', runId = 'latest', redact = true } = {}) => {
  const params = new URLSearchParams();
  params.set('table', table);
  if (runId) params.set('runId', runId);
  params.set('redact', redact ? '1' : '0');
  return get(`/api/research/studies/${encodeURIComponent(studyId)}/data?${params}`);
};
export const getResearchStudyCoverage = (studyId, { runId = 'latest' } = {}) => {
  const params = new URLSearchParams();
  if (runId) params.set('runId', runId);
  return get(`/api/research/studies/${encodeURIComponent(studyId)}/coverage?${params}`);
};
export const getResearchStudyProgress = (studyId, { runId = 'latest' } = {}) => {
  const params = new URLSearchParams();
  if (runId) params.set('runId', runId);
  return get(`/api/research/studies/${encodeURIComponent(studyId)}/progress?${params}`);
};
export const downloadResearchStudyCsv = (studyId, { table = 'analysis_ready', runId = 'latest', redact = true } = {}) => {
  const params = new URLSearchParams();
  params.set('table', table);
  if (runId) params.set('runId', runId);
  params.set('redact', redact ? '1' : '0');
  return downloadBlob(`/api/research/studies/${encodeURIComponent(studyId)}/export?${params}`, `${studyId}_${table}.csv`);
};
export const finalizeResearchStudyDataset = (studyId) => post(`/api/research/studies/${encodeURIComponent(studyId)}/finalize-dataset`, {});
export const buildResearchStudyEncodedDataset = (studyId) => post(`/api/research/studies/${encodeURIComponent(studyId)}/build-encoded-dataset`, {});
export const cleanResearchStudyGenerated = (studyId, options = {}) => post(`/api/research/studies/${encodeURIComponent(studyId)}/clean-generated`, options);
export const importResearchFromArchive = (studyId, filters = {}) => post(`/api/research/studies/${encodeURIComponent(studyId)}/import-from-archive`, filters);
export const normalizeResearchStudy = (studyId) => post(`/api/research/studies/${encodeURIComponent(studyId)}/normalize`, {});
export const runResearchStudy = (studyId, options = {}) => post(`/api/research/studies/${encodeURIComponent(studyId)}/run`, options);
export const runResearchStudyPatientInfo = (studyId, options = {}) => post(`/api/research/studies/${encodeURIComponent(studyId)}/patient-info`, options);
export const fetchHchanhForResearchStudy = (studyId, options = {}) => post(`/api/research/studies/${encodeURIComponent(studyId)}/fetch-hchanh`, options);
export const fetchOrderHistoryForResearchStudy = (studyId, options = {}) => post(`/api/research/studies/${encodeURIComponent(studyId)}/fetch-order-history`, options);
// Lấy hành chánh + y lệnh trong 1 lần (gộp files)
export const fetchHchanhAllForResearchArchive = (options = {}) => post('/api/research/archive/fetch-hchanh', { ...options, files: ['profile', 'discharge', 'surgery', 'order_history'] });
export const fetchHchanhAllForResearchStudy = (studyId, options = {}) => post(`/api/research/studies/${encodeURIComponent(studyId)}/fetch-hchanh`, { ...options, files: ['profile', 'discharge', 'surgery', 'order_history'] });
// Lấy lại chỗ thiếu
export const refetchMissingResearch = (options = {}) => post('/api/research/refetch-missing', options);
// Analysis config
export const getAnalysisPresets = () => get('/api/research/analysis-presets');
export const updateStudyAnalysisConfig = (studyId, config) => post(`/api/research/studies/${encodeURIComponent(studyId)}/analysis-config`, config);
export const getHealth = () => get('/api/health');
export const getDiagnostics = () => get('/api/diagnostics');
export const getRuntimeHealth = () => get('/api/runtime-health');
export const runRuntimeMigrate = () => post('/api/runtime-migrate', {});

export async function checkInputChanges(targets) {
  const url = '/api/check-input-changes';
  const method = 'POST';
  const label = apiActionLabel(method, url);
  const started = Date.now();
  const details = { method, url, label, body: summarizeApiBody(targets) };
  logActivity('api.request.start', details);

  let res;
  try {
    res = await fetchWithAuth(url, {
      method,
      headers: headers(),
      body: JSON.stringify(targets),
    }, true, details);
  } catch (err) {
    logActivity('api.request.error', { ...details, duration_ms: Date.now() - started, message: String(err.message || err) });
    throw err;
  }

  // 409 = phát hiện thay đổi và đã cập nhật dữ liệu; đây là kết quả hợp lệ để UI chặn nhập.
  if (res.status === 409) {
    const data = await res.json();
    logActivity('api.request.ok', {
      ...details,
      status: res.status,
      duration_ms: Date.now() - started,
      result: { status: data?.status || 'changed', message: data?.message || 'Có thay đổi mới' },
    });
    return data;
  }
  if (res.ok) {
    const data = await res.json();
    logActivity('api.request.ok', {
      ...details,
      status: res.status,
      duration_ms: Date.now() - started,
      result: { status: data?.status || '', message: data?.message || '' },
    });
    return data;
  }
  const msg = await extractErrorMessage(res);
  logActivity('api.request.error', { ...details, status: res.status, duration_ms: Date.now() - started, message: msg });
  throw new Error(msg);
}

// ── Input care ────────────────────────────────────────────────────────────────
export const runInputCare = (targets) => post('/api/run-input-care', targets);

// ── Input infusions ───────────────────────────────────────────────────────────
export const runInputInfusions = (targets) => post('/api/run-input-infusions', targets);

// ── Input procedures ─────────────────────────────────────────────────────────
export const runInputProcedures = (targets) => post('/api/run-input-procedures', targets);

// ── Input VTYT ───────────────────────────────────────────────────────────────
export const runInputVTYT = (targets) => post('/api/run-input-vtyt', targets);
export const previewInputVTYT = (targets) => post('/api/preview-input-vtyt', targets);

// ── Report PDF ────────────────────────────────────────────────────────────────
// Dùng One-Time Token (OTT) thay vì APP_TOKEN trực tiếp trên URL.
// APP_TOKEN trên URL lọt vào browser history và server access log — OTT thì không.
//
// Flow:
//  1. POST /api/report-token → { ott }  (token 1 lần, hết hạn sau 2 phút)
//  2. Mở URL /api/run-report-infusion?ott=<ott>&...  (không có APP_TOKEN)

export async function reportUrl({ date, dateFrom, dateTo, rows = null, source = '', start = 0, end = 23, no0 = false }) {
  const p = new URLSearchParams();
  if (dateFrom) { p.set('date_from', dateFrom); p.set('date_to', dateTo || dateFrom); }
  else if (date) p.set('date', date);
  p.set('start', String(start));
  p.set('end', String(end));
  if (no0) p.set('no0', '1');
  p.set('sid', getSessionId());

  // Lấy OTT nếu server đang dùng APP_TOKEN. Snapshot rows (nếu có) được gắn vào
  // OTT ở server để PDF dùng đúng dữ liệu đang hiển thị, không đọc/parsing nguồn lại.
  const report = Array.isArray(rows)
    ? { date: date || '', source: source || '', rows }
    : null;
  const { ott } = await post('/api/report-token', report ? { report } : {});
  if (ott) p.set('ott', ott);

  return `/api/run-report-infusion?${p}`;
}

// ── Data info (for startup choice screen) ────────────────────────────────────
export const getFeatureRegistry = () => get('/api/features');
export const getFeatureDefinition = (featureId) => get(`/api/features/${encodeURIComponent(featureId)}`);
export const updateFeatureState = (featureId, payload) => patch(`/api/features/${encodeURIComponent(featureId)}/state`, payload);
export const resetFeatureState = (featureId) => del(`/api/features/${encodeURIComponent(featureId)}/state`);
export const reloadFeatureRegistry = () => post('/api/features/reload', {});
export const getWorkflows = () => get('/api/workflows');
export const planWorkflow = (workflowId, payload = {}) => post(`/api/workflows/${encodeURIComponent(workflowId)}/plan`, payload);
export const runWorkflow = (workflowId, payload = {}) => post(`/api/workflows/${encodeURIComponent(workflowId)}/run`, payload);
export const getWorkflowRuns = (workflowId = '') => get(`/api/workflows/runs${workflowId ? `?workflow_id=${encodeURIComponent(workflowId)}` : ''}`);
export const getWorkflowRun = (runId) => get(`/api/workflows/runs/${encodeURIComponent(runId)}`);
export const cancelWorkflowRun = (runId) => post(`/api/workflows/runs/${encodeURIComponent(runId)}/cancel`, {});
export const getArtifacts = () => get('/api/artifacts');
export const updateWorkflowState = (workflowId, payload) => patch(`/api/workflows/${encodeURIComponent(workflowId)}/state`, payload);
export const resetWorkflowState = (workflowId) => del(`/api/workflows/${encodeURIComponent(workflowId)}/state`);

export const getDataInfo = () => get('/api/data-info');
export const getSessionLogs = () => get('/api/session-logs');
export const getDataSessions = () => get('/api/data-sessions');
export const deleteDataSession = (sid) => del('/api/data-sessions/' + encodeURIComponent(sid));

// ── Cancel running task ───────────────────────────────────────────────────────
export const cancelTask = () => post('/api/cancel', {});

// ── Nurse settings ────────────────────────────────────────────────────────────
export const getNurseSettings = () => get('/api/nurse-settings');
export const saveNurseSettings = (payload) => post('/api/nurse-settings', payload);


// ── Điều dưỡng hành chánh ───────────────────────────────────────────────────
export const getAdminNurseState = () => get('/api/admin-nurse-state');
export const saveAdminNurseState = (payload) => post('/api/admin-nurse-state', payload);
export const checkCurrentBed = (patient) => post('/api/check-current-bed', { patient });

export const getAdminWorkflowDashboard = () => get('/api/admin-workflow/dashboard');
export const getAdminWorkflowPatient = (patientId) => get(`/api/admin-workflow/patient/${encodeURIComponent(patientId)}`);
export const getAdminWorkflowSnapshot = () => get('/api/admin-workflow/snapshot');
export const createAdminWorkflowMorningSnapshot = () => post('/api/admin-workflow/snapshot/morning', {});
export const createAdminWorkflowAfternoonSnapshot = () => post('/api/admin-workflow/snapshot/afternoon', {});
export const diffAdminWorkflowSnapshots = () => post('/api/admin-workflow/diff', {});
export const runAdminWorkflowDischargeQA = (patientId = '') => post('/api/admin-workflow/discharge-qa', patientId ? { patientId } : {});
export const getAdminWorkflowForecast = (days = 3) => get(`/api/admin-workflow/forecast?days=${encodeURIComponent(days)}`);
export const getAdminWorkflowBillingAudit = (patientId = '') => get(`/api/admin-workflow/billing-audit${patientId ? `?patientId=${encodeURIComponent(patientId)}` : ''}`);
export const getAdminWorkflowSurgeryPackage = (patientId = '') => get(`/api/admin-workflow/surgery-package${patientId ? `?patientId=${encodeURIComponent(patientId)}` : ''}`);
export const createAdminWorkflowTicket = (patientId, payload = {}) => post('/api/admin-workflow/ticket', { patientId, ...payload });
export const updateAdminWorkflowTicket = (ticketId, payload = {}) => patch(`/api/admin-workflow/ticket/${encodeURIComponent(ticketId)}`, payload);
export const getAdminWorkflowTickets = () => get('/api/admin-workflow/tickets');
export const rescanAdminWorkflow = (patientId = '') => post('/api/admin-workflow/rescan', patientId ? { patientId } : {});
export const getAdminWorkflowPrintReady = () => get('/api/admin-workflow/print-ready');
export const createAdminWorkflowPrintPack = () => post('/api/admin-workflow/print-pack', {});
export const clearAdminWorkflow = () => post('/api/admin-workflow/clear', {});

// ── Phòng khám ───────────────────────────────────────────────────────────────
export const runClinicPreview = (payload) => post('/api/clinic/preview', payload);
export const runClinicCarePreview = (payload) => post('/api/clinic/care-preview', payload);
export const runClinicInputCare = (payload) => post('/api/clinic/input-care', payload);
export const runClinicCareOrderSeeds = (payload) => post('/api/clinic/care-order-seeds', payload);
export const getClinicCareDraft = () => get('/api/clinic/care-draft');
export const saveClinicCareDraft = (payload) => post('/api/clinic/care-draft', payload);
export const clearClinicCareDraft = () => del('/api/clinic/care-draft');
export const runClinicInputProcedures = (payload) => post('/api/clinic/input-procedures', payload);

// ── Export / Import session data ──────────────────────────────────────────────

/** Tải dữ liệu session về dưới dạng Blob JSON (không để token trên URL). */
export async function exportData() {
  const url = '/api/export-data';
  const method = 'GET';
  const label = apiActionLabel(method, url);
  const started = Date.now();
  const details = { method, url, label };
  logActivity('api.request.start', details);
  let res;
  try {
    res = await fetchWithAuth(url, { headers: headers() }, true, details);
  } catch (err) {
    logActivity('api.request.error', { ...details, duration_ms: Date.now() - started, message: String(err.message || err) });
    throw err;
  }
  if (!res.ok) {
    const msg = await extractErrorMessage(res);
    logActivity('api.request.error', { ...details, status: res.status, duration_ms: Date.now() - started, message: msg });
    throw new Error(msg);
  }
  logActivity('api.request.ok', { ...details, status: res.status, duration_ms: Date.now() - started, result: { status: 'ok' } });
  return res.blob();
}

export async function importData(bundle) {
  return post('/api/import-data', { bundle });
}

// ── Hành chánh (hchanh) ───────────────────────────────────────────────────────
export const getHchanh_Index     = ()            => get('/api/hchanh/index');
export const syncHchanh          = (patients)    => post('/api/hchanh/sync', patients ? { patients } : {});
export const getHchanh_Dashboard = ()            => get('/api/hchanh/dashboard');
export const getHchanh_VtytDraft = ()             => get('/api/hchanh/vtyt-draft');
export const saveHchanh_VtytDraft = (draft)          => post('/api/hchanh/vtyt-draft', { draft });
export const clearHchanh_VtytDraft = ()               => del('/api/hchanh/vtyt-draft');
export const getRecordsCheckDashboard = ()       => get('/api/hchanh/records-check/dashboard');
export const getRecordsCheckGoogleSheet = ()      => get('/api/hchanh/records-check/google-sheet');
export const syncRecordsCheckGoogleSheet = (options = {}) => post('/api/hchanh/records-check/google-sheet/sync', options);
export const updateRecordsCheckGoogleSheetRow = (payload = {}) => post('/api/hchanh/records-check/google-sheet/update-row', payload);
export const setRecordsCheckChecked = (caseKeyOrKeys, checked) => {
  const caseKeys = Array.isArray(caseKeyOrKeys) ? caseKeyOrKeys.filter(Boolean) : [caseKeyOrKeys].filter(Boolean);
  return post('/api/hchanh/records-check/checked', { case_key: caseKeys[0] || '', case_keys: caseKeys, checked: Boolean(checked) });
};
export const startRecordsCheckFetchBatch = (payload = {}) => post('/api/hchanh/records-check/fetch-batch', payload);
export const stopRecordsCheckFetchBatch = () => post('/api/hchanh/records-check/stop', {});
export const exportRecordsCheckPdf = (payload = {}) => post('/api/hchanh/records-check/export-pdf', payload);
export const setRecordsCheckPaperChecklist = (caseKeyOrKeys, patch, actor = '') => {
  const caseKeys = Array.isArray(caseKeyOrKeys) ? caseKeyOrKeys.filter(Boolean) : [caseKeyOrKeys].filter(Boolean);
  return post('/api/hchanh/records-check/paper-checklist', { case_keys: caseKeys, patch: patch || {}, actor });
};
export const getRecordsCheckSubmissions = () => get('/api/hchanh/records-check/submissions');
export const addRecordsCheckSubmission = (payload = {}) => post('/api/hchanh/records-check/submissions/add', payload);
export const submitRecordsCheckSubmission = (payload = {}) => post('/api/hchanh/records-check/submissions/submit', payload);
export const markRecordsCheckSubmissionReturned = (payload = {}) => post('/api/hchanh/records-check/submissions/returned', payload);
export const removeRecordsCheckSubmissionItems = (payload = {}) => post('/api/hchanh/records-check/submissions/remove', payload);
export const exportRecordsCheckSubmissionPdf = (payload = {}) => post('/api/hchanh/records-check/submissions/export-pdf', payload);
export const addRecordsCheckSubmissionDiscrepancy = (payload = {}) => post('/api/hchanh/records-check/submissions/discrepancy', payload);
export const scanRecordsCheckCompleted = (options = {}) => {
  const hasHeadless = Object.prototype.hasOwnProperty.call(options || {}, 'headless')
    || Object.prototype.hasOwnProperty.call(options || {}, 'hidden')
    || Object.prototype.hasOwnProperty.call(options || {}, 'run_hidden')
    || Object.prototype.hasOwnProperty.call(options || {}, 'runHidden');
  return post('/api/hchanh/records-check/scan-completed', {
    ...(options?.date_from || options?.dateFrom ? { date_from: options.date_from || options.dateFrom } : {}),
    ...(options?.date_to || options?.dateTo ? { date_to: options.date_to || options.dateTo } : {}),
    ...(hasHeadless ? { headless: Boolean(options.headless ?? options.hidden ?? options.run_hidden ?? options.runHidden) } : { headless: true }),
  });
};
export const getHchanh_Patient   = (ma_bn)       => get(`/api/hchanh/patient/${encodeURIComponent(ma_bn)}`);
export const fetchHchanh         = (ma_bn, scope, files, dateFrom, dateTo, options = {}) => {
  const inpatientStatus = String(options?.inpatient_status || options?.inpatientStatus || options?.status || '').trim();
  const caseKey = String(options?.case_key || options?.caseKey || options?.encounter_key || options?.encounterKey || '').trim();
  const hasHeadless = Object.prototype.hasOwnProperty.call(options || {}, 'headless')
    || Object.prototype.hasOwnProperty.call(options || {}, 'hidden')
    || Object.prototype.hasOwnProperty.call(options || {}, 'run_hidden')
    || Object.prototype.hasOwnProperty.call(options || {}, 'runHidden');
  return post('/api/hchanh/fetch', {
    ma_bn,
    scope,
    ...(files ? { files } : {}),
    ...(dateFrom ? { date_from: dateFrom, date_to: dateTo || dateFrom } : {}),
    ...(inpatientStatus ? { inpatient_status: inpatientStatus } : {}),
    ...(caseKey ? { case_key: caseKey, records_check: true } : {}),
    ...(options?.records_check || options?.recordsCheck ? { records_check: true } : {}),
    ...(hasHeadless ? { headless: Boolean(options.headless ?? options.hidden ?? options.run_hidden ?? options.runHidden) } : {}),
  });
};
export const getHchanh_Tickets   = ()            => get('/api/hchanh/tickets');
export const createHchanh_Ticket = (ma_bn, payload = {}) => post('/api/hchanh/ticket', { ma_bn, ...payload });
export const updateHchanh_Ticket = (ticketId, payload)   => patch(`/api/hchanh/ticket/${encodeURIComponent(ticketId)}`, payload);
export const createHchanh_Snapshot = (kind)     => post(`/api/hchanh/snapshot/${encodeURIComponent(kind)}`, {});
export const getHchanh_Snapshot  = ()           => get('/api/hchanh/snapshot');
export const clearHchanh_Patient = (ma_bn)      => post('/api/hchanh/clear-patient', { ma_bn });
export const clearHchanh         = ()           => post('/api/hchanh/clear', {});

export const rescanHchanh        = (ma_bn)       => post('/api/hchanh/rescan', { ma_bn });
export const openHchanh_BedEdit = (ma_bn, dateTo = '') => post('/api/hchanh/open-bed-edit', { ma_bn, ...(dateTo ? { date_to: dateTo } : {}) });
export const printHchanh_BillingPdf = (ma_bn, ho_ten = '', dateTo = '') => post('/api/hchanh/print-billing', { ma_bn, ho_ten, ...(dateTo ? { date_to: dateTo } : {}) });
export async function downloadHchanh_BillingPdf(fileName) {
  const res = await fetchWithAuth(`/api/hchanh/printed-billing/${encodeURIComponent(fileName)}`, { headers: headers() });
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.blob();
}

export const printWard_DischargeBundle = (ma_bn, ho_ten = '', dateTo = '', dischargeDate = '') =>
  post('/api/hchanh/print-discharge-bundle', {
    ma_bn,
    ho_ten,
    ...(dateTo ? { date_to: dateTo, selected_dates: [dateTo] } : {}),
    ...(dischargeDate ? { ngay_ra_vien_date: dischargeDate } : {}),
  });
export const printWard_DischargeBundleBatch = (patients = [], dateTo = '', selectedDates = []) =>
  post('/api/hchanh/print-discharge-bundle-batch', {
    patients,
    ...(dateTo ? { date_to: dateTo } : {}),
    ...(Array.isArray(selectedDates) && selectedDates.length ? { selected_dates: selectedDates } : {}),
  });
export async function downloadWard_DischargeBundle(fileName) {
  const res = await fetchWithAuth(`/api/hchanh/discharge-bundle/${encodeURIComponent(fileName)}`, { headers: headers() });
  if (!res.ok) throw new Error(await extractErrorMessage(res));
  return res.blob();
}
export const printHchanh_Ticket  = (ticketId)    => openHtmlBlobInNewTab(`/api/hchanh/ticket/${encodeURIComponent(ticketId)}/print`, `hchanh_ticket_${ticketId}.html`);
export const printHchanh_WardList = ()           => openHtmlBlobInNewTab('/api/hchanh/print-ward-list', 'hchanh_danh_sach_xep_phong.html');
export async function exportHchanh_Issues(format = 'csv', owner = '') {
  const qs  = new URLSearchParams({ format, ...(owner ? { owner } : {}) }).toString();
  const url = `/api/hchanh/export/issues?${qs}`;
  const res = await fetchWithAuth(url, { headers: headers() });
  return res;
}

// ── VTYT Catalog ──────────────────────────────────────────────────────────────
export const getVtytCatalog      = ()              => get('/api/vtyt-catalog');
export const updateVtytCatalog   = (key, body)    => patch(`/api/vtyt-catalog/${encodeURIComponent(key)}`, body);
export const resetVtytCatalog    = (key)           => post(`/api/vtyt-catalog/reset/${encodeURIComponent(key)}`, {});
