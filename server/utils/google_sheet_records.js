'use strict';

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');

function text(value) {
  return String(value ?? '').replace(/^\uFEFF/, '').replace(/\s+/g, ' ').trim();
}

function stripDiacritics(value) {
  return text(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function normalizeHeader(value) {
  return stripDiacritics(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeName(value) {
  return normalizeHeader(value);
}

function normalizeStorageIdentity(value) {
  const raw = text(value);
  if (!raw) return { raw: '', number: '', kind: '', year: '', full_key: '', legacy_key: '' };

  const slashParts = raw.split('/').map(part => part.trim()).filter(Boolean);
  let number = '';
  if (slashParts.length >= 2 && /^\d+$/.test(slashParts[1])) {
    number = slashParts[1].replace(/^0+/, '') || '0';
  }

  if (!number) {
    const compact = raw.replace(/[.,\s]/g, '');
    if (/^\d+$/.test(compact)) number = compact.replace(/^0+/, '') || '0';
  }

  const groups = raw.match(/\d+/g) || [];
  if (!number && groups.length) {
    const likely = groups
      .map((digits, index) => ({ digits, index }))
      .filter(item => !(item.digits.length === 4 && /^20\d{2}$/.test(item.digits)))
      .sort((a, b) => b.digits.length - a.digits.length || a.index - b.index)[0]
      || groups.map((digits, index) => ({ digits, index })).sort((a, b) => b.digits.length - a.digits.length || a.index - b.index)[0];
    number = likely?.digits ? (likely.digits.replace(/^0+/, '') || '0') : '';
  }

  const upper = stripDiacritics(raw).toUpperCase();
  const kind = /(^|[^A-Z0-9])BT([^A-Z0-9]|$)|BINH\s*THUONG/.test(upper)
    ? 'BT'
    : (/(^|[^A-Z0-9])TN([^A-Z0-9]|$)|TAI\s*NAN/.test(upper) ? 'TN' : '');
  const year = (groups.find(group => /^20\d{2}$/.test(group)) || '');
  const fullKey = number && kind && year ? `${year}::${kind}::${number}` : '';
  return { raw, number, kind, year, full_key: fullKey, legacy_key: number };
}

function normalizeStorageKey(value) {
  return normalizeStorageIdentity(value).legacy_key;
}

function parseCsv(csvText) {
  const input = String(csvText ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (field || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows.filter(cells => cells.some(cell => text(cell)));
}

function parseVietnameseTimestamp(value) {
  const raw = text(value);
  if (!raw) return null;
  let match = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (match) {
    return new Date(
      Number(match[3]),
      Number(match[2]) - 1,
      Number(match[1]),
      Number(match[4] || 0),
      Number(match[5] || 0),
      Number(match[6] || 0),
    ).getTime();
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function findHeaderIndex(headers, candidates) {
  const wanted = candidates.map(normalizeHeader);
  return headers.findIndex(header => wanted.includes(header));
}

function parseGoogleSheetRecords(csvText) {
  const rows = parseCsv(csvText);
  if (!rows.length) throw new Error('Google Sheet không có dữ liệu.');

  const headers = rows[0].map(normalizeHeader);
  const timestampIndex = findHeaderIndex(headers, ['Dấu thời gian', 'Thời gian', 'Timestamp']);
  const storageIndex = findHeaderIndex(headers, ['Số lưu trữ', 'Số lưu trữ hồ sơ', 'Số hồ sơ', 'So luu tru']);
  const nameIndex = findHeaderIndex(headers, ['Họ và tên', 'Họ tên', 'Tên người bệnh', 'Ho va ten']);

  if (storageIndex < 0) {
    throw new Error('Google Sheet thiếu cột “Số lưu trữ”.');
  }

  const recordsByIdentityAndName = new Map();
  rows.slice(1).forEach((cells, offset) => {
    const storageRaw = text(cells[storageIndex]);
    const storageIdentity = normalizeStorageIdentity(storageRaw);
    if (!storageIdentity.number) return;

    const timestamp = timestampIndex >= 0 ? text(cells[timestampIndex]) : '';
    const patientName = nameIndex >= 0 ? text(cells[nameIndex]) : '';
    const timestampMs = parseVietnameseTimestamp(timestamp);
    const record = {
      row_number: offset + 2,
      timestamp,
      timestamp_ms: timestampMs,
      storage_raw: storageRaw,
      storage_key: storageIdentity.legacy_key,
      storage_number: storageIdentity.number,
      storage_kind: storageIdentity.kind,
      storage_year: storageIdentity.year,
      storage_full_key: storageIdentity.full_key,
      patient_name: patientName,
      patient_name_normalized: normalizeName(patientName),
    };
    const identityKey = storageIdentity.full_key || `number::${storageIdentity.number}`;
    const dedupeKey = `${identityKey}::${record.patient_name_normalized || '__missing_name__'}`;
    const previous = recordsByIdentityAndName.get(dedupeKey);
    if (!previous) {
      recordsByIdentityAndName.set(dedupeKey, record);
      return;
    }
    const previousTime = Number(previous.timestamp_ms ?? -1);
    const currentTime = Number(record.timestamp_ms ?? -1);
    if (currentTime > previousTime || (currentTime === previousTime && Number(record.row_number || 0) >= Number(previous.row_number || 0))) {
      recordsByIdentityAndName.set(dedupeKey, record);
    }
  });

  return [...recordsByIdentityAndName.values()].sort((a, b) => {
    const timeDiff = Number(b.timestamp_ms ?? -1) - Number(a.timestamp_ms ?? -1);
    return timeDiff || Number(b.row_number || 0) - Number(a.row_number || 0);
  });
}

function extractSpreadsheetInfo(spreadsheetUrl, configuredGid = '') {
  const raw = text(spreadsheetUrl);
  const idMatch = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!idMatch) throw new Error('Link Google Sheet không hợp lệ.');

  const configured = text(configuredGid);
  let gidFromUrl = '';
  try {
    const url = new URL(raw);
    gidFromUrl = text(url.searchParams.get('gid'));
    if (!gidFromUrl && url.hash) {
      const hashMatch = url.hash.match(/gid=(\d+)/);
      if (hashMatch) gidFromUrl = hashMatch[1];
    }
  } catch (_) {}

  // Link có gid là lựa chọn cụ thể của người dùng, nên ưu tiên hơn giá trị
  // mặc định "0" trong cấu hình. Điều này tránh đồng bộ nhầm tab đầu tiên khi
  // người dùng dán link của một worksheet khác.
  const gid = gidFromUrl || configured || '0';
  return { spreadsheet_id: idMatch[1], gid: gid || '0' };
}

function buildCsvUrls(spreadsheetUrl, configuredGid = '') {
  const info = extractSpreadsheetInfo(spreadsheetUrl, configuredGid);
  const id = encodeURIComponent(info.spreadsheet_id);
  const gid = encodeURIComponent(info.gid);
  return {
    ...info,
    urls: [
      `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`,
      `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&gid=${gid}`,
    ],
  };
}

function getTextViaHttp(url, { timeoutMs = 20000, redirectCount = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error('Google Sheet chuyển hướng quá nhiều lần.'));
      return;
    }
    const client = String(url).startsWith('http:') ? http : https;
    const request = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 EMR-Dashboard/2.1',
        Accept: 'text/csv,text/plain,*/*',
        'Cache-Control': 'no-cache, no-store, max-age=0',
        Pragma: 'no-cache',
      },
    }, response => {
      const status = Number(response.statusCode || 0);
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        const nextUrl = new URL(location, url).toString();
        getTextViaHttp(nextUrl, { timeoutMs, redirectCount: redirectCount + 1 }).then(resolve, reject);
        return;
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (status < 200 || status >= 300) {
          reject(new Error(`Google Sheet trả về HTTP ${status}.`));
          return;
        }
        resolve({
          body,
          content_type: text(response.headers['content-type']),
          etag: text(response.headers.etag),
          last_modified: text(response.headers['last-modified']),
          cache_control: text(response.headers['cache-control']),
        });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`Quá thời gian tải Google Sheet (${timeoutMs} ms).`)));
    request.on('error', reject);
  });
}

