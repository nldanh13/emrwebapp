# Quy tắc bắt buộc cho mọi người và AI sửa EMR Web App

Đây là hướng dẫn ở **thư mục gốc**. Áp dụng với mọi file trong repository. **Đọc `docs/CHANGE_RULES.md` trước khi thay đổi mã.**

## Tài liệu phải đọc

- [`docs/CHANGE_RULES.md`](docs/CHANGE_RULES.md): quy tắc an toàn khi sửa code và điều kiện merge.
- [`PRODUCT.md`](PRODUCT.md) và [`DESIGN.md`](DESIGN.md): nghiệp vụ, nguyên tắc sản phẩm và giao diện.
- [`docs/UX_RULES.md`](docs/UX_RULES.md): tab, thao tác lưu, polling, realtime, tìm kiếm.
- Khi đụng EMR/Python/Selenium: [`docs/EMR_ACCESS_SAFETY.md`](docs/EMR_ACCESS_SAFETY.md), [`docs/PERSISTENT_CHROME_WORKER.md`](docs/PERSISTENT_CHROME_WORKER.md) và [`docs/PARALLEL_CARE_INFUSION.md`](docs/PARALLEL_CARE_INFUSION.md).
- Khi đụng dữ liệu nghiên cứu: [`docs/RESEARCH_DATA_SAFETY.md`](docs/RESEARCH_DATA_SAFETY.md).

## Tuyệt đối không phá

1. **Không ghi nhầm EMR:** đúng người bệnh, đúng đợt điều trị, đúng tài khoản; nhập/sửa/xóa phải đi qua kiểm tra trước và xác minh sau. Không tự thử lại POST hay bấm Lưu sau timeout.
2. **Không tạo tải đột biến:** giữ hàng đợi và giới hạn truy cập HTTP/Selenium; gặp 429/503 phải ngừng/giảm tải, không tìm đường khác để truy cập tiếp. Không test tải trên EMR bệnh viện.
3. **Không dùng chung Chrome bừa bãi:** một chủ sở hữu, một thao tác tại một thời điểm, phiên phải còn hợp lệ; Chrome thường trực chỉ dùng cho luồng đọc được phép, không tự chuyển sang ghi.
4. **Không mất dữ liệu người dùng:** chuyển tab/refresh không ghi đè trạng thái chưa lưu; không thay quy tắc “Đã kiểm” thành “Đã nộp”, không ngầm đánh dấu đủ giấy tờ/chữ ký.
5. **Không để lộ bệnh án, token, cookie, mật khẩu**, không bypass role/session/workspace, audit hay feature gate.
6. **Không làm hỏng dữ liệu cũ:** mọi thay đổi định dạng dữ liệu/API phải tương thích hoặc có migration + rollback đã kiểm thử.
7. **Không sửa test để che lỗi.** Khi sửa bug, ưu tiên viết test tái hiện trước, sau đó test hồi quy cả trường hợp bình thường.

## Trước khi merge

- Chỉ sửa file liên quan; rà soát tác động đọc/ghi EMR, retry, login, cache, polling, tác vụ trùng và migration.
- Chạy `npm run build` và `npm run test:ci`. Không merge khi `Test` của **commit cuối cùng** chưa xanh.
- Tạo PR và điền [checklist Pull Request](.github/pull_request_template.md), gồm test, rủi ro, restart/rollback.
- Backend/Python thay đổi: triển khai và restart khi **không có tác vụ chạy**. Không tự kích hoạt luồng ghi mới hoặc thay đổi giới hạn sản xuất khi chưa được chấp thuận.

**Lưu ý:** Rule và CI giúp giảm rủi ro hồi quy nhưng không thay thế kiểm chứng nghiệp vụ, thử nghiệm có kiểm soát và chính sách CNTT bệnh viện.
