'use strict';

// Từ điển dữ liệu Kho nghiên cứu — nguồn DUY NHẤT mô tả từng bảng/cột.
//
// Mô tả được viết từ code chuẩn hóa hiện tại (server/routes/research.js,
// normalizeRunOutputsInner và các hàm normalize*/infer*), không từ giả định.
// scripts/research_data_dictionary_test.js kiểm tra danh sách cột ở đây khớp
// NORMALIZED_COLUMNS và khớp quy tắc che định danh khi xuất; sửa code thêm/bớt cột
// mà không cập nhật file này thì CI báo lỗi.
// Tài liệu đọc được: docs/DATA_DICTIONARY.md (sinh bằng scripts/build_data_dictionary.js).
//
// Phân loại định danh (identifier):
//   direct       — định danh trực tiếp người bệnh hoặc mã EMR tra ngược được.
//   quasi        — có thể góp phần nhận diện khi kết hợp (ngày, tuổi, giới, khoa...).
//   free_text    — văn bản tự do, có thể lẫn tên/SĐT/địa chỉ do người nhập gõ vào.
//   staff        — thông tin nhân viên y tế.
//   pseudonymous — mã giả danh do hệ thống tạo (Mã NC, encounter_id).
//   none         — không định danh.
// Phạm vi dùng (use):
//   allowed            — dùng được trong dataset nghiên cứu.
//   approval_required  — chỉ đưa vào khi đề cương đã duyệt cần tới (hiện KHÔNG bị tự che khi xuất).
//   excluded           — mặc định bị che khi xem/xuất (server/research/export_utils.js).
// Phân loại "use" là đề xuất kỹ thuật; bệnh viện/hội đồng đạo đức phải xác nhận.

const DICTIONARY_VERSION = '2026-09-23.3';

const CONVENTIONS = {
  dates: 'Ngày dạng YYYY-MM-DD; thời điểm dạng YYYY-MM-DD HH:mm (giờ địa phương, không có múi giờ). Cột "ngày giờ" có thể chỉ có phần ngày nếu nguồn không có giờ.',
  flags: 'Cột cờ 1/0: "1" = có, "0" = không. Ô trống = không xác định được (khác với "0").',
  empty: 'Ô trống nghĩa là nguồn không có hoặc hệ thống không đọc được giá trị. Hệ thống không tự điền giá trị thay thế.',
  raw_vs_norm: 'Cột *_raw giữ nguyên văn bản EMR; cột *_norm/*_num là giá trị đã chuẩn hóa. Khi nghi ngờ, đối chiếu cột *_raw.',
  numbers: 'Số thập phân dùng dấu chấm. Kết quả xét nghiệm KHÔNG được quy đổi đơn vị; đơn vị nằm ở cột unit của cùng dòng.',
  csv: 'File CSV UTF-8 có BOM, phân tách bằng dấu phẩy.',
};

// ── Cột dùng chung ────────────────────────────────────────────────────────────
function col(type, meaning, extra = {}) {
  return { type, meaning, identifier: 'none', use: 'allowed', ...extra };
}

const COMMON = {
  research_code: col('string', 'Mã NC: mã giả danh của đợt điều trị, dùng thay tên khi xuất ẩn danh.', {
    format: 'NC + 4 chữ số (ví dụ NC0012)', identifier: 'pseudonymous',
    source: 'research_source.csv (cấp khi tạo nguồn chuẩn) hoặc mã script XN/CĐHA đã cấp cho cùng đợt.',
    empty: 'Chưa ghép được đợt (xem encounter_match_status).',
  }),
  patient_code: col('string', 'Mã BN trên EMR.', {
    identifier: 'direct', use: 'excluded', source: 'Cột Mã BN của danh sách nội trú / file thô.',
    empty: 'Không được trống (bắt buộc).',
  }),
  encounter_id: col('string', 'Khóa đợt điều trị (Research key), nối về encounters.encounter_id.', {
    format: 'enc_<16 ký tự hex>; enc_unresolved_… nếu không đủ căn cứ ghép',
    identifier: 'pseudonymous',
    derivation: 'Băm (sha1 rút gọn) theo thứ tự ưu tiên: Mã điều trị/Mã nội trú → Mã vào viện → Mã BN + thời điểm vào/ra → Mã NC.',
    empty: 'Dòng chưa gắn được vào đợt nào (encounter_match_status = ambiguous/missing).',
  }),
  encounter_match_status: col('enum', 'Kết quả gắn dòng vào đợt điều trị.', {
    allowed: ['matched', 'ambiguous', 'missing'],
    derivation: 'matched: khớp khóa EMR/Mã NC/khoảng thời gian duy nhất; ambiguous: khớp nhiều đợt; missing: không khớp đợt nào. Không tự gắn dòng ambiguous/missing.',
  }),
  days_from_admission: col('integer', 'Số ngày từ ngày vào viện đến thời điểm của dòng (tính theo ngày lịch, 0 = cùng ngày vào viện).', {
    unit: 'ngày', empty: 'Thiếu ngày vào viện hoặc thời điểm của dòng.', allowed: 'Có thể âm (trước ngày vào viện).',
  }),
  days_from_surgery: col('integer', 'Số ngày từ ngày mổ của đợt đến thời điểm của dòng (0 = ngày mổ).', {
    unit: 'ngày', empty: 'Đợt không có ngày mổ hoặc thiếu thời điểm.', allowed: 'Có thể âm.',
  }),
  days_from_discharge: col('integer', 'Số ngày từ ngày ra viện đến thời điểm của dòng (âm = trước ngày ra viện).', {
    unit: 'ngày', empty: 'Chưa có ngày ra viện hoặc thiếu thời điểm.',
  }),
  is_within_encounter: col('flag01', 'Thời điểm của dòng nằm trong khoảng vào viện → ra viện của đợt.', {
    allowed: ['1', '0'],
    derivation: 'Nếu chưa có ngày ra viện, dùng mốc ngày vào + 60 ngày làm giới hạn trên.',
    empty: 'Thiếu ngày vào viện hoặc thời điểm của dòng.',
  }),
  source: col('string', 'Nguồn của dòng.', { allowed: 'Ví dụ: encounter, hchanh_auto_surgery, hchanh_order_history, surgery_raw.' }),
  source_run_id: col('string', 'Mã đợt dữ liệu (run) đã tạo ra dòng này.'),
  row_hash: col('string', 'Mã băm nội dung dòng (16 ký tự hex), để phát hiện trùng/thay đổi giữa các lần chuẩn hóa.'),
};

