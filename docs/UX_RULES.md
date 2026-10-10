# Quy tắc hành vi giao diện (UX rules)

Áp dụng cho **mọi thay đổi** ở giao diện và các API mà giao diện gọi. Đọc cùng
[PRODUCT.md](../PRODUCT.md) (người dùng, nguyên tắc sản phẩm) và [DESIGN.md](../DESIGN.md)
(màu, chữ, nút). DESIGN.md nói **trông thế nào**, tài liệu này nói **chạy thế nào**.

Mỗi quy tắc dưới đây đến từ một lỗi người dùng đã gặp thật. Phần ghi chú "vì" nhắc lại lỗi đó để
người sửa sau hiểu vì sao không được làm khác.

Các quy tắc có đánh dấu **[tự kiểm]** được `scripts/ux_rules_check.mjs` kiểm trong `npm run test:ci`:
vi phạm thì CI đỏ.

---

## 1. Chuyển tab không được làm mất gì

1.1 **[tự kiểm R1]** Mọi tab được **giữ lại** sau lần mở đầu: thêm tab mới vào danh sách
`KeepAliveTab` trong `src/App.jsx`, không vẽ kiểu `{tab === 'x' && <X />}`.
*Vì:* chuyển tab bị dựng lại từ đầu, phải tải lại dữ liệu, mất phòng đang chọn, mất phần đang nhập,
mất theo dõi tác vụ đang chạy.

1.2 **[tự kiểm R2]** Màn hình tải dữ liệu lúc mở thì phải **cập nhật ngầm khi quay lại tab**:
`useOnTabReturn(() => load())` (`src/hooks/useTabActivity.js`). Cập nhật ngầm = giữ nguyên dữ liệu
đang hiện cho tới khi có dữ liệu mới, không xóa trắng màn hình, không bỏ lựa chọn của người dùng
(chỉ bỏ những lựa chọn không còn tồn tại).
*Vì:* dữ liệu có thể vừa đổi ở tab khác (quét danh sách, xếp phòng...).

1.3 **[tự kiểm R3]** Tab đang ẩn **không tự làm mới định kỳ** nếu không có việc đang chạy: dùng
`useTabActive()`. Trường hợp cần hỏi máy chủ khi ẩn (vd. báo tác vụ đang chạy lên menu) thì hỏi
thưa và ghi chú `// ux-rules: polling-ok — lý do`.

1.4 Tab ẩn không được vẽ lại theo App (đã lo trong `KeepAliveTab`). Không truyền vào tab những prop
đổi liên tục (đồng hồ từng giây...).

## 2. Không bao giờ mất thao tác của người dùng một cách im lặng

2.1 Thao tác chỉnh sửa **tự lưu** (chờ ~1 giây sau thay đổi cuối) và hiện trạng thái
("Có thay đổi, đang chờ tự lưu…", "Đã tự lưu lúc HH:mm", lỗi thì nói rõ). Nút "Lưu" vẫn có thể giữ
để bấm tay.
*Vì:* xếp phòng chỉ lưu khi bấm nút; chuyển tab trước khi bấm là mất, và Lấy dữ liệu không có phòng
nào để chọn.

2.2 Form dài không tự lưu được (vd. phiếu nhập tay từng Mã NC) thì:
- hiện rõ **"Chưa lưu"** khi có thay đổi;
- chuyển sang bản ghi khác thì **tự lưu bản đang nhập trước** (lưu lỗi thì ở lại, không chuyển);
- `useUnsavedChangesGuard(dirty)` để trình duyệt hỏi lại khi tải lại/đóng trang.

2.3 Rời màn hình (sang tab khác) khi còn thay đổi chưa lưu: lưu ngay (xem `BedBoard.jsx`).

2.4 Lưu xong mà tab khác cần biết thì phát sự kiện (vd. `emr:board-saved`); tab kia nghe và tải lại.
Giữ tên sự kiện dạng `emr:<việc>`.

## 3. Tác vụ chạy lâu (thu thập EMR, chuẩn hóa, nhập liệu)

