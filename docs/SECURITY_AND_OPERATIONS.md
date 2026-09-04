# Bảo mật và vận hành

## 1. Phạm vi triển khai

Bản hiện tại phù hợp cho mạng nội bộ có kiểm soát. Không công khai trực tiếp server ra Internet. Khi dùng qua LAN, đặt reverse proxy HTTPS và token riêng cho từng người dùng.

## 2. Secret

Ưu tiên file secret có quyền đọc giới hạn hoặc secret store của hệ điều hành:

- `EMR_PASSWORD_FILE`
- `EMR_HCHANH_PASSWORD_FILE`
- `EMR_USERS_FILE`

Bật `EMR_REQUIRE_SECRET_ENV=1` để từ chối mật khẩu rõ trong cấu hình. Không lưu cookie, mật khẩu hoặc token vào database nghiệp vụ.

## 3. Quyền và session

Mỗi tài khoản có một vai trò và có thể giới hạn danh sách session. Không chia sẻ token. Khi nhân sự thay đổi, thu hồi token ngay và kiểm tra audit.

## 4. Export nghiên cứu

Dữ liệu luôn được ẩn danh mặc định. Muốn export có định danh cần đồng thời:

1. Vai trò `supervisor` hoặc `admin`.
2. `EMR_ALLOW_IDENTIFIED_RESEARCH_EXPORT=1`.
3. Không dùng export cục bộ với bộ lọc phía trình duyệt.
4. Kiểm tra sự kiện trong security audit.

Sau khi hoàn tất nhu cầu đặc biệt, tắt biến môi trường trở lại.

## 5. Google Sheet

Không sử dụng bảng ở chế độ “bất kỳ ai có liên kết”. Mặc định hệ thống chỉ nhận CSV nội bộ trong `config/hchanh/imports` hoặc `.runtime/imports`. Tích hợp Google API có xác thực cần được triển khai riêng nếu muốn đồng bộ trực tuyến.

## 6. Retention

- Mặc định: `EMR_SESSION_RETENTION_MODE=disabled`.
- Khuyến nghị khi cần dọn: `archive`.
- `delete` chỉ hoạt động cùng `EMR_ALLOW_PERMANENT_SESSION_DELETE=1`.

Kho archive vẫn chứa dữ liệu nhạy cảm, phải được mã hóa và backup.

## 7. Khôi phục sự cố

Sau khi server khởi động lại, tác vụ đang chạy được đánh dấu `unknown_after_restart`. Không chạy lại ngay. Trước tiên kiểm tra EMR thật, task journal, task item và audit để xác định thao tác cuối đã được lưu hay chưa.

## 8. File JSON hỏng

File trạng thái quan trọng bị hỏng được đổi tên `.corrupt-<timestamp>` và tác vụ dừng. Không xóa file cách ly trước khi điều tra. Phục hồi từ backup hoặc xác nhận thủ công dữ liệu trên EMR.

## 9. Backup

Tối thiểu backup:

- `.runtime/session_archive`
- `.runtime/audit`
- PostgreSQL khi được bật
- kho attachment/PDF cần lưu
- cấu hình rule không chứa secret

Thực hiện thử phục hồi định kỳ; backup chưa từng restore không được xem là đáng tin cậy.
