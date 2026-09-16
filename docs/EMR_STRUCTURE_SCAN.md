# Kiểm tra cấu trúc EMR

## Vấn đề

`worker/hchanh_fetch.py` fetch dữ liệu bằng các selector/field id **cố định**, xác nhận
qua HTML thật do người dùng gửi trong quá trình phát triển. Nếu nhà cung cấp HIS
(ONEMES) cập nhật giao diện — đổi id field, đổi cấu trúc bảng, đổi wpid — code hiện tại
có thể fetch sai/thiếu **mà không báo lỗi rõ ràng** (chỉ trả về rỗng hoặc dữ liệu cũ).

## Giải pháp

Nút **"Kiểm tra cấu trúc EMR"** (mục Cài đặt) đăng nhập EMR **chỉ đọc**, tải lại các
trang code đang dùng và so với danh mục đã biết, đồng thời dò thêm các trang mới qua
liên kết tìm thấy trên các trang đó. Không tự sửa code, không bấm/gửi bất kỳ form nào —
chỉ báo cáo cho người dùng/người phát triển biết chỗ nào cần xem lại.

## Thành phần

| File | Vai trò |
| --- | --- |
| `config/hchanh/emr_structure_manifest.json` | Danh mục trang/selector code đang dùng — **sửa tay** khi thêm/đổi selector thật trong `hchanh_fetch.py`, không tự sinh. |
| `worker/emr_structure_scan.py` | Đăng nhập (`EmrHttpSession`, tái dùng session HTTP chỉ đọc có sẵn), kiểm từng trang trong manifest, dò trang mới qua `<a href>` chứa `wpid=`. |
| `server/routes/emr_structure_scan.js` | `GET /api/run-emr-structure-scan` — spawn worker qua `runScript`, cùng cơ chế hàng đợi/giới hạn (`enqueueHeavy`, `HEAVY_TASK_ROUTES`) như nút "Quét BN". |
| `src/components/EmrStructureScanTab.jsx` | Giao diện bấm nút + xem báo cáo. |

## Cách kiểm tra 1 trang đã biết

Với mỗi trang trong manifest: dựng URL (từ `wpid_literal` cố định, hoặc đọc
`wpid_config_key` trong `config.json` cho các trang có wpid tùy bệnh viện như
`discharge_wpid`/`bed_days_wpid`/`documents_wpid` — bỏ qua nếu chưa cấu hình), GET trang
đó, kiểm từng `field id`/`table id` khai báo trong manifest còn tồn tại trong HTML
không. Trang cần dữ liệu 1 người bệnh cụ thể (`needs_patient: true`) dùng chung 1 bệnh
nhân mẫu (lấy ngẫu nhiên từ danh sách nội trú khi quét).

## Cách dò trang mới

Từ mỗi trang đã tải, tìm mọi `<a href>` chứa `wpid=` chưa có trong manifest. **Bỏ qua**
link có chữ thuộc nhóm hành động ghi (xóa/lưu/sửa/cập nhật/xác nhận/duyệt/gửi/...) để
tránh vô tình chạm vào thao tác ghi. Tải tối đa `--max-discovered` trang mới (mặc định
15), chỉ 1 tầng (không tiếp tục dò từ trang mới phát hiện), có nghỉ giữa các lần gọi để
không dồn dập lên EMR thật. Với mỗi trang mới: chỉ tóm tắt cấu trúc (field id, tên bảng
+ header cột, số lựa chọn dropdown) — **không suy đoán ý nghĩa** của trang.

## Nếu báo "Đăng nhập HTTP thất bại"

Chế độ HTTP-only/no-Chrome không tự mở Chrome để đăng nhập. Nếu POST đăng
nhập bằng HTTP bị EMR từ chối (thường do trang login có cơ chế
viewstate/token phức tạp hơn form thường), chạy một lần từ máy có Chrome:

```bash
npm run auth:http
```

Lệnh này mở Chrome thật để đăng nhập rồi lưu cookie vào
`.runtime/auth/emr_http_cookies.json`. Sau đó bấm "Dò cấu trúc EMR ngay"
lại — lần quét sẽ dùng cookie đã lưu, không cần mở Chrome nữa.

## Nếu báo "Không tìm được bệnh nhân mẫu"

