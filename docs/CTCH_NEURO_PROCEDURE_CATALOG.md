# Danh mục gợi ý thủ thuật CTCH – Thần kinh

## Nguồn và phạm vi

`config/procedure_templates.ctch_neuro.suggestions.json` chứa **40 mã kỹ thuật** từ tệp do người vận hành cung cấp: 16 mã mức A (bám trực tiếp công việc thường gặp) và 24 mã mức B (biến thể cần đối chiếu thêm). Tên/mã được giữ theo bảng lọc `DMKT_MauThuThuat_CTCH_ThanKinh_UuTien_ThucTe.xlsx`; không khẳng định tất cả được bệnh viện/phòng khám phê duyệt.

Chỉ thêm **danh mục gợi ý** vào giao diện `Mẫu thủ thuật–phẫu thuật`. Không tự cài 40 mẫu hoạt động, không ghi EMR và không đụng tới `config/procedure_templates.json` khi chỉ mở tab.

## Quy trình duyệt

1. Vào `Mẫu thủ thuật–phẫu thuật` → khu `Kỹ thuật gợi ý CTCH – Thần kinh`. Tìm theo mã/tên, lọc mức A/B hoặc tất cả.
2. Bấm `Thêm bản nháp` cho từng kỹ thuật, hoặc `Thêm các mẫu ưu tiên chưa có` để thêm những mức A chưa có. Những mẫu cũ được giữ nguyên. Các bản nháp mới **`reviewed=false, enabled=false, auto=false`**.
3. Đối chiếu **mã và tên DVKT thật trên EMR**, phạm vi kỹ thuật BV cho phép, BS/điều dưỡng thực hiện, mẫu tường trình trên EMR, nội dung tường trình và các thông số cần thiết. Tên mẫu từ danh mục không được chỉnh sai danh mục mã gốc.
4. Khi đủ trường bắt buộc, bấm `Xác nhận đã duyệt mẫu`; xác nhận lại trên hộp thoại. Sau duyệt, mẫu vẫn ở trạng thái **tắt**; muốn tự nhập cần bật **Đang dùng** và **Tự nhập** một cách riêng biệt.
5. Nếu sửa nội dung chuyên môn sau duyệt, mẫu tự trở về **chờ duyệt, tắt cả hai cờ**. Các kỹ thuật có từ khóa trùng mẫu đang hoạt động cần xử lý mẫu cũ trước khi bật.
6. Mẫu gợi ý dùng khớp **tên DVKT đầy đủ**, không dùng từ khóa chung (vd. “tiêm”, “bột”, “khâu”). Worker không dùng mẫu phẫu thuật mặc định bao trùm đối với một DVKT đã được thêm bản nháp danh mục nhưng chưa duyệt.

## Trường hợp dễ chọn nhầm

- Tiêm gân gấp ngón tay **khác** phẫu thuật ngón tay cò súng.
- Hút ổ viêm **khác** trích rạch áp xe/dẫn lưu; có hoặc không siêu âm là kỹ thuật khác.
- Hút dịch gối **khác** tiêm khớp gối.
- PRP điều trị thoái hóa khớp **khác** PRP phần mềm quanh khớp và điều chế PRP.
- Mắt cá/chai chân ở da **khác** phẫu thuật xương mắt cá; “gọt chai chân cho bệnh nhân đái tháo đường” không thay cho mọi trường hợp chai chân.
- Có mã kỹ thuật khác nhau cùng tên (vd. khâu vết thương trên 10 cm), chỉ thêm mã thực tế bệnh viện áp dụng.

## Kiểm thử và triển khai

- `npm run build`, `npm run test:ci`: xác minh UI, không ghi trùng mẫu, yêu cầu duyệt, server bảo vệ bản nháp và worker không tự chạy mẫu chưa duyệt.
- Tính năng không cần mở EMR khi xem danh mục. Tất cả kiểm thử dùng dữ liệu giả lập.
- Khi triển khai mã Node/Python mới, chờ tác vụ kết thúc rồi cập nhật/restart server. Có thể xóa **riêng mẫu nháp** đã thêm, không xóa/ghi đè danh mục hay dữ liệu bệnh án đang dùng.
- Đây là bảng gợi ý cấu hình, không thay thế danh mục được phê duyệt, phạm vi hành nghề, quy trình/đồng thuận và quyết định lâm sàng.
