# Cơ sở dữ liệu SQLite cho phần Nghiên cứu

Sau mỗi lần **Chuẩn hóa**, hệ thống tự động tạo/cập nhật một file SQLite bên cạnh thư mục `runs`.

## Vị trí

Kho dữ liệu gốc:

```text
.runtime/research/research_store/du_lieu_goc/research.sqlite3
```

Nghiên cứu riêng:

```text
.runtime/research/research_store/<ma_nghien_cuu>/research.sqlite3
```

File mô tả bảng/cột:

```text
research.sqlite3.manifest.json
```

## Nội dung chính

- `patients`
- `encounters`
- `diagnoses`
- `lab_results`
- `imaging_results`
- `surgery_results`
- `medication_orders`
- `clinical_notes`
- `patient_day`
- `analysis_ready`
- `analysis_selected` nếu có
- `analysis_final` nếu đã chốt dataset
- các bảng raw và encoded nếu file nguồn tồn tại

Các bảng kỹ thuật:

- `research_meta`: phiên bản schema, mã nghiên cứu, run mới nhất.
- `table_manifest`: số dòng, số cột và checksum từng CSV nguồn.
- `column_manifest`: ánh xạ tên cột CSV sang tên cột SQLite.

Các view tiện dùng:

- `v_analysis_dataset`: tự trỏ tới `analysis_final`, rồi `analysis_selected`, rồi `analysis_ready`.
- `v_encounter_summary`: một dòng mỗi lượt điều trị kèm số lượng XN, CĐHA, phẫu thuật và y lệnh thuốc.

## Lưu ý bảo mật

SQLite chứa dữ liệu định danh. Không gửi file ra ngoài hệ thống khi chưa được phê duyệt. API tải file vẫn tuân theo `EMR_ALLOW_IDENTIFIED_RESEARCH_EXPORT` và yêu cầu quyền supervisor/admin.