3.1 Trạng thái "đang chạy" lấy **từ máy chủ**, không chỉ từ state giao diện: rời tab, tải lại trang
hay mở máy khác vẫn thấy đúng. Luôn hiện: việc gì, ở đâu, bắt đầu lúc nào, đã bao lâu, tiến độ gần nhất.

3.2 Một nơi hiển thị cho mỗi loại trạng thái; không rải cùng một thông báo ở nhiều chỗ.
- Kho nghiên cứu: "đang chạy" chỉ hiện ở dải đầu trang (`RunningBanner`).
- "Cập nhật … trước" tính theo **lần ghi tiến độ thật**, không theo câu thông báo lúc bắt đầu.
- Viết thời gian dạng "x phút trước".
- Quá 10 phút không có tiến độ mới thì cảnh báo kèm việc cần làm.

*Vì:* dải từng ghi "cập nhật 5185 giây trước" ngay cạnh "máy chủ vẫn đang chạy", trông như treo.

3.3 Các quy trình khác nhau thì tách rời: đang chuẩn hóa vẫn thu thập được và ngược lại; khóa theo
từng quy trình, không dùng chung một khóa.

3.4 Việc nặng (đọc/ghi nhiều file) chạy trong tiến trình con hoặc hàng đợi, **không chặn** máy chủ.

3.5 Trạng thái các nút phải nhất quán với trạng thái thật: không có nút "đang chạy" khi máy chủ báo
đã dừng, không hiện "Dừng" khi không có gì chạy.

3.6 **Xếp hàng theo tài nguyên thật sự dùng**, không xếp mọi thứ chung một hàng:
- Tác vụ **mở EMR** (quét, thu thập, nhập liệu) dùng `enqueueHeavy`, chạy lần lượt theo tài khoản
  EMR (`server/services/task_queue.js`).
- Tác vụ **chỉ chạy trên máy** (chèn chữ ký PDF, tạo báo cáo từ file đã có) dùng `enqueueLocal`.
  Loại này chạy ngay, không chờ tác vụ EMR, và **không gọi `registerCancel`**: nút Dừng của phiên
  thuộc về tác vụ EMR đang chạy.
- Chuẩn hóa dữ liệu nghiên cứu có làn riêng (mục 3.3).

*Vì:* đang thu thập Kho nghiên cứu (hàng giờ) thì bấm "Thêm chữ ký" quay mãi, vì nó phải chờ lượt
thu thập xong.

## 4. Không mở EMR khi không cần

4.1 Dữ liệu đã có (kho dữ liệu gốc, Kho người bệnh, dữ liệu của tab khác) thì **dùng lại**, không mở
EMR lấy lại. Chỉ mở EMR cho đúng phần còn thiếu, và cho người dùng thấy trước sẽ lấy gì.
*Vì:* nghiên cứu chọn mẫu từ kho mà vẫn mở EMR lấy lại toàn bộ.

4.2 Mọi nơi ghi "phần nào đã lấy" phải theo **đúng định dạng worker ghi** (`progress.json`,
`hchanh_auto_progress.json`, `order_history_auto_progress.json`), và có test chạy qua bước lập
kế hoạch của Thu thập tự động (`planCollection`) để chắc phần đã có không bị lấy lại.

4.3 **Một lượt chạy = một lần đăng nhập EMR.** Không đổi tài khoản giữa chừng: phiên nhập liệu có
`single_login`, và `WorkerSession.switch_account` từ chối đổi. Việc cần tên người khác thì làm trên
phiếu (đổi Người lập). Việc EMR không cho thì báo để xử lý tay.
*Vì:* log cũ đăng nhập qua lại lndieu → vtynhi → lndieu nhiều lần trong một lượt.

4.4 **Nhập liệu đăng nhập bằng tài khoản người ca làm theo lịch**, không dùng tài khoản mặc định.
- Dùng `EntryAccountResolver` (`worker/nurse_emr_accounts.py`) và `ws.use_entry_account(...)`.
- Người ca làm chưa có tài khoản EMR thì dùng tài khoản mặc định và cảnh báo rõ cần thêm tài khoản cho ai.
- Quét, lấy dữ liệu, xem trước thì dùng tài khoản mặc định.
- Chi tiết: [PARALLEL_CARE_INFUSION.md](PARALLEL_CARE_INFUSION.md).

