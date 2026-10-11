# Chrome Worker thường trực — thử nghiệm cho Kiểm hồ sơ

## Phạm vi

Phiên bản hoàn thiện cho luồng đọc chỉ áp dụng cho **Trả HSBA → Kiểm hồ sơ → Lấy dữ liệu thiếu/cập nhật** ở chế độ Chrome ẩn (`headless`). Luồng này chỉ **đọc** hồ sơ Ra Khoa và CĐHA/CLS; các thao tác ghi chăm sóc, dịch truyền, thủ thuật vẫn giữ cơ chế hiện hành.

Thiết kế: Express Node.js → 1 hàng đợi cho mỗi workspace → tiến trình Python `hchanh_read_daemon.py` sở hữu **một Chrome** → EMR. Các tác vụ Node.js không trực tiếp điều khiển cùng WebDriver.

## Mặc định và cách tắt

Chrome Worker thường trực **tự bật sau khi cập nhật và khởi động lại server** cho luồng đọc Trả HSBA (headless, EMR trực tiếp). Không cần thiết lập biến môi trường. Đối với bridge, Chrome hiện, và thao tác ghi EMR, chương trình tiếp tục dùng runner cũ.

Để **tắt ngay** tính năng thường trực trên Windows PowerShell trước khi chạy server: `$env:EMR_PERSISTENT_HCHANH_WORKER="0"`, rồi `npm start`. Có thể bật lại bằng `"1"` hoặc bỏ biến môi trường (khởi động lại server). Nên thử trên nhóm nhỏ được phép trước khi chạy quy mô lớn.

## Giới hạn bảo vệ

- Chỉ nhận các tác vụ đọc Ra Khoa + CLS của một workspace; từ chối mọi `_files_override` ngoài hai mục cho từng bệnh nhân; không mở cổng mạng; JSON qua stdin/stdout riêng của tiến trình con.
- Mỗi yêu cầu tối đa **10 hồ sơ**. Mỗi Chrome phục vụ tối đa **30 lượt hồ sơ** hoặc **15 phút tuổi**, sau đó tự tạo lại. Không dùng chung Chrome giữa tài khoản EMR khác nhau.
- Chỉ **một tác vụ** điều khiển Chrome tại một thời điểm; có giới hạn hàng đợi 2 yêu cầu.
- Khi không có yêu cầu trong **2 phút**, Node đóng stdin để Python giải phóng Chrome và cookie trong RAM. Khi server dừng, dọn cả cây tiến trình Chrome, gồm cả POSIX/Windows.
- Người vận hành bấm **Dừng**: Node hủy tiến trình worker/Chrome; không phát lại tự động một tác vụ có kết quả chưa rõ.
- Thời gian chờ một batch theo `PY_TIMEOUT_MS`; nếu treo, tiêu hủy cả cây tiến trình (Windows `taskkill /T`).
- Worker HTTP tiếp tục tuân thủ `EMR_HTTP_GLOBAL_GAP_MS` và cơ chế ngừng khi EMR trả 429/503.
- Phiên đăng nhập EMR vẫn thuộc tài khoản được cấp quyền; không cố giữ phiên qua logout hoặc vượt thời gian hết hạn do EMR quy định.

## Theo dõi vận hành và riêng tư

Truy cập `/api/diagnostics` (có xác thực) để xem `resident_chrome` gồm trạng thái bật, số worker đang sống, tác vụ đang chạy/chờ, số lần mở Chrome, tái sử dụng, hoàn tất, lỗi, timeout và hủy. Số liệu không bao gồm mã bệnh nhân hay tài khoản.

Nhật ký Python thường có họ tên người bệnh hoặc HTML bệnh án nên console thường trực **chỉ ghi loại lỗi/cảnh báo đã ẩn nội dung**, không ghi tên/URL/chi tiết bệnh nhân.

## Đánh giá trước và sau

Chạy thử trên một tập nhỏ có quyền truy cập và được CNTT chấp thuận. Theo dõi số lần mở Chrome, số lần đăng nhập, số hồ sơ/giây, số lỗi và mức sử dụng CPU/RAM. Đối chiếu dữ liệu mỗi hồ sơ, nhất là khi thay đổi ngày ra viện hoặc lượt điều trị.

Không được coi giới hạn của Chrome Worker như giới hạn toàn bộ EMR: Selenium, trình duyệt người dùng và các máy khác vẫn tạo thêm lưu lượng.

## Tắt/khôi phục

Đặt `EMR_PERSISTENT_HCHANH_WORKER=0` rồi khởi động lại Node.js khi không có tác vụ. Không cần khôi phục database vì worker chỉ đọc và ghi kết quả vào tệp tiến độ hiện hành.

Không bật tính năng này nếu chưa có kế hoạch giám sát và cho phép từ CNTT bệnh viện.
