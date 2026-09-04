import React, { useEffect, useMemo, useState } from 'react';
import { C } from '../../tokens.js';
import { Btn, Spinner } from '../shared.jsx';
import RecordsSubmissionTab from './RecordsSubmissionTab.jsx';
import { PAPER_ISSUE_STATES, applyGoogleSheetValidation, buildGoogleSheetIndex, buildUnlinkedSheetIssues, paperFilterMatches } from './googleSheetValidation.mjs';
import { exportRecordsCheckPdf, getRecordsCheckDashboard, getRecordsCheckGoogleSheet, getRecordsCheckSubmissions, scanRecordsCheckCompleted, setRecordsCheckChecked, startRecordsCheckFetchBatch, stopRecordsCheckFetchBatch, syncRecordsCheckGoogleSheet, updateRecordsCheckGoogleSheetRow } from '../../api.js';

const CHECK_FILES = ['discharge', 'cls'];
const COMPLETED_STATUS = 'Hoàn tất';
const CHECKED_STORAGE_KEY = 'emr.recordsCheck.checked.v1';
const HEADLESS_STORAGE_KEY = 'emr.recordsCheck.headless.v1';
const BATCH_LIMIT_STORAGE_KEY = 'emr.recordsCheck.batchLimit.v1';
const DISCHARGE_MONTH_STORAGE_KEY = 'emr.recordsCheck.dischargeMonth.v1';

function txt(value, fallback = '—') {
  if (Array.isArray(value)) {
    const parts = value.map(x => txt(x, '')).filter(Boolean);
    return parts.length ? parts.join(' · ') : fallback;
  }
  if (value && typeof value === 'object') {
    const parts = Object.values(value).map(x => txt(x, '')).filter(Boolean);
    return parts.length ? parts.join(' · ') : fallback;
  }
  return String(value ?? '').replace(/\s+/g, ' ').trim() || fallback;
}

function norm(value) {
  return String(value ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

function getMaBn(card) {
  return String(card?.ma_bn || card?.patient_id || card?.patientId || '').trim();
}

function getCardCaseKey(card) {
  return String(card?.case_key || card?.encounter_key || '').trim();
}


function getNativeCaseKey(card) {
  return String(card?.case_key || card?.encounter_key || '').trim();
}

function displayNameOf(card) {
  const raw = txt(card?._display_name || card?.ho_ten || card?.name || '', '');
  return raw
    .replace(/\s*-\s*PM\s*:\s*PHÒNG\s+PHẪU\s+THUẬT\s*$/i, '')
    .replace(/\s*-\s*PHÒNG\s+PHẪU\s+THUẬT\s*$/i, '')
    .trim() || raw || 'Không rõ tên';
}

function departmentOf(card) {
  return dateText(
    card?.department,
    card?.source_row?.ten_khoa_dieu_tri,
    card?.source_row?.department_name,
    card?.source_row?.khoa_dieu_tri,
    card?.source_row?.department,
    card?.source_row?.['Tên khoa điều trị'],
    card?.source_row?.['Khoa điều trị'],
    card?.source_row?.['Khoa chuyển đến'],
  );
}

function dateText(...values) {
  for (const value of values) {
    const s = txt(value, '');
    if (s) return s;
  }
  return '';
}

function clsResultText(row) {
  return [
    row?.name,
    row?.ten_dv,
    row?.ten_dich_vu,
    row?.['Tên dịch vụ'],
    row?.['Ten dich vu'],
    row?.loai,
    row?.nhom_dich_vu,
    row?.group,
    row?.['Nhóm dịch vụ'],
    row?.phong,
    row?.ket_qua,
    row?.['Mô tả/Kết quả'],
    row?.['Kết luận'],
  ].map(x => txt(x, '')).filter(Boolean).join(' | ');
}

function clsResultName(row) {
  return dateText(
    row?.name,
    row?.ten_dv,
    row?.ten_dich_vu,
    row?.['Tên dịch vụ'],
    row?.['Ten dich vu'],
    row?.dich_vu,
    row?.['Dịch vụ']
  );
}

function detectModalities(value) {
  const s = norm(value);
  const out = new Set();

  if (/(^|[^a-z0-9])(x\s*-?\s*quang|xray|x\s*ray|xq)([^a-z0-9]|$)/i.test(s) || s.includes('chup phim')) out.add('xq');
  if (/(^|[^a-z0-9])(ct|msct)([^a-z0-9]|$)/i.test(s) || /cat\s+lop|scanner/.test(s)) out.add('ct');
  if (/(^|[^a-z0-9])mri([^a-z0-9]|$)/i.test(s) || /cong\s+huong\s+tu/.test(s)) out.add('mri');

  return [...out];
}

function imagingClsStats(clsData) {
  const rows = Array.isArray(clsData?.results)
    ? clsData.results
    : (Array.isArray(clsData?.rows) ? clsData.rows : []);
  const sets = { xq: new Set(), ct: new Set(), mri: new Set() };
  const examples = [];

  rows.forEach((row, index) => {
    const rawText = clsResultText(row);
    const modalities = detectModalities(rawText);
    if (!modalities.length) return;

    const key = txt(row?.so_phieu || row?.ma_phieu || row?.ticket || row?.onclick, '')
      || [txt(row?.tg_chi_dinh || row?.ngay || row?.time, ''), clsResultName(row), index].filter(Boolean).join('::')
      || `cls_${index}`;
    modalities.forEach(modality => sets[modality].add(`${modality}::${key}`));
    if (examples.length < 10) {
      examples.push({
        time: txt(row?.tg_chi_dinh || row?.ngay_chi_dinh || row?.ngay || row?.time, ''),
        ticket: txt(row?.so_phieu || row?.ma_phieu || row?.ticket, ''),
        modalities,
        text: txt(rawText, '').slice(0, 260),
      });
    }
  });

  // Worker Python đã phân loại trực tiếp từng dòng CĐHA. Ưu tiên số đếm này để
  // giao diện, CSV và PDF dùng cùng một nguồn; chỉ tự nhận diện text với dữ liệu cũ.
  const workerCounts = clsData?.counts;
  const hasWorkerCounts = workerCounts && typeof workerCounts === 'object'
    && ['xq', 'ct', 'mri'].some(key => Object.prototype.hasOwnProperty.call(workerCounts, key));
  if (hasWorkerCounts) {
    const safeCount = value => {
      const n = Number(value);
      return Number.isFinite(n) ? Math.max(0, n) : 0;
    };
    const xq = safeCount(workerCounts.xq);
    const ct = safeCount(workerCounts.ct);
    const mri = safeCount(workerCounts.mri);
    return { xq, ct, mri, total: xq + ct + mri, examples, source: 'worker' };
  }

  return { xq: sets.xq.size, ct: sets.ct.size, mri: sets.mri.size, total: sets.xq.size + sets.ct.size + sets.mri.size, examples, source: 'fallback' };
}

function fileStatus(card, fileKey) {
  const st = card?.file_statuses?.[fileKey];
  if (st && typeof st === 'object') return st;
  if (card?.[fileKey]) return { tone: 'green', label: 'Đã có' };
  if ((card?.missing_files || []).includes(fileKey)) return { tone: 'amber', label: 'Thiếu' };
  return { tone: 'gray', label: 'Chưa lấy' };
}

const TECHNICAL_FETCH_STATUSES = new Set(['error', 'no_session', 'no_url', 'timeout', 'cdha_timeout', 'missing_output', 'spawn_error', 'no_results_popup', 'no_cdha_tab', 'pending']);

function rawFetchStatus(payload) {
  return String(payload?._fetch_status || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isSuccessfulFilePayload(card, fileKey) {
  const payload = card?.[fileKey];
  if (!payload) return false;

  const state = String(card?.file_statuses?.[fileKey]?.state || '').trim().toLowerCase();
  if (['fetch_error', 'not_started', 'partial'].includes(state)) return false;
  if (state === 'empty') return fileKey === 'cls';

  const status = rawFetchStatus(payload);
  if (TECHNICAL_FETCH_STATUSES.has(status) || status === 'partial') return false;
  if (status === 'empty') return fileKey === 'cls';
  return true;
}

function chipStyle(tone) {
  if (tone === 'green') return { color: C.green, background: C.greenBg, borderColor: C.greenBorder };
  if (tone === 'red') return { color: C.red, background: C.redBg, borderColor: C.redBorder };
  if (tone === 'amber') return { color: C.amber, background: C.amberBg, borderColor: C.amberBorder };
  if (tone === 'blue') return { color: C.blue, background: C.blueBg, borderColor: C.blueBorder };
  return { color: C.text2, background: C.surface2, borderColor: C.border };
}

function Chip({ tone = 'gray', children, title }) {
  const s = chipStyle(tone);
  return (
    <span title={title} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 7px', borderRadius: 999, fontSize: 10, fontWeight: 700, color: s.color, background: s.background, border: `1px solid ${s.borderColor}`, whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}

function StatBox({ label, value, tone = 'gray' }) {
  const s = chipStyle(tone);
  return (
    <div style={{ minWidth: 92, padding: '9px 11px', borderRadius: 6, background: s.background, border: `1px solid ${s.borderColor}` }}>
      <div style={{ fontSize: 21, lineHeight: 1, fontWeight: 850, color: s.color }}>{value}</div>
      <div style={{ fontSize: 10, color: C.text2, marginTop: 4 }}>{label}</div>
    </div>
  );
}

function sheetRecordUiKey(record) {
  return [record?.row_number, record?.timestamp, record?.storage_raw, record?.patient_name].map(value => String(value || '').trim()).join('::');
}

function uniqueSheetRecords(records) {
  const out = [];
  const seen = new Set();
  (Array.isArray(records) ? records : []).filter(Boolean).forEach(record => {
    const key = sheetRecordUiKey(record);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(record);
  });
  return out.sort((a, b) => Number(a?.row_number || 0) - Number(b?.row_number || 0));
}

function editableSheetRecordsForRow(row) {
  return uniqueSheetRecords([
    ...(row?.paperRecord?.related_records || []),
    ...(row?.paperRecord?.candidates || []),
    row?.paperRecord?.record,
    ...(row?.paperRecord?.informational_records || []),
  ]);
}

function googleSheetRowUrl(spreadsheetUrl, gid, rowNumber) {
  const raw = String(spreadsheetUrl || '').trim();
  const row = Number(rowNumber || 0);
  if (!raw || !row) return '';
  try {
    const url = new URL(raw);
    const safeGid = String(gid || url.searchParams.get('gid') || '0').trim() || '0';
    url.searchParams.set('gid', safeGid);
    url.hash = `gid=${encodeURIComponent(safeGid)}&range=A${row}`;
    return url.toString();
  } catch (_) {
    return raw;
  }
}

function admissionDateOf(card) {
  return dateText(
    card?.profile?.ngay_vao_vien,
    card?.profile?.ngay_vao,
    card?.profile?.raw_admission_time,
    card?.discharge?.ngay_vao,
    card?.admission_time
  );
}

function rawDischargeDateOf(card) {
  return dateText(
    card?.profile?.ngay_ra_vien,
    card?.profile?.ngay_ra,
    card?.discharge?.raw_time,
    [card?.discharge?.gio_ra, card?.discharge?.ngay_ra].filter(Boolean).join(' '),
    card?.discharge?.ngay_ra,
    card?.discharge_time,
    card?.order_history?._discharge_date
  );
}

function dateSortValue(value) {
  const text = txt(value, '');
  if (!text) return null;
  let m = text.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/);
  if (m) {
    const time = text.match(/(\d{1,2})[:h](\d{1,2})/);
    const hh = time?.[1] ? Number(time[1]) : 0;
    const mm = time?.[2] ? Number(time[2]) : 0;
    return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), hh, mm).getTime();
  }
  m = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2}))?/);
  if (m) {
    const hh = m[4] ? Number(m[4]) : 0;
    const mm = m[5] ? Number(m[5]) : 0;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hh, mm).getTime();
  }
  return null;
}

