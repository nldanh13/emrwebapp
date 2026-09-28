# Kho người bệnh

Một file SQLite gom mọi lượt khám và mọi đợt nằm viện của từng người bệnh, để tra hành trình và theo dõi tái khám.

- Code: `server/services/patient_db.js` (kho), `server/services/clinic_patient_sync.js` (Phòng khám), `server/routes/patient_db.js` (API).
- File: `.runtime/kho_benh_nhan/kho.sqlite3`. Có thể đổi bằng biến `EMR_PATIENT_DB_PATH`.
- Cần Node.js ≥ 22.13 (dùng `node:sqlite` có sẵn, không cài thêm gói). Với Node cũ hơn, kho tắt và API trả 503; các phần khác vẫn chạy.

## Nguyên tắc

1. **Người bệnh = Mã BN.** Không ghép theo họ tên.
2. **Lượt = 1 lần tiếp xúc.**
   - `kham`: 1 dòng Danh sách Khám bệnh, khoá `kb:<khambenhid>`.
   - `noi_tru`: 1 đợt nằm viện. Các lần quét của cùng Mã BN có khoảng ngày giao nhau được ghép vào cùng một đợt.
3. **Dữ liệu thô không bao giờ bị sửa hay xoá.** Bảng `lan_quet` lưu từng file lấy từ EMR nguyên văn, kèm nguồn, mức tin cậy và thời điểm lấy. Nội dung trùng (cùng hash, không tính `_meta`) thì không lưu lại.
4. **Mức tin cậy:**
   - `goc`: lượt đã kết thúc và được quét để chốt (Kho nghiên cứu; lượt khám đã Hoàn tất).
   - `tam_thoi`: quét lúc người bệnh còn đang điều trị (Hành chánh, Kiểm hồ sơ, Phòng khám đang theo dõi).
5. **Bảng chuẩn hoá luôn dựng lại được** từ `lan_quet`. Mỗi loại dữ liệu lấy bản gốc trước, cùng mức thì lấy bản mới hơn.
6. **Chỉ máy chủ Node ghi vào kho.** Worker Python vẫn trả JSON như cũ.
7. **Không tự điền dữ liệu.** Ô trống nghĩa là nguồn không có hoặc hệ thống không đọc được.

## Bảng

| Bảng | Mỗi dòng là |
|---|---|
| `benh_nhan` | 1 người bệnh: họ tên (kèm bản không dấu để tìm), năm sinh, giới, địa chỉ, SĐT, thẻ BHYT |
| `luot` | 1 lượt: loại, khoa, giờ vào/ra, trạng thái, xử trí, BHYT, lý do, chẩn đoán chính + ICD, ngày hẹn tái khám, mức, nguồn |
| `lan_quet` | 1 file dữ liệu thô của 1 lần quét |
| `chan_doan` | 1 chẩn đoán của lượt (`chinh`, `kem`, `vao`, `ra`) |
| `dich_vu` | 1 dịch vụ: XN / CĐHA (số đã xong / số chỉ định) hoặc chỉ định chụp |
| `thao_tac` | 1 việc hệ thống đã làm trên EMR (`hoan_tat_kham`, `sbbhc`, `dieu_tri_ngoai_tru`) |
| `ket_qua_xn` | 1 kết quả xét nghiệm (1 chỉ số): thời gian, loại XN, chỉ số, kết quả, đơn vị, tham chiếu, cờ bất thường, kèm dòng nguồn nguyên văn |
| `ket_qua_cdha` | 1 dịch vụ CĐHA: thời gian, nhóm, tên dịch vụ, mô tả, kết luận, kèm dòng nguồn nguyên văn |
| `lien_ket_luot` | 1 mối nối giữa 2 lượt của cùng người bệnh (xem mục Tái khám). Tính lại mỗi khi lượt thay đổi, không nhập tay |

## Tái khám và tái nhập viện

Mỗi khi một lượt thay đổi, `rebuildLinks` tính lại các mối nối của người bệnh đó.

| Loại nối | Quy tắc |
|---|---|
| `tai_kham_dung_hen` | Lượt có ngày hẹn → lượt sau gần ngày hẹn nhất, lệch không quá ±3 ngày. Nếu cùng ngày có cả lượt khám và đợt nội trú, lấy lượt khám |
| `tai_kham_tre_hen` | Không có lượt trong ±3 ngày → lượt đầu tiên sau hạn (quá ngày hẹn + 3 ngày) |
| `tai_nhap_vien_30` | Đợt nội trú đã ra viện → đợt nội trú kế tiếp bắt đầu trong 30 ngày |
| `kham_nhap_vien` | Lượt khám có xử trí Nhập viện → đợt nội trú bắt đầu trong 2 ngày |

