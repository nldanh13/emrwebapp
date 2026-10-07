# Quy trình toàn vẹn dữ liệu nghiên cứu

## Nguyên tắc bắt buộc

1. **Nguồn EMR là bằng chứng, không phải suy diễn.** Không có ghi nhận không đồng nghĩa với “Không”. Y lệnh không đồng nghĩa đã dùng/đã thực hiện.
2. **Raw là nguồn đối chiếu.** Mọi sửa tự động trên raw phải có backup trước thay đổi và audit từng dòng.
3. **Phẫu thuật chỉ ghép khi nằm trong đợt điều trị đã khớp.** `encounter_id` là bằng chứng hỗ trợ; không dùng đơn độc nếu nguồn có biểu diễn lượt trùng/lệch.
4. **Không bỏ dòng âm thầm.** Raw JSON lỗi, ngày PT thiếu, collection lỗi/pending, normalized unmatched đều phải xuất hiện trong `collection_integrity.json`/QA.
5. **Mọi đường Chuẩn hóa chính thức dùng cùng preflight.** Archive, Study, Run, child và inline đều đi qua `normalize_safe.js`.

## Các lỗi đã xảy ra và biện pháp chặn tái diễn

### 1. Mất ngày phẫu thuật khi flatten raw

Worker có thể trả `detail.bat_dau` chỉ là giờ, trong khi `item.thoi_gian` còn ngày + giờ. Dữ liệu legacy vì vậy có thể có `Ngày phẫu thuật=08:15` và bị loại khỏi normalize.

**Biện pháp:** `surgery_raw_repair.js` chỉ phục hồi từ bằng chứng explicit trong Raw JSON trước normalize. Nếu cột hiện tại đã có ngày đầy đủ thì không được ghi đè bằng ngày từ list row.

### 2. Repair từng ghi đè một ngày PT hợp lệ

Logic cũ ưu tiên ngày từ dòng danh sách, khiến ngày hợp lệ có thể bị thay và chuyển thành “outside stay”.

**Biện pháp:** thứ tự bằng chứng hiện tại là: ngày đầy đủ đang có → ngày explicit trong detail → ngày list + giờ detail. Có regression test.

### 3. Một số đường normalize bỏ qua repair

Archive/study/direct/inline từng không đồng nhất; chạy trực tiếp có thể tạo `surgery_results.csv` khác với chạy qua queue.

**Biện pháp:** `normalize_safe.js` là cổng chung; `normalize_child.js` và `normalize_runner.js` đều gọi cổng này.

### 4. Raw bị sửa nhưng không có bản quay lại

Sự cố trước buộc phải phục hồi từ Raw JSON vì không có backup trước lần repair.

**Biện pháp:** trước lần repair có thay đổi đầu tiên, tự tạo `hchanh_surgery.before_auto_repair.csv`; mọi thay đổi ghi nối tiếp vào `surgery_raw_repair_audit.jsonl`. Repair phải idempotent.

### 5. “Không có marker PT trong lịch sử y lệnh” từng bị xem như `ok + 0`

Marker lịch sử y lệnh chỉ là tín hiệu sàng lọc. Không có marker **không chứng minh** không có phẫu thuật.

**Biện pháp:** `hchanh_fetch_entry.py` là entrypoint tương thích ngược cho worker Hành chánh. Riêng luồng `hchanh_auto` của nghiên cứu, nếu không có marker PT nhưng có khoảng ngày đợt điều trị, worker vẫn mở/xác minh D/s Phẫu thuật trên toàn khoảng admission–discharge. Kết quả zero sau lookup thật được ghi `fetch_status=empty` + `verified_surgery_list_empty`; nếu không thể xác minh thì là `partial`, không phải `ok`.

`collection_integrity.json` coi legacy `ok + 0` không có bằng chứng lookup là `SURGERY_ZERO_UNVERIFIED` **blocking**. Chỉ `empty` sau lookup thật mới là `verified_empty`.

### 6. Dùng run lịch sử/stale và normalize khi thu thập chưa xong

Một file chuẩn hóa có timestamp mới không chứng minh raw đã đầy đủ. Archive run cũng không nên được chọn chỉ vì mtime.

**Biện pháp:** luôn ghi/kiểm tra run id; chỉ dùng archive khi người dùng chủ động chọn. `collection_integrity.json` ghi các trạng thái surgery pending/error và raw/normalized counts.

### 7. Diagnostic/linkage quá rộng

Ghép theo mã BN hoặc chẩn đoán có thể kéo PT từ đợt khác.

**Biện pháp:** ưu tiên encounter đã xác lập + admission/discharge window; fallback chỉ khi có mốc ngày PT nằm trong đúng đợt và kết quả là duy nhất. Encounter không duy nhất phải giữ unresolved, không tự ép ghép.

## SOP chuẩn từ nay

### A. Thu thập

