# Rà soát màn hình Sửa dịch truyền và giờ truyền suy luận

## Vì sao trước đây có nhiều dòng 100 ml / 30 giọt/phút hoặc giờ 00:06?

- Bộ xếp lịch trước đây có thể **tự gán 30 giọt/phút** cho thuốc được pha trong
  túi dịch khi y lệnh chưa có tốc độ. Từ đó phần mềm tính thời gian dùng thuốc
  nối tiếp, khiến giờ `09:26`, `10:32`, `00:06` trông như y lệnh gốc.
- Một giờ `00:06 16/10` có thể là **giờ dự kiến ngày hôm sau** của y lệnh
  ngày 15/10, không phải chứng cứ bác sĩ chỉ định thêm một lần truyền.
- Một dòng `—` là **thiếu giờ truyền**, không được tự lấy giờ lập y lệnh làm
  giờ bắt đầu. Số dòng trùng tên không khẳng định là thuốc được chỉ định nhiều
  lần; phải xem lại thời gian, số lượng và y lệnh gốc.

## Sau khi cập nhật

1. **Sửa dịch truyền** tách danh sách chưa có giờ khỏi lịch đã tính, hiển thị
   cả giờ dùng đọc từ y lệnh và ngày-giờ phần mềm đã tính; mốc sang ngày kế
   tiếp có cảnh báo rõ. Tốc độ suy đoán được đánh dấu **cần xác nhận**.
2. Khi xử lý dữ liệu mới, **không tự điền 30 giọt/phút** chỉ vì có ống/lọ
   pha NaCl. Nếu tốc độ chưa được xác nhận, giữ dòng để đối chiếu,
   **không tự tính thêm giờ truyền**.
3. API sửa thể tích/tốc độ kiểm tra số dương và chỉ chấp nhận **đúng một**
   dòng trùng khóa. Nếu có nhiều dòng giống hệt, trả lỗi thay vì sửa tất cả.
4. Khi sửa cục bộ, lịch tính từ thể tích/tốc độ cũ được đánh dấu
   `infusion_schedule_stale`. Dữ liệu cục bộ được giữ nhưng **không thể
   nhập EMR qua luồng server** cho BN/ngày còn dòng chưa rà soát;
   không tự ghi lại giờ kết thúc giả định.
5. Tiền kiểm nhập dịch truyền bỏ qua toàn bộ **BN/ngày** còn dòng thiếu giờ,
   thiếu thể tích, thiếu tốc độ, tốc độ suy luận hoặc lịch chưa tính lại.
   Các BN/ngày khác trong lượt vẫn chạy theo cơ chế sẵn có. Không chạy tự
   dọn/ghi EMR cho BN/ngày chưa đủ thông tin.

## Cách đối chiếu

- Mở **Y lệnh gốc** để xác nhận số lần, ngày, thời điểm dùng, đường dùng,
  thể tích pha và tốc độ. Không áp dụng mặc định `100 ml/30 giọt/phút`
  cho nhiều thuốc khác nhau nếu chưa có cơ sở từ y lệnh/quy tắc được duyệt.
- Chỉnh **cấu hình thuốc/nguồn dữ liệu đúng** nếu thiếu hoặc sai, rồi
  **chạy lại xử lý** để tính lại lịch (thao tác sửa cục bộ **không** tự
  sắp xếp lại các lần truyền hoặc cập nhật y lệnh EMR).
- Trước khi bấm **Kiểm tra / Nhập / Sửa**, kiểm tra bản xem trước khớp y lệnh
  bệnh viện và xem số dòng đã được giữ/tách. Không chạy thử trên EMR thật
  ngoài quy trình được CNTT cho phép.

## Kiểm thử

`npm run build`, `npm run test:ci` chạy các bài test UI (thời gian qua
nửa đêm, thiếu giờ, tốc độ suy đoán), Node (sửa một dòng, chặn trùng và
chặn BN/ngày thiếu thông tin) và Python (bỏ mặc định 30 giọt/phút).
Không thay dữ liệu bệnh nhân thật, không thay đổi liều hay thực hiện chỉ định.
