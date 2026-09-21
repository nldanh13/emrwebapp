# Từ điển thuật ngữ — EMR Dashboard (Data Hub)

Tài liệu này gom lại các thuật ngữ dùng xuyên suốt web app này, để trao đổi cho gọn — không cần giải thích lại mỗi lần. Cập nhật thêm khi có tab/tính năng mới.

## 1. Hai hệ thống khác nhau — đừng nhầm

| Tên | Là gì |
| --- | --- |
| **EMR** | Phần mềm quản lý bệnh án điện tử **thật** của bệnh viện (hệ thống gốc, không phải web app này). Không có API công khai — mọi thao tác đọc/ghi vào đây đều phải giả lập trình duyệt (Selenium). |
| **Data Hub** / **web app này** | Ứng dụng React + Express trong repo `emrwebapp` — nơi bạn xem dữ liệu, bấm nút "nhập", quản lý lịch điều dưỡng... Bản thân nó **không lưu bệnh án**, chỉ điều phối và tự động hoá việc thao tác với EMR thật. |
| **worker** | Các script Python trong thư mục `worker/` (`input_care.py`, `input_infusions.py`, ...) — chạy Selenium, tự mở Chrome, đăng nhập EMR thật và thao tác thay người dùng. Khi nói "**tool** chạy/nhập/quét", tức là một worker đang chạy. |
| **tài khoản Data Hub** | Tài khoản đăng nhập **vào web app này** (mã truy cập/token, có vai trò — xem mục 2). |
| **tài khoản EMR** | Tài khoản đăng nhập **vào EMR thật** mà worker dùng để thao tác (khác hẳn tài khoản Data Hub). Có 2 kiểu: tài khoản EMR gắn theo người đăng nhập Data Hub, và tài khoản EMR gắn theo **tên điều dưỡng trong lịch trực** (ca làm/ca trực — xem mục 4). |

## 2. Vai trò tài khoản (role)

Từ thấp đến cao — vai trò cao hơn có toàn bộ quyền của vai trò thấp hơn:

| role (trong code) | Tên hiển thị | Làm được gì |
| --- | --- | --- |
| `viewer` | Người xem | Chỉ xem, không nhập/sửa gì |
| `researcher` | Nghiên cứu | Xem + xuất dữ liệu nghiên cứu (tab Kho nghiên cứu) |
| `operator` | Vận hành | Nhập/xử lý dữ liệu — vai trò của đa số nhân viên |
| `supervisor` | Giám sát | Thêm quyền xuất dữ liệu, xoá dữ liệu |
| `admin` | Quản trị | Toàn quyền, kể cả **Thiết lập tài khoản** (tạo/sửa tài khoản Data Hub và tài khoản EMR — vì có chứa mật khẩu thật) |

Nếu server chưa bật đăng nhập (`local_only`, chưa cấu hình `config/users.json`) thì không cần vai trò gì — ai mở app cũng có toàn quyền, giống admin.

## 3. Các tab chính (thanh điều hướng bên trái)

Nhóm **Dữ liệu**
| Tab | Việc chính |
| --- | --- |
| **Lấy dữ liệu** | Quét danh sách bệnh nhân, lấy y lệnh (thuốc/dịch truyền/thủ thuật/xét nghiệm/diễn biến), phân loại dữ liệu — bước ①②③ trước khi nhập gì cả |
| **Xếp phòng** | Gán bệnh nhân vào phòng để theo dõi/nhập theo phòng |

Nhóm **Điều dưỡng**
| Tab | Việc chính |
| --- | --- |
| **Nhập bệnh phòng** | Nhập **chăm sóc, dịch truyền, thủ thuật** cho bệnh nhân nội trú thường ngày — tab nhập chính, worker `input_care.py`/`input_infusions.py` chạy từ đây |
| **Nhập trực** | Nhập cho **người bệnh mới nhận** hoặc **chuyển khoa** trong ca trực (khác luồng với Nhập bệnh phòng vì có mốc "nhận khoa" riêng) |
| **Lịch điều dưỡng** | Quản lý danh sách điều dưỡng (roster), xếp lịch **ca làm/ca trực** theo ngày, và (mới thêm) thiết lập **tài khoản EMR riêng** cho từng điều dưỡng |
| **Báo cáo ca trực** | In phiếu bàn giao ca, bảng thuốc, danh sách tiêm truyền |

