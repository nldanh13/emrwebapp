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
| `POST /api/kho/dong-bo` | chép kho đợt nằm viện đã có sang kho người bệnh |

## Sao lưu

Kho là một file duy nhất. Khi sao lưu, chép cả `kho.sqlite3`, `kho.sqlite3-wal` và `kho.sqlite3-shm` lúc máy chủ đã dừng.

## Các đợt tiếp theo

- **Đợt 3:** nối lượt (`lien_ket_luot`).
  - Tái khám đúng hẹn: ±3 ngày so với ngày hẹn.
  - Trễ hẹn / không tái khám.
  - Tái nhập viện trong 30 ngày.
  - Khám → nhập viện.
  - Kèm màn "Hành trình người bệnh" và báo cáo.
- **Đợt 4:** các tab đọc dữ liệu từ kho.
- **Đợt 5:** Kho nghiên cứu chuẩn hoá từ kho chung.
