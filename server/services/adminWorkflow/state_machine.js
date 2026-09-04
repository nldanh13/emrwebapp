'use strict';

const { TAGS, TAG_LABELS, WORKFLOWS, WORKFLOW_LABELS } = require('./constants');
const {
  normText,
  safeArray,
  uniq,
  getFirstValue,
  getPatientId,
  getPatientName,
  getRoom,
  getDoctor,
  getDiagnosis,
  parseVNDate,
  getRecordDate,
  latestRecord,
  collectServicesFromRecord,
  collectDrugsFromSource,
  isSurgicalServiceName,
} = require('./common');

function getExitInfo(record) {
  const xuTriRaw = String(getFirstValue(record, ['xu_tri', 'xuTri', 'xử trí', 'Xử trí', 'ket_qua_dieu_tri', 'tinh_trang_ra_vien']) || '').trim();
  const exitRaw = String(getFirstValue(record, ['ra_vien', 'ngay_ra_vien', 'gio_ra_vien', 'thoi_gian_ra_vien', 'chuyen_khoa', 'chuyen_vien', 'tu_vong']) || '').trim();
  const noteRaw = String(getFirstValue(record, ['ghi_chu', 'note']) || '').trim();
  const statusRaw = String(getFirstValue(record, ['status', 'trang_thai', 'trạng thái']) || '').trim();
  const timeRaw = String(getFirstValue(record, ['thoi_gian_ra_vien', 'gio_ra_vien', 'ngay_ra_vien', 'tg_ra', 'exit_time', 'discharge_time']) || '').trim();

  const actionText = normText([xuTriRaw, exitRaw, noteRaw].join(' '));
  const statusText = normText(statusRaw);
  const text = normText([actionText, statusText].join(' '));
  const dateMatch = timeRaw.match(/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/);
  const hourMatch = timeRaw.match(/\d{1,2}:\d{1,2}/);

  // Không coi một ca là ra viện chỉ vì dòng danh sách còn lưu nhãn "xu_tri" cũ.
  // Với BN vẫn ở trạng thái "Đang thực hiện", phải có giờ/ngày ra thật mới gắn tag ra viện/chuyển khoa.
  const activeInpatient = /dang thuc hien|dang dieu tri|dang nam vien/.test(statusText);
  const hasExitTime = Boolean(timeRaw || dateMatch || hourMatch);
  const exitConfirmed = !activeInpatient || hasExitTime;

  const dischargeHit = /(^|\s)(ra vien|xuat vien|cho ra vien)(\s|$)/.test(actionText);
  const plannedDischargeOnly = /du kien ra vien|hen ra vien/.test(actionText) && !hasExitTime;
  const transferWardHit = /chuyen khoa|chuyen vien noi bo|ra khoa/.test(actionText);
  const transferHospitalHit = /(?<!noi bo\s{0,5})chuyen vien(?!\s*noi\s*bo)|chuyen tuyen|chuyen benh vien/.test(actionText);
  const deathHit = /tu vong|chet|xin ve|nang ve/.test(actionText);

  return {
    text,
    xuTri: xuTriRaw,
    rawTime: timeRaw,
    date: dateMatch ? dateMatch[0] : '',
    time: hourMatch ? hourMatch[0] : '',
    discharge: exitConfirmed && dischargeHit && !plannedDischargeOnly,
    transferWard: exitConfirmed && transferWardHit,
    transferHospital: exitConfirmed && transferHospitalHit,
    death: exitConfirmed && deathHit,
  };
}

function detectAdmission(record, records) {
  const text = normText([
    getFirstValue(record, ['nguon_vao', 'noi_gioi_thieu', 'ly_do_vao_vien', 'hinh_thuc_vao_vien', 'tuyen_vao', 'admission_source']),
    getFirstValue(record, ['so_chuyen_tuyen', 'giay_chuyen_tuyen', 'referral', 'emergency', 'cap_cuu']),
    records.map(r => getFirstValue(r, ['nguon_vao', 'noi_gioi_thieu', 'ly_do_vao_vien', 'hinh_thuc_vao_vien', 'admission_source'])).join(' '),
  ].join(' '));
  const admissionTime = String(getFirstValue(record, ['thoi_gian_vao_khoa', 'tg_vao', 'thoi_gian_vao', 'admission_time', 'ngay_vao_vien', 'ngay_vao_khoa']) || '').trim();
  const dayValues = uniq(records.map(getRecordDate));
  const admissionDate = parseVNDate(admissionTime);
  const hasTodayOnly = dayValues.length <= 1;
  return {
    admissionTime,
    emergency: /cap cuu|khoa cap cuu|emergency/.test(text),
    referral: /chuyen tuyen|giay chuyen tuyen|chuyen vien den|tuyen duoi/.test(text),
    newAdmission: /moi nhap|vua vao|nhap vien|vao khoa|cap cuu/.test(text) || Boolean(admissionDate && hasTodayOnly),
    sourceText: text,
  };
}

function detectSurgery(records) {
  const services = records.flatMap(collectServicesFromRecord);
  const drugs = records.flatMap(collectDrugsFromSource);
  const allText = normText([
    services.map(s => `${s.name} ${s.source} ${s.status || ''}`).join(' '),
    drugs.map(d => `${d.name} ${d.routeLabel || ''} ${d.note || ''}`).join(' '),
    records.map(r => [r.dien_bien, r.ghi_chu, r.status, r.trang_thai, r.phau_thuat, r.pttt].filter(Boolean).join(' ')).join(' '),
  ].join(' '));
  const surgicalServices = services.filter(s => isSurgicalServiceName(s.name));
  const preOp = /chuan bi phau thuat|truoc mo|tien phau|cho mo|du kien mo|chuyen mo|len phong mo/.test(allText);
  const postOp = /da phau thuat|sau mo|hau phau|pt xong|mo xong|ve khoa sau mo|nhap khoa sau mo|tu phong mo ve/.test(allText) || surgicalServices.length > 0;
  const postOpReturn = /pt xong nhap khoa|ve khoa sau mo|tu phong mo ve|hau phau ve khoa/.test(allText);
  return { preOp, postOp, postOpReturn, surgicalServices, services };
}