- Lưu run id ngay từ đầu.
- Lấy đủ các file được yêu cầu cho từng ca.
- Với research `hchanh_auto`, surgery được xác minh trực tiếp trên D/s Phẫu thuật trong toàn đợt; marker y lệnh chỉ hỗ trợ, không còn là điều kiện để bỏ qua lookup.
- Surgery zero-row chỉ được coi là explicit empty sau khi worker đã thực sự kiểm tra màn hình surgery (`fetch_status=empty`, reason `verified_surgery_list_empty`).
- Không điền “Không” từ sự vắng mặt của raw.

### B. Preflight

Chạy normalize qua queue/UI hoặc `normalize_safe.js`. Preflight sẽ:

1. backup raw trước repair;
2. repair legacy surgery từ bằng chứng explicit;
3. ghi audit;
4. tạo `collection_integrity.json`.

Các mã cần xử lý:

- `SURGERY_COLLECTION_INCOMPLETE`: blocking;
- `SURGERY_ZERO_UNVERIFIED`: blocking;
- `SURGERY_RAW_JSON_INVALID`: blocking;
- `SURGERY_RAW_DATE_INCOMPLETE`: cần rà ngày;
- `SURGERY_NORMALIZED_UNMATCHED`: cần rà linkage.

### C. Chuẩn hóa

Không gọi `normalize.normalizeRunOutputs(...)` trực tiếp trong thao tác vận hành. Dùng `normalize_safe.normalizeRunOutputsSafe(...)` hoặc UI/queue.

### D. Merge nghiên cứu

- Chỉ điền ô trống.
- PT phải nằm trong admission–discharge window của encounter đã khớp.
- Lưu nguồn/audit cho mỗi ô bổ sung.
- Encounter không duy nhất → unresolved, không đoán.
- Không có raw → missing/unverified, không điền “Không”.

### E. Chốt dataset

Chỉ chốt sau khi xem cả QA chuẩn hóa và `collection_integrity.json`. `ready_for_analysis` phải là `true`; mọi unresolved còn lại phải có lý do rõ ràng và được giữ trong audit/unresolved output.

## Kiểm tra ngẫu nhiên độ chính xác (Kho dữ liệu gốc → Kiểm tra ngẫu nhiên)

Dùng để đánh giá dữ liệu đã ghép đúng tới đâu, bằng cách đối chiếu trực tiếp với EMR:

1. Bấm **Chọn ca ngẫu nhiên**. Máy chọn một đợt điều trị chưa kiểm (ca đã kiểm không bị chọn lại).
2. Mở EMR của người bệnh (Mã BN hiện ở đầu thẻ), đối chiếu từng mục:
   - **Mốc đợt**: ngày giờ vào viện (tính cả Cấp cứu), ngày giờ ra viện, chẩn đoán.
   - **Tối đa 5 dòng ngẫu nhiên** mỗi loại: XN, CĐHA, thuốc/y lệnh, phẫu thuật. Kiểm cả nội dung lẫn việc thuộc đúng đợt.
     Dòng có nhãn cam là "Trước nhập viện" / "Cấp cứu, trước vào khoa".
   - **Dòng không gắn vào đợt**: tối đa 3 dòng của cùng người bệnh, trong vòng 7 ngày quanh đợt nhưng không được gắn.
     Kiểm xem đúng là không thuộc đợt này không.
3. Bấm **Đúng**, **Sai** hoặc **Không chắc**. Mỗi lần bấm được lưu ngay; khi chọn Sai, ghi chú EMR ghi gì (tự lưu khi rời ô).
4. Bảng **Tỉ lệ đạt cộng dồn** cho từng loại dữ liệu: tỉ lệ = Đúng / (Đúng + Sai), kèm khoảng tin cậy 95% (Wilson).
   Khoảng tin cậy còn rộng nghĩa là cần kiểm thêm ca. "Không chắc" không tính vào tỉ lệ.
5. **Các mục sai** liệt kê kèm ghi chú để sửa quy tắc ghép; bấm vào để mở lại ca đó.

Kết quả lưu ở `audit/reviews.json` trong thư mục đợt kho. Cần cùng quyền với Tra cứu người bệnh (supervisor/admin và
`EMR_ALLOW_IDENTIFIED_RESEARCH_EXPORT=1`), vì màn này hiện Mã BN và họ tên để đối chiếu.

## Lệnh normalize an toàn cho một run cụ thể

```powershell
node -e "const s=require('./server/research/normalize_safe'); const r=s.normalizeRunOutputsSafe('.\\.runtime\\research\\research_store\\du_lieu_goc\\runs\\<RUN_ID>',{sourceRunId:'<RUN_ID>',force:true}); console.log(JSON.stringify(r,null,2))"
```

Không dùng lệnh gọi trực tiếp `require('./server/research/normalize').normalizeRunOutputs(...)` cho vận hành dữ liệu nghiên cứu.