// Cột theo ĐÚNG thứ tự file CSV mà code ghi ra (order); cột không định nghĩa riêng
// lấy từ COMMON. Thiếu định nghĩa hoặc định nghĩa thừa đều là lỗi viết từ điển.
function withCommon(order, own) {
  const out = {};
  for (const name of order) {
    const def = own[name] || COMMON[name];
    if (!def) throw new Error(`data_dictionary: thiếu định nghĩa cột ${name}`);
    out[name] = def;
  }
  const extra = Object.keys(own).filter(name => !order.includes(name));
  if (extra.length) throw new Error(`data_dictionary: cột không có trong thứ tự: ${extra.join(', ')}`);
  return out;
}

// ── Bảng chuẩn hóa ───────────────────────────────────────────────────────────
const TABLES = {};

TABLES.patients = {
  file: 'patients.csv', tier: 'normalized',
  grain: 'Một người bệnh (một Mã BN).',
  primary_key: ['patient_code'],
  foreign_keys: [],
  referenced_by: ['encounters.patient_code'],
  sources: ['du_lieu_ban_dau.csv / research_source.csv', 'hchanh_profile.csv (màn điều dưỡng)', 'thong_tin_benh_nhan_bo_sung.csv'],
  processing: 'Gộp mọi dòng của cùng Mã BN; mỗi trường lấy giá trị có sẵn đầy đủ nhất. Giới tính chuẩn hóa về Nam/Nữ; năm sinh tách từ ngày sinh/tuổi.',
  inferred: false,
  quality: {
    required: ['patient_code'],
    unique: ['patient_code'],
    checks: ['Trùng patient_code là lỗi chặn.'],
    manual_review: [],
  },
  columns: withCommon(['patient_code', 'patient_name', 'sex', 'birth_date', 'age', 'birth_year', 'address', 'phone_number', 'citizen_id', 'insurance_subject', 'insurance_card', 'insurance_type', 'insurance_valid_from', 'insurance_valid_to', 'first_research_code', 'encounter_count', 'source_input', 'source_run_id', 'row_hash'], {
    patient_code: { ...COMMON.patient_code, meaning: 'Mã BN trên EMR (khóa chính).' },
    patient_name: col('string', 'Họ tên người bệnh.', { identifier: 'direct', use: 'excluded', source: 'Danh sách nội trú / hồ sơ nền.' }),
    sex: col('enum', 'Giới tính.', { allowed: ['Nam', 'Nữ', '(giữ nguyên văn bản nếu không nhận ra)'], identifier: 'quasi', empty: 'Nguồn không ghi.' }),
    birth_date: col('date', 'Ngày sinh.', { identifier: 'direct', use: 'excluded', empty: 'EMR chỉ có năm sinh/tuổi.' }),
    age: col('string', 'Tuổi như EMR hiển thị.', { identifier: 'quasi', use: 'approval_required', note: 'Không quy đổi; có thể là "65" hoặc dạng tháng tuổi.' }),
    birth_year: col('integer', 'Năm sinh (4 chữ số).', {
      identifier: 'quasi', use: 'approval_required', derivation: 'Tìm số 19xx/20xx trong ngày sinh, tuổi hoặc năm sinh.', empty: 'Không tìm thấy năm hợp lệ.',
    }),
    address: col('text', 'Địa chỉ.', { identifier: 'direct', use: 'excluded' }),
    phone_number: col('string', 'Số điện thoại.', { identifier: 'direct', use: 'excluded' }),
    citizen_id: col('string', 'Số CMND/CCCD.', { identifier: 'direct', use: 'excluded' }),
    insurance_subject: col('string', 'Đối tượng BHYT/viện phí.', { identifier: 'quasi', use: 'excluded' }),
    insurance_card: col('string', 'Số thẻ BHYT.', { identifier: 'direct', use: 'excluded' }),
    insurance_type: col('string', 'Loại thẻ BHYT.', { identifier: 'quasi', use: 'excluded' }),
    insurance_valid_from: col('date', 'Thẻ BHYT có giá trị từ ngày.', { identifier: 'quasi', use: 'excluded' }),
    insurance_valid_to: col('date', 'Thẻ BHYT có giá trị đến ngày.', { identifier: 'quasi', use: 'excluded' }),
    first_research_code: { ...COMMON.research_code, meaning: 'Mã NC của đợt đầu tiên gặp của người bệnh (để nối nhanh).' },
    encounter_count: col('integer', 'Số đợt điều trị của người bệnh trong run này.', { allowed: '≥ 0' }),
    source_input: col('string', 'Nguồn danh sách đã tạo dòng (nếu file nguồn có ghi).'),
  }),
};

