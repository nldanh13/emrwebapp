'use strict';

const { TAGS, ISSUE_GROUPS } = require('./constants');
const { normText, safeArray, makeIssue, parseVNDate } = require('./common');
const { daysBetweenInclusive, extractNumber } = require('./business_helpers');
const { buildBillingAudit } = require('./billing_audit');

function hasExitTag(state) {
  return safeArray(state?.tags).some(t => [TAGS.DISCHARGE, TAGS.TRANSFER_WARD, TAGS.TRANSFER_HOSPITAL, TAGS.DEATH].includes(t));
}

function documentText(profile, records) {
  return normText([
    profile?.diagnosis,
    profile?.exit?.xuTri,
    profile?.exit?.text,
    profile?.exit?.rawTime,
    safeArray(records).map(r => [
      r.giay_ra_vien, r.discharge_paper, r.tom_tat_benh_an, r.chan_doan, r.chuan_doan,
      r.loi_dan, r.dan_do, r.ghi_chu, r.note, r.hen_tai_kham, r.giay_hen_tai_kham,
      r.giay_nghi_om, r.nghi_om, r.so_ngay_nghi,
    ].filter(Boolean).join(' ')).join(' '),
  ].join(' '));
}

function detectTypoRisk(text, rules = {}) {
  const t = normText(text);
  const risks = [];
  const pairs = safeArray(rules.typoPairs).length ? safeArray(rules.typoPairs) : [
    { bad: 'chuan doan', good: 'chẩn đoán' },
    { bad: 'phau thuat', good: 'phẫu thuật' },
    { bad: 'phau thuat', good: 'phẫu thuật' },
    { bad: 'gay xuong', good: 'gãy xương' },
    { bad: 'tai kham', good: 'tái khám' },
  ];
  for (const pair of pairs) {
    const bad = normText(pair.bad);
    if (bad && t.includes(bad)) risks.push(`Có thể đang ghi "${pair.bad}"; cần kiểm lại cách viết "${pair.good || ''}".`.trim());
  }
  if (/\b(chuan doan|phau thuat|phau thuat|gay xuong|tai kham)\b/.test(t)) {
    // handled above if configured; keep guard for custom configs with empty typoPairs
  }
  return [...new Set(risks)];
}

function runCostQA({ profile, serviceSignals, drugSignals, billingAudit }) {
  const issues = [];
  const bhyt = profile?.bhyt || {};
  if (!bhyt.has) {
    issues.push(makeIssue({
      group: ISSUE_GROUPS.BHYT,
      severity: 'error',
      code: 'BHYT_MISSING_OR_SELF_PAY',
      title: 'Chưa thấy thông tin BHYT rõ ràng',
      detail: 'Hồ sơ xuất/chuyển cần phân tách rõ BHYT và thu phí tự túc.',
      action: 'Kiểm tra đối tượng thanh toán, số thẻ BHYT và thông tin chuyển tuyến nếu có.',
    }));
  }

  if (billingAudit?.issues?.length) issues.push(...billingAudit.issues);

  const summary = billingAudit?.summary || {};
  if (summary.sourceType === 'billing_table' && summary.bhytCount === 0 && summary.selfPayCount === 0 && summary.rowsCount > 0) {
    issues.push(makeIssue({
      group: ISSUE_GROUPS.COST,
      severity: 'warn',
      code: 'BILLING_PAYMENT_GROUP_EMPTY',
      title: 'Bảng kê có dòng chi phí nhưng chưa rõ nhóm thanh toán',
      detail: 'Không thấy dấu hiệu BHYT/tự túc/TT0 trên các dòng bảng kê đã đọc.',
      action: 'Đối chiếu lại trường đối tượng thanh toán trên EMR hoặc bổ sung parser bảng kê.',
    }));
  }

  if (drugSignals?.hasSelfPaidMarker && !summary.selfPayCount) {
    issues.push(makeIssue({
      group: ISSUE_GROUPS.COST,
      severity: 'warn',
      code: 'SELF_PAY_MARKER_NOT_IN_BILLING',
      title: 'Có dấu hiệu thuốc/vật tư tự túc nhưng bảng kê chưa tách dòng tương ứng',
      detail: 'Dữ liệu y lệnh có TT0/tự túc/ngoài BHYT.',
      action: 'So y lệnh với bảng kê; đảm bảo khoản tự túc hiển thị đúng trên phiếu công khai.',
    }));
  }

  if ((serviceSignals?.hasCls || serviceSignals?.hasSurgery) && summary.sourceType !== 'billing_table') {
    issues.push(makeIssue({
      group: ISSUE_GROUPS.COST,
      severity: 'error',
      code: 'COST_RECONCILE_REQUIRED_NO_TABLE',
      title: 'Cần quét Bảng kê chi phí trước khi in',
      detail: 'Có CLS/DVKT/PTTT nhưng chưa có bảng kê chi tiết để đối chiếu BHYT/tự túc.',
      action: 'Mở Bảng kê trên EMR để worker đọc lại rồi chạy QA hồ sơ.',
    }));
  }
  return issues;
}

