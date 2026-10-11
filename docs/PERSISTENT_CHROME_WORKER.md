# Chrome Worker thường trực — thử nghiệm cho Kiểm hồ sơ

## Phạm vi

Tính năng thử nghiệm chỉ áp dụng cho **Trả HSBA → Kiểm hồ sơ → Lấy dữ liệu thiếu/cập nhật** ở chế độ Chrome ẩn (`headless`). Luồng này chỉ **đọc** hồ sơ Ra Khoa và CĐHA/CLS; các thao tác ghi chăm sóc, dịch truyền, thủ thuật vẫn giữ cơ chế hiện hành.

Thiết kế: Express Node.js → 1 hàng đợi cho mỗi workspace → tiến trình Python `hchanh_read_daemon.py` sở hữu **một Chrome** → EMR. Các tác vụ Node.js không trực tiếp điều khiển cùng WebDriver.

## Cách bật thử nghiệm

Tắt các tác vụ đang chạy trước khi cập nhật mã/khởi động lại máy chủ. Thiết lập biến môi trường:

- Windows PowerShell (chỉ có hiệu lực trong Terminal đang chạy): `$env:EMR_PERSISTENT_HCHANH_WORKER="1"`
- Sau đó `npm start`.

Nếu không bật biến này, luồng dùng `runScript('hchanh_fetch.py')` như cũ. Nếu không chạy headless hoặc đang dùng EMR bridge, tự quay về cách chạy cũ.

## Giới hạn bảo vệ

- Chỉ nhận các tác vụ đọc Ra Khoa + CLS của một workspace; không mở cổng mạng; JSON qua stdin/stdout riêng của tiến trình con.
- Mỗi yêu cầu tối đa **10 hồ sơ**. Mỗi Chrome phục vụ tối đa **30 lượt hồ sơ** trước khi tự tạo lại. Không dùng chung Chrome giữa tài khoản EMR khác nhau.
- Chỉ **một tác vụ** điều khiển Chrome tại một thời điểm; có giới hạn hàng đợi 2 yêu cầu.
- Khi không có yêu cầu trong **2 phút**, Node đóng stdin để Python giải phóng Chrome và cookie trong RAM. Khi server đóng, stdin cũng đóng, Python thoát và đóng Chrome.
- Người vận hành bấm **Dừng**: Node hủy tiến trình worker/Chrome; không phát lại tự động một tác vụ có kết quả chưa rõ.
- Thời gian chờ một batch theo `PY_TIMEOUT_MS`; nếu treo, tiêu hủy cả cây tiến trình (Windows `taskkill /T`).
- Worker HTTP tiếp tục tuân thủ `EMR_HTTP_GLOBAL_GAP_MS` và cơ chế ngừng khi EMR trả 429/503.
- Phiên đăng nhập EMR vẫn thuộc tài khoản được cấp quyền; không cố giữ phiên qua logout hoặc vượt thời gian hết hạn do EMR quy định.

## Đánh giá trước và sau

Chạy thử trên một tập nhỏ có quyền truy cập và được CNTT chấp thuận. Theo dõi số lần mở Chrome, số lần đăng nhập, số hồ sơ/giây, số lỗi và mức sử dụng CPU/RAM. Đối chiếu dữ liệu mỗi hồ sơ, nhất là khi thay đổi ngày ra viện hoặc lượt điều trị.

Không được coi giới hạn của Chrome Worker như giới hạn toàn bộ EMR: Selenium, trình duyệt người dùng và các máy khác vẫn tạo thêm lưu lượng.

## Tắt/khôi phục

Đặt `EMR_PERSISTENT_HCHANH_WORKER=0` (hoặc xóa biến) rồi khởi động lại Node.js khi không có tác vụ. Không cần khôi phục database vì worker chỉ đọc và ghi kết quả vào tệp tiến độ hiện hành.

Không bật tính năng này nếu chưa có kế hoạch giám sát và cho phép từ CNTT bệnh viện.