TABLES.encounters = {
  file: 'encounters.csv', tier: 'normalized',
  grain: 'Một đợt điều trị nội trú. Các dòng chuyển khoa của cùng đợt (chung Mã nội trú) được gộp làm một.',
  primary_key: ['encounter_id'],
  foreign_keys: [{ columns: ['patient_code'], references: 'patients.patient_code' }],
  referenced_by: ['diagnoses', 'lab_results', 'imaging_results', 'surgery_results', 'medication_orders', 'medication_day_summary', 'clinical_notes', 'patient_day', 'extract_status', 'analysis_ready'],
  sources: ['research_source.csv (từ du_lieu_ban_dau.csv)', 'du_lieu_goc.csv (script XN/CĐHA)', 'hchanh_profile.csv', 'hchanh_discharge.csv (mục Ra khoa)', 'hchanh_surgery.csv'],
  processing: 'Ghép các nguồn theo khóa EMR (Research key, Mã điều trị/Mã nội trú, Mã vào viện) rồi mới theo thời gian. Khi gộp dòng cùng đợt, ngày vào là thời điểm vào sớm nhất. Không ghép theo họ tên.',
  inferred: false,
  quality: {
    required: ['encounter_id', 'patient_code'],
    unique: ['encounter_id', 'research_code'],
    checks: [
      'Trùng encounter_id hoặc Mã NC: lỗi chặn.',
      'patient_code không có trong patients: lỗi chặn.',
      'Thiếu ngày vào viện, ngày ra trước ngày vào, ngày ở tương lai, nằm viện > 365 ngày: cảnh báo, đưa vào encounter_review.csv.',
    ],
    manual_review: ['needs_manual_review khác trống', 'Cặp đợt cùng BN chồng lấn/cùng ngày ra viện nhưng không chung khóa EMR (possible_same_stay).'],
  },
  columns: withCommon(['encounter_id', 'research_code', 'patient_code', 'admission_date', 'discharge_date', 'treatment_duration', 'department', 'room_bed', 'admission_diagnosis', 'discharge_diagnosis', 'diagnosis_raw', 'comorbidity_text', 'complication_text', 'discharge_status', 'surgery_date', 'emr_admission_id', 'emr_treatment_id', 'emr_noitru_id', 'needs_manual_review', 'source_run_id', 'source_status', 'row_hash'], {
    encounter_id: { ...COMMON.encounter_id, meaning: 'Khóa chính của đợt điều trị (Research key).', empty: 'Không được trống (bắt buộc).' },
    admission_date: col('datetime', 'Thời điểm vào viện (vào khoa đầu tiên của đợt).', {
      identifier: 'quasi', use: 'approval_required', source: 'Ngày vào viện (hồ sơ) hoặc T/G vào sớm nhất trên danh sách.', empty: 'Không đọc được ngày vào.',
    }),
    discharge_date: col('datetime', 'Thời điểm ra viện.', { identifier: 'quasi', use: 'approval_required', source: 'Mục Ra khoa (hchanh_discharge).', empty: 'Chưa ra viện hoặc chưa lấy hồ sơ ra viện.' }),
    treatment_duration: col('string', 'Số ngày điều trị như EMR ghi.', { unit: 'ngày', note: 'Giữ nguyên văn bản EMR, không tính lại.' }),
    department: col('string', 'Khoa điều trị.', { identifier: 'quasi' }),
    room_bed: col('string', 'Phòng/giường.', { identifier: 'quasi', use: 'approval_required' }),
    admission_diagnosis: col('text', 'Chẩn đoán vào viện (nguyên văn).', { identifier: 'free_text', use: 'approval_required' }),
    discharge_diagnosis: col('text', 'Chẩn đoán ra viện (nguyên văn, thường có mã ICD đầu dòng).', { identifier: 'free_text', use: 'approval_required' }),
    diagnosis_raw: col('text', 'Chẩn đoán dùng để phân tích: chẩn đoán ra viện, nếu trống thì chẩn đoán vào viện.', { identifier: 'free_text', use: 'approval_required' }),
    comorbidity_text: col('text', 'Bệnh kèm/bệnh nền (nguyên văn).', { identifier: 'free_text', use: 'approval_required' }),
    complication_text: col('text', 'Biến chứng/tai biến (nguyên văn).', { identifier: 'free_text', use: 'approval_required' }),
    discharge_status: col('string', 'Tình trạng/kết quả khi ra viện như EMR ghi (ví dụ "Đỡ, giảm").', { note: 'Giá trị phụ thuộc danh mục EMR; chưa chuẩn hóa.' }),
    surgery_date: col('date', 'Ngày mổ (nếu có) theo nguồn đợt điều trị.', { identifier: 'quasi', use: 'approval_required', empty: 'Không mổ hoặc chưa có dữ liệu phẫu thuật.' }),
    emr_admission_id: col('string', 'Mã vào viện trên EMR.', { identifier: 'direct', use: 'excluded' }),
    emr_treatment_id: col('string', 'Mã điều trị trên EMR.', { identifier: 'direct', use: 'excluded' }),
    emr_noitru_id: col('string', 'Mã nội trú (noitruid) trên EMR; các dòng chuyển khoa của cùng đợt dùng chung mã này.', { identifier: 'direct', use: 'excluded' }),
    needs_manual_review: col('string', 'Lý do cần người kiểm tra, nối bằng "; ". Trống = không có vấn đề đã biết.', {
      allowed: 'Ví dụ: encounter_match_ambiguous, encounter_match_missing.',
    }),
    source_status: col('string', 'Các nguồn đã góp vào đợt, nối bằng "+".', { allowed: 'initial, sample, deep, hchanh_profile, hchanh_discharge' }),
  }),
};

TABLES.diagnoses = {
  file: 'diagnoses.csv', tier: 'normalized',
  grain: 'Một chẩn đoán của một đợt (vào viện, ra viện, bệnh kèm hoặc biến chứng).',
  primary_key: ['diagnosis_id'],
  foreign_keys: [{ columns: ['encounter_id'], references: 'encounters.encounter_id' }],
  sources: ['encounters.csv (các cột chẩn đoán)'],
  processing: 'Tách 4 cột chẩn đoán của encounters thành từng dòng; mã ICD lấy bằng biểu thức A00 hoặc A00.0 đầu tiên trong văn bản.',
  inferred: true,
  quality: { required: ['diagnosis_id', 'encounter_id', 'diagnosis_type'], unique: ['diagnosis_id'], checks: ['Trùng diagnosis_id: lỗi chặn.'], manual_review: ['icd_code trống nhưng diagnosis_text có nội dung.'] },
  columns: withCommon(['diagnosis_id', 'research_code', 'patient_code', 'encounter_id', 'diagnosis_date', 'diagnosis_type', 'icd_code', 'diagnosis_text', 'source', 'source_run_id', 'row_hash'], {
    diagnosis_id: col('string', 'Khóa dòng: dx_<row_hash>.'),
    diagnosis_date: col('date', 'Ngày ra viện cho chẩn đoán ra viện; ngày vào viện cho các loại còn lại.', { identifier: 'quasi', use: 'approval_required' }),
    diagnosis_type: col('enum', 'Loại chẩn đoán.', { allowed: ['admission', 'discharge', 'comorbidity', 'complication'] }),
    icd_code: col('string', 'Mã ICD-10 tách tự động từ văn bản.', { inferred: true, format: 'A00 hoặc A00.0', empty: 'Văn bản không có mã ICD; không tự đoán mã.' }),
    diagnosis_text: col('text', 'Nội dung chẩn đoán (nguyên văn).', { identifier: 'free_text', use: 'approval_required' }),
  }),
};

