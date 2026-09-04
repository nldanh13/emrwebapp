# EMR Dashboard 2.3.0

## Module hóa

- Registry schema v2 cho 28 chức năng và 6 workflow.
- Override bật/tắt runtime, có bảo vệ module an toàn.
- Feature gate ánh xạ route với module.
- Workflow planner, runner, durable store và artifact store theo session.
- Chính sách lỗi `continue`, `stop-dependents`, `halt-workflow`.
- Trạng thái bước độc lập và kết quả workflow một phần.

## Nhập EMR

- Tách token precheck cho chăm sóc, dịch truyền, thủ thuật và VTYT.
- Giao diện không còn yêu cầu bypass precheck từ client.
- Một nhánh lỗi không làm dừng nhánh nhập khác.
- Chỉ cho nhập khi precheck và phân loại dữ liệu hoàn tất.

## Thu thập và xử lý

- Tách xử lý phân loại y lệnh thành `server/services/order_pipeline.js`.
- Lấy lại y lệnh một người bệnh giữ kết quả lấy được khi phân loại bị tắt/lỗi và trả trạng thái `partial/skipped` rõ ràng.
- Planner truyền trạng thái thiếu input xuống các bước phụ thuộc thay vì báo sẵn sàng sai.

## Bảo mật và dữ liệu

- Gắn middleware kiểm tra OTT vào route báo cáo PDF.
- Gọi workflow nội bộ qua loopback cố định, không tin `Host` header bên ngoài.
- Artifact store không lưu token, cookie, mật khẩu hoặc credential.
- Chuẩn hóa một số đường dẫn dữ liệu theo `EMR_RUNTIME_ROOT`.

## Kiểm thử

- Thêm test cho feature gate, module bảo vệ, dependency planner, workflow nhánh độc lập, token một lần, route không trùng và OTT báo cáo.
