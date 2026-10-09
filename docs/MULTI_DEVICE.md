# Dùng EMR Web App trên nhiều thiết bị

## Khái niệm

Có 3 lớp khác nhau:

1. **Server**: máy chạy `npm start`. Python/Selenium/Chrome và toàn bộ tiến trình EMR chạy ở đây.
2. **Thiết bị điều khiển**: máy tính, điện thoại, tablet chỉ gửi API tới server và hiển thị kết quả.
3. **Workspace (session dữ liệu)**: thư mục runtime chứa dữ liệu, trạng thái và hàng đợi của một phiên làm việc.

Điện thoại không chạy một bản Python/Selenium riêng. Bấm trên điện thoại vẫn làm server trên máy chính chạy worker.

## Kho chung (cách khuyên dùng)

Kho chung là một workspace mà **mọi máy mở mặc định**, để cả khoa thấy cùng một bộ dữ liệu mà không
phải gửi link cho từng máy.

1. Người có vai trò **giám sát** trở lên mở đúng dữ liệu cần dùng chung, bấm nút **Chưa có kho chung**
   (hoặc **Dữ liệu riêng**) trên thanh trên cùng → **Đặt dữ liệu này làm kho chung**.
2. Từ đó:
   - máy mới hoặc máy chưa có dữ liệu gì: tự mở kho chung, không hỏi;
   - máy đang có dữ liệu riêng: hiện dải vàng hỏi **Chuyển sang kho chung** / **Giữ dữ liệu riêng**.
     Không tự chuyển, vì người dùng sẽ tưởng mất dữ liệu. Dữ liệu riêng vẫn còn, mở lại ở
     Lấy dữ liệu → **Đổi dữ liệu**;
   - máy đã chọn giữ dữ liệu riêng, hoặc mở bằng link workspace, thì không bị hỏi lại.
3. Thanh trên cùng luôn ghi máy đang ở **Kho chung** hay **Dữ liệu riêng**.
4. **Bỏ kho chung** (giám sát) không xoá dữ liệu nào. Kho chung đang dùng thì không xoá được ở Đổi dữ liệu.

Người dùng bị giới hạn danh sách session (`sessions` trong `users.json`) chỉ thấy kho chung nếu được
phép vào session đó.

Mã nguồn: `server/services/shared_workspace.js`, `server/routes/workspace.js` (`/api/workspace`),
`src/components/shell/WorkspaceGate.jsx`, `decideWorkspace` trong `src/hooks/useSession.js`.
Test: `scripts/shared_workspace_test.js`, `src/hooks/useSession.sharedWorkspace.test.js`.

## Mở đúng cùng dữ liệu trên máy khác (bằng link)

Đăng nhập cùng mã truy cập **không có nghĩa** tự động dùng cùng workspace. Mỗi trình duyệt mới có thể đã có session riêng.

Từ thanh trên cùng, bấm **Mở cùng dữ liệu trên thiết bị khác**. Link được tạo có dạng:

```text
http://<server>:3001/?workspace=<session-id>
```

Mở đúng link này trên thiết bị thứ hai. Thiết bị thứ hai vẫn phải nhập mã truy cập; link workspace không phải mật khẩu.

Khi đã mở link, browser lưu workspace đó và các lần mở tiếp theo tiếp tục dùng cùng dữ liệu.

## Nếu bấm cùng lúc trên hai thiết bị

### Cùng workspace

- Các tác vụ đi qua `task_queue` được xếp nối tiếp theo workspace/session; không chạy chồng trong cùng session.
- Các tác vụ nặng dùng cùng tài khoản EMR còn được khóa thêm theo `accountKey`, vì vậy cùng một tài khoản EMR không bị hai Selenium/HTTP worker sử dụng song song.
- Kho nghiên cứu có khóa theo archive/study; hai thao tác ghi cùng một phạm vi nghiên cứu không được chạy chồng.
- Hai màn hình có thể đọc/poll cùng trạng thái. Dữ liệu thực tế nằm trên server, không nằm riêng trên điện thoại.
- Hai người cùng sửa một dữ liệu nhập tay (bảng, cài đặt, danh mục, bản nháp VTYT): người lưu sau đang cầm bản cũ
  bị chặn, thấy thông báo "Dữ liệu này vừa được <tên> lưu lúc <giờ> trên máy khác", rồi app tải bản mới nhất.
  Không có chuyện ghi đè im lặng. Tên lấy từ người đăng nhập (`server/services/resource_writers.js`).
- Checklist kiểm tay ở Hành chánh so từng mục: mục đã được người khác sửa sau khi mình mở thì không bị ghi đè;
  mỗi mục hiện "Kiểm bởi <tên> · <giờ>".

### Khác workspace

