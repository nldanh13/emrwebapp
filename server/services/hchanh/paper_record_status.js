// server/services/hchanh/paper_record_status.js
//
// Logic thuần (không đụng file/EMR) cho quy định bàn giao hồ sơ giấy KHTH:
//   - trạng thái KSĐ/GPB (adapter-based, xem lab_result_adapter.js)
//   - checklist hồ sơ giấy + audit lịch sử thay đổi
//   - hạn bàn giao 48 giờ và tô màu cảnh báo
//   - điều kiện "Sẵn sàng nộp"
//
// Tách riêng khỏi server/routes/hchanh.js để có thể unit test độc lập,
// không phụ thuộc session/EMR/express.

'use strict';

const HANDOVER_HOURS = 48;
const WARN_24H_MS = 24 * 60 * 60 * 1000;
const WARN_12H_MS = 12 * 60 * 60 * 1000;

// ── KSĐ / GPB ────────────────────────────────────────────────────────────────

const KSD_GPB_STATUS = Object.freeze({
  NOT_ORDERED: 'NOT_ORDERED',
  PENDING: 'PENDING',
  COMPLETED: 'COMPLETED',
  // Không có trong 3 trạng thái nghiệp vụ theo yêu cầu, nhưng bắt buộc phải có
  // để KHÔNG đánh đồng "chưa đọc được dữ liệu thật" với "Không có chỉ định".
  UNKNOWN: 'UNKNOWN',
});

const KSD_GPB_LABELS = Object.freeze({
  NOT_ORDERED: 'Không có chỉ định',
  PENDING: 'Đã chỉ định, chưa có kết quả',
  COMPLETED: 'Đã có kết quả',
  UNKNOWN: 'Chưa xác định',
});

function ksdGpbInfo(status, extra = {}) {
  const safeStatus = KSD_GPB_STATUS[status] ? status : KSD_GPB_STATUS.UNKNOWN;
  return {
    status: safeStatus,
    label: KSD_GPB_LABELS[safeStatus],
    source: 'not_configured',
    reason: '',
    ...extra,
  };
}

// Chỉ trạng thái PENDING (đã chỉ định, chưa có kết quả) mới bắt buộc ghi note bìa.
// UNKNOWN không ép ghi note vì backend chưa đọc được dữ liệu thật — ép buộc ở đây
// sẽ chặn nộp hồ sơ oan cho toàn bộ trường hợp khi adapter chưa được nối nguồn EMR.
function needsCoverNote(ksdGpb = {}) {
  const ksd = ksdGpb?.ksd || {};
  const gpb = ksdGpb?.gpb || {};
  return ksd.status === KSD_GPB_STATUS.PENDING || gpb.status === KSD_GPB_STATUS.PENDING;
}

// ── Checklist hồ sơ giấy + audit ─────────────────────────────────────────────

const CHECKLIST_BOOLEAN_FIELDS = Object.freeze(['checked', 'doctor_signed', 'nurse_signed', 'head_signed', 'cover_note_done']);
const CHECKLIST_TEXT_FIELDS = Object.freeze(['note', 'checked_by']);
const CHECKLIST_HISTORY_LIMIT = 200;

function emptyChecklist() {
  return {
    checked: false,
    checked_at: null,
    checked_by: '',
    doctor_signed: false,
    nurse_signed: false,
    head_signed: false,
    cover_note_done: false,
    note: '',
    updated_by: '',
    updated_at: null,
    history: [],
  };
}

function normalizeChecklist(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = emptyChecklist();
  for (const field of CHECKLIST_BOOLEAN_FIELDS) out[field] = Boolean(src[field]);
  for (const field of CHECKLIST_TEXT_FIELDS) out[field] = String(src[field] ?? '').slice(0, 1000);
  out.checked_at = src.checked_at || null;
  out.updated_by = String(src.updated_by ?? '').slice(0, 200);
  out.updated_at = src.updated_at || null;
  out.history = Array.isArray(src.history) ? src.history.slice(-CHECKLIST_HISTORY_LIMIT) : [];
  return out;
}

