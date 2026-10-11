# Ánh xạ field: web app (emrwebapp) ↔ công cụ nhập cổng BHYT

`bhyt/emrwebapp_client.py` dịch dữ liệu đã rà soát ở tab "Nghỉ ốm" (`GET /api/sick-leave-import`,
sinh ra bởi `worker/parse_bhxh_sick_leave_list.py`) sang tên field nội bộ mà `bhyt/portal.py`
dùng để điền form thật trên `gdbhyt.baohiemxahoi.gov.vn`. Nếu BHXH đổi tên cột trong file Excel
gửi rà soát, chỉ cần sửa `COLUMN_KEY_MAP` ở `worker/parse_bhxh_sick_leave_list.py` — 2 bảng dưới
đây vẫn đúng miễn cột nguồn vẫn map ra đúng key cột trái.

## Ngoại trú — Giấy nghỉ hưởng BHXH (mẫu 07)

| Key từ emrwebapp (`_map_bhxh_row`) | Key nội bộ bhyt (`_fill_bhxh` trong `portal.py`) | Ghi chú |
| --- | --- | --- |
| `ma_chung_tu` | `ma_ct` | |
| `so_seri` | `so_seri` | |
| *(không có trong file BHXH)* | `so_kcb` | Luôn để trống — bổ sung tay qua nút "Bổ sung" |
| `mau_so` | `mau_so` | Mặc định "07" nếu thiếu |
| `ma_so_bh` | `ma_bhxh` | |
| `ma_the` | `ma_the` | |
| `ho_ten` | `ho_ten` | |
| `ngay_sinh` | `ngay_sinh` | |
| `gioi_tinh` | `gioi_tinh` | |
| `don_vi` | `ten_dv` | |
| *(không có trong file BHXH)* | `ngay_kcb` | Luôn để trống |
| `chan_doan` | `chan_doan` | |
| `dieu_tri_tu_ngay` | `tu_ngay` | |
| `dieu_tri_den_ngay` | `den_ngay` | |
| `ho_ten_cha` | `ho_ten_cha` | Chỉ có nếu Excel có cột này |
| `ho_ten_me` | `ho_ten_me` | Chỉ có nếu Excel có cột này |
| `thu_truong` | `nguoi_dai_dien` | |
| `nguoi_hanh_nghe` (dự phòng `bac_si_trong_danh_sach`) | `doctor_text` | |
| `ngay_chung_tu` | `ngay_ct` | |
| *(không có)* | `loai_giay_to`, `so_cccd`, `ngaycap_cccd`, `noicap_cccd` | Luôn để trống |

## Nội trú — Giấy ra viện (mẫu 03)

| Key từ emrwebapp (`_map_grv_row`) | Key nội bộ bhyt (`_fill_grv` trong `portal.py`) | Ghi chú |
| --- | --- | --- |
| `so_luu_tru` | `ma_ct` | |
| `ma_y_te` | `so_seri` | |
| `ma_so_bh` | `ma_bhxh` | |
| `ma_the` | `ma_the` | |
| `ho_ten` | `ho_ten` | |
| `ngay_sinh` | `ngay_sinh` | |
| `ho_ten_me` | `ho_ten_me` | Chỉ có nếu Excel có cột này |
| `ho_ten_cha` | `ho_ten_cha` | Chỉ có nếu Excel có cột này |
| `gioi_tinh` | `gioi_tinh` | |
| `nghe_nghiep` | `nghe_nghiep` | |
| `khoa` | `ma_khoa` | |
| `dan_toc` | `dan_toc` | |
| `dia_chi` | `dia_chi` | |
| `ngay_vao_vien` | `tu_ngay` | |
| `ngay_ra_vien` | `den_ngay` | |
| `dinh_chi_thai_nghen` | `dc_thainghen` | Chỉ có nếu Excel có cột này |
| `tuoi_thai` | `tuoi_thai` | Chỉ có nếu Excel có cột này |
| `chan_doan` | `chan_doan` | |
| `phuong_phap_dieu_tri` | `pp_dieutri` | |
| `ghi_chu` | `ghi_chu` | Field "Ghi chú" thật trên form — **khác** `ra_soat_ghi_chu_bo_sung` (ghi chú rà soát của BHXH, dùng để lọc bỏ qua, không đưa vào form) |
| `thu_truong_don_vi` | `nguoi_dai_dien` | |
| `truong_khoa` (dự phòng `bac_si_trong_danh_sach`) | `doctor_text` | |
| `ngay_chung_tu` | `ngay_ct` | |
| `dieu_tri_ngoai_tru_tu_ngay` | `ngoaitru_tungay` | |
| `dieu_tri_ngoai_tru_den_ngay` | `ngoaitru_denngay` | |
| *(không có)* | `loai_giay_to` | Mặc định "Không có giấy tờ" |
| *(không có)* | `so_cccd`, `ngaycap_cccd`, `noicap_cccd` | Luôn để trống |

## Bộ lọc khi lấy từ web app (không có khi đọc Excel trực tiếp)

- **Bỏ qua ca đang bị flag "cần sửa"** — `review_has_issue()` đọc `so_loi_ra_soat` / `ra_soat_ghi_chu_bo_sung` / `ghi_chu_bo_sung`, y hệt `reviewHasIssue()` trong `src/components/SickLeaveTab.jsx`.
- **Bỏ qua ca đã tick "Đã nộp"** — tra theo key trong `GET /api/sick-leave-state`, dựng lại đúng công thức key mà `SickLeaveTab.jsx` dùng (`_bhxh_state_key`/`_grv_state_key` ↔ `bhxhOutpatientList`/`bhxhInpatientList` trong file đó). Nếu sửa công thức key ở 1 bên, phải sửa bên kia theo.

