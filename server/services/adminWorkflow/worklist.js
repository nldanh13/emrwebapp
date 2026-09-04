'use strict';

const { TAGS, ISSUE_GROUPS } = require('./constants');
const { safeArray, normText, getFirstValue, parseVNDate } = require('./common');
const { patientCanPrint } = require('./print_guard');

function text(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function hasValue(value) {
  const s = text(value);
  return Boolean(s && !/^[-–—]+$/.test(s) && !/^(chua|chưa|khong ro|không rõ|null|undefined)$/i.test(normText(s)));
}

function hasTag(card, tag) {
  return safeArray(card?.workflowTags || card?.workflow?.tags).includes(tag);
}

function hasAnyTag(card, tags) {
  return safeArray(tags).some(tag => hasTag(card, tag));
}

function issueCounts(card) {
  const c = card?.issueCounts || {};
  const issues = safeArray(card?.issues || card?.assessment?.issues);
  return {
    errors: Number(c.errors ?? issues.filter(x => x?.severity === 'error').length ?? 0),
    warnings: Number(c.warnings ?? issues.filter(x => x?.severity === 'warn').length ?? 0),
    info: Number(c.info ?? issues.filter(x => x?.severity === 'info').length ?? 0),
  };
}

function severityTone(card) {
  const c = issueCounts(card);
  if (c.errors > 0) return 'red';
  if (c.warnings > 0) return 'yellow';
  if (patientCanPrint(card) || card?.workflowStatus === 'green' || card?.printReady) return 'green';
  return 'blue';
}

function exitKind(card) {
  if (hasTag(card, TAGS.DEATH)) return 'death';
  if (hasTag(card, TAGS.TRANSFER_HOSPITAL)) return 'transfer_hospital';
  if (hasTag(card, TAGS.TRANSFER_WARD)) return 'transfer_ward';
  if (hasTag(card, TAGS.DISCHARGE)) return 'discharge';
  return '';
}

function exitLabel(kind) {
  const map = {
    death: 'Tử vong/xin về',
    transfer_hospital: 'Chuyển viện',
    transfer_ward: 'Chuyển khoa',
    discharge: 'Ra viện',
  };
  return map[kind] || '';
}

function ownerFromIssue(issue) {
  const hay = normText(`${issue?.group} ${issue?.category} ${issue?.title} ${issue?.detail} ${issue?.action}`);
  if (/bac si|bs|chan doan|xu tri|giay ra vien|loi dan|tai kham|nghi om|y lenh/.test(hay)) return 'Bác sĩ điều trị';
  if (/bhyt|bang ke|vien phi|tu tuc|xuat toan|chi phi/.test(hay)) return 'Điều dưỡng hành chánh/viện phí';
  if (/giuong|buong/.test(hay)) return 'Điều dưỡng hành chánh';
  if (/vtyt|vat tu|tieu hao/.test(hay)) return 'Điều dưỡng phụ trách VTYT';
  return 'Điều dưỡng hành chánh';
}

function normalizeIssueForAction(issue) {
  return {
    id: issue?.id || issue?.code || `${issue?.group || ''}-${issue?.title || ''}`,
    code: text(issue?.code),
    severity: issue?.severity === 'error' ? 'error' : issue?.severity === 'info' ? 'info' : 'warn',
    group: text(issue?.group || issue?.category || 'Hành chánh'),
    title: text(issue?.title || 'Cần kiểm tra'),
    detail: text(issue?.detail || issue?.evidence || ''),
    action: text(issue?.action || 'Kiểm tra lại trên EMR.'),
    owner: ownerFromIssue(issue),
  };
}

function raw(card) {
  return card?.patient || card?.profile?.raw || {};
}

function adminProfile(card) {
  const p = card?.profile || {};
  const r = raw(card);
  const admission = p.admission || {};
  const exit = p.exit || {};
  const dischargeKind = exitKind(card);
  return {
    patientId: text(card?.patientId || p.patientId || getFirstValue(r, ['ma_bn', 'patientId', 'Mã BN', 'Mã YT'])),
    name: text(card?.patientName || p.name || getFirstValue(r, ['ho_ten', 'name', 'ten_nguoi_benh'])),
    room: text(p.room || r.so_phong || r.phong || r.Vi_Tri || r.giuong),
    bed: text(r.giuong || r.bed || r.so_giuong || p.bed || p.room),
    diagnosis: text(p.diagnosis || r.chan_doan || r.chuan_doan || r.diagnosis),
    doctor: text(p.doctor || r.bac_si_dieu_tri || r.bac_si || r.doctor || r.bs_dieu_tri),
    admission: {
      enteredAt: text(admission.admissionTime || r.thoi_gian_vao_khoa || r.tg_vao || r.ngay_vao_vien || r.admission_time),
      ward: text(r.khoa_dieu_tri || r.ten_khoa_dieu_tri || r.department || r.ward),
      fromWard: text(r.khoa_chuyen_den || r.khoa_chuyen_tu || r.noi_chuyen_den || r.from_ward),
      emergency: Boolean(admission.emergency),
      referral: Boolean(admission.referral),
    },
    discharge: {
      kind: dischargeKind,
      label: exitLabel(dischargeKind),
      hasOrder: Boolean(dischargeKind),
      outcome: text(exit.xuTri || r.xu_tri || r.ket_qua_dieu_tri || r.tinh_trang_ra_vien),
      at: text(exit.rawTime || r.thoi_gian_ra_vien || r.gio_ra_vien || r.ngay_ra_vien || r.tg_ra),
      date: text(exit.date || r.ngay_ra_vien),
      time: text(exit.time || r.gio_ra_vien),
      targetWard: text(r.khoa_chuyen_den || r.khoa_den || r.chuyen_den || r.target_ward),
    },
    insurance: {
      hasBHYT: Boolean(p.bhyt?.has),
      code: text(p.bhyt?.code || r.bhyt || r.BHYT || r.ma_bhyt || r.so_the_bhyt || r.doi_tuong),
      status: p.bhyt?.has ? 'valid_or_present' : 'missing_or_self_pay',
    },
    billing: {
      sourceType: text(card?.billingAudit?.summary?.sourceType),
      totalAmount: Number(card?.billingAudit?.summary?.totalAmount || 0),
      selfPayCount: Number(card?.billingAudit?.summary?.selfPayCount || 0),
      missing: Boolean(card?.qa?.required && card?.billingAudit?.summary?.sourceType !== 'billing_table'),
    },
  };
}

function addChecklistItem(list, group, key, label, ok, detail = '', owner = 'Điều dưỡng hành chánh') {
  list.push({
    group,
    key,
    label,
    ok: Boolean(ok),
    status: ok ? 'done' : 'missing',
    detail: text(detail),
    owner,
  });
}

function hasDateAndHour(value) {
  const s = text(value);
  if (!s) return false;
  const hasDate = /\d{1,2}\s*[\/\-]\s*\d{1,2}(?:\s*[\/\-]\s*\d{2,4})?/.test(s) || parseVNDate(s);
  const hasHour = /\b\d{1,2}:\d{2}\b/.test(s);
  return Boolean(hasDate && hasHour);
}

function buildChecklist(card) {
  const p = adminProfile(card);
  const items = [];
  const leaving = Boolean(p.discharge.kind);
  const transfer = ['transfer_ward', 'transfer_hospital'].includes(p.discharge.kind);
  const surgery = Boolean(card?.workflow?.isSurgery || hasAnyTag(card, [TAGS.PRE_OP, TAGS.POST_OP, TAGS.POST_OP_RETURN]));
  const newAdmission = hasTag(card, TAGS.NEW_ADMISSION);
  const billing = p.billing || {};

  addChecklistItem(items, 'Thông tin nền', 'patient-id', 'Có mã người bệnh', hasValue(p.patientId));
  addChecklistItem(items, 'Thông tin nền', 'room-bed', 'Có phòng/giường', hasValue(p.room || p.bed));
  addChecklistItem(items, 'Thông tin nền', 'diagnosis', 'Có chẩn đoán chính', hasValue(p.diagnosis), '', 'Bác sĩ điều trị');
  addChecklistItem(items, 'Thông tin nền', 'doctor', 'Có bác sĩ điều trị', hasValue(p.doctor), '', 'Bác sĩ điều trị');
  addChecklistItem(items, 'Thông tin nền', 'insurance', 'Có thông tin BHYT/đối tượng', hasValue(p.insurance.code), p.insurance.hasBHYT ? 'Có thẻ/đối tượng BHYT' : 'Thiếu hoặc tự túc');

  if (newAdmission) {
    addChecklistItem(items, 'Mới nhập khoa', 'admission-time', 'Có giờ vào khoa', hasValue(p.admission.enteredAt), p.admission.enteredAt);
    addChecklistItem(items, 'Mới nhập khoa', 'admission-ward', 'Có khoa điều trị', hasValue(p.admission.ward), p.admission.ward);
    addChecklistItem(items, 'Mới nhập khoa', 'admission-billing', 'Đã đối chiếu BHYT/chuyển tuyến', p.insurance.hasBHYT || !p.admission.referral, p.insurance.code || 'Cần kiểm giấy chuyển tuyến/BHYT');
  }

  if (leaving) {
    addChecklistItem(items, 'Ra/chuyển khoa', 'exit-order', `Có xử trí ${p.discharge.label || 'ra/chuyển'}`, p.discharge.hasOrder, p.discharge.outcome, 'Bác sĩ điều trị');
    addChecklistItem(items, 'Ra/chuyển khoa', 'exit-time', 'Có ngày giờ ra/chuyển', hasDateAndHour(p.discharge.at || `${p.discharge.date} ${p.discharge.time}`), p.discharge.at, 'Bác sĩ điều trị');
    addChecklistItem(items, 'Ra/chuyển khoa', 'exit-outcome', 'Có kết quả điều trị/xử trí', hasValue(p.discharge.outcome), p.discharge.outcome, 'Bác sĩ điều trị');
    addChecklistItem(items, 'Ra/chuyển khoa', 'exit-target', 'Có khoa/đơn vị chuyển đến nếu chuyển khoa/chuyển viện', !transfer || hasValue(p.discharge.targetWard), p.discharge.targetWard, 'Bác sĩ điều trị');
    addChecklistItem(items, 'Ra/chuyển khoa', 'billing-table', 'Có bảng kê/chi phí được đối chiếu', billing.sourceType === 'billing_table' || !billing.missing, billing.sourceType || 'Chưa thấy bảng kê');
    addChecklistItem(items, 'Ra/chuyển khoa', 'print-guard', 'Đủ điều kiện in/chốt hồ sơ', patientCanPrint(card), patientCanPrint(card) ? 'Không còn lỗi đỏ/vàng' : 'Còn lỗi chặn hoặc phiếu sửa chưa nghiệm thu');
  }

  if (surgery) {
    const audit = card?.surgeryPackageAudit || {};
    const pct = Number(audit.completionPct || 0);
    addChecklistItem(items, 'PTTT', 'surgery-service', 'Có chỉ định PTTT/DVKT', safeArray(card?.services).length > 0, safeArray(card?.services).slice(0, 2).map(s => s.name).join(' · '));
    addChecklistItem(items, 'PTTT', 'surgery-package', 'Đối chiếu gói dụng cụ PTTT', !audit.required || pct >= 100, audit.required ? `${pct || 0}%` : 'Không bắt buộc theo dictionary hiện tại');
    addChecklistItem(items, 'PTTT', 'surgery-supplies', 'Đối chiếu VTYT/thuốc dùng kèm', safeArray(card?.supplyPlan).length === 0 || safeArray(card?.alertSupplies).length === 0, safeArray(card?.alertSupplies).slice(0, 3).map(x => x.label).join(' · '));
  }

  const done = items.filter(x => x.ok).length;
  return {
    items,
    done,
    total: items.length,
    percent: items.length ? Math.round((done / items.length) * 100) : 0,
    missing: items.filter(x => !x.ok),
  };
}

function primaryMainState(card) {
  const tone = severityTone(card);
  if (tone === 'green' && (card?.workflow?.isLeaving || card?.printReady)) return 'completed';
  if (hasTag(card, TAGS.DEATH)) return 'death_case';
  if (hasTag(card, TAGS.TRANSFER_HOSPITAL)) return 'transfer_pending';
  if (hasTag(card, TAGS.TRANSFER_WARD)) return 'transfer_pending';
  if (hasTag(card, TAGS.DISCHARGE)) return 'discharge_pending';
  if (card?.workflow?.isSurgery || hasAnyTag(card, [TAGS.PRE_OP, TAGS.POST_OP, TAGS.POST_OP_RETURN])) return 'surgery_pending';
  if (hasTag(card, TAGS.NEW_ADMISSION)) return 'new_admission';
  if (tone === 'green') return 'completed';
  return 'active_treatment';
}

function stateLabel(state, card) {
  const map = {
    completed: patientCanPrint(card) ? 'Sẵn sàng in/chốt' : 'Đã ổn',
    death_case: 'Hồ sơ tử vong/xin về',
    transfer_pending: hasTag(card, TAGS.TRANSFER_HOSPITAL) ? 'Chuyển viện' : 'Chuyển khoa',
    discharge_pending: 'Ra viện',
    surgery_pending: 'Phẫu thuật/thủ thuật',
    new_admission: 'Mới nhập khoa',
    active_treatment: 'Tiếp tục điều trị',
  };
  return map[state] || 'Theo dõi';
}

function findNextAction(card, checklist) {
  const issue = safeArray(card?.issues).filter(x => x?.severity !== 'info')[0];
  if (issue) {
    const normalized = normalizeIssueForAction(issue);
    return { text: normalized.action || normalized.title, owner: normalized.owner, reason: normalized.title };
  }
  const missing = safeArray(checklist?.missing)[0];
  if (missing) return { text: `Bổ sung: ${missing.label}`, owner: missing.owner, reason: missing.detail };
  if (patientCanPrint(card)) return { text: 'Có thể in/chốt hồ sơ theo quy trình.', owner: 'Điều dưỡng hành chánh', reason: 'Không còn lỗi đỏ/vàng.' };
  return { text: 'Tiếp tục theo dõi và đối chiếu y lệnh trong ca.', owner: 'Điều dưỡng hành chánh', reason: '' };
}

function worklistGroup(card, tone, mainState) {
  const issues = safeArray(card?.issues);
  const hasBilling = issues.some(x => [ISSUE_GROUPS.BHYT, ISSUE_GROUPS.COST, 'BHYT', 'Bảng kê'].includes(x?.group || x?.category));
  if (tone === 'red') return 'urgent';
  if (mainState === 'completed') return 'completed';
  if (['discharge_pending', 'transfer_pending', 'death_case'].includes(mainState)) return 'leaving_today';
  if (hasBilling || card?.assessment?.bhytRisk || card?.billingAudit?.summary?.selfPayCount) return 'billing';
  if (tone === 'yellow') return 'missing_docs';
  if (mainState === 'surgery_pending') return 'surgery';
  if (mainState === 'new_admission') return 'new_admission';
  return 'active_treatment';
}

function priorityScore(card, checklist, mainState, group) {
  const c = issueCounts(card);
  let score = c.errors * 100 + c.warnings * 20;
  if (['discharge_pending', 'transfer_pending', 'death_case'].includes(mainState)) score += 55;
  if (group === 'billing' || card?.assessment?.bhytRisk) score += 30;
  if (mainState === 'surgery_pending') score += 25;
  if (mainState === 'new_admission') score += 10;
  score += safeArray(checklist?.missing).length * 6;
  if (patientCanPrint(card)) score = Math.max(0, score - 50);
  return score;
}

function buildWorklist(card) {
  const profile = adminProfile(card);
  const checklist = buildChecklist(card);
  const mainState = primaryMainState(card);
  const tone = severityTone(card);
  const group = worklistGroup(card, tone, mainState);
  const next = findNextAction(card, checklist);
  const actions = safeArray(card?.issues).filter(x => x?.severity !== 'info').map(normalizeIssueForAction);
  const score = priorityScore(card, checklist, mainState, group);
  const summary = {
    mainState,
    label: stateLabel(mainState, card),
    tone,
    group,
    groupLabel: groupLabel(group),
    priorityScore: score,
    priority: score >= 100 ? 'high' : score >= 40 ? 'medium' : 'normal',
    mainReason: next.reason || safeArray(card?.workflow?.reasons)[0] || '',
    nextAction: next.text,
    owner: next.owner,
    canPrint: patientCanPrint(card),
    blockers: safeArray(card?.issues).filter(x => x?.severity === 'error').length,
  };
  return { adminProfile: profile, checklist, workflowSummary: summary, actionItems: actions, worklistGroup: group, priorityScore: score };
}

function groupLabel(group) {
  const map = {
    urgent: 'Cần xử lý ngay',
    leaving_today: 'Ra/chuyển khoa hôm nay',
    missing_docs: 'Thiếu hồ sơ',
    billing: 'Bảng kê/BHYT',
    surgery: 'PTTT',
    new_admission: 'Mới nhập khoa',
    active_treatment: 'Tiếp tục điều trị',
    completed: 'Đã hoàn tất',
  };
  return map[group] || 'Theo dõi';
}

function summarizeCounts(patients) {
  const list = safeArray(patients);
  const byGroup = group => list.filter(p => p.worklistGroup === group).length;
  return {
    urgent: byGroup('urgent'),
    dischargeToday: list.filter(p => ['discharge_pending', 'transfer_pending', 'death_case'].includes(p.workflowSummary?.mainState)).length,
    transferToday: list.filter(p => p.workflowSummary?.mainState === 'transfer_pending').length,
    missingDocs: byGroup('missing_docs'),
    billingIssues: byGroup('billing'),
    surgery: byGroup('surgery'),
    newAdmission: byGroup('new_admission'),
    activeTreatment: byGroup('active_treatment'),
    completed: byGroup('completed'),
    readyToPrint: list.filter(p => p.workflowSummary?.canPrint).length,
    needDoctorUpdate: list.filter(p => safeArray(p.actionItems).some(x => x.owner === 'Bác sĩ điều trị')).length,
  };
}

module.exports = {
  buildWorklist,
  summarizeCounts,
  adminProfile,
  buildChecklist,
  severityTone,
};
