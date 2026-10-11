# Quy tắc bắt buộc khi sửa EMR Web App (người và AI)

**Áp dụng toàn repository.** Trước khi đọc/sửa code, mở `AGENTS.md` ở thư mục gốc và tài liệu này. Mục tiêu là **giảm nguy cơ hồi quy, mất dữ liệu và tạo tải bất thường cho EMR bệnh viện**; không có bộ rule nào bảo đảm tuyệt đối không còn lỗi.

## 1. Thứ tự ưu tiên và quy trình

1. Đọc `PRODUCT.md`, `DESIGN.md`, `docs/UX_RULES.md`, `CLAUDE.md`; với phần liên quan, đọc `docs/EMR_ACCESS_SAFETY.md`, `docs/PERSISTENT_CHROME_WORKER.md`, `docs/PARALLEL_CARE_INFUSION.md`, `docs/RESEARCH_DATA_SAFETY.md`.
2. Mô tả trước **lỗi/tính năng, phạm vi, bất biến không được phá, rủi ro, cách kiểm tra và cách quay lại bản cũ**. Chỉ thay đúng phần liên quan; không dọn code/làm đẹp/refactor dây chuyền không cần thiết trong cùng PR.
3. Khi sửa lỗi: thêm bài kiểm thử **tái hiện lỗi trước** (đỏ ở mã cũ), sửa mã để test xanh; thêm kiểm thử đối chứng để đảm bảo nhánh bình thường không hỏng. Nếu không thể mô phỏng lỗi, giải thích lý do trong PR.
4. Không chỉnh trực tiếp `main`; tạo nhánh và Pull Request, để CI bắt buộc `Test` **success trên HEAD cuối** rồi mới merge. Khi HEAD đổi, CI của commit cũ không được dùng làm bằng chứng.
5. Không merge khi chưa rõ tác động lên tài khoản, phiên, thời gian chờ, số request, dữ liệu cũ, hủy tác vụ, chạy lại tác vụ và quyền truy cập.
6. Sau merge, cập nhật hướng dẫn triển khai: `git pull origin main`, `npm run build`, **restart Node/Python worker nếu sửa backend** khi không còn tác vụ đang chạy. Có phương án tắt/bật tính năng, kiểm tra sức khỏe và khôi phục.

## 2. Bất biến tuyệt đối của bệnh án và thao tác GHI

- **Đúng người bệnh + đúng đợt điều trị + đúng ngày/ca + đúng tài khoản**, dựa trên khóa EMR/encounter; không ghép chỉ bằng họ tên hay thứ tự dòng. Nếu mơ hồ, dừng để người dùng xác minh, không tự chọn.
- **Đọc khác ghi**: mở danh sách/xem hồ sơ không được âm thầm thay đổi EMR; thao tác ghi chỉ chạy khi có yêu cầu rõ ràng, đúng quyền, qua **tiền kiểm, xác nhận/phạm vi, audit và xác minh sau ghi**. Không tắt/bỏ qua các cổng bảo vệ bằng cách gọi worker trực tiếp hoặc thêm route phụ.
- **Không tự gửi lại POST/click Lưu/Hoàn tất/Thu hồi/xóa sau timeout/mất kết nối**: kết quả có thể đã ghi thành công. Phải đọc/xác minh trạng thái EMR trước khi quyết định tiếp theo; chưa xác minh được thì báo **không rõ kết quả**, để kiểm tra thủ công.
- Bảo đảm chống nhấp đúp/trùng yêu cầu tại **server** (idempotency/dedupe), không chỉ disable nút ở frontend. Khóa chống trùng phải gồm **phạm vi nghiệp vụ/đợt/bản ghi**, có chính sách xử lý khi worker dừng giữa chừng. Không biến “có lỗi” thành “đã xong”.
- Trạng thái **Đã kiểm** chỉ cho phép hồ sơ vào danh sách **chuẩn bị nộp**. Không được tự coi là đã nộp, đã hoàn tất checklist/chữ ký hoặc đủ điều kiện bàn giao. Phân biệt `checked`, `submission_ready`, `submitted`; có test cho hồ sơ thiếu giấy tờ và hồ sơ trùng đợt.
- Mọi thao tác sửa/xóa dữ liệu cũ phải có sao lưu/đường lui, quản lý tương thích và kiểm thử migration bằng bản dữ liệu giả; không tự xóa `.runtime`, `secrets`, cơ sở dữ liệu hoặc dữ liệu cũ để “hết lỗi”.