TABLES.lab_results = {
  file: 'lab_results.csv', tier: 'normalized',
  grain: 'Một kết quả xét nghiệm (một chỉ số trong một phiếu).',
  primary_key: ['lab_result_id'],
  foreign_keys: [{ columns: ['encounter_id'], references: 'encounters.encounter_id', when: 'encounter_match_status = matched' }],
  sources: ['lich_su_xn.csv (script XN/CĐHA, popup lịch sử xét nghiệm trên EMR)'],
  processing: 'Giữ nguyên kết quả gốc; tách dấu so sánh, phần số và phần chữ; tên chỉ số chuẩn hóa theo bảng từ khóa. Không quy đổi đơn vị. Cùng BN + cùng thời điểm + cùng chỉ số là một kết quả (bệnh viện xác nhận): dòng thô giống hệt nhau chỉ giữ một.',
  inferred: false,
  quality: {
    required: ['lab_result_id', 'patient_code', 'test_name_raw'],
    unique: ['lab_result_id'],
    checks: [
      'Dòng thô giống hệt nhau: giữ một, cảnh báo số dòng đã bỏ (duplicate_raw_rows_removed).',
      'Trùng lab_result_id sau khi bỏ dòng giống hệt: lỗi chặn.',
      'encounter_match_status = ambiguous/missing: cảnh báo.',
    ],
    manual_review: [
      'Cùng BN + cùng thời điểm + cùng chỉ số nhưng kết quả khác nhau (conflicting_lab_result): giữ tất cả, không tự chọn.',
      'result_num trống nhưng result_raw có số',
      'Đơn vị khác nhau cho cùng test_name_norm trong một nghiên cứu.',
    ],
  },
  columns: withCommon(['lab_result_id', 'research_code', 'patient_code', 'encounter_id', 'encounter_match_status', 'lab_datetime', 'lab_date', 'lab_group', 'test_name_raw', 'test_name_norm', 'result_raw', 'result_operator', 'result_num', 'result_text', 'unit', 'ref_range_raw', 'flag_raw', 'flag_norm', 'days_from_admission', 'days_from_surgery', 'days_from_discharge', 'is_within_encounter', 'source_run_id', 'row_hash'], {
    lab_result_id: col('string', 'Khóa dòng: lab_<row_hash>.'),
    lab_datetime: col('datetime', 'Thời điểm chỉ định/xét nghiệm.', { identifier: 'quasi', use: 'approval_required' }),
    lab_date: col('date', 'Ngày xét nghiệm.', { identifier: 'quasi', use: 'approval_required' }),
    lab_group: col('string', 'Nhóm xét nghiệm như EMR ghi (huyết học, sinh hóa…).'),
    test_name_raw: col('string', 'Tên chỉ số như EMR ghi.'),
    test_name_norm: col('string', 'Tên chỉ số chuẩn hóa.', {
      allowed: ['creatinine', 'egfr', 'wbc', 'crp', 'hemoglobin', 'hct', 'neutrophil', 'lymphocyte', 'monocyte', 'rdw', 'platelet', 'urea', 'ast', 'alt', 'glucose', '(tên gốc dạng token nếu không khớp)'],
      derivation: 'So khớp từ khóa (không dấu) theo thứ tự; khớp đầu tiên thắng.',
    }),
    result_raw: col('string', 'Kết quả nguyên văn.'),
    result_operator: col('enum', 'Dấu so sánh đứng đầu kết quả.', { allowed: ['<', '>', '<=', '>=', '='], empty: 'Không có dấu.' }),
    result_num: col('decimal', 'Phần số đầu tiên trong kết quả.', { unit: 'theo cột unit', empty: 'Kết quả không có số (ví dụ "Âm tính").' }),
    result_text: col('string', 'Kết quả dạng chữ khi kết quả không thuần số.', { empty: 'Kết quả chỉ là số.' }),
    unit: col('string', 'Đơn vị như EMR ghi.', { empty: 'EMR không ghi đơn vị.' }),
    ref_range_raw: col('string', 'Khoảng tham chiếu như EMR ghi.'),
    flag_raw: col('string', 'Cờ bất thường như EMR ghi.'),
    flag_norm: col('enum', 'Cờ bất thường đã chuẩn hóa.', { allowed: ['high', 'low', 'abnormal', 'normal', 'unknown'], empty: 'EMR không đánh dấu.' }),
  }),
};

TABLES.imaging_results = {
  file: 'imaging_results.csv', tier: 'normalized',
  grain: 'Một dịch vụ chẩn đoán hình ảnh/thăm dò.',
  primary_key: ['imaging_id'],
  foreign_keys: [{ columns: ['encounter_id'], references: 'encounters.encounter_id', when: 'encounter_match_status = matched' }],
  sources: ['lich_su_cdha.csv (script XN/CĐHA)'],
  processing: 'Loại máy lấy từ Nhóm dịch vụ, nếu trống thì suy từ tên dịch vụ; vùng cơ thể suy từ tên dịch vụ. Dòng thô giống hệt nhau chỉ giữ một.',
  inferred: true,
  quality: { required: ['imaging_id', 'patient_code'], unique: ['imaging_id'], checks: ['Dòng thô giống hệt nhau: giữ một, cảnh báo số dòng đã bỏ.', 'Trùng imaging_id: lỗi chặn.', 'Ghép đợt ambiguous/missing: cảnh báo.'], manual_review: ['Cùng BN + cùng thời điểm + cùng dịch vụ nhưng kết quả khác nhau (conflicting_imaging_result).', 'modality = Khác', 'body_region trống'] },
  columns: withCommon(['imaging_id', 'research_code', 'patient_code', 'encounter_id', 'encounter_match_status', 'ordered_at', 'order_date', 'service_name_raw', 'modality', 'body_region', 'result_text', 'conclusion_text', 'status', 'days_from_admission', 'days_from_surgery', 'days_from_discharge', 'is_within_encounter', 'source_run_id', 'row_hash'], {
    imaging_id: col('string', 'Khóa dòng: img_<row_hash>.'),
    ordered_at: col('datetime', 'Thời điểm chỉ định.', { identifier: 'quasi', use: 'approval_required' }),
    order_date: col('date', 'Ngày chỉ định.', { identifier: 'quasi', use: 'approval_required' }),
    service_name_raw: col('string', 'Tên dịch vụ như EMR ghi.'),
    modality: col('enum', 'Loại kỹ thuật.', { allowed: ['CT', 'MRI', 'Siêu âm', 'X-quang', 'DEXA', 'Điện tim', 'Khác', '(giá trị Nhóm dịch vụ của EMR nếu có)'], inferred: true }),
    body_region: col('enum', 'Vùng cơ thể suy từ tên dịch vụ.', {
      allowed: ['Ngực/phổi', 'Bụng', 'Tim mạch', 'Cột sống', 'Gối', 'Há/khu chậu', 'Sọ não', 'Cổ'],
      inferred: true, empty: 'Không nhận ra vùng.',
      note: 'Nhãn "Há/khu chậu" là lỗi chính tả trong code (đúng là "Háng/khung chậu"); giữ nguyên để không đổi dữ liệu cũ.',
    }),
    result_text: col('text', 'Mô tả kết quả (nguyên văn).', { identifier: 'free_text', use: 'approval_required' }),
    conclusion_text: col('text', 'Kết luận (nguyên văn).', { identifier: 'free_text', use: 'approval_required' }),
    status: col('string', 'Trạng thái dịch vụ như EMR ghi.'),
  }),
};