Trạng thái hẹn tính theo ngày hôm nay, không lưu vào kho:
- `dung_hen` / `tre_hen`: có mối nối tương ứng.
- `qua_hen`: đã quá ngày hẹn + 3 ngày mà chưa thấy người bệnh quay lại.
- `chua_den_hen`: chưa tới ngày hẹn, hoặc vẫn còn trong khoảng ±3 ngày.

Cách tính tỉ lệ:
- **Tỉ lệ đúng hẹn** = đúng hẹn / (đúng hẹn + trễ hẹn + quá hẹn). Không tính các hẹn chưa đến.
- **Tỉ lệ tái nhập viện** = tái nhập / (tái nhập + không tái nhập). Đợt ra viện chưa đủ 30 ngày mà chưa thấy tái nhập được đếm riêng.

Giới hạn: chỉ tính các lượt có trong kho. Người bệnh quay lại nơi hệ thống không quét sẽ bị tính là quá hẹn hoặc không tái nhập.

Màn hình **Người bệnh & tái khám** (nhóm Nghiên cứu) có 3 phần:
- tìm người bệnh và xem hành trình;
- báo cáo tái khám theo ngày hẹn;
- báo cáo tái nhập viện theo ngày ra viện.

## Nguồn ghi vào kho

- **Hành chánh, Kiểm hồ sơ, Kho nghiên cứu:** mỗi lần lấy dữ liệu hành chánh, `recordHchanhFetch` ghi kết quả vào kho dùng chung (`hchanh_stays`) rồi chép sang kho người bệnh.
  - Dữ liệu đã lấy từ trước: Hành chánh → Công cụ → "Góp dữ liệu đã lấy vào kho nghiên cứu", hoặc gọi `POST /api/kho/dong-bo`.
- **Phòng khám:** trong lúc theo dõi, máy chủ chép `clinic_monitor_state.json` sang kho mỗi phút, khi dừng và trước khi bắt đầu lần theo dõi mới. Trước đây file này bị ghi đè mỗi chu kỳ nên không còn lịch sử.
  - Worker mở màn khám (chỉ đọc, không bấm nút) của lượt đã có xử trí để đọc chẩn đoán, lý do khám, chi tiết xử trí và ngày hẹn tái khám.
  - Khi lượt chuyển sang Hoàn tất, worker đọc lại để chốt thành dữ liệu gốc.
  - Mỗi chu kỳ đọc tối đa 4 lượt, ưu tiên lượt đã Hoàn tất.
  - Ngày hẹn được tìm theo nhãn có chữ "hẹn" hoặc "tái khám" trong popup xử trí; toàn bộ popup vẫn được lưu nguyên văn trong `lan_quet`.

## Tra cứu (vai trò operator trở lên; mỗi lần xem hồ sơ được ghi nhật ký)

| API | Dùng để |
|---|---|
| `GET /api/kho/tong-quan` | số người bệnh, số lượt, dung lượng |
| `GET /api/kho/tim?q=` | tìm theo mã BN, họ tên (có dấu hoặc không dấu), SĐT, số thẻ BHYT |
| `GET /api/kho/benh-nhan/:maBn` | hành trình: mọi lượt theo thời gian, kèm chẩn đoán, dịch vụ, thao tác, nguồn dữ liệu |
| `GET /api/kho/luot?tu=&den=&loai=&khoa=` | danh sách lượt theo ngày, loại, khoa |
| `GET /api/kho/tai-kham?tu=&den=&trang_thai=` | báo cáo tái khám theo ngày hẹn; `trang_thai`: `dung_hen`, `tre_hen`, `qua_hen`, `chua_den_hen` |
| `GET /api/kho/tai-nhap-vien?tu=&den=` | báo cáo tái nhập viện trong 30 ngày, theo ngày ra viện |
| `POST /api/kho/dong-bo` | chép kho đợt nằm viện đã có sang kho người bệnh |

## Các tab đọc từ kho

- **Kho nghiên cứu, Kiểm hồ sơ:**
  - `hchanh_stay_store.findStoredStay` đọc Kho người bệnh trước (`patient_db.findStay`): đợt đã ra viện chứa ngày cần tìm, mỗi file lấy bản gốc trước, cùng mức thì lấy bản mới hơn.
  - File JSON `hchanh_stays` chỉ còn là dự phòng, dùng khi kho tắt hoặc chưa có đợt đó.
