// Phạm vi (kho gốc / nghiên cứu riêng), danh sách bảng xem được và các cột định danh cần che trong màn hình Kho nghiên cứu.
const ARCHIVE_SCOPE = '__archive__';

const ARCHIVE_API_SCOPE = 'du_lieu_goc';

const ARCHIVE_DEFAULT_TABLE = 'initial_list';

const STUDY_DEFAULT_TABLE = 'cohort';

const ARCHIVE_TABLES = [
  ['initial_list',   'Dữ liệu ban đầu'],
  ['research_source','Nguồn chuẩn'],
  ['deep_source',    'Dữ liệu gốc sâu'],
  ['patient_master', 'BN chuẩn'],
  ['encounters',     'Đợt điều trị'],
  ['analysis_ready', 'Bảng phân tích'],
  ['analysis_selected', 'Biến đã chọn'],
  ['analysis_final', 'Dataset cuối'],
  ['analysis_ready_encoded', 'Phân tích encoded'],
  ['analysis_selected_encoded', 'Biến đã chọn encoded'],
  ['lab_results_encoded', 'XN encoded'],
  ['lab_dictionary', 'Dict XN'],
  ['imaging_results_encoded', 'CĐHA encoded'],
  ['imaging_dictionary', 'Dict CĐHA'],
  ['medication_orders_encoded', 'Y lệnh encoded'],
  ['drug_dictionary', 'Dict thuốc'],
  ['route_dictionary', 'Dict đường dùng'],
  ['diagnoses_encoded', 'Chẩn đoán encoded'],
  ['diagnosis_dictionary', 'Dict chẩn đoán'],
  ['surgery_results_encoded', 'PT/TT encoded'],
  ['procedure_dictionary', 'Dict PT/TT'],
  ['anesthesia_dictionary', 'Dict vô cảm'],
  ['diagnoses',      'Chẩn đoán'],
  ['patient_day',    'Patient-day'],
  ['lab_results',    'XN chuẩn'],
  ['imaging_results','CĐHA chuẩn'],
  ['surgery_results','PT/TT'],
  ['medication_orders','Y lệnh thuốc'],
  ['clinical_notes', 'Diễn biến'],
  ['patient_extra',  'Thông tin khác'],
  ['extract_status', 'Tiến độ'],
  ['errors',         'Lỗi'],
];

const STUDY_TABLES = [
  ['cohort',         'Danh sách mẫu'],
  ['research_source','Nguồn chuẩn'],
  ['patient_master', 'BN chuẩn'],
  ['encounters',     'Đợt điều trị'],
  ['analysis_ready', 'Bảng phân tích'],
  ['analysis_selected', 'Biến đã chọn'],
  ['analysis_final', 'Dataset cuối'],
  ['analysis_ready_encoded', 'Phân tích encoded'],
  ['analysis_selected_encoded', 'Biến đã chọn encoded'],
  ['lab_results_encoded', 'XN encoded'],
  ['lab_dictionary', 'Dict XN'],
  ['imaging_results_encoded', 'CĐHA encoded'],
  ['imaging_dictionary', 'Dict CĐHA'],
  ['medication_orders_encoded', 'Y lệnh encoded'],
  ['drug_dictionary', 'Dict thuốc'],
  ['route_dictionary', 'Dict đường dùng'],
  ['diagnoses_encoded', 'Chẩn đoán encoded'],
  ['diagnosis_dictionary', 'Dict chẩn đoán'],
  ['surgery_results_encoded', 'PT/TT encoded'],
  ['procedure_dictionary', 'Dict PT/TT'],
  ['anesthesia_dictionary', 'Dict vô cảm'],
  ['diagnoses',      'Chẩn đoán'],
  ['patient_day',    'Patient-day'],
  ['lab_results',    'XN chuẩn'],
  ['imaging_results','CĐHA chuẩn'],
  ['surgery_results','PT/TT'],
  ['medication_orders','Y lệnh thuốc'],
  ['clinical_notes', 'Diễn biến'],
  ['patient_extra',  'Thông tin khác'],
  ['extract_status', 'Tiến độ'],
  ['errors',         'Lỗi'],
  ['patients',       'Raw mẫu'],
  ['xn',             'Raw XN'],
  ['cdha',           'Raw CĐHA'],
];

const TABLES = [...ARCHIVE_TABLES, ...STUDY_TABLES.filter(([id]) => !ARCHIVE_TABLES.some(([a]) => a === id))];

const SENSITIVE_COLUMNS = new Set([
  'Họ tên','Mã BN','Số bệnh án','Mã vào viện','Mã điều trị','Điện thoại','Số CMND','Số CMT','CCCD',
  'patient_name','patient_code','birth_date','address','phone_number','citizen_id','insurance_card','insurance_subject','insurance_type','insurance_valid_from','insurance_valid_to','emr_admission_id','emr_treatment_id',
  'Địa chỉ','Ngày sinh','Số thẻ','Số thẻ BHYT','BHYT','Raw JSON',
]);

function todayInputDate() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function tablesForScope(isArchive) { return isArchive ? ARCHIVE_TABLES : STUDY_TABLES; }

function tableIdsForScope(isArchive) { return tablesForScope(isArchive).map(([id]) => id); }

function defaultTableForScope(isArchive) { return isArchive ? ARCHIVE_DEFAULT_TABLE : STUDY_DEFAULT_TABLE; }

function tableLabel(id, isArchive) {
  return tablesForScope(isArchive).find(([k]) => k === id)?.[1]
      || TABLES.find(([k]) => k === id)?.[1] || 'Bảng';
}

function primaryTableAfterRun(_isArchive = false) { return 'analysis_ready'; }

function datasetCount(source, id, isArchive = false) {
  if (isArchive && id === 'initial_list') return source?.latest_run?.outputs?.initial_list || source?.source_count || 0;
  if (isArchive && id === 'deep_source')  return source?.latest_run?.outputs?.deep_source  || source?.latest_run?.outputs?.patients || 0;
  if (isArchive && id === 'patients')     return source?.latest_run?.outputs?.patients || 0;
  if (id === 'cohort') return isArchive ? source?.source_count || 0 : source?.cohort_count || 0;
  return source?.latest_run?.outputs?.[id] || 0;
}

export {
  ARCHIVE_SCOPE,
  ARCHIVE_API_SCOPE,
  ARCHIVE_DEFAULT_TABLE,
  STUDY_DEFAULT_TABLE,
  ARCHIVE_TABLES,
  STUDY_TABLES,
  TABLES,
  SENSITIVE_COLUMNS,
  todayInputDate,
  tablesForScope,
  tableIdsForScope,
  defaultTableForScope,
  tableLabel,
  primaryTableAfterRun,
  datasetCount,
};