TABLES.surgery_results = {
  file: 'surgery_results.csv', tier: 'normalized',
  grain: 'Một ca phẫu thuật/thủ thuật.',
  primary_key: ['surgery_id'],
  foreign_keys: [{ columns: ['encounter_id'], references: 'encounters.encounter_id', when: 'encounter_match_status = matched' }],
  sources: ['hchanh_surgery.csv (D/s phẫu thuật, tìm theo mốc PT trong lịch sử y lệnh)', 'lich_su_phau_thuat.csv / phau_thuat.csv (nếu có)'],
  processing: 'Bỏ dòng không có ngày, tên và phương pháp; gộp các dòng trùng ca mổ.',
  inferred: false,
  quality: { required: ['surgery_id', 'patient_code'], unique: ['surgery_id'], checks: ['Trùng surgery_id: lỗi chặn.', 'Ghép đợt ambiguous/missing: cảnh báo.'], manual_review: ['surgery_date nằm ngoài khoảng đợt (is_within_encounter = 0).'] },
  columns: withCommon(['surgery_id', 'research_code', 'patient_code', 'encounter_id', 'encounter_match_status', 'surgery_datetime', 'surgery_date', 'surgery_name', 'surgery_method', 'anesthesia_method', 'surgery_class', 'status', 'preop_diagnosis', 'postop_diagnosis', 'operating_room', 'days_from_admission', 'days_from_discharge', 'is_within_encounter', 'source', 'source_run_id', 'row_hash'], {
    surgery_id: col('string', 'Khóa dòng: surg_<row_hash>.'),
    surgery_datetime: col('datetime', 'Thời điểm bắt đầu mổ.', { identifier: 'quasi', use: 'approval_required' }),
    surgery_date: col('date', 'Ngày mổ.', { identifier: 'quasi', use: 'approval_required' }),
    surgery_name: col('string', 'Tên phẫu thuật/dịch vụ.'),
    surgery_method: col('text', 'Phương pháp phẫu thuật (nguyên văn).', { identifier: 'free_text', use: 'approval_required' }),
    anesthesia_method: col('string', 'Phương pháp vô cảm.'),
    surgery_class: col('string', 'Phân loại phẫu thuật như EMR ghi (đặc biệt, loại 1…).'),
    status: col('string', 'Trạng thái ca mổ.'),
    preop_diagnosis: col('text', 'Chẩn đoán trước mổ.', { identifier: 'free_text', use: 'approval_required' }),
    postop_diagnosis: col('text', 'Chẩn đoán sau mổ.', { identifier: 'free_text', use: 'approval_required' }),
    operating_room: col('string', 'Phòng mổ.', { identifier: 'quasi' }),
  }),
};

TABLES.medication_orders = {
  file: 'medication_orders.csv', tier: 'normalized',
  grain: 'Một dòng thuốc trong một y lệnh.',
  primary_key: ['med_order_id'],
  foreign_keys: [{ columns: ['encounter_id'], references: 'encounters.encounter_id', when: 'encounter_match_status = matched' }],
  sources: ['hchanh_order_history.csv (lịch sử y lệnh trên màn bác sĩ)'],
  processing: 'Tách nội dung y lệnh thành từng dòng; chỉ giữ dòng có từ khóa thuốc (tt, viên, ống, chai, uống, tiêm, truyền…). Đường dùng và nhóm thuốc suy từ văn bản. Ngày hậu phẫu tính theo ca mổ đầu tiên CÙNG đợt.',
  inferred: true,
  quality: { required: ['med_order_id', 'patient_code', 'drug_name_raw'], unique: ['med_order_id'], checks: ['Trùng med_order_id: lỗi chặn.', 'Ghép đợt ambiguous/missing: cảnh báo.'], manual_review: ['route_norm không thuộc danh sách chuẩn', 'drug_group_guess trống với thuốc cần phân tích'] },
  columns: withCommon(['med_order_id', 'research_code', 'patient_code', 'encounter_id', 'encounter_match_status', 'order_datetime', 'order_date', 'drug_name_raw', 'drug_name_norm', 'drug_group_guess', 'active_ingredient', 'route_raw', 'route_norm', 'dose_raw', 'times_per_day', 'raw_line', 'surgery_datetime_ref', 'surgery_date_ref', 'postop_day_index', 'postop_day_label', 'is_postop_day_1_3', 'days_from_admission', 'days_from_discharge', 'is_within_encounter', 'source', 'source_run_id', 'row_hash'], {
    med_order_id: col('string', 'Khóa dòng: med_<row_hash>.'),
    order_datetime: col('datetime', 'Thời điểm y lệnh.', { identifier: 'quasi', use: 'approval_required' }),
    order_date: col('date', 'Ngày y lệnh.', { identifier: 'quasi', use: 'approval_required' }),
    drug_name_raw: col('string', 'Tên thuốc/dòng y lệnh (tối đa 180 ký tự, bỏ tiền tố "(TT)").'),
    drug_name_norm: col('string', 'Tên thuốc dạng token: bỏ phần trong ngoặc, bỏ dấu, chữ thường, nối bằng "_".', { inferred: true }),
    drug_group_guess: col('string', 'Nhóm thuốc suy theo tên (có thể nhiều nhóm, nối "; ").', {
      allowed: ['giảm_đau', 'kháng_sinh', 'kháng_kết_tập_tiểu_cầu', 'kháng_đông', 'dạ_dày', 'đái_tháo_đường'],
      inferred: true, empty: 'Không thuộc danh sách hoạt chất đã biết (không có nghĩa là không phải thuốc).',
    }),
    active_ingredient: col('string', 'Hoạt chất (nếu nguồn có).'),
    route_raw: col('string', 'Đường dùng gốc (nếu không có cột riêng thì là cả dòng y lệnh).'),
    route_norm: col('string', 'Đường dùng chuẩn hóa.', {
      allowed: ['truyền_tĩnh_mạch', 'tiêm_tĩnh_mạch', 'tiêm_bắp', 'tiêm_dưới_da', 'uống', 'bôi', 'khí_dung', '(token văn bản gốc nếu không khớp)'], inferred: true,
    }),
    dose_raw: col('string', 'Liều (nếu không có cột riêng thì là cả dòng y lệnh).'),
    times_per_day: col('string', 'Số lần/ngày (nếu nguồn có).'),
    raw_line: col('text', 'Dòng y lệnh gốc.', { identifier: 'free_text', use: 'approval_required' }),
    surgery_datetime_ref: col('datetime', 'Thời điểm ca mổ đầu tiên của cùng đợt, dùng làm mốc hậu phẫu.', { identifier: 'quasi', use: 'approval_required' }),
    surgery_date_ref: col('date', 'Ngày ca mổ mốc.', { identifier: 'quasi', use: 'approval_required' }),
    postop_day_index: col('integer', 'Ngày hậu phẫu (0 = ngày mổ, âm = trước mổ).', { unit: 'ngày', empty: 'Đợt không có ca mổ đã ghép — không phải ngày 0.' }),
    postop_day_label: col('string', 'Nhãn ngày hậu phẫu: N<postop_day_index>.', { format: 'N-1, N0, N1…' }),
    is_postop_day_1_3: col('flag01', 'Y lệnh thuộc hậu phẫu ngày 1–3.', { allowed: ['1', '0'], empty: 'Không có ca mổ mốc.' }),
  }),
};