// Áp patch vào checklist hiện tại, sinh lịch sử thay đổi cho từng trường thực sự
// đổi giá trị. Hàm thuần: không đọc/ghi file, để router chịu trách nhiệm persist
// (dùng lại đúng cơ chế lưu index.checked / index.checked_aliases đã có sẵn cho
// dấu "Đã kiểm" — nhờ vậy checklist mới cũng được backup, hồi phục sau quét lại
// EMR/reload giống hệt cơ chế đã chạy ổn định).
function applyChecklistPatch(existingRaw, patch, actor, nowIso) {
  const current = normalizeChecklist(existingRaw);
  const next = { ...current };
  const history = [...current.history];
  const actorName = String(actor || '').trim().slice(0, 200);
  const at = nowIso || new Date().toISOString();
  const safePatch = patch && typeof patch === 'object' ? patch : {};

  for (const field of CHECKLIST_BOOLEAN_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(safePatch, field)) continue;
    const before = current[field];
    const after = Boolean(safePatch[field]);
    if (before === after) continue;
    next[field] = after;
    history.push({ field, from: before, to: after, by: actorName, at });
    if (field === 'checked') {
      next.checked_at = after ? at : null;
      if (after && actorName) next.checked_by = actorName;
      if (!after) next.checked_by = '';
    }
  }
  for (const field of CHECKLIST_TEXT_FIELDS) {
    if (field === 'checked_by') continue; // suy ra từ checked ở trên, không set tay qua patch text
    if (!Object.prototype.hasOwnProperty.call(safePatch, field)) continue;
    const before = current[field];
    const after = String(safePatch[field] ?? '').slice(0, 1000);
    if (before === after) continue;
    next[field] = after;
    history.push({ field, from: before, to: after, by: actorName, at });
  }

  next.updated_by = actorName || current.updated_by;
  next.updated_at = history.length > current.history.length ? at : current.updated_at;
  next.history = history.slice(-CHECKLIST_HISTORY_LIMIT);
  return next;
}

// 7 trạng thái hồ sơ giấy theo đúng yêu cầu nghiệp vụ, ưu tiên theo thứ tự bước
// thực hiện thực tế: kiểm → BS ký → ĐD ký → Trưởng khoa ký → note bìa (nếu nợ).
function paperRecordStatus(checklistRaw, ksdGpb) {
  const checklist = normalizeChecklist(checklistRaw);
  if (!checklist.checked) return { code: 'NOT_CHECKED', label: 'Chưa kiểm', tone: 'gray' };

  const nothingDoneYet = !checklist.doctor_signed && !checklist.nurse_signed
    && !checklist.head_signed && !checklist.cover_note_done;
  if (nothingDoneYet) return { code: 'CHECKING', label: 'Đang kiểm', tone: 'blue' };

  if (!checklist.doctor_signed) return { code: 'MISSING_DOCTOR_SIGN', label: 'Thiếu chữ ký bác sĩ', tone: 'amber' };
  if (!checklist.nurse_signed) return { code: 'MISSING_NURSE_SIGN', label: 'Thiếu chữ ký điều dưỡng', tone: 'amber' };
  if (!checklist.head_signed) return { code: 'WAITING_HEAD_SIGN', label: 'Chờ Trưởng khoa ký', tone: 'amber' };
  if (needsCoverNote(ksdGpb) && !checklist.cover_note_done) {
    return { code: 'MISSING_COVER_NOTE', label: 'Chưa ghi note bìa', tone: 'amber' };
  }
  return { code: 'COMPLETE', label: 'Đã hoàn thiện', tone: 'green' };
}

// ── Hạn bàn giao 48 giờ ──────────────────────────────────────────────────────

function parseIsoMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

function fmtHours(ms) {
  return Math.round(Math.abs(ms) / (60 * 60 * 1000) * 10) / 10;
}

