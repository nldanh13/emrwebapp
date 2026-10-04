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

**Biện pháp hiện tại:** `collection_integrity.json` tách `ok_zero_unverified` khỏi `verified_empty`; tuyệt đối không dùng `ok + 0` làm bằng chứng “không phẫu thuật”. Các ca này phải được xác minh/thu thập lại trước khi dùng kết luận âm tính.

> Việc tối ưu worker để luôn mở/xác minh D/s Phẫu thuật trong research mode là bước acquisition cần duy trì: nếu chưa có `verified_lookup/verified_empty`, ca zero-row vẫn là **unverified**, không phải negative.

### 6. Dùng run lịch sử/stale và normalize khi thu thập chưa xong

Một file chuẩn hóa có timestamp mới không chứng minh raw đã đầy đủ. Archive run cũng không nên được chọn chỉ vì mtime.

**Biện pháp:** luôn ghi/kiểm tra run id; chỉ dùng archive khi người dùng chủ động chọn. `collection_integrity.json` ghi các trạng thái surgery pending/error và raw/normalized counts.

### 7. Diagnostic/linkage quá rộng

Ghép theo mã BN hoặc chẩn đoán có thể kéo PT từ đợt khác.

**Biện pháp:** ưu tiên encounter đã xác lập + admission/discharge window; fallback chỉ khi có mốc ngày PT nằm trong đúng đợt và kết quả là duy nhất. Không tự ép 8 ca `ENCOUNTER_UNRESOLVED`.

## SOP chuẩn từ nay

### A. Thu thập

- Lưu run id ngay từ đầu.
- Lấy đủ các file được yêu cầu cho từng ca.
- Surgery zero-row chỉ được coi là âm tính khi worker đã thực sự kiểm tra màn hình surgery và lưu bằng chứng `verified_lookup/verified_empty`.
- Không điền “Không” từ sự vắng mặt của raw.

### B. Preflight

Chạy normalize qua queue/UI hoặc `normalize_safe.js`. Preflight sẽ:

1. backup raw trước repair;
2. repair legacy surgery từ bằng chứng explicit;
3. ghi audit;
4. tạo `collection_integrity.json`.

Các mã cần xử lý:

- `SURGERY_COLLECTION_INCOMPLETE`: blocking;
- `SURGERY_RAW_JSON_INVALID`: blocking;
- `SURGERY_ZERO_UNVERIFIED`: chưa được coi là âm tính;
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

Chỉ chốt sau khi xem cả QA chuẩn hóa và `collection_integrity.json`. Mọi unresolved còn lại phải có lý do rõ ràng và được giữ trong audit/unresolved output.

## Lệnh normalize an toàn cho một run cụ thể

```powershell
node -e "const s=require('./server/research/normalize_safe'); const r=s.normalizeRunOutputsSafe('.\\.runtime\\research\\research_store\\du_lieu_goc\\runs\\<RUN_ID>',{sourceRunId:'<RUN_ID>',force:true}); console.log(JSON.stringify(r,null,2))"
```

Không dùng lệnh gọi trực tiếp `require('./server/research/normalize').normalizeRunOutputs(...)` cho vận hành dữ liệu nghiên cứu.
