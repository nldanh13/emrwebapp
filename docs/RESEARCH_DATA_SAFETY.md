# An toàn dữ liệu Kho nghiên cứu

Tài liệu này mô tả luồng dữ liệu của phần Nghiên cứu **theo code hiện tại**
(`server/routes/research.js`, `server/research/*`, `research/sqlite_store.py`),
các cơ chế bảo vệ đã có, và việc cần làm khi vận hành. Đây không phải tuyên bố
tuân thủ pháp luật: các mục đánh dấu **[Bệnh viện xác nhận]** cần bộ phận pháp
chế/an toàn thông tin/hội đồng đạo đức quyết định.

Định nghĩa chi tiết từng bảng/cột (mỗi dòng là gì, khóa, kiểu, đơn vị, giá trị cho
phép, ý nghĩa ô trống, nguồn, quy tắc chất lượng, định danh và phạm vi dùng): xem
[`DATA_DICTIONARY.md`](DATA_DICTIONARY.md).

## 1. Luồng dữ liệu

Mỗi kho (kho gốc `du_lieu_goc` hoặc một nghiên cứu riêng) nằm ở
`.runtime/research/research_store/<id>/`, mỗi lần quét là một run
`runs/<run_id>/`.

1. **Quét danh sách** → `du_lieu_ban_dau.csv` (1 dòng / dòng trên danh sách nội
   trú EMR; một đợt nằm viện có thể có nhiều dòng do chuyển khoa).
2. **Nguồn chuẩn** → `research_source.csv`: thêm `Mã NC`, `Research key` và
   khoảng ngày lấy dữ liệu cho từng dòng.
3. **Lấy dữ liệu** → `lich_su_xn.csv`, `lich_su_cdha.csv`, `du_lieu_goc.csv`
   (script XN/CĐHA) và `hchanh_*.csv` (hành chánh).
4. **Chuẩn hóa** → `patients`, `encounters` và các bảng con, `analysis_ready`,
   `analysis_selected`, `extract_status`, `research.sqlite3`, cùng các file kiểm
   soát mới (mục 3).
5. **Dataset cuối** → `analysis_final.csv` (bỏ dòng `needs_manual_review`) và bản
   lưu phiên bản trong `datasets/`.

## 2. Nhận diện người bệnh và đợt điều trị

- `patient_code` = Mã BN trên EMR. Không ghép theo họ tên.
- `encounter_id` ưu tiên khóa EMR: `encounter_id` có sẵn → Mã điều trị/Mã nội trú
  → Mã vào viện → (Mã BN + thời điểm vào/ra) → Mã NC. Nếu không đủ căn cứ, khóa có
  tiền tố `enc_unresolved_` và dòng được đánh dấu `needs_manual_review`.
- Dòng XN/CĐHA/phẫu thuật/y lệnh được gắn vào đợt theo khóa EMR, sau đó theo thời
  gian. Kết quả ghép ghi ở `encounter_match_status`: `matched`, `ambiguous` (khớp
  nhiều đợt) hoặc `missing`. Dòng `ambiguous`/`missing` **không** được tự gắn.
- **Chuyển khoa:** trên danh sách nội trú EMR, các dòng chuyển khoa của cùng một đợt
  nằm viện **dùng chung Mã nội trú** (đã được xác nhận ngày 23/09/2026). Các dòng chung
  Mã nội trú (hoặc Mã điều trị/Mã vào viện) được gộp thành **một đợt, một Mã NC**. Ngày
  vào của đợt là thời điểm vào **sớm nhất** trong các dòng, khoảng lấy dữ liệu là khoảng
  rộng nhất, không phụ thuộc thứ tự dòng trong file.
- Dòng **không có** Mã nội trú (ví dụ danh sách quét bằng bản cũ) không gộp được theo
  quy tắc trên. Hệ thống **không tự gộp** các dòng này; cặp đợt của cùng BN có khoảng
  nằm viện chồng lấn hoặc cùng ngày ra viện được liệt kê trong `encounter_review.csv`
  (`possible_same_stay`) để người duyệt. Quét lại danh sách bằng bản hiện tại để có
  Mã nội trú.

## 3. Kiểm soát sau mỗi lần Chuẩn hóa

