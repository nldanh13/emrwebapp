'use strict';

const { ISSUE_GROUPS, TAGS } = require('./constants');
const { normText, safeArray, makeIssue } = require('./common');
const { stoppedOrder, orderText } = require('./business_helpers');
const { runMedicationBusinessRules } = require('./medication_rules');
const { buildSurgeryPackageAudit } = require('./surgery_package');

function hasStoppedDrug(drug) {
  return stoppedOrder(drug);
}

function runDrugRules({ state, drugs, drugSignals, rules }) {
  const issues = [];
  const activeDrugs = safeArray(drugs).filter(d => !hasStoppedDrug(d));

  issues.push(...runMedicationBusinessRules({ state, drugs, rules }));

  if (activeDrugs.length && !drugSignals?.has6h && state?.isLeaving) {
    const drugNames = activeDrugs.slice(0, 6).map(d => d.name || d.ten_thuoc || d.ten_hien_thi || d.raw_text || '').filter(Boolean);
    issues.push(makeIssue({
      group: ISSUE_GROUPS.DRUG,
      severity: 'warn',
      code: 'DRUG_TIME_MISSING_ON_EXIT',
      title: 'Y lệnh thuốc chưa có giờ dùng thuốc',
      detail: drugNames.length
        ? `Chưa có giờ dùng thuốc: ${drugNames.join(', ')}.`
        : 'Có y lệnh thuốc nhưng chưa thấy giờ dùng thuốc rõ ràng.',
      action: 'Bác sĩ bổ sung giờ dùng thuốc trên y lệnh EMR trước khi chốt hồ sơ.',
      evidence: drugNames.join(', '),
    }));
  }
  if (drugSignals?.hasInjection && !drugSignals?.has6h && !state?.isLeaving) {
    issues.push(makeIssue({
      group: ISSUE_GROUPS.DRUG,
      severity: 'warn',
      code: 'INJECTION_NEEDS_SCHEDULE_CHECK',
      title: 'Thuốc tiêm/truyền cần đối chiếu giờ dùng',
      detail: 'Có thuốc tiêm/truyền nhưng chưa thấy cữ dùng đủ rõ trong dữ liệu phân loại.',
      action: 'Kiểm tra giờ dùng, số lần dùng và trạng thái đã thực hiện trên EMR.',
    }));
  }
  if (drugSignals?.hasSelfPaidMarker) {
    issues.push(makeIssue({
      group: ISSUE_GROUPS.BHYT,
      severity: 'warn',
      code: 'SELF_PAID_DRUG',
      title: 'Có thuốc/vật tư đánh dấu tự túc hoặc TT0',
      detail: 'Cần tách rõ nhóm BHYT và nhóm thu phí tự túc trên bảng kê.',
      action: 'Đối chiếu đối tượng thanh toán từng thuốc/vật tư trước khi in bảng kê.',
    }));
  }
  return issues;
}

function runSupplyRules({ state, supplyPlan, alertSupplies }) {
  const issues = [];
  if (safeArray(alertSupplies).length) {
    issues.push(makeIssue({
      group: ISSUE_GROUPS.SUPPLY,
      severity: 'info',
      code: 'SUPPLIES_INPUT_BY_NURSE',
      title: `Có ${alertSupplies.length} nhóm VTYT điều dưỡng cần xem trước`,
      detail: alertSupplies.slice(0, 6).map(x => `${x.label || x.name}: ${x.qty || x.quantity || 1}`).join(' · '),
      action: 'Điều dưỡng xem bảng VTYT trên thẻ người bệnh và bấm Nhập VTYT nếu phù hợp.',
    }));
  }
  const hasOnlyRoutine = safeArray(supplyPlan).length && !safeArray(alertSupplies).length;
  if (hasOnlyRoutine && !safeArray(state?.tags).includes(TAGS.POST_OP)) {
    issues.push(makeIssue({
      group: ISSUE_GROUPS.SUPPLY,
      severity: 'info',
      code: 'SUPPLIES_ROUTINE_ONLY',
      title: 'Chỉ có VTYT thường quy',
      detail: 'Các vật tư thường quy không tạo cảnh báo lĩnh thêm.',
      action: '',
    }));
  }
  if (safeArray(state?.tags).includes(TAGS.POST_OP)) {
    issues.push(makeIssue({
      group: ISSUE_GROUPS.SUPPLY,
      severity: 'info',
      code: 'POST_OP_ROUTINE_SUPPRESSED',
      title: 'Đã tạm ngưng hao phí lưu trú thường quy do tag Đã đi PT',
      detail: 'Workflow chỉ tính VTYT liên quan y lệnh/ngày phẫu thuật, không tạo phiếu sửa cho bác sĩ.',
    }));
  }
  return issues;
}