function dischargeMonthKey(value) {
  const ms = dateSortValue(value);
  if (ms == null) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function dischargeMonthLabel(value) {
  const key = String(value || '').trim();
  const match = key.match(/^(\d{4})-(\d{2})$/);
  return match ? `${match[2]}/${match[1]}` : key;
}

function dischargeBeforeAdmission(admission, discharge) {
  const adm = dateSortValue(admission);
  const dis = dateSortValue(discharge);
  return adm != null && dis != null && dis < adm;
}

function hasBadDischargeDate(card) {
  return dischargeBeforeAdmission(admissionDateOf(card), rawDischargeDateOf(card));
}

function dischargeDateOf(card) {
  const raw = rawDischargeDateOf(card);
  if (!raw) return '';
  // Không hiển thị ngày ra viện nếu mốc ra nhỏ hơn ngày vào của dòng/lượt đó.
  // Trường hợp này thường là dữ liệu discharge cũ bị gắn nhầm sang lần nhập khoa mới.
  if (hasBadDischargeDate(card)) return '';
  return raw;
}

function isLikelyStorageNo(value) {
  const s = txt(value, '');
  return Boolean(s && /\d/.test(s));
}

function storageOf(card) {
  const candidates = [
    card?.discharge?.so_luu_tru,
    card?.so_luu_tru,
    card?.storage_no,
    card?.storage,
    card?.profile?.so_luu_tru,
    card?.source_row?.so_luu_tru,
    card?.source_row?.SoLuuTru,
    card?.source_row?.['Số lưu trữ'],
    card?.source_row?.['So luu tru'],
  ];
  for (const value of candidates) {
    const s = txt(value, '');
    if (isLikelyStorageNo(s)) return s;
  }
  return '';
}

function storageForPrint(value) {
  const raw = txt(value, '');
  if (!raw) return '';
  const parts = raw.split('/').map(part => part.trim()).filter(Boolean);
  if (parts.length >= 2 && /^\d+$/.test(parts[1])) {
    const n = String(Number(parts[1]));
    return n === 'NaN' ? parts[1].replace(/^0+/, '') || '0' : n;
  }
  const longestNumber = raw.match(/\d{4,}/g)?.sort((a, b) => b.length - a.length)[0] || '';
  return longestNumber ? (longestNumber.replace(/^0+/, '') || '0') : raw;
}

function completedStatusText(card) {
  return dateText(
    card?.inpatient_status,
    card?.profile?.inpatient_status,
    card?.discharge?.matched_inpatient_status,
    card?.order_history?.matched_inpatient_status,
    card?.cls?.matched_inpatient_status,
    card?.discharge?.requested_inpatient_status,
    card?.order_history?.requested_inpatient_status,
    card?.cls?.requested_inpatient_status,
    card?.scope_label,
    card?.scope,
    card?.workflow_tags
  );
}

function isCompletedCase(card) {
  const hay = norm([
    completedStatusText(card),
    card?.discharge?.xu_tri,
    card?.discharge?.tinh_trang_ra,
    card?.discharge?.so_luu_tru,
    dischargeDateOf(card),
  ].filter(Boolean).join(' '));
  return /hoan tat|tat toan|ra vien|xuat vien|chuyen vien|chuyen khoa|tu vong|discharge/.test(hay) || card?.scope === 'discharge';
}

function orderStatusLabel(card, storage = '', dischargeDate = '') {
  // Chỉ giữ 4 trạng thái chính cho bảng kiểm hồ sơ:
  // Đủ dữ liệu / Thiếu dữ liệu / Đang quét / Chưa ra viện.
  const dischargeOk = isSuccessfulFilePayload(card, 'discharge');
  const clsOk = isSuccessfulFilePayload(card, 'cls');
  const dischargeStatus = rawFetchStatus(card?.discharge);
  const hasFetchError = Boolean(card?.fetch_error_active || card?.fetch_error);
  if (!dischargeDate) {
    // _fetch_status=empty nghĩa là đã mở được màn Ra khoa nhưng chưa có nội dung
    // ra viện. Các trạng thái không mở được màn hình vẫn là Thiếu dữ liệu.
    const confirmedNotDischarged = Boolean(card?.not_discharged || dischargeStatus === 'empty');
    return confirmedNotDischarged && !hasFetchError ? { tone: 'gray', label: 'Chưa ra viện' } : { tone: 'amber', label: 'Thiếu dữ liệu' };
  }
  if (dischargeOk && clsOk && storage && !hasBadDischargeDate(card) && !hasFetchError) return { tone: 'green', label: 'Đủ dữ liệu' };
  return { tone: 'amber', label: 'Thiếu dữ liệu' };
}

function isRowDataComplete(row) {
  return Boolean(
    row?.dischargeDate
    && row?.storage
    && !hasBadDischargeDate(row?.card)
    && !row?.card?.fetch_error_active
    && !row?.card?.fetch_error
    && isSuccessfulFilePayload(row?.card, 'discharge')
    && isSuccessfulFilePayload(row?.card, 'cls')
  );
}

function isRowFetchableMissing(row) {
  return String(row?.status?.label || '') === 'Thiếu dữ liệu';
}

function sortableDateNumber(value) {
  const ms = dateSortValue(value);
  if (ms == null) return Number.NEGATIVE_INFINITY;
  const d = new Date(ms);
  return Number(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`);
}
function sortableDateDescValue(value) {
  const n = sortableDateNumber(value);
  return Number.isFinite(n) ? n : Number.NEGATIVE_INFINITY;
}

function compareRowsByAdmissionNewest(a, b) {
  const admissionDiff = sortableDateDescValue(b?.admissionDate) - sortableDateDescValue(a?.admissionDate);
  if (admissionDiff) return admissionDiff;
  const dischargeDiff = sortableDateDescValue(b?.dischargeDate) - sortableDateDescValue(a?.dischargeDate);
  if (dischargeDiff) return dischargeDiff;
  return String(a?.displayName || '').localeCompare(String(b?.displayName || ''), 'vi')
    || String(a?.ma_bn || '').localeCompare(String(b?.ma_bn || ''), 'vi')
    || String(a?.storage || '').localeCompare(String(b?.storage || ''), 'vi');
}

function sortRowsByAdmissionNewest(rows) {
  return [...(Array.isArray(rows) ? rows : [])].sort(compareRowsByAdmissionNewest);
}

function rotateRowsFromCursor(rows, cursorKey) {
  const sorted = sortRowsByAdmissionNewest(rows);
  const cursor = String(cursorKey || '').trim();
  if (!cursor) return sorted;
  const idx = sorted.findIndex(row => rowContainsCaseKey(row, cursor));
  if (idx <= 0) return sorted;
  return [...sorted.slice(idx), ...sorted.slice(0, idx)];
}

function compareRowsForFetchPriority(a, b) {
  const aAttempts = Math.max(0, Number(a?.card?.fetch_attempt_count || 0));
  const bAttempts = Math.max(0, Number(b?.card?.fetch_attempt_count || 0));
  if (Boolean(aAttempts) !== Boolean(bAttempts)) return aAttempts ? 1 : -1;

  const now = Date.now();
  const retryTime = row => {
    const parsed = Date.parse(String(row?.card?.next_retry_at || ''));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const aRetry = retryTime(a);
  const bRetry = retryTime(b);
  const aCooling = aRetry > now;
  const bCooling = bRetry > now;
  if (aCooling !== bCooling) return aCooling ? 1 : -1;

  const aFailures = Math.max(0, Number(a?.card?.fetch_failure_count || 0));
  const bFailures = Math.max(0, Number(b?.card?.fetch_failure_count || 0));
  if (aFailures !== bFailures) return aFailures - bFailures;

  const aLast = Date.parse(String(a?.card?.last_fetch_attempt_at || '')) || 0;
  const bLast = Date.parse(String(b?.card?.last_fetch_attempt_at || '')) || 0;
  if (aLast !== bLast) return aLast - bLast;
  return compareRowsByAdmissionNewest(a, b);
}

function dataFilterMatches(row, filterValue) {
  const value = String(filterValue || 'all');
  if (value === 'all') return true;
  if (value === 'complete') return isRowDataComplete(row);
  if (value === 'missing') return !isRowDataComplete(row);
  if (value.startsWith('status::')) return String(row?.status?.label || '') === value.slice('status::'.length);
  return true;
}

function statusFilterValue(label) {
  return `status::${String(label || '')}`;
}


function buildRows(cards) {
  return cards.map(card => {
    const stats = imagingClsStats(card?.cls);
    const storage = storageOf(card);
    const admissionDate = admissionDateOf(card);
    const dischargeDate = dischargeDateOf(card);
    const status = orderStatusLabel(card, storage, dischargeDate);
    const completed = isCompletedCase(card);
    return { card, stats, storage, status, ma_bn: getMaBn(card), admissionDate, dischargeDate, completed, displayName: displayNameOf(card), department: departmentOf(card) };
  });
}

function getRowKey(row) {
  const card = row?.card || {};
  const mergedKey = txt(card?.merged_key, '');
  if (mergedKey) return mergedKey;
  const caseKey = getCardCaseKey(card);
  if (caseKey) return caseKey;
  return [row?.ma_bn, row?.admissionDate, row?.dischargeDate, row?.storage]
    .map(v => txt(v, ''))
    .filter(Boolean)
    .join('::') || row?.ma_bn || '';
}

function rowContainsCaseKey(row, key) {
  const wanted = String(key || '').trim();
  if (!wanted) return false;
  return getRowKey(row) === wanted
    || getNativeCaseKey(row?.card) === wanted
    || rowSourceCaseKeys(row).includes(wanted);
}

function rowSourceCaseKeys(row) {
  const card = row?.card || {};
  const keys = [
    ...(Array.isArray(card?.source_case_keys) ? card.source_case_keys : []),
    getNativeCaseKey(card),
    getCardCaseKey(card),
  ].map(value => txt(value, '')).filter(Boolean);
  return [...new Set(keys)];
}

function rowCheckedKeys(row) {
  return rowSourceCaseKeys(row);
}

function isRowChecked(row, checkedMap) {
  const keys = [getRowKey(row), ...rowSourceCaseKeys(row)].filter(Boolean);
  return Boolean(row?.card?.checked || keys.some(key => checkedMap?.[key]));
}

function submissionRecordId(row) {
  return getRowKey(row);
}

function submissionAliases(row) {
  return [...new Set([getRowKey(row), ...rowSourceCaseKeys(row)].filter(Boolean))];
}

function buildSubmittedLockMap(submissionDashboard) {
  const dashboard = submissionDashboard?.dashboard || submissionDashboard || {};
  const locks = {};
  for (const batch of Array.isArray(dashboard?.batches) ? dashboard.batches : []) {
    const batchSubmitted = Boolean(batch?.locked || batch?.batch_status === 'submitted' || batch?.status === 'submitted');
    if (!batchSubmitted) continue;
    for (const item of Array.isArray(batch?.items) ? batch.items : []) {
      const effectiveStatus = String(item?.effective_status || '').trim().toLowerCase();
      const itemStatus = String(item?.status || '').trim().toLowerCase();
      if (effectiveStatus && effectiveStatus !== 'submitted') continue;
      if (!effectiveStatus && itemStatus !== 'active' && itemStatus !== 'submitted') continue;
      const aliases = [...new Set([
        item?.record_id,
        ...(Array.isArray(item?.aliases) ? item.aliases : []),
      ].map(value => String(value || '').trim()).filter(Boolean))];
      const lock = {
        submission_date: String(batch?.submission_date || batch?.id || '').trim(),
        submitted_at: String(batch?.submitted_at || '').trim(),
      };
      aliases.forEach(alias => { locks[alias] = lock; });
    }
  }
  return locks;
}

function submittedLockForRow(row, lockMap) {
  for (const alias of submissionAliases(row)) {
    if (lockMap?.[alias]) return lockMap[alias];
  }
  return null;
}

function formatSubmissionDate(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(value || '').trim();
}

function applyJobStatus(rows, job) {
  if (!job?.running || !job?.current_key) return rows;
  return rows.map(row => rowContainsCaseKey(row, job.current_key)
    ? { ...row, status: { tone: 'blue', label: 'Đang quét' }, _is_job_current: true }
    : row);
}

function readCheckedMap() {
  try {
    const raw = localStorage.getItem(CHECKED_STORAGE_KEY);
    const data = raw ? JSON.parse(raw) : {};
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function writeCheckedMap(next) {
  try { localStorage.setItem(CHECKED_STORAGE_KEY, JSON.stringify(next || {})); } catch (_) {}
}

function readHeadlessPref() {
  try {
    const raw = localStorage.getItem(HEADLESS_STORAGE_KEY);
    return raw == null ? true : raw === 'true';
  } catch {
    return true;
  }
}

function writeHeadlessPref(next) {
  try { localStorage.setItem(HEADLESS_STORAGE_KEY, next ? 'true' : 'false'); } catch (_) {}
}
function readBatchLimitPref() {
  try {
    const raw = localStorage.getItem(BATCH_LIMIT_STORAGE_KEY);
    if (raw == null || raw === '') return 50;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 50;
  } catch {
    return 50;
  }
}

function writeBatchLimitPref(next) {
  try { localStorage.setItem(BATCH_LIMIT_STORAGE_KEY, String(next || 0)); } catch (_) {}
}

function readDischargeMonthPref() {
  try {
    const raw = String(localStorage.getItem(DISCHARGE_MONTH_STORAGE_KEY) || '').trim();
    return /^\d{4}-\d{2}$/.test(raw) ? raw : '';
  } catch {
    return '';
  }
}

function writeDischargeMonthPref(next) {
  try {
    const value = String(next || '').trim();
    if (value) localStorage.setItem(DISCHARGE_MONTH_STORAGE_KEY, value);
    else localStorage.removeItem(DISCHARGE_MONTH_STORAGE_KEY);
  } catch (_) {}
}


function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function downloadBlob(text, filename, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportCsv(rows, checkedMap) {
  const headers = ['Đã kiểm', 'Đối chiếu Google Sheet', 'Dấu thời gian Google Sheet', 'Tên trên Google Sheet', 'Số lưu trữ trên Google Sheet', 'Nhận định đối chiếu', 'Số lưu trữ EMR', 'Họ và tên EMR', 'Mã BN', 'Ngày vào viện', 'Ngày ra viện', 'Số XQ', 'Số CT', 'Số MRI', 'Tổng XQ+CT+MRI'];
  const esc = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const lines = [headers.map(esc).join(',')];
  rows.forEach(row => {
    lines.push([
      isRowChecked(row, checkedMap) ? 'Đã kiểm' : '',
      row.paperRecord?.label || '',
      row.paperRecord?.record?.timestamp || '',
      row.paperRecord?.record?.patient_name || '',
      row.paperRecord?.record?.storage_raw || '',
      row.paperRecord?.issue_detail || '',
      row.storage,
      row.displayName || '',
      row.ma_bn,
      row.admissionDate,
      row.dischargeDate,
      row.stats.xq,
      row.stats.ct,
      row.stats.mri,
      row.stats.total,
    ].map(esc).join(','));
  });
  downloadBlob('\ufeff' + lines.join('\n'), `kiem_ho_so_${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv;charset=utf-8');
}


function storageKind(value) {
  const raw = txt(value, '');
  const up = raw.toUpperCase();
  if (/(^|\/)BT(\/|$)/.test(up) || /BÌNH\s*THƯỜNG/i.test(raw)) return 'BT';
  if (/(^|\/)TN(\/|$)/.test(up) || /TAI\s*NẠN/i.test(raw)) return 'TN';
  return 'KHAC';
}

export default function RecordsCheckTab({ toast, workDateRange }) {
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(false);
  const [fetchingKey, setFetchingKey] = useState('');
  const [batch, setBatch] = useState({ running: false, done: 0, total: 0 });
  const [search, setSearch] = useState('');
  const [showOnlyCompleted, setShowOnlyCompleted] = useState(true);
  const [showOnlyStorage, setShowOnlyStorage] = useState(false);
  const [dataFilter, setDataFilter] = useState('all');
  const [paperFilter, setPaperFilter] = useState('all');
  const [dischargeMonth, setDischargeMonth] = useState(() => readDischargeMonthPref());
  const [googleSheet, setGoogleSheet] = useState({ loading: false, enabled: true, records: [], count: 0, fetched_at: '', stale: true, warning: '', message: '', spreadsheet_url: '' });
  const [sheetEditor, setSheetEditor] = useState(null);
  const [sheetEditorSaving, setSheetEditorSaving] = useState(false);
  const [headless, setHeadless] = useState(() => readHeadlessPref());
  const [batchLimit, setBatchLimit] = useState(() => readBatchLimitPref());
  const [checkedMap, setCheckedMap] = useState(() => readCheckedMap());
  const [savingCheckedKeys, setSavingCheckedKeys] = useState(() => new Set());
  const [updateSelectedKeys, setUpdateSelectedKeys] = useState(() => new Set());
  const [lastRefreshAt, setLastRefreshAt] = useState('');
  const [viewMode, setViewMode] = useState('check');
  const [submittedLockMap, setSubmittedLockMap] = useState({});

  async function setChecked(row, checked) {
    const key = getRowKey(row);
    if (!key) return;
    const submissionLock = submittedLockForRow(row, submittedLockMap);
    if (submissionLock) {
      const dateLabel = formatSubmissionDate(submissionLock.submission_date);
      toast?.(`Hồ sơ đã nộp${dateLabel ? ` ngày ${dateLabel}` : ''}; dấu “Đã kiểm” đã được khóa để tránh thao tác nhầm.`, 'warn');
      return;
    }
    setSavingCheckedKeys(prev => new Set(prev).add(key));
    try {
      await setRecordsCheckChecked(rowCheckedKeys(row), checked);
      setCheckedMap(prev => {
        const next = { ...(prev || {}) };
        if (checked) next[key] = true;
        else delete next[key];
        writeCheckedMap(next);
        return next;
      });
      await refreshDashboard({ silent: true });
    } catch (err) {
      toast?.(`Không lưu được dấu đã kiểm: ${String(err.message || err)}`, 'error');
    } finally {
      setSavingCheckedKeys(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  function setHeadlessPref(next) {
    const value = Boolean(next);
    setHeadless(value);
    writeHeadlessPref(value);
  }

  function setBatchLimitPref(next) {
    const value = Number(next || 0);
    setBatchLimit(value);
    writeBatchLimitPref(value);
  }

  function setDischargeMonthPref(next) {
    const value = String(next || '').trim();
    setDischargeMonth(value);
    writeDischargeMonthPref(value);
  }

  function applyGoogleSheetData(data) {
    const records = Array.isArray(data?.records) ? data.records : [];
    setGoogleSheet(prev => ({
      ...prev,
      ...data,
      loading: false,
      records,
      count: Number(data?.count ?? records.length),
      warning: String(data?.warning || ''),
      message: String(data?.message || ''),
    }));
  }

  async function syncGoogleSheet({ silent = false } = {}) {
    setGoogleSheet(prev => ({ ...prev, loading: true }));
    try {
      // Đồng bộ thủ công phải lấy dữ liệu mới thật sự. Nếu Google Sheet lỗi,
      // không âm thầm trả cache cũ vì người dùng sẽ tưởng nút đồng bộ không chạy.
      const data = await syncRecordsCheckGoogleSheet({ allow_stale_fallback: false });
      applyGoogleSheetData(data);
      if (!silent) toast?.(data?.message || `Đã đồng bộ ${Number(data?.count || 0)} hồ sơ từ Google Sheet.`, data?.stale ? 'warn' : 'ok');
      return data;
    } catch (err) {
      const message = String(err.message || err);
      setGoogleSheet(prev => ({ ...prev, loading: false, warning: message }));
      if (!silent) toast?.(`Không đồng bộ được Google Sheet: ${message}`, 'error');
      return null;
    }
  }

  function openSheetEditor({ records = [], emrRow = null, note = '' } = {}) {
    const candidates = uniqueSheetRecords(records);
    if (!candidates.length) {
      toast?.('Không có dòng Google Sheet cụ thể để sửa.', 'warn');
      return;
    }
    const record = candidates[0];
    setSheetEditor({
      records: candidates,
      selected_key: sheetRecordUiKey(record),
      record,
      storage_raw: String(record?.storage_raw || ''),
      patient_name: String(record?.patient_name || ''),
      emrRow,
      note: String(note || ''),
    });
  }

  function selectSheetEditorRecord(key) {
    setSheetEditor(prev => {
      if (!prev) return prev;
      const record = (prev.records || []).find(item => sheetRecordUiKey(item) === key) || prev.records?.[0];
      if (!record) return prev;
      return {
        ...prev,
        selected_key: sheetRecordUiKey(record),
        record,
        storage_raw: String(record.storage_raw || ''),
        patient_name: String(record.patient_name || ''),
      };
    });
  }

  function patchSheetEditor(patch) {
    setSheetEditor(prev => prev ? { ...prev, ...patch } : prev);
  }

  async function saveSheetEditor() {
    if (!sheetEditor?.record) return;
    if (!googleSheet?.write_enabled) {
      toast?.('Google Sheet đang ở chế độ chỉ đọc. Cần cấu hình Google Apps Script để sửa trực tiếp.', 'error');
      return;
    }
    const rowNumber = Number(sheetEditor.record.row_number || 0);
    if (!rowNumber) {
      toast?.('Không xác định được số dòng Google Sheet.', 'error');
      return;
    }
    const storageRaw = String(sheetEditor.storage_raw || '').trim();
    const patientName = String(sheetEditor.patient_name || '').replace(/\s+/g, ' ').trim();
    const changed = storageRaw !== String(sheetEditor.record.storage_raw || '').trim()
      || patientName !== String(sheetEditor.record.patient_name || '').replace(/\s+/g, ' ').trim();
    if (!changed) {
      toast?.('Chưa có thay đổi để lưu.', 'warn');
      return;
    }
    const ok = window.confirm(`Cập nhật dòng ${rowNumber} trên Google Sheet?\nSố LT: ${storageRaw || '(trống)'}\nHọ tên: ${patientName || '(trống)'}`);
    if (!ok) return;
    setSheetEditorSaving(true);
    try {
      const data = await updateRecordsCheckGoogleSheetRow({
        row_number: rowNumber,
        expected: {
          timestamp: sheetEditor.record.timestamp || '',
          storage_raw: sheetEditor.record.storage_raw || '',
          patient_name: sheetEditor.record.patient_name || '',
        },
        updates: {
          storage_raw: storageRaw,
          patient_name: patientName,
        },
      });
      if (data?.sheet) applyGoogleSheetData(data.sheet);
      toast?.(data?.message || `Đã cập nhật dòng ${rowNumber} trên Google Sheet.`, 'ok');
      setSheetEditor(null);
    } catch (err) {
      toast?.(`Không sửa được Google Sheet: ${String(err.message || err)}`, 'error');
    } finally {
      setSheetEditorSaving(false);
    }
  }

  function applyDashboardData(data) {
    setDashboard(data);
    const backendChecked = {};
    Object.entries(data?.checked_map || {}).forEach(([key, value]) => {
      if (key && value?.checked) backendChecked[key] = true;
    });
    (data?.patients || []).forEach(card => {
      const key = getCardCaseKey(card) || getNativeCaseKey(card);
      if (key && card?.checked) backendChecked[key] = true;
    });
    // Backend là nguồn chính xác. Ghi đè để checkbox đã bỏ chọn không bị
    // localStorage cũ tự bật lại sau khi tải trang.
    setCheckedMap(backendChecked);
    writeCheckedMap(backendChecked);
    setLastRefreshAt(new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    const job = data?.job;
    if (job?.running) setBatch({ running: true, done: Number(job.done || 0), total: Number(job.total || 0) });
    else if (batch.running) setBatch({ running: false, done: Number(job?.done || 0), total: Number(job?.total || 0) });
  }

  async function refreshDashboard({ silent = true } = {}) {
    if (!silent) setLoading(true);
    try {
      const data = await getRecordsCheckDashboard();
      applyDashboardData(data);
      return data;
    } catch (err) {
      toast?.(String(err.message || err), 'error');
      return null;
    } finally {
      if (!silent) setLoading(false);
    }
  }

  async function load({ doScan = false } = {}) {
    setLoading(true);
    try {
      if (doScan) await scanRecordsCheckCompleted({ date_from: workDateRange?.from || '', date_to: workDateRange?.to || workDateRange?.from || '', headless });
      const data = await getRecordsCheckDashboard();
      applyDashboardData(data);
    } catch (err) {
      toast?.(String(err.message || err), 'error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const data = await getRecordsCheckDashboard();
        if (!cancelled) applyDashboardData(data);
      } catch (err) {
        if (!cancelled) toast?.(String(err.message || err), 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (viewMode !== 'check') return undefined;
    let cancelled = false;
    (async () => {
      try {
        const data = await getRecordsCheckSubmissions();
        if (!cancelled) setSubmittedLockMap(buildSubmittedLockMap(data));
      } catch (err) {
        if (!cancelled) toast?.(`Không tải được trạng thái nộp hồ sơ: ${String(err.message || err)}`, 'error');
      }
    })();
    return () => { cancelled = true; };
  }, [viewMode]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cached = await getRecordsCheckGoogleSheet();
        if (cancelled) return;
        applyGoogleSheetData(cached);
        if (cached?.enabled !== false && cached?.auto_sync_on_open !== false) {
          // Đồng bộ tự động khi mở tab được phép dùng cache để giao diện vẫn hoạt
          // động khi mạng/Google tạm lỗi; đồng bộ thủ công thì không.
          const fresh = await syncRecordsCheckGoogleSheet({ allow_stale_fallback: true });
          if (!cancelled) applyGoogleSheetData(fresh);
        }
      } catch (err) {
        if (!cancelled) setGoogleSheet(prev => ({ ...prev, loading: false, warning: String(err.message || err) }));
      }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const jobRunningNow = Boolean(dashboard?.job?.running);
    if (!batch.running && !fetchingKey && !jobRunningNow) return undefined;
    const timer = window.setInterval(() => refreshDashboard({ silent: true }), 2500);
    return () => window.clearInterval(timer);
  }, [batch.running, fetchingKey, dashboard?.job?.running]); // eslint-disable-line react-hooks/exhaustive-deps

  const allRawCards = useMemo(() => (dashboard?.patients || []).filter(p => p?.active !== false), [dashboard]);
  const rows = useMemo(() => buildRows(allRawCards), [allRawCards]);
  const googleSheetIndex = useMemo(() => buildGoogleSheetIndex(googleSheet?.records || []), [googleSheet?.records]);
  const displayRows = useMemo(
    () => applyGoogleSheetValidation(applyJobStatus(rows, dashboard?.job), googleSheetIndex),
    [rows, dashboard?.job, googleSheetIndex],
  );
  const unlinkedSheetIssues = useMemo(
    () => buildUnlinkedSheetIssues(displayRows, googleSheet?.records || []),
    [displayRows, googleSheet?.records],
  );

  useEffect(() => {
    setUpdateSelectedKeys(prev => {
      const valid = new Set(displayRows.map(getRowKey).filter(Boolean));
      const next = new Set([...prev].filter(key => valid.has(key)));
      return next.size === prev.size ? prev : next;
    });
  }, [displayRows]);

  async function fetchCheckData(rowOrCard, { showToast = true } = {}) {
    const row = rowOrCard?.card ? rowOrCard : buildRows([rowOrCard])[0];
    if (!row) return;
    const key = getRowKey(row);
    setFetchingKey(key);
    try {
      await fetchRows([row], showToast ? `Đã đưa ${row.displayName || row.ma_bn || 'người bệnh'} vào hàng đợi cập nhật đầy đủ.` : undefined, { forceRefresh: true });
    } finally {
      setFetchingKey('');
    }
  }


  async function fetchRows(targetRows, doneMessage, { forceRefresh = false, prioritizeRetries = false } = {}) {
    const cursorKey = dashboard?.job?.resume_key || dashboard?.job?.current_key || '';
    const cleanTargets = targetRows.filter(Boolean);
    const sortedTargets = prioritizeRetries
      ? [...cleanTargets].sort(compareRowsForFetchPriority)
      : rotateRowsFromCursor(cleanTargets, cursorKey);
    const targets = batchLimit > 0 ? sortedTargets.slice(0, batchLimit) : sortedTargets;
    if (!targets.length) {
      toast?.('Không có dòng nào để cập nhật.', 'ok');
      return;
    }
    // Một hồ sơ hiển thị có thể gộp nhiều dòng EMR trùng số lưu trữ. Khi cập nhật,
    // gửi toàn bộ case_key nguồn để dữ liệu của các dòng chuyển khoa vẫn được lấy.
    const caseKeys = [];
    const seenCaseKeys = new Set();
    targets.forEach(row => {
      rowSourceCaseKeys(row).forEach(key => {
        if (!key || seenCaseKeys.has(key)) return;
        seenCaseKeys.add(key);
        caseKeys.push(key);
      });
    });
    if (!caseKeys.length) {
      toast?.('Không xác định được dòng hồ sơ để cập nhật.', 'warn');
      return;
    }
    setBatch({ running: true, done: 0, total: caseKeys.length });
    try {
      const dateFrom = workDateRange?.from || '';
      const dateTo = workDateRange?.to || dateFrom;
      await startRecordsCheckFetchBatch({
        case_keys: caseKeys,
        date_from: dateFrom,
        date_to: dateTo,
        headless,
        force_refresh: Boolean(forceRefresh),
      });
      await refreshDashboard({ silent: true });
      const limitNote = sortedTargets.length > targets.length
        ? ` (chạy trước ${targets.length}/${sortedTargets.length} ca ${prioritizeRetries ? 'theo ưu tiên ca chưa từng lấy và lỗi cũ' : 'theo ngày vào mới nhất'})`
        : '';
      toast?.((doneMessage || `Đã đưa ${targets.length} dòng hồ sơ vào hàng đợi cập nhật nền.`) + limitNote, 'ok');
    } catch (err) {
      setBatch({ running: false, done: 0, total: 0 });
      toast?.(`Không khởi động được cập nhật nền: ${String(err.message || err)}`, 'error');
    }
  }


  async function fetchAllMissing() {
    const targets = displayRows.filter(isRowFetchableMissing);
    if (!targets.length) {
      toast?.('Không còn ca thiếu dữ liệu cần lấy thêm.', 'ok');
      return;
    }
    await fetchRows(targets, 'Đã chạy cập nhật các ca còn thiếu dữ liệu kiểm hồ sơ.', { prioritizeRetries: true });
  }

  async function stopFetchJob() {
    try {
      const out = await stopRecordsCheckFetchBatch();
      setBatch({ running: false, done: 0, total: 0 });
      setFetchingKey('');
      await refreshDashboard({ silent: true });
      toast?.(out?.message || 'Đã dừng lấy dữ liệu kiểm hồ sơ.', 'ok');
    } catch (err) {
      toast?.(`Không dừng được tác vụ: ${String(err.message || err)}`, 'error');
    }
  }

  const statusOptions = useMemo(() => ['Đủ dữ liệu', 'Thiếu dữ liệu', 'Đang quét', 'Chưa ra viện'], []);
  const dischargeMonthOptions = useMemo(() => {
    const months = new Set(dischargeMonth ? [dischargeMonth] : []);
    displayRows.forEach(row => {
      const key = dischargeMonthKey(row?.dischargeDate);
      if (key) months.add(key);
    });
    return [...months].sort((a, b) => b.localeCompare(a));
  }, [displayRows, dischargeMonth]);

  const filteredRows = useMemo(() => {
    const q = norm(search);
    return displayRows
      .filter(row => !showOnlyCompleted || row.completed)
      .filter(row => !showOnlyStorage || row.storage)
      .filter(row => dataFilterMatches(row, dataFilter))
      .filter(row => paperFilterMatches(row, paperFilter))
      .filter(row => !dischargeMonth || dischargeMonthKey(row.dischargeDate) === dischargeMonth)
      .filter(row => {
        if (!q) return true;
        return norm([
          row.displayName, row.ma_bn, row.department, row.storage, row.admissionDate, row.dischargeDate,
          row.paperRecord?.record?.patient_name, row.paperRecord?.record?.storage_raw, row.paperRecord?.record?.timestamp, row.paperRecord?.issue_detail,
        ].join(' ')).includes(q);
      })
      .sort(compareRowsByAdmissionNewest);
  }, [displayRows, search, showOnlyCompleted, showOnlyStorage, dataFilter, paperFilter, dischargeMonth]);

  function toggleUpdateSelect(row, nextValue = null) {
    const key = getRowKey(row);
    if (!key) return;
    setUpdateSelectedKeys(prev => {
      const next = new Set(prev);
      const shouldSelect = nextValue == null ? !next.has(key) : Boolean(nextValue);
      if (shouldSelect) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function selectVisibleRows() {
    setUpdateSelectedKeys(prev => {
      const next = new Set(prev);
      filteredRows.forEach(row => {
        const key = getRowKey(row);
        if (key) next.add(key);
      });
      return next;
    });
  }

  function selectMissingRows() {
    setUpdateSelectedKeys(prev => {
      const next = new Set(prev);
      filteredRows.filter(isRowFetchableMissing).forEach(row => {
        const key = getRowKey(row);
        if (key) next.add(key);
      });
      return next;
    });
  }

  function clearUpdateSelection() {
    setUpdateSelectedKeys(new Set());
  }

  async function fetchSelectedRows() {
    const targets = displayRows.filter(row => updateSelectedKeys.has(getRowKey(row)));
    if (!targets.length) {
      toast?.('Chưa chọn dòng hồ sơ để cập nhật.', 'warn');
      return;
    }
    await fetchRows(targets, `Đã đưa ${targets.length} dòng hồ sơ đã chọn vào hàng đợi cập nhật đầy đủ.`, { forceRefresh: true });
  }

  const counts = useMemo(() => {
    const completed = displayRows.filter(r => r.completed);
    const withStorage = displayRows.filter(r => r.storage);
    const checked = filteredRows.filter(r => isRowChecked(r, checkedMap)).length;
    const withPaperRecord = displayRows.filter(r => r.paperRecord?.state === 'available').length;
    const paperIssues = displayRows.filter(r => PAPER_ISSUE_STATES.has(String(r.paperRecord?.state || ''))).length;
    const paperNameMismatch = displayRows.filter(r => ['name_mismatch', 'possible_name_typo'].includes(r.paperRecord?.state)).length;
    const paperStorageNameConflict = displayRows.filter(r => r.paperRecord?.state === 'storage_name_conflict').length;
    const paperDoubleTypo = displayRows.filter(r => r.paperRecord?.state === 'possible_name_and_storage_typo').length;
    const paperMissingName = displayRows.filter(r => r.paperRecord?.state === 'missing_name').length;
    const paperAmbiguous = displayRows.filter(r => r.paperRecord?.state === 'ambiguous_storage').length;
    return {
      total: displayRows.length,
      mergedSourceRows: displayRows.reduce((sum, row) => sum + Math.max(0, Number(row?.card?.duplicate_storage_count || 1) - 1), 0),
      completed: completed.length,
      withStorage: withStorage.length,
      withPaperRecord,
      paperIssues,
      paperNameMismatch,
      paperStorageNameConflict,
      paperDoubleTypo,
      paperMissingName,
      paperAmbiguous,
      unlinkedSheet: unlinkedSheetIssues.length,
      unlinkedSheetSuspicious: unlinkedSheetIssues.filter(issue => issue.tone === 'red' || issue.tone === 'amber').length,
      sheetNeedsReview: paperIssues + unlinkedSheetIssues.filter(issue => issue.tone === 'red' || issue.tone === 'amber').length,
      shown: filteredRows.length,
      selected: updateSelectedKeys.size,
      checked,
      missingData: displayRows.filter(r => !isRowDataComplete(r)).length,
      completeData: displayRows.filter(r => isRowDataComplete(r)).length,
      shownMissing: filteredRows.filter(r => !isRowDataComplete(r)).length,
    };
  }, [displayRows, filteredRows, checkedMap, updateSelectedKeys, unlinkedSheetIssues]);

  const activeJob = dashboard?.job || null;
  const jobRunning = Boolean(activeJob?.running);
  const effectiveRunning = Boolean(jobRunning || batch.running || fetchingKey);
  const activeDone = Number(activeJob?.done ?? batch.done ?? 0);
  const activeTotal = Number(activeJob?.total ?? batch.total ?? 0);

  const submissionRecords = useMemo(() => displayRows.map(row => ({
    record_id: submissionRecordId(row),
    aliases: submissionAliases(row),
    source_case_keys: rowSourceCaseKeys(row),
    checked: isRowChecked(row, checkedMap),
    data_complete: isRowDataComplete(row),
    snapshot: {
      ho_ten: row.displayName || '',
      ma_bn: row.ma_bn || '',
      so_luu_tru: row.storage || '',
      so_luu_tru_in: storageForPrint(row.storage),
      storage_kind: storageKind(row.storage),
      admission_date: row.admissionDate || '',
      discharge_date: row.dischargeDate || '',
      xq: Number(row.stats?.xq || 0),
      ct: Number(row.stats?.ct || 0),
      mri: Number(row.stats?.mri || 0),
    },
  })), [displayRows, checkedMap]);

  async function clearSubmissionChecked(recordsToClear = []) {
    const targets = Array.isArray(recordsToClear) ? recordsToClear.filter(Boolean) : [];
    const aliases = [...new Set(targets.flatMap(record => [
      record?.record_id,
      ...(Array.isArray(record?.aliases) ? record.aliases : []),
      ...(Array.isArray(record?.source_case_keys) ? record.source_case_keys : []),
    ]).map(value => String(value || '').trim()).filter(Boolean))];
    if (!aliases.length) throw new Error('Không tìm được khóa hồ sơ để bỏ dấu đã kiểm.');

    await setRecordsCheckChecked(aliases, false);
    await refreshDashboard({ silent: true });
    return { count: targets.length };
  }

  async function exportCheckedPdf() {
    const rowsForPdf = displayRows
      .filter(row => isRowChecked(row, checkedMap))
      .map(row => ({
        ho_ten: row.displayName || '',
        ma_bn: row.ma_bn || '',
        so_luu_tru: row.storage || '',
        so_luu_tru_in: storageForPrint(row.storage),
        storage_kind: storageKind(row.storage),
        xq: Number(row.stats?.xq || 0),
        ct: Number(row.stats?.ct || 0),
        mri: Number(row.stats?.mri || 0),
      }));
    if (!rowsForPdf.length) {
      toast?.('Chưa có hồ sơ được đánh dấu “Đã kiểm” để xuất PDF.', 'warn');
      return;
    }
    try {
      const out = await exportRecordsCheckPdf({ rows: rowsForPdf });
      const url = String(out?.url || '').trim();
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
      toast?.(`Đã xuất PDF ${Number(out?.count || rowsForPdf.length)} hồ sơ đã kiểm.`, 'ok');
    } catch (err) {
      toast?.(`Không xuất được PDF: ${String(err.message || err)}`, 'error');
    }
  }

  const modeTabs = (
    <div style={{ display: 'flex', gap: 0, alignItems: 'center', padding: '0 12px', background: C.surface, borderBottom: `1px solid ${C.border2}` }}>
      <button type="button" onClick={() => setViewMode('check')} style={{ ...modeTabStyle, color: viewMode === 'check' ? C.text : C.text3, background: 'transparent', borderColor: 'transparent', borderBottom: `2px solid ${viewMode === 'check' ? C.blue : 'transparent'}` }}>
        Danh sách kiểm hồ sơ
      </button>
      <button type="button" onClick={() => setViewMode('submission')} style={{ ...modeTabStyle, color: viewMode === 'submission' ? C.text : C.text3, background: 'transparent', borderColor: 'transparent', borderBottom: `2px solid ${viewMode === 'submission' ? C.blue : 'transparent'}` }}>
        Nộp hồ sơ theo ngày
      </button>
      <span style={{ marginLeft: 10, color: C.text3, fontSize: 9.5 }}>Dấu đã kiểm được lưu cố định.</span>
    </div>
  );


  if (loading && !dashboard) {
    return <div style={{ padding: 32, color: C.text2, display: 'flex', alignItems: 'center', gap: 10 }}><Spinner /> Đang tải dữ liệu kiểm hồ sơ...</div>;
  }

  if (viewMode === 'submission') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        {modeTabs}
        <div style={{ flex: 1, minHeight: 0 }}>
          <RecordsSubmissionTab records={submissionRecords} toast={toast} onClearChecked={clearSubmissionChecked} />
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {modeTabs}
      <div style={{ padding: '9px 12px', borderBottom: `1px solid ${C.border2}`, background: C.surface }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 160, marginRight: 2 }}>
            <div style={{ fontSize: 14, fontWeight: 850, color: C.text }}>Kiểm hồ sơ</div>
            <div style={{ fontSize: 10, color: C.text3, marginTop: 1 }}>Ca hoàn tất và CĐHA</div>
          </div>
          <Btn variant="primary" disabled={loading || effectiveRunning} onClick={() => load({ doScan: true })} style={{ fontSize: 11, padding: '5px 12px' }}>
            {loading ? <><Spinner size={10} /> Đang quét...</> : 'Quét danh sách'}
          </Btn>
          <Btn variant="secondary" disabled={googleSheet.loading} onClick={() => syncGoogleSheet()} style={{ fontSize: 11, padding: '5px 12px' }}>
            {googleSheet.loading ? <><Spinner size={10} /> Đang đồng bộ Sheet...</> : 'Đồng bộ Sheet'}
          </Btn>
          {googleSheet.spreadsheet_url ? <a href={googleSheet.spreadsheet_url} target="_blank" rel="noreferrer" style={{ fontSize: 11, fontWeight: 800, color: C.blue, textDecoration: 'none' }}>Mở Google Sheet</a> : null}
          <Chip tone={googleSheet.write_enabled ? 'green' : 'amber'} title={googleSheet.write_config_error || (googleSheet.write_missing_token ? 'Thiếu EMR_GOOGLE_SHEET_WRITE_TOKEN' : 'Chưa cấu hình Google Apps Script Web app')}>{googleSheet.write_enabled ? 'Sheet: sửa được' : 'Sheet: chỉ đọc'}</Chip>
          <Btn variant="danger" disabled={effectiveRunning} onClick={fetchAllMissing} style={{ fontSize: 11, padding: '5px 12px' }}>
            {effectiveRunning ? `Đang lấy ${activeDone}/${activeTotal || '?'}` : `Lấy ca thiếu${batchLimit > 0 ? ` (${batchLimit})` : ''}`}
          </Btn>
          <Btn variant="danger" disabled={!effectiveRunning} onClick={stopFetchJob} style={{ fontSize: 11, padding: '5px 12px' }}>
            Dừng lấy
          </Btn>
          <Btn variant="secondary" disabled={!updateSelectedKeys.size || effectiveRunning} onClick={fetchSelectedRows} style={{ fontSize: 11, padding: '5px 12px' }}>
            {updateSelectedKeys.size ? `Cập nhật đã chọn (${updateSelectedKeys.size})` : 'Cập nhật đã chọn'}
          </Btn>
          <Btn variant="secondary" disabled={!filteredRows.length} onClick={selectVisibleRows} style={{ fontSize: 11, padding: '5px 12px' }}>Chọn dòng hiển thị</Btn>
          <Btn variant="secondary" disabled={!filteredRows.some(isRowFetchableMissing)} onClick={selectMissingRows} style={{ fontSize: 11, padding: '5px 12px' }}>Chọn ca thiếu</Btn>
          <Btn variant="default" disabled={!updateSelectedKeys.size} onClick={clearUpdateSelection} style={{ fontSize: 11, padding: '5px 12px' }}>Bỏ chọn</Btn>
          <Btn variant="secondary" disabled={!filteredRows.length} onClick={() => exportCsv(filteredRows, checkedMap)} style={{ fontSize: 11, padding: '5px 12px' }}>Xuất CSV</Btn>
          <Btn variant="secondary" disabled={!counts.checked} onClick={exportCheckedPdf} style={{ fontSize: 11, padding: '5px 12px' }}>{counts.checked ? `Xuất PDF đã kiểm (${counts.checked})` : 'Xuất PDF đã kiểm'}</Btn>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: C.text2, userSelect: 'none' }} title="Giới hạn số ca chạy trong một lượt. Khi lấy ca thiếu, hệ thống ưu tiên ca chưa từng lấy rồi mới thử lại các ca lỗi cũ để tránh kẹt ở nhóm đầu.">
            Mỗi lượt
            <select value={batchLimit} onChange={e => setBatchLimitPref(Number(e.target.value || 0))} disabled={effectiveRunning}
              style={{ padding: '4px 8px', borderRadius: 8, background: C.surface2, border: `1px solid ${C.border}`, color: C.text, fontSize: 11 }}>
              <option value={25}>25 ca</option>
              <option value={50}>50 ca</option>
              <option value={100}>100 ca</option>
              <option value={200}>200 ca</option>
              <option value={0}>Tất cả</option>
            </select>
          </label>
          <label title={headless ? 'Bật chạy ẩn: khi lấy chi tiết sẽ không mở cửa sổ Chrome.' : 'Tắt chạy ẩn: dùng khi cần nhìn Chrome thao tác để kiểm lỗi.'}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 800, color: headless ? C.green : C.amber, border: `1px solid ${headless ? C.greenBorder : C.amberBorder}`, background: headless ? C.greenBg : C.amberBg, borderRadius: 999, padding: '4px 9px', userSelect: 'none' }}>
            <input type="checkbox" checked={headless} onChange={e => setHeadlessPref(e.target.checked)} />
            {headless ? 'Chạy ẩn: Bật' : 'Chạy ẩn: Tắt (sẽ hiện Chrome)'}
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: C.text2, userSelect: 'none' }}>
            <input type="checkbox" checked={showOnlyCompleted} onChange={e => setShowOnlyCompleted(e.target.checked)} />
            Chỉ ca hoàn tất
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: C.text2, userSelect: 'none' }}>
            <input type="checkbox" checked={showOnlyStorage} onChange={e => setShowOnlyStorage(e.target.checked)} />
            Chỉ có số lưu trữ
          </label>
          <select value={paperFilter} onChange={e => setPaperFilter(e.target.value)} title="Lọc theo kết quả đối chiếu EMR với Google Sheet" style={{ padding: '6px 10px', borderRadius: 8, background: C.surface2, border: `1px solid ${C.border}`, color: C.text, fontSize: 12, minWidth: 205 }}>
            <option value="all">Đối chiếu Sheet: Tất cả</option>
            <option value="available">Đã khớp tên và Số LT</option>
            <option value="issues">Có thể sai / cần kiểm</option>
            <option value="missing">Chưa có trên Sheet</option>
            <option value="possible_name_typo">Tên gần giống, cần kiểm</option>
            <option value="storage_name_conflict">Một Số LT có nhiều tên</option>
            <option value="name_mismatch">Cùng Số LT, khác tên</option>
            <option value="missing_same_name">Chưa có - tên trùng Số LT khác</option>
            <option value="possible_name_and_storage_typo">Tên và Số LT đều gần giống</option>
            <option value="missing_name">Sheet thiếu tên</option>
            <option value="ambiguous_storage">Trùng Số LT, chưa xác định</option>
          </select>
          <select value={dataFilter} onChange={e => setDataFilter(e.target.value)} title="Lọc theo trạng thái đang hiển thị trong bảng" style={{ padding: '6px 10px', borderRadius: 8, background: C.surface2, border: `1px solid ${C.border}`, color: C.text, fontSize: 12, minWidth: 165 }}>
            <option value="all">Tất cả trạng thái</option>
            {statusOptions.map(label => <option key={label} value={statusFilterValue(label)}>{label}</option>)}
          </select>
          <select
            value={dischargeMonth}
            onChange={e => setDischargeMonthPref(e.target.value)}
            title="Chỉ hiển thị hồ sơ có ngày ra viện thuộc tháng đã chọn"
            style={{ padding: '6px 10px', borderRadius: 8, background: C.surface2, border: `1px solid ${dischargeMonth ? C.blueBorder : C.border}`, color: dischargeMonth ? C.blue : C.text, fontSize: 12, minWidth: 170, fontWeight: dischargeMonth ? 800 : 400 }}
          >
            <option value="">Ra viện: Tất cả tháng</option>
            {dischargeMonthOptions.map(month => (
              <option key={month} value={month}>Ra viện {dischargeMonthLabel(month)}</option>
            ))}
          </select>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Tìm tên, mã BN, khoa, số lưu trữ..." style={{ flex: 1, minWidth: 210, maxWidth: 380, padding: '6px 10px', borderRadius: 8, background: C.surface2, border: `1px solid ${C.border}`, color: C.text, fontSize: 12 }} />
          {loading && <Spinner size={14} />}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '8px 16px', background: C.surface, borderBottom: `1px solid ${C.border2}` }}>
        <StatBox label="Tổng hồ sơ" value={counts.total} tone="blue" />
        {counts.mergedSourceRows ? <StatBox label="Dòng trùng đã gộp" value={counts.mergedSourceRows} tone="blue" /> : null}
        <StatBox label="Đã khớp Sheet" value={counts.withPaperRecord} tone="green" />
        <StatBox label="Đã kiểm" value={counts.checked} tone="green" />
        <StatBox label="Chưa đủ dữ liệu" value={counts.missingData} tone={counts.missingData ? 'amber' : 'green'} />
        {counts.sheetNeedsReview ? <StatBox label="Sheet cần kiểm" value={counts.sheetNeedsReview} tone="red" /> : null}
        {counts.paperStorageNameConflict ? <StatBox label="Một Số LT nhiều tên" value={counts.paperStorageNameConflict} tone="red" /> : null}
        {counts.paperNameMismatch ? <StatBox label="Có thể sai tên" value={counts.paperNameMismatch} tone="amber" /> : null}
        {counts.paperDoubleTypo ? <StatBox label="Tên/Số LT gần giống" value={counts.paperDoubleTypo} tone="amber" /> : null}
        {counts.paperMissingName ? <StatBox label="Sheet thiếu tên" value={counts.paperMissingName} tone="amber" /> : null}
        {counts.paperAmbiguous ? <StatBox label="Trùng Số LT chưa rõ" value={counts.paperAmbiguous} tone="amber" /> : null}
        {counts.unlinkedSheet ? <StatBox label="Dòng Sheet chưa ghép" value={counts.unlinkedSheet} tone={counts.unlinkedSheetSuspicious ? 'amber' : 'blue'} /> : null}
        <div style={{ color: C.text2, fontSize: 11 }}>Hiển thị <b style={{ color: C.text }}>{counts.shown}</b> dòng{dischargeMonth ? <span> · Ra viện <b style={{ color: C.blue }}>{dischargeMonthLabel(dischargeMonth)}</b></span> : null} · Đã chọn <b style={{ color: C.text }}>{counts.selected}</b>{effectiveRunning ? <span> · <b style={{ color: C.red }}>Đang lấy {activeDone}/{activeTotal || '?'}</b>{activeJob?.current_name ? <span> · {activeJob.current_name}</span> : null}</span> : (activeJob?.message ? <span> · {activeJob.stale ? <b style={{ color: C.amber }}>Tác vụ cũ đã dừng</b> : activeJob.stopped ? <b style={{ color: C.amber }}>Đã dừng</b> : <span>{activeJob.message}</span>}</span> : null)}{lastRefreshAt ? <span> · Cập nhật {lastRefreshAt}</span> : null}<span> · Google Sheet <b style={{ color: googleSheet.stale ? C.amber : C.green }}>{Number(googleSheet.count || 0)} hồ sơ</b>{googleSheet.fetched_at ? ` · ${new Date(googleSheet.fetched_at).toLocaleString('vi-VN')}` : ''}</span>{googleSheet.warning ? <span title={googleSheet.warning} style={{ color: C.amber }}> · Sheet đang dùng dữ liệu đã lưu</span> : null}</div>
      </div>

      {unlinkedSheetIssues.length ? (
        <details style={{ margin: '8px 16px 0', border: `1px solid ${C.amberBorder}`, borderRadius: 6, background: C.amberBg, overflow: 'hidden', flexShrink: 0 }}>
          <summary style={{ cursor: 'pointer', padding: '9px 12px', color: C.amber, fontSize: 11, fontWeight: 850 }}>
            Google Sheet có {unlinkedSheetIssues.length} dòng chưa ghép được với danh sách EMR hiện tại{counts.unlinkedSheetSuspicious ? ` · ${counts.unlinkedSheetSuspicious} dòng có dấu hiệu sai` : ''} — bấm để kiểm tra
          </summary>
          <div style={{ maxHeight: 220, overflow: 'auto', background: C.surface }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead style={{ position: 'sticky', top: 0, background: C.surface2, zIndex: 1 }}>
                <tr>
                  {['Dòng Sheet', 'Thời gian', 'Số lưu trữ Sheet', 'Tên trên Sheet', 'Nhận định', 'Sửa'].map(label => (
                    <th key={label} style={{ padding: '7px 9px', borderBottom: `1px solid ${C.border}`, textAlign: 'left', color: C.text2, fontSize: 9, textTransform: 'uppercase', letterSpacing: .5 }}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {unlinkedSheetIssues.slice(0, 100).map(issue => (
                  <tr key={`${issue.record?.row_number || ''}::${issue.record?.storage_raw || ''}::${issue.record?.patient_name || ''}`}>
                    <td style={sheetIssueCellStyle}>{issue.record?.row_number || '—'}</td>
                    <td style={sheetIssueCellStyle}>{issue.record?.timestamp || '—'}</td>
                    <td style={{ ...sheetIssueCellStyle, fontWeight: 800, color: C.text }}>{issue.record?.storage_raw || '—'}</td>
                    <td style={{ ...sheetIssueCellStyle, fontWeight: 800, color: C.text }}>{issue.record?.patient_name || '—'}</td>
                    <td style={{ ...sheetIssueCellStyle, minWidth: 260 }}><Chip tone={issue.tone}>{issue.label}</Chip><div style={{ marginTop: 3, color: C.text2, fontSize: 10 }}>{issue.detail}</div></td>
                    <td style={sheetIssueCellStyle}><Btn variant="secondary" onClick={() => openSheetEditor({ records: [issue.record], note: issue.detail })} style={{ fontSize: 10, padding: '4px 8px' }}>Sửa dòng</Btn></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {unlinkedSheetIssues.length > 100 ? <div style={{ padding: 8, color: C.text2, fontSize: 10 }}>Chỉ hiển thị 100/{unlinkedSheetIssues.length} dòng đầu.</div> : null}
          </div>
        </details>
      ) : null}

      <div style={{ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' }}>
        <div style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '12px 14px' }}>
          <div style={{ border: `1px solid ${C.border}`, borderRadius: 7, overflow: 'hidden', background: C.surface, boxShadow: C.shadow }}>
            <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0 }}>
              <thead style={{ position: 'sticky', top: 0, zIndex: 3 }}>
                <tr style={{ background: C.surface2 }}>
                  {[
                    ['Chọn', 'center'], ['Đã kiểm', 'center'], ['Số lưu trữ EMR', 'left'], ['Đối chiếu Sheet', 'left'], ['Họ và tên EMR', 'left'],
                    ['Ngày vào viện', 'left'], ['Ngày ra viện', 'left'],
                    ['Số XQ', 'center'], ['Số CT', 'center'], ['Số MRI', 'center'],
                    ['Dữ liệu', 'left'],
                  ].map(([label, align]) => (
                    <th key={label} style={{ padding: '8px 9px', borderBottom: `1px solid ${C.border}`, color: C.text2, fontSize: 10, textAlign: align, textTransform: 'uppercase', letterSpacing: .6, whiteSpace: 'nowrap' }}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredRows.length === 0 ? (
                  <tr><td colSpan={11} style={{ padding: 24, textAlign: 'center', color: C.text2, fontSize: 13 }}>Chưa có ca phù hợp. Bấm “Quét danh sách” để tạo danh sách kiểm hồ sơ riêng.</td></tr>
                ) : filteredRows.map(row => {
                  const rowKey = getRowKey(row);
                  const checked = isRowChecked(row, checkedMap);
                  const submissionLock = submittedLockForRow(row, submittedLockMap);
                  const checkedLocked = Boolean(submissionLock);
                  const selectedForUpdate = updateSelectedKeys.has(rowKey);
                  const savingChecked = savingCheckedKeys.has(rowKey);
                  const paperCandidates = Number(row.paperRecord?.candidates?.length || 0);
                  const editableSheetRecords = editableSheetRecordsForRow(row);
                  const paperTitle = row.paperRecord?.issue_detail
                    || (row.paperRecord?.record
                      ? `Google Sheet: ${row.paperRecord.record.patient_name || 'Không ghi tên'} · ${row.paperRecord.record.storage_raw || 'Không ghi Số LT'} · ${row.paperRecord.record.timestamp || 'Không ghi thời gian'}${paperCandidates > 1 ? ` · Có ${paperCandidates} dòng liên quan` : ''}`
                      : 'Chưa tìm thấy dữ liệu phù hợp trên Google Sheet');
                  const retryText = row?.card?.next_retry_at ? new Date(row.card.next_retry_at).toLocaleString('vi-VN') : '';
                  const dataTitle = row?.card?.fetch_error
                    ? `${row.card.fetch_error}${retryText ? ` · Tự ưu tiên thử lại sau ${retryText}` : ''}`
                    : (row.status.label === 'Đủ dữ liệu' ? 'Đã lấy đủ thông tin ra viện và CĐHA.' : 'Cần lấy thêm dữ liệu ra viện hoặc CĐHA.');
                  return (
                    <tr key={rowKey || `${row.ma_bn}-${row.storage || row.admissionDate || ''}`} style={{ background: selectedForUpdate ? C.surface2 : C.surface }}>
                      <td onClick={e => e.stopPropagation()} style={countCellStyle}>
                        <input type="checkbox" checked={selectedForUpdate} onChange={e => toggleUpdateSelect(row, e.target.checked)} title="Chọn ca này để cập nhật dữ liệu" />
                      </td>
                      <td onClick={e => e.stopPropagation()} style={countCellStyle}>
                        <div style={{ display: 'grid', justifyItems: 'center', gap: 3 }}>
                          <input
                            type="checkbox"
                            checked={checked || checkedLocked}
                            disabled={savingChecked || checkedLocked}
                            onChange={e => setChecked(row, e.target.checked)}
                            title={savingChecked
                              ? 'Đang lưu...'
                              : checkedLocked
                                ? `Hồ sơ đã nộp${submissionLock?.submission_date ? ` ngày ${formatSubmissionDate(submissionLock.submission_date)}` : ''}; không thể thay đổi dấu đã kiểm.`
                                : 'Đánh dấu đã kiểm hồ sơ'}
                          />
                          {checkedLocked ? <span style={{ color: C.green, fontSize: 8, fontWeight: 850, whiteSpace: 'nowrap' }}>ĐÃ NỘP</span> : null}
                        </div>
                      </td>
                      <td title={row.storage || ''} style={{ padding: '8px 8px', borderBottom: `1px solid ${C.border2}`, color: row.storage ? C.text : C.text3, fontSize: 12, fontWeight: row.storage ? 800 : 500, whiteSpace: 'nowrap', minWidth: 145 }}>{row.storage || '—'}</td>
                      <td style={{ padding: '8px 8px', borderBottom: `1px solid ${C.border2}`, minWidth: 235, maxWidth: 310 }}>
                        <Chip tone={row.paperRecord?.tone || 'gray'} title={paperTitle}>{row.paperRecord?.label || 'Chưa có hồ sơ'}</Chip>
                        {row.paperRecord?.record ? (
                          <div style={{ marginTop: 4, color: C.text2, fontSize: 9, lineHeight: 1.35, overflowWrap: 'anywhere' }}>
                            <div><b>Sheet:</b> {row.paperRecord.record.patient_name || 'Không ghi tên'} · {row.paperRecord.record.storage_raw || 'Không ghi Số LT'}</div>
                            {row.paperRecord.record.timestamp ? <div style={{ color: C.text3 }}>{row.paperRecord.record.timestamp}</div> : null}
                          </div>
                        ) : null}
                        {row.paperRecord?.issue_detail ? <div style={{ marginTop: 4, color: row.paperRecord.tone === 'red' ? C.red : (row.paperRecord.tone === 'amber' ? C.amber : C.text2), fontSize: 9, lineHeight: 1.35, fontWeight: row.paperRecord.is_issue ? 700 : 500, whiteSpace: 'normal' }}>{row.paperRecord.issue_detail}</div> : null}
                        {editableSheetRecords.length ? (
                          <div style={{ marginTop: 5 }}>
                            <Btn variant="secondary" onClick={() => openSheetEditor({ records: editableSheetRecords, emrRow: row, note: row.paperRecord?.issue_detail || '' })} style={{ fontSize: 9, padding: '3px 8px' }}>
                              {editableSheetRecords.length > 1 ? `Xem / sửa ${editableSheetRecords.length} dòng Sheet` : 'Sửa dòng Sheet'}
                            </Btn>
                          </div>
                        ) : null}
                      </td>
                      <td style={{ padding: '8px 10px', borderBottom: `1px solid ${C.border2}`, minWidth: 220 }}>
                        <div style={{ fontSize: 12, fontWeight: 800, color: C.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.displayName}</div>
                        <div style={{ fontSize: 10, color: C.text2, marginTop: 1 }}>{row.ma_bn}{row.department ? ` · ${row.department}` : ''}</div>
                        {Number(row?.card?.duplicate_storage_count || 0) > 1 ? <div style={{ marginTop: 3 }}><Chip tone="blue">Đã gộp {Number(row.card.duplicate_storage_count)} dòng EMR</Chip></div> : null}
                      </td>
                      <td style={dateCellStyle}>{row.admissionDate || '—'}</td>
                      <td style={dateCellStyle}>{row.dischargeDate || '—'}</td>
                      <td style={countCellStyle}>{row.stats.xq}</td>
                      <td style={countCellStyle}>{row.stats.ct}</td>
                      <td style={countCellStyle}>{row.stats.mri}</td>
                      <td style={{ padding: '8px 8px', borderBottom: `1px solid ${C.border2}`, minWidth: 118 }}><Chip tone={row.status.tone} title={dataTitle}>{row.status.label}</Chip></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {sheetEditor ? (
        <div role="dialog" aria-modal="true" onMouseDown={event => { if (event.target === event.currentTarget && !sheetEditorSaving) setSheetEditor(null); }} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(15, 23, 42, .46)', display: 'grid', placeItems: 'center', padding: 18 }}>
          <div style={{ width: 'min(680px, 96vw)', maxHeight: '90vh', overflow: 'auto', background: C.surface, border: `1px solid ${C.border}`, borderRadius: 7, boxShadow: '0 20px 60px rgba(15,23,42,.28)' }}>
            <div style={{ padding: '11px 14px', borderBottom: `1px solid ${C.border2}`, display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 850, color: C.text }}>Sửa dữ liệu Google Sheet</div>
                <div style={{ fontSize: 10, color: C.text3, marginTop: 2 }}>Chỉ cập nhật cột Số lưu trữ và Họ và tên của đúng dòng được chọn.</div>
              </div>
              <button type="button" disabled={sheetEditorSaving} onClick={() => setSheetEditor(null)} style={{ border: 0, background: 'transparent', color: C.text2, fontSize: 20, cursor: 'pointer' }}>×</button>
            </div>
            <div style={{ padding: 14, display: 'grid', gap: 12 }}>
              {sheetEditor.records?.length > 1 ? (
                <div>
                  <div style={sheetEditorLabelStyle}>Chọn dòng cần sửa</div>
                  <select value={sheetEditor.selected_key} onChange={event => selectSheetEditorRecord(event.target.value)} style={sheetEditorInputStyle}>
                    {sheetEditor.records.map(record => (
                      <option key={sheetRecordUiKey(record)} value={sheetRecordUiKey(record)}>
                        Dòng {record.row_number || '—'} · {record.storage_raw || 'Không Số LT'} · {record.patient_name || 'Không tên'}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}

              {sheetEditor.note ? <div style={{ padding: '8px 10px', borderRadius: 8, border: `1px solid ${C.amberBorder}`, background: C.amberBg, color: C.amber, fontSize: 11, lineHeight: 1.45 }}>{sheetEditor.note}</div> : null}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div style={{ padding: 10, borderRadius: 8, background: C.surface2, border: `1px solid ${C.border2}` }}>
                  <div style={sheetEditorLabelStyle}>Dòng hiện tại trên Sheet</div>
                  <div style={{ fontSize: 12, color: C.text, lineHeight: 1.6 }}>
                    <div><b>Dòng:</b> {sheetEditor.record?.row_number || '—'}</div>
                    <div><b>Thời gian:</b> {sheetEditor.record?.timestamp || '—'}</div>
                    <div><b>Số LT:</b> {sheetEditor.record?.storage_raw || '—'}</div>
                    <div><b>Họ tên:</b> {sheetEditor.record?.patient_name || '—'}</div>
                  </div>
                </div>
                <div style={{ padding: 10, borderRadius: 8, background: C.blueBg, border: `1px solid ${C.blueBorder}` }}>
                  <div style={sheetEditorLabelStyle}>Dữ liệu EMR đang đối chiếu</div>
                  {sheetEditor.emrRow ? (
                    <div style={{ fontSize: 12, color: C.text, lineHeight: 1.6 }}>
                      <div><b>Số LT:</b> {sheetEditor.emrRow.storage || '—'}</div>
                      <div><b>Họ tên:</b> {sheetEditor.emrRow.displayName || '—'}</div>
                      <div><b>Mã BN:</b> {sheetEditor.emrRow.ma_bn || '—'}</div>
                    </div>
                  ) : <div style={{ fontSize: 11, color: C.text2 }}>Dòng Sheet này chưa ghép chắc chắn với hồ sơ EMR. Hãy tự xác minh trước khi sửa.</div>}
                </div>
              </div>

              <div>
                <div style={sheetEditorLabelStyle}>Số lưu trữ trên Google Sheet</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input value={sheetEditor.storage_raw} onChange={event => patchSheetEditor({ storage_raw: event.target.value })} style={sheetEditorInputStyle} />
                  {sheetEditor.emrRow?.storage ? <Btn variant="secondary" onClick={() => patchSheetEditor({ storage_raw: sheetEditor.emrRow.storage })} style={{ whiteSpace: 'nowrap' }}>Dùng Số LT EMR</Btn> : null}
                </div>
              </div>
              <div>
                <div style={sheetEditorLabelStyle}>Họ và tên trên Google Sheet</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input value={sheetEditor.patient_name} onChange={event => patchSheetEditor({ patient_name: event.target.value })} style={sheetEditorInputStyle} />
                  {sheetEditor.emrRow?.displayName ? <Btn variant="secondary" onClick={() => patchSheetEditor({ patient_name: sheetEditor.emrRow.displayName })} style={{ whiteSpace: 'nowrap' }}>Dùng tên EMR</Btn> : null}
                </div>
              </div>

              {!googleSheet.write_enabled ? (
                <div style={{ padding: '8px 10px', borderRadius: 8, border: `1px solid ${C.redBorder}`, background: C.redBg, color: C.red, fontSize: 11, lineHeight: 1.45 }}>
                  Chức năng ghi trực tiếp chưa được cấu hình. {googleSheet.write_config_error || (googleSheet.write_missing_token ? 'Server đang thiếu EMR_GOOGLE_SHEET_WRITE_TOKEN.' : 'Cần khai báo write_web_app_url của Google Apps Script.')}
                </div>
              ) : null}

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                {googleSheetRowUrl(googleSheet.spreadsheet_url, googleSheet.sheet_gid, sheetEditor.record?.row_number) ? (
                  <a href={googleSheetRowUrl(googleSheet.spreadsheet_url, googleSheet.sheet_gid, sheetEditor.record?.row_number)} target="_blank" rel="noreferrer" style={{ fontSize: 11, fontWeight: 800, color: C.blue, textDecoration: 'none' }}>Mở đúng dòng trên Google Sheet</a>
                ) : <span />}
                <div style={{ display: 'flex', gap: 8 }}>
                  <Btn variant="default" disabled={sheetEditorSaving} onClick={() => setSheetEditor(null)}>Hủy</Btn>
                  <Btn variant="primary" disabled={sheetEditorSaving || !googleSheet.write_enabled} onClick={saveSheetEditor}>
                    {sheetEditorSaving ? <><Spinner size={10} /> Đang lưu...</> : 'Lưu lên Google Sheet'}
                  </Btn>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const sheetEditorLabelStyle = { fontSize: 10, color: C.text3, fontWeight: 850, textTransform: 'uppercase', letterSpacing: .5, marginBottom: 5 };
const sheetEditorInputStyle = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, background: C.surface2, border: `1px solid ${C.border}`, color: C.text, fontSize: 12 };
const modeTabStyle = { border: '1px solid', borderRadius: 8, padding: '6px 11px', fontSize: 11, fontWeight: 850, cursor: 'pointer' };
const countCellStyle = { padding: '8px 8px', borderBottom: `1px solid ${C.border2}`, textAlign: 'center', color: C.text, fontSize: 12, fontWeight: 800 };
const dateCellStyle = { padding: '8px 8px', borderBottom: `1px solid ${C.border2}`, color: C.text2, fontSize: 11, whiteSpace: 'nowrap' };
const sheetIssueCellStyle = { padding: '7px 9px', borderBottom: `1px solid ${C.border2}`, color: C.text2, fontSize: 10, verticalAlign: 'top' };
