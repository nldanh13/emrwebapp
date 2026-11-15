# Biến tự định nghĩa trong nghiên cứu

Mục **Thống kê & xuất dữ liệu → Đo lường từng biến → Biến tự định nghĩa** cho phép mỗi nghiên cứu tự tạo cột mới từ các cột đã có, không cần sửa code. Cột mới nằm cuối file "Biến đã chọn", có trong thống kê, danh sách ca thiếu dữ liệu, giá trị cần kiểm lại và Từ điển biến (cột "cách lấy" ghi rõ cách tính).

Không mở EMR, không đổi kho dữ liệu chung: chỉ tính lại file của nghiên cứu. Thiếu dữ liệu nguồn hoặc không khớp thì ô để trống, không đoán.

## Năm kiểu biến

| Kiểu | Dùng khi | Ví dụ |
|---|---|---|
| Hiệu hai mốc thời gian | Khoảng cách giữa hai cột ngày/giờ. Đơn vị ngày tính theo ngày lịch; giờ/phút cần giờ ở cả hai mốc. | Số ngày từ vào viện tới mổ: từ `admission_date` đến `ngay_mo`, đơn vị ngày. |
| Công thức | Tính từ các cột số bằng + − * / ^ và ngoặc. | BMI: `can_nang / (chieu_cao/100)^2`, 1 số lẻ. |
| Chia nhóm theo ngưỡng | Đổi một cột số thành nhóm. Giá trị bằng ngưỡng thuộc nhóm phía trên. | Phân loại BMI: ngưỡng `18.5; 23; 25`, tên nhóm `Gầy; Bình thường; Thừa cân; Béo phì`. |
| Gom nhóm theo từ khóa/mã ICD | Tìm từ khóa (không phân biệt dấu, hoa thường) trong một hay nhiều cột chữ. Nhóm khớp trước được lấy. | Vùng phẫu thuật: mã 1 "xương đùi; S72; khớp háng", mã 2 "đĩa đệm; cột sống; M51", còn lại 9. |
| Số trong tờ điều trị | Con số đầu tiên sau từ khóa trong Diễn biến/Y lệnh, vào đúng ngày N so với ngày mổ hoặc ngày vào viện. | VAS ngày 1 sau mổ: từ khóa `VAS`, ngày 1, so với ngày mổ, lấy lớn nhất. |

Biến sau dùng được kết quả của biến trước (vd. tạo BMI trước rồi mới chia nhóm BMI). Dùng nút ↑ ↓ để đổi thứ tự.

## Cách làm

1. Mở **Biến tự định nghĩa**, chọn kiểu, bấm **+ Thêm biến**.
2. Đặt nhãn (hiện trong thống kê, từ điển) và tên cột (không dấu, không khoảng trắng, dùng trong công thức).
3. Chọn cột nguồn và điền ngưỡng/từ khóa.
4. Bấm **Xem trước** để xem số lượt có giá trị và phân bố, chưa lưu gì. Xem trước và lưu dùng cùng một cách tính nên số liệu khớp file xuất.
5. Bấm **Lưu biến tự định nghĩa**.

## Dùng lại cho nghiên cứu khác

Trong nghiên cứu mới, chọn **Chép từ nghiên cứu khác…** rồi bấm **Chép**: toàn bộ biến tự định nghĩa của nghiên cứu kia được thêm vào (bỏ biến trùng tên). Nghiên cứu mới cần có các biến nguồn cùng tên cột; nếu thiếu, khi lưu sẽ báo cột nào chưa có.

## Lưu ý

- Bỏ một biến đang được biến tự định nghĩa dùng làm nguồn thì sẽ bị chặn lưu, kèm tên biến cần sửa.
- "Số trong tờ điều trị" đọc chữ bác sĩ ghi, nên kiểm lại vài ca bằng tra cứu người bệnh trước khi phân tích.
- Biến gom nhóm từ chẩn đoán dùng cột chẩn đoán nguyên văn; nếu xuất có ẩn định danh, các cột chữ tự do vẫn cần kiểm tra như trong `docs/RESEARCH_DATA_SAFETY.md`.