## Giấy ra viện đọc từ PDF EMR (`bhyt/pdf_giay_ra_vien.py`)

Luồng nội trú, giống luồng phiếu phòng khám: mở Danh sách Điều trị nội trú → hồ sơ người bệnh →
in "Giấy ra viện" (PDF) → `parse_grv_text` tách theo nhãn in trên giấy → điền mẫu 03.

| Nhãn trên giấy ra viện | Key nội bộ | Ghi chú |
| --- | --- | --- |
| Khoa | `ma_khoa` | Ô chọn trên cổng, chọn theo tên khoa |
| Mã y tế | `so_seri` | |
| Số lưu trữ | `ma_ct` | |
| Họ tên người bệnh | `ho_ten` | |
| Ngày/tháng/năm sinh | `ngay_sinh` | |
| Nam/Nữ (Giới tính) | `gioi_tinh` | |
| Dân tộc, Nghề nghiệp, Địa chỉ | `dan_toc`, `nghe_nghiep`, `dia_chi` | |
| Mã số BHXH/Thẻ BHYT số | `ma_the`, `ma_bhxh` | Chỉ có thẻ 15 ký tự thì mã BHXH = 10 số cuối |
| Vào viện lúc / Ra viện lúc | `tu_ngay`, `den_ngay` | Dạng `dd/mm/yyyy HH:MM` như file Excel |
| Chẩn đoán, Phương pháp điều trị, Ghi chú | `chan_doan`, `pp_dieutri`, `ghi_chu` | |
| "… ngoại trú từ ngày … đến (hết) ngày …" | `ngoaitru_tungay`, `ngoaitru_denngay` | |
| Họ tên cha / mẹ, Tuổi thai, Đình chỉ thai nghén | `ho_ten_cha`, `ho_ten_me`, `tuoi_thai`, `dc_thainghen` | |
| Dòng "…, ngày .. tháng .. năm .." chỗ ký | `ngay_ct` | |
| Tên dưới chữ "Trưởng khoa" | `doctor_text` | Chỉ nhận bác sĩ có trong `allowed_doctors` |

### Giấy ra viện thật của bệnh viện (MS: 01/BV-01)

Đối chiếu với mẫu PDF người dùng gửi: pdfminer bố cục mặc định làm lộn thứ tự dòng, nên
`extract_grv_text` đọc với `LAParams(line_margin=0.2, boxes_flow=None, char_margin=20)`.

- "Số hồ sơ/Số BA: NNN/2026/GRV" → `ma_ct` (khi không có "Số lưu trữ").
- Thẻ in tách ô ("DN 4 92 92 01234567 Giá trị từ …") → ghép lại `ma_the`, bỏ phần hạn thẻ.
- "Số CCCD/CMND/…: …. Ngày cấp: …" → `so_cccd`, `ngaycap_cccd`; có CCCD thì không đặt
  "Không có giấy tờ".
- "Nghỉ ốm từ ngày … đến (hết) ngày …" trong Ghi chú → `nghi_tu_ngay`, `nghi_den_ngay`.
- Giấy này **không in** Khoa, Mã y tế, Số lưu trữ và tên bác sĩ. `ma_khoa` và `doctor_text`
  lấy theo thứ tự: khoa/bác sĩ chọn trên giao diện khi quét (mặc định "Ngoại Chấn thương chỉnh
  hình - Thần kinh (K24)" và BS Nguyễn Lê Hoan, lưu vào `config.json` → `grv_defaults`), rồi tới
  cột "Khoa"/"Bác sĩ" của danh sách nội trú nếu có.

Chọn ngày ra viện (mặc định hôm nay): danh sách nội trú lọc trạng thái "Hoàn tất"
(`drpSelectTrangThai`), đặt "Khoảng" (`cbbLoai`, `dtTuNgay`/`dtDenNgay`) lùi 60 ngày tới ngày
đã chọn, rồi chỉ giữ dòng có cột Ngày ra viện đúng ngày đó. Các id này lấy từ
`worker/selenium_emr_helpers.py`.

Chỗ chưa xác nhận trên máy bệnh viện (chỉnh trong `config.json` → `emr.selectors`):
`grv_report_link` (chữ trên link phiếu in) hoặc `grv_report_id` (mã phiếu cho `OnReportPdf`).

### Bù từ "Thông tin bệnh nhân, chi phí" (`EmrPortal.read_patient_info`)

Luồng theo bản ghi của người dùng: Quản lý Bệnh nhân → Chuyển đối tượng bệnh nhân sang bảo hiểm →
D/s Bệnh nhân → tìm mã BN (`txtTimKiem`, `btnTimKiem`) → nút trên dòng trong
`divBenhNhanDanhSachContent` → "Thông tin bệnh nhân, chi phí". Chỉ đọc, không bấm Lưu.

| Ô EMR | Key nội bộ |
| --- | --- |
| `cbbDanToc` | `dan_toc` |
| `cbbLoaiGiayTo` | `loai_giay_to` (chỉ dùng khi có số CCCD; không thì giữ "Không có giấy tờ") |
| `txtSoCMND` | `so_cccd` |
| `txtNgayCap` | `ngaycap_cccd` |
| `cbbGioiTinh` | `gioi_tinh` |

Giấy ra viện là nguồn chính; các ô này chỉ bù chỗ giấy ra viện để trống.
