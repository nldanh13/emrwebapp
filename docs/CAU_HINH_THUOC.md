# Kiến thức thuốc nằm ở đâu

Mỗi loại thông tin thuốc chỉ có **một** nơi lưu. Muốn đổi cách xử lý dữ liệu thì sửa đúng nơi đó.
Không viết thêm danh sách tên thuốc vào code.

| Thông tin | Nơi lưu | Ai sửa |
|---|---|---|
| Thuốc của khoa: tên chuẩn, tên khác, hoạt chất, đường dùng, thể tích/tốc độ mặc định, **quy tắc pha**, tên hiển thị, "có dung môi đi kèm" | `config/medication_catalog.json` — màn **Danh mục thuốc → Thuốc** | Người dùng, trên màn hình |
| Kiến thức sẵn có đi kèm phần mềm: luật pha (Vancomycin, Merovia, Nefopam…), thể tích mặc định theo tên, hoạt chất của tên thương mại (VECMID), thuốc có dung môi đi kèm, tên hiển thị chuẩn | `config/medication_builtin.json` — xem ở **Danh mục thuốc → Sẵn có** | Theo phiên bản phần mềm (ứng dụng không ghi file này) |
| Nhận diện dịch truyền theo tên, từ nhận diện dung môi (natri clorid, nước cất…), ngưỡng thể tích | `config/order_rules.json` | Người cài đặt |
| Đường dùng (TTM, TMC, uống…) | `config/routes.json` + phần tự cài — **Danh mục thuốc → Đường dùng** | Người dùng |
| Mã + tên dung môi (Natri clorid 0.9%, Glucose 5%…) | `config/solvents.json` | Người cài đặt |
| Giờ mặc định theo chữ buổi (sáng 8 giờ, trưa 12 giờ…) | `config/d_v2.json` | Người cài đặt |
| Lịch giờ khi y lệnh thiếu giờ (8–16–23) | `config/schedule_rules.json` | Người cài đặt |

## Thứ tự ưu tiên khi xử lý dữ liệu

1. **Y lệnh ghi rõ** (dung môi, thể tích, tốc độ) luôn thắng.
2. **Danh mục thuốc** (người dùng khai báo).
3. **Kiến thức sẵn có** (`medication_builtin.json`).
4. Mặc định chung (vd. túi Natri clorid 100 ml). Báo cáo ca trực ghi "(mặc định, hỏi lại y lệnh)".

Màn **Danh mục thuốc → Thuốc → Kiểm tra quy tắc pha thuốc** chạy đúng hàm của bước xử lý, để xem
trước một thuốc sẽ được xử lý thế nào.

## Thay đổi 10/2026 (gom về một nguồn)

- `d_v2.json` trước đây được chép vào từng phiên một lần rồi dùng mãi, nên bản cập nhật không tới
  được phiên cũ. Nay mọi phiên đọc chung một file. Bản riêng của phiên chỉ được dùng khi file đó ghi
  `"__dung_ban_rieng__": true`.
- `d_v2.json` mục 1, 3, 5, 6 đã chuyển sang `medication_builtin.json`. Mục 2, 4 và `tu_khoa_rac`
  không còn code nào đọc nên đã bỏ.
- Danh sách dịch truyền trước đây chép ở 3 nơi; nay chỉ còn `order_rules.json`. `rule_engine.py`
  vẫn giữ một bản dự phòng, chỉ dùng khi file hỏng.
- `tests/test_medication_golden.py` so kết quả xử lý của 62 y lệnh mẫu với file mốc. Sau khi gom,
  kết quả không đổi.

## Nhiều cách pha, cần xác nhận, thống kê thực tế

- **Nhiều cách pha cho một thuốc.** Trong "Quy tắc pha thuốc" có:
  - một **cách mặc định**;
  - các **cách pha theo điều kiện**: đường dùng (TTM, bơm tiêm điện…) và/hoặc khoảng liều mỗi lần
    (mg). Ví dụ Vancomycin: liều ≤ 500 mg → 100 ml; liều ≥ 501 mg → 200 ml; bơm tiêm điện → 50 ml.

  Liều mỗi lần = hàm lượng trong tên × số lọ/ống mỗi lần (`worker/processing/dose.py`). Nếu thiếu
  dữ kiện thì không tính.