Nhóm **Hành chánh**
| Tab | Việc chính |
| --- | --- |
| **Hành chánh** | Bảng kê viện phí, ngày giường, hồ sơ ra viện |
| **Kiểm hồ sơ** | Kiểm/đối chiếu số lưu trữ, tên, phát hiện hồ sơ trùng/sai lệch, nộp hồ sơ |
| **Nghỉ ốm** | Chuẩn bị hồ sơ **Giấy chứng nhận nghỉ việc hưởng BHXH** (nội trú + ngoại trú), nối sang công cụ nhập cổng BHXH thật |
| **Phòng khám** | Chăm sóc và thủ thuật cho bệnh nhân **ngoại trú** (khác nội trú) |

Nhóm **Nghiên cứu / Cài đặt**
| Tab | Việc chính |
| --- | --- |
| **Kho nghiên cứu** | Xây cohort (nhóm bệnh nhân theo tiêu chí), chọn biến, xuất dataset nghiên cứu (có ẩn danh) |
| **Danh mục VTYT** | Từ điển vật tư y tế — mã thay thế, bật/tắt vật tư được phép tự nhập |
| **Danh mục thuốc** | Tên chuẩn hoá thuốc/dịch truyền, alias, thể tích/tốc độ mặc định — worker dùng để tự suy luận khi EMR chỉ ghi tên thuốc |
| **Kiểm tra cấu trúc EMR** | Đăng nhập EMR (chỉ đọc), so sánh trang/selector đang dùng với danh mục đã biết để phát hiện **EMR đổi giao diện** (đúng loại lỗi vừa sửa ở phiếu truyền dịch) |
| **Thiết lập tài khoản** | Quản lý tài khoản Data Hub + tài khoản EMR riêng (chỉ admin) |

## 4. Thuật ngữ nghiệp vụ/lâm sàng hay gặp