## 3. Giới hạn truy cập EMR, Selenium và phiên đăng nhập

- **An toàn hơn tốc độ**: ưu tiên dùng dữ liệu hiện có, cache đúng khóa & TTL, chỉ đọc phần còn thiếu. Không quét lại toàn bộ theo từng bệnh nhân, không gửi cùng request đồng thời từ nhiều worker.
- Giữ các lớp giới hạn ở `worker/emr_access_budget.py`, `server/services/task_queue.js`, `server/services/hchanh_resident_worker.js`. Các giới hạn hiện tại **không** bao trùm mọi Selenium hay nhiều máy chủ; không được tuyên bố là đã chặn toàn bộ lưu lượng EMR.
- **Một Chrome có đúng một tiến trình sở hữu**, một tác vụ thao tác tại một thời điểm; xếp hàng theo **tài khoản thực tế** và workspace. Không attach cùng WebDriver từ nhiều process, không dùng chung cookie giữa tài khoản, không để Chrome cũ và mới chồng phiên khi đổi workspace hoặc timeout.
- Chrome Worker thường trực **chỉ cho đọc Trả HSBA (Ra Khoa, CLS, headless, EMR trực tiếp)**. Không nới sang ghi bệnh án/chăm sóc/dịch truyền/thủ thuật/VTYT nếu chưa có thiết kế và kiểm thử riêng. Bảo toàn giới hạn hồ sơ/lần, vòng đời, idle shutdown, nút Dừng, chống treo, khóa theo tài khoản.
- Giữ phiên **chỉ khi còn hợp lệ**; kiểm tra URL/DOM đăng nhập và vòng đời, không cố vượt hạn phiên do EMR quy định; không phát sinh “keep-alive giả” để né timeout. Không che giấu tự động hóa hoặc tìm cách vượt giới hạn của EMR.
- Khi EMR trả `401/403`: dừng, không thử lặp cùng lỗi. Khi `429/503`: tôn trọng `Retry-After` và tạm giảm tải toàn bộ luồng liên quan; **không chuyển sang Selenium** để tiếp tục truy cập. Với GET chỉ retry có giới hạn, backoff; không tăng worker, không tạo vòng lặp vô hạn, không retry POST.
- Selenium: chỉ click/nhập/chọn khi giá trị đang hiển thị **khác giá trị cần đặt**; khi filter đổi vẫn phải refresh kết quả; dùng `WebDriverWait` theo điều kiện thay vì sleep/click lặp. Sau navigation phải kiểm tra lại DOM, không tin cache điều khiển từ trang trước.
- Khi thao tác/luồng chạy lâu: timeout hữu hạn, cancel được, đóng **cả cây ChromeDriver/Chrome** đúng hệ điều hành; chờ Chrome cũ chết hẳn trước khi mở mới. Khi hủy không tự phát lại lệnh. Không chạy thử tải/stress trên EMR sản xuất nếu chưa được CNTT bệnh viện cho phép.

## 4. Phiên làm việc Web App, giao diện, dữ liệu đồng bộ

- Phân biệt rõ **đăng nhập Web App** với **phiên EMR** và **workspace dữ liệu**. Không tự chia sẻ token/cookie EMR, không kéo dài Web App session bằng giải pháp không được phép.
- Mọi API phải kiểm tra xác thực, vai trò và phạm vi workspace **tại server**; thay đổi route cần test 401/403/nhầm workspace, không chỉ ẩn nút.
- Tuân thủ `docs/UX_RULES.md`: tab giữ nguyên khi chuyển, nhập liệu không mất khi đổi tab, trạng thái tác vụ lấy từ server, dữ liệu trên tab quay lại được cập nhật ngầm **mà không ghi đè thao tác chưa lưu**.
- Ưu tiên event/SSE và chia sẻ cache (`useServerData`) thay vì polling nhiều khung. Không thêm `setInterval` ngắn vào tab ẩn hoặc gọi lại EMR khi chỉ cần cập nhật hiển thị. Với tìm kiếm: debounce/deferred **không được mất ký tự**; không setState/re-render toàn bảng khi mỗi phím gõ.
- Dữ liệu **chưa xác minh** phải ghi là chưa xác minh/partial, không hiển thị “đã đủ/0 lỗi/đã nộp” để che tình trạng thiếu. Ngày tháng hiển thị `dd/mm/yyyy`, thống nhất một nguồn dữ liệu/một mẫu số giữa các màn hình.

