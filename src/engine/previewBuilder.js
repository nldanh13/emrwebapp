import { isExitCase, getVTYTSearchRange } from '../parsers/raKhoa.js';
import { buildVTYTPreviewPlan } from './vtytRuleEngine.js';

export function sanitizePatientForPreview(patient = {}) {
  return {
    display_name: patient.display_name || patient.hoTenAnDanh || '[Ẩn tên]',
    ma_bn: patient.maBnAnDanh || patient.ma_bn_an_danh || '[Ẩn mã]',
    phong: patient.phong || patient.vi_tri || '',
    tuoi: patient.tuoi || patient.age || '',
    status: patient.status || '',
  };
}

export function summarizeChiPhiRows(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.nhom_chi_phi || 'Khác';
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  return Array.from(groups.entries()).map(([group, count]) => ({ group, count }));
}

export function buildAdminNursePreview({
  patient = {},
  raKhoaInfo = {},
  popupOrders = [],
  declarations = [],
  addedRows = [],
  previousVTYTItems = [],
  surgeryRecords = [],
  bedTimeline = [],
  chiPhiRows = [],
  currentDate = new Date(),
} = {}) {
  const exitCase = isExitCase(raKhoaInfo);
  const timeRange = getVTYTSearchRange(patient, raKhoaInfo);
  const vtyt = buildVTYTPreviewPlan({
    patient,
    popupOrders,
    declarations,
    addedRows,
    previousVTYTItems,
    surgeryRecords,
    currentDate,
  });

  const plannedActions = vtyt.missing.map((item) => ({
    type: 'add_vtyt',
    label: `Thêm ${item.name} x${item.missing_quantity}`,
    catalog_key: item.key,
    searchKeyword: item.searchKeyword,
    quantity: item.missing_quantity,
    reasons: item.reasons,
  }));

  return {
    patient: sanitizePatientForPreview(patient),
    ra_khoa_status: raKhoaInfo.status || null,
    discharge: raKhoaInfo.discharge || {},
    is_exit_case: exitCase,
    time_range: timeRange,
    popup_orders_count: popupOrders.length,
    declarations_count: declarations.length,
    surgery_count: surgeryRecords.length,
    bed_timeline_count: bedTimeline.length,
    chi_phi_summary: summarizeChiPhiRows(chiPhiRows),
    vtyt,
    planned_actions: plannedActions,
    status: vtyt.status,
  };
}