| File | Nội dung |
|---|---|
| `normalize_state.json` | `running` trước khi ghi bảng, `complete`/`failed` khi xong. Còn `running` nghĩa là lần trước dừng giữa chừng. |
| `normalize_history.jsonl` | Mỗi lần chuẩn hóa thêm 1 dòng (không ghi đè): thời điểm, run_id, phiên bản schema, phiên bản code (version + git commit), chữ ký input, số dòng vào/ra, trạng thái SQLite, tóm tắt QA. |
| `qa_report.json` | Lỗi **chặn** và **cảnh báo**, chỉ chứa mã giả danh và số đếm. |
| `encounter_review.csv` | Danh sách đợt cần người duyệt kèm lý do. |
| `datasets/<tên>/` | Bản bất biến của mỗi dataset cuối: `analysis_final.csv`, `data_dictionary.json`, `dataset_manifest.json` (run, chữ ký dữ liệu chuẩn hóa, phiên bản schema/code/từ điển, cấu hình biến, đề cương + tiêu chí + yêu cầu dữ liệu của nghiên cứu, QA, checksum từng file) và `SHA256SUMS` (gồm cả checksum của manifest). Xem mục 3c. |

**Lỗi chặn** (không cho tạo dataset cuối): trùng `encounter_id`/Mã NC/`patient_code`,
thiếu khóa bắt buộc, dòng con trỏ tới đợt không tồn tại, trùng mã dòng, SQLite lỗi
hoặc lệch với CSV (so sha256), lần chuẩn hóa trước dừng giữa chừng hoặc lỗi.

**Cảnh báo** (cần xem lại): dòng con chưa ghép được đợt, thiếu ngày vào viện, ngày
ra trước ngày vào, ngày ở tương lai, nằm viện trên 365 ngày, ca nghi cùng đợt, dòng
XN/CĐHA thô giống hệt nhau đã bỏ bớt, và cùng BN + cùng thời điểm + cùng chỉ số mà kết
quả khác nhau (giữ tất cả, không tự chọn).
Hệ thống không tự sửa giá trị lâm sàng. Các cột suy luận (ví dụ
`injury_side_suggested`) được liệt kê trong `qa_report.json` → `notes` với trạng
thái `needs_human_confirmation`.

## 3c. Snapshot dataset cuối

- **Ghi an toàn:** snapshot được ghi vào `datasets/.tmp_<tên>_<ngẫu nhiên>/`. Thứ tự: CSV,
  từ điển, manifest (có checksum từng file), `SHA256SUMS`. Sau đó mọi file được kiểm lại
  SHA-256; chỉ khi khớp mới đổi tên (nguyên tử) thành `datasets/<tên>/`. Thư mục chính
  thức vì vậy luôn là snapshot đã hoàn tất. Thư mục `.tmp_*` không bao giờ được coi là
  snapshot.
- **Kiểm tra** (`GET /api/research/archive/datasets/verify`,
  `GET /api/research/studies/<id>/datasets/verify`): mỗi snapshot được báo một trong ba
  trạng thái:
  - `valid`: đủ file, đúng checksum;
  - `missing`: thiếu file hoặc thiếu cả snapshot;
  - `modified`: sai checksum, gồm cả trường hợp manifest bị sửa.

  Việc kiểm tra chỉ đọc; snapshot sai checksum được giữ nguyên để điều tra, không tự sửa
  hay ghi đè. Snapshot tạo trước bản này (chưa có `SHA256SUMS`) chỉ kiểm được CSV theo
  sha256 trong manifest, và được đánh dấu `legacy`.
- **Tạo lại cùng nội dung:** nếu có snapshot cùng sha256 và kiểm tra `valid` thì dùng lại
  snapshot đó, như trước đây. Nếu snapshot đó bị sửa hoặc thiếu file thì tạo snapshot mới
  bên cạnh; bản hỏng vẫn giữ nguyên.
- **Dọn sau sự cố:** mỗi lần tạo snapshot, thư mục `.tmp_*` bị bỏ lại được dọn. Thư mục tạm
  của chính tiến trình đang chạy thì dọn ngay (ghi snapshot là đồng bộ, nên nếu còn tức là
  đã hỏng). Thư mục tạm của tiến trình khác chỉ dọn khi đã cũ hơn 10 phút. Snapshot đã hoàn
  tất không bao giờ bị dọn.