- Dữ liệu runtime là tách biệt.
- Tác vụ nặng dùng cùng tài khoản EMR vẫn phải chờ nhau nhờ account lane toàn server.
- Các tác vụ không dùng cùng tài nguyên có thể chạy song song nếu server cho phép.

## Nhiều người, nhiều máy cùng lấy chi tiết

Bước **Lấy chi tiết** chia danh sách người bệnh thành từng lô nhỏ trong một hàng đợi
(`server/services/details_parallel.js`). Người làm nào rảnh thì nhận lô kế tiếp. Có hai loại người làm:

1. **Máy góp sức** (không cần cài gì): trên mỗi máy trong bệnh viện, mở EMR, đăng nhập bằng tài khoản của
   người dùng máy đó, rồi bấm nút dấu trang **Góp sức lấy dữ liệu** (lấy nút ở Lấy dữ liệu → Lấy chi tiết →
   "Thêm máy góp sức"). Máy đó đọc hồ sơ bằng phiên EMR của chính người đó, qua cầu nối tab EMR
   (`server/services/emr_bridge.js`, phần `helpers`), và gửi về máy chủ. App không giữ mật khẩu của họ.
2. **Tài khoản trên máy chủ**: tài khoản chung, cộng các tài khoản đọc mà quản trị khai ở **Thiết lập tài khoản →
   Tài khoản EMR → Tài khoản EMR để lấy dữ liệu song song** (mặc định 2, tối đa 4 cùng lúc, kể cả tài khoản chung).
   Máy chủ mở Chrome bằng các tài khoản này.

Bảo đảm:

- **Không trùng**: mỗi lô chỉ ở một chỗ. Máy chủ chỉ nhận kết quả của đúng các ca trong lô và gộp theo mã người bệnh.
- **Không mất**: máy tắt, đóng tab, rớt mạng hoặc bị đăng xuất thì lô đang làm quay lại hàng đợi cho người khác.
  Lô không giao lại cho người vừa làm lỗi. Người làm lỗi 2 lô liền thì nghỉ. Một lô lỗi 3 lần thì thôi, người bệnh
  trong lô giữ dữ liệu cũ, màn hình báo rõ ai chưa lấy được.
- **Không đoán**: ca máy góp sức không đọc được qua tab (vd. vừa ra viện, phải tìm ở "Hoàn tất") được trả lại để
  tài khoản trên máy chủ mở bằng Chrome.
- Máy góp sức nối giữa chừng cũng được nhận việc. Lấy dữ liệu → Lấy chi tiết hiện ai đang góp sức và mỗi
  người đã làm bao nhiêu ca.
- Một tài khoản trên máy chủ chỉ chạy một lô tại một thời điểm, có file cookie riêng. Tài khoản đọc trùng tài khoản
  chung hoặc đang dùng để nhập liệu thì không được dùng, vì hai bên có thể đăng xuất lẫn nhau.
- Dưới 8 người bệnh, hoặc chỉ có một người làm, thì chạy một worker như trước.
- Chế độ cầu nối tab EMR (Data Hub trên cloud) chưa chia việc, luôn chạy một worker.
- EMR ghi nhận tài khoản của từng người đã xem hồ sơ nào. Nhật ký hoạt động của app ghi người/máy nào lấy
  bao nhiêu ca.

## Quy tắc an toàn

- Không dùng cùng một mã truy cập như một cơ chế chọn dữ liệu. Mã truy cập xác thực người dùng; workspace xác định bộ dữ liệu đang thao tác.
- Không gửi link workspace ra ngoài mạng tin cậy. Link không chứa token nhưng vẫn để lộ mã workspace.
- Khi cần làm cùng một ca từ máy tính và điện thoại, luôn dùng link **Mở cùng dữ liệu trên thiết bị khác** trước.
- Nếu một tác vụ đang chạy, nên theo dõi trạng thái hiện tại thay vì bấm lại cùng hành động. Hàng đợi giúp tránh chạy chồng nhưng lần bấm thứ hai vẫn có thể trở thành một lượt chạy kế tiếp nếu endpoint đó cho phép lặp.
- Các form nhập tay đang mở đồng thời trên hai thiết bị vẫn có rủi ro người sau ghi đè thay đổi người trước nếu cả hai cùng sửa một bản ghi. Với dữ liệu nhập tay quan trọng, chỉ nên để một thiết bị ở chế độ chỉnh sửa tại một thời điểm cho tới khi có version/ETag cho form đó.

## Trạng thái cục bộ vẫn khác nhau

Các thứ như tab đang mở, menu, kích thước giao diện và một số lựa chọn UI lưu trong trình duyệt có thể khác giữa điện thoại và máy tính. Điều này không có nghĩa dữ liệu server khác nhau khi hai thiết bị dùng cùng `workspace`.