function runDischargePaperQA({ profile, state, records, rules = {} }) {
  const issues = [];
  const exit = profile?.exit || {};
  const requireDatetime = rules.requireExitDatetime !== false;
  const requireDiagnosis = rules.requireDiagnosis !== false;

  if (!exit.xuTri && !exit.text) {
    issues.push(makeIssue({
      group: ISSUE_GROUPS.DISCHARGE_PAPER,
      severity: 'error',
      code: 'EXIT_DISPOSITION_MISSING',
      title: 'Thiếu hoặc chưa bắt được xử trí ra khoa',
      detail: 'Chưa thấy rõ xuất viện/chuyển khoa/chuyển viện/tử vong trên dữ liệu hiện có.',
      action: 'Cập nhật xử trí ra viện/chuyển khoa/chuyển viện trên EMR trước khi in hồ sơ.',
    }));
  }
  if (requireDatetime && (!exit.date || !exit.time)) {
    issues.push(makeIssue({
      group: ISSUE_GROUPS.DISCHARGE_PAPER,
      severity: 'error',
      code: 'EXIT_DATETIME_MISSING',
      title: 'Thiếu ngày/giờ ra viện hoặc chuyển khoa',
      detail: exit.rawTime ? `Dữ liệu hiện có: ${exit.rawTime}` : 'Chưa thấy mốc ngày giờ ra khỏi khoa.',
      action: 'Bổ sung ngày giờ ra viện/chuyển khoa chính xác trên EMR.',
    }));
  }
  if (requireDiagnosis && !profile?.diagnosis) {
    issues.push(makeIssue({
      group: ISSUE_GROUPS.DISCHARGE_PAPER,
      severity: 'warn',
      code: 'DIAGNOSIS_MISSING',
      title: 'Chưa thấy chẩn đoán ra viện/chẩn đoán chính',
      detail: 'Dữ liệu hành chính hiện không có chẩn đoán rõ ràng.',
      action: 'Rà lại giấy ra viện, chẩn đoán chính, bệnh kèm và biến chứng nếu có.',
    }));
  }

  const typo = detectTypoRisk(documentText(profile, records), rules);
  for (const detail of typo) {
    issues.push(makeIssue({
      group: ISSUE_GROUPS.DISCHARGE_PAPER,
      severity: 'warn',
      code: 'TEXT_TYPO_RISK',
      title: 'Cần rà lỗi chính tả/nội dung trên giấy ra viện',
      detail,
      action: 'Kiểm tra lại chính tả, thuật ngữ chuyên môn và ngày giờ trên giấy ra viện.',
    }));
  }
  return issues;
}