- Log và kết quả kiểm tra chỉ có tên snapshot, tên file và checksum, không có dữ liệu
  người bệnh.

## 3b. Thu thập tự động (chỉ lấy phần thiếu/lỗi/đã thay đổi)

Nút **Thu thập tự động** (`POST /api/research/archive/collect-auto`, hoặc
`/api/research/studies/<id>/collect-auto`) thay cho việc bấm lần lượt từng bước rồi tự
rà kết quả. Code: `server/research/collection.js` (logic) và phần "Điều phối thu thập
tự động" trong `server/routes/research.js`.

**Trạng thái riêng từng phần của từng lượt** (XN, CĐHA, Hồ sơ nền, Ra viện, Phẫu
thuật, Y lệnh) được lưu ở `collection_ledger.json`.

**Đơn vị theo dõi là lượt điều trị, không phải dòng danh sách.** Các dòng chuyển khoa của
cùng một lượt được gom về lượt đã chuẩn hóa (`encounters.csv`), theo thứ tự ưu tiên:

1. Mã nội trú;
2. Mã điều trị;
3. T/G vào nằm trong khoảng vào–ra của lượt.

Dòng chỉ được gom khi khớp **đúng một** lượt; khớp nhiều lượt, hoặc khác Mã nội trú, thì
đứng riêng. Tiến độ nằm ở bất kỳ dòng nào của lượt đều được tính cho lượt. Tiến độ hành
chánh ghi theo khóa dòng cũ được ghép theo Mã BN + ngày vào, nếu khớp đúng một lượt. Khi
cần lấy lại, worker nhận dòng vào sớm nhất của lượt, với khoảng lấy dữ liệu phủ cả lượt.
Khi chưa chuẩn hóa (chưa có `encounters.csv`), mỗi dòng là một đơn vị.

Các trạng thái:

| Trạng thái | Nghĩa | Hệ thống làm gì |
|---|---|---|
| `ok` | Đã lấy, EMR có dữ liệu | Bỏ qua nếu lượt không đổi |
| `empty` | Đã lấy, **EMR xác nhận không có** | Bỏ qua nếu lượt không đổi |
| `pending` | Chưa lấy / lần trước dừng giữa chừng | Lấy |
| `failed` | Lỗi kỹ thuật (timeout, mất phiên, tab không tải, chỉ đọc được một phần) | Tự thử lại, tối đa 3 lần (đổi được theo đề cương); hết lượt thì vào danh sách ngoại lệ |
| `blocked` | Giao diện EMR khác mẫu; không xác định chắc lượt điều trị; EMR nay trống mà lần trước có dữ liệu | **Không** tự thử lại, dữ liệu cũ giữ nguyên, vào danh sách ngoại lệ |

- Script XN/CĐHA trước đây ghi tab "không tải được" thành "xong, 0 dòng", tức là lẫn
  với "EMR không có". Nay tab không tải được, hay có phiếu Hoàn tất mà không mở được
  chi tiết, đều được ghi là lỗi. XN và CĐHA được lưu **riêng**: XN lỗi thì CĐHA đã lấy
  vẫn được giữ, lần sau chỉ lấy lại XN.
- Không tìm thấy người bệnh trên EMR được ghi rõ theo dòng nguồn và để tìm lại sau cùng.
  Nếu có mốc thời gian mà không lượt nào trên EMR khớp chắc chắn, ca đó dừng với lý do
  `encounter_not_identified`; hệ thống **không** tự chọn lượt gần giống nhất. Dòng trên
  EMR khác Mã nội trú với dòng nguồn không bao giờ được nhận thay.
- **Phát hiện thay đổi:** mỗi dòng danh sách nội trú có một chữ ký hash (Mã nội trú,
  trạng thái, xử trí, khoa chuyển đến, ngày ra; riêng họ tên/tuổi/giới). Cột
  `list_row_signatures` nằm trong `research_source.csv`, chỉ chứa hash. Khi quét lại danh
  sách, lượt có dòng mới hoặc dòng đổi thông tin được lấy lại cả 6 phần. Nếu chỉ đổi
  họ tên/tuổi/giới thì chỉ lấy lại hồ sơ nền. Dòng bị gộp khỏi `du_lieu_ban_dau.csv`
  không bị coi là thay đổi.