- **Phòng khám:** mỗi dòng Danh sách Khám bệnh có thêm `lich_su` (`patient_db.patientContext`), không tính chính lượt đang khám. Dòng hiển thị:
  - lượt này là tái khám đúng hẹn (±3 ngày), trễ hẹn hay khám trước hẹn;
  - ra viện trong 30 ngày gần đây, nếu có;
  - hoặc số lần đã đến và lần gần nhất.
  - Hẹn cũ hơn 90 ngày không được tính.
- **Hành chánh:**
  - Thẻ người bệnh có `lich_su`, không tính đợt đang nằm.
  - Danh sách báo "Tái nhập viện: ra viện dd/mm, sau N ngày" khi lần ra viện trước cách đợt này không quá 30 ngày.
  - Tab Hồ sơ có mục "Lịch sử trong kho người bệnh".

## Kho nghiên cứu chuẩn hoá từ kho chung

Khi bấm Chuẩn hoá, phần hành chánh của từng ca (thông tin nền, ra viện, phẫu thuật, y lệnh) được đối chiếu với Kho người bệnh. Hàm xử lý là `overlayHchanhFromPatientDb` trong `server/routes/research.js`.

| Trường hợp | Kết quả |
|---|---|
| Lần quét của nghiên cứu chưa có phần đó | Lấy từ kho. Dòng có cột `Nguồn kho` = `kho_nguoi_benh:goc` hoặc `kho_nguoi_benh:tam_thoi` |
| Lần quét đang dùng dữ liệu tạm thời (`provisional_files` trong file tiến độ) và kho đã có dữ liệu gốc | Thay bằng dữ liệu gốc |
| Còn lại | Giữ nguyên dữ liệu của lần quét |

- CSV thô của lần quét (`hchanh_*.csv`) không bị sửa. Kết quả đối chiếu ghi vào `kho_nguoi_benh_overlay.json` và `action_log.txt`.
- Thông báo sau khi chuẩn hoá cho biết đã lấy / thay bao nhiêu phần và còn bao nhiêu phần tạm thời.
- Chữ ký đầu vào có kèm phiên bản dữ liệu của kho (`patient_db.dataVersion`). Kho có bản quét mới thì lần bấm Chuẩn hoá sau sẽ chạy lại, không dùng kết quả cũ.
- **XN / CĐHA:**
  - Mỗi lần chuẩn hoá, kết quả trong `lich_su_xn.csv` / `lich_su_cdha.csv` của lần quét được ghi vào kho ở mức gốc.
  - Ca **chưa có kết quả nào** trong lần quét (theo Mã BN và khoảng ngày của ca) thì lấy từ kho, ví dụ kho gốc hay nghiên cứu khác đã lấy trước. Các dòng lấy từ kho mang Mã NC của nghiên cứu hiện tại.
  - Ca đã có kết quả trong lần quét thì giữ nguyên.
  - Kho không lưu Mã NC. Cùng người bệnh, thời điểm, chỉ số và kết quả chỉ được lưu một lần, dù lấy ở nhiều lần quét.
  - Kết quả được gắn vào lượt theo ngày: đợt nội trú chứa ngày đó, không có thì lượt khám cùng ngày. Việc gắn được tính lại mỗi khi lượt thay đổi.
  - Dòng thiếu Mã BN, thời gian hoặc tên chỉ số / dịch vụ bị bỏ qua; hệ thống không tự điền.
- **Góp kết quả đã lấy từ trước:** nút "Góp dữ liệu đã lấy vào kho nghiên cứu" (Hành chánh → Công cụ) hoặc `POST /api/kho/dong-bo` đọc XN / CĐHA của mọi lần quét nghiên cứu đã có.
- Màn "Người bệnh & tái khám" cho mỗi lượt một mục thu gọn "Xét nghiệm: N kết quả (M bất thường) · CĐHA: K", bấm vào để xem bảng kết quả và kết luận CĐHA.

## Sao lưu

Kiểm tra toàn vẹn và tạo bản sao nhất quán (có thể chạy khi máy chủ đang hoạt động):

```bash
npm run patient-db:check
npm run patient-db:backup
```

- Bản sao mặc định nằm trong `.runtime/backups/kho_benh_nhan/` và không được commit.
- Có thể đổi thư mục bằng biến `EMR_PATIENT_DB_BACKUP_DIR`.
- Lệnh sao lưu kiểm tra kho trước, dùng `VACUUM INTO`, ghi file tạm rồi mới đổi tên; không để lại file chính thức dở dang khi lỗi.
- Nên lên lịch chạy `npm run patient-db:backup` hằng ngày bằng Task Scheduler trên máy Windows vận hành.

## Việc có thể làm tiếp

- Lấy XN / CĐHA ngay khi người bệnh đang nằm viện (Hành chánh / Phòng khám) để có kết quả tạm thời trước khi Kho nghiên cứu chốt.
