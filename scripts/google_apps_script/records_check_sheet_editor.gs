/**
 * Google Apps Script Web app cho EMR Dashboard - Kiểm hồ sơ.
 *
 * Chỉ cho phép sửa hai cột:
 *   - Số lưu trữ
 *   - Họ và tên
 *
 * Thiết lập Script Property:
 *   EMR_WRITE_TOKEN = chuỗi bí mật giống EMR_GOOGLE_SHEET_WRITE_TOKEN trên server.
 */

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
    const payload = parsePayload_(e);
    verifyToken_(payload.token);
    if (String(payload.action || '') !== 'update_records_check_row') {
      throw new Error('Hành động không được hỗ trợ.');
    }

    const spreadsheetId = clean_(payload.spreadsheet_id);
    const sheetGid = Number(payload.sheet_gid);
    const requestedRow = Number(payload.row_number);
    if (!spreadsheetId) throw new Error('Thiếu spreadsheet_id.');
    if (!Number.isInteger(requestedRow) || requestedRow < 2) throw new Error('Số dòng không hợp lệ.');

    const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    const sheet = spreadsheet.getSheets().find(item => Number(item.getSheetId()) === sheetGid);
    if (!sheet) throw new Error('Không tìm thấy tab Google Sheet theo gid đã cấu hình.');

    const lastColumn = sheet.getLastColumn();
    const lastRow = sheet.getLastRow();
    if (lastColumn < 1 || lastRow < 2) throw new Error('Google Sheet chưa có dữ liệu.');

    const headers = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
    const timestampColumn = findHeaderColumn_(headers, ['Dấu thời gian', 'Thời gian', 'Timestamp']);
    const storageColumn = findHeaderColumn_(headers, ['Số lưu trữ', 'Số lưu trữ hồ sơ', 'Số hồ sơ', 'So luu tru']);
    const nameColumn = findHeaderColumn_(headers, ['Họ và tên', 'Họ tên', 'Tên người bệnh', 'Ho va ten']);
    if (!storageColumn) throw new Error('Google Sheet thiếu cột “Số lưu trữ”.');
    if (!nameColumn) throw new Error('Google Sheet thiếu cột “Họ và tên”.');

    const expected = payload.expected && typeof payload.expected === 'object' ? payload.expected : {};
    let resolvedRow = requestedRow;
    if (!rowMatchesExpected_(sheet, resolvedRow, { timestampColumn, storageColumn, nameColumn }, expected)) {
      const matches = [];
      for (let row = 2; row <= lastRow; row += 1) {
        if (rowMatchesExpected_(sheet, row, { timestampColumn, storageColumn, nameColumn }, expected)) matches.push(row);
      }
      if (matches.length === 1) resolvedRow = matches[0];
      else if (matches.length > 1) throw new Error('Có nhiều dòng cùng khớp dữ liệu cũ; không tự sửa để tránh nhầm.');
      else throw new Error('Dòng Google Sheet đã thay đổi sau lần đồng bộ. Hãy đồng bộ lại rồi sửa tiếp.');
    }

    const updates = payload.updates && typeof payload.updates === 'object' ? payload.updates : {};
    const changedFields = [];
    if (Object.prototype.hasOwnProperty.call(updates, 'storage_raw')) {
      sheet.getRange(resolvedRow, storageColumn).setValue(clean_(updates.storage_raw));
      changedFields.push('storage_raw');
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'patient_name')) {
      sheet.getRange(resolvedRow, nameColumn).setValue(clean_(updates.patient_name));
      changedFields.push('patient_name');
    }
    if (!changedFields.length) throw new Error('Không có trường nào cần cập nhật.');
    SpreadsheetApp.flush();

    return json_({
      ok: true,
      status: 'ok',
      message: 'Đã cập nhật dòng ' + resolvedRow + ' trên Google Sheet.',
      row_number: resolvedRow,
      changed_fields: changedFields,
      storage_raw: sheet.getRange(resolvedRow, storageColumn).getDisplayValue(),
      patient_name: sheet.getRange(resolvedRow, nameColumn).getDisplayValue(),
    });
  } catch (error) {
    return json_({ ok: false, status: 'error', message: String(error && error.message ? error.message : error) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function parsePayload_(e) {
  const raw = e && e.postData ? String(e.postData.contents || '') : '';
  if (!raw) throw new Error('Yêu cầu không có dữ liệu JSON.');
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    throw new Error('JSON gửi lên không hợp lệ.');
  }
}

function verifyToken_(providedToken) {
  const configured = String(PropertiesService.getScriptProperties().getProperty('EMR_WRITE_TOKEN') || '');
  if (!configured) throw new Error('Apps Script chưa có Script Property EMR_WRITE_TOKEN.');
  if (String(providedToken || '') !== configured) throw new Error('Token ghi Google Sheet không đúng.');
}

function rowMatchesExpected_(sheet, rowNumber, columns, expected) {
  if (!Number.isInteger(rowNumber) || rowNumber < 2 || rowNumber > sheet.getLastRow()) return false;
  const checks = [];
  const expectedTimestamp = clean_(expected.timestamp);
  const expectedStorage = clean_(expected.storage_raw);
  const expectedName = clean_(expected.patient_name);
  if (expectedTimestamp && columns.timestampColumn) {
    checks.push(clean_(sheet.getRange(rowNumber, columns.timestampColumn).getDisplayValue()) === expectedTimestamp);
  }
  if (Object.prototype.hasOwnProperty.call(expected, 'storage_raw')) {
    checks.push(clean_(sheet.getRange(rowNumber, columns.storageColumn).getDisplayValue()) === expectedStorage);
  }
  if (Object.prototype.hasOwnProperty.call(expected, 'patient_name')) {
    checks.push(clean_(sheet.getRange(rowNumber, columns.nameColumn).getDisplayValue()) === expectedName);
  }
  return checks.length > 0 && checks.every(Boolean);
}

function findHeaderColumn_(headers, candidates) {
  const normalizedCandidates = candidates.map(normalizeHeader_);
  for (let index = 0; index < headers.length; index += 1) {
    if (normalizedCandidates.indexOf(normalizeHeader_(headers[index])) >= 0) return index + 1;
  }
  return 0;
}

function normalizeHeader_(value) {
  return clean_(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clean_(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function json_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