function runFollowUpQA({ profile, records, rules = {} }) {
  const issues = [];
  const text = normText([
    profile?.admission?.sourceText,
    safeArray(records).map(r => [r.giay_hen_tai_kham, r.hen_tai_kham, r.tai_kham, r.appointment, r.ghi_chu, r.note].filter(Boolean).join(' ')).join(' '),
  ].join(' '));
  const hasFollowUp = /hen tai kham|tai kham|ngay hen|lich hen|phong kham|giay hen/.test(text);
  const required = Boolean(
    (rules.requireForEmergencyAdmission !== false && profile?.admission?.emergency)
    || (rules.requireForReferral !== false && profile?.admission?.referral)
  );
  if (required && !hasFollowUp) {
    issues.push(makeIssue({
      group: ISSUE_GROUPS.FOLLOW_UP,
      severity: 'error',
      code: 'FOLLOW_UP_REQUIRED',
      title: 'Bắt buộc có giấy hẹn tái khám',
      detail: profile?.admission?.emergency
        ? 'Người bệnh có dấu hiệu nhập viện từ Cấp cứu.'
        : 'Người bệnh có dấu hiệu có giấy chuyển tuyến.',
      action: 'Tạo/kiểm giấy hẹn tái khám trước khi in và bàn giao hồ sơ.',
    }));
  } else if (required) {
    issues.push(makeIssue({
      group: ISSUE_GROUPS.FOLLOW_UP,
      severity: 'info',
      code: 'FOLLOW_UP_PRESENT',
      title: 'Có dấu hiệu giấy hẹn tái khám',
      detail: 'Vẫn cần kiểm ngày hẹn, phòng khám/chuyên khoa và bác sĩ hẹn.',
      action: 'Đối chiếu nội dung giấy hẹn tái khám trước khi in.',
    }));
  }
  return issues;
}

function findSickLeaveFields(records) {
  const values = [];
  for (const r of safeArray(records)) {
    for (const key of ['nghi_om', 'giay_nghi_om', 'so_ngay_nghi', 'sick_leave', 'sick_leave_days', 'ghi_chu']) {
      if (r?.[key] !== undefined && r?.[key] !== null && String(r[key]).trim()) values.push(String(r[key]));
    }
  }
  return values.join(' ');
}

function runSickLeaveQA({ profile, records, rules = {} }) {
  const issues = [];
  const text = normText(findSickLeaveFields(records));
  if (!/nghi om|giay nghi|so ngay nghi|sick leave/.test(text)) return issues;

  const raw = findSickLeaveFields(records);
  const statedDays = extractNumber(raw.match(/(?:nghi|nghỉ|so ngay|số ngày)[^0-9]{0,12}(\d{1,3})/)?.[1] || raw.match(/(\d{1,3})\s*(?:ngay|ngày)/)?.[1] || '');
  const inpatientDays = daysBetweenInclusive(profile?.admission?.admissionTime, profile?.exit?.rawTime || profile?.exit?.date);
  const maxExtra = Number(rules.maxExtraDaysAfterExit || 30);

  if (!statedDays) {
    issues.push(makeIssue({
      group: ISSUE_GROUPS.SICK_LEAVE,
      severity: 'warn',
      code: 'SICK_LEAVE_DAYS_MISSING',
      title: 'Có giấy nghỉ ốm nhưng chưa bắt được số ngày nghỉ',
      detail: 'Cần so ngày vào/ra, số ngày nghỉ ốm và ngày cấp giấy.',
      action: 'Bổ sung/kiểm số ngày nghỉ ốm trên giấy trước khi in.',
    }));
    return issues;
  }

  if (inpatientDays && statedDays < inpatientDays) {
    issues.push(makeIssue({
      group: ISSUE_GROUPS.SICK_LEAVE,
      severity: 'warn',
      code: 'SICK_LEAVE_LESS_THAN_INPATIENT_DAYS',
      title: 'Số ngày nghỉ ốm nhỏ hơn số ngày điều trị nội trú',
      detail: `Nghỉ ốm ${statedDays} ngày, điều trị ước tính ${inpatientDays} ngày.`,
      action: 'Kiểm lại ngày vào/ra viện và số ngày nghỉ ốm trước khi bàn giao.',
    }));
  }
  if (inpatientDays && statedDays > inpatientDays + maxExtra) {
    issues.push(makeIssue({
      group: ISSUE_GROUPS.SICK_LEAVE,
      severity: 'warn',
      code: 'SICK_LEAVE_TOO_LONG',
      title: 'Số ngày nghỉ ốm vượt xa số ngày điều trị',
      detail: `Nghỉ ốm ${statedDays} ngày, điều trị ước tính ${inpatientDays} ngày, ngưỡng cộng thêm cấu hình ${maxExtra} ngày.`,
      action: 'Kiểm tra lại giấy nghỉ ốm và chỉ định nghỉ sau ra viện.',
    }));
  }
  if (!inpatientDays && rules.requireDateRange !== false) {
    issues.push(makeIssue({
      group: ISSUE_GROUPS.SICK_LEAVE,
      severity: 'warn',
      code: 'SICK_LEAVE_DATE_RANGE_UNCLEAR',
      title: 'Có giấy nghỉ ốm nhưng chưa đủ ngày vào/ra để tự tính',
      detail: `Số ngày nghỉ ghi nhận: ${statedDays}.`,
      action: 'Bổ sung ngày vào/ra viện hoặc kiểm lại ngày cấp giấy nghỉ ốm.',
    }));
  }
  return issues;
}

