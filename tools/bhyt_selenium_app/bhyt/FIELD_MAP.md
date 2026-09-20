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