// dischargedAtIso: giờ ra viện dạng ISO đã parse được (hoặc null/rỗng nếu không có).
// dischargeHasTime: true nếu nguồn EMR có giờ thật, false nếu chỉ có ngày (không được
//   tự bịa giờ giả — bài toán 48h khi đó phải hiển thị "chưa xác định chính xác").
function computeHandover({ dischargedAtIso, dischargeHasTime, handedOverAt, nowIso } = {}) {
  const now = parseIsoMs(nowIso) ?? Date.now();
  const dischargedMs = parseIsoMs(dischargedAtIso);

  if (dischargedMs == null) {
    return {
      state: 'not_discharged',
      label: 'Chưa ra viện',
      tone: 'gray',
      discharged_at: null,
      handover_deadline: null,
      handed_over_at: handedOverAt || null,
      remaining_ms: null,
    };
  }

  if (!dischargeHasTime) {
    return {
      state: 'unknown_deadline',
      label: 'Chưa xác định chính xác hạn 48 giờ',
      tone: 'gray',
      discharged_at: new Date(dischargedMs).toISOString(),
      handover_deadline: null,
      handed_over_at: handedOverAt || null,
      remaining_ms: null,
      source_note: 'EMR chỉ trả về ngày ra viện, không có giờ ra viện thật.',
    };
  }

  const deadlineMs = dischargedMs + HANDOVER_HOURS * 60 * 60 * 1000;
  const deadlineIso = new Date(deadlineMs).toISOString();
  const handedOverMs = parseIsoMs(handedOverAt);

  if (handedOverMs != null) {
    const onTime = handedOverMs <= deadlineMs;
    return {
      state: onTime ? 'submitted_on_time' : 'submitted_late',
      label: onTime ? 'Đã nộp đúng hạn' : `Đã nộp trễ ${fmtHours(handedOverMs - deadlineMs)} giờ`,
      tone: onTime ? 'green' : 'red',
      discharged_at: new Date(dischargedMs).toISOString(),
      handover_deadline: deadlineIso,
      handed_over_at: new Date(handedOverMs).toISOString(),
      remaining_ms: deadlineMs - handedOverMs,
      late_hours: onTime ? 0 : fmtHours(handedOverMs - deadlineMs),
    };
  }

  const remainingMs = deadlineMs - now;
  let state = 'normal';
  let label = 'Còn thời gian';
  let tone = 'gray';
  if (remainingMs < 0) {
    state = 'overdue';
    label = `Quá hạn ${fmtHours(remainingMs)} giờ`;
    tone = 'red';
  } else if (remainingMs <= WARN_12H_MS) {
    state = 'due_12h';
    label = `Còn ${fmtHours(remainingMs)} giờ (dưới 12 giờ)`;
    tone = 'orange';
  } else if (remainingMs <= WARN_24H_MS) {
    state = 'due_24h';
    label = `Còn ${fmtHours(remainingMs)} giờ (dưới 24 giờ)`;
    tone = 'amber';
  }

  return {
    state,
    label,
    tone,
    discharged_at: new Date(dischargedMs).toISOString(),
    handover_deadline: deadlineIso,
    handed_over_at: null,
    remaining_ms: remainingMs,
  };
}

// ── Điều kiện "Sẵn sàng nộp" ─────────────────────────────────────────────────

function submissionReadiness({ hasDischargeDate, hasStorage, checklist, ksdGpb } = {}) {
  const cl = normalizeChecklist(checklist);
  const missing = [];
  if (!hasDischargeDate) missing.push('Chưa có ngày ra viện');
  if (!hasStorage) missing.push('Chưa có số lưu trữ');
  if (!cl.checked) missing.push('Chưa kiểm hồ sơ giấy');
  if (!cl.doctor_signed) missing.push('Chưa xác nhận bác sĩ điều trị ký đầy đủ');
  if (!cl.nurse_signed) missing.push('Chưa xác nhận điều dưỡng bệnh phòng ký đầy đủ');
  if (!cl.head_signed) missing.push('Chưa xác nhận Trưởng khoa ký kết thúc điều trị');
  if (needsCoverNote(ksdGpb) && !cl.cover_note_done) missing.push('Còn nợ KSĐ/GPB nhưng chưa xác nhận ghi note ngoài bìa');
  return { ready: missing.length === 0, missing };
}

// Gợi ý nội dung note bìa khi đang nợ KSĐ/GPB — người dùng vẫn phải tự xác nhận
// đã ghi lên bìa giấy thật, đây chỉ là văn bản mẫu để copy/in.
function coverNoteSuggestion(ksdGpb = {}, { nowLabel = '', watcher = '' } = {}) {
  const debts = [];
  if (ksdGpb?.ksd?.status === KSD_GPB_STATUS.PENDING) debts.push('KSĐ');
  if (ksdGpb?.gpb?.status === KSD_GPB_STATUS.PENDING) debts.push('GPB');
  if (!debts.length) return '';
  return `Hồ sơ còn nợ kết quả ${debts.join('/')}. Ngày thực hiện: ${nowLabel || '……………'}. Người theo dõi: ${watcher || '……………'}`;
}

module.exports = {
  HANDOVER_HOURS,
  KSD_GPB_STATUS,
  KSD_GPB_LABELS,
  ksdGpbInfo,
  needsCoverNote,
  emptyChecklist,
  normalizeChecklist,
  applyChecklistPatch,
  paperRecordStatus,
  computeHandover,
  submissionReadiness,
  coverNoteSuggestion,
};
