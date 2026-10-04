// Phạm vi (kho gốc / nghiên cứu riêng), danh sách bảng và nhãn bảng của màn hình Kho nghiên cứu.
const ARCHIVE_SCOPE = '__archive__';

const ARCHIVE_API_SCOPE = 'du_lieu_goc';

const ARCHIVE_TABLES = [
  ['initial_list',   'Dữ liệu ban đầu'],
  ['research_source','Nguồn chuẩn'],
  ['deep_source',    'Dữ liệu gốc đã lấy sâu'],
  ['patient_master', 'Người bệnh'],
  ['encounters',     'Đợt điều trị'],
  ['analysis_ready', 'Bảng phân tích'],
  ['analysis_selected', 'Biến đã chọn'],
  ['analysis_final', 'Dataset cuối'],
  ['analysis_ready_encoded', 'Bảng phân tích (mã hóa)'],
  ['analysis_selected_encoded', 'Biến đã chọn (mã hóa)'],
  ['lab_results_encoded', 'Xét nghiệm (mã hóa)'],
  ['lab_dictionary', 'Từ điển xét nghiệm'],
  ['imaging_results_encoded', 'CĐHA (mã hóa)'],
  ['imaging_dictionary', 'Từ điển CĐHA'],
  ['medication_orders_encoded', 'Y lệnh (mã hóa)'],
  ['drug_dictionary', 'Từ điển thuốc'],
  ['route_dictionary', 'Từ điển đường dùng'],
  ['diagnoses_encoded', 'Chẩn đoán (mã hóa)'],
  ['diagnosis_dictionary', 'Từ điển chẩn đoán'],
  ['surgery_results_encoded', 'PT/TT (mã hóa)'],
  ['procedure_dictionary', 'Từ điển PT/TT'],
  ['anesthesia_dictionary', 'Từ điển vô cảm'],
  ['diagnoses',      'Chẩn đoán'],
  ['patient_day',    'Theo ngày nằm viện'],
  ['lab_results',    'Xét nghiệm'],
  ['imaging_results','CĐHA'],
  ['surgery_results','PT/TT'],
  ['medication_orders','Y lệnh thuốc'],
  ['clinical_notes', 'Diễn biến'],
  ['patient_extra',  'Thông tin khác'],
  ['extract_status', 'Tiến độ lấy dữ liệu'],
  ['errors',         'Lỗi'],
];

const STUDY_TABLES = [
  ['cohort',         'Danh sách mẫu'],
  ['crf',            'Phiếu nhập tay'],
  ['research_source','Nguồn chuẩn'],
  ['patient_master', 'Người bệnh'],
  ['encounters',     'Đợt điều trị'],
  ['analysis_ready', 'Bảng phân tích'],
  ['analysis_selected', 'Biến đã chọn'],
  ['analysis_final', 'Dataset cuối'],
  ['analysis_ready_encoded', 'Bảng phân tích (mã hóa)'],
  ['analysis_selected_encoded', 'Biến đã chọn (mã hóa)'],
  ['lab_results_encoded', 'Xét nghiệm (mã hóa)'],
  ['lab_dictionary', 'Từ điển xét nghiệm'],
  ['imaging_results_encoded', 'CĐHA (mã hóa)'],
  ['imaging_dictionary', 'Từ điển CĐHA'],
  ['medication_orders_encoded', 'Y lệnh (mã hóa)'],
  ['drug_dictionary', 'Từ điển thuốc'],
  ['route_dictionary', 'Từ điển đường dùng'],
  ['diagnoses_encoded', 'Chẩn đoán (mã hóa)'],
  ['diagnosis_dictionary', 'Từ điển chẩn đoán'],
  ['surgery_results_encoded', 'PT/TT (mã hóa)'],
  ['procedure_dictionary', 'Từ điển PT/TT'],
  ['anesthesia_dictionary', 'Từ điển vô cảm'],
  ['diagnoses',      'Chẩn đoán'],
  ['patient_day',    'Theo ngày nằm viện'],
  ['lab_results',    'Xét nghiệm'],
  ['imaging_results','CĐHA'],
  ['surgery_results','PT/TT'],
  ['medication_orders','Y lệnh thuốc'],
  ['clinical_notes', 'Diễn biến'],
  ['patient_extra',  'Thông tin khác'],
  ['extract_status', 'Tiến độ lấy dữ liệu'],
  ['errors',         'Lỗi'],
  ['patients',       'Mẫu (dữ liệu thô)'],
  ['xn',             'Xét nghiệm (dữ liệu thô)'],
  ['cdha',           'CĐHA (dữ liệu thô)'],
];

const TABLES = [...ARCHIVE_TABLES, ...STUDY_TABLES.filter(([id]) => !ARCHIVE_TABLES.some(([a]) => a === id))];

function todayInputDate() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function tablesForScope(isArchive) { return isArchive ? ARCHIVE_TABLES : STUDY_TABLES; }

function tableLabel(id, isArchive) {
  return tablesForScope(isArchive).find(([k]) => k === id)?.[1]
      || TABLES.find(([k]) => k === id)?.[1] || 'Bảng';
}

function datasetCount(source, id, isArchive = false) {
  if (isArchive && id === 'initial_list') return source?.latest_run?.outputs?.initial_list || source?.source_count || 0;
  if (isArchive && id === 'deep_source')  return source?.latest_run?.outputs?.deep_source  || source?.latest_run?.outputs?.patients || 0;
  if (isArchive && id === 'patients')     return source?.latest_run?.outputs?.patients || 0;
  if (id === 'cohort') return isArchive ? source?.source_count || 0 : source?.cohort_count || 0;
  if (id === 'crf') return isArchive ? 0 : Number(source?.crf_entry_count || 0);
  return source?.latest_run?.outputs?.[id] || 0;
}

export {
  ARCHIVE_SCOPE,
  ARCHIVE_API_SCOPE,
  ARCHIVE_TABLES,
  STUDY_TABLES,
  TABLES,
  todayInputDate,
  tablesForScope,
  tableLabel,
  datasetCount,
};
