'use strict';

const { ISSUE_GROUPS, TAGS } = require('./constants');
const { safeArray, makeIssue, normText } = require('./common');
const {
  orderText,
  orderNorm,
  containsAny,
  firstMatcher,
  isInjectionRoute,
  stoppedOrder,
  extractClockTimes,
  frequencyPerDay,
  dailyQuantity,
  orderDate,
} = require('./business_helpers');

function tagAllowed(rule, state) {
  const tags = new Set(safeArray(state?.tags));
  const required = safeArray(rule.contextTags || rule.tags);
  const excluded = safeArray(rule.excludeTags);
  if (required.length && !required.some(t => tags.has(t))) return false;
  if (excluded.length && excluded.some(t => tags.has(t))) return false;
  return true;
}

function activeDrugs(drugs) {
  return safeArray(drugs).filter(d => !stoppedOrder(d));
}

function drugName(drug) {
  return String(drug?.name || drug?.ten_thuoc || drug?.ten_hien_thi || drug?.label || drug?.raw_text || drug?.raw || '').trim();
}

function ruleTitle(rule, drug, suffix = '') {
  return String(rule.title || `Y lệnh thuốc cần rà theo quy tắc khoa${suffix ? `: ${suffix}` : ''}`).trim();
}

function runMedicationPolicyRules({ state, drugs, medicationRules }) {
  const issues = [];
  const list = activeDrugs(drugs);
  for (const drug of list) {
    const text = orderNorm(drug);
    const name = drugName(drug);
    for (const rule of safeArray(medicationRules)) {
      if (!tagAllowed(rule, state)) continue;
      if (!containsAny(text, rule.match || rule.keywords || rule.drugs)) continue;

      const freq = frequencyPerDay(drug, 1);
      const daily = dailyQuantity(drug, freq);
      const clocks = extractClockTimes(orderText(drug));
      const severity = rule.severity === 'info' ? 'info' : rule.severity === 'error' ? 'error' : 'warn';

      if (rule.requireSchedule && !clocks.length && !drug.so_lan && !drug.times && !drug.frequency_per_day) {
        issues.push(makeIssue({
          group: ISSUE_GROUPS.DRUG,
          severity: rule.scheduleSeverity || severity,
          code: `${rule.id || 'MED_RULE'}_SCHEDULE_MISSING`,
          title: ruleTitle(rule, drug, 'thiếu giờ dùng thuốc'),
          detail: `${name || 'Thuốc'} chưa có giờ dùng thuốc/tần suất đủ rõ.`,
          action: rule.scheduleAction || 'Bác sĩ bổ sung giờ dùng thuốc hoặc số lần dùng/ngày trên y lệnh EMR.',
          evidence: orderText(drug),
          meta: { ruleId: rule.id || '', frequencyPerDay: freq, clocks },
        }));
      }

      if (Number(rule.maxTimesPerDay) > 0 && freq > Number(rule.maxTimesPerDay)) {
        issues.push(makeIssue({
          group: ISSUE_GROUPS.DRUG,
          severity,
          code: `${rule.id || 'MED_RULE'}_MAX_FREQ`,
          title: ruleTitle(rule, drug),
          detail: `${name}: ${freq} lần/ngày, vượt ngưỡng khoa cấu hình là ${rule.maxTimesPerDay} lần/ngày.`,
          action: rule.action || 'Trao đổi bác sĩ phụ trách để xác nhận/sửa y lệnh theo quy tắc nội bộ của khoa.',
          evidence: orderText(drug),
          meta: { ruleId: rule.id || '', frequencyPerDay: freq, maxTimesPerDay: rule.maxTimesPerDay },
        }));
      }

      if (Number(rule.maxDailyQty) > 0 && daily > Number(rule.maxDailyQty)) {
        issues.push(makeIssue({
          group: ISSUE_GROUPS.DRUG,
          severity,
          code: `${rule.id || 'MED_RULE'}_MAX_DAILY_QTY`,
          title: ruleTitle(rule, drug),
          detail: `${name}: số lượng/ngày ước tính ${daily}, vượt ngưỡng khoa cấu hình là ${rule.maxDailyQty}.`,
          action: rule.action || 'Đối chiếu liều, số lần dùng và số lượng lĩnh trước khi thực hiện.',
          evidence: orderText(drug),
          meta: { ruleId: rule.id || '', dailyQty: daily, maxDailyQty: rule.maxDailyQty },
        }));
      }

      if (rule.requiresStopPlan && safeArray(state?.tags).includes(TAGS.POST_OP) && !/ngung|dung den|den ngay|het ngay|trong 24h|24 gio|24h/.test(text)) {
        issues.push(makeIssue({
          group: ISSUE_GROUPS.DRUG,
          severity: rule.stopPlanSeverity || 'warn',
          code: `${rule.id || 'MED_RULE'}_STOP_PLAN_MISSING`,
          title: rule.stopPlanTitle || 'Thuốc sau mổ cần có kế hoạch ngưng/đối chiếu thời điểm dùng',
          detail: `${name}: chưa thấy mốc ngưng/kết thúc rõ trong dữ liệu y lệnh.`,
          action: rule.stopPlanAction || 'Đối chiếu phác đồ khoa và cập nhật thời điểm ngưng nếu cần.',
          evidence: orderText(drug),
          meta: { ruleId: rule.id || '' },
        }));
      }
    }
  }
  return issues;
}

