# Bật sửa trực tiếp Google Sheet từ tab Kiểm hồ sơ

## 1. Tạo Apps Script

1. Mở Google Sheet cần sửa.
2. Chọn **Tiện ích mở rộng → Apps Script**.
3. Xóa mã mẫu và dán nội dung file `records_check_sheet_editor.gs`.
4. Mở **Project Settings → Script Properties** và tạo:

```text
EMR_WRITE_TOKEN=<chuỗi bí mật dài, ngẫu nhiên>
```

## 2. Deploy Web app

1. Chọn **Deploy → New deployment → Web app**.
2. Execute as: **Me**.
3. Who has access: **Anyone**.
4. Deploy và sao chép URL dạng:

```text
https://script.google.com/macros/s/.../exec
```

Token bí mật là lớp xác thực bắt buộc. Không ghi token vào source code hoặc Google Sheet.

## 3. Cấu hình EMR Dashboard

Trong `config/hchanh/records_check_google_sheet.json`, thêm URL Web app:

```json
"write_web_app_url": "https://script.google.com/macros/s/.../exec",
"write_timeout_ms": 20000
```

Trong file `.env` ở thư mục gốc dự án thêm đúng token đã tạo:

```env
EMR_GOOGLE_SHEET_WRITE_TOKEN=chuỗi_bí_mật_giống_Script_Property
```

Giữ nguyên biến đọc Sheet công khai đang dùng:

```env
EMR_ALLOW_PUBLIC_GOOGLE_SHEET=1
```

Tắt hẳn server Node rồi chạy lại. Tab Kiểm hồ sơ sẽ hiện trạng thái **Sửa trực tiếp: Bật**.

## An toàn cập nhật

- Chỉ hai cột `Số lưu trữ` và `Họ và tên` được phép sửa.
- Backend không gửi token xuống trình duyệt.
- Trước khi ghi, Apps Script kiểm tra dữ liệu cũ của dòng. Nếu Sheet đã thay đổi sau lần đồng bộ, thao tác bị từ chối và yêu cầu đồng bộ lại.
- Hệ thống không tự xóa dòng và không sửa cột Dấu thời gian.