## 5. Bảo mật và dữ liệu nhạy cảm

- Không ghi commit các file `.env`, mật khẩu, token, cookie, dữ liệu hồ sơ thật, file PDF bệnh án hay `.runtime`. Dùng mock/dữ liệu giả cho test. Không đưa tên/mã bệnh nhân vào log, console, URL chẩn đoán hoặc artefact CI; chỉ log loại lỗi, số đếm, mã tương quan đã ẩn danh.
- Không tự thay đổi quyền, tắt xác thực, mở port mạng, bypass `feature_gate`, `precheck`, `idempotency`, audit hoặc policy bệnh viện để “sửa nhanh”.
- Mọi thay đổi thư viện, API bên ngoài, Selenium selector, cơ chế đăng nhập phải có nguồn kiểm chứng/kiểm thử và phương án dự phòng; không lưu cookie lâu hơn chính sách cho phép.

## 6. Kiểm thử bắt buộc trước merge

Thực hiện ít nhất:

```bash
npm ci
npm run build
npm run test:ci
```

**Không được chạy test kết nối EMR bệnh viện thật** trong CI. Bộ `test:ci` hiện bao gồm Python pytest, compileall, kiểm tra cú pháp Node, UX, Vitest, smoke scripts và kiểm tra bí mật. Nếu thêm module/route/worker, thêm test phù hợp để kiểm được đường lỗi lẫn đường thành công; cập nhật test cũ **chỉ khi hành vi mới thật sự được chấp thuận**, không sửa assert cho xanh một cách máy móc.

Ma trận tối thiểu khi thay đổi phần tương ứng:

| Khu vực sửa | Điều kiện kiểm thử phải chứng minh |
| --- | --- |
| API / bảo mật | đúng vai trò và workspace; từ chối sai quyền; không gửi request trùng |
| EMR HTTP | 401/403 không retry; 429/503 dừng; GET có backoff; POST không gửi lại |
| Chrome/Selenium | đúng tài khoản/BN/đợt; đổi filter; phiên hết hạn; timeout; cancel; Chrome thoát; không dùng chung |
| Nhập bệnh án | precheck và xác minh sau ghi; timeout không tự ghi lần hai; phần lỗi không đánh dấu đã hoàn tất |
| Trả HSBA | Đã kiểm xếp được ngày nộp; thiếu checklist vẫn là đang chuẩn bị; không tự bàn giao; không thêm trùng |
| React/UX | gõ tìm kiếm không giật/mất ký tự; chuyển tab không mất dữ liệu; realtime không làm mất chọn/lưu |
| Nghiên cứu | ghép đúng encounter, không gộp người bệnh sai; đủ/chính xác tách biệt; ẩn danh mặc định |
| Triển khai | dữ liệu cũ còn đọc được; restart an toàn; rollback tính năng; log không lộ dữ liệu |

Nếu test không thể chạy, phải **ghi rõ test nào chưa chạy và vì sao**, không tuyên bố “đã an toàn”. CI xanh là điều kiện cần, không thay thế kiểm thử tích hợp trong môi trường được phép.

## 7. Quy tắc nghiệm thu Pull Request

PR phải có: mục tiêu/triệu chứng; phạm vi file; bất biến giữ nguyên; trước/sau; rủi ro bệnh án/EMR/hiệu năng/phiên; test mới và kết quả; hướng dẫn cập nhật và rollback; ghi rõ có cần restart Node/Python không. PR sửa nhiều nghiệp vụ không liên quan phải tách nhỏ.

**Dừng merge khi:** thiếu hoặc đỏ CI; thay đổi không kiểm soát được việc ghi EMR; retry có thể ghi trùng; có thể nhầm BN/đợt/tài khoản; không có đường lui cho migration; lộ dữ liệu nhạy cảm; hoặc phát sinh truy cập EMR không giới hạn.

**Sau merge:** người vận hành triển khai lúc không có việc đang chạy, theo dõi `/api/health`, `/api/diagnostics`, tiến độ tác vụ và log đã ẩn định danh; chạy thử lô nhỏ được phép. Khi lỗi: dừng tác vụ, bật công tắc rollback của tính năng hoặc quay về commit/backup phù hợp; giữ dữ liệu để điều tra, không xóa dấu vết.