*Vì:* phiếu nhập bằng tài khoản chung bị ghi sai người thực hiện.

## 5. Số liệu phải khớp nhau giữa các bước

5.1 Bước xem trước và bước lưu/xuất dùng **cùng một hàm** lọc/ghép (không viết hai bản). Có test so
kết quả hai bước.
*Vì:* xem trước ra 80 lượt nhưng "Lưu thành nghiên cứu" báo không có người bệnh phù hợp, rồi lại ra
86 mẫu do dòng lặp.

5.2 Một đơn vị đếm rõ ràng (lượt điều trị / người bệnh / dòng) và ghi rõ trên màn hình.

5.3 **Mỗi con số hiện ra phải trả lời được hai câu: "nó là gì?" và "tôi phải làm gì?"** Không trả
lời được câu thứ hai thì con số không đứng ở phần chính. Đưa nó vào mục "Chi tiết kỹ thuật" thu gọn,
hoặc bỏ đi.
- Các con số cùng nhóm dùng **một mẫu số** và cộng lại phải khớp.
- Đánh giá dữ liệu thu thập theo hai tiêu chí: **Đủ** (lấy đủ các phần chưa) và **Chính xác**
  (trùng, ngày tháng vô lý, kết quả mâu thuẫn).
- Việc máy đang tự làm thì ghi "không cần làm gì", không trộn vào số "cần xử lý".
- Xem `src/components/research/dataHealth.js`.

*Vì:* màn Kho nghiên cứu từng có 4 con số tổng khác nhau (3.127 / 3.016 / 3.015 / 500), "Cần xử lý
2.706" gồm cả ca máy đang lấy, và "Chưa ghép 553" mà không ai biết phải làm gì.

## 6. Thông báo, lỗi và trạng thái rỗng

6.1 Lỗi nói **việc gì không làm được, vì sao, làm gì tiếp**, bằng tiếng Việt. Không hiện thông báo kỹ
thuật trần ("404 Not Found", traceback, đường dẫn API). 404 do máy chủ chưa khởi động lại sau cập nhật
thì nhắc khởi động lại (đã có trong `src/api.js`).

6.2 Trạng thái rỗng: **một** thông báo kèm **một** hành động gỡ (vd. "Nạp danh sách mẫu từ kho"),
không lặp nhiều khung trống, không hiện nút bấm vào không làm được gì.

6.3 Biến/cột dùng tên dễ hiểu cho người dùng (vd. "Dùng hoạt chất: Acid Zoledronic", không phải
`active_ingredient`). Biến kiểu có/không xuất Có (1)/Không (0).

6.4 Gợi ý việc nên làm ngay tại chỗ (vd. "Dùng làm tiêu chuẩn chọn vào") thay vì chỉ báo lỗi.

## 7. Dữ liệu nhạy cảm

7.1 Dữ liệu nghiên cứu ẩn định danh mặc định; xem định danh cần cấu hình riêng và đúng vai trò.

7.2 Không in token, mật khẩu, nội dung `.env` ra màn hình, log hay tin nhắn.

## 8. Quy trình mỗi lần thay đổi

8.1 Đọc PRODUCT.md, DESIGN.md và tài liệu này trước khi sửa.

8.2 Sửa lỗi thì **viết test tái hiện lỗi trước** (test phải hỏng khi chưa sửa), rồi mới sửa.

8.3 Chạy `npm run test:ci` (gồm `scripts/ux_rules_check.mjs`) và để xanh trước khi đẩy code.

8.4 Thay đổi phía máy chủ: nhắc người dùng **khởi động lại máy chủ** (tắt rồi `npm start`) lúc không
có tác vụ đang chạy. Thay đổi chỉ ở giao diện: tải lại trang là đủ.