- **Không đoán khi không chắc.** Dòng thuốc được ghi `can_xac_nhan_pha` kèm lý do khi:
  - nhiều cách pha cùng khớp;
  - y lệnh thiếu đường dùng hoặc liều để chọn;
  - phải dùng 100 ml mặc định.

  Báo cáo ca trực hiện "cần xác nhận cách pha"; phiếu in ghi "xác nhận cách pha".
- **Thống kê cách pha thực tế.** Trong form sửa thuốc, mục "Thực tế trong dữ liệu":
  - máy chủ chạy lại đúng bước xử lý trên y lệnh nguyên văn của Kho nghiên cứu (`clinical_notes.csv`)
    và trên dữ liệu đã xử lý của phiên (`worker/dilution_stats.py`), không mở EMR;
  - chỉ đếm những lần y lệnh ghi rõ dung môi/thể tích; phần hệ thống tự suy được đếm riêng;
  - có nút "Đặt làm mặc định" và "Thêm thành cách pha".

## Dọn danh mục, bộ lọc, thuốc mới

- **Dọn mục "thuốc + Natri clorid 0.9%"** (do bước tự đồng bộ cũ sinh ra): ở đầu tab Thuốc bấm "Xem và dọn".
  - Có xem trước từng việc và chọn được mục nào cần dọn.
  - Danh mục được sao lưu vào `<thư mục dữ liệu>/backups/` trước khi sửa.
  - Thuốc gốc đã có → mục cũ được gộp vào. Thể tích cũ khác quy tắc thì được giữ thành "cách pha gợi ý"
    trong form thuốc, chưa áp dụng cho tới khi bạn duyệt.
  - Thuốc gốc chưa có → mục được đổi tên; thể tích cũ thành quy tắc pha "chỉ khi y lệnh ghi truyền".
- **Bộ lọc:**
  - "Cần pha, chưa có quy tắc": không tính chai/túi truyền pha sẵn (dịch truyền ≥ 50 ml).
  - "Thiếu hoạt chất".
  - "Có thể sai": mục cũ + dung môi, dịch truyền < 50 ml, hai mục trùng như NATRI CLORID / SODIUM CHLORIDE.
- **Thuốc mới:** tab liệt kê thuốc có trong y lệnh (dữ liệu phiên + Kho nghiên cứu) nhưng chưa có
  trong danh mục. Danh sách được khớp bằng đúng hàm tra danh mục của bước xử lý (`worker/catalog_gaps.py`).
  - "Thiết lập" mở form thêm thuốc, đã điền sẵn tên, hoạt chất, đường dùng, thể tích theo dữ liệu.
  - "Bỏ qua" chỉ ẩn thuốc khỏi danh sách, không sửa danh mục.


## Thuốc dùng cả tiêm tĩnh mạch chậm (TMC) và truyền (TTM)

**Một chế phẩm/một mã danh mục**, có thể có nhiều đường dùng nếu đúng hướng dẫn
sản phẩm và danh mục bệnh viện được phép. Không tạo hai bản thuốc trùng tên.

Trong **Danh mục thuốc → Sửa thuốc**:
- Dạng bào chế: `Dung dịch tiêm` cho ống Nefopam, `Bột pha tiêm` cho lọ kháng sinh bột.
- Hàm lượng trên nhãn: ví dụ `20 mg/2 ml` hoặc `0,5 g/lọ`. Đây là chữ mô tả, không tự quy đổi liều.
- **Thể tích thuốc gốc**: `2` ml cho ống dung dịch 2 ml; để trống đối với lọ bột.
- **Thể tích hoàn nguyên** (lọ bột): chỉ điền khi đã xác minh theo hướng dẫn chế phẩm được bệnh viện duyệt. Đây không phải thể tích dịch truyền; không tự tính tốc độ hoặc khối lượng dung môi.
- **Đường dùng mặc định**: để trống khi cả TMC/TTM đều được dùng, để hệ thống theo y lệnh.
- **Đường dùng cho phép**: chọn `TMC` và `TTM` chỉ khi được cơ sở chấp thuận.
- **Thể tích/tốc độ truyền mặc định**: để trống đối với chế phẩm có nhiều cách dùng; nếu được duyệt, khai báo quy tắc pha với `Chỉ khi y lệnh ghi truyền`.
- Phải xem trước từng trường hợp bằng `Kiểm tra quy tắc pha thuốc` trước khi dùng thực tế.

