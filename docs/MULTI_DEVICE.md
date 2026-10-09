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

### Khác workspace

- Dữ liệu runtime là tách biệt.
- Tác vụ nặng dùng cùng tài khoản EMR vẫn phải chờ nhau nhờ account lane toàn server.
- Các tác vụ không dùng cùng tài nguyên có thể chạy song song nếu server cho phép.

## Quy tắc an toàn

- Không dùng cùng một mã truy cập như một cơ chế chọn dữ liệu. Mã truy cập xác thực người dùng; workspace xác định bộ dữ liệu đang thao tác.
- Không gửi link workspace ra ngoài mạng tin cậy. Link không chứa token nhưng vẫn để lộ mã workspace.
- Khi cần làm cùng một ca từ máy tính và điện thoại, luôn dùng link **Mở cùng dữ liệu trên thiết bị khác** trước.
- Nếu một tác vụ đang chạy, nên theo dõi trạng thái hiện tại thay vì bấm lại cùng hành động. Hàng đợi giúp tránh chạy chồng nhưng lần bấm thứ hai vẫn có thể trở thành một lượt chạy kế tiếp nếu endpoint đó cho phép lặp.
- Các form nhập tay đang mở đồng thời trên hai thiết bị vẫn có rủi ro người sau ghi đè thay đổi người trước nếu cả hai cùng sửa một bản ghi. Với dữ liệu nhập tay quan trọng, chỉ nên để một thiết bị ở chế độ chỉnh sửa tại một thời điểm cho tới khi có version/ETag cho form đó.

## Trạng thái cục bộ vẫn khác nhau

Các thứ như tab đang mở, menu, kích thước giao diện và một số lựa chọn UI lưu trong trình duyệt có thể khác giữa điện thoại và máy tính. Điều này không có nghĩa dữ liệu server khác nhau khi hai thiết bị dùng cùng `workspace`.