8.5 Dữ liệu cũ do bản trước tạo ra (vd. nghiên cứu lưu trước bản sửa) không tự sửa: nói rõ cho người
dùng cần làm gì (tạo lại, nạp lại...), hoặc cung cấp nút làm việc đó.

## 9. Màn hình số liệu: tính sẵn ở máy chủ, giao diện chỉ hiển thị

Lý do: trước đây mỗi khung tự gọi API riêng, mỗi lúc một khác, nên cùng một màn hình hiện ba bốn
mẫu số (3.016 / 3.041 / 3.127 lượt) và số nhảy dần từng ô. Người xem không biết tin con số nào.

9.1 **Một màn hình, một gói số liệu (screen model).** Máy chủ tính sẵn mọi con số của màn hình từ
**một nguồn** rồi trả về một lần (vd. `GET /research/archive/screen/collection`, file
`server/research/screen_model.js`). Các nhóm chia rời nhau và cộng lại đúng tổng; có test kiểm
bất biến đó (`scripts/research_screen_model_test.js`). Khi chưa làm được ở máy chủ, giao diện vẫn
tải mọi nguồn **cùng lúc trong một hàm** rồi dựng gói một lần (vd. Dữ liệu tổng quát).

9.2 **Khung hiển thị không tự gọi máy chủ.** Thành phần vẽ số liệu (`ResearchMonitor.jsx`,
`GeneralOverviewView.jsx`, `dataHealth.js`) chỉ nhận gói qua props, không import `api.js`.

9.3 **Kho dữ liệu dùng chung** (`src/hooks/useServerData.js`, kiểu stale-while-revalidate):
nhiều khung cùng khóa dùng chung một bản, một lần gọi; quay lại tab hiện ngay bản đang có rồi cập
nhật ngầm; bản mới về thì mọi khung đổi **cùng lúc**; lỗi khi tải lại thì giữ bản cũ và báo lỗi.
Khóa đặt theo phạm vi (`research:<archive|mã nghiên cứu>:<màn hình>`) để kênh sự kiện báo đúng chỗ.

9.4 **Khung xám (skeleton) lần đầu.** Chưa có gói thì vẽ khung xám đúng bố cục
(`src/components/Skeleton.jsx`), không hiện "0" hay số lẻ tẻ, không để bố cục nhảy khi số về.
Số liệu luôn kèm giờ tính ("số liệu lúc HH:mm:ss").

9.5 **Máy chủ báo khi đổi, không hẹn giờ hỏi.** Máy chủ tự theo dõi file nguồn của các phạm vi
đang có người xem và danh sách tác vụ đang chạy (`server/services/research_watch.js`), đổi thì
gửi sự kiện `research` qua `/api/events` (Server-Sent Events). Giao diện nhận
`emr:research-changed` rồi `invalidate('research:<phạm vi>:')`. Hẹn giờ chỉ còn là dự phòng
thưa khi mất kết nối kênh sự kiện (`useRealtimeConnected`). Sự kiện không chứa dữ liệu người bệnh.

9.6 **Áp dụng cho mọi tab.** Route trả số liệu cho một màn hình gọi
`watchScreen({ sid, key, files, extra })` (`server/services/screen_watch.js`): máy chủ theo dõi
file/thư mục nguồn (và trạng thái trong bộ nhớ qua `extra`), đổi thì gửi sự kiện `screen` cho
đúng workspace. Giao diện: màn hình dùng kho chung đặt khóa `screen:<key>` (kênh sự kiện tự
`invalidate`); màn hình chưa chuyển hẳn thì `useScreenChanged('<key>', () => tải lại im lặng)`.
Tải lại do sự kiện luôn im lặng: không vòng chờ, không xóa màn hình, không báo lỗi bật lên.

