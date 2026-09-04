'use strict';

const { readJsonSafe } = require('../../utils/file');
const { safeArray, getPatientId, buildPatientGroups, latestRecord, collectDrugsFromSource, collectServicesFromRecord, mergeByKey, getRecordDate } = require('./common');
const { buildState, buildPatientProfile } = require('./state_machine');
const { mapSuppliesForRecords } = require('./supply_mapper');
const { runOrderRules } = require('./rule_engine');
const { runDischargeQA } = require('./discharge_qa');
const { buildBillingAudit } = require('./billing_audit');
const { buildSurgeryPackageAudit } = require('./surgery_package');
const { ticketsByPatient } = require('./repair_ticket');
const { buildPrintGuard, patientCanPrint } = require('./print_guard');
const { buildWorklist, summarizeCounts } = require('./worklist');

function readProcessedRows(ctx) {
  const paths = [ctx.PROCESSED_PATH, ctx.CLASSIFIED_DAYS_PATH, ctx.FINAL_PATH, ctx.ORDER_DAYS_PATH].filter(Boolean);
  for (const p of paths) {
    const rows = readJsonSafe(p, []);
    if (Array.isArray(rows) && rows.length) return rows;
  }
  return [];
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

function countIssues(issues) {
  return {
    errors: safeArray(issues).filter(x => x.severity === 'error').length,
    warnings: safeArray(issues).filter(x => x.severity === 'warn').length,
    info: safeArray(issues).filter(x => x.severity === 'info').length,
  };
}

function workflowStatus({ issues, qa, ticket }) {
  const c = countIssues(issues);
  if (ticket && ticket.status === 'VERIFIED') return 'green';
  if (c.errors) return 'red';
  if (c.warnings) return 'amber';
  if (qa?.required && qa?.status === 'ok') return 'green';
  return 'gray';
}

function buildAssessment({ state, issues, qa, mapped }) {
  const c = countIssues(issues);
  const requiredVtyt = safeArray(mapped.alertSupplies);
  return {
    issues,
    errorCount: c.errors,
    warnCount: c.warnings,
    infoCount: c.info,
    bhytRisk: issues.some(x => x.group === 'BHYT' || x.category === 'BHYT' || /BHYT|xuất toán|xuat toan/i.test(`${x.title} ${x.detail}`)),
    canDischarge: Boolean(state.isLeaving && qa?.status === 'ok' && c.errors === 0 && c.warnings === 0),
    isLeaving: Boolean(state.isLeaving),
    has6h: Boolean(mapped.drugSignals?.has6h),
    hasSurgicalTechnicalService: Boolean(mapped.serviceSignals?.hasSurgicalTechnicalService),
    vtyt: requiredVtyt.length ? { state: 'needed', count: requiredVtyt.length, detail: requiredVtyt.slice(0, 4).map(x => x.label).join(', ') } : { state: 'none', count: 0, detail: '' },
    qa,
  };
}

function compatStatusFromTags(state) {
  const tags = new Set(state.tags || []);
  return {
    discharge: tags.has('DISCHARGE'),
    transferWard: tags.has('TRANSFER_WARD'),
    transferHospital: tags.has('TRANSFER_HOSPITAL'),
    death: tags.has('DEATH'),
    surgery: tags.has('PRE_OP') || tags.has('POST_OP') || tags.has('POST_OP_RETURN'),
    continueCare: tags.has('CONTINUE_CARE'),
    newAdmission: tags.has('NEW_ADMISSION'),
  };
}

function buildWorkflowCard(records, ctx, ticket = null, liveBed = null) {
  const state = buildState(records);
  const profile = buildPatientProfile(records);
  const mapped = mapSuppliesForRecords(records, state, ctx);
  const drugs = mergeByKey(mapped.drugs, d => `${d.category || d.routeLabel || ''}|${d.name || ''}|${d.gio_dung || d.time || d.tg_bat_dau || ''}|${d.date || ''}`.toLowerCase());
  const services = mergeByKey(mapped.services, s => `${s.source || ''}|${s.name || ''}|${s.date || ''}`.toLowerCase());
  const billingAudit = buildBillingAudit({ records, services, drugs });
  const surgeryPackageAudit = buildSurgeryPackageAudit({ state, services, supplyPlan: mapped.supplyPlan, surgeryPackageRules: mapped.surgeryPackageRules });
  const qa = runDischargeQA({ profile, state, records, drugs, services, drugSignals: mapped.drugSignals, serviceSignals: mapped.serviceSignals, liveBed, billingAudit, rules: mapped.rules });
  const ruleIssues = runOrderRules({
    state,
    profile,
    drugs,
    services,
    drugSignals: mapped.drugSignals,
    serviceSignals: mapped.serviceSignals,
    supplyPlan: mapped.supplyPlan,
    alertSupplies: mapped.alertSupplies,
    surgeryPackageRules: mapped.surgeryPackageRules,
    surgeryPackageAudit,
    rules: mapped.rules,
  });
  const issues = dedupeIssues([...ruleIssues, ...safeArray(qa.issues)]);
  const issueCounts = countIssues(issues);
  const workflow = { ...state, status: workflowStatus({ issues, qa, ticket }), canPrint: false };
  const assessment = buildAssessment({ state, issues, qa, mapped });
  const latest = latestRecord(records);
  const patientId = profile.patientId || getPatientId(latest);
  const card = {
    key: patientId,
    patientId,
    patientName: profile.name,
    patient: profile.raw || latest,
    profile,
    workflow,
    workflowTags: workflow.tags,
    workflowLabels: workflow.tagLabels,
    workflowStatus: workflow.status,
    status: compatStatusFromTags(workflow),
    issueCounts,
    issues,
    qa,
    ticket,
    ticketStatus: ticket?.status || 'NONE',
    drugs,
    services,
    cares: mapped.cares,
    supplyPlan: mapped.supplyPlan,
    alertSupplies: mapped.alertSupplies,
    drugSignals: mapped.drugSignals,
    serviceSignals: mapped.serviceSignals,
    billingAudit,
    surgeryPackageAudit,
    assessment,
    liveBed,
    days: safeArray(records).map(getRecordDate).filter(Boolean).sort(),
    isLeaving: Boolean(workflow.isLeaving),
    recordsCount: safeArray(records).length,
    updatedAt: new Date().toISOString(),
  };
  card.workflow.canPrint = patientCanPrint(card);
  card.printReady = card.workflow.canPrint;
  const worklist = buildWorklist(card);
  return {
    ...card,
    ...worklist,
    workflow: {
      ...card.workflow,
      summary: worklist.workflowSummary,
      priorityScore: worklist.priorityScore,
      worklistGroup: worklist.worklistGroup,
    },
  };
}

function buildDashboard(ctx, options = {}) {
  const rows = readProcessedRows(ctx);
  const groups = buildPatientGroups(rows);
  const tickets = ticketsByPatient(ctx);
  const liveBedChecks = options.liveBedChecks || {};
  const patients = [...groups.values()].map(records => {
    const id = getPatientId(latestRecord(records));
    return buildWorkflowCard(records, ctx, tickets[id] || null, liveBedChecks[id] || null);
  }).sort((a, b) => {
    const rank = { red: 0, amber: 1, green: 2, gray: 3 };
    return (Number(b.priorityScore || 0) - Number(a.priorityScore || 0))
      || (rank[a.workflowStatus] ?? 9) - (rank[b.workflowStatus] ?? 9)
      || String(a.profile.room).localeCompare(String(b.profile.room), 'vi')
      || String(a.profile.name).localeCompare(String(b.profile.name), 'vi');
  });
  const byPatientId = {};
  for (const p of patients) byPatientId[p.patientId] = p;
  const counts = {
    total: patients.length,
    discharge: patients.filter(p => p.workflow?.isLeaving).length,
    surgery: patients.filter(p => p.workflow?.isSurgery).length,
    inpatient: patients.filter(p => p.workflowTags?.includes('CONTINUE_CARE')).length,
    newAdmission: patients.filter(p => p.workflowTags?.includes('NEW_ADMISSION')).length,
    error: patients.filter(p => p.issueCounts.errors > 0).length,
    warning: patients.filter(p => p.issueCounts.warnings > 0).length,
    green: patients.filter(p => p.workflowStatus === 'green').length,
    readyToPrint: patients.filter(p => p.printReady).length,
    openTickets: patients.filter(p => p.ticket && !['VERIFIED', 'CLOSED', 'NO_ISSUE'].includes(p.ticket.status)).length,
    selfPay: patients.filter(p => (p.billingAudit?.summary?.selfPayCount || 0) > 0).length,
    billingMissing: patients.filter(p => p.qa?.required && p.billingAudit?.summary?.sourceType !== 'billing_table').length,
    surgeryPackageMissing: patients.filter(p => safeArray(p.surgeryPackageAudit?.audits).some(a => safeArray(a.missing).length)).length,
    ...summarizeCounts(patients),
  };
  const printGuard = buildPrintGuard(patients);
  return {
    status: 'ok',
    version: 3,
    generatedAt: new Date().toISOString(),
    counts,
    patients,
    byPatientId,
    printGuard,
  };
}

module.exports = { readProcessedRows, buildDashboard, buildWorkflowCard, countIssues, dedupeIssues };