TABLES.medication_day_summary = {
  file: 'medication_day_summary.csv', tier: 'normalized',
  grain: 'Một ngày y lệnh của một đợt (tổng hợp các thuốc trong ngày).',
  primary_key: ['encounter_id', 'order_date'],
  foreign_keys: [{ columns: ['encounter_id'], references: 'encounters.encounter_id' }],
  sources: ['medication_orders.csv (chỉ dòng đã gắn đợt và có ngày)'],
  processing: 'Nhóm theo đợt + ngày y lệnh.',
  inferred: false,
  quality: { required: ['encounter_id', 'order_date'], unique: ['encounter_id + order_date'], checks: [], manual_review: [] },
  columns: withCommon(['research_code', 'patient_code', 'encounter_id', 'order_date', 'drug_count', 'route_set', 'drugs_display', 'drugs_json', 'source_run_id', 'row_hash'], {
    order_date: col('date', 'Ngày y lệnh.', { identifier: 'quasi', use: 'approval_required' }),
    drug_count: col('integer', 'Số dòng thuốc trong ngày.', { allowed: '≥ 1' }),
    route_set: col('string', 'Các đường dùng trong ngày, nối "; ".'),
    drugs_display: col('string', 'Tối đa 20 tên thuốc trong ngày, nối "; ".'),
    drugs_json: col('json', 'Toàn bộ tên thuốc trong ngày (mảng JSON).'),
  }),
};

TABLES.clinical_notes = {
  file: 'clinical_notes.csv', tier: 'normalized',
  grain: 'Một dòng lịch sử y lệnh (diễn biến + nội dung y lệnh).',
  primary_key: ['note_id'],
  foreign_keys: [{ columns: ['encounter_id'], references: 'encounters.encounter_id', when: 'encounter_match_status = matched' }],
  sources: ['hchanh_order_history.csv'],
  processing: 'Giữ nguyên văn diễn biến và y lệnh; bỏ dòng không có nội dung.',
  inferred: false,
  quality: { required: ['note_id', 'patient_code'], unique: ['note_id'], checks: ['Trùng note_id: lỗi chặn.', 'Ghép đợt ambiguous/missing: cảnh báo.'], manual_review: [] },
  columns: withCommon(['note_id', 'research_code', 'patient_code', 'encounter_id', 'encounter_match_status', 'note_datetime', 'note_date', 'doctor_name', 'note_type', 'clinical_text', 'order_text', 'status', 'days_from_admission', 'days_from_discharge', 'is_within_encounter', 'source', 'source_run_id', 'row_hash'], {
    note_id: col('string', 'Khóa dòng: note_<row_hash>.'),
    note_datetime: col('datetime', 'Thời điểm y lệnh.', { identifier: 'quasi', use: 'approval_required' }),
    note_date: col('date', 'Ngày y lệnh.', { identifier: 'quasi', use: 'approval_required' }),
    doctor_name: col('string', 'Bác sĩ ra y lệnh.', { identifier: 'staff', use: 'approval_required', note: 'Thông tin nhân viên y tế; hiện KHÔNG bị che tự động khi xuất.' }),
    note_type: col('enum', 'Loại ghi chép.', { allowed: ['order_history'] }),
    clinical_text: col('text', 'Diễn biến bệnh (nguyên văn).', { identifier: 'free_text', use: 'approval_required' }),
    order_text: col('text', 'Nội dung y lệnh (nguyên văn).', { identifier: 'free_text', use: 'approval_required' }),
    status: col('string', 'Trạng thái y lệnh.'),
  }),
};

const PD_LABS = ['hb', 'hct', 'neutrophil', 'lymphocyte', 'monocyte', 'rdw', 'plt', 'creatinine', 'egfr', 'wbc', 'crp'];
function labSnapshotColumns(scope) {
  const out = {};
  for (const key of PD_LABS) {
    out[key] = col('string', `Kết quả ${key} ${scope} (result_raw nguyên văn).`, {
      unit: 'theo lab_results.unit (không quy đổi)',
      empty: 'Không có kết quả chỉ số này.',
      derivation: `Lấy từ lab_results có test_name_norm tương ứng (${key === 'hb' ? 'hemoglobin' : key === 'plt' ? 'platelet' : key}).`,
    });
  }
  return out;
}

TABLES.patient_day = {
  file: 'patient_day.csv', tier: 'normalized',
  grain: 'Một ngày có hoạt động (XN/CĐHA/mổ/thuốc) của một đợt.',
  primary_key: ['encounter_id', 'date'],
  foreign_keys: [{ columns: ['encounter_id'], references: 'encounters.encounter_id' }],
  sources: ['lab_results', 'imaging_results', 'surgery_results', 'medication_orders (chỉ dòng đã gắn đợt)'],
  processing: 'Nhóm theo đợt + ngày. Ngày không có hoạt động nào thì không có dòng.',
  inferred: false,
  quality: { required: ['encounter_id', 'date'], unique: ['encounter_id + date'], checks: [], manual_review: ['hospital_day ≤ 0 (hoạt động trước ngày vào viện).'] },
  columns: withCommon(['research_code', 'patient_code', 'encounter_id', 'date', 'hospital_day', 'has_lab', 'lab_count', 'has_imaging', 'imaging_count', 'has_surgery', 'surgery_count', 'has_medication', 'medication_count', 'hb', 'hct', 'neutrophil', 'lymphocyte', 'monocyte', 'rdw', 'plt', 'creatinine', 'egfr', 'wbc', 'crp', 'source_run_id', 'row_hash'], {
    date: col('date', 'Ngày.', { identifier: 'quasi', use: 'approval_required' }),
    hospital_day: col('integer', 'Ngày nằm viện thứ mấy (1 = ngày vào viện).', { unit: 'ngày', empty: 'Thiếu ngày vào viện.' }),
    has_lab: col('flag01', 'Có xét nghiệm trong ngày.', { allowed: ['1', '0'] }),
    lab_count: col('integer', 'Số kết quả XN trong ngày.'),
    has_imaging: col('flag01', 'Có CĐHA trong ngày.', { allowed: ['1', '0'] }),
    imaging_count: col('integer', 'Số CĐHA trong ngày.'),
    has_surgery: col('flag01', 'Có mổ trong ngày.', { allowed: ['1', '0'] }),
    surgery_count: col('integer', 'Số ca mổ trong ngày.'),
    has_medication: col('flag01', 'Có y lệnh thuốc trong ngày.', { allowed: ['1', '0'] }),
    medication_count: col('integer', 'Số dòng thuốc trong ngày.'),
    ...Object.fromEntries(Object.entries(labSnapshotColumns('trong ngày')).map(([k, v]) => [k, {
      ...v, derivation: `${v.derivation} Nếu trong ngày có nhiều kết quả, lấy kết quả gặp đầu tiên theo thứ tự file (không phải theo giờ).`,
    }])),
  }),
};