function runDuplicateIngredientRules({ drugs, duplicateIngredientGroups }) {
  const issues = [];
  const list = activeDrugs(drugs);
  const byDate = new Map();
  for (const drug of list) {
    const date = orderDate(drug) || 'unknown';
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(drug);
  }
  for (const [date, dayDrugs] of byDate.entries()) {
    for (const group of safeArray(duplicateIngredientGroups)) {
      const hits = [];
      for (const drug of dayDrugs) {
        const match = firstMatcher(orderNorm(drug), group.match || group.keywords || group.drugs);
        if (match) hits.push({ drug, match, name: drugName(drug) });
      }
      const unique = [...new Map(hits.map(h => [normText(h.name), h])).values()];
      const max = Number(group.maxActive || group.max || 1);
      if (unique.length > max) {
        issues.push(makeIssue({
          group: ISSUE_GROUPS.DRUG,
          severity: group.severity || 'warn',
          code: `${group.id || 'DUPLICATE_DRUG_GROUP'}_DUPLICATE`,
          title: group.title || `Có nhiều thuốc cùng nhóm ${group.group || ''}`.trim(),
          detail: `${date}: ${unique.map(h => h.name).join(' + ')}.`,
          action: group.action || 'Đối chiếu trùng nhóm/hoạt chất theo quy tắc nội bộ trước khi lĩnh và thực hiện.',
          evidence: unique.map(h => orderText(h.drug)).join(' | '),
          meta: { groupId: group.id || '', date, count: unique.length, maxActive: max },
        }));
      }
    }
  }
  return issues;
}

function runMedicationCompletenessRules({ state, drugs }) {
  const issues = [];
  const list = activeDrugs(drugs);
  const injectables = list.filter(isInjectionRoute);
  const missingSchedule = injectables.filter(d => !extractClockTimes(orderText(d)).length && !d.so_lan && !d.times && !d.frequency_per_day);
  if (missingSchedule.length) {
    issues.push(makeIssue({
      group: ISSUE_GROUPS.DRUG,
      severity: state?.isLeaving ? 'error' : 'warn',
      code: 'INJECTABLE_SCHEDULE_REQUIRED',
      title: 'Y lệnh thuốc chưa có giờ dùng thuốc',
      detail: `Chưa có giờ dùng thuốc: ${missingSchedule.slice(0, 5).map(drugName).filter(Boolean).join(', ') || 'chưa rõ tên thuốc'}.`,
      action: 'Bác sĩ bổ sung giờ dùng thuốc trên y lệnh EMR.',
      evidence: missingSchedule.slice(0, 5).map(orderText).join(' | '),
    }));
  }

  const noName = list.filter(d => !drugName(d));
  if (noName.length) {
    issues.push(makeIssue({
      group: ISSUE_GROUPS.DRUG,
      severity: 'warn',
      code: 'DRUG_NAME_MISSING',
      title: 'Có dòng thuốc chưa bắt được tên rõ ràng',
      detail: `${noName.length} dòng thuốc không đủ tên để kiểm rule.`,
      action: 'Kiểm tra parser hoặc đọc lại chi tiết người bệnh trước khi chốt.',
    }));
  }
  return issues;
}

function runMedicationBusinessRules({ state, drugs, rules }) {
  return [
    ...runMedicationCompletenessRules({ state, drugs }),
    ...runMedicationPolicyRules({ state, drugs, medicationRules: rules?.medicationRules }),
    ...runDuplicateIngredientRules({ drugs, duplicateIngredientGroups: rules?.duplicateIngredientGroups }),
  ];
}

module.exports = {
  activeDrugs,
  drugName,
  runMedicationBusinessRules,
  runMedicationPolicyRules,
  runDuplicateIngredientRules,
  runMedicationCompletenessRules,
};