- **Lần chạy đầu sau khi nâng cấp:** các tab XN/CĐHA mà bản cũ ghi "xong, 0 dòng" sẽ
  được lấy lại **một lần** để xác nhận EMR thật sự không có. Lý do là bản cũ không phân
  biệt được hai trường hợp này.

**Kết quả bị sửa trên EMR mà dòng danh sách không đổi.** Chữ ký danh sách không bắt
được trường hợp này, nên có thêm:

- **Lần kiểm tra gần nhất** của từng phần, từng lượt: `last_check_at` trong sổ, lấy
  theo lúc worker thật sự đọc EMR.
- **Chính sách làm mới riêng từng phần** (`POST .../refresh-policy`, ví dụ
  `{"xn": 14, "cdha": 30}` ngày). Kho gốc và mỗi nghiên cứu có chính sách riêng. Phần
  không đặt hạn thì **không** tự kiểm tra lại; không có một khoảng thời gian chung cho mọi
  loại dữ liệu. Nút **Làm mới** kiểm tra lại ngay các phần người dùng chọn. Làm mới thủ
  công cũng thử lại phần đã hết lượt tự thử lại.
- **So sánh khi lấy lại:**
  - Dữ liệu mới được so với bản trước. Các cột kỹ thuật như run, nguồn, URL phiên không
    được tính vào so sánh.
  - Nếu giống, phần đó chỉ được ghi "đã kiểm tra, không đổi"; phiên bản giữ nguyên.
  - Nếu khác, phiên bản tăng lên và **cả bản cũ lẫn bản mới** được ghi vào
    `collection_versions.jsonl`. File này chỉ thêm, không ghi đè.
  - Mỗi thay đổi được ghi một dòng vào `collection_changes.csv`: phần nào, phiên bản
    nào, thêm/bớt bao nhiêu dòng, do quá hạn hay do bấm Làm mới. File này chỉ có Mã NC,
    không có Mã BN.
  - `collection_versions.jsonl` chứa dữ liệu lâm sàng thô như các file CSV trong run, nên
    có cùng mức nhạy cảm.
- **Sau khi cập nhật**, hệ thống tự chạy lại chuẩn hóa, rồi đánh giá lại các lượt vừa lấy
  theo yêu cầu của từng nghiên cứu:
  - Kho gốc được đánh giá theo mọi nghiên cứu; nghiên cứu riêng thì theo chính nó.
  - Lượt nào đổi mức đủ dùng được liệt kê trong báo cáo (`readiness_changes`).
- Chỉ lần lấy qua **Thu thập tự động** mới được so sánh và lưu phiên bản. Các nút chạy
  từng bước cũ vẫn thay dữ liệu như trước, không lưu bản cũ.

**Giao dịch làm mới có thể khôi phục.** Mỗi lượt giao việc cho worker là một giao dịch
trong `<run>/.collection_txn/<id>/`:

1. **Chuẩn bị** (trước khi worker thay dữ liệu): chụp dữ liệu cũ của đúng các phần sẽ lấy
   (`before_rows.json`) và sổ hiện tại (`before_ledger.json`). Sau đó mới ghi
   `journal.json`; có journal nghĩa là ảnh chụp đã đủ.
2. **Đã lấy**: worker chạy xong. CSV và progress có thể đã đổi.
3. **Hoàn tất**: so sánh, rồi ghi lần lượt lịch sử phiên bản, lịch sử thay đổi, sổ thu
   thập. Journal ghi lại bước nào đã xong. Mỗi bước tự bỏ qua phần đã ghi vì phiên bản và
   thay đổi có id ổn định (lượt + phần + số phiên bản + hash nội dung), nên chạy lại không
   tạo bản trùng.
4. **Kết thúc**: xóa thư mục giao dịch, ghi một dòng không định danh vào
   `collection_txn_log.jsonl`.

