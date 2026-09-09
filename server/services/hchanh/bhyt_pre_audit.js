// server/services/hchanh/bhyt_pre_audit.js
// Tiền giám định BHYT trước khi nộp hồ sơ — KHÔNG kết luận "xuất toán".
// Trả về: nguy cơ từ chối thanh toán + lý do + khoản tiền có nguy cơ + thứ cần kiểm tra.
//
// Đã cài Tầng 1 (tính toàn vẹn dữ liệu), Tầng 2 (ngày giường), Tầng 3 (chẩn
// đoán ↔ PT/TT) và Tầng 4 (CLS chứng minh chỉ định). Các tầng còn lại (thuốc/
// VTYT, giá + quyền lợi BHYT, hồ sơ chứng minh...) sẽ thêm dần bằng cách bổ
// sung hàm check + rule mới, không đổi khung này.
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

  const allFindings = [...tier1_findings, ...tier2_findings, ...tier3_findings, ...tier4_findings];
  const assessment = computeAssessment({ hasEnoughData, findings: allFindings });

  return {
    applicable: true,
    tiers_completed: [1, 2, 3, 4],
    tier1_findings,
    tier2_findings,
    tier3_findings,
    tier4_findings,
    assessment,
  };
}

module.exports = {
  BHYT_SEVERITY,
  SEVERITY_RANK,
  ASSESSMENT,
  runBhytPreAudit,
  runBhytTier1,
  runBhytTier2,
  runBhytTier3,
  runBhytTier4,
  loadRuleMeta,
  loadDxProcedureMap,
};