function validateGoogleAppsScriptWebAppUrl(rawUrl) {
  const raw = text(rawUrl);
  if (!raw) throw new Error('Chưa cấu hình URL Google Apps Script để ghi dữ liệu.');
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    throw new Error('URL Google Apps Script không hợp lệ.');
  }
  const host = String(url.hostname || '').toLowerCase();
  const allowedHost = host === 'script.google.com'
    || host === 'script.googleusercontent.com'
    || host.endsWith('.script.googleusercontent.com')
    || host.endsWith('.googleusercontent.com');
  if (url.protocol !== 'https:' || !allowedHost) {
    throw new Error('URL ghi Google Sheet phải là Google Apps Script HTTPS.');
  }
  if (host === 'script.google.com' && !/^\/macros\/s\/[^/]+\/(exec|dev)\/?$/i.test(url.pathname)) {
    throw new Error('URL Google Apps Script phải là đường dẫn Web app /macros/s/.../exec.');
  }
  return url.toString();
}

function requestTextViaHttp(url, {
  method = 'GET',
  headers = {},
  body = null,
  timeoutMs = 20000,
  redirectCount = 0,
} = {}) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 6) {
      reject(new Error('Google Apps Script chuyển hướng quá nhiều lần.'));
      return;
    }
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch (_) {
      reject(new Error('URL Google Apps Script không hợp lệ.'));
      return;
    }
    const client = parsed.protocol === 'http:' ? http : https;
    const payload = body == null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'));
    const requestHeaders = {
      'User-Agent': 'Mozilla/5.0 EMR-Dashboard/2.1',
      Accept: 'application/json,text/plain,*/*',
      'Cache-Control': 'no-cache, no-store, max-age=0',
      Pragma: 'no-cache',
      ...headers,
    };
    if (payload && !Object.keys(requestHeaders).some(key => key.toLowerCase() === 'content-length')) {
      requestHeaders['Content-Length'] = String(payload.length);
    }

    const request = client.request(parsed, { method, headers: requestHeaders }, response => {
      const status = Number(response.statusCode || 0);
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        const nextUrl = new URL(location, parsed).toString();
        const switchToGet = [301, 302, 303].includes(status);
        requestTextViaHttp(nextUrl, {
          method: switchToGet ? 'GET' : method,
          headers: switchToGet ? {} : requestHeaders,
          body: switchToGet ? null : payload,
          timeoutMs,
          redirectCount: redirectCount + 1,
        }).then(resolve, reject);
        return;
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const responseBody = Buffer.concat(chunks).toString('utf8');
        if (status < 200 || status >= 300) {
          reject(new Error(`Google Apps Script trả về HTTP ${status}: ${text(responseBody).slice(0, 240)}`));
          return;
        }
        resolve({
          body: responseBody,
          content_type: text(response.headers['content-type']),
          status,
        });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`Quá thời gian gọi Google Apps Script (${timeoutMs} ms).`)));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function postJsonToGoogleAppsScript(url, payload, { timeoutMs = 20000 } = {}) {
  const safeUrl = validateGoogleAppsScriptWebAppUrl(url);
  const response = await requestTextViaHttp(safeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload || {}),
    timeoutMs,
  });
  let data;
  try {
    data = JSON.parse(String(response.body || '').replace(/^\uFEFF/, ''));
  } catch (_) {
    throw new Error(`Google Apps Script không trả JSON hợp lệ: ${text(response.body).slice(0, 240)}`);
  }
  if (!data || typeof data !== 'object') throw new Error('Google Apps Script không trả kết quả hợp lệ.');
  if (data.ok === false || data.status === 'error') {
    throw new Error(text(data.message || data.error) || 'Google Apps Script từ chối cập nhật.');
  }
  return data;
}