Khi bấm Thu thập tự động hoặc xem trạng thái, giao dịch dở dang của lần chạy trước (không
thuộc tiến trình đang chạy) được hoàn tất **trước** khi đọc progress. Bản cũ lấy từ ảnh
chụp, nên không mất dù CSV đã bị thay.

- Commit dở của script XN/CĐHA (`.commit_*`) được trả lại bản backup trước khi so sánh.
- Nếu worker đã ghi CSV mà chưa kịp ghi progress, thay đổi vẫn được lưu phiên bản, với kết
  quả `changed_unconfirmed`.
- Worker hành chánh nay ghi CSV **trước**, progress **sau**. Trước đây có thể có progress
  "xong" mà CSV chưa có dữ liệu.
- Dòng lịch sử bị cắt dở do dừng đột ngột được bỏ qua và ghi lại đầy đủ.

Thư mục `.collection_txn` chứa dữ liệu lâm sàng thô (ảnh chụp bản cũ), nên được tạo với
quyền 700/600 (chỉ chủ sở hữu, trên Linux/macOS) và bị xóa ngay khi giao dịch kết thúc.
Trên Windows, quyền thư mục theo quyền của thư mục `.runtime`. Hệ thống không sửa dữ liệu
trên EMR và không xóa lịch sử phiên bản đã lưu.

**Báo cáo sau mỗi đợt** (`collection_report.json`; lịch sử chỉ gồm số đếm ở
`collection_history.jsonl`). Báo cáo gồm: số ca đã lấy, số ca bỏ qua vì không đổi, số
phần đã tự lấy bù, số lỗi Selenium còn tồn, số ca không thể ghép chắc chắn. Chỉ các ca
ngoại lệ nằm trong `collection_exceptions.csv` (loại, Mã NC, phần, lý do, số lần thử).
Chi tiết lỗi đã được bỏ URL và các dãy số dài.

**Đủ dùng theo từng nghiên cứu** (`GET /api/research/studies/<id>/readiness` →
`study_readiness.csv`). Không có nhãn đủ/thiếu chung cho người bệnh. Mỗi đề cương khai
báo phần bắt buộc và dữ liệu phải có, ví dụ "có CĐHA loại CT", qua
`POST /api/research/studies/<id>/data-requirements`. Nếu chưa khai báo, hệ thống suy
ra từ biến đã chọn; nếu cũng chưa chọn biến thì mặc định cần đủ 6 phần. Kết quả từng
lượt:

- `usable`: đủ dùng;
- `not_eligible`: đã lấy đủ nhưng EMR không có dữ liệu đề tài yêu cầu, ví dụ không có CT;
- `incomplete`: phần bắt buộc chưa lấy xong;
- `needs_review`: có phần bị chặn hoặc lượt không ghép chắc.

Một ca thiếu CT vẫn `usable` cho đề tài không cần CT.

## 4. Dữ liệu định danh

- Có định danh trực tiếp: `du_lieu_ban_dau.csv`, `research_source.csv`,
  `hchanh_*.csv`, `patients.csv`, `analysis_ready.csv` (họ tên), `research.sqlite3`.
- Xem/xuất mặc định **đã che** theo tên cột (`server/research/export_utils.js`),
  gồm cả Mã nội trú, số lưu trữ và URL EMR (URL chứa `keyword=<Mã BN>`).
- Xem/xuất có định danh cần đồng thời: `identified=1`, vai trò supervisor/admin, và
  `EMR_ALLOW_IDENTIFIED_RESEARCH_EXPORT=1`. Mỗi lần được phép ghi sự kiện
  `research.identified_access` vào `.runtime/audit/security_audit_YYYYMM.jsonl`
  (chuỗi hash): người dùng, thời điểm, bảng/run/nghiên cứu, mục đích nếu gửi
  `?purpose=`.
- Từ khóa tra cứu người bệnh chỉ được lưu dạng băm trong log. Log worker và
  `action_log.txt` không in họ tên, số thẻ BHYT, chẩn đoán.
