'use strict';

// Phiên bản schema và danh sách cột của các bảng chuẩn hóa (khớp server/research/data_dictionary.js).

// v9: strict date parsing, typed numeric filters/custom fields 1/0, và bỏ
// patient-level surgery fallback khi chuẩn hóa medication_orders.
// v10: Mã NC duy nhất/ổn định, ghép theo Research key, qa_report.json +
// encounter_review.csv + normalize_state.json + normalize_history.jsonl.
// v11: gộp dòng chuyển khoa chung Mã nội trú lấy ngày vào sớm nhất.
// v12: bỏ dòng XN/CĐHA thô giống hệt nhau; QA báo kết quả mâu thuẫn.
// v13: ghép lượt theo Mã NC đã chuẩn hóa/ngày vào-ra duy nhất, không đoán ca mơ hồ.
// v14: bảng chuẩn hóa không còn dấu ' trước số âm/"+" (lỗi ghi CSV cũ); chuẩn hóa lại toàn bộ.
// v15: thêm patient_key (mã người bệnh giả danh, bảng liên kết patient_link.csv của kho);
//      dataset chọn biến/dataset cuối/bảng mã hóa không còn Mã BN và họ tên.
// v16: bổ sung parser cấu trúc cho y lệnh và diễn biến lâm sàng.
// v17: XN lossless — không tự xóa các lần xét nghiệm giống nhau; mỗi dòng có ID riêng.
// v18: provenance + chuẩn hóa đơn vị XN bảo thủ; parser thuốc đầy đủ.
// v19: giữ toàn bộ XN/CĐHA trong analysis_ready và CĐHA lossless.
// v20: lưu bằng chứng/lý do matching từng dòng; Mã NC không tham gia quyết định matching.
// v21: analysis_ready chỉ giữ biến/tóm tắt theo encounter; chi tiết XN/CĐHA ở bảng dài,
//      không nhét toàn bộ kết quả của một đợt vào các ô JSON/text cực lớn.
// v22: Mã BN là khóa nguồn duy nhất; bỏ các cột mã EMR không thu thập (emr_admission_id, emr_treatment_id, emr_noitru_id).
// v23: thêm sinh hiệu lúc vào viện từ Phiếu vào viện cho Kho nghiên cứu.
// v24: một đợt tính từ lúc nhận Cấp cứu (24 giờ trước giờ vào khoa khi chưa có giờ vào viện)
//      đến hết ngày ra viện (ngày ra chỉ có ngày không còn bị hiểu là 00:00).
// v25: các dòng khoa có khoảng vào–ra chồng nhau là một đợt; Mã NC cũ dùng chung cho nhiều Mã BN
//      trong file hành chánh bị bỏ; 24 giờ trước giờ vào áp cho mọi đợt.
// v26: đợt kéo dài theo khoảng vào–ra cả lần nằm viện ghi trên dòng y lệnh; ngày phẫu thuật ghi
//      kiểu tháng/ngày được đọc đúng.
// v27: kết quả trước nhập viện / sau ra viện (≤ 30 ngày) gắn kèm đợt gần nhất, đánh dấu
//      encounter_match_method = pre_admission / post_discharge, is_within_encounter = 0.
// v28: chỉ gắn kết quả trước nhập viện tối đa 3 ngày; sau ra viện không gắn vào đợt.
const NORMALIZED_SCHEMA_VERSION = 28;

