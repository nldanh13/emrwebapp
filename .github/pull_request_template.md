<!-- BẮT BUỘC: đọc AGENTS.md và docs/CHANGE_RULES.md trước khi sửa. -->
## Mục tiêu / Lỗi hiện tại

- Vấn đề đang gặp:
- Kết quả mong đợi:
- Phạm vi file/module thay đổi:
- Những phần **không** thay đổi:

## Ảnh hưởng và rủi ro

Đánh dấu tất cả khu vực liên quan:

- [ ] Chỉ tài liệu / kiểm thử, không thay đổi runtime
- [ ] Giao diện React / trạng thái nhập / tìm kiếm / chuyển tab
- [ ] API, phân quyền, session hoặc workspace
- [ ] Đọc EMR qua HTTP/Chrome/Selenium/bridge
- [ ] **Ghi hoặc sửa EMR** (chăm sóc, truyền dịch, thủ thuật, VTYT, phiếu)
- [ ] Dữ liệu bệnh án, kho nghiên cứu hoặc schema/migration
- [ ] Tác vụ nền, concurrency, hủy, timeout/retry
- [ ] Cấu hình, triển khai, thay đổi mặc định sản xuất

Nếu có đọc/ghi EMR, giải thích cách bảo đảm đúng BN/đợt/tài khoản và tránh truy cập/trùng lệnh:

## Bất biến và trường hợp xấu nhất

- Các điều kiện không được phá (đúng bệnh nhân/đợt, precheck, không ghi trùng, không làm quá tải EMR, không mất dữ liệu khi đổi tab):
- Khi timeout/mất kết nối/429/503/hết phiên/hủy giữa chừng, hệ thống làm gì?
- Có ảnh hưởng dữ liệu cũ hoặc cần migration/backup không? Nếu có, nêu kế hoạch:

## Kiểm thử

- [ ] Đã đọc `AGENTS.md` và `docs/CHANGE_RULES.md` cùng tài liệu nghiệp vụ liên quan
- [ ] Có kiểm thử tái hiện lỗi và kiểm thử hồi quy, hoặc giải thích vì sao không thể
- [ ] `npm run build` đạt
- [ ] `npm run test:ci` đạt
- [ ] CI `Test` của **commit cuối cùng** đạt; không lấy kết quả từ HEAD cũ
- [ ] Không dùng EMR bệnh viện thật/dữ liệu người bệnh thật trong CI
- [ ] Không ghi log/token/cookie/mã định danh/tài liệu bệnh án nhạy cảm
- [ ] Đã tự rà soát diff, không đụng file hay quy tắc ngoài phạm vi

Kết quả test/đường dẫn báo cáo CI:

## Triển khai và khôi phục

- Có cần dừng tác vụ, restart Node/Python hoặc build UI?
- Đã giữ tương thích dữ liệu/API cũ như thế nào?
- Cách **rollback ngay** nếu xảy ra lỗi, và dấu hiệu cần rollback:
- Cần thử nghiệm nhỏ/giám sát EMR với CNTT bệnh viện không?

> Không merge nếu CI đỏ/chưa chạy; nguy cơ ghi trùng EMR; nhầm BN/đợt/tài khoản; mất dữ liệu; hoặc thiếu phương án xử lý các thay đổi rủi ro cao.
