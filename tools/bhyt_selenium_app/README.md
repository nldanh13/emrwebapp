# Công cụ nhập chứng từ BHYT bằng Selenium

Ứng dụng chạy **trên máy Windows của bạn**, đọc Excel, lọc hồ sơ theo 16 bác sĩ đã cấu hình và nhập dữ liệu vào `gdbhyt.baohiemxahoi.gov.vn` bằng Chrome/Selenium.

> **Cách dùng bây giờ: tab "Nghỉ ốm" của app chính, chỉ giải CAPTCHA.** Lưu tài khoản cổng BHXH một lần
> (Mã cơ sở KCB, tên đăng nhập, mật khẩu, lưu ở `secrets/bhyt_portal_account.json` trên máy chủ). Mỗi lần
> nhập: bấm **Lấy mã CAPTCHA** (app tự khởi động công cụ này nếu chưa chạy), gõ mã, bấm **Đăng nhập và nhập
> tự động**. Máy chủ app điền tài khoản, đăng nhập EMR cho công cụ, rồi công cụ tự chạy một lượt
> (`bhyt/auto_run.py`): quét Danh sách Khám bệnh hôm nay (đọc phiếu nghỉ), quét người bệnh ra viện ngày đã chọn
> (đọc giấy ra viện), nhập thật lên cổng các hồ sơ đủ dữ liệu, giữ phiên để nhập hết danh sách. Ca thẻ DN chưa
> ghi nghỉ ốm chờ người dùng bấm **Có nghỉ** (kèm ngày) hoặc **Không nghỉ** trên tab.
>
> Lần đầu trên máy mới vẫn cần nhấp đúp `start.bat` một lần để cài thư viện Python.

## Chức năng

- Đọc hai loại file:
  - Giấy chứng nhận nghỉ việc hưởng BHXH (mẫu 07).
  - Giấy ra viện (mẫu 03).
- Chỉ lấy hồ sơ có **Người hành nghề/Trưởng khoa** thuộc danh sách đã cung cấp.
- Giữ nguyên mã có số 0 đầu, ngày tháng và tiếng Việt từ Excel.
- Phát hiện hồ sơ trùng bằng khóa dữ liệu; nhập lại file không tạo bản ghi trùng.
- Cho phép bổ sung/sửa trường còn thiếu trước khi chạy.
- Chế độ **Điền thử** chỉ điền một hồ sơ lên màn hình, không bấm Lưu.
- Chế độ **Nhập thật** yêu cầu xác nhận `NHẬP THẬT`.
- Có Dừng, chạy tiếp, nhật ký, số lần thử và xuất CSV trạng thái.
- Selenium điền Mã cơ sở KCB, tên đăng nhập và mật khẩu vào đúng các trường trên cổng.
- CAPTCHA và OTP do người dùng nhập trực tiếp trên Chrome; ứng dụng không vượt CAPTCHA và không lưu mật khẩu.
- Phiên Chrome được giữ trong thư mục `runtime/chrome_profile` để hạn chế phải đăng nhập lại.

## Cài và chạy trên Windows

Yêu cầu:

1. Windows 10/11.
2. Google Chrome bản hiện hành.
3. Python 3.11 trở lên, khi cài nhớ chọn **Add Python to PATH**.

Giải nén toàn bộ thư mục, sau đó nhấp đúp **`start.bat`**. Lần đầu chương trình sẽ tạo môi trường Python và cài thư viện; các lần sau sẽ nhanh hơn. Giao diện mở tại:

`http://127.0.0.1:5005`

Nếu Windows Firewall hỏi, chỉ cần cho phép mạng riêng; ứng dụng chỉ lắng nghe trên máy cục bộ (`127.0.0.1`).

## Luồng sử dụng bắt buộc