| Màn hình | Khóa | Máy chủ theo dõi |
|---|---|---|
| Lấy dữ liệu (Hành chánh) | `hchanh-dashboard` | thư mục hchanh, index, phiếu |
| Kiểm HSBA | `records-check-dashboard` | thư mục records_check, index, tác vụ nền |
| Ký tên ĐD HSBA | `discharge-bundles` | thư mục bộ in ra viện |
| Phòng khám | `clinic-monitor` (kho chung) | file trạng thái theo dõi + tiến trình còn chạy |
| Kho nghiên cứu | `research:<phạm vi>:…` | file tiến độ/sổ thu thập (`research_watch.js`) |

Nguồn không theo dõi được (vd. công cụ BHYT chạy riêng ở cổng khác) giữ hẹn giờ khi có việc đang
chạy, ghi rõ `ux-rules: no-realtime — <lý do>`.

9.7 **Khung xám ở mọi tab.** Lần đầu mở tab (chưa có số liệu) dùng `SkeletonScreen` (thanh công
cụ + ô số + bảng) hoặc `SkeletonTable`/`SkeletonBlock`/`SkeletonLines` đúng chỗ nội dung sẽ hiện.
Đã có số liệu mà đang tải lại thì **giữ nguyên nội dung cũ** (chỉ nút "Tải lại" quay), không thay
bảng bằng vòng xoay. Chưa biết số liệu thì không nói "Chưa có…/Chưa quét" (vd. các bước ở Lấy dữ
liệu hiện khung xám tới khi tải xong). Vòng xoay chỉ dùng trên nút đang chạy thao tác.

9.8 Tự kiểm (R4 trong `scripts/ux_rules_check.mjs`): khung hiển thị ở 9.2 không import `api.js`;
file dùng `useServerData` không tự `setInterval` gọi máy chủ, trừ hẹn giờ dự phòng có theo
`useRealtimeConnected` (kênh nối thì hỏi thưa, mất nối mới hỏi dày). R5: màn hình tab còn hẹn giờ
hỏi máy chủ phải theo `useRealtimeConnected`, hoặc ghi `ux-rules: no-realtime — <lý do>`.
R6: không còn chỗ hiện vòng xoay + "Đang tải…" thay cho nội dung (dùng khung xám, mục 9.7).

---

## Danh sách tab và cách giữ trạng thái (rà 10/2026)

| Tab | Giữ khi chuyển tab | Cập nhật khi quay lại | Lưu chỉnh sửa |
|---|---|---|---|
| Lấy dữ liệu | Có | Có, và khi Xếp phòng vừa lưu | — |
| Xếp phòng | Có | Có (trừ khi đang chờ lưu) | Tự lưu ~0,8 giây; rời tab thì lưu ngay |
| Nhập bệnh phòng | Có | Có (danh sách người bệnh) | Ghi EMR qua tiền kiểm |
| Lịch làm việc (điều dưỡng khoa + phòng khám) | Có | Có (trừ khi đang chờ lưu); mở lên là tuần này, chọn sẵn hôm nay | Tự lưu ~0,4 giây |
| Báo cáo ca trực | Có | Có | — |
| Kiểm HSBA, Nhập VTYT | Có | Có (đồng bộ lại danh sách) | Theo từng thao tác |
| Ký tên ĐD HSBA | Có | Có | — |
| Trả HSBA | Có | Có | Theo từng thao tác |
| Nghỉ ốm | Có | Có | Theo từng thao tác |
| Phòng khám | Có | Có; ẩn thì ngừng tự làm mới | Theo từng thao tác |
| Người bệnh & tái khám | Có | Có | — |
| Kho nghiên cứu | Có | Theo dõi máy chủ | Thêm / bớt biến của nghiên cứu: "Chưa lưu" cho tới khi bấm Lưu; chuyển tab vẫn giữ (KeepAlive) |
| Danh mục VTYT, Danh mục thuốc | Có | Có | Hộp thoại sửa, bấm Lưu |
| Kiểm tra cấu trúc EMR | Có | Không tự tải | — |
| Thiết lập tài khoản | Có (mục đã mở cũng giữ) | Có | Người dùng, tài khoản đọc: bấm Lưu. Tài khoản EMR điều dưỡng/bác sĩ: tự lưu ~0,8 giây, từng người; Thêm/Xoá lưu ngay (xoá hỏi lại) |
