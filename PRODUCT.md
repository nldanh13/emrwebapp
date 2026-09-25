# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
- **Điều dưỡng và nhân viên hành chánh của khoa nội trú**: nhập chăm sóc, dịch truyền, thủ thuật và VTYT theo phòng/ca; xếp giường; làm phiếu bàn giao ca trực; kiểm và nộp hồ sơ ra viện.
- **Người vận hành** (người dựng và quản trị app): lấy dữ liệu từ EMR, theo dõi tác vụ tự động, cấu hình danh mục và tài khoản.
- Dùng trên **cả máy tính trạm của khoa và điện thoại** (đi buồng, giao ca). Hai loại thiết bị đều phải dùng tốt; không coi điện thoại là phụ.

## Product Purpose
Web app nội bộ điều phối dữ liệu người bệnh nội trú. EMR của bệnh viện không có API công khai, nên app đọc/ghi EMR qua worker Selenium/HTTP. App gom danh sách người bệnh, y lệnh và chi phí về một chỗ, rồi giúp khoa:
- xếp phòng/giường;
- tự động nhập chăm sóc, dịch truyền, thủ thuật, VTYT lên EMR (có bước tiền kiểm trước khi ghi);
- kiểm hồ sơ ra viện, tiền giám định BHYT, in bộ hồ sơ và bảng kê;
- làm báo cáo ca trực và lịch điều dưỡng;
- trích xuất dữ liệu nghiên cứu (ẩn danh mặc định).

Thành công nghĩa là: ít thao tác tay trên EMR, không nhập trùng/nhập sai, và nhìn vào là biết người bệnh nào còn việc cần làm.

## Operating Context
- Làm việc theo **ngày và ca** (hành chánh, ca làm, ca trực); mọi màn hình chính lọc theo khoảng ngày làm việc, mặc định hôm nay.
- Thao tác thật trên EMR chạy lâu (vài giây đến vài phút) và có thể bị huỷ giữa chừng; người dùng cần thấy tiến độ và kết quả từng người bệnh.
- Chạy trong mạng nội bộ bệnh viện, trên máy Windows; có thể không có Internet, nên giao diện không được phụ thuộc tài nguyên tải từ ngoài lúc chạy.
- Dữ liệu người bệnh là dữ liệu nhạy cảm.

## Capabilities and Constraints
- React + Vite (giao diện), Express (API), worker Python/Selenium. Không dùng framework CSS; hiện style chủ yếu viết trực tiếp trong JSX kèm `src/tokens.js` và `src/styles/app.css`.
- Ngôn ngữ giao diện: **tiếng Việt**, thuật ngữ lâm sàng/hành chánh của khoa (CS, DT, TT, VTYT, BHYT, GMHS, CTCH-TK, bảng kê, ra viện...). Ngày hiển thị **dd/mm/yyyy**.
- Phân quyền theo vai trò: viewer, researcher, operator, supervisor, admin.
- Mọi thao tác ghi lên EMR đều phải qua tiền kiểm; giao diện không được làm mờ hay giấu bước này.

## Brand Commitments
- Tên hiển thị: **Data Hub** ("Khai thác dữ liệu bệnh viện"). Giữ nhận diện hiện tại: nền sáng, sạch, màu nhấn xanh dương; người dùng chọn **sắp xếp lại, không đổi diện mạo** (09/2026).

## Evidence on Hand
- Không có ảnh, logo hay số liệu thật nào được phép đưa vào giao diện mẫu; mọi dữ liệu minh hoạ phải là dữ liệu giả và ghi rõ.

## Product Principles
1. **Việc cần làm lên trước**: màn hình trả lời ngay "người bệnh nào còn gì chưa xong", thao tác chính luôn dễ thấy.
2. **An toàn hơn nhanh**: thao tác ghi lên EMR phải rõ phạm vi, có xác nhận/tiền kiểm và cho huỷ; lỗi nói rõ chuyện gì xảy ra và làm gì tiếp.
3. **Nhất quán giữa các màn hình**: cùng một việc thì cùng một kiểu nút, nhãn và màu trạng thái.
4. **Dùng được ở cả hai nơi**: bàn máy tính trong ca và điện thoại khi đi buồng.

## Accessibility & Inclusion
- Chữ đủ lớn và đủ tương phản để đọc nhanh trên màn hình trạm (WCAG AA cho chữ thường); vùng bấm trên điện thoại tối thiểu ~40px.
- Không dùng màu làm tín hiệu duy nhất cho trạng thái (luôn kèm chữ hoặc icon).