function buildPatientProfile(records) {
  const list = safeArray(records);
  const latest = latestRecord(list);
  const exit = getExitInfo(latest);
  const admission = detectAdmission(latest, list);
  const bhytText = String(getFirstValue(latest, ['bhyt', 'BHYT', 'ma_bhyt', 'so_the_bhyt', 'doi_tuong', 'insurance', 'insurance_code']) || '').trim();
  const room = getRoom(latest) || getRoom(list[0] || {});
  return {
    patientId: getPatientId(latest) || getPatientId(list[0] || {}),
    name: getPatientName(latest) || getPatientName(list[0] || {}),
    room,
    doctor: getDoctor(latest) || getDoctor(list[0] || {}),
    diagnosis: getDiagnosis(latest) || getDiagnosis(list[0] || {}),
    admission,
    exit,
    bhyt: {
      has: Boolean(bhytText && !/khong|không|tu tuc|tự túc/.test(normText(bhytText))),
      code: bhytText,
    },
    raw: latest,
  };
}

function buildState(records) {
  const list = safeArray(records);
  const latest = latestRecord(list);
  const exit = getExitInfo(latest);
  const admission = detectAdmission(latest, list);
  const surgery = detectSurgery(list);
  const tags = [];
  const reasons = [];

  const add = (tag, reason) => {
    if (!tags.includes(tag)) tags.push(tag);
    if (reason) reasons.push(reason);
  };

  if (exit.death) add(TAGS.DEATH, 'Có dấu hiệu tử vong/xin về/nặng về');
  if (exit.transferHospital) add(TAGS.TRANSFER_HOSPITAL, 'Có xử trí chuyển viện/chuyển tuyến');
  if (exit.transferWard) add(TAGS.TRANSFER_WARD, 'Có xử trí chuyển khoa/ra khoa');
  if (exit.discharge) add(TAGS.DISCHARGE, 'Có xử trí xuất viện/ra viện');
  if (surgery.preOp) add(TAGS.PRE_OP, 'Có dấu hiệu chuẩn bị phẫu thuật');
  if (surgery.postOp) add(TAGS.POST_OP, surgery.surgicalServices.length ? 'Có PTTT/DVKT phẫu thuật' : 'Có dấu hiệu đã đi phẫu thuật');
  if (surgery.postOpReturn) add(TAGS.POST_OP_RETURN, 'Có dấu hiệu PT xong nhập khoa');
  if (admission.newAdmission) add(TAGS.NEW_ADMISSION, 'Có dấu hiệu mới nhập viện/vào khoa');
  if (!tags.some(t => [TAGS.DISCHARGE, TAGS.TRANSFER_WARD, TAGS.TRANSFER_HOSPITAL, TAGS.DEATH].includes(t))) {
    add(TAGS.CONTINUE_CARE, 'Chưa có dấu hiệu ra khỏi khoa');
  }

  const workflows = [];
  if (tags.some(t => [TAGS.DISCHARGE, TAGS.TRANSFER_WARD, TAGS.TRANSFER_HOSPITAL, TAGS.DEATH].includes(t))) workflows.push(WORKFLOWS.DISCHARGE_QA);
  if (tags.some(t => [TAGS.PRE_OP, TAGS.POST_OP, TAGS.POST_OP_RETURN].includes(t))) workflows.push(WORKFLOWS.SURGERY_REVIEW);
  if (tags.includes(TAGS.NEW_ADMISSION)) workflows.push(WORKFLOWS.ADMISSION_REVIEW);
  if (tags.includes(TAGS.CONTINUE_CARE)) workflows.push(WORKFLOWS.INPATIENT_REVIEW);

  const priority = tags.some(t => [TAGS.DISCHARGE, TAGS.TRANSFER_HOSPITAL, TAGS.DEATH].includes(t)) ? 'high'
    : tags.some(t => [TAGS.TRANSFER_WARD, TAGS.POST_OP, TAGS.PRE_OP, TAGS.NEW_ADMISSION].includes(t)) ? 'medium'
    : 'normal';

  return {
    tags,
    tagLabels: tags.map(t => TAG_LABELS[t] || t),
    workflows: uniq(workflows),
    workflowLabels: uniq(workflows).map(w => WORKFLOW_LABELS[w] || w),
    priority,
    reasons: uniq(reasons),
    isLeaving: tags.some(t => [TAGS.DISCHARGE, TAGS.TRANSFER_WARD, TAGS.TRANSFER_HOSPITAL, TAGS.DEATH].includes(t)),
    isSurgery: tags.some(t => [TAGS.PRE_OP, TAGS.POST_OP, TAGS.POST_OP_RETURN].includes(t)),
    skipRoutineInpatientSupplies: tags.includes(TAGS.POST_OP) && !tags.includes(TAGS.CONTINUE_CARE),
    onlyMapSurgeryDayOrders: tags.includes(TAGS.POST_OP),
    surgery,
    detectedAt: new Date().toISOString(),
  };
}

module.exports = { buildState, buildPatientProfile, getExitInfo, detectAdmission, detectSurgery };