TABLES.extract_status = {
  file: 'extract_status.csv', tier: 'normalized',
  grain: 'Một đợt: tiến độ lấy dữ liệu và mức sẵn sàng phân tích.',
  primary_key: ['encounter_id'],
  foreign_keys: [{ columns: ['encounter_id'], references: 'encounters.encounter_id' }],
  sources: ['progress.json (XN/CĐHA)', 'hchanh_auto_progress.json', 'order_history_auto_progress.json'],
  processing: 'Chọn bản ghi tiến độ khớp nhất với đợt (khóa đợt → Mã NC → Mã BN + ngày vào/ra; chỉ dùng Mã BN khi BN có đúng 1 đợt). Hành chánh dùng trạng thái riêng từng file khi có. Trạng thái chi tiết hơn (lý do lỗi, số lần thử, đã đổi trên EMR) nằm ở collection_ledger.json / collection_exceptions.csv.',
  inferred: false,
  quality: { required: ['encounter_id'], unique: ['encounter_id'], checks: ['"empty" = đã lấy xong, EMR xác nhận không có; không phải lỗi'], manual_review: ['overall_status = error', 'một phần = blocked (cần người xem)', 'missing_required chứa encounter_match'] },
  columns: withCommon(['research_code', 'encounter_id', 'patient_code', 'patient_name', 'popup_status', 'xn_status', 'cdha_status', 'profile_status', 'discharge_status', 'surgery_status', 'order_history_status', 'overall_status', 'completion_level', 'ready_for_analysis', 'missing_required', 'lab_count', 'imaging_count', 'surgery_count', 'medication_count', 'last_error', 'source_run_id'], {
    patient_name: col('string', 'Họ tên (để hiển thị tiến độ).', { identifier: 'direct', use: 'excluded' }),
    popup_status: col('string', 'Đã mở được hồ sơ XN/CĐHA.', { allowed: ['done', 'error', 'blocked', '(khác/trống = chưa làm)'] }),
    xn_status: col('string', 'Trạng thái lấy XN.', { allowed: ['done = có dữ liệu', 'empty = EMR không có', 'error = lỗi kỹ thuật', 'blocked = cần người xem', '(khác/trống = chưa làm)'] }),
    cdha_status: col('string', 'Trạng thái lấy CĐHA.', { allowed: ['done = có dữ liệu', 'empty = EMR không có', 'error = lỗi kỹ thuật', 'blocked = cần người xem', '(khác/trống = chưa làm)'] }),
    profile_status: col('string', 'Trạng thái lấy hồ sơ nền.', { allowed: ['done', 'empty', 'partial', 'error', 'blocked', 'skipped_recent_failure', '(trống = chưa làm)'] }),
    discharge_status: col('string', 'Trạng thái lấy ra viện.', { allowed: ['done', 'empty', 'partial', 'error', 'blocked', 'skipped_recent_failure', '(trống)'] }),
    surgery_status: col('string', 'Trạng thái lấy phẫu thuật.', { allowed: ['done', 'empty', 'partial', 'error', 'blocked', 'skipped_recent_failure', '(trống)'] }),
    order_history_status: col('string', 'Trạng thái lấy lịch sử y lệnh.', { allowed: ['done', 'empty', 'partial', 'error', 'blocked', 'skipped_recent_failure', '(trống)'] }),
    overall_status: col('enum', 'Trạng thái chung.', { allowed: ['done', 'error', 'pending'] }),
    completion_level: col('enum', 'Mức đầy đủ.', {
      allowed: ['full_required', 'clinical_admin', 'xn_cdha', 'partial'],
      derivation: 'full_required: đủ mọi phần bắt buộc; clinical_admin: đủ XN/CĐHA + hồ sơ nền + ra viện; xn_cdha: chỉ đủ XN/CĐHA; partial: còn lại.',
    }),
    ready_for_analysis: col('flag01', 'Đủ điều kiện đưa vào dataset cuối.', {
      allowed: ['1', '0'],
      derivation: 'Không lỗi VÀ đủ XN/CĐHA, hồ sơ nền, ra viện; phẫu thuật chỉ bắt buộc khi đợt có mổ; y lệnh bắt buộc khi có mổ hoặc có thuốc; đợt phải ghép chắc chắn.',
    }),
    missing_required: col('string', 'Phần bắt buộc còn thiếu, nối "; ".', { allowed: ['xn_cdha', 'profile', 'discharge', 'surgery', 'order_history', 'encounter_match'] }),
    lab_count: col('integer', 'Số kết quả XN đã gắn vào đợt.'),
    imaging_count: col('integer', 'Số CĐHA đã gắn vào đợt.'),
    surgery_count: col('integer', 'Số ca mổ đã gắn vào đợt.'),
    medication_count: col('integer', 'Số dòng thuốc đã gắn vào đợt.'),
    last_error: col('string', 'Lỗi gần nhất khi lấy XN/CĐHA.', { note: 'Thông báo kỹ thuật; có thể chứa Mã BN.' }),
  }),
};

