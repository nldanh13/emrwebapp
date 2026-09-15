// server/services/hchanh/bhyt_pre_audit.js
// Tiền giám định BHYT trước khi nộp hồ sơ — KHÔNG kết luận "xuất toán".
// Trả về: nguy cơ từ chối thanh toán + lý do + khoản tiền có nguy cơ + thứ cần kiểm tra.
//
// Đã cài Tầng 1 (tính toàn vẹn dữ liệu), Tầng 2 (ngày giường), Tầng 3 (chẩn
// đoán ↔ PT/TT), Tầng 4 (CLS chứng minh chỉ định), Tầng 5 (VTYT — hiện là
// placeholder trung thực, xem ghi chú tại runBhytTier5), Tầng 6 (thuốc — cảnh
// báo lâm sàng NEEDS_JUSTIFICATION + CONTRAINDICATED, xem ghi chú tại
// runBhytTier6), Tầng 7 (trùng dịch vụ cùng ngày — phạm vi thu hẹp theo yêu
// cầu, chưa gồm người thực hiện/phạm vi hành nghề) và Tầng 8 (dịch vụ kỹ thuật
// — trùng/cấu phần "trong gói" + bằng chứng liên kết thuốc/vật tư, pilot theo
// ví dụ cụ thể, xem ghi chú tại runBhytTier8). Còn lại: Tầng 5 đủ 7 cửa kiểm
// VTYT thật, Tầng 6 phần cấu trúc thuốc (danh mục/đường dùng/định mức), Tầng 7
// người thực hiện/phạm vi hành nghề, Tầng 8 phần còn lại (2.1-2.5 trong báo
// cáo cảnh báo BHYT nội bộ) — sẽ thêm dần bằng cách bổ sung hàm check + rule
// mới, không đổi khung này.
//
// Nguyên tắc (theo đề xuất thiết kế):
//   - Rule pháp lý (BHYT_RULE) và checklist chuyên môn nội bộ là hai lớp khác nhau.
//   - Không suy đoán khi thiếu dữ liệu ổn định — báo "không đủ dữ liệu", không tự đỏ.
//   - "Số tiền có nguy cơ" là giá trị dịch vụ liên quan cảnh báo, không phải số tiền
//     chắc chắn bị từ chối thanh toán.
//   - Rule nên đọc từ config (config/hchanh/bhyt_pre_audit_rules.json) để có nguồn
//     pháp lý/hành động rõ ràng và có thể cập nhật khi văn bản thay đổi, không sửa code.

'use strict';

const fs   = require('fs');
const path = require('path');

const {
  parseVNDateTime,
  dateOnlyUTC,
  fmtDateUTC,
  fmtDateTimeUTC,
  isBeforeDate,
  dateFromSurgeryRow,
} = require('./vn_datetime');
const { loadQaRules, extractClsFromBilling } = require('./qa_shared');

