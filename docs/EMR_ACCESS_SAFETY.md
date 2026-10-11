# Giới hạn truy cập EMR (đợt 1)

## Mục tiêu

Giảm lưu lượng đọc gửi từ nhiều Python worker trên cùng máy chủ Data Hub, tránh đăng nhập/truy cập liên tiếp khi EMR lỗi hoặc quá tải. **Không nhằm che giấu tự động hóa hay vượt chính sách bảo mật bệnh viện.** Cần thống nhất giới hạn cụ thể với bộ phận CNTT.

## Cơ chế đã triển khai

- `worker/emr_access_budget.py` cấp lượt truy cập HTTP theo **origin EMR**, dùng khóa file hệ điều hành để điều tiết giữa nhiều tiến trình Python trên **một máy chủ**.
- Giá trị mặc định `EMR_HTTP_GLOBAL_GAP_MS=500` (tối đa khoảng 2 yêu cầu/giây **cộng dồn** từ các worker HTTP đi qua `EmrHttpSession`, chưa tính Chrome/Selenium hoặc máy chạy Data Hub độc lập).
- Nếu backlog phải chờ trên 15 giây, worker dừng với lỗi có thể xử lý, không sinh thêm request.
- HTTP 429: tạm dừng toàn bộ worker HTTP trên máy chủ trong khoảng `Retry-After` hoặc mặc định 60 giây. HTTP 503: tương tự, mặc định 30 giây. Trần một lượt tạm dừng 300 giây.
- HTTP 401/403/4xx **không thử lại**. Các lỗi 5xx khác và lỗi mạng tạm thời của **GET** chỉ thử lại tối đa 1 lần, cách ít nhất 1 giây. **POST không thử lại tự động**, vì có thể làm đổi trạng thái server/phiên đăng nhập.
- Các đường quét và lấy chi tiết chính không tự chuyển qua Selenium để tiếp tục tạo tải khi EMR đang báo quá tải.

## Phạm vi chưa được điều tiết chung

- Click, submit, navigation bằng Selenium/Chrome.
- Các lời gọi HTTP trực tiếp không qua `EmrHttpSession`.
- Máy góp sức truy cập EMR trên máy tính **khác** không dùng chung file điều tiết. Nếu đi qua Python bridge trên server, nhịp gọi bridge được điều tiết; trình duyệt nhận yêu cầu vẫn cần cơ chế quản lý song song riêng.
- Mỗi máy chủ Data Hub độc lập có bộ điều tiết riêng. Chưa phải giải pháp giới hạn *toàn bệnh viện*.

Không thể dựa vào giới hạn này để khẳng định EMR sẽ không bị quá tải. **Không chạy kiểm thử tải trên EMR sản xuất nếu chưa được CNTT bệnh viện cho phép.**

## Tùy chỉnh và vận hành

- `EMR_HTTP_GLOBAL_GAP_MS`: số mili giây tối thiểu giữa hai lượt HTTP cùng origin (mặc định 500, tối đa 10000; giá trị 0 tắt điều tiết chung nếu được quản trị viên phê duyệt).
- `EMR_HTTP_BUDGET_DIR`: thư mục chia sẻ giữa các worker cùng máy chủ. Mặc định thư mục `.runtime/auth` cạnh bộ lưu cookie. Thư mục chứa bộ đếm thời gian theo hash origin, **không chứa token hay dữ liệu người bệnh**.
- `http_read_max_retries`: tối đa 1 lần thử lại GET; đặt 0 để tắt.
- `http_read_request_delay_ms`: nhịp chờ riêng từng worker, áp dụng thêm trước bộ điều tiết chung.

Nếu EMR trả 429/503, cần kiểm tra lý do, hạn chế các tác vụ đồng thời và chờ hết thời gian làm mát, **không tăng worker để chạy nhanh hơn**. Chỉ triển khai sau khi kiểm thử `npm run test:ci`, cập nhật mã và khởi động lại server khi không có tác vụ đang chạy.

## Giai đoạn tiếp theo

1. Đo số yêu cầu thực sự tới EMR theo loại tác vụ, không ghi nội dung bệnh án/cookie.
2. Điều tiết chung Selenium + cầu nối đa máy với ngân sách do CNTT xác nhận.
3. Chia sẻ bản danh sách nội trú theo phạm vi giữa các lô cùng đợt (tránh quét lại cho mỗi lô).
4. So sánh trạng thái EMR trước khi nhập, và xác minh thao tác ghi đã thành công trước khi thử lại sau timeout.