const NORMALIZED_COLUMNS = {
  patients: [
    'patient_code', 'patient_key', 'patient_name', 'sex', 'birth_date', 'age', 'birth_year',
    'address', 'phone_number', 'citizen_id', 'insurance_subject', 'insurance_card', 'insurance_type',
    'insurance_valid_from', 'insurance_valid_to', 'first_research_code', 'encounter_count',
    'source_input', 'source_run_id', 'row_hash',
  ],
  encounters: [
    'encounter_id', 'research_code', 'patient_code', 'patient_key', 'admission_date', 'discharge_date',
    'treatment_duration', 'department', 'room_bed',
    'admission_pulse', 'admission_temperature', 'admission_bp_systolic', 'admission_bp_diastolic',
    'admission_respiratory_rate', 'admission_weight_kg', 'admission_height_cm',
    'admission_diagnosis', 'discharge_diagnosis',
    'diagnosis_raw', 'comorbidity_text', 'complication_text', 'discharge_status',
    'surgery_date', 'needs_manual_review',
    'source_run_id', 'source_status', 'row_hash',
  ],
  diagnoses: [
    'diagnosis_id', 'research_code', 'patient_code', 'patient_key', 'encounter_id', 'diagnosis_date',
    'diagnosis_type', 'icd_code', 'diagnosis_text', 'source', 'source_run_id', 'row_hash',
  ],
  lab_results: [
    'lab_result_id', 'research_code', 'patient_code', 'patient_key', 'encounter_id', 'encounter_match_status', 'encounter_match_method', 'encounter_match_reason', 'lab_datetime', 'lab_date',
    'lab_group', 'lab_order_id', 'test_name_raw', 'test_name_norm', 'result_raw', 'result_operator', 'result_num', 'result_text',
    'unit', 'result_num_norm', 'unit_norm', 'unit_conversion_status', 'ref_range_raw', 'flag_raw', 'flag_norm',
    'days_from_admission', 'days_from_surgery', 'days_from_discharge', 'is_within_encounter',
    'source_type', 'source_quality', 'source_file', 'source_run_id', 'row_hash',
  ],
  imaging_results: [
    'imaging_id', 'research_code', 'patient_code', 'patient_key', 'encounter_id', 'encounter_match_status', 'encounter_match_method', 'encounter_match_reason', 'ordered_at', 'order_date',
    'service_name_raw', 'modality', 'body_region', 'result_text', 'conclusion_text',
    'status', 'days_from_admission', 'days_from_surgery', 'days_from_discharge', 'is_within_encounter',
    'source_type', 'source_quality', 'source_file', 'source_run_id', 'row_hash',
  ],
  surgery_results: [
    'surgery_id', 'research_code', 'patient_code', 'patient_key', 'encounter_id', 'encounter_match_status', 'encounter_match_method', 'encounter_match_reason', 'surgery_datetime', 'surgery_date',
    'surgery_name', 'surgery_method', 'anesthesia_method', 'surgery_class', 'status',
    'preop_diagnosis', 'postop_diagnosis', 'operating_room',
    'days_from_admission', 'days_from_discharge', 'is_within_encounter',
    'source', 'source_type', 'source_quality', 'source_file', 'source_run_id', 'row_hash',
  ],
  medication_orders: [
    'med_order_id', 'research_code', 'patient_code', 'patient_key', 'encounter_id', 'encounter_match_status', 'encounter_match_method', 'encounter_match_reason', 'order_datetime', 'order_date',
    'drug_name_raw', 'drug_name_norm', 'drug_group_guess', 'active_ingredient', 'route_raw', 'route_norm',
    'dose_raw', 'times_per_day', 'schedule', 'order_action', 'parser_confidence', 'source_field', 'raw_line',
    'surgery_datetime_ref', 'surgery_date_ref', 'postop_day_index', 'postop_day_label', 'is_postop_day_1_3',
    'days_from_admission', 'days_from_discharge', 'is_within_encounter',
    'source', 'source_type', 'source_quality', 'source_file', 'source_run_id', 'row_hash',
  ],
  medication_day_summary: [
    'research_code', 'patient_code', 'patient_key', 'encounter_id', 'order_date', 'drug_count',
    'route_set', 'drugs_display', 'drugs_json', 'source_run_id', 'row_hash',
  ],
  clinical_notes: [
    'note_id', 'research_code', 'patient_code', 'patient_key', 'encounter_id', 'encounter_match_status', 'encounter_match_method', 'encounter_match_reason', 'note_datetime', 'note_date',
    'doctor_name', 'note_type', 'clinical_text', 'order_text', 'status',
    'days_from_admission', 'days_from_discharge', 'is_within_encounter',
    'source', 'source_type', 'source_quality', 'source_file', 'source_run_id', 'row_hash',
  ],
  clinical_events: [
    'clinical_event_id', 'research_code', 'patient_code', 'patient_key', 'encounter_id', 'encounter_match_status', 'encounter_match_method', 'encounter_match_reason',
    'event_datetime', 'event_date', 'doctor_name', 'event_type', 'event_subtype',
    'value_raw', 'value_norm', 'negated', 'certainty', 'source_text', 'parser_rule', 'confidence',
    'days_from_admission', 'days_from_discharge', 'is_within_encounter',
    'source', 'source_type', 'source_quality', 'source_file', 'source_run_id', 'row_hash',
  ],
  patient_day: [
    'research_code', 'patient_code', 'patient_key', 'encounter_id', 'date', 'hospital_day',
    'has_lab', 'lab_count', 'has_imaging', 'imaging_count', 'has_surgery', 'surgery_count', 'has_medication', 'medication_count',
    'hb', 'hct', 'neutrophil', 'lymphocyte', 'monocyte', 'rdw', 'plt',
    'creatinine', 'egfr', 'wbc', 'crp', 'source_run_id', 'row_hash',
  ],
  analysis_ready: [
    'research_code', 'encounter_id', 'patient_code', 'patient_key', 'patient_name', 'sex', 'birth_year', 'age',
    'admission_date', 'surgery_date', 'discharge_date', 'hospital_stay_days', 'time_to_surgery_hours',
    'diagnosis_raw',
    'admission_pulse', 'admission_temperature', 'admission_bp_systolic', 'admission_bp_diastolic',
    'admission_respiratory_rate', 'admission_weight_kg', 'admission_height_cm',
    // inference fields (injury_side_suggested, hip_fracture_suggested, v.v.) được sinh động theo analysis_config
    // và được gộp vào đây bởi writeCsvDynamic — không hardcode ở đây để tránh cột rỗng với NC khác chuyên khoa
    'surgery_name', 'surgery_method', 'anesthesia_method', 'comorbidity_text', 'complication_text',
    'hb', 'hct', 'neutrophil', 'lymphocyte', 'monocyte', 'rdw', 'plt',
    'lab_result_count', 'imaging_result_count',
    'needs_manual_review', 'source_run_id', 'row_hash',
  ],
  extract_status: [
    'research_code', 'encounter_id', 'patient_code', 'patient_key', 'patient_name', 'popup_status', 'xn_status', 'cdha_status',
    'profile_status', 'discharge_status', 'surgery_status', 'order_history_status',
    'overall_status', 'completion_level', 'ready_for_analysis', 'missing_required',
    'lab_count', 'imaging_count', 'surgery_count', 'medication_count',
    'last_error', 'source_run_id',
  ],
};

module.exports = {
  NORMALIZED_SCHEMA_VERSION,
  NORMALIZED_COLUMNS,
};