function safeArray(v)   { return Array.isArray(v) ? v : []; }
function text(v, fb='') { return String(v ?? '').replace(/\s+/g, ' ').trim() || fb; }
function normText(v) {
  return String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/\s+/g, ' ').trim();
}
function moneyNum(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// groups: mảng các NHÓM từ khóa — mỗi nhóm phải khớp ĐỦ mọi từ khóa trong nhóm (AND),
// các nhóm nối với nhau bằng OR. Dùng cho rule cần khớp nhiều từ khóa cùng lúc trong
// tên dịch vụ (vd "ct" + "can quang") mà không thể diễn tả bằng 1 danh sách OR đơn giản.
function matchesKeywordGroups(normalizedText, groups) {
  return safeArray(groups).some(group => safeArray(group).every(k => normalizedText.includes(normText(k))));
}

// ── Thang mức độ (khác severity error/warn/info của QA hành chánh) ─────────────
// INFO < WARNING < REVIEW < HIGH_RISK < BLOCK — không dùng điểm số cộng dồn.

const BHYT_SEVERITY = Object.freeze({
  INFO:      'info',
  WARNING:   'warning',
  REVIEW:    'review',
  HIGH_RISK: 'high_risk',
  BLOCK:     'block',
});

const SEVERITY_RANK = Object.freeze({
  info: 0, warning: 1, review: 2, high_risk: 3, block: 4,
});

// ── Đánh giá tổng ────────────────────────────────────────────────────────────

const ASSESSMENT = Object.freeze({
  SAFE:               { code: 'safe',               label: 'An toàn',                       tone: 'green'  },
  NEEDS_REVIEW:       { code: 'needs_review',        label: 'Cần kiểm tra',                  tone: 'amber'  },
  HIGH_RISK:          { code: 'high_risk',           label: 'Nguy cơ cao',                   tone: 'orange' },
  DO_NOT_SUBMIT:      { code: 'do_not_submit',       label: 'Không nên nộp',                 tone: 'red'    },
  INSUFFICIENT_DATA:  { code: 'insufficient_data',   label: 'Không đủ dữ liệu để đánh giá',  tone: 'gray'   },
});

// ── Rule metadata (nguồn pháp lý, hành động...) — config-driven ────────────────

let _ruleCache = null, _ruleCacheTime = 0;
function loadRuleMeta() {
  const now = Date.now();
  if (_ruleCache && now - _ruleCacheTime < 30000) return _ruleCache;
  try {
    const p = path.join(__dirname, '..', '..', '..', 'config', 'hchanh', 'bhyt_pre_audit_rules.json');
    if (fs.existsSync(p)) {
      _ruleCache = JSON.parse(fs.readFileSync(p, 'utf-8'));
      _ruleCacheTime = now;
      return _ruleCache;
    }
  } catch (e) { console.warn('[BHYT_PRE_AUDIT] Không đọc bhyt_pre_audit_rules.json:', e.message); }
  return { rules: {} };
}

function makeFinding({ rule_id, severity, group, title, detail = '', action = '', amount_at_risk = 0, evidence = '', tier, legal_source, legal_clause }) {
  const meta = loadRuleMeta().rules?.[rule_id] || {};
  return {
    rule_id,
    tier: Number(tier ?? meta.tier ?? 1),
    severity: Object.values(BHYT_SEVERITY).includes(severity) ? severity : BHYT_SEVERITY.REVIEW,
    group: text(group, 'Tiền giám định BHYT'),
    title: text(title),
    detail: text(detail),
    action: text(action || meta.action || 'Kiểm tra lại trên EMR trước khi nộp hồ sơ.'),
    legal_source: text(legal_source ?? meta.legal_source ?? ''),
    legal_clause: text(legal_clause ?? meta.legal_clause ?? ''),
    amount_at_risk: Math.max(0, Math.round(moneyNum(amount_at_risk))),
    evidence: text(evidence),
  };
}

// ── Tầng 1: tính toàn vẹn dữ liệu ───────────────────────────────────────────────

function admissionAndDischargeDates(profile, discharge) {
  const admitAt = parseVNDateTime(profile?.ngay_vao_vien || profile?.ngay_vao || discharge?.ngay_vao);
  const dischargeAt = parseVNDateTime(profile?.ngay_ra_vien || profile?.ngay_ra || discharge?.raw_time || discharge?.ngay_ra);
  return {
    admitAt, dischargeAt,
    admissionDate: dateOnlyUTC(admitAt),
    dischargeDate: dateOnlyUTC(dischargeAt),
  };
}

function checkDischargeBeforeAdmission({ admitAt, dischargeAt }) {
  if (!admitAt || !dischargeAt) return null;
  if (dischargeAt.getTime() >= admitAt.getTime()) return null;
  return makeFinding({
    rule_id: 'BHYT_T1_DISCHARGE_BEFORE_ADMISSION',
    severity: BHYT_SEVERITY.BLOCK,
    group: 'Tính toàn vẹn dữ liệu',
    title: 'Ngày ra viện trước ngày vào viện',
    detail: `Vào viện: ${fmtDateUTC(admitAt)}; Ra viện: ${fmtDateUTC(dischargeAt)}.`,
    action: 'Kiểm tra lại ngày giờ vào/ra viện trên EMR trước khi nộp hồ sơ.',
    evidence: `admission=${fmtDateUTC(admitAt)}, discharge=${fmtDateUTC(dischargeAt)}`,
  });
}

function checkCardValidity({ profile, admissionDate, dischargeDate }) {
  if (!profile) return [];
  if (profile.tu_tuc) return []; // tự túc viện phí, không claim BHYT

  const findings = [];
  const bhytCode = text(profile.bhyt_code);
  if (!bhytCode) {
    findings.push(makeFinding({
      rule_id: 'BHYT_T1_BHYT_CODE_MISSING',
      severity: BHYT_SEVERITY.REVIEW,
      group: 'Thẻ BHYT',
      title: 'Chưa xác định mã thẻ BHYT / đối tượng thanh toán',
      action: 'Kiểm tra thẻ BHYT trên EMR hoặc xác nhận người bệnh tự túc viện phí.',
    }));
    return findings; // không có mã thẻ thì không kiểm tiếp hạn thẻ
  }

  const validFrom = parseVNDateTime(profile.bhyt_tu_ngay);
  const validTo   = parseVNDateTime(profile.bhyt_den_ngay);
  // Không đọc được hạn thẻ trên EMR: không suy đoán thêm, để Tầng khác hoặc người
  // kiểm tự tra cứu trên cổng BHXH/VNeID.
  if (!validFrom && !validTo) return findings;

  if (validTo && dischargeDate && isBeforeDate(validTo, dischargeDate)) {
    findings.push(makeFinding({
      rule_id: 'BHYT_T1_CARD_EXPIRED_BEFORE_DISCHARGE',
      severity: BHYT_SEVERITY.BLOCK,
      group: 'Thẻ BHYT',
      title: 'Thẻ BHYT hết hạn trước ngày ra viện',
      detail: `Thẻ có giá trị đến ${fmtDateUTC(validTo)}; ra viện ${fmtDateUTC(dischargeDate)}.`,
      action: 'Xác minh lại hạn thẻ trên cổng BHXH/VNeID trước khi nộp hồ sơ.',
      evidence: `bhyt_den_ngay=${fmtDateUTC(validTo)}`,
    }));
  }
  if (validFrom && admissionDate && isBeforeDate(admissionDate, validFrom)) {
    findings.push(makeFinding({
      rule_id: 'BHYT_T1_CARD_NOT_YET_VALID_AT_ADMISSION',
      severity: BHYT_SEVERITY.BLOCK,
      group: 'Thẻ BHYT',
      title: 'Thẻ BHYT chưa có hiệu lực tại ngày vào viện',
      detail: `Thẻ có giá trị từ ${fmtDateUTC(validFrom)}; vào viện ${fmtDateUTC(admissionDate)}.`,
      action: 'Xác minh lại hiệu lực thẻ trên cổng BHXH/VNeID trước khi nộp hồ sơ.',
      evidence: `bhyt_tu_ngay=${fmtDateUTC(validFrom)}`,
    }));
  }
  return findings;
}

function checkServiceDatesWithinStay(billing, { admissionDate, dischargeDate }) {
  if (!billing || !admissionDate || !dischargeDate) return [];
  const beforeRows = [];
  const afterRows = [];
  for (const r of safeArray(billing.rows)) {
    const d = parseVNDateTime(r?.tg_ylenh);
    if (!d) continue;
    const dateOnly = dateOnlyUTC(d);
    if (isBeforeDate(dateOnly, admissionDate)) beforeRows.push(r);
    else if (isBeforeDate(dischargeDate, dateOnly)) afterRows.push(r);
  }

  const findings = [];
  const bhytAmount = rows => rows.reduce((s, r) => s + (r.payment_group === 'bhyt' ? moneyNum(r.thanh_tien) : 0), 0);

  if (beforeRows.length) {
    findings.push(makeFinding({
      rule_id: 'BHYT_T1_SERVICE_DATE_BEFORE_ADMISSION',
      severity: BHYT_SEVERITY.BLOCK,
      group: 'Thời gian dịch vụ',
      title: `${beforeRows.length} dòng bảng kê có ngày thực hiện trước ngày vào viện`,
      detail: beforeRows.slice(0, 5).map(r => `${text(r.name)} (${text(r.tg_ylenh)})`).join('; '),
      action: 'Kiểm tra lại ngày thực hiện dịch vụ hoặc ngày vào viện trên EMR.',
      amount_at_risk: bhytAmount(beforeRows),
      evidence: `count=${beforeRows.length}`,
    }));
  }
  if (afterRows.length) {
    findings.push(makeFinding({
      rule_id: 'BHYT_T1_SERVICE_DATE_AFTER_DISCHARGE',
      severity: BHYT_SEVERITY.BLOCK,
      group: 'Thời gian dịch vụ',
      title: `${afterRows.length} dòng bảng kê có ngày thực hiện sau ngày ra viện`,
      detail: afterRows.slice(0, 5).map(r => `${text(r.name)} (${text(r.tg_ylenh)})`).join('; '),
      action: 'Kiểm tra lại ngày thực hiện dịch vụ hoặc ngày ra viện trên EMR.',
      amount_at_risk: bhytAmount(afterRows),
      evidence: `count=${afterRows.length}`,
    }));
  }
  return findings;
}

function checkPrimaryDiagnosis(discharge) {
  if (!discharge) return null; // QA hành chánh đã báo riêng việc chưa lấy dữ liệu ra viện
  const cd = text(discharge.chan_doan_chinh || discharge.chan_doan_ra);
  if (cd) return null;
  return makeFinding({
    rule_id: 'BHYT_T1_PRIMARY_DIAGNOSIS_MISSING',
    severity: BHYT_SEVERITY.BLOCK,
    group: 'Chẩn đoán',
    title: 'Chưa có chẩn đoán chính ra viện',
    action: 'Bác sĩ bổ sung chẩn đoán chính ICD-10 trước khi nộp hồ sơ.',
  });
}

// Xung đột trình tự thời gian (mục 3 trong báo cáo cảnh báo BHYT nội bộ): một chi
// phí đúng chuyên môn vẫn có thể bị loại nếu trình tự thời gian không hợp lý — ở đây
// chỉ làm phần có dữ liệu sẵn (giờ bắt đầu/kết thúc phẫu thuật đã fetch được từ form
// chi tiết PT, xem worker/hchanh_fetch.py txtBatDauPT/txtKetThucPT). Các mốc khác
// trong báo cáo (thuốc trước y lệnh, kết quả XN trước khi lấy mẫu...) cần 2 mốc thời
// gian riêng biệt của cùng 1 sự việc mà dữ liệu hiện tại chưa có — không suy đoán.
function checkSurgeryTimeSequence(surgery) {
  const rows = safeArray(surgery?.surgeries);
  if (!rows.length) return null;
  const invalid = [];
  for (const row of rows) {
    const start = parseVNDateTime(row?.bat_dau || row?.detail?.bat_dau);
    const end = parseVNDateTime(row?.ket_thuc || row?.detail?.ket_thuc);
    if (!start || !end) continue; // thiếu 1 trong 2 mốc thì không suy đoán
    if (end.getTime() < start.getTime()) invalid.push({ row, start, end });
  }
  if (!invalid.length) return null;
  return makeFinding({
    rule_id: 'BHYT_T1_SURGERY_TIME_SEQUENCE_INVALID',
    severity: BHYT_SEVERITY.BLOCK,
    group: 'Trình tự thời gian',
    title: `${invalid.length} phẫu thuật/thủ thuật có giờ kết thúc trước giờ bắt đầu`,
    detail: invalid.slice(0, 5).map(x => `${text(surgeryRowText(x.row), 'PT/TT')}: bắt đầu ${fmtDateTimeUTC(x.start)}, kết thúc ${fmtDateTimeUTC(x.end)}`).join('; '),
    action: 'Kiểm tra lại giờ bắt đầu/kết thúc trên biên bản phẫu thuật trên EMR trước khi nộp hồ sơ.',
    evidence: `count=${invalid.length}`,
  });
}

function checkSurgeryDates(surgery) {
  const rows = safeArray(surgery?.surgeries);
  if (!rows.length) return null;
  const missing = rows.filter(r => !dateFromSurgeryRow(r));
  if (!missing.length) return null;
  return makeFinding({
    rule_id: 'BHYT_T1_SURGERY_DATE_MISSING',
    severity: BHYT_SEVERITY.BLOCK,
    group: 'Phẫu thuật/thủ thuật',
    title: `${missing.length} phẫu thuật/thủ thuật chưa xác định được ngày thực hiện`,
    detail: missing.slice(0, 5).map(r => text(r.ten || r.name || r.ten_pt, 'PT/TT chưa rõ tên')).join('; '),
    action: 'Bác sĩ bổ sung ngày giờ thực hiện phẫu thuật/thủ thuật trên EMR.',
  });
}

function checkBenefitLevelConsistency(billing) {
  if (!billing) return null;
  const levels = new Set();
  let bhytTotal = 0;
  for (const r of safeArray(billing.rows)) {
    if (r?.payment_group !== 'bhyt') continue;
    bhytTotal += moneyNum(r.thanh_tien);
    const mh = text(r.muc_huong);
    if (mh) levels.add(mh);
  }
  if (levels.size <= 1) return null;
  return makeFinding({
    rule_id: 'BHYT_T1_BENEFIT_LEVEL_INCONSISTENT',
    severity: BHYT_SEVERITY.REVIEW,
    group: 'Mức hưởng BHYT',
    title: `Bảng kê có ${levels.size} mức hưởng BHYT khác nhau trong cùng đợt điều trị`,
    detail: `Các mức: ${[...levels].join(', ')}.`,
    action: 'Kiểm tra lại mức hưởng áp dụng cho từng dòng — có thể do đổi thẻ/đối tượng giữa đợt.',
    amount_at_risk: bhytTotal,
  });
}

function runBhytTier1({ profile, discharge, billing, surgery, admitAt, dischargeAt, admissionDate, dischargeDate }) {
  const findings = [];

  const f1 = checkDischargeBeforeAdmission({ admitAt, dischargeAt });
  if (f1) findings.push(f1);

  findings.push(...checkCardValidity({ profile, admissionDate, dischargeDate }));
  findings.push(...checkServiceDatesWithinStay(billing, { admissionDate, dischargeDate }));

  const f2 = checkPrimaryDiagnosis(discharge);
  if (f2) findings.push(f2);

  const f3 = checkSurgeryDates(surgery);
  if (f3) findings.push(f3);

  const f3b = checkSurgeryTimeSequence(surgery);
  if (f3b) findings.push(f3b);

  const f4 = checkBenefitLevelConsistency(billing);
  if (f4) findings.push(f4);

  return findings;
}

// ── Tầng 2: ngày giường ──────────────────────────────────────────────────────
// Không tính lại ngày giường từ đầu — dùng lại kết quả buildBedDaysReview() đã
// tính trong discharge_qa.js (truyền vào qua tham số bedDaysReview) để tránh hai
// nơi tính ra hai con số khác nhau. Tầng này chỉ diễn giải kết quả đó dưới góc độ
// nguy cơ BHYT, và bổ sung rule chưa có (nằm ≤4 giờ).

function hoursBetween(a, b) {
  if (!(a instanceof Date) || !(b instanceof Date)) return null;
  return (b.getTime() - a.getTime()) / 3600000;
}

function checkShortStayBedCharged({ admitAt, dischargeAt, bed_days }) {
  const hours = hoursBetween(admitAt, dischargeAt);
  if (hours === null || hours > 4) return null;
  const billedDays = Number(bed_days?.so_ngay_tinh || 0);
  if (billedDays <= 0) return null;
  return makeFinding({
    rule_id: 'BHYT_T2_SHORT_STAY_BED_CHARGED',
    severity: BHYT_SEVERITY.HIGH_RISK,
    group: 'Ngày giường',
    title: `Người bệnh nằm ${hours.toFixed(1)} giờ (≤4 giờ) nhưng vẫn tính ${billedDays} ngày giường`,
    detail: `Vào viện ${fmtDateTimeUTC(admitAt)}; ra viện ${fmtDateTimeUTC(dischargeAt)}.`,
    action: 'Kiểm tra điều kiện tính ngày giường cho trường hợp nằm dưới 4 giờ theo hướng dẫn giá dịch vụ ngày giường bệnh hiện hành, trừ khi thuộc diện tử vong/chuyển viện cấp cứu.',
    evidence: `duration_hours=${hours.toFixed(2)}, billed_days=${billedDays}`,
  });
}

function checkBedDaysOverExpected({ admitAt, dischargeAt, bedDaysReview }) {
  if (!bedDaysReview || bedDaysReview.status !== 'mismatch') return null;
  const expected = Number(bedDaysReview.expected_total || 0);
  const actual   = Number(bedDaysReview.actual_total || 0);
  // Chỉ quan tâm hướng TÍNH THỪA (nguy cơ BHYT phải trả nhiều hơn). Tính thiếu là
  // vấn đề hoàn thiện hồ sơ/doanh thu của bệnh viện, đã được QA hành chánh báo riêng.
  if (actual <= expected) return null;

  // Ngoại lệ 4–24 giờ: một số hướng dẫn cho phép tính 1 ngày giường dù công thức
  // theo ngày lịch (ra - vào) ra 0 ngày cho trường hợp vào/ra cùng ngày. Không báo
  // nguy cơ cho đúng trường hợp này để tránh cảnh báo sai.
  const hours = hoursBetween(admitAt, dischargeAt);
  if (expected === 0 && actual === 1 && hours !== null && hours > 4 && hours < 24) return null;

  const diffAmount = Number(bedDaysReview.amount?.diff);
  return makeFinding({
    rule_id: 'BHYT_T2_BED_DAYS_OVER_EXPECTED',
    severity: BHYT_SEVERITY.HIGH_RISK,
    group: 'Ngày giường',
    title: `Số ngày giường tính (${actual}) nhiều hơn số ngày dự kiến theo thời gian điều trị (${expected})`,
    detail: safeArray(bedDaysReview.suggestions).slice(0, 3).join(' '),
    action: 'Mở Buồng giường → Sửa thông tin, tách/đổi loại giường theo gợi ý từng khoảng ngày trước khi nộp hồ sơ.',
    amount_at_risk: Number.isFinite(diffAmount) && diffAmount > 0 ? diffAmount : 0,
    evidence: `expected=${expected}, actual=${actual}`,
  });
}

function runBhytTier2({ admitAt, dischargeAt, bed_days, bedDaysReview }) {
  const findings = [];

  const f1 = checkShortStayBedCharged({ admitAt, dischargeAt, bed_days });
  if (f1) findings.push(f1);

  const f2 = checkBedDaysOverExpected({ admitAt, dischargeAt, bedDaysReview });
  if (f2) findings.push(f2);

  return findings;
}

// ── Tầng 3: chẩn đoán ↔ PT/TT ────────────────────────────────────────────────
// 3 mức COMPATIBLE / REVIEW / INCOMPATIBLE thay vì quy định cứng "chẩn đoán X chỉ
// được PT Y". Chỉ khai báo cho các PT/TT mà đề xuất thiết kế đã nêu ICD cụ thể —
// không suy đoán mã ICD cho các PT/TT khác khi chưa có nguồn xác nhận.

let _dxProcCache = null, _dxProcCacheTime = 0;
function loadDxProcedureMap() {
  const now = Date.now();
  if (_dxProcCache && now - _dxProcCacheTime < 30000) return _dxProcCache;
  try {
    const p = path.join(__dirname, '..', '..', '..', 'config', 'hchanh', 'bhyt_dx_procedure_map.json');
    if (fs.existsSync(p)) {
      _dxProcCache = JSON.parse(fs.readFileSync(p, 'utf-8'));
      _dxProcCacheTime = now;
      return _dxProcCache;
    }
  } catch (e) { console.warn('[BHYT_PRE_AUDIT] Không đọc bhyt_dx_procedure_map.json:', e.message); }
  return { procedures: [], implant_removal: null };
}

function surgeryRowText(row) {
  return text(row?.ten || row?.name || row?.ten_pt || row?.dich_vu_phau_thuat || row?.phuong_phap_pt);
}

function icdMatchesAnyPrefix(icd, prefixes) {
  const norm = String(icd || '').toUpperCase().replace(/\s+/g, '');
  if (!norm) return false;
  return safeArray(prefixes).some(p => norm.startsWith(String(p).toUpperCase()));
}

function checkDiagnosisProcedureCompatibility({ discharge, surgery }) {
  const rows = safeArray(surgery?.surgeries);
  if (!rows.length) return [];
  const icd = text(discharge?.chan_doan_chinh_icd);
  if (!icd) return []; // chưa tách được mã ICD từ chẩn đoán chính -> không suy đoán

  const map = loadDxProcedureMap();
  const findings = [];
  for (const row of rows) {
    const rowText = normText(surgeryRowText(row));
    if (!rowText) continue;
    const proc = safeArray(map.procedures).find(p => safeArray(p.match_keywords).some(k => rowText.includes(normText(k))));
    if (!proc) continue; // PT/TT chưa có trong bảng đối chiếu -> không đánh giá, tránh suy đoán

    if (icdMatchesAnyPrefix(icd, proc.compatible_icd_prefixes)) continue; // COMPATIBLE

    if (icdMatchesAnyPrefix(icd, proc.incompatible_icd_prefixes)) {
      findings.push(makeFinding({
        rule_id: 'BHYT_T3_DX_PROCEDURE_INCOMPATIBLE',
        severity: BHYT_SEVERITY.HIGH_RISK,
        group: 'Chẩn đoán ↔ PT/TT',
        title: `Chẩn đoán chính (${icd}) không thuộc nhóm liên quan tới "${text(proc.label, surgeryRowText(row))}"`,
        detail: text(proc.incompatible_message),
        action: 'Bác sĩ kiểm tra lại chẩn đoán chính hoặc chỉ định phẫu thuật/thủ thuật có đúng người bệnh, đúng đợt không.',
        evidence: `icd=${icd}, procedure=${surgeryRowText(row)}`,
      }));
      continue;
    }

    // Không rơi vào nhóm phù hợp lẫn không liên quan -> cần kiểm thêm, không tự đỏ.
    findings.push(makeFinding({
      rule_id: 'BHYT_T3_DX_PROCEDURE_NEEDS_REVIEW',
      severity: BHYT_SEVERITY.REVIEW,
      group: 'Chẩn đoán ↔ PT/TT',
      title: `Chẩn đoán chính (${icd}) chưa khớp rõ với chỉ định "${text(proc.label, surgeryRowText(row))}"`,
      detail: text(proc.review_message),
      action: 'Kiểm tra lại chẩn đoán chính có mô tả đúng lý do chỉ định phẫu thuật/thủ thuật không.',
      evidence: `icd=${icd}, procedure=${surgeryRowText(row)}`,
    }));
  }
  return findings;
}

function checkImplantRemovalEvidence({ discharge, surgery, billing }) {
  const cfg = loadDxProcedureMap().implant_removal;
  if (!cfg) return null;
  const rows = safeArray(surgery?.surgeries);
  const matched = rows.some(row => safeArray(cfg.match_keywords).some(k => normText(surgeryRowText(row)).includes(normText(k))));
  if (!matched) return null;

  const icd = text(discharge?.chan_doan_chinh_icd);
  if (icdMatchesAnyPrefix(icd, cfg.diagnosis_downgrade_icd_prefixes)) return null; // đã có chẩn đoán xác nhận liền xương

  const clsText = normText(safeArray(billing?.rows).map(r => r?.name || '').join(' '));
  const hasClsEvidence = safeArray(cfg.downgrade_cls_keywords).some(k => clsText.includes(normText(k)));
  if (hasClsEvidence) return null; // có X-quang kiểm tra trong bảng kê

  return makeFinding({
    rule_id: 'BHYT_T3_IMPLANT_REMOVAL_NEEDS_EVIDENCE',
    severity: BHYT_SEVERITY.HIGH_RISK,
    group: 'Chẩn đoán ↔ PT/TT',
    title: 'Có chỉ định tháo phương tiện kết hợp xương nhưng chưa thấy bằng chứng liền xương',
    detail: text(cfg.review_message),
    action: 'Kiểm tra XQ liền xương gần nhất và chẩn đoán tình trạng liền xương trước khi nộp hồ sơ.',
    evidence: `icd=${icd || 'khong_ro'}`,
  });
}

function runBhytTier3({ discharge, surgery, billing }) {
  const findings = [];
  findings.push(...checkDiagnosisProcedureCompatibility({ discharge, surgery }));
  const f = checkImplantRemovalEvidence({ discharge, surgery, billing });
  if (f) findings.push(f);
  return findings;
}

// ── Tầng 4: CLS chứng minh chỉ định ──────────────────────────────────────────
// Tái dùng cấu hình `specialty_rules` đã có trong config/hchanh/qa_rules.json
// (QA hành chánh) — không định nghĩa lại danh mục CLS kỳ vọng ở đây để tránh
// hai nơi lệch nhau khi có người sửa qa_rules.json. Chỉ lấy các rule chuyên
// khoa có `required_cls_keywords` (bằng chứng CLS/biên bản cho một chỉ định);
// rule có `required_supply_keywords` (VTYT) để dành cho Tầng 5.

function checkClsExpectedEvidence({ profile, discharge, billing }) {
  const rules = loadQaRules();
  const specialty_cfg = rules.specialty_rules || {};
  const dept_text = normText([profile?.khoa, discharge?.chan_doan_chinh].join(' '));
  const dx_text = normText([
    discharge?.chan_doan_chinh,
    ...safeArray(discharge?.benh_kem),
    ...safeArray(discharge?.chan_doan_vao_list).map(c => c?.ten || ''),
  ].join(' '));
  const cls_rows = extractClsFromBilling(billing);
  const cls_bhyt_text = cls_rows.filter(r => r.pg === 'bhyt').map(r => normText(r.name)).join(' ');

  const findings = [];
  for (const [, spec] of Object.entries(specialty_cfg)) {
    if (!spec.enabled) continue;
    const dept_match = safeArray(spec.dept_keywords).some(k => dept_text.includes(normText(k)));
    if (!dept_match) continue;

    for (const rule of safeArray(spec.rules)) {
      if (!rule.enabled || !rule.required_cls_keywords) continue; // chỉ CLS, VTYT thuộc Tầng 5
      const has_dx = safeArray(rule.dx_keywords).some(k => dx_text.includes(normText(k)));
      if (!has_dx) continue;
      const has_cls = safeArray(rule.required_cls_keywords).some(k => cls_bhyt_text.includes(normText(k)));
      if (has_cls) continue;

      findings.push(makeFinding({
        rule_id: `BHYT_T4_${rule.code}`,
        tier: 4,
        severity: rule.severity === 'error' ? BHYT_SEVERITY.HIGH_RISK : BHYT_SEVERITY.REVIEW,
        group: 'CLS chứng minh chỉ định',
        title: text(rule.title),
        detail: text(rule.detail),
        action: text(rule.action || 'Kiểm tra lại CLS/biên bản chứng minh chỉ định trước khi nộp hồ sơ.'),
        legal_source: 'Checklist chuyên môn nội bộ (config/hchanh/qa_rules.json → specialty_rules)',
        legal_clause: 'Không phải rule pháp lý bắt buộc — đối chiếu CLS/biên bản với chỉ định theo cấu hình chuyên khoa nội bộ, cần người kiểm xác nhận.',
        evidence: `dept_rule=${rule.code}`,
      }));
    }
  }
  return findings;
}

function runBhytTier4({ profile, discharge, billing }) {
  return checkClsExpectedEvidence({ profile, discharge, billing });
}

// ── Tầng 5: VTYT — placeholder trung thực ───────────────────────────────────
// Đề xuất gốc yêu cầu 7 cửa kiểm cho VTYT (mã hợp lệ, trong danh mục BHXH,
// hiệu lực, phạm vi BHYT, trần thanh toán, số lượng khớp biên bản PT, không
// trùng giá DVKT). Hệ thống HIỆN KHÔNG có: danh mục VTYT do BHXH duyệt kèm hạn
// hiệu lực, bảng trần thanh toán theo mã VTYT, hay số liệu vật tư sử dụng thực
// tế trong biên bản PT (dữ liệu `surgery` chỉ lưu ngày/phân loại PT, không lưu
// vật tư tiêu hao). `config/vtyt_dictionary.json` chỉ là danh mục nội bộ nhỏ
// (8 mã, khoa CTCH/TK) dùng để TỰ ĐỘNG NHẬP VTYT, không phải danh mục BHXH đầy
// đủ — không đủ căn cứ để kết luận "hợp lệ/không hợp lệ".
//
// Vì vậy Tầng 5 KHÔNG tự đoán đúng/sai (giống lab_result_adapter.js trả
// UNKNOWN thay vì suy đoán). Chỉ khoanh vùng: có dòng VTYT thanh toán BHYT
// trong bảng kê nhưng CHƯA có nguồn đối chiếu — cần người kiểm tra thủ công.

let _vtytCatalogNamesCache = null, _vtytCatalogNamesCacheTime = 0;
function loadVtytCatalogNames() {
  const now = Date.now();
  if (_vtytCatalogNamesCache && now - _vtytCatalogNamesCacheTime < 30000) return _vtytCatalogNamesCache;
  try {
    const p = path.join(__dirname, '..', '..', '..', 'config', 'vtyt_dictionary.json');
    if (fs.existsSync(p)) {
      const dict = JSON.parse(fs.readFileSync(p, 'utf-8'));
      const names = [];
      for (const [key, item] of Object.entries(dict.catalog || {})) {
        if (key === '_comment' || !item) continue;
        for (const k of [item.searchKeyword, item.name, ...safeArray(item.aliases)]) {
          const n = normText(k);
          if (n) names.push(n);
        }
      }
      _vtytCatalogNamesCache = names;
      _vtytCatalogNamesCacheTime = now;
      return _vtytCatalogNamesCache;
    }
  } catch (e) { console.warn('[BHYT_PRE_AUDIT] Không đọc vtyt_dictionary.json:', e.message); }
  return [];
}

function isKnownVtytLine(rowName) {
  const n = normText(rowName);
  if (!n) return false;
  return loadVtytCatalogNames().some(k => k && n.includes(k));
}

function checkVtytUnverifiable({ billing }) {
  const rows = safeArray(billing?.rows).filter(r => r?.payment_group === 'bhyt' && isKnownVtytLine(r?.name));
  if (!rows.length) return null;

  const totalAmount = rows.reduce((s, r) => s + moneyNum(r.thanh_tien), 0);
  return makeFinding({
    rule_id: 'BHYT_T5_VTYT_UNVERIFIABLE',
    severity: BHYT_SEVERITY.INFO,
    group: 'VTYT',
    title: `${rows.length} dòng VTYT thanh toán BHYT chưa đối chiếu được`,
    detail: `Danh sách: ${rows.slice(0, 5).map(r => text(r.name)).join('; ')}${rows.length > 5 ? `; +${rows.length - 5} dòng khác` : ''}.`,
    action: 'Đối chiếu thủ công: mã VTYT còn hiệu lực, đúng danh mục BV đã đăng ký với BHXH, số lượng khớp biên bản PT, và không trùng với vật tư đã tính trong giá DVKT.',
    amount_at_risk: totalAmount,
    evidence: `count=${rows.length}`,
  });
}

function runBhytTier5({ billing }) {
  const f = checkVtytUnverifiable({ billing });
  return f ? [f] : [];
}

// ── Tầng 6: Thuốc — cảnh báo lâm sàng (diagnosis_support) ───────────────────
// Đề xuất gốc: không tự quyết định thuốc hợp/không hợp; kiểm cấu trúc trước
// (danh mục, đường dùng, thời gian, số lượng...) rồi mới đến cảnh báo lâm sàng.
// Hệ thống hiện KHÔNG có danh mục thuốc BHYT/đường dùng/định mức số lượng để
// làm phần cấu trúc đó (cùng khoảng trống dữ liệu như Tầng 5). "Không dùng
// thuốc sau ra viện" đã được Tầng 1 (BHYT_T1_SERVICE_DATE_AFTER_DISCHARGE, áp
// dụng cho mọi dòng bảng kê) và QA hành chánh (ORDER_AFTER_DISCHARGE) bao phủ
// chung, không lặp lại ở đây. "Trùng đơn bất thường" đã được Tầng 7 bao phủ
// chung cho mọi dịch vụ (không riêng thuốc).
//
// Phần duy nhất Tầng 6 làm: cảnh báo lâm sàng — kháng sinh phổ rộng thanh toán
// BHYT nhưng chưa thấy chẩn đoán nhiễm khuẩn phù hợp. Dùng lại chính danh mục
// kháng sinh đã có trong config/hchanh/qa_rules.json (cls_diagnosis_rules →
// CLS_ANTIBIOTIC_NO_INFECTION_DX, đã được đội ngũ xác nhận trước đó) — sao
// chép sang config/hchanh/bhyt_drug_rules.json để quét trực tiếp trên MỌI dòng
// bảng kê BHYT (rule gốc chỉ quét dòng CLS/xét nghiệm nên gần như không khớp
// dòng thuốc thật). Mức độ REVIEW, không tự đỏ — đúng CLINICAL_JUSTIFICATION_
// REQUIRED trong đề xuất gốc.

let _drugRulesCache = null, _drugRulesCacheTime = 0;
function loadDrugRules() {
  const now = Date.now();
  if (_drugRulesCache && now - _drugRulesCacheTime < 30000) return _drugRulesCache;
  try {
    const p = path.join(__dirname, '..', '..', '..', 'config', 'hchanh', 'bhyt_drug_rules.json');
    if (fs.existsSync(p)) {
      _drugRulesCache = JSON.parse(fs.readFileSync(p, 'utf-8'));
      _drugRulesCacheTime = now;
      return _drugRulesCache;
    }
  } catch (e) { console.warn('[BHYT_PRE_AUDIT] Không đọc bhyt_drug_rules.json:', e.message); }
  return { drug_diagnosis_rules: [] };
}

// Dùng chung cho cả rule "cần chẩn đoán hỗ trợ" và rule "chống chỉ định" — cùng một
// nguồn text chẩn đoán (chính + ra viện + bệnh kèm + chẩn đoán vào), vì cả hai đều
// chỉ so khớp từ khóa/mã ICD dạng chuỗi con trên text tự do (đã có mã ICD nhúng sẵn
// dạng "(I74.3)" trong chẩn đoán EMR thực tế), không tách ICD có cấu trúc.
function buildDischargeDxText(discharge) {
  return normText([
    discharge?.chan_doan_chinh,
    discharge?.chan_doan_ra,
    ...safeArray(discharge?.benh_kem),
    ...safeArray(discharge?.chan_doan_vao_list).map(c => c?.ten || ''),
  ].join(' '));
}

function checkDrugDiagnosisSupport({ discharge, billing }) {
  if (!billing || !discharge) return [];
  const rules = safeArray(loadDrugRules().drug_diagnosis_rules).filter(r => r?.enabled !== false);
  if (!rules.length) return [];

  const bhytRows = safeArray(billing.rows).filter(r => r?.payment_group === 'bhyt');
  const dxText = buildDischargeDxText(discharge);

  const findings = [];
  for (const rule of rules) {
    const matchedRows = bhytRows.filter(r => safeArray(rule.drug_keywords).some(k => normText(r.name).includes(normText(k))));
    if (!matchedRows.length) continue;
    const hasDx = safeArray(rule.dx_keywords).some(k => dxText.includes(normText(k)));
    if (hasDx) continue;

    const amount = matchedRows.reduce((s, r) => s + moneyNum(r.thanh_tien), 0);
    findings.push(makeFinding({
      rule_id: `BHYT_T6_${rule.code}`,
      tier: 6,
      severity: BHYT_SEVERITY.REVIEW,
      group: 'Thuốc',
      title: text(rule.title),
      detail: `${text(rule.detail)} Thuốc trong bảng kê: ${matchedRows.slice(0, 3).map(r => text(r.name)).join('; ')}${matchedRows.length > 3 ? `; +${matchedRows.length - 3} dòng khác` : ''}.`,
      action: text(rule.action || 'Bác sĩ bổ sung chẩn đoán phù hợp trước khi nộp hồ sơ.'),
      legal_source: 'Checklist chuyên môn nội bộ (config/hchanh/bhyt_drug_rules.json)',
      legal_clause: 'Không phải rule pháp lý bắt buộc — cảnh báo cần giải trình lâm sàng (clinical justification), không tự kết luận sai.',
      amount_at_risk: amount,
      evidence: `drug_rule=${rule.code}, count=${matchedRows.length}`,
    }));
  }
  return findings;
}

// Ngược hướng với checkDrugDiagnosisSupport: không phải "thiếu chẩn đoán hỗ trợ" mà
// là "CÓ chẩn đoán/bệnh nền thuộc nhóm chống chỉ định" (vd diclofenac + bệnh tim thiếu
// máu cục bộ). Mức HIGH_RISK (không BLOCK) — chỉ cảnh báo để bác sĩ tự xác nhận,
// không tự động khóa đơn thuốc.
function checkDrugContraindication({ discharge, billing }) {
  if (!billing || !discharge) return [];
  const rules = safeArray(loadDrugRules().drug_contraindication_rules).filter(r => r?.enabled !== false);
  if (!rules.length) return [];

  const bhytRows = safeArray(billing.rows).filter(r => r?.payment_group === 'bhyt');
  const dxText = buildDischargeDxText(discharge);

  const findings = [];
  for (const rule of rules) {
    const matchedRows = bhytRows.filter(r => safeArray(rule.drug_keywords).some(k => normText(r.name).includes(normText(k))));
    if (!matchedRows.length) continue;
    const hasContraindication = safeArray(rule.contraindication_dx_keywords).some(k => dxText.includes(normText(k)));
    if (!hasContraindication) continue;

    const amount = matchedRows.reduce((s, r) => s + moneyNum(r.thanh_tien), 0);
    findings.push(makeFinding({
      rule_id: `BHYT_T6_${rule.code}`,
      tier: 6,
      severity: BHYT_SEVERITY.HIGH_RISK,
      group: 'Thuốc',
      title: text(rule.title),
      detail: `${text(rule.detail)} Thuốc trong bảng kê: ${matchedRows.slice(0, 3).map(r => text(r.name)).join('; ')}${matchedRows.length > 3 ? `; +${matchedRows.length - 3} dòng khác` : ''}.`,
      action: text(rule.action || 'Bác sĩ xác nhận lại chỉ định/chống chỉ định trước khi nộp hồ sơ.'),
      legal_source: 'Checklist chuyên môn nội bộ (config/hchanh/bhyt_drug_rules.json → drug_contraindication_rules)',
      legal_clause: 'Không phải rule pháp lý bắt buộc — cảnh báo chống chỉ định cần bác sĩ xác nhận, không tự kết luận sai.',
      amount_at_risk: amount,
      evidence: `drug_rule=${rule.code}, count=${matchedRows.length}`,
    }));
  }
  return findings;
}

function runBhytTier6({ discharge, billing }) {
  return [
    ...checkDrugDiagnosisSupport({ discharge, billing }),
    ...checkDrugContraindication({ discharge, billing }),
  ];
}

// ── Tầng 7: Trùng dịch vụ ────────────────────────────────────────────────────
// Phạm vi HIỆN TẠI (theo yêu cầu): chỉ kiểm trùng dịch vụ cùng ngày. Người thực
// hiện/phạm vi hành nghề và rule "trong gói" CHƯA làm — bổ sung sau khi có yêu
// cầu cụ thể, không phải do thiếu dữ liệu.
//
// Dữ liệu billing không có mã số chỉ định (số phiếu y lệnh) riêng cho từng
// dòng — chỉ có `tg_ylenh` (thời gian y lệnh). "Hai chỉ định khác nhau" được
// suy ra từ việc có ≥2 DÒNG BẢNG KÊ riêng biệt cho cùng một dịch vụ trong cùng
// một ngày (một chỉ định số lượng >1 thường gộp vào một dòng có `sl` > 1, ít
// khi tách dòng) — đây là suy luận có giới hạn, luôn nêu rõ trong finding.
// Loại trừ dòng ngày giường (đã có Tầng 2 xử lý riêng, lặp nhiều dòng/ngày là
// bình thường với tiền giường, không phải trùng dịch vụ).

function isBedDayRow(row) {
  const blob = normText([row?.loai_yc, row?.name].filter(Boolean).join(' '));
  return blob.includes('ngay giuong');
}

function serviceKey(row) {
  const ma = text(row?.ma_dv);
  if (ma) return `code:${ma}`;
  return `name:${normText(row?.name)}`;
}

function checkDuplicateServiceSameDay({ billing }) {
  const rows = safeArray(billing?.rows).filter(r => r?.payment_group === 'bhyt' && !isBedDayRow(r));
  const groups = new Map();
  for (const row of rows) {
    const at = parseVNDateTime(row?.tg_ylenh);
    const dateOnly = dateOnlyUTC(at);
    if (!dateOnly) continue; // không xác định được ngày thực hiện thì không suy đoán trùng
    const key = `${serviceKey(row)}|${dateOnly.getTime()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ row, at });
  }

  const findings = [];
  for (const entries of groups.values()) {
    if (entries.length < 2) continue;
    entries.sort((a, b) => a.at.getTime() - b.at.getTime());
    const [first, ...rest] = entries;
    const amount = rest.reduce((s, e) => s + moneyNum(e.row.thanh_tien), 0);
    const name = text(first.row.name, 'Dịch vụ');
    findings.push(makeFinding({
      rule_id: 'BHYT_T7_DUPLICATE_SERVICE_SAME_DAY',
      severity: BHYT_SEVERITY.REVIEW,
      group: 'Trùng dịch vụ',
      title: `"${name}" xuất hiện ${entries.length} lần trong bảng kê BHYT cùng ngày ${fmtDateUTC(first.at)}`,
      detail: `Các lần: ${entries.map(e => fmtDateTimeUTC(e.at)).join('; ')}. Suy ra từ việc có nhiều dòng bảng kê riêng biệt cho cùng dịch vụ trong ngày — chưa xác nhận có đúng từ 2 chỉ định độc lập hay không.`,
      action: 'Kiểm tra lại có đúng 2 chỉ định độc lập (ví dụ trước và sau can thiệp) hay bị nhập trùng/tách dòng nhầm.',
      amount_at_risk: amount,
      evidence: `service=${name}, count=${entries.length}, date=${fmtDateUTC(first.at)}`,
    }));
  }
  return findings;
}

function runBhytTier7({ billing }) {
  return checkDuplicateServiceSameDay({ billing });
}

// ── Tầng 8: Dịch vụ kỹ thuật — trùng/cấu phần & bằng chứng liên kết ─────────────
// Trước đây cố ý CHƯA làm (xem README lịch sử) vì thiếu căn cứ pháp lý cho rule
// "trong gói". Thông tư 39/2024/TT-BYT (phân biệt chi phí đã/chưa tính trong giá
// dịch vụ) là căn cứ cho phần "bundled". Rule đọc từ config/hchanh/
// bhyt_dvkt_cross_check_rules.json — 2 loại:
//   - 'bundled': dịch vụ chính + dịch vụ có thể là công đoạn của nó cùng xuất hiện
//     trong bảng kê cùng ngày -> nguy cơ trùng/cấu phần giá.
//   - 'missing_support': dịch vụ chính xuất hiện nhưng KHÔNG thấy thuốc/vật tư bắt
//     buộc đi kèm cùng ngày (vd CT có cản quang nhưng không có thuốc cản quang).
// Chỉ cảnh báo REVIEW để người kiểm tự xác nhận (2 chỉ định độc lập, 2 mẫu bệnh
// phẩm riêng...), không tự động kết luận trùng/thiếu và không tự chặn gửi hồ sơ.

let _dvktCrossCheckCache = null, _dvktCrossCheckCacheTime = 0;
function loadDvktCrossCheckRules() {
  const now = Date.now();
  if (_dvktCrossCheckCache && now - _dvktCrossCheckCacheTime < 30000) return _dvktCrossCheckCache;
  try {
    const p = path.join(__dirname, '..', '..', '..', 'config', 'hchanh', 'bhyt_dvkt_cross_check_rules.json');
    if (fs.existsSync(p)) {
      _dvktCrossCheckCache = JSON.parse(fs.readFileSync(p, 'utf-8'));
      _dvktCrossCheckCacheTime = now;
      return _dvktCrossCheckCache;
    }
  } catch (e) { console.warn('[BHYT_PRE_AUDIT] Không đọc bhyt_dvkt_cross_check_rules.json:', e.message); }
  return { rules: [] };
}

// Gộp dòng bảng kê theo ngày thực hiện (bỏ dòng không xác định được ngày — không suy
// đoán trùng/thiếu khi thiếu mốc thời gian). Không lọc theo payment_group: bằng chứng
// đi kèm (vd thuốc cản quang) có thể tự túc dù dịch vụ chính là BHYT.
function groupBillingRowsByDay(billing) {
  const groups = new Map();
  for (const row of safeArray(billing?.rows)) {
    const at = parseVNDateTime(row?.tg_ylenh);
    const dateOnly = dateOnlyUTC(at);
    if (!dateOnly) continue;
    const key = dateOnly.getTime();
    if (!groups.has(key)) groups.set(key, { date: dateOnly, rows: [] });
    groups.get(key).rows.push(row);
  }
  return [...groups.values()];
}

function checkDvktCrossChecks({ billing }) {
  const rules = safeArray(loadDvktCrossCheckRules().rules).filter(r => r?.enabled !== false);
  if (!rules.length || !billing) return [];
  const dayGroups = groupBillingRowsByDay(billing);
  if (!dayGroups.length) return [];

  const findings = [];
  for (const rule of rules) {
    for (const { date, rows } of dayGroups) {
      const primaryRows = rows.filter(r => matchesKeywordGroups(normText(r?.name), rule.primary_keywords));
      if (!primaryRows.length) continue;
      // Bằng chứng đi kèm (hoặc dịch vụ cấu phần) phải đến từ MỘT DÒNG BẢNG KÊ KHÁC —
      // không tính chính dòng dịch vụ chính, vì tên dịch vụ (vd "CT ... có tiêm thuốc
      // cản quang") có thể tự chứa luôn từ khóa companion mà không có dòng thuốc/vật
      // tư riêng nào thật sự được thanh toán.
      const hasCompanion = rows.some(r => !primaryRows.includes(r) && matchesKeywordGroups(normText(r?.name), rule.companion_keywords));

      const isBundledHit = rule.type === 'bundled' && hasCompanion;
      const isMissingSupportHit = rule.type === 'missing_support' && !hasCompanion;
      if (!isBundledHit && !isMissingSupportHit) continue;

      const bhytAmount = primaryRows.reduce((s, r) => s + (r.payment_group === 'bhyt' ? moneyNum(r.thanh_tien) : 0), 0);
      findings.push(makeFinding({
        rule_id: `BHYT_T8_${rule.code}`,
        tier: 8,
        severity: BHYT_SEVERITY.REVIEW,
        group: 'Dịch vụ kỹ thuật',
        title: text(rule.title),
        detail: `${text(rule.detail)} Ngày ${fmtDateUTC(date)}: ${primaryRows.slice(0, 3).map(r => text(r.name)).join('; ')}${primaryRows.length > 3 ? `; +${primaryRows.length - 3} dòng khác` : ''}.`,
        action: text(rule.action || 'Kiểm tra lại trên EMR trước khi nộp hồ sơ.'),
        legal_source: rule.type === 'bundled'
          ? 'Thông tư 39/2024/TT-BYT + checklist chuyên môn nội bộ (config/hchanh/bhyt_dvkt_cross_check_rules.json)'
          : 'Checklist chuyên môn nội bộ (config/hchanh/bhyt_dvkt_cross_check_rules.json)',
        legal_clause: rule.type === 'bundled'
          ? 'Phân biệt chi phí đã và chưa được kết cấu trong giá dịch vụ kỹ thuật — không thanh toán trùng công đoạn đã nằm trong giá dịch vụ chính.'
          : 'Không phải rule pháp lý bắt buộc — cảnh báo cần bằng chứng liên kết dịch vụ ↔ thuốc/vật tư, cần người kiểm xác nhận.',
        amount_at_risk: bhytAmount,
        evidence: `dvkt_rule=${rule.code}, date=${fmtDateUTC(date)}, type=${rule.type}`,
      }));
    }
  }
  return findings;
}

// Nhiều lần PT/TT trong cùng đợt điều trị: nêu ra mấy chỗ/phương pháp/ekip, cùng hay
// khác ekip — để người kiểm đối chiếu bảng kê với Điều 7 Khoản 3, Thông tư
// 22/2023/TT-BYT (17/11/2023): "Trường hợp thực hiện nhiều can thiệp trong cùng một
// lần phẫu thuật: thanh toán theo giá của phẫu thuật phức tạp nhất, có mức giá cao
// nhất, các dịch vụ kỹ thuật khác phát sinh ngoài quy trình kỹ thuật của phẫu thuật
// nêu trên được thanh toán như sau: a) Bằng 50% giá của các phẫu thuật phát sinh nếu
// kỹ thuật đó vẫn do một kíp phẫu thuật thực hiện; b) Bằng 80% giá của các phẫu thuật
// phát sinh nếu kỹ thuật đó phải thay kíp phẫu thuật khác để thực hiện; c) Trường hợp
// thực hiện dịch vụ phát sinh là các thủ thuật thì thanh toán 80% giá dịch vụ kỹ
// thuật phát sinh." (căn cứ pháp lý do người dùng xác nhận qua ảnh chụp văn bản gốc).
//
// CHỈ nêu tỷ lệ áp dụng (100%/50%/80%) để người kiểm tự đối chiếu bảng kê — KHÔNG tự
// tính số tiền điều chỉnh, vì hệ thống chưa có: (1) giá dịch vụ gắn với từng dòng PT
// (surgery.surgeries không có trường giá, giá chỉ có ở bảng kê `billing`), và (2)
// cách phân biệt tin cậy "phẫu thuật" vs "thủ thuật" cho dịch vụ phát sinh (trường
// `phan_loai_pt` là phân loại độ phức tạp PT theo TT 50/2014, không phải PT/TT).
// Khớp tên dịch vụ PT với dòng bảng kê để suy ra giá + loại PT/TT sẽ là suy đoán
// không đủ tin cậy — không làm khi chưa có cách khớp chắc chắn.
//
// Định nghĩa "cùng ekip" / "khác ekip" (quy ước nghiệp vụ do người dùng xác nhận,
// không phải trích luật): "cùng ekip" = một tập thể nhân sự thống nhất, đồng hành
// xuyên suốt từ đầu đến cuối; "khác ekip" = có thay đổi nhân sự giữa chừng (đổi ca
// trực/giao ca) hoặc là 2 nhóm hoàn toàn độc lập. Cài đặt: so khớp CHÍNH XÁC cả 6
// vai trò (bs_mo_chinh, gay_me_chinh, ptv_phu_1, ptv_phu_2, dd_dung_cu, ktv_phu_me)
// giữa các lần PT — chỉ cần 1 vai trò khác là coi "khác ekip" (đúng tinh thần "đồng
// hành xuyên suốt toàn bộ ê-kíp", không riêng PTV chính).
function checkMultiSurgeryEkipComposition({ surgery }) {
  const rows = safeArray(surgery?.surgeries);
  if (rows.length < 2) return [];

  const ekipFields = ['bs_mo_chinh', 'gay_me_chinh', 'ptv_phu_1', 'ptv_phu_2', 'dd_dung_cu', 'ktv_phu_me'];
  const ekipKey = (r) => ekipFields.map(k => normText(text(r?.[k]))).join('|');
  const hasAnyEkipData = rows.some(r => ekipFields.some(k => text(r?.[k])));
  if (!hasAnyEkipData) return [];

  const distinctEkip = new Set(rows.map(ekipKey));
  const distinctMethods = new Set(rows.map(r => normText(text(r?.phuong_phap_pt || r?.dich_vu_phau_thuat))).filter(Boolean));
  const sameEkip = distinctEkip.size <= 1;

  return [makeFinding({
    rule_id: 'BHYT_T8_MULTI_SURGERY_EKIP_COMPOSITION',
    tier: 8,
    severity: BHYT_SEVERITY.REVIEW,
    group: 'Dịch vụ kỹ thuật',
    title: `${rows.length} lần phẫu thuật/thủ thuật trong đợt điều trị — ${sameEkip ? 'cùng ekip' : `${distinctEkip.size} ekip khác nhau`}, ${distinctMethods.size || rows.length} phương pháp`,
    detail: rows.map((r, i) => `PT ${i + 1}: ${text(r?.phuong_phap_pt || r?.dich_vu_phau_thuat, 'chưa rõ phương pháp')} — PTV chính: ${text(r?.bs_mo_chinh, 'chưa rõ')}`).join('; '),
    action: sameEkip
      ? 'Cùng 1 kíp thực hiện nhiều PT/TT trong 1 lần: dịch vụ giá cao nhất thanh toán 100%, các dịch vụ phát sinh thêm CHỈ thanh toán 50% giá (80% nếu dịch vụ phát sinh là thủ thuật, không phải phẫu thuật) — Điều 7 Khoản 3.a Thông tư 22/2023/TT-BYT. Kiểm tra lại bảng kê có đang tính đúng tỷ lệ này cho từng dòng, tránh tính 100% cho tất cả.'
      : 'Phải thay kíp khác để thực hiện thêm PT/TT trong cùng 1 lần: dịch vụ giá cao nhất thanh toán 100%, các dịch vụ phát sinh thêm thanh toán 80% giá — Điều 7 Khoản 3.b Thông tư 22/2023/TT-BYT. Kiểm tra lại bảng kê có đang tính đúng tỷ lệ 80% cho dòng phát sinh, không phải 100%.',
    legal_source: 'Thông tư 22/2023/TT-BYT (Bộ Y tế, ngày 17/11/2023), Điều 7 Khoản 3',
    legal_clause: 'Nhiều can thiệp trong cùng 1 lần phẫu thuật: dịch vụ giá cao nhất thanh toán 100%; dịch vụ phát sinh thêm thanh toán 50% nếu cùng kíp phẫu thuật, 80% nếu phải thay kíp khác hoặc dịch vụ phát sinh là thủ thuật.',
    evidence: `count=${rows.length}, distinct_ekip=${distinctEkip.size}, distinct_methods=${distinctMethods.size}`,
  })];
}

function runBhytTier8({ billing, surgery }) {
  return [...checkDvktCrossChecks({ billing }), ...checkMultiSurgeryEkipComposition({ surgery })];
}

// ── Tổng hợp đánh giá ────────────────────────────────────────────────────────
// Dùng rule severity + override (không cộng điểm): mức nặng nhất quyết định trạng thái.
// "Số tiền có nguy cơ" lấy giá trị lớn nhất trong các finding, không cộng dồn — tránh
// tính trùng khi nhiều finding cùng quy về một khoản BHYT của đợt điều trị.

function computeAssessment({ hasEnoughData, findings }) {
  if (!hasEnoughData) {
    return { ...ASSESSMENT.INSUFFICIENT_DATA, amount_at_risk: 0, findings: [] };
  }
  const worstRank = findings.reduce((max, f) => Math.max(max, SEVERITY_RANK[f.severity] ?? 0), 0);
  let assessment;
  if (worstRank >= SEVERITY_RANK.block) assessment = ASSESSMENT.DO_NOT_SUBMIT;
  else if (worstRank >= SEVERITY_RANK.high_risk) assessment = ASSESSMENT.HIGH_RISK;
  else if (worstRank >= SEVERITY_RANK.review) assessment = ASSESSMENT.NEEDS_REVIEW;
  else if (worstRank >= SEVERITY_RANK.warning) assessment = ASSESSMENT.NEEDS_REVIEW;
  else assessment = ASSESSMENT.SAFE;

  const amount_at_risk = findings.reduce((max, f) => Math.max(max, f.amount_at_risk || 0), 0);
  return { ...assessment, amount_at_risk, findings };
}

// ── Chỉ số "tỷ lệ đạt" theo Tầng ─────────────────────────────────────────────
// KHÔNG phải điểm số cộng dồn (đúng nguyên tắc "không cộng điểm" ở trên) — chỉ đếm
// bao nhiêu trong số các Tầng ĐÃ CHẠY không phát sinh finding nào, để người kiểm có
// cái nhìn nhanh theo nhóm thay vì phải đọc hết danh sách finding gộp. "Không có
// finding" không đồng nghĩa "đã xác minh sạch tuyệt đối" — nhiều Tầng (5, 6, 8...)
// chỉ phát hiện được khi có dữ liệu khớp từ khóa liên quan; không khớp gì không phải
// lúc nào cũng nghĩa là "đã kiểm và không có vấn đề", có thể là "không có gì để kiểm".
// Vì vậy đây là chỉ số THAM KHẢO hiển thị bên cạnh `assessment` (vẫn là tín hiệu
// chính), không dùng để tự động khóa nút ra viện — người kiểm luôn tự quyết định.

const TIER_LABELS = Object.freeze({
  1: 'Toàn vẹn dữ liệu',
  2: 'Ngày giường',
  3: 'Chẩn đoán ↔ PT/TT',
  4: 'CLS chứng minh chỉ định',
  5: 'VTYT',
  6: 'Thuốc/DVKT',
  7: 'Trùng dịch vụ',
  8: 'DVKT trùng/cấu phần',
});

function computeTierReadiness(tierEntries) {
  const items = tierEntries.map(({ tier, findings }) => ({
    tier,
    label: TIER_LABELS[tier] || `Tầng ${tier}`,
    count: findings.length,
    clean: findings.length === 0,
  }));
  return {
    clean_count: items.filter(i => i.clean).length,
    total_count: items.length,
    items,
  };
}

// ── Điểm vào ─────────────────────────────────────────────────────────────────
// Chỉ áp dụng cho scope 'discharge' — các scope khác (nhập khoa/PTTT/hằng ngày)
// chưa có đủ dữ liệu ra viện/bảng kê để tiền giám định.

function runBhytPreAudit({ meta, data, bedDaysReview }) {
  const scope = meta?.scope_default || 'daily';
  if (scope !== 'discharge') {
    return { applicable: false, tiers_completed: [], assessment: null };
  }

  const { profile, discharge, billing, surgery, bed_days } = data || {};
  const hasEnoughData = Boolean(profile && discharge);
  const { admitAt, dischargeAt, admissionDate, dischargeDate } = admissionAndDischargeDates(profile, discharge);

  const tier1_findings = hasEnoughData
    ? runBhytTier1({ profile, discharge, billing, surgery, admitAt, dischargeAt, admissionDate, dischargeDate })
    : [];
  const tier2_findings = hasEnoughData
    ? runBhytTier2({ admitAt, dischargeAt, bed_days, bedDaysReview })
    : [];
  const tier3_findings = hasEnoughData
    ? runBhytTier3({ discharge, surgery, billing })
    : [];
  const tier4_findings = hasEnoughData
    ? runBhytTier4({ profile, discharge, billing })
    : [];
  const tier5_findings = hasEnoughData
    ? runBhytTier5({ billing })
    : [];
  const tier6_findings = hasEnoughData
    ? runBhytTier6({ discharge, billing })
    : [];
  const tier7_findings = hasEnoughData
    ? runBhytTier7({ billing })
    : [];
  const tier8_findings = hasEnoughData
    ? runBhytTier8({ billing, surgery })
    : [];

  const allFindings = [...tier1_findings, ...tier2_findings, ...tier3_findings, ...tier4_findings, ...tier5_findings, ...tier6_findings, ...tier7_findings, ...tier8_findings];
  const assessment = computeAssessment({ hasEnoughData, findings: allFindings });
  const readiness = hasEnoughData
    ? computeTierReadiness([
        { tier: 1, findings: tier1_findings },
        { tier: 2, findings: tier2_findings },
        { tier: 3, findings: tier3_findings },
        { tier: 4, findings: tier4_findings },
        { tier: 5, findings: tier5_findings },
        { tier: 6, findings: tier6_findings },
        { tier: 7, findings: tier7_findings },
        { tier: 8, findings: tier8_findings },
      ])
    : null;

  return {
    applicable: true,
    tiers_completed: [1, 2, 3, 4, 5, 6, 7, 8],
    tier1_findings,
    tier2_findings,
    tier3_findings,
    tier4_findings,
    tier5_findings,
    tier6_findings,
    tier7_findings,
    tier8_findings,
    assessment,
    readiness,
  };
}

module.exports = {
  BHYT_SEVERITY,
  SEVERITY_RANK,
  ASSESSMENT,
  TIER_LABELS,
  runBhytPreAudit,
  computeTierReadiness,
  runBhytTier1,
  runBhytTier2,
  runBhytTier3,
  runBhytTier4,
  runBhytTier5,
  runBhytTier6,
  runBhytTier7,
  runBhytTier8,
  loadRuleMeta,
  loadDxProcedureMap,
  loadDrugRules,
  loadDvktCrossCheckRules,
};