- Log console của worker, stderr trả về giao diện và `action_log.txt` đi qua bộ che
  `server/utils/log_redact.js` / `worker/log_redact.py`: URL EMR chỉ giữ tham số mô tả
  màn hình (`wpid`, `wpre`, `nextlink`…), bỏ giá trị mã phiên `usid`, `noitruid`,
  `keyword`, `kp`…; dãy 7–10 chữ số đứng riêng (Mã BN) thành nhãn `BN#xxxxxx` — băm có
  muối ngẫu nhiên theo mỗi lần khởi động server, nên lần theo được một ca trong log
  nhưng không tra ngược ra Mã BN. Log cũ ghi trước thay đổi này không được sửa lại.
  Stacktrace chromedriver bị lược khỏi log.
- Tab "Tra cứu người bệnh" hỏi `GET /research/identified-access` trước; khi đang khóa
  thì hiện điều kiện cần bật thay vì gọi API rồi báo lỗi.
- Chưa tách bảng liên kết Mã BN ↔ Mã NC khỏi dữ liệu phân tích: các bảng chuẩn hóa
  vẫn giữ `patient_code` để ghép. Việc tách là thay đổi cấu trúc lớn, đề xuất làm ở
  bước sau.

## 5. Nghiên cứu riêng

- Mỗi nghiên cứu có thư mục, cohort, run, SQLite và dataset riêng. Thay đổi một
  nghiên cứu không ghi vào thư mục nghiên cứu khác.
- `study.json` → `governance`: mã/phiên bản đề cương, trạng thái phê duyệt, số và
  ngày phê duyệt, giai đoạn dữ liệu, tiêu chí chọn/loại trừ, trường định danh được
  duyệt, người được phép truy cập. Cập nhật qua
  `POST /api/research/studies/:id/governance` (supervisor). Hiện tại **chỉ lưu và
  ghi vào manifest dataset**, chưa dùng để chặn truy cập. **[Bệnh viện xác nhận]**
  có bắt buộc `approval_status=approved` trước khi xuất hay không.
- Xóa nghiên cứu: chỉ admin, thư mục được chuyển vào `research_store/_deleted/`
  (có audit `research.study_deleted`), không xóa vĩnh viễn.

## 6. Sao lưu và khôi phục

Toàn bộ dữ liệu nằm trong `.runtime/` (kho nghiên cứu, audit). Đề xuất:

1. **Trước khi cập nhật code**: dừng server, sao chép cả thư mục
   `E:\web app\.runtime\research\research_store\` sang ổ/phân vùng khác, đặt tên
   theo ngày (ví dụ `research_store_backup_20260923`).
2. **Định kỳ** (theo chính sách bệnh viện): sao lưu `.runtime\research\` và
   `.runtime\audit\` lên nơi lưu trữ đã được mã hóa. **[Bệnh viện xác nhận]** nơi
   lưu, thời hạn giữ, ai được truy cập bản sao lưu.
3. **Khôi phục**: dừng server, chép thư mục sao lưu về đúng vị trí, khởi động lại,
   bấm **Chuẩn hóa** để tạo lại bảng và SQLite từ file thô.
4. Khôi phục nghiên cứu bị xóa nhầm: chuyển
   `_deleted\<id>_<thời điểm>\` về `research_store\<id>\`.

## 7. Nâng cấp lên phiên bản này

Không có migration phá dữ liệu. Các bước:

1. Sao lưu như mục 6.1.
2. `git pull`, khởi động lại server.
3. Mở từng kho/nghiên cứu, bấm **Chuẩn hóa**. Schema tăng lên v12 nên lần đầu sẽ
   chuẩn hóa lại đầy đủ và tạo `qa_report.json`, `encounter_review.csv`.
4. Nếu `research_source.csv` cũ có Mã NC bị trùng (lỗi cũ cấp `NC0001` cho mọi
   dòng), file này được tạo lại với Mã NC duy nhất. Mã được lấy theo thứ tự ưu tiên
   (1) mã hợp lệ cũ của cùng dòng, (2) mã script XN/CĐHA đã cấp cho cùng đợt trong
   `du_lieu_goc.csv`, (3) số mới. **Mã NC của một số đợt có thể thay đổi**; các
   `analysis_final.csv` cũ được lưu bản sao trong `datasets/` trước khi bị gỡ.
5. Xem `qa_report.json`/khung độ phủ: xử lý lỗi chặn trước khi tạo dataset cuối.
