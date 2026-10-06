# Kiến thức thuốc nằm ở đâu

Mỗi loại thông tin thuốc chỉ có **một** nơi lưu. Muốn đổi cách xử lý dữ liệu thì sửa đúng nơi đó.
Không viết thêm danh sách tên thuốc vào code.

| Thông tin | Nơi lưu | Ai sửa |
|---|---|---|
| Thuốc của khoa: tên chuẩn, tên khác, hoạt chất, đường dùng, thể tích/tốc độ mặc định, **quy tắc pha**, tên hiển thị, "có dung môi đi kèm" | `config/medication_catalog.json` — màn **Danh mục thuốc → Thuốc** | Người dùng, trên màn hình |
| Kiến thức sẵn có đi kèm phần mềm: luật pha (Vancomycin, Merovia, Nefopam…), thể tích mặc định theo tên, hoạt chất của tên thương mại (VECMID), thuốc có dung môi đi kèm, tên hiển thị chuẩn | `config/medication_builtin.json` — xem ở **Danh mục thuốc → Sẵn có** | Theo phiên bản phần mềm (ứng dụng không ghi file này) |
| Nhận diện dịch truyền theo tên, từ nhận diện dung môi (natri clorid, nước cất…), ngưỡng thể tích | `config/order_rules.json` | Người cài đặt |
| Đường dùng (TTM, TMC, uống…) | `config/routes.json` + phần tự cài — **Danh mục thuốc → Đường dùng** | Người dùng |
| Mã + tên dung môi (Natri clorid 0.9%, Glucose 5%…) | `config/solvents.json` | Người cài đặt |
| Giờ mặc định theo chữ buổi (sáng 8 giờ, trưa 12 giờ…) | `config/d_v2.json` | Người cài đặt |
| Lịch giờ khi y lệnh thiếu giờ (8–16–23) | `config/schedule_rules.json` | Người cài đặt |

## Thứ tự ưu tiên khi xử lý dữ liệu

1. **Y lệnh ghi rõ** (dung môi, thể tích, tốc độ) luôn thắng.
2. **Danh mục thuốc** (người dùng khai báo).
3. **Kiến thức sẵn có** (`medication_builtin.json`).
4. Mặc định chung (vd. túi Natri clorid 100 ml). Báo cáo ca trực ghi "(mặc định, hỏi lại y lệnh)".

Màn **Danh mục thuốc → Thuốc → Kiểm tra quy tắc pha thuốc** chạy đúng hàm của bước xử lý, để xem
trước một thuốc sẽ được xử lý thế nào.

## Thay đổi 10/2026 (gom về một nguồn)

- `d_v2.json` trước đây được chép vào từng phiên một lần rồi dùng mãi, nên bản cập nhật không tới
  được phiên cũ. Nay mọi phiên đọc chung một file. Bản riêng của phiên chỉ được dùng khi file đó ghi
  `"__dung_ban_rieng__": true`.
- `d_v2.json` mục 1, 3, 5, 6 đã chuyển sang `medication_builtin.json`. Mục 2, 4 và `tu_khoa_rac`
  không còn code nào đọc nên đã bỏ.
- Danh sách dịch truyền trước đây chép ở 3 nơi; nay chỉ còn `order_rules.json`. `rule_engine.py`
  vẫn giữ một bản dự phòng, chỉ dùng khi file hỏng.
- `tests/test_medication_golden.py` so kết quả xử lý của 62 y lệnh mẫu với file mốc. Sau khi gom,
  kết quả không đổi.