Luồng phân loại: **y lệnh ghi rõ TMC** luôn giữ là thuốc tiêm, kể cả thuốc có
luật pha NaCl theo tên/hoạt chất. Nếu cùng dòng có cả TMC và TTM, hệ thống
giữ ở thuốc tiêm và đánh dấu `can_xac_nhan_duong_dung`, không tự tạo phiếu truyền.
Y lệnh ghi TTM vẫn được phân loại theo quy tắc hiện hành.

**Chú ý tương thích:** Những bản ghi thuốc cũ không có `preparation` tiếp tục
được đọc như trước; không tự điền/di chuyển giá trị `default_volume_ml`, vì
trường cũ vốn được xử lý như thể tích truyền. Đừng tự đổi dữ liệu gốc của bệnh nhân.
Thể tích hoàn nguyên/ống chỉ dùng để hiển thị và tham khảo cấu hình; không phải
chỉ định sử dụng thuốc hay xác nhận độ tương thích dung môi.

Không tự chạy thử trên EMR bệnh viện. Bước kiểm thử offline chạy với dữ liệu giả.


## Danh mục thuốc bệnh viện từ bảng Select2 (15/10/2026)

Tab **Danh mục thuốc → Thuốc BV (185 mã)** chứa bản sao **offline, chỉ đọc** của
tệp HTML Select2 người dùng cung cấp. Bản gốc có 252 dòng hiển thị, trong đó
67 dòng là bản lặp cùng mã và 185 mã khác nhau. Giữ nguyên từng mã, tên, ĐVT,
hàm lượng, hoạt chất mô tả, quy cách và **nhãn đường dùng gốc**. Các tên lặp
nhưng có mã khác (như Truxima 100mg/10ml và 500mg/50ml; Natri clorid 100ml/500ml)
vẫn là các mục tra cứu riêng. Tồn kho và đơn giá từ nguồn **không** được lưu
vào mã nguồn vì không cần cho cấu hình thuốc và dễ lỗi thời.

- **Xem và tìm kiếm** trong tab không truy cập EMR, không tự tạo/sửa thuốc cấu hình.
- Nút **Tạo cấu hình** mở form tạo thuốc theo tên/mã nguồn, lưu mã BV vào
  `hospital_code` chỉ khi người dùng chủ động kiểm tra và bấm Lưu.
- **Không tự điền đường dùng**, kể cả nguồn ghi `Tiêm`, `Tiêm truyền` hoặc
  `Truyền tĩnh mạch`: những mô tả này không xác nhận TMC, TTM, tốc độ,
  liều hay kỹ thuật được cơ sở phê duyệt. Hoạt chất gốc cũng **chỉ hiển thị
  để đối chiếu**, không tự biến thành alias/hoạt chất suy luận của worker.
- Có thể sao chép **hàm lượng nguyên văn** nếu đủ ngắn. Không tự suy ra
  thể tích gốc từ 20mg/2ml, không coi 0,5g bột là số ml và không tự đặt
  hoàn nguyên/dung môi/thể tích/tốc độ truyền.
- Nếu danh mục đang có tên thuốc trùng, hiển thị **Xem cấu hình cũ**
  thay vì ghi đè hoặc gộp các mã BV. Không nhập hàng loạt trực tiếp vào
  cấu hình đang xử lý y lệnh; việc đó có thể làm thay đổi suy luận thuốc.
- Tên thuốc đã liên kết với mã BV không được tự đổi sang tên của mã khác.
  Chỉ người vận hành có quyền cấu hình mới có thể lưu theo API hiện có.

**Đường lui:** Phần tra cứu chỉ đọc nên có thể tắt tab mà không ảnh hưởng
các thuốc đang dùng. Các mục thuốc đã được lưu thủ công vẫn nằm trong
`config/medication_catalog.json`; cần sao lưu/kiểm tra riêng trước khi chỉnh
hoặc xóa. Không chạy tải thực tế trên EMR bệnh viện để xác thực bản sao.