function runServiceRules({ state, services, serviceSignals }) {
  const issues = [];
  if (serviceSignals?.hasContrast) {
    issues.push(makeIssue({
      group: ISSUE_GROUPS.CLS_DVKT,
      severity: 'warn',
      code: 'CONTRAST_CHECK',
      title: 'Có CLS/DVKT dùng cản quang/cản từ',
      detail: 'Cần đối chiếu thuốc/vật tư cản quang/cản từ với bảng kê.',
      action: 'Kiểm tra chi phí tự túc/BHYT và vật tư dùng kèm nếu có.',
    }));
  }
  if (serviceSignals?.hasBlood) {
    issues.push(makeIssue({
      group: ISSUE_GROUPS.CLS_DVKT,
      severity: 'warn',
      code: 'BLOOD_TRANSFUSION_CHECK',
      title: 'Có chỉ định truyền máu/chế phẩm máu',
      detail: 'Cần đối chiếu chi phí, phiếu truyền máu và vật tư liên quan.',
      action: 'Kiểm tra bảng kê và hồ sơ truyền máu trước khi chốt.',
    }));
  }
  if (state?.isLeaving && serviceSignals?.hasCls) {
    issues.push(makeIssue({
      group: ISSUE_GROUPS.CLS_DVKT,
      severity: 'warn',
      code: 'EXIT_CLS_DVKT_RECONCILE',
      title: 'Cần đối chiếu CLS/DVKT trước khi ra khỏi khoa',
      detail: safeArray(services).slice(0, 5).map(s => s.name).join(' · '),
      action: 'So bảng kê với y lệnh CLS/DVKT, kết quả và dịch vụ đã thực hiện.',
    }));
  }
  return issues;
}

function runSurgeryPackageRules({ state, services, supplyPlan, surgeryPackageRules, surgeryPackageAudit }) {
  const audit = surgeryPackageAudit || buildSurgeryPackageAudit({ state, services, supplyPlan, surgeryPackageRules });
  if (audit?.issues?.length) return audit.issues;
  if (audit?.required && audit.completionPct === 100) {
    return [makeIssue({
      group: ISSUE_GROUPS.SURGERY_PACKAGE,
      severity: 'info',
      code: 'SURGERY_PACKAGE_OK',
      title: 'Đã đối chiếu đủ gói dụng cụ PTTT theo dictionary hiện tại',
      detail: safeArray(audit.audits).map(a => `${a.service}: ${a.completionPct}%`).join(' · '),
      action: '',
    })];
  }
  return [];
}

function runAdmissionRules({ state, profile }) {
  const issues = [];
  if (safeArray(state?.tags).includes(TAGS.NEW_ADMISSION)) {
    issues.push(makeIssue({
      group: ISSUE_GROUPS.ADMIN,
      severity: 'info',
      code: 'NEW_ADMISSION_REVIEW',
      title: 'Người bệnh mới nhập viện cần rà thông tin nền',
      detail: 'Workflow mới nhập viện chạy song song nếu có thêm tag xuất/chuyển trong cùng ngày.',
      action: 'Kiểm tra thông tin hành chính, nguồn vào viện, BHYT/chuyển tuyến và y lệnh đầu vào.',
    }));
  }
  if ((profile?.admission?.emergency || profile?.admission?.referral) && !profile?.bhyt?.has) {
    issues.push(makeIssue({
      group: ISSUE_GROUPS.BHYT,
      severity: 'warn',
      code: 'ADMISSION_SOURCE_BHYT_REVIEW',
      title: 'Nguồn nhập viện cần đối chiếu BHYT/chuyển tuyến',
      detail: profile?.admission?.emergency ? 'Người bệnh có dấu hiệu nhập từ Cấp cứu.' : 'Người bệnh có dấu hiệu có giấy chuyển tuyến.',
      action: 'Kiểm tra thông tin thẻ BHYT, giấy chuyển tuyến và đối tượng thanh toán.',
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

function runOrderRules({ state, profile, drugs, services, drugSignals, serviceSignals, supplyPlan, alertSupplies, surgeryPackageRules, surgeryPackageAudit, rules }) {
  return dedupeIssues([
    ...runDrugRules({ state, drugs, drugSignals, rules }),
    ...runSupplyRules({ state, supplyPlan, alertSupplies }),
    ...runServiceRules({ state, services, serviceSignals }),
    ...runSurgeryPackageRules({ state, services, supplyPlan, surgeryPackageRules, surgeryPackageAudit }),
    ...runAdmissionRules({ state, profile }),
  ]);
}

module.exports = {
  runOrderRules,
  runDrugRules,
  runSupplyRules,
  runServiceRules,
  runSurgeryPackageRules,
  runAdmissionRules,
};