1. Nhập **Mã cơ sở KCB**, **Tên đăng nhập**, **Mật khẩu**, rồi bấm **Mở Chrome & điền đăng nhập**.
2. Trên Chrome, nhập CAPTCHA, bấm **Đăng nhập** và hoàn tất OTP nếu hệ thống yêu cầu. Quay lại ứng dụng và bấm **Kiểm tra đăng nhập**.
3. Ở bước **Nhập dữ liệu**, chọn một hoặc cả hai file `.xlsx`, rồi bấm **Đọc Excel**.
4. Xem cột **Sẵn sàng**. Bấm **Bổ sung** để điền dữ liệu thiếu.
   - File giấy nghỉ đã kiểm tra không có cột **Số KCB**, nên các hồ sơ mẫu 07 sẽ chưa sẵn sàng cho tới khi trường này được bổ sung.
   - Không tự điền Số KCB hoặc dữ liệu nghiệp vụ bằng suy đoán.
5. Chọn đúng một hồ sơ sẵn sàng rồi bấm **Điền thử 1 hồ sơ**.
6. Kiểm tra trực tiếp mọi trường trên Chrome. Chế độ thử **không bấm Lưu**.
7. Nếu đúng, chọn các hồ sơ cần nhập, bấm **Nhập thật**, gõ `NHẬP THẬT` và xác nhận.
8. Theo dõi trạng thái và nhật ký. Có thể bấm **Dừng**; chương trình dừng sau hồ sơ đang xử lý.

## Quy tắc an toàn và vận hành

- Không chạy hai bản ứng dụng cùng lúc và không mở Chrome khác bằng cùng thư mục hồ sơ Selenium.
- Không thao tác trong tab cổng BHYT khi tiến trình đang nhập thật.
- Chạy lô nhỏ trước (1–3 hồ sơ), đối chiếu trên cổng, rồi mới tăng số lượng.
- Hồ sơ `Thành công` được bỏ qua khi chạy lại.
- Nếu cổng báo lỗi, hồ sơ có trạng thái `Lỗi`; sửa dữ liệu, chọn hồ sơ và dùng **Đặt lại trạng thái đã chọn** rồi chạy lại.
- Nếu trang đổi giao diện/tên control, Selenium có thể dừng và ghi lỗi thay vì tiếp tục mù.
- Dữ liệu và nhật ký cục bộ nằm trong `runtime/bhyt_automation.sqlite3`. Hãy bảo vệ thư mục này vì có dữ liệu người bệnh.

## Kiểm thử cục bộ

Nhấp đúp `kiem_tra.bat` hoặc chạy:

```bat
.venv\Scripts\python -m unittest discover -s tests -v
```

## Danh sách bác sĩ

Danh sách được lưu tại `config.json`. Khi cần đổi, đóng ứng dụng, sửa mảng `allowed_doctors`, lưu file rồi chạy lại.

## Xử lý lỗi thường gặp

- **Không mở được Chrome:** cập nhật Chrome, đóng tất cả cửa sổ Chrome do công cụ mở, rồi chạy lại.
- **Chưa đăng nhập:** nhập lại thông tin, bấm **Mở Chrome & điền đăng nhập**, hoàn tất CAPTCHA/OTP trên Chrome rồi kiểm tra lại.
- **Không tìm thấy bác sĩ/khoa/dân tộc:** giá trị trong Excel không khớp danh sách trên cổng. Mở hồ sơ bằng nút **Bổ sung** và sửa theo đúng tên hiển thị trên cổng.
- **Không xác định kết quả sau khi Lưu:** kiểm tra Chrome và lịch sử trên cổng trước khi đặt lại/chạy lại để tránh gửi trùng.
- **Cổng đổi cấu trúc:** không tiếp tục nhập thật; cần cập nhật ánh xạ trong `bhyt/portal.py`.

> Đây là công cụ hỗ trợ nhập liệu, không thay thế việc kiểm tra nghiệp vụ và quyền truy cập hợp lệ của người sử dụng.
