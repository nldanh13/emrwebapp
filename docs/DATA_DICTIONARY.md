# Từ điển dữ liệu Kho nghiên cứu

> File này được sinh tự động từ `server/research/data_dictionary.js` (phiên bản `2026-09-23.3`). Đừng sửa tay: sửa file nguồn rồi chạy `node scripts/build_data_dictionary.js`.
>
> Mô tả được viết từ code chuẩn hóa hiện tại. Cột "Dùng" là đề xuất kỹ thuật; phạm vi dùng thực tế phải theo đề cương được hội đồng đạo đức/bệnh viện phê duyệt.

## Quy ước chung

- Ngày dạng YYYY-MM-DD; thời điểm dạng YYYY-MM-DD HH:mm (giờ địa phương, không có múi giờ). Cột "ngày giờ" có thể chỉ có phần ngày nếu nguồn không có giờ.
- Cột cờ 1/0: "1" = có, "0" = không. Ô trống = không xác định được (khác với "0").
- Ô trống nghĩa là nguồn không có hoặc hệ thống không đọc được giá trị. Hệ thống không tự điền giá trị thay thế.
- Cột *_raw giữ nguyên văn bản EMR; cột *_norm/*_num là giá trị đã chuẩn hóa. Khi nghi ngờ, đối chiếu cột *_raw.
- Số thập phân dùng dấu chấm. Kết quả xét nghiệm KHÔNG được quy đổi đơn vị; đơn vị nằm ở cột unit của cùng dòng.
- File CSV UTF-8 có BOM, phân tách bằng dấu phẩy.

**Định danh:** Trực tiếp = nhận diện được người bệnh hoặc tra ngược EMR; Gián tiếp = có thể góp phần nhận diện khi kết hợp; Văn bản tự do = có thể lẫn tên/SĐT do người nhập gõ; Nhân viên = thông tin nhân viên y tế; Giả danh = mã do hệ thống tạo.

**Dùng:** Được dùng = đưa vào dataset nghiên cứu; Cần đề cương duyệt = chỉ đưa vào khi đề cương cần tới (hiện **không** bị tự che khi xuất); Loại = mặc định bị che khi xem/xuất.

## Danh sách bảng

| Bảng | Mỗi dòng là | Khóa chính |
|---|---|---|
| [`patients.csv`](#patients) | Một người bệnh (một Mã BN). | `patient_code` |
| [`encounters.csv`](#encounters) | Một đợt điều trị nội trú. Các dòng chuyển khoa của cùng đợt (chung Mã nội trú) được gộp làm một. | `encounter_id` |
| [`diagnoses.csv`](#diagnoses) | Một chẩn đoán của một đợt (vào viện, ra viện, bệnh kèm hoặc biến chứng). | `diagnosis_id` |
| [`lab_results.csv`](#lab_results) | Một kết quả xét nghiệm (một chỉ số trong một phiếu). | `lab_result_id` |
| [`imaging_results.csv`](#imaging_results) | Một dịch vụ chẩn đoán hình ảnh/thăm dò. | `imaging_id` |
| [`surgery_results.csv`](#surgery_results) | Một ca phẫu thuật/thủ thuật. | `surgery_id` |
| [`medication_orders.csv`](#medication_orders) | Một dòng thuốc trong một y lệnh. | `med_order_id` |
| [`medication_day_summary.csv`](#medication_day_summary) | Một ngày y lệnh của một đợt (tổng hợp các thuốc trong ngày). | `encounter_id`, `order_date` |
| [`clinical_notes.csv`](#clinical_notes) | Một dòng lịch sử y lệnh (diễn biến + nội dung y lệnh). | `note_id` |
| [`patient_day.csv`](#patient_day) | Một ngày có hoạt động (XN/CĐHA/mổ/thuốc) của một đợt. | `encounter_id`, `date` |
| [`extract_status.csv`](#extract_status) | Một đợt: tiến độ lấy dữ liệu và mức sẵn sàng phân tích. | `encounter_id` |
| [`analysis_ready.csv`](#analysis_ready) | Một đợt điều trị: bảng rộng sẵn để phân tích. | `encounter_id` |

## patients

**File:** `patients.csv` · **Tầng:** chuẩn hóa · **Có biến suy luận:** không

**Mỗi dòng là:** Một người bệnh (một Mã BN).

**Khóa chính (duy nhất):** `patient_code`

**Khóa nối:** (không có) · Được nối từ: `encounters.patient_code`

**Nguồn:** du_lieu_ban_dau.csv / research_source.csv; hchanh_profile.csv (màn điều dưỡng); thong_tin_benh_nhan_bo_sung.csv

**Cách xử lý:** Gộp mọi dòng của cùng Mã BN; mỗi trường lấy giá trị có sẵn đầy đủ nhất. Giới tính chuẩn hóa về Nam/Nữ; năm sinh tách từ ngày sinh/tuổi.

**Quy tắc chất lượng**

- Bắt buộc: `patient_code`
- Duy nhất: `patient_code`
- Trùng patient_code là lỗi chặn.

**Cần người kiểm tra khi:**

- (không có)

| Cột | Kiểu | Ý nghĩa | Giá trị / đơn vị | Ô trống nghĩa là | Định danh | Dùng |
|---|---|---|---|---|---|---|
| `patient_code` | chuỗi | Mã BN trên EMR (khóa chính). Nguồn: Cột Mã BN của danh sách nội trú / file thô. |  | Không được trống (bắt buộc). | Trực tiếp | Loại (bị che khi xuất) |
| `patient_name` | chuỗi | Họ tên người bệnh. Nguồn: Danh sách nội trú / hồ sơ nền. |  |  | Trực tiếp | Loại (bị che khi xuất) |
| `sex` | danh mục | Giới tính. | `Nam`, `Nữ`, `(giữ nguyên văn bản nếu không nhận ra)` | Nguồn không ghi. | Gián tiếp | Được dùng |
| `birth_date` | ngày | Ngày sinh. |  | EMR chỉ có năm sinh/tuổi. | Trực tiếp | Loại (bị che khi xuất) |
| `age` | chuỗi | Tuổi như EMR hiển thị. Lưu ý: Không quy đổi; có thể là "65" hoặc dạng tháng tuổi. |  |  | Gián tiếp | Cần đề cương duyệt |
| `birth_year` | số nguyên | Năm sinh (4 chữ số). Cách tính: Tìm số 19xx/20xx trong ngày sinh, tuổi hoặc năm sinh. |  | Không tìm thấy năm hợp lệ. | Gián tiếp | Cần đề cương duyệt |
| `address` | văn bản | Địa chỉ. |  |  | Trực tiếp | Loại (bị che khi xuất) |
| `phone_number` | chuỗi | Số điện thoại. |  |  | Trực tiếp | Loại (bị che khi xuất) |
| `citizen_id` | chuỗi | Số CMND/CCCD. |  |  | Trực tiếp | Loại (bị che khi xuất) |
| `insurance_subject` | chuỗi | Đối tượng BHYT/viện phí. |  |  | Gián tiếp | Loại (bị che khi xuất) |
| `insurance_card` | chuỗi | Số thẻ BHYT. |  |  | Trực tiếp | Loại (bị che khi xuất) |
| `insurance_type` | chuỗi | Loại thẻ BHYT. |  |  | Gián tiếp | Loại (bị che khi xuất) |
| `insurance_valid_from` | ngày | Thẻ BHYT có giá trị từ ngày. |  |  | Gián tiếp | Loại (bị che khi xuất) |
| `insurance_valid_to` | ngày | Thẻ BHYT có giá trị đến ngày. |  |  | Gián tiếp | Loại (bị che khi xuất) |
| `first_research_code` | chuỗi | Mã NC của đợt đầu tiên gặp của người bệnh (để nối nhanh). Nguồn: research_source.csv (cấp khi tạo nguồn chuẩn) hoặc mã script XN/CĐHA đã cấp cho cùng đợt. | Dạng: NC + 4 chữ số (ví dụ NC0012) | Chưa ghép được đợt (xem encounter_match_status). | Giả danh | Được dùng |
| `encounter_count` | số nguyên | Số đợt điều trị của người bệnh trong run này. | ≥ 0 |  | — | Được dùng |
| `source_input` | chuỗi | Nguồn danh sách đã tạo dòng (nếu file nguồn có ghi). |  |  | — | Được dùng |
| `source_run_id` | chuỗi | Mã đợt dữ liệu (run) đã tạo ra dòng này. |  |  | — | Được dùng |
| `row_hash` | chuỗi | Mã băm nội dung dòng (16 ký tự hex), để phát hiện trùng/thay đổi giữa các lần chuẩn hóa. |  |  | — | Được dùng |

## encounters

**File:** `encounters.csv` · **Tầng:** chuẩn hóa · **Có biến suy luận:** không

**Mỗi dòng là:** Một đợt điều trị nội trú. Các dòng chuyển khoa của cùng đợt (chung Mã nội trú) được gộp làm một.

**Khóa chính (duy nhất):** `encounter_id`

**Khóa nối:** `patient_code` → `patients.patient_code` · Được nối từ: `diagnoses`, `lab_results`, `imaging_results`, `surgery_results`, `medication_orders`, `medication_day_summary`, `clinical_notes`, `patient_day`, `extract_status`, `analysis_ready`

**Nguồn:** research_source.csv (từ du_lieu_ban_dau.csv); du_lieu_goc.csv (script XN/CĐHA); hchanh_profile.csv; hchanh_discharge.csv (mục Ra khoa); hchanh_surgery.csv

**Cách xử lý:** Ghép các nguồn theo khóa EMR (Research key, Mã điều trị/Mã nội trú, Mã vào viện) rồi mới theo thời gian. Khi gộp dòng cùng đợt, ngày vào là thời điểm vào sớm nhất. Không ghép theo họ tên.

**Quy tắc chất lượng**

- Bắt buộc: `encounter_id`, `patient_code`
- Duy nhất: `encounter_id`, `research_code`
- Trùng encounter_id hoặc Mã NC: lỗi chặn.
- patient_code không có trong patients: lỗi chặn.
- Thiếu ngày vào viện, ngày ra trước ngày vào, ngày ở tương lai, nằm viện > 365 ngày: cảnh báo, đưa vào encounter_review.csv.

**Cần người kiểm tra khi:**

- needs_manual_review khác trống
- Cặp đợt cùng BN chồng lấn/cùng ngày ra viện nhưng không chung khóa EMR (possible_same_stay).

| Cột | Kiểu | Ý nghĩa | Giá trị / đơn vị | Ô trống nghĩa là | Định danh | Dùng |
|---|---|---|---|---|---|---|
| `encounter_id` | chuỗi | Khóa chính của đợt điều trị (Research key). Cách tính: Băm (sha1 rút gọn) theo thứ tự ưu tiên: Mã điều trị/Mã nội trú → Mã vào viện → Mã BN + thời điểm vào/ra → Mã NC. | Dạng: enc_<16 ký tự hex>; enc_unresolved_… nếu không đủ căn cứ ghép | Không được trống (bắt buộc). | Giả danh | Được dùng |
| `research_code` | chuỗi | Mã NC: mã giả danh của đợt điều trị, dùng thay tên khi xuất ẩn danh. Nguồn: research_source.csv (cấp khi tạo nguồn chuẩn) hoặc mã script XN/CĐHA đã cấp cho cùng đợt. | Dạng: NC + 4 chữ số (ví dụ NC0012) | Chưa ghép được đợt (xem encounter_match_status). | Giả danh | Được dùng |
| `patient_code` | chuỗi | Mã BN trên EMR. Nguồn: Cột Mã BN của danh sách nội trú / file thô. |  | Không được trống (bắt buộc). | Trực tiếp | Loại (bị che khi xuất) |
| `admission_date` | ngày giờ | Thời điểm vào viện (vào khoa đầu tiên của đợt). Nguồn: Ngày vào viện (hồ sơ) hoặc T/G vào sớm nhất trên danh sách. |  | Không đọc được ngày vào. | Gián tiếp | Cần đề cương duyệt |
| `discharge_date` | ngày giờ | Thời điểm ra viện. Nguồn: Mục Ra khoa (hchanh_discharge). |  | Chưa ra viện hoặc chưa lấy hồ sơ ra viện. | Gián tiếp | Cần đề cương duyệt |
| `treatment_duration` | chuỗi | Số ngày điều trị như EMR ghi. Lưu ý: Giữ nguyên văn bản EMR, không tính lại. | Đơn vị: ngày |  | — | Được dùng |
| `department` | chuỗi | Khoa điều trị. |  |  | Gián tiếp | Được dùng |
| `room_bed` | chuỗi | Phòng/giường. |  |  | Gián tiếp | Cần đề cương duyệt |
| `admission_diagnosis` | văn bản | Chẩn đoán vào viện (nguyên văn). |  |  | Văn bản tự do | Cần đề cương duyệt |
| `discharge_diagnosis` | văn bản | Chẩn đoán ra viện (nguyên văn, thường có mã ICD đầu dòng). |  |  | Văn bản tự do | Cần đề cương duyệt |
| `diagnosis_raw` | văn bản | Chẩn đoán dùng để phân tích: chẩn đoán ra viện, nếu trống thì chẩn đoán vào viện. |  |  | Văn bản tự do | Cần đề cương duyệt |
| `comorbidity_text` | văn bản | Bệnh kèm/bệnh nền (nguyên văn). |  |  | Văn bản tự do | Cần đề cương duyệt |
| `complication_text` | văn bản | Biến chứng/tai biến (nguyên văn). |  |  | Văn bản tự do | Cần đề cương duyệt |
| `discharge_status` | chuỗi | Tình trạng/kết quả khi ra viện như EMR ghi (ví dụ "Đỡ, giảm"). Lưu ý: Giá trị phụ thuộc danh mục EMR; chưa chuẩn hóa. |  |  | — | Được dùng |
| `surgery_date` | ngày | Ngày mổ (nếu có) theo nguồn đợt điều trị. |  | Không mổ hoặc chưa có dữ liệu phẫu thuật. | Gián tiếp | Cần đề cương duyệt |
| `emr_admission_id` | chuỗi | Mã vào viện trên EMR. |  |  | Trực tiếp | Loại (bị che khi xuất) |
| `emr_treatment_id` | chuỗi | Mã điều trị trên EMR. |  |  | Trực tiếp | Loại (bị che khi xuất) |
| `emr_noitru_id` | chuỗi | Mã nội trú (noitruid) trên EMR; các dòng chuyển khoa của cùng đợt dùng chung mã này. |  |  | Trực tiếp | Loại (bị che khi xuất) |
| `needs_manual_review` | chuỗi | Lý do cần người kiểm tra, nối bằng "; ". Trống = không có vấn đề đã biết. | Ví dụ: encounter_match_ambiguous, encounter_match_missing. |  | — | Được dùng |
| `source_run_id` | chuỗi | Mã đợt dữ liệu (run) đã tạo ra dòng này. |  |  | — | Được dùng |
| `source_status` | chuỗi | Các nguồn đã góp vào đợt, nối bằng "+". | initial, sample, deep, hchanh_profile, hchanh_discharge |  | — | Được dùng |
| `row_hash` | chuỗi | Mã băm nội dung dòng (16 ký tự hex), để phát hiện trùng/thay đổi giữa các lần chuẩn hóa. |  |  | — | Được dùng |

## diagnoses

**File:** `diagnoses.csv` · **Tầng:** chuẩn hóa · **Có biến suy luận:** có

**Mỗi dòng là:** Một chẩn đoán của một đợt (vào viện, ra viện, bệnh kèm hoặc biến chứng).

**Khóa chính (duy nhất):** `diagnosis_id`

**Khóa nối:** `encounter_id` → `encounters.encounter_id`

**Nguồn:** encounters.csv (các cột chẩn đoán)

**Cách xử lý:** Tách 4 cột chẩn đoán của encounters thành từng dòng; mã ICD lấy bằng biểu thức A00 hoặc A00.0 đầu tiên trong văn bản.

**Quy tắc chất lượng**

- Bắt buộc: `diagnosis_id`, `encounter_id`, `diagnosis_type`
- Duy nhất: `diagnosis_id`
- Trùng diagnosis_id: lỗi chặn.

**Cần người kiểm tra khi:**

- icd_code trống nhưng diagnosis_text có nội dung.

| Cột | Kiểu | Ý nghĩa | Giá trị / đơn vị | Ô trống nghĩa là | Định danh | Dùng |
|---|---|---|---|---|---|---|
| `diagnosis_id` | chuỗi | Khóa dòng: dx_<row_hash>. |  |  | — | Được dùng |
| `research_code` | chuỗi | Mã NC: mã giả danh của đợt điều trị, dùng thay tên khi xuất ẩn danh. Nguồn: research_source.csv (cấp khi tạo nguồn chuẩn) hoặc mã script XN/CĐHA đã cấp cho cùng đợt. | Dạng: NC + 4 chữ số (ví dụ NC0012) | Chưa ghép được đợt (xem encounter_match_status). | Giả danh | Được dùng |
| `patient_code` | chuỗi | Mã BN trên EMR. Nguồn: Cột Mã BN của danh sách nội trú / file thô. |  | Không được trống (bắt buộc). | Trực tiếp | Loại (bị che khi xuất) |
| `encounter_id` | chuỗi | Khóa đợt điều trị (Research key), nối về encounters.encounter_id. Cách tính: Băm (sha1 rút gọn) theo thứ tự ưu tiên: Mã điều trị/Mã nội trú → Mã vào viện → Mã BN + thời điểm vào/ra → Mã NC. | Dạng: enc_<16 ký tự hex>; enc_unresolved_… nếu không đủ căn cứ ghép | Dòng chưa gắn được vào đợt nào (encounter_match_status = ambiguous/missing). | Giả danh | Được dùng |
| `diagnosis_date` | ngày | Ngày ra viện cho chẩn đoán ra viện; ngày vào viện cho các loại còn lại. |  |  | Gián tiếp | Cần đề cương duyệt |
| `diagnosis_type` | danh mục | Loại chẩn đoán. | `admission`, `discharge`, `comorbidity`, `complication` |  | — | Được dùng |
| `icd_code` | chuỗi | Mã ICD-10 tách tự động từ văn bản. **Suy luận tự động.** | Dạng: A00 hoặc A00.0 | Văn bản không có mã ICD; không tự đoán mã. | — | Được dùng |
| `diagnosis_text` | văn bản | Nội dung chẩn đoán (nguyên văn). |  |  | Văn bản tự do | Cần đề cương duyệt |
| `source` | chuỗi | Nguồn của dòng. | Ví dụ: encounter, hchanh_auto_surgery, hchanh_order_history, surgery_raw. |  | — | Được dùng |
| `source_run_id` | chuỗi | Mã đợt dữ liệu (run) đã tạo ra dòng này. |  |  | — | Được dùng |
| `row_hash` | chuỗi | Mã băm nội dung dòng (16 ký tự hex), để phát hiện trùng/thay đổi giữa các lần chuẩn hóa. |  |  | — | Được dùng |

## lab_results

**File:** `lab_results.csv` · **Tầng:** chuẩn hóa · **Có biến suy luận:** không

**Mỗi dòng là:** Một kết quả xét nghiệm (một chỉ số trong một phiếu).

**Khóa chính (duy nhất):** `lab_result_id`

**Khóa nối:** `encounter_id` → `encounters.encounter_id` (khi encounter_match_status = matched)

**Nguồn:** lich_su_xn.csv (script XN/CĐHA, popup lịch sử xét nghiệm trên EMR)

**Cách xử lý:** Giữ nguyên kết quả gốc; tách dấu so sánh, phần số và phần chữ; tên chỉ số chuẩn hóa theo bảng từ khóa. Không quy đổi đơn vị. Cùng BN + cùng thời điểm + cùng chỉ số là một kết quả (bệnh viện xác nhận): dòng thô giống hệt nhau chỉ giữ một.

**Quy tắc chất lượng**

- Bắt buộc: `lab_result_id`, `patient_code`, `test_name_raw`
- Duy nhất: `lab_result_id`
- Dòng thô giống hệt nhau: giữ một, cảnh báo số dòng đã bỏ (duplicate_raw_rows_removed).
- Trùng lab_result_id sau khi bỏ dòng giống hệt: lỗi chặn.
- encounter_match_status = ambiguous/missing: cảnh báo.

**Cần người kiểm tra khi:**

- Cùng BN + cùng thời điểm + cùng chỉ số nhưng kết quả khác nhau (conflicting_lab_result): giữ tất cả, không tự chọn.
- result_num trống nhưng result_raw có số
- Đơn vị khác nhau cho cùng test_name_norm trong một nghiên cứu.

| Cột | Kiểu | Ý nghĩa | Giá trị / đơn vị | Ô trống nghĩa là | Định danh | Dùng |
|---|---|---|---|---|---|---|
| `lab_result_id` | chuỗi | Khóa dòng: lab_<row_hash>. |  |  | — | Được dùng |
| `research_code` | chuỗi | Mã NC: mã giả danh của đợt điều trị, dùng thay tên khi xuất ẩn danh. Nguồn: research_source.csv (cấp khi tạo nguồn chuẩn) hoặc mã script XN/CĐHA đã cấp cho cùng đợt. | Dạng: NC + 4 chữ số (ví dụ NC0012) | Chưa ghép được đợt (xem encounter_match_status). | Giả danh | Được dùng |
| `patient_code` | chuỗi | Mã BN trên EMR. Nguồn: Cột Mã BN của danh sách nội trú / file thô. |  | Không được trống (bắt buộc). | Trực tiếp | Loại (bị che khi xuất) |
| `encounter_id` | chuỗi | Khóa đợt điều trị (Research key), nối về encounters.encounter_id. Cách tính: Băm (sha1 rút gọn) theo thứ tự ưu tiên: Mã điều trị/Mã nội trú → Mã vào viện → Mã BN + thời điểm vào/ra → Mã NC. | Dạng: enc_<16 ký tự hex>; enc_unresolved_… nếu không đủ căn cứ ghép | Dòng chưa gắn được vào đợt nào (encounter_match_status = ambiguous/missing). | Giả danh | Được dùng |
| `encounter_match_status` | danh mục | Kết quả gắn dòng vào đợt điều trị. Cách tính: matched: khớp khóa EMR/Mã NC/khoảng thời gian duy nhất; ambiguous: khớp nhiều đợt; missing: không khớp đợt nào. Không tự gắn dòng ambiguous/missing. | `matched`, `ambiguous`, `missing` |  | — | Được dùng |
| `lab_datetime` | ngày giờ | Thời điểm chỉ định/xét nghiệm. |  |  | Gián tiếp | Cần đề cương duyệt |
| `lab_date` | ngày | Ngày xét nghiệm. |  |  | Gián tiếp | Cần đề cương duyệt |
| `lab_group` | chuỗi | Nhóm xét nghiệm như EMR ghi (huyết học, sinh hóa…). |  |  | — | Được dùng |
| `test_name_raw` | chuỗi | Tên chỉ số như EMR ghi. |  |  | — | Được dùng |
| `test_name_norm` | chuỗi | Tên chỉ số chuẩn hóa. Cách tính: So khớp từ khóa (không dấu) theo thứ tự; khớp đầu tiên thắng. | `creatinine`, `egfr`, `wbc`, `crp`, `hemoglobin`, `hct`, `neutrophil`, `lymphocyte`, `monocyte`, `rdw`, `platelet`, `urea`, `ast`, `alt`, `glucose`, `(tên gốc dạng token nếu không khớp)` |  | — | Được dùng |
| `result_raw` | chuỗi | Kết quả nguyên văn. |  |  | — | Được dùng |
| `result_operator` | danh mục | Dấu so sánh đứng đầu kết quả. | `<`, `>`, `<=`, `>=`, `=` | Không có dấu. | — | Được dùng |
| `result_num` | số thập phân | Phần số đầu tiên trong kết quả. | Đơn vị: theo cột unit | Kết quả không có số (ví dụ "Âm tính"). | — | Được dùng |
| `result_text` | chuỗi | Kết quả dạng chữ khi kết quả không thuần số. |  | Kết quả chỉ là số. | — | Được dùng |
| `unit` | chuỗi | Đơn vị như EMR ghi. |  | EMR không ghi đơn vị. | — | Được dùng |
| `ref_range_raw` | chuỗi | Khoảng tham chiếu như EMR ghi. |  |  | — | Được dùng |
| `flag_raw` | chuỗi | Cờ bất thường như EMR ghi. |  |  | — | Được dùng |
| `flag_norm` | danh mục | Cờ bất thường đã chuẩn hóa. | `high`, `low`, `abnormal`, `normal`, `unknown` | EMR không đánh dấu. | — | Được dùng |
| `days_from_admission` | số nguyên | Số ngày từ ngày vào viện đến thời điểm của dòng (tính theo ngày lịch, 0 = cùng ngày vào viện). | Đơn vị: ngày; Có thể âm (trước ngày vào viện). | Thiếu ngày vào viện hoặc thời điểm của dòng. | — | Được dùng |
| `days_from_surgery` | số nguyên | Số ngày từ ngày mổ của đợt đến thời điểm của dòng (0 = ngày mổ). | Đơn vị: ngày; Có thể âm. | Đợt không có ngày mổ hoặc thiếu thời điểm. | — | Được dùng |
| `days_from_discharge` | số nguyên | Số ngày từ ngày ra viện đến thời điểm của dòng (âm = trước ngày ra viện). | Đơn vị: ngày | Chưa có ngày ra viện hoặc thiếu thời điểm. | — | Được dùng |
| `is_within_encounter` | cờ 1/0 | Thời điểm của dòng nằm trong khoảng vào viện → ra viện của đợt. Cách tính: Nếu chưa có ngày ra viện, dùng mốc ngày vào + 60 ngày làm giới hạn trên. | `1`, `0` | Thiếu ngày vào viện hoặc thời điểm của dòng. | — | Được dùng |
| `source_run_id` | chuỗi | Mã đợt dữ liệu (run) đã tạo ra dòng này. |  |  | — | Được dùng |
| `row_hash` | chuỗi | Mã băm nội dung dòng (16 ký tự hex), để phát hiện trùng/thay đổi giữa các lần chuẩn hóa. |  |  | — | Được dùng |

## imaging_results

**File:** `imaging_results.csv` · **Tầng:** chuẩn hóa · **Có biến suy luận:** có

**Mỗi dòng là:** Một dịch vụ chẩn đoán hình ảnh/thăm dò.

**Khóa chính (duy nhất):** `imaging_id`

**Khóa nối:** `encounter_id` → `encounters.encounter_id` (khi encounter_match_status = matched)

**Nguồn:** lich_su_cdha.csv (script XN/CĐHA)

**Cách xử lý:** Loại máy lấy từ Nhóm dịch vụ, nếu trống thì suy từ tên dịch vụ; vùng cơ thể suy từ tên dịch vụ. Dòng thô giống hệt nhau chỉ giữ một.

**Quy tắc chất lượng**

- Bắt buộc: `imaging_id`, `patient_code`
- Duy nhất: `imaging_id`
- Dòng thô giống hệt nhau: giữ một, cảnh báo số dòng đã bỏ.
- Trùng imaging_id: lỗi chặn.
- Ghép đợt ambiguous/missing: cảnh báo.

**Cần người kiểm tra khi:**

- Cùng BN + cùng thời điểm + cùng dịch vụ nhưng kết quả khác nhau (conflicting_imaging_result).
- modality = Khác
- body_region trống

| Cột | Kiểu | Ý nghĩa | Giá trị / đơn vị | Ô trống nghĩa là | Định danh | Dùng |
|---|---|---|---|---|---|---|
| `imaging_id` | chuỗi | Khóa dòng: img_<row_hash>. |  |  | — | Được dùng |
| `research_code` | chuỗi | Mã NC: mã giả danh của đợt điều trị, dùng thay tên khi xuất ẩn danh. Nguồn: research_source.csv (cấp khi tạo nguồn chuẩn) hoặc mã script XN/CĐHA đã cấp cho cùng đợt. | Dạng: NC + 4 chữ số (ví dụ NC0012) | Chưa ghép được đợt (xem encounter_match_status). | Giả danh | Được dùng |
| `patient_code` | chuỗi | Mã BN trên EMR. Nguồn: Cột Mã BN của danh sách nội trú / file thô. |  | Không được trống (bắt buộc). | Trực tiếp | Loại (bị che khi xuất) |
| `encounter_id` | chuỗi | Khóa đợt điều trị (Research key), nối về encounters.encounter_id. Cách tính: Băm (sha1 rút gọn) theo thứ tự ưu tiên: Mã điều trị/Mã nội trú → Mã vào viện → Mã BN + thời điểm vào/ra → Mã NC. | Dạng: enc_<16 ký tự hex>; enc_unresolved_… nếu không đủ căn cứ ghép | Dòng chưa gắn được vào đợt nào (encounter_match_status = ambiguous/missing). | Giả danh | Được dùng |
| `encounter_match_status` | danh mục | Kết quả gắn dòng vào đợt điều trị. Cách tính: matched: khớp khóa EMR/Mã NC/khoảng thời gian duy nhất; ambiguous: khớp nhiều đợt; missing: không khớp đợt nào. Không tự gắn dòng ambiguous/missing. | `matched`, `ambiguous`, `missing` |  | — | Được dùng |
| `ordered_at` | ngày giờ | Thời điểm chỉ định. |  |  | Gián tiếp | Cần đề cương duyệt |
| `order_date` | ngày | Ngày chỉ định. |  |  | Gián tiếp | Cần đề cương duyệt |
| `service_name_raw` | chuỗi | Tên dịch vụ như EMR ghi. |  |  | — | Được dùng |
| `modality` | danh mục | Loại kỹ thuật. **Suy luận tự động.** | `CT`, `MRI`, `Siêu âm`, `X-quang`, `DEXA`, `Điện tim`, `Khác`, `(giá trị Nhóm dịch vụ của EMR nếu có)` |  | — | Được dùng |
| `body_region` | danh mục | Vùng cơ thể suy từ tên dịch vụ. **Suy luận tự động.** Lưu ý: Nhãn "Há/khu chậu" là lỗi chính tả trong code (đúng là "Háng/khung chậu"); giữ nguyên để không đổi dữ liệu cũ. | `Ngực/phổi`, `Bụng`, `Tim mạch`, `Cột sống`, `Gối`, `Há/khu chậu`, `Sọ não`, `Cổ` | Không nhận ra vùng. | — | Được dùng |
| `result_text` | văn bản | Mô tả kết quả (nguyên văn). |  |  | Văn bản tự do | Cần đề cương duyệt |
| `conclusion_text` | văn bản | Kết luận (nguyên văn). |  |  | Văn bản tự do | Cần đề cương duyệt |
| `status` | chuỗi | Trạng thái dịch vụ như EMR ghi. |  |  | — | Được dùng |
| `days_from_admission` | số nguyên | Số ngày từ ngày vào viện đến thời điểm của dòng (tính theo ngày lịch, 0 = cùng ngày vào viện). | Đơn vị: ngày; Có thể âm (trước ngày vào viện). | Thiếu ngày vào viện hoặc thời điểm của dòng. | — | Được dùng |
| `days_from_surgery` | số nguyên | Số ngày từ ngày mổ của đợt đến thời điểm của dòng (0 = ngày mổ). | Đơn vị: ngày; Có thể âm. | Đợt không có ngày mổ hoặc thiếu thời điểm. | — | Được dùng |
| `days_from_discharge` | số nguyên | Số ngày từ ngày ra viện đến thời điểm của dòng (âm = trước ngày ra viện). | Đơn vị: ngày | Chưa có ngày ra viện hoặc thiếu thời điểm. | — | Được dùng |
| `is_within_encounter` | cờ 1/0 | Thời điểm của dòng nằm trong khoảng vào viện → ra viện của đợt. Cách tính: Nếu chưa có ngày ra viện, dùng mốc ngày vào + 60 ngày làm giới hạn trên. | `1`, `0` | Thiếu ngày vào viện hoặc thời điểm của dòng. | — | Được dùng |
| `source_run_id` | chuỗi | Mã đợt dữ liệu (run) đã tạo ra dòng này. |  |  | — | Được dùng |
| `row_hash` | chuỗi | Mã băm nội dung dòng (16 ký tự hex), để phát hiện trùng/thay đổi giữa các lần chuẩn hóa. |  |  | — | Được dùng |

## surgery_results

**File:** `surgery_results.csv` · **Tầng:** chuẩn hóa · **Có biến suy luận:** không

**Mỗi dòng là:** Một ca phẫu thuật/thủ thuật.

**Khóa chính (duy nhất):** `surgery_id`

**Khóa nối:** `encounter_id` → `encounters.encounter_id` (khi encounter_match_status = matched)

**Nguồn:** hchanh_surgery.csv (D/s phẫu thuật, tìm theo mốc PT trong lịch sử y lệnh); lich_su_phau_thuat.csv / phau_thuat.csv (nếu có)

**Cách xử lý:** Bỏ dòng không có ngày, tên và phương pháp; gộp các dòng trùng ca mổ.

**Quy tắc chất lượng**

- Bắt buộc: `surgery_id`, `patient_code`
- Duy nhất: `surgery_id`
- Trùng surgery_id: lỗi chặn.
- Ghép đợt ambiguous/missing: cảnh báo.

**Cần người kiểm tra khi:**

- surgery_date nằm ngoài khoảng đợt (is_within_encounter = 0).

| Cột | Kiểu | Ý nghĩa | Giá trị / đơn vị | Ô trống nghĩa là | Định danh | Dùng |
|---|---|---|---|---|---|---|
| `surgery_id` | chuỗi | Khóa dòng: surg_<row_hash>. |  |  | — | Được dùng |
| `research_code` | chuỗi | Mã NC: mã giả danh của đợt điều trị, dùng thay tên khi xuất ẩn danh. Nguồn: research_source.csv (cấp khi tạo nguồn chuẩn) hoặc mã script XN/CĐHA đã cấp cho cùng đợt. | Dạng: NC + 4 chữ số (ví dụ NC0012) | Chưa ghép được đợt (xem encounter_match_status). | Giả danh | Được dùng |
| `patient_code` | chuỗi | Mã BN trên EMR. Nguồn: Cột Mã BN của danh sách nội trú / file thô. |  | Không được trống (bắt buộc). | Trực tiếp | Loại (bị che khi xuất) |
| `encounter_id` | chuỗi | Khóa đợt điều trị (Research key), nối về encounters.encounter_id. Cách tính: Băm (sha1 rút gọn) theo thứ tự ưu tiên: Mã điều trị/Mã nội trú → Mã vào viện → Mã BN + thời điểm vào/ra → Mã NC. | Dạng: enc_<16 ký tự hex>; enc_unresolved_… nếu không đủ căn cứ ghép | Dòng chưa gắn được vào đợt nào (encounter_match_status = ambiguous/missing). | Giả danh | Được dùng |
| `encounter_match_status` | danh mục | Kết quả gắn dòng vào đợt điều trị. Cách tính: matched: khớp khóa EMR/Mã NC/khoảng thời gian duy nhất; ambiguous: khớp nhiều đợt; missing: không khớp đợt nào. Không tự gắn dòng ambiguous/missing. | `matched`, `ambiguous`, `missing` |  | — | Được dùng |
| `surgery_datetime` | ngày giờ | Thời điểm bắt đầu mổ. |  |  | Gián tiếp | Cần đề cương duyệt |
| `surgery_date` | ngày | Ngày mổ. |  |  | Gián tiếp | Cần đề cương duyệt |
| `surgery_name` | chuỗi | Tên phẫu thuật/dịch vụ. |  |  | — | Được dùng |
| `surgery_method` | văn bản | Phương pháp phẫu thuật (nguyên văn). |  |  | Văn bản tự do | Cần đề cương duyệt |
| `anesthesia_method` | chuỗi | Phương pháp vô cảm. |  |  | — | Được dùng |
| `surgery_class` | chuỗi | Phân loại phẫu thuật như EMR ghi (đặc biệt, loại 1…). |  |  | — | Được dùng |
| `status` | chuỗi | Trạng thái ca mổ. |  |  | — | Được dùng |
| `preop_diagnosis` | văn bản | Chẩn đoán trước mổ. |  |  | Văn bản tự do | Cần đề cương duyệt |
| `postop_diagnosis` | văn bản | Chẩn đoán sau mổ. |  |  | Văn bản tự do | Cần đề cương duyệt |
| `operating_room` | chuỗi | Phòng mổ. |  |  | Gián tiếp | Được dùng |
| `days_from_admission` | số nguyên | Số ngày từ ngày vào viện đến thời điểm của dòng (tính theo ngày lịch, 0 = cùng ngày vào viện). | Đơn vị: ngày; Có thể âm (trước ngày vào viện). | Thiếu ngày vào viện hoặc thời điểm của dòng. | — | Được dùng |
| `days_from_discharge` | số nguyên | Số ngày từ ngày ra viện đến thời điểm của dòng (âm = trước ngày ra viện). | Đơn vị: ngày | Chưa có ngày ra viện hoặc thiếu thời điểm. | — | Được dùng |
| `is_within_encounter` | cờ 1/0 | Thời điểm của dòng nằm trong khoảng vào viện → ra viện của đợt. Cách tính: Nếu chưa có ngày ra viện, dùng mốc ngày vào + 60 ngày làm giới hạn trên. | `1`, `0` | Thiếu ngày vào viện hoặc thời điểm của dòng. | — | Được dùng |
| `source` | chuỗi | Nguồn của dòng. | Ví dụ: encounter, hchanh_auto_surgery, hchanh_order_history, surgery_raw. |  | — | Được dùng |
| `source_run_id` | chuỗi | Mã đợt dữ liệu (run) đã tạo ra dòng này. |  |  | — | Được dùng |
| `row_hash` | chuỗi | Mã băm nội dung dòng (16 ký tự hex), để phát hiện trùng/thay đổi giữa các lần chuẩn hóa. |  |  | — | Được dùng |

## medication_orders

**File:** `medication_orders.csv` · **Tầng:** chuẩn hóa · **Có biến suy luận:** có

**Mỗi dòng là:** Một dòng thuốc trong một y lệnh.

**Khóa chính (duy nhất):** `med_order_id`

**Khóa nối:** `encounter_id` → `encounters.encounter_id` (khi encounter_match_status = matched)

**Nguồn:** hchanh_order_history.csv (lịch sử y lệnh trên màn bác sĩ)

**Cách xử lý:** Tách nội dung y lệnh thành từng dòng; chỉ giữ dòng có từ khóa thuốc (tt, viên, ống, chai, uống, tiêm, truyền…). Đường dùng và nhóm thuốc suy từ văn bản. Ngày hậu phẫu tính theo ca mổ đầu tiên CÙNG đợt.

**Quy tắc chất lượng**

- Bắt buộc: `med_order_id`, `patient_code`, `drug_name_raw`
- Duy nhất: `med_order_id`
- Trùng med_order_id: lỗi chặn.
- Ghép đợt ambiguous/missing: cảnh báo.

**Cần người kiểm tra khi:**

- route_norm không thuộc danh sách chuẩn
- drug_group_guess trống với thuốc cần phân tích

| Cột | Kiểu | Ý nghĩa | Giá trị / đơn vị | Ô trống nghĩa là | Định danh | Dùng |
|---|---|---|---|---|---|---|
| `med_order_id` | chuỗi | Khóa dòng: med_<row_hash>. |  |  | — | Được dùng |
| `research_code` | chuỗi | Mã NC: mã giả danh của đợt điều trị, dùng thay tên khi xuất ẩn danh. Nguồn: research_source.csv (cấp khi tạo nguồn chuẩn) hoặc mã script XN/CĐHA đã cấp cho cùng đợt. | Dạng: NC + 4 chữ số (ví dụ NC0012) | Chưa ghép được đợt (xem encounter_match_status). | Giả danh | Được dùng |
| `patient_code` | chuỗi | Mã BN trên EMR. Nguồn: Cột Mã BN của danh sách nội trú / file thô. |  | Không được trống (bắt buộc). | Trực tiếp | Loại (bị che khi xuất) |
| `encounter_id` | chuỗi | Khóa đợt điều trị (Research key), nối về encounters.encounter_id. Cách tính: Băm (sha1 rút gọn) theo thứ tự ưu tiên: Mã điều trị/Mã nội trú → Mã vào viện → Mã BN + thời điểm vào/ra → Mã NC. | Dạng: enc_<16 ký tự hex>; enc_unresolved_… nếu không đủ căn cứ ghép | Dòng chưa gắn được vào đợt nào (encounter_match_status = ambiguous/missing). | Giả danh | Được dùng |
| `encounter_match_status` | danh mục | Kết quả gắn dòng vào đợt điều trị. Cách tính: matched: khớp khóa EMR/Mã NC/khoảng thời gian duy nhất; ambiguous: khớp nhiều đợt; missing: không khớp đợt nào. Không tự gắn dòng ambiguous/missing. | `matched`, `ambiguous`, `missing` |  | — | Được dùng |
| `order_datetime` | ngày giờ | Thời điểm y lệnh. |  |  | Gián tiếp | Cần đề cương duyệt |
| `order_date` | ngày | Ngày y lệnh. |  |  | Gián tiếp | Cần đề cương duyệt |
| `drug_name_raw` | chuỗi | Tên thuốc/dòng y lệnh (tối đa 180 ký tự, bỏ tiền tố "(TT)"). |  |  | — | Được dùng |
| `drug_name_norm` | chuỗi | Tên thuốc dạng token: bỏ phần trong ngoặc, bỏ dấu, chữ thường, nối bằng "_". **Suy luận tự động.** |  |  | — | Được dùng |
| `drug_group_guess` | chuỗi | Nhóm thuốc suy theo tên (có thể nhiều nhóm, nối "; "). **Suy luận tự động.** | `giảm_đau`, `kháng_sinh`, `kháng_kết_tập_tiểu_cầu`, `kháng_đông`, `dạ_dày`, `đái_tháo_đường` | Không thuộc danh sách hoạt chất đã biết (không có nghĩa là không phải thuốc). | — | Được dùng |
| `active_ingredient` | chuỗi | Hoạt chất (nếu nguồn có). |  |  | — | Được dùng |
| `route_raw` | chuỗi | Đường dùng gốc (nếu không có cột riêng thì là cả dòng y lệnh). |  |  | — | Được dùng |
| `route_norm` | chuỗi | Đường dùng chuẩn hóa. **Suy luận tự động.** | `truyền_tĩnh_mạch`, `tiêm_tĩnh_mạch`, `tiêm_bắp`, `tiêm_dưới_da`, `uống`, `bôi`, `khí_dung`, `(token văn bản gốc nếu không khớp)` |  | — | Được dùng |
| `dose_raw` | chuỗi | Liều (nếu không có cột riêng thì là cả dòng y lệnh). |  |  | — | Được dùng |
| `times_per_day` | chuỗi | Số lần/ngày (nếu nguồn có). |  |  | — | Được dùng |
| `raw_line` | văn bản | Dòng y lệnh gốc. |  |  | Văn bản tự do | Cần đề cương duyệt |
| `surgery_datetime_ref` | ngày giờ | Thời điểm ca mổ đầu tiên của cùng đợt, dùng làm mốc hậu phẫu. |  |  | Gián tiếp | Cần đề cương duyệt |
| `surgery_date_ref` | ngày | Ngày ca mổ mốc. |  |  | Gián tiếp | Cần đề cương duyệt |
| `postop_day_index` | số nguyên | Ngày hậu phẫu (0 = ngày mổ, âm = trước mổ). | Đơn vị: ngày | Đợt không có ca mổ đã ghép — không phải ngày 0. | — | Được dùng |
| `postop_day_label` | chuỗi | Nhãn ngày hậu phẫu: N<postop_day_index>. | Dạng: N-1, N0, N1… |  | — | Được dùng |
| `is_postop_day_1_3` | cờ 1/0 | Y lệnh thuộc hậu phẫu ngày 1–3. | `1`, `0` | Không có ca mổ mốc. | — | Được dùng |
| `days_from_admission` | số nguyên | Số ngày từ ngày vào viện đến thời điểm của dòng (tính theo ngày lịch, 0 = cùng ngày vào viện). | Đơn vị: ngày; Có thể âm (trước ngày vào viện). | Thiếu ngày vào viện hoặc thời điểm của dòng. | — | Được dùng |
| `days_from_discharge` | số nguyên | Số ngày từ ngày ra viện đến thời điểm của dòng (âm = trước ngày ra viện). | Đơn vị: ngày | Chưa có ngày ra viện hoặc thiếu thời điểm. | — | Được dùng |
| `is_within_encounter` | cờ 1/0 | Thời điểm của dòng nằm trong khoảng vào viện → ra viện của đợt. Cách tính: Nếu chưa có ngày ra viện, dùng mốc ngày vào + 60 ngày làm giới hạn trên. | `1`, `0` | Thiếu ngày vào viện hoặc thời điểm của dòng. | — | Được dùng |
| `source` | chuỗi | Nguồn của dòng. | Ví dụ: encounter, hchanh_auto_surgery, hchanh_order_history, surgery_raw. |  | — | Được dùng |
| `source_run_id` | chuỗi | Mã đợt dữ liệu (run) đã tạo ra dòng này. |  |  | — | Được dùng |
| `row_hash` | chuỗi | Mã băm nội dung dòng (16 ký tự hex), để phát hiện trùng/thay đổi giữa các lần chuẩn hóa. |  |  | — | Được dùng |

## medication_day_summary

**File:** `medication_day_summary.csv` · **Tầng:** chuẩn hóa · **Có biến suy luận:** không

**Mỗi dòng là:** Một ngày y lệnh của một đợt (tổng hợp các thuốc trong ngày).

**Khóa chính (duy nhất):** `encounter_id`, `order_date`

**Khóa nối:** `encounter_id` → `encounters.encounter_id`

**Nguồn:** medication_orders.csv (chỉ dòng đã gắn đợt và có ngày)

**Cách xử lý:** Nhóm theo đợt + ngày y lệnh.

**Quy tắc chất lượng**

- Bắt buộc: `encounter_id`, `order_date`
- Duy nhất: `encounter_id + order_date`

**Cần người kiểm tra khi:**

- (không có)

| Cột | Kiểu | Ý nghĩa | Giá trị / đơn vị | Ô trống nghĩa là | Định danh | Dùng |
|---|---|---|---|---|---|---|
| `research_code` | chuỗi | Mã NC: mã giả danh của đợt điều trị, dùng thay tên khi xuất ẩn danh. Nguồn: research_source.csv (cấp khi tạo nguồn chuẩn) hoặc mã script XN/CĐHA đã cấp cho cùng đợt. | Dạng: NC + 4 chữ số (ví dụ NC0012) | Chưa ghép được đợt (xem encounter_match_status). | Giả danh | Được dùng |
| `patient_code` | chuỗi | Mã BN trên EMR. Nguồn: Cột Mã BN của danh sách nội trú / file thô. |  | Không được trống (bắt buộc). | Trực tiếp | Loại (bị che khi xuất) |
| `encounter_id` | chuỗi | Khóa đợt điều trị (Research key), nối về encounters.encounter_id. Cách tính: Băm (sha1 rút gọn) theo thứ tự ưu tiên: Mã điều trị/Mã nội trú → Mã vào viện → Mã BN + thời điểm vào/ra → Mã NC. | Dạng: enc_<16 ký tự hex>; enc_unresolved_… nếu không đủ căn cứ ghép | Dòng chưa gắn được vào đợt nào (encounter_match_status = ambiguous/missing). | Giả danh | Được dùng |
| `order_date` | ngày | Ngày y lệnh. |  |  | Gián tiếp | Cần đề cương duyệt |
| `drug_count` | số nguyên | Số dòng thuốc trong ngày. | ≥ 1 |  | — | Được dùng |
| `route_set` | chuỗi | Các đường dùng trong ngày, nối "; ". |  |  | — | Được dùng |
| `drugs_display` | chuỗi | Tối đa 20 tên thuốc trong ngày, nối "; ". |  |  | — | Được dùng |
| `drugs_json` | JSON | Toàn bộ tên thuốc trong ngày (mảng JSON). |  |  | — | Được dùng |
| `source_run_id` | chuỗi | Mã đợt dữ liệu (run) đã tạo ra dòng này. |  |  | — | Được dùng |
| `row_hash` | chuỗi | Mã băm nội dung dòng (16 ký tự hex), để phát hiện trùng/thay đổi giữa các lần chuẩn hóa. |  |  | — | Được dùng |

## clinical_notes

**File:** `clinical_notes.csv` · **Tầng:** chuẩn hóa · **Có biến suy luận:** không

**Mỗi dòng là:** Một dòng lịch sử y lệnh (diễn biến + nội dung y lệnh).

**Khóa chính (duy nhất):** `note_id`

**Khóa nối:** `encounter_id` → `encounters.encounter_id` (khi encounter_match_status = matched)

**Nguồn:** hchanh_order_history.csv

**Cách xử lý:** Giữ nguyên văn diễn biến và y lệnh; bỏ dòng không có nội dung.

**Quy tắc chất lượng**

- Bắt buộc: `note_id`, `patient_code`
- Duy nhất: `note_id`
- Trùng note_id: lỗi chặn.
- Ghép đợt ambiguous/missing: cảnh báo.

**Cần người kiểm tra khi:**

- (không có)

| Cột | Kiểu | Ý nghĩa | Giá trị / đơn vị | Ô trống nghĩa là | Định danh | Dùng |
|---|---|---|---|---|---|---|
| `note_id` | chuỗi | Khóa dòng: note_<row_hash>. |  |  | — | Được dùng |
| `research_code` | chuỗi | Mã NC: mã giả danh của đợt điều trị, dùng thay tên khi xuất ẩn danh. Nguồn: research_source.csv (cấp khi tạo nguồn chuẩn) hoặc mã script XN/CĐHA đã cấp cho cùng đợt. | Dạng: NC + 4 chữ số (ví dụ NC0012) | Chưa ghép được đợt (xem encounter_match_status). | Giả danh | Được dùng |
| `patient_code` | chuỗi | Mã BN trên EMR. Nguồn: Cột Mã BN của danh sách nội trú / file thô. |  | Không được trống (bắt buộc). | Trực tiếp | Loại (bị che khi xuất) |
| `encounter_id` | chuỗi | Khóa đợt điều trị (Research key), nối về encounters.encounter_id. Cách tính: Băm (sha1 rút gọn) theo thứ tự ưu tiên: Mã điều trị/Mã nội trú → Mã vào viện → Mã BN + thời điểm vào/ra → Mã NC. | Dạng: enc_<16 ký tự hex>; enc_unresolved_… nếu không đủ căn cứ ghép | Dòng chưa gắn được vào đợt nào (encounter_match_status = ambiguous/missing). | Giả danh | Được dùng |
| `encounter_match_status` | danh mục | Kết quả gắn dòng vào đợt điều trị. Cách tính: matched: khớp khóa EMR/Mã NC/khoảng thời gian duy nhất; ambiguous: khớp nhiều đợt; missing: không khớp đợt nào. Không tự gắn dòng ambiguous/missing. | `matched`, `ambiguous`, `missing` |  | — | Được dùng |
| `note_datetime` | ngày giờ | Thời điểm y lệnh. |  |  | Gián tiếp | Cần đề cương duyệt |
| `note_date` | ngày | Ngày y lệnh. |  |  | Gián tiếp | Cần đề cương duyệt |
| `doctor_name` | chuỗi | Bác sĩ ra y lệnh. Lưu ý: Thông tin nhân viên y tế; hiện KHÔNG bị che tự động khi xuất. |  |  | Nhân viên | Cần đề cương duyệt |
| `note_type` | danh mục | Loại ghi chép. | `order_history` |  | — | Được dùng |
| `clinical_text` | văn bản | Diễn biến bệnh (nguyên văn). |  |  | Văn bản tự do | Cần đề cương duyệt |
| `order_text` | văn bản | Nội dung y lệnh (nguyên văn). |  |  | Văn bản tự do | Cần đề cương duyệt |
| `status` | chuỗi | Trạng thái y lệnh. |  |  | — | Được dùng |
| `days_from_admission` | số nguyên | Số ngày từ ngày vào viện đến thời điểm của dòng (tính theo ngày lịch, 0 = cùng ngày vào viện). | Đơn vị: ngày; Có thể âm (trước ngày vào viện). | Thiếu ngày vào viện hoặc thời điểm của dòng. | — | Được dùng |
| `days_from_discharge` | số nguyên | Số ngày từ ngày ra viện đến thời điểm của dòng (âm = trước ngày ra viện). | Đơn vị: ngày | Chưa có ngày ra viện hoặc thiếu thời điểm. | — | Được dùng |
| `is_within_encounter` | cờ 1/0 | Thời điểm của dòng nằm trong khoảng vào viện → ra viện của đợt. Cách tính: Nếu chưa có ngày ra viện, dùng mốc ngày vào + 60 ngày làm giới hạn trên. | `1`, `0` | Thiếu ngày vào viện hoặc thời điểm của dòng. | — | Được dùng |
| `source` | chuỗi | Nguồn của dòng. | Ví dụ: encounter, hchanh_auto_surgery, hchanh_order_history, surgery_raw. |  | — | Được dùng |
| `source_run_id` | chuỗi | Mã đợt dữ liệu (run) đã tạo ra dòng này. |  |  | — | Được dùng |
| `row_hash` | chuỗi | Mã băm nội dung dòng (16 ký tự hex), để phát hiện trùng/thay đổi giữa các lần chuẩn hóa. |  |  | — | Được dùng |

## patient_day

**File:** `patient_day.csv` · **Tầng:** chuẩn hóa · **Có biến suy luận:** không

**Mỗi dòng là:** Một ngày có hoạt động (XN/CĐHA/mổ/thuốc) của một đợt.

**Khóa chính (duy nhất):** `encounter_id`, `date`

**Khóa nối:** `encounter_id` → `encounters.encounter_id`

**Nguồn:** lab_results; imaging_results; surgery_results; medication_orders (chỉ dòng đã gắn đợt)

**Cách xử lý:** Nhóm theo đợt + ngày. Ngày không có hoạt động nào thì không có dòng.

**Quy tắc chất lượng**

- Bắt buộc: `encounter_id`, `date`
- Duy nhất: `encounter_id + date`

**Cần người kiểm tra khi:**

- hospital_day ≤ 0 (hoạt động trước ngày vào viện).

| Cột | Kiểu | Ý nghĩa | Giá trị / đơn vị | Ô trống nghĩa là | Định danh | Dùng |
|---|---|---|---|---|---|---|
| `research_code` | chuỗi | Mã NC: mã giả danh của đợt điều trị, dùng thay tên khi xuất ẩn danh. Nguồn: research_source.csv (cấp khi tạo nguồn chuẩn) hoặc mã script XN/CĐHA đã cấp cho cùng đợt. | Dạng: NC + 4 chữ số (ví dụ NC0012) | Chưa ghép được đợt (xem encounter_match_status). | Giả danh | Được dùng |
| `patient_code` | chuỗi | Mã BN trên EMR. Nguồn: Cột Mã BN của danh sách nội trú / file thô. |  | Không được trống (bắt buộc). | Trực tiếp | Loại (bị che khi xuất) |
| `encounter_id` | chuỗi | Khóa đợt điều trị (Research key), nối về encounters.encounter_id. Cách tính: Băm (sha1 rút gọn) theo thứ tự ưu tiên: Mã điều trị/Mã nội trú → Mã vào viện → Mã BN + thời điểm vào/ra → Mã NC. | Dạng: enc_<16 ký tự hex>; enc_unresolved_… nếu không đủ căn cứ ghép | Dòng chưa gắn được vào đợt nào (encounter_match_status = ambiguous/missing). | Giả danh | Được dùng |
| `date` | ngày | Ngày. |  |  | Gián tiếp | Cần đề cương duyệt |
| `hospital_day` | số nguyên | Ngày nằm viện thứ mấy (1 = ngày vào viện). | Đơn vị: ngày | Thiếu ngày vào viện. | — | Được dùng |
| `has_lab` | cờ 1/0 | Có xét nghiệm trong ngày. | `1`, `0` |  | — | Được dùng |
| `lab_count` | số nguyên | Số kết quả XN trong ngày. |  |  | — | Được dùng |
| `has_imaging` | cờ 1/0 | Có CĐHA trong ngày. | `1`, `0` |  | — | Được dùng |
| `imaging_count` | số nguyên | Số CĐHA trong ngày. |  |  | — | Được dùng |
| `has_surgery` | cờ 1/0 | Có mổ trong ngày. | `1`, `0` |  | — | Được dùng |
| `surgery_count` | số nguyên | Số ca mổ trong ngày. |  |  | — | Được dùng |
| `has_medication` | cờ 1/0 | Có y lệnh thuốc trong ngày. | `1`, `0` |  | — | Được dùng |
| `medication_count` | số nguyên | Số dòng thuốc trong ngày. |  |  | — | Được dùng |
| `hb` | chuỗi | Kết quả hb trong ngày (result_raw nguyên văn). Cách tính: Lấy từ lab_results có test_name_norm tương ứng (hemoglobin). Nếu trong ngày có nhiều kết quả, lấy kết quả gặp đầu tiên theo thứ tự file (không phải theo giờ). | Đơn vị: theo lab_results.unit (không quy đổi) | Không có kết quả chỉ số này. | — | Được dùng |
| `hct` | chuỗi | Kết quả hct trong ngày (result_raw nguyên văn). Cách tính: Lấy từ lab_results có test_name_norm tương ứng (hct). Nếu trong ngày có nhiều kết quả, lấy kết quả gặp đầu tiên theo thứ tự file (không phải theo giờ). | Đơn vị: theo lab_results.unit (không quy đổi) | Không có kết quả chỉ số này. | — | Được dùng |
| `neutrophil` | chuỗi | Kết quả neutrophil trong ngày (result_raw nguyên văn). Cách tính: Lấy từ lab_results có test_name_norm tương ứng (neutrophil). Nếu trong ngày có nhiều kết quả, lấy kết quả gặp đầu tiên theo thứ tự file (không phải theo giờ). | Đơn vị: theo lab_results.unit (không quy đổi) | Không có kết quả chỉ số này. | — | Được dùng |
| `lymphocyte` | chuỗi | Kết quả lymphocyte trong ngày (result_raw nguyên văn). Cách tính: Lấy từ lab_results có test_name_norm tương ứng (lymphocyte). Nếu trong ngày có nhiều kết quả, lấy kết quả gặp đầu tiên theo thứ tự file (không phải theo giờ). | Đơn vị: theo lab_results.unit (không quy đổi) | Không có kết quả chỉ số này. | — | Được dùng |
| `monocyte` | chuỗi | Kết quả monocyte trong ngày (result_raw nguyên văn). Cách tính: Lấy từ lab_results có test_name_norm tương ứng (monocyte). Nếu trong ngày có nhiều kết quả, lấy kết quả gặp đầu tiên theo thứ tự file (không phải theo giờ). | Đơn vị: theo lab_results.unit (không quy đổi) | Không có kết quả chỉ số này. | — | Được dùng |
| `rdw` | chuỗi | Kết quả rdw trong ngày (result_raw nguyên văn). Cách tính: Lấy từ lab_results có test_name_norm tương ứng (rdw). Nếu trong ngày có nhiều kết quả, lấy kết quả gặp đầu tiên theo thứ tự file (không phải theo giờ). | Đơn vị: theo lab_results.unit (không quy đổi) | Không có kết quả chỉ số này. | — | Được dùng |
| `plt` | chuỗi | Kết quả plt trong ngày (result_raw nguyên văn). Cách tính: Lấy từ lab_results có test_name_norm tương ứng (platelet). Nếu trong ngày có nhiều kết quả, lấy kết quả gặp đầu tiên theo thứ tự file (không phải theo giờ). | Đơn vị: theo lab_results.unit (không quy đổi) | Không có kết quả chỉ số này. | — | Được dùng |
| `creatinine` | chuỗi | Kết quả creatinine trong ngày (result_raw nguyên văn). Cách tính: Lấy từ lab_results có test_name_norm tương ứng (creatinine). Nếu trong ngày có nhiều kết quả, lấy kết quả gặp đầu tiên theo thứ tự file (không phải theo giờ). | Đơn vị: theo lab_results.unit (không quy đổi) | Không có kết quả chỉ số này. | — | Được dùng |
| `egfr` | chuỗi | Kết quả egfr trong ngày (result_raw nguyên văn). Cách tính: Lấy từ lab_results có test_name_norm tương ứng (egfr). Nếu trong ngày có nhiều kết quả, lấy kết quả gặp đầu tiên theo thứ tự file (không phải theo giờ). | Đơn vị: theo lab_results.unit (không quy đổi) | Không có kết quả chỉ số này. | — | Được dùng |
| `wbc` | chuỗi | Kết quả wbc trong ngày (result_raw nguyên văn). Cách tính: Lấy từ lab_results có test_name_norm tương ứng (wbc). Nếu trong ngày có nhiều kết quả, lấy kết quả gặp đầu tiên theo thứ tự file (không phải theo giờ). | Đơn vị: theo lab_results.unit (không quy đổi) | Không có kết quả chỉ số này. | — | Được dùng |
| `crp` | chuỗi | Kết quả crp trong ngày (result_raw nguyên văn). Cách tính: Lấy từ lab_results có test_name_norm tương ứng (crp). Nếu trong ngày có nhiều kết quả, lấy kết quả gặp đầu tiên theo thứ tự file (không phải theo giờ). | Đơn vị: theo lab_results.unit (không quy đổi) | Không có kết quả chỉ số này. | — | Được dùng |
| `source_run_id` | chuỗi | Mã đợt dữ liệu (run) đã tạo ra dòng này. |  |  | — | Được dùng |
| `row_hash` | chuỗi | Mã băm nội dung dòng (16 ký tự hex), để phát hiện trùng/thay đổi giữa các lần chuẩn hóa. |  |  | — | Được dùng |

## extract_status

**File:** `extract_status.csv` · **Tầng:** chuẩn hóa · **Có biến suy luận:** không

**Mỗi dòng là:** Một đợt: tiến độ lấy dữ liệu và mức sẵn sàng phân tích.

**Khóa chính (duy nhất):** `encounter_id`

**Khóa nối:** `encounter_id` → `encounters.encounter_id`

**Nguồn:** progress.json (XN/CĐHA); hchanh_auto_progress.json; order_history_auto_progress.json

**Cách xử lý:** Chọn bản ghi tiến độ khớp nhất với đợt (khóa đợt → Mã NC → Mã BN + ngày vào/ra; chỉ dùng Mã BN khi BN có đúng 1 đợt). Hành chánh dùng trạng thái riêng từng file khi có. Trạng thái chi tiết hơn (lý do lỗi, số lần thử, đã đổi trên EMR) nằm ở collection_ledger.json / collection_exceptions.csv.

**Quy tắc chất lượng**

- Bắt buộc: `encounter_id`
- Duy nhất: `encounter_id`
- "empty" = đã lấy xong, EMR xác nhận không có; không phải lỗi

**Cần người kiểm tra khi:**

- overall_status = error
- một phần = blocked (cần người xem)
- missing_required chứa encounter_match

| Cột | Kiểu | Ý nghĩa | Giá trị / đơn vị | Ô trống nghĩa là | Định danh | Dùng |
|---|---|---|---|---|---|---|
| `research_code` | chuỗi | Mã NC: mã giả danh của đợt điều trị, dùng thay tên khi xuất ẩn danh. Nguồn: research_source.csv (cấp khi tạo nguồn chuẩn) hoặc mã script XN/CĐHA đã cấp cho cùng đợt. | Dạng: NC + 4 chữ số (ví dụ NC0012) | Chưa ghép được đợt (xem encounter_match_status). | Giả danh | Được dùng |
| `encounter_id` | chuỗi | Khóa đợt điều trị (Research key), nối về encounters.encounter_id. Cách tính: Băm (sha1 rút gọn) theo thứ tự ưu tiên: Mã điều trị/Mã nội trú → Mã vào viện → Mã BN + thời điểm vào/ra → Mã NC. | Dạng: enc_<16 ký tự hex>; enc_unresolved_… nếu không đủ căn cứ ghép | Dòng chưa gắn được vào đợt nào (encounter_match_status = ambiguous/missing). | Giả danh | Được dùng |
| `patient_code` | chuỗi | Mã BN trên EMR. Nguồn: Cột Mã BN của danh sách nội trú / file thô. |  | Không được trống (bắt buộc). | Trực tiếp | Loại (bị che khi xuất) |
| `patient_name` | chuỗi | Họ tên (để hiển thị tiến độ). |  |  | Trực tiếp | Loại (bị che khi xuất) |
| `popup_status` | chuỗi | Đã mở được hồ sơ XN/CĐHA. | `done`, `error`, `blocked`, `(khác/trống = chưa làm)` |  | — | Được dùng |
| `xn_status` | chuỗi | Trạng thái lấy XN. | `done = có dữ liệu`, `empty = EMR không có`, `error = lỗi kỹ thuật`, `blocked = cần người xem`, `(khác/trống = chưa làm)` |  | — | Được dùng |
| `cdha_status` | chuỗi | Trạng thái lấy CĐHA. | `done = có dữ liệu`, `empty = EMR không có`, `error = lỗi kỹ thuật`, `blocked = cần người xem`, `(khác/trống = chưa làm)` |  | — | Được dùng |
| `profile_status` | chuỗi | Trạng thái lấy hồ sơ nền. | `done`, `empty`, `partial`, `error`, `blocked`, `skipped_recent_failure`, `(trống = chưa làm)` |  | — | Được dùng |
| `discharge_status` | chuỗi | Trạng thái lấy ra viện. | `done`, `empty`, `partial`, `error`, `blocked`, `skipped_recent_failure`, `(trống)` |  | — | Được dùng |
| `surgery_status` | chuỗi | Trạng thái lấy phẫu thuật. | `done`, `empty`, `partial`, `error`, `blocked`, `skipped_recent_failure`, `(trống)` |  | — | Được dùng |
| `order_history_status` | chuỗi | Trạng thái lấy lịch sử y lệnh. | `done`, `empty`, `partial`, `error`, `blocked`, `skipped_recent_failure`, `(trống)` |  | — | Được dùng |
| `overall_status` | danh mục | Trạng thái chung. | `done`, `error`, `pending` |  | — | Được dùng |
| `completion_level` | danh mục | Mức đầy đủ. Cách tính: full_required: đủ mọi phần bắt buộc; clinical_admin: đủ XN/CĐHA + hồ sơ nền + ra viện; xn_cdha: chỉ đủ XN/CĐHA; partial: còn lại. | `full_required`, `clinical_admin`, `xn_cdha`, `partial` |  | — | Được dùng |
| `ready_for_analysis` | cờ 1/0 | Đủ điều kiện đưa vào dataset cuối. Cách tính: Không lỗi VÀ đủ XN/CĐHA, hồ sơ nền, ra viện; phẫu thuật chỉ bắt buộc khi đợt có mổ; y lệnh bắt buộc khi có mổ hoặc có thuốc; đợt phải ghép chắc chắn. | `1`, `0` |  | — | Được dùng |
| `missing_required` | chuỗi | Phần bắt buộc còn thiếu, nối "; ". | `xn_cdha`, `profile`, `discharge`, `surgery`, `order_history`, `encounter_match` |  | — | Được dùng |
| `lab_count` | số nguyên | Số kết quả XN đã gắn vào đợt. |  |  | — | Được dùng |
| `imaging_count` | số nguyên | Số CĐHA đã gắn vào đợt. |  |  | — | Được dùng |
| `surgery_count` | số nguyên | Số ca mổ đã gắn vào đợt. |  |  | — | Được dùng |
| `medication_count` | số nguyên | Số dòng thuốc đã gắn vào đợt. |  |  | — | Được dùng |
| `last_error` | chuỗi | Lỗi gần nhất khi lấy XN/CĐHA. Lưu ý: Thông báo kỹ thuật; có thể chứa Mã BN. |  |  | — | Được dùng |
| `source_run_id` | chuỗi | Mã đợt dữ liệu (run) đã tạo ra dòng này. |  |  | — | Được dùng |

## analysis_ready

**File:** `analysis_ready.csv` · **Tầng:** phân tích · **Có biến suy luận:** có

**Mỗi dòng là:** Một đợt điều trị: bảng rộng sẵn để phân tích.

**Khóa chính (duy nhất):** `encounter_id`

**Khóa nối:** `encounter_id` → `encounters.encounter_id`; `patient_code` → `patients.patient_code`

**Nguồn:** encounters; patients; lab_results; imaging_results; surgery_results

**Cách xử lý:** Một dòng mỗi đợt. XN lấy kết quả SỚM NHẤT của đợt; phẫu thuật lấy ca SỚM NHẤT của đợt; biến suy luận chạy trên chẩn đoán + văn bản CĐHA theo preset của nghiên cứu.

**Quy tắc chất lượng**

- Bắt buộc: `encounter_id`, `research_code`
- Duy nhất: `encounter_id`
- Dòng có needs_manual_review bị loại khỏi analysis_final.csv.

**Cần người kiểm tra khi:**

- needs_manual_review khác trống (thiếu biến bắt buộc của preset, ghép đợt không chắc chắn).
- Mọi biến suy luận cần người xác nhận trước khi dùng.

**Cột sinh động (không cố định):**

- Cột suy luận theo preset (ví dụ injury_side_suggested, hip_fracture_suggested, spine_involved, joint_type_suggested, neuro_deficit, stroke_type): suy từ văn bản chẩn đoán + CĐHA bằng từ khóa; ô trống = không tìm thấy từ khóa, KHÔNG có nghĩa là "không". Cần người xác nhận.
- Cột tự định nghĩa của nghiên cứu (custom_fields): so mẫu trên văn bản chẩn đoán đã bỏ dấu; cột boolean luôn là 1/0.

| Cột | Kiểu | Ý nghĩa | Giá trị / đơn vị | Ô trống nghĩa là | Định danh | Dùng |
|---|---|---|---|---|---|---|
| `research_code` | chuỗi | Mã NC: mã giả danh của đợt điều trị, dùng thay tên khi xuất ẩn danh. Nguồn: research_source.csv (cấp khi tạo nguồn chuẩn) hoặc mã script XN/CĐHA đã cấp cho cùng đợt. | Dạng: NC + 4 chữ số (ví dụ NC0012) | Chưa ghép được đợt (xem encounter_match_status). | Giả danh | Được dùng |
| `encounter_id` | chuỗi | Khóa đợt điều trị (Research key), nối về encounters.encounter_id. Cách tính: Băm (sha1 rút gọn) theo thứ tự ưu tiên: Mã điều trị/Mã nội trú → Mã vào viện → Mã BN + thời điểm vào/ra → Mã NC. | Dạng: enc_<16 ký tự hex>; enc_unresolved_… nếu không đủ căn cứ ghép | Dòng chưa gắn được vào đợt nào (encounter_match_status = ambiguous/missing). | Giả danh | Được dùng |
| `patient_code` | chuỗi | Mã BN trên EMR. Nguồn: Cột Mã BN của danh sách nội trú / file thô. |  | Không được trống (bắt buộc). | Trực tiếp | Loại (bị che khi xuất) |
| `patient_name` | chuỗi | Họ tên. |  |  | Trực tiếp | Loại (bị che khi xuất) |
| `sex` | danh mục | Giới tính. | `Nam`, `Nữ` |  | Gián tiếp | Được dùng |
| `birth_year` | số nguyên | Năm sinh. |  |  | Gián tiếp | Cần đề cương duyệt |
| `age` | chuỗi | Tuổi như EMR ghi. |  |  | Gián tiếp | Cần đề cương duyệt |
| `admission_date` | ngày giờ | Thời điểm vào viện. |  |  | Gián tiếp | Cần đề cương duyệt |
| `surgery_date` | ngày giờ | Thời điểm ca mổ sớm nhất của đợt. |  | Không có ca mổ đã ghép. | Gián tiếp | Cần đề cương duyệt |
| `discharge_date` | ngày giờ | Thời điểm ra viện. |  |  | Gián tiếp | Cần đề cương duyệt |
| `hospital_stay_days` | chuỗi | Số ngày nằm viện. Cách tính: Lấy "Thời gian điều trị" của EMR nếu có; nếu không, tính (ngày ra − ngày vào) + 1. | Đơn vị: ngày | Chưa có ngày ra viện. | — | Được dùng |
| `time_to_surgery_hours` | số thập phân | Số giờ từ vào viện đến ca mổ sớm nhất (làm tròn 0,1). | Đơn vị: giờ; Âm là bất thường → cần kiểm tra. | Không mổ hoặc thiếu thời điểm. | — | Được dùng |
| `diagnosis_raw` | văn bản | Chẩn đoán (ra viện, nếu trống thì vào viện). |  |  | Văn bản tự do | Cần đề cương duyệt |
| `surgery_name` | chuỗi | Tên ca mổ sớm nhất. |  |  | — | Được dùng |
| `surgery_method` | văn bản | Phương pháp ca mổ sớm nhất. |  |  | Văn bản tự do | Cần đề cương duyệt |
| `anesthesia_method` | chuỗi | Vô cảm của ca mổ sớm nhất. |  |  | — | Được dùng |
| `comorbidity_text` | văn bản | Bệnh kèm. |  |  | Văn bản tự do | Cần đề cương duyệt |
| `complication_text` | văn bản | Biến chứng. |  |  | Văn bản tự do | Cần đề cương duyệt |
| `hb` | chuỗi | Kết quả hb đầu tiên của đợt (result_raw nguyên văn). Cách tính: Lấy từ lab_results có test_name_norm tương ứng (hemoglobin). Kết quả có lab_datetime sớm nhất trong đợt. | Đơn vị: theo lab_results.unit (không quy đổi) | Không có kết quả chỉ số này. | — | Được dùng |
| `hct` | chuỗi | Kết quả hct đầu tiên của đợt (result_raw nguyên văn). Cách tính: Lấy từ lab_results có test_name_norm tương ứng (hct). Kết quả có lab_datetime sớm nhất trong đợt. | Đơn vị: theo lab_results.unit (không quy đổi) | Không có kết quả chỉ số này. | — | Được dùng |
| `neutrophil` | chuỗi | Kết quả neutrophil đầu tiên của đợt (result_raw nguyên văn). Cách tính: Lấy từ lab_results có test_name_norm tương ứng (neutrophil). Kết quả có lab_datetime sớm nhất trong đợt. | Đơn vị: theo lab_results.unit (không quy đổi) | Không có kết quả chỉ số này. | — | Được dùng |
| `lymphocyte` | chuỗi | Kết quả lymphocyte đầu tiên của đợt (result_raw nguyên văn). Cách tính: Lấy từ lab_results có test_name_norm tương ứng (lymphocyte). Kết quả có lab_datetime sớm nhất trong đợt. | Đơn vị: theo lab_results.unit (không quy đổi) | Không có kết quả chỉ số này. | — | Được dùng |
| `monocyte` | chuỗi | Kết quả monocyte đầu tiên của đợt (result_raw nguyên văn). Cách tính: Lấy từ lab_results có test_name_norm tương ứng (monocyte). Kết quả có lab_datetime sớm nhất trong đợt. | Đơn vị: theo lab_results.unit (không quy đổi) | Không có kết quả chỉ số này. | — | Được dùng |
| `rdw` | chuỗi | Kết quả rdw đầu tiên của đợt (result_raw nguyên văn). Cách tính: Lấy từ lab_results có test_name_norm tương ứng (rdw). Kết quả có lab_datetime sớm nhất trong đợt. | Đơn vị: theo lab_results.unit (không quy đổi) | Không có kết quả chỉ số này. | — | Được dùng |
| `plt` | chuỗi | Kết quả plt đầu tiên của đợt (result_raw nguyên văn). Cách tính: Lấy từ lab_results có test_name_norm tương ứng (platelet). Kết quả có lab_datetime sớm nhất trong đợt. | Đơn vị: theo lab_results.unit (không quy đổi) | Không có kết quả chỉ số này. | — | Được dùng |
| `imaging_summary` | văn bản | Tên dịch vụ + mô tả + kết luận CĐHA của đợt, nối lại, tối đa 1200 ký tự. |  |  | Văn bản tự do | Cần đề cương duyệt |
| `needs_manual_review` | chuỗi | Lý do cần người kiểm tra, nối "; ". | Nhãn thiếu biến của preset (ví dụ "bên tổn thương", "ngày phẫu thuật") và cờ ghép đợt. |  | — | Được dùng |
| `source_run_id` | chuỗi | Mã đợt dữ liệu (run) đã tạo ra dòng này. |  |  | — | Được dùng |
| `row_hash` | chuỗi | Mã băm nội dung dòng (16 ký tự hex), để phát hiện trùng/thay đổi giữa các lần chuẩn hóa. |  |  | — | Được dùng |

## Bảng thô (đầu vào)

Bảng thô giữ nguyên dữ liệu EMR, **đều chứa định danh**, không dùng trực tiếp làm dataset nghiên cứu.

| File | Mỗi dòng là | Lấy từ | Cột định danh |
|---|---|---|---|
| `du_lieu_ban_dau.csv` | Một dòng trên danh sách nội trú EMR (mỗi khoa/lượt một dòng). | Nút "1. Quét danh sách" — màn D/s Điều trị nội trú. | Mã BN, Họ tên, Mã nội trú, URL bác sĩ, URL điều dưỡng (chứa Mã BN) |
| `research_source.csv` | Một đợt điều trị (đã gộp các dòng chung Mã nội trú). | Tạo từ du_lieu_ban_dau.csv; thêm Mã NC, Research key, fetch_from_date/fetch_to_date. | Mã BN, Họ tên, Mã nội trú, URL |
| `lich_su_xn.csv` | Một chỉ số xét nghiệm của một phiếu. | Script XN/CĐHA — popup lịch sử xét nghiệm. | Mã BN, Mã vào viện, Mã điều trị, Người chỉ định (nhân viên) |
| `lich_su_cdha.csv` | Một dịch vụ CĐHA. | Script XN/CĐHA. | Mã BN, Mã vào viện, Mã điều trị, Người chỉ định (nhân viên) |
| `hchanh_profile.csv` | Một dòng nguồn (Research key). | Lấy hành chánh — màn điều dưỡng (con mắt). | Mã BN, Họ tên, Ngày sinh, Địa chỉ, Điện thoại, Số CMND, Số thẻ BHYT |
| `hchanh_discharge.csv` | Một dòng nguồn. | Lấy hành chánh — mục Ra khoa trên màn bác sĩ. | Mã BN, Họ tên, Số lưu trữ |
| `hchanh_surgery.csv` | Một ca PT/TT. | Lấy hành chánh — D/s phẫu thuật. | Mã BN, Họ tên, Raw JSON |
| `hchanh_order_history.csv` | Một dòng lịch sử y lệnh. | Lấy hành chánh — Lịch sử y lệnh. | Mã BN, Họ tên, Bác sĩ (nhân viên), Raw JSON |

## Hạn chế đã biết

- analysis_ready: khi chọn kết quả XN sớm nhất, dòng thiếu lab_datetime được coi là sớm nhất.
- patient_day: nhiều kết quả cùng chỉ số trong một ngày thì lấy kết quả gặp đầu tiên theo thứ tự file, không theo giờ.
- clinical_notes.doctor_name (tên nhân viên) chưa bị che tự động khi xuất.
- Nhãn body_region "Há/khu chậu" sai chính tả (đúng là "Háng/khung chậu").
