'use strict';

const TAGS = Object.freeze({
  DISCHARGE: 'DISCHARGE',
  TRANSFER_WARD: 'TRANSFER_WARD',
  TRANSFER_HOSPITAL: 'TRANSFER_HOSPITAL',
  DEATH: 'DEATH',
  PRE_OP: 'PRE_OP',
  POST_OP: 'POST_OP',
  POST_OP_RETURN: 'POST_OP_RETURN',
  NEW_ADMISSION: 'NEW_ADMISSION',
  CONTINUE_CARE: 'CONTINUE_CARE',
});

const TAG_LABELS = Object.freeze({
  DISCHARGE: 'Xuất viện',
  TRANSFER_WARD: 'Chuyển khoa',
  TRANSFER_HOSPITAL: 'Chuyển viện',
  DEATH: 'Tử vong',
  PRE_OP: 'Chuẩn bị PT',
  POST_OP: 'Đã đi PT',
  POST_OP_RETURN: 'PT xong nhập khoa',
  NEW_ADMISSION: 'Mới nhập viện',
  CONTINUE_CARE: 'Tiếp tục điều trị',
});

const WORKFLOWS = Object.freeze({
  DISCHARGE_QA: 'DISCHARGE_QA',
  SURGERY_REVIEW: 'SURGERY_REVIEW',
  INPATIENT_REVIEW: 'INPATIENT_REVIEW',
  ADMISSION_REVIEW: 'ADMISSION_REVIEW',
  DELTA_REVIEW: 'DELTA_REVIEW',
});

const WORKFLOW_LABELS = Object.freeze({
  DISCHARGE_QA: 'QA hồ sơ xuất/chuyển',
  SURGERY_REVIEW: 'Rà soát phẫu thuật',
  INPATIENT_REVIEW: 'Rà soát lưu trú',
  ADMISSION_REVIEW: 'Rà soát nhập viện mới',
  DELTA_REVIEW: 'Rà soát phát sinh',
});

const ISSUE_SEVERITY_RANK = Object.freeze({ error: 3, warn: 2, info: 1 });

const ISSUE_GROUPS = Object.freeze({
  DRUG: 'Thuốc',
  SUPPLY: 'VTYT',
  SURGERY_PACKAGE: 'Gói PTTT',
  BHYT: 'BHYT',
  COST: 'Bảng kê',
  BED: 'Tiền giường',
  CLS_DVKT: 'CLS/DVKT',
  DISCHARGE_PAPER: 'Giấy ra viện',
  SICK_LEAVE: 'Giấy nghỉ ốm',
  FOLLOW_UP: 'Giấy hẹn tái khám',
  ADMIN: 'Hành chánh',
  SNAPSHOT: 'Snapshot',
  SYSTEM: 'Hệ thống',
});

const TICKET_STATUS = Object.freeze({
  OPEN: 'OPEN',
  SENT: 'SENT',
  VERIFYING: 'VERIFYING',
  VERIFIED: 'VERIFIED',
  PARTIAL: 'PARTIAL',
  STALE: 'STALE',
  CLOSED: 'CLOSED',
  NO_ISSUE: 'NO_ISSUE',
});

const SNAPSHOT_TTL_HOURS = 12;
const SNAPSHOT_TTL_MS = SNAPSHOT_TTL_HOURS * 60 * 60 * 1000;

module.exports = {
  TAGS,
  TAG_LABELS,
  WORKFLOWS,
  WORKFLOW_LABELS,
  ISSUE_SEVERITY_RANK,
  ISSUE_GROUPS,
  TICKET_STATUS,
  SNAPSHOT_TTL_HOURS,
  SNAPSHOT_TTL_MS,
};
