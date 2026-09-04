'use strict';

const { ISSUE_GROUPS } = require('./constants');
const { safeArray, normText, makeIssue, isSurgicalServiceName } = require('./common');
const { containsAny } = require('./business_helpers');

function itemText(item) {
  return normText([
    item?.label, item?.name, item?.ten, item?.ten_vat_tu, item?.source, item?.sourceOrder, item?.note, item?.raw_text, item?.raw,
  ].join(' '));
}

function normalizeRequiredItem(item) {
  if (typeof item === 'string') return { label: item, match: [item], required: true };
  if (item && typeof item === 'object') return { ...item, label: item.label || item.name || item.ten || '', match: item.match || item.keywords || [item.label || item.name || item.ten || ''], required: item.required !== false };
  return null;
}

function serviceMatchesRule(service, rule) {
  const text = normText(`${service?.name || ''} ${service?.source || ''} ${service?.code || service?.ma_dich_vu || service?.ma_pttt || ''}`);
  return containsAny(text, rule.match || rule.keywords || rule.codes);
}

function presentRequired(required, supplyPlan) {
  const haystack = safeArray(supplyPlan).map(itemText).join(' | ');
  return containsAny(haystack, required.match || [required.label]);
}

function buildSurgeryPackageAudit({ state, services, supplyPlan, surgeryPackageRules }) {
  const surgicalServices = safeArray(services).filter(s => isSurgicalServiceName(`${s.name || ''} ${s.source || ''}`));
  const audits = [];
  const issues = [];
  if (!state?.isSurgery && !surgicalServices.length) return { required: false, audits, issues, completionPct: 100 };

  if (!surgicalServices.length) {
    issues.push(makeIssue({
      group: ISSUE_GROUPS.SURGERY_PACKAGE,
      severity: 'warn',
      code: 'SURGERY_SERVICE_NOT_CAPTURED',
      title: 'Có tag phẫu thuật nhưng chưa bắt được mã/tên PTTT',
      detail: 'Không thể kiểm gói dụng cụ đặc thù nếu thiếu mã/tên phẫu thuật thủ thuật.',
      action: 'Quét lại DVKT/PTTT hoặc bổ sung dictionary match theo tên phẫu thuật thực tế.',
    }));
    return { required: true, audits, issues, completionPct: 0 };
  }

  for (const svc of surgicalServices) {
    const matchedRule = safeArray(surgeryPackageRules).find(rule => serviceMatchesRule(svc, rule));
    const requiredItems = safeArray(matchedRule?.required).map(normalizeRequiredItem).filter(Boolean);
    if (!matchedRule) {
      const audit = { service: svc.name, matched: false, ruleId: '', requiredItems: [], present: [], missing: [], completionPct: 0 };
      audits.push(audit);
      issues.push(makeIssue({
        group: ISSUE_GROUPS.SURGERY_PACKAGE,
        severity: 'warn',
        code: 'SURGERY_PACKAGE_RULE_MISSING',
        title: 'PTTT chưa có trong bộ từ điển dụng cụ riêng',
        detail: svc.name,
        action: 'Thêm rule vào config/admin_workflow_rules.json để kiểm dụng cụ theo từng loại phẫu thuật.',
        evidence: svc.name,
      }));
      continue;
    }

    const present = [];
    const missing = [];
    for (const req of requiredItems) {
      if (presentRequired(req, supplyPlan)) present.push(req);
      else missing.push(req);
    }
    const completionPct = requiredItems.length ? Math.round((present.length / requiredItems.length) * 100) : 100;
    const audit = {
      service: svc.name,
      matched: true,
      ruleId: matchedRule.id || '',
      packageName: matchedRule.name || matchedRule.title || '',
      requiredItems,
      present,
      missing,
      completionPct,
    };
    audits.push(audit);
    if (missing.length) {
      issues.push(makeIssue({
        group: ISSUE_GROUPS.SURGERY_PACKAGE,
        severity: matchedRule.severity || 'error',
        code: 'SURGERY_PACKAGE_MISSING_ITEMS',
        title: 'Thiếu/không thấy đủ dụng cụ đặc thù theo PTTT',
        detail: `${svc.name}: còn thiếu ${missing.map(x => x.label).join(', ')}`,
        action: matchedRule.action || 'Đối chiếu vật tư đã nhập với bộ dụng cụ riêng của ca mổ; bổ sung hoặc giải trình nếu không dùng.',
        evidence: svc.name,
        meta: { ruleId: matchedRule.id || '', completionPct },
      }));
    }
  }

  const allReq = audits.reduce((acc, a) => acc + safeArray(a.requiredItems).length, 0);
  const allPresent = audits.reduce((acc, a) => acc + safeArray(a.present).length, 0);
  return { required: true, audits, issues, completionPct: allReq ? Math.round((allPresent / allReq) * 100) : 100 };
}

module.exports = { buildSurgeryPackageAudit };