TABLES.analysis_ready = {
  file: 'analysis_ready.csv', tier: 'analysis',
  grain: 'Một đợt điều trị: bảng rộng sẵn để phân tích.',
  primary_key: ['encounter_id'],
  foreign_keys: [{ columns: ['encounter_id'], references: 'encounters.encounter_id' }, { columns: ['patient_code'], references: 'patients.patient_code' }],
  sources: ['encounters', 'patients', 'lab_results', 'imaging_results', 'surgery_results'],
  processing: 'Một dòng mỗi đợt. XN lấy kết quả SỚM NHẤT của đợt; phẫu thuật lấy ca SỚM NHẤT của đợt; biến suy luận chạy trên chẩn đoán + văn bản CĐHA theo preset của nghiên cứu.',
  inferred: true,
  quality: {
    required: ['encounter_id', 'research_code'],
    unique: ['encounter_id'],
    checks: ['Dòng có needs_manual_review bị loại khỏi analysis_final.csv.'],
    manual_review: ['needs_manual_review khác trống (thiếu biến bắt buộc của preset, ghép đợt không chắc chắn).', 'Mọi biến suy luận cần người xác nhận trước khi dùng.'],
  },
  dynamic_columns: {
    inferred: 'Cột suy luận theo preset (ví dụ injury_side_suggested, hip_fracture_suggested, spine_involved, joint_type_suggested, neuro_deficit, stroke_type): suy từ văn bản chẩn đoán + CĐHA bằng từ khóa; ô trống = không tìm thấy từ khóa, KHÔNG có nghĩa là "không". Cần người xác nhận.',
    custom: 'Cột tự định nghĩa của nghiên cứu (custom_fields): so mẫu trên văn bản chẩn đoán đã bỏ dấu; cột boolean luôn là 1/0.',
  },
  columns: withCommon(['research_code', 'encounter_id', 'patient_code', 'patient_name', 'sex', 'birth_year', 'age', 'admission_date', 'surgery_date', 'discharge_date', 'hospital_stay_days', 'time_to_surgery_hours', 'diagnosis_raw', 'surgery_name', 'surgery_method', 'anesthesia_method', 'comorbidity_text', 'complication_text', 'hb', 'hct', 'neutrophil', 'lymphocyte', 'monocyte', 'rdw', 'plt', 'imaging_summary', 'needs_manual_review', 'source_run_id', 'row_hash'], {
    patient_name: col('string', 'Họ tên.', { identifier: 'direct', use: 'excluded' }),
    sex: col('enum', 'Giới tính.', { allowed: ['Nam', 'Nữ'], identifier: 'quasi' }),
    birth_year: col('integer', 'Năm sinh.', { identifier: 'quasi', use: 'approval_required' }),
    age: col('string', 'Tuổi như EMR ghi.', { identifier: 'quasi', use: 'approval_required' }),
    admission_date: col('datetime', 'Thời điểm vào viện.', { identifier: 'quasi', use: 'approval_required' }),
    surgery_date: col('datetime', 'Thời điểm ca mổ sớm nhất của đợt.', { identifier: 'quasi', use: 'approval_required', empty: 'Không có ca mổ đã ghép.' }),
    discharge_date: col('datetime', 'Thời điểm ra viện.', { identifier: 'quasi', use: 'approval_required' }),
    hospital_stay_days: col('string', 'Số ngày nằm viện.', {
      unit: 'ngày', derivation: 'Lấy "Thời gian điều trị" của EMR nếu có; nếu không, tính (ngày ra − ngày vào) + 1.',
      empty: 'Chưa có ngày ra viện.',
    }),
    time_to_surgery_hours: col('decimal', 'Số giờ từ vào viện đến ca mổ sớm nhất (làm tròn 0,1).', { unit: 'giờ', empty: 'Không mổ hoặc thiếu thời điểm.', allowed: 'Âm là bất thường → cần kiểm tra.' }),
    diagnosis_raw: col('text', 'Chẩn đoán (ra viện, nếu trống thì vào viện).', { identifier: 'free_text', use: 'approval_required' }),
    surgery_name: col('string', 'Tên ca mổ sớm nhất.'),
    surgery_method: col('text', 'Phương pháp ca mổ sớm nhất.', { identifier: 'free_text', use: 'approval_required' }),
    anesthesia_method: col('string', 'Vô cảm của ca mổ sớm nhất.'),
    comorbidity_text: col('text', 'Bệnh kèm.', { identifier: 'free_text', use: 'approval_required' }),
    complication_text: col('text', 'Biến chứng.', { identifier: 'free_text', use: 'approval_required' }),
    ...Object.fromEntries(Object.entries(labSnapshotColumns('đầu tiên của đợt'))
      .filter(([k]) => ['hb', 'hct', 'neutrophil', 'lymphocyte', 'monocyte', 'rdw', 'plt'].includes(k))
      .map(([k, v]) => [k, { ...v, derivation: `${v.derivation} Kết quả có lab_datetime sớm nhất trong đợt.` }])),
    imaging_summary: col('text', 'Tên dịch vụ + mô tả + kết luận CĐHA của đợt, nối lại, tối đa 1200 ký tự.', { identifier: 'free_text', use: 'approval_required' }),
    needs_manual_review: col('string', 'Lý do cần người kiểm tra, nối "; ".', { allowed: 'Nhãn thiếu biến của preset (ví dụ "bên tổn thương", "ngày phẫu thuật") và cờ ghép đợt.' }),
  }),
};

// ── Bảng thô (tóm tắt nguồn) ─────────────────────────────────────────────────
const RAW_TABLES = {
  du_lieu_ban_dau: { file: 'du_lieu_ban_dau.csv', grain: 'Một dòng trên danh sách nội trú EMR (mỗi khoa/lượt một dòng).', source: 'Nút "1. Quét danh sách" — màn D/s Điều trị nội trú.', identifiers: ['Mã BN', 'Họ tên', 'Mã nội trú', 'URL bác sĩ', 'URL điều dưỡng (chứa Mã BN)'] },
  research_source: { file: 'research_source.csv', grain: 'Một đợt điều trị (đã gộp các dòng chung Mã nội trú).', source: 'Tạo từ du_lieu_ban_dau.csv; thêm Mã NC, Research key, fetch_from_date/fetch_to_date.', identifiers: ['Mã BN', 'Họ tên', 'Mã nội trú', 'URL'] },
  lich_su_xn: { file: 'lich_su_xn.csv', grain: 'Một chỉ số xét nghiệm của một phiếu.', source: 'Script XN/CĐHA — popup lịch sử xét nghiệm.', identifiers: ['Mã BN', 'Mã vào viện', 'Mã điều trị', 'Người chỉ định (nhân viên)'] },
  lich_su_cdha: { file: 'lich_su_cdha.csv', grain: 'Một dịch vụ CĐHA.', source: 'Script XN/CĐHA.', identifiers: ['Mã BN', 'Mã vào viện', 'Mã điều trị', 'Người chỉ định (nhân viên)'] },
  hchanh_profile: { file: 'hchanh_profile.csv', grain: 'Một dòng nguồn (Research key).', source: 'Lấy hành chánh — màn điều dưỡng (con mắt).', identifiers: ['Mã BN', 'Họ tên', 'Ngày sinh', 'Địa chỉ', 'Điện thoại', 'Số CMND', 'Số thẻ BHYT'] },
  hchanh_discharge: { file: 'hchanh_discharge.csv', grain: 'Một dòng nguồn.', source: 'Lấy hành chánh — mục Ra khoa trên màn bác sĩ.', identifiers: ['Mã BN', 'Họ tên', 'Số lưu trữ'] },
  hchanh_surgery: { file: 'hchanh_surgery.csv', grain: 'Một ca PT/TT.', source: 'Lấy hành chánh — D/s phẫu thuật.', identifiers: ['Mã BN', 'Họ tên', 'Raw JSON'] },
  hchanh_order_history: { file: 'hchanh_order_history.csv', grain: 'Một dòng lịch sử y lệnh.', source: 'Lấy hành chánh — Lịch sử y lệnh.', identifiers: ['Mã BN', 'Họ tên', 'Bác sĩ (nhân viên)', 'Raw JSON'] },
};

const KNOWN_ISSUES = [
  'analysis_ready: khi chọn kết quả XN sớm nhất, dòng thiếu lab_datetime được coi là sớm nhất.',
  'patient_day: nhiều kết quả cùng chỉ số trong một ngày thì lấy kết quả gặp đầu tiên theo thứ tự file, không theo giờ.',
  'clinical_notes.doctor_name (tên nhân viên) chưa bị che tự động khi xuất.',
  'Nhãn body_region "Há/khu chậu" sai chính tả (đúng là "Háng/khung chậu").',
];

module.exports = {
  DICTIONARY_VERSION,
  CONVENTIONS,
  COMMON,
  TABLES,
  RAW_TABLES,
  KNOWN_ISSUES,
};