- **BN**: bệnh nhân.
- **Khoa điều trị**: khoa đang/đã điều trị cho BN. Một BN có thể có **nhiều khoa điều trị** nếu từng **chuyển khoa** — EMR liệt kê "Khoa điều trị thứ N" (N lớn = gần đây nhất/hiện tại).
- **Chuyển khoa**: BN được chuyển từ khoa này sang khoa khác. Phiếu chăm sóc/dịch truyền ở khoa **cũ** (trước khi chuyển) không sửa/xoá được nữa từ khoa mới — đây là điểm worker phải nhận biết để **dừng đúng chỗ**, không quét/sửa nhầm dữ liệu khoa cũ.
- **Ca làm** / **ca trực**: hai loại ca của điều dưỡng trong ngày, xếp theo lịch ở tab Lịch điều dưỡng. Quy tắc giờ: 07:00–10:59 và 13:00–16:59 = ca làm; 11:00–12:59, 17:00–23:59 và 00:00–06:59 (tính vào ca trực của **ngày hôm trước**) = ca trực.
- **Chăm sóc** / **phiếu chăm sóc** / **TT chăm sóc**: phiếu điều dưỡng ghi nhận diễn biến + hành động chăm sóc tại một thời điểm (vd 08:00: lấy dấu hiệu sinh tồn, thực hiện chỉ định thuốc...). "TT" = Thông tin.
- **Dịch truyền**: thuốc/dịch truyền tĩnh mạch — phiếu riêng ("Phiếu theo dõi truyền dịch") ghi tên thuốc, thể tích, tốc độ, giờ bắt đầu/kết thúc, lô sản xuất.
- **Thủ thuật**: các thao tác y khoa (thay băng, đặt thông...) cần ghi nhận người thực hiện, phương pháp vô cảm, mẫu tường trình.
- **Vật tư y tế (VTYT)**: vật tư tiêu hao dùng kèm y lệnh (kim, băng, ống thông...).
- **Y lệnh**: chỉ định của bác sĩ (thuốc, dịch truyền, thủ thuật, xét nghiệm...) — là "đầu vào" để worker suy ra cần nhập chăm sóc/dịch truyền gì.
- **Diễn biến**: mô tả tình trạng BN tại một thời điểm (vd "Người bệnh tỉnh, tiếp xúc tốt...").
- **Người lập**: tên điều dưỡng đứng tên tạo phiếu (chăm sóc/dịch truyền) trên EMR — được set **theo ca làm/ca trực** tại giờ đó, không phụ thuộc ai đang đăng nhập.
- **Đang thực hiện / Hoàn tất / Mới**: trạng thái của BN hoặc của 1 phiếu trên EMR. "Đang thực hiện" = BN còn nằm viện tại khoa; "Hoàn tất" = phiếu đã lưu xong; "Mới" = phiếu tạo dở/nháp (worker cần dọn nếu còn sót).
- **Nhận khoa** / **nhận bệnh**: mốc BN được khoa mới tiếp nhận sau khi chuyển khoa/phòng khám/phẫu thuật.
- **Hậu phẫu**: giai đoạn sau khi BN mổ xong, thường có phiếu "nhận hậu phẫu" riêng khi khoa nhận lại BN.
- **GMHS**: Gây Mê Hồi Sức — khoa/đơn vị xử lý gây mê và hồi sức sau mổ. **CTCH**: Chấn Thương Chỉnh Hình (một khoa ngoại phổ biến trong dữ liệu mẫu).
- **Đi mổ**: BN đang trong quá trình phẫu thuật — EMR tạm khoá không cho nhập chăm sóc bình thường, worker phải nhận biết để bỏ qua đúng cách (không báo lỗi giả).
- **Ra viện**: BN xuất viện — có mốc giờ ra viện riêng, sau mốc này không tự sinh thêm phiếu chăm sóc định kỳ.
- **BHYT**: Bảo hiểm y tế. **BHXH**: Bảo hiểm xã hội. **Giấy nghỉ ốm**: "Giấy chứng nhận nghỉ việc hưởng BHXH" — hồ sơ để người bệnh nhận chế độ nghỉ ốm.
- **Nội trú** / **ngoại trú**: BN nằm viện (nội trú) khác với BN đến khám rồi về trong ngày (ngoại trú, xử lý ở tab Phòng khám).

## 5. Thuật ngữ kỹ thuật hay dùng khi tôi báo cáo với bạn

- **PR (Pull Request)**: một gói thay đổi code chờ merge vào nhánh `main`. Mỗi lần tôi sửa/thêm tính năng xong, tôi commit + push, rồi (khi bạn yêu cầu) tạo PR và merge.
- **merge**: gộp PR vào `main` — sau khi merge thì thay đổi chính thức có hiệu lực.
- **CI ("Test" check)**: bài kiểm tra tự động (chạy toàn bộ test) mà GitHub bắt phải pass trước khi merge được.
- **branch**: nhánh làm việc riêng (branch hiện tại của phiên này: `claude/eloquent-gauss-b95ktc`) — code mới nằm ở đây trước khi merge vào `main`.
- **commit**: một lần lưu thay đổi kèm mô tả.
- **test (pytest/vitest)**: test tự động cho phần Python (`pytest`) và phần giao diện (`vitest`) — chạy để phát hiện lỗi trước khi merge.
- **quét (scan)**: worker mở một trang EMR, đọc dữ liệu hiển thị (thường phải lật nhiều trang phân trang).
- **cache**: dữ liệu worker quét được một lần rồi giữ tạm trong bộ nhớ, dùng lại để so sánh/quyết định (tạo mới/sửa/bỏ qua) thay vì quét lại nhiều lần.
- **Selenium**: công cụ giả lập trình duyệt Chrome mà worker dùng để thao tác EMR như người thật (EMR không có API).
- **session**: một phiên làm việc trên web app (dữ liệu, tiến trình đang xử lý gắn theo phiên đó).

---
*Tài liệu này không tự động cập nhật — khi có tab/khái niệm mới, nói tôi bổ sung vào đây.*