function withCacheBuster(rawUrl, value = Date.now()) {
  const url = new URL(String(rawUrl));
  url.searchParams.set('_emr_refresh', String(value));
  return url.toString();
}

function contentHash(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

async function fetchGoogleSheetRecords({ spreadsheet_url, sheet_gid = '0', timeout_ms = 20000, source_file = '', allow_public = false } = {}) {
  const localFile = text(source_file);
  if (localFile) {
    const csvText = fs.readFileSync(localFile, 'utf8');
    const records = parseGoogleSheetRecords(csvText);
    return {
      spreadsheet_id: '', gid: '', source_url: '', source_type: 'local_csv',
      content_type: 'text/csv', etag: '', last_modified: '', cache_control: '',
      content_hash: contentHash(csvText), downloaded_at: new Date().toISOString(), records,
    };
  }
  if (!allow_public) {
    throw new Error('Đồng bộ Google Sheet công khai đang bị khóa. Hãy dùng file CSV nội bộ hoặc bật EMR_ALLOW_PUBLIC_GOOGLE_SHEET sau khi được phê duyệt.');
  }
  const info = buildCsvUrls(spreadsheet_url, sheet_gid);
  const errors = [];
  const cacheBust = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  for (const baseUrl of info.urls) {
    const url = withCacheBuster(baseUrl, cacheBust);
    try {
      const response = await getTextViaHttp(url, { timeoutMs: Number(timeout_ms) || 20000 });
      const bodyStart = response.body.slice(0, 500).toLowerCase();
      if (bodyStart.includes('<html') || bodyStart.includes('<!doctype html') || bodyStart.includes('accounts.google.com')) {
        throw new Error('Không tải được CSV từ Google Sheet. Không nên chuyển tài liệu bệnh nhân sang chế độ công khai; hãy dùng file CSV nội bộ hoặc cơ chế xác thực riêng.');
      }
      const records = parseGoogleSheetRecords(response.body);
      return {
        spreadsheet_id: info.spreadsheet_id,
        gid: info.gid,
        source_url: url,
        content_type: response.content_type,
        etag: response.etag || '',
        last_modified: response.last_modified || '',
        cache_control: response.cache_control || '',
        content_hash: contentHash(response.body),
        downloaded_at: new Date().toISOString(),
        records,
      };
    } catch (error) {
      errors.push(String(error.message || error));
    }
  }

  throw new Error(errors.filter(Boolean).join(' | ') || 'Không tải được dữ liệu Google Sheet.');
}

module.exports = {
  normalizeHeader,
  normalizeName,
  normalizeStorageIdentity,
  normalizeStorageKey,
  parseCsv,
  parseGoogleSheetRecords,
  extractSpreadsheetInfo,
  buildCsvUrls,
  withCacheBuster,
  contentHash,
  fetchGoogleSheetRecords,
  validateGoogleAppsScriptWebAppUrl,
  postJsonToGoogleAppsScript,
};