Các trang cần patient (bác sĩ, điều dưỡng, bảng kê chi phí, ...) cần lấy mẫu 1 mã BN từ
danh sách nội trú (`tblNoiTru`). Nếu danh sách đó trống hoặc đổi cấu trúc (đổi tên cột
"Mã BN"), báo cáo vẫn chạy tiếp thay vì bỏ cuộc: các trang cần patient bị đánh dấu
`skipped_no_sample_patient`, còn trang "Danh sách bệnh nhân nội trú" (không cần patient)
vẫn được kiểm thật sự — xem trạng thái của nó trong "CÁC TRANG ĐÃ BIẾT" và số liệu
`inpatient_scan_diag` (số dòng đọc được, số dòng dò được link, tên cột tìm thấy) để biết
là danh sách trống thật hay bảng đã đổi cấu trúc.

## Nếu trang "Danh sách bệnh nhân nội trú" báo "Đổi cấu trúc" (thiếu bảng tblNoiTru)

Một số bản HIS (ONEMES3) vẽ bảng này bằng JavaScript sau khi trang tải xong (gọi qua
một endpoint riêng gọi là AjaxPro), thay vì có sẵn trong HTML — HTTP-only/no-Chrome
không chạy JS nên sẽ luôn "thiếu bảng" dù đăng nhập đúng và danh sách thật sự không
trống. Đây không phải suy đoán — đã xác nhận trực tiếp qua DevTools trên một EMR thật
(POST `/ajaxpro/....ashx` kèm header `X-AjaxPro-Method`, trả về JSON chứa danh sách
bệnh nhân do JS tự vẽ ra bảng).

Cách kiểm tra trên EMR của bạn: mở Chrome thật, vào đúng màn hình danh sách nội trú,
bấm F12 → tab Network → bấm F5 → tìm dòng `xhr`/`fetch` lớn nhất trỏ tới
`/ajaxpro/....ashx` có header `X-AjaxPro-Method`. Nếu thấy vậy, điền vào `config.json`:

| Key | Lấy từ đâu |
| --- | --- |
| `ajaxpro_inpatient_endpoint` | Phần sau `/ajaxpro/` trong Request URL (vd `ONEMES3.DT.BVDK.WebParts.DanhSachDieuTriNoiTruDraw,....ashx`) |
| `ajaxpro_inpatient_method` | Header `X-AjaxPro-Method` (để trống thì dùng mặc định `ServerSideDrawSearchResult_VDUH`) |
| `ajaxpro_department_id` | Trường `DepartmentId` (hoặc `KhoaPhongId`) trong tab Payload |
| `ajaxpro_owner_user_id` | Trường `OwnerUserId` trong tab Payload |

Không cần điền mật khẩu hay cookie — phiên đăng nhập vẫn dùng cookie HTTP bình thường.

**Quan trọng**: ngay cả khi điền đủ 4 giá trị trên đúng từng chữ (kể cả GET lại trang
để lấy tham số phiên mới nhất trước khi gọi), có thể vẫn gặp lỗi
`System.MissingMethodException` từ server dù tên method đúng như trình duyệt đang dùng
— tức là còn thiếu điều kiện phía server mà không xác định được nếu không có tài liệu
kỹ thuật từ nhà cung cấp ONEMES hoặc IT của bệnh viện. Đây là giới hạn hiện tại, không
phải bug.

Chỉ cần điền được **`ajaxpro_inpatient_endpoint`** (dù đường gọi AjaxPro có tự chạy
được hay không), báo cáo sẽ tự hạ cấp cảnh báo "Đổi cấu trúc" của trang này thành
"ℹ Giới hạn kỹ thuật (đã xác nhận)" — vì việc bạn cấu hình được giá trị này (nghĩa là
đã tự xác nhận bằng DevTools) đã đủ bằng chứng đây là giới hạn kỹ thuật thật, không
phải EMR đổi cấu trúc. Chưa điền thì báo cáo vẫn giữ nguyên cảnh báo đỏ như trước, tránh
tự suy đoán cho các bản cài đặt chưa xác nhận.

## Giới hạn đã biết

- `loadformdongdraw` (form đóng hồ sơ) chưa đưa vào manifest — cần `noitruid`/`hosoid`
  riêng cho từng lần, chưa có cách dựng URL chung mà không suy đoán.
- Chỉ kiểm được các trang truy cập qua HTTP session (không cần JS/click) — trang nào
  chỉ hiện dữ liệu sau khi bấm nút trên UI thật (vd popup chi tiết CĐHA, xem
  `hchanh_cls_detail_fetch` trong `bhyt_pre_audit`) không nằm trong phạm vi tool này.
- Kết quả "còn đúng" (✓ OK) không đồng nghĩa "đã xác minh toàn bộ trang" — chỉ nghĩa là
  các field/bảng đã khai báo trong manifest vẫn tồn tại; nếu EMR thêm field mới không
  ảnh hưởng field cũ, tool này sẽ không phát hiện được thay đổi đó.