function runBedQA({ liveBed }) {
  const issues = [];
  if (!liveBed) {
    issues.push(makeIssue({
      group: ISSUE_GROUPS.BED,
      severity: 'warn',
      code: 'BED_LIVE_CHECK_MISSING',
      title: 'Chưa kiểm buồng giường hiện tại',
      detail: 'Tiền giường cần đối chiếu trước khi đóng hồ sơ.',
      action: 'Bấm Kiểm BG để Selenium đọc timeline buồng giường hiện tại rồi so với phòng phụ trách.',
    }));
  } else if (safeArray(liveBed?.checks?.warnings).length) {
    issues.push(makeIssue({
      group: ISSUE_GROUPS.BED,
      severity: 'warn',
      code: 'BED_LIVE_WARNINGS',
      title: 'Buồng giường hiện tại có cảnh báo',
      detail: safeArray(liveBed.checks.warnings).join(' · '),
      action: 'Cập nhật/đối chiếu lại phòng, giường, thời gian và người chỉ định buồng giường.',
    }));
  }
  return issues;
}

function dedupeIssues(issues) {
  const out = [];
  const seen = new Set();
  for (const issue of safeArray(issues)) {
    const key = `${issue.code || ''}|${issue.group || ''}|${issue.title || ''}|${issue.detail || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

function runDischargeQA({ profile, state, records, drugs, services, drugSignals, serviceSignals, liveBed, billingAudit, rules }) {
  if (!hasExitTag(state)) {
    return {
      required: false,
      status: 'not_required',
      canPrint: false,
      issues: [],
      summary: 'Người bệnh chưa thuộc nhóm xuất/chuyển/tử vong.',
    };
  }
  const audit = billingAudit || buildBillingAudit({ records, services, drugs });
  const issues = dedupeIssues([
    ...runCostQA({ profile, state, serviceSignals, drugSignals, billingAudit: audit }),
    ...runDischargePaperQA({ profile, state, records, rules: rules?.dischargeDocumentRules }),
    ...runFollowUpQA({ profile, records, rules: rules?.followUpRules }),
    ...runSickLeaveQA({ profile, records, rules: rules?.sickLeaveRules }),
    ...runBedQA({ profile, liveBed }),
  ]);
  const errorCount = issues.filter(x => x.severity === 'error').length;
  const warnCount = issues.filter(x => x.severity === 'warn').length;
  const status = errorCount ? 'error' : warnCount ? 'warn' : 'ok';
  return {
    required: true,
    status,
    canPrint: status === 'ok',
    issues,
    billingAudit: audit,
    summary: status === 'ok' ? 'Đủ điều kiện in theo rule hiện tại.' : `Còn ${errorCount} lỗi và ${warnCount} cảnh báo cần xử lý.`,
  };
}

module.exports = {
  runDischargeQA,
  runCostQA,
  runDischargePaperQA,
  runFollowUpQA,
  runSickLeaveQA,
  runBedQA,
  detectTypoRisk,
};
