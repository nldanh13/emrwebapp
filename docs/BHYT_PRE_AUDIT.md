# Tiền giám định BHYT trước khi nộp hồ sơ

## Mục tiêu

Không để hệ thống tự kết luận "xuất toán". Với mỗi hồ sơ ra viện, hệ thống trả về:

- **Đánh giá BHYT**: An toàn / Cần kiểm tra / Nguy cơ cao / Không nên nộp / Không đủ dữ liệu để đánh giá.
- **Giá trị dịch vụ liên quan cảnh báo** ("số tiền có nguy cơ") — không phải số tiền chắc chắn bị từ chối thanh toán.
- **Danh sách việc cần kiểm** kèm hành động đề xuất và nguồn pháp lý (khi có).

Module này **gộp chung vào tab Hành chánh hiện có** (không phải tab/route riêng): kết quả nằm trong `qa.bhyt` của cùng API `/api/hchanh/dashboard` và `/api/hchanh/patient/:ma_bn` mà QA hành chánh (`discharge_qa.js`) đang trả về, chỉ áp dụng cho `scope = discharge`.

## Vị trí trong code

| Thành phần | File |
| --- | --- |
| Rule engine + Tầng 1, 2, 3 | `server/services/hchanh/bhyt_pre_audit.js` |
| Tiện ích ngày/giờ dùng chung | `server/services/hchanh/vn_datetime.js` (tách ra từ `discharge_qa.js` để tránh phụ thuộc vòng) |
| Metadata rule (nguồn pháp lý, hành động) | `config/hchanh/bhyt_pre_audit_rules.json` |
| Bảng đối chiếu Chẩn đoán ↔ PT/TT (Tầng 3) | `config/hchanh/bhyt_dx_procedure_map.json` |
| Nơi gọi vào | `server/services/hchanh/discharge_qa.js` → `runDischargeQA_Hchanh()` gắn kết quả vào `qa.bhyt` |
| Hiển thị | `src/components/hchanh/HchahnTab.jsx` → `BhytAssessmentBox` (trong `DetailPanel`, ngay dưới khối QA hành chánh) |
| Test | `scripts/bhyt_pre_audit_test.js` (chạy trong `npm run test:ci`) |

## Nguyên tắc thiết kế

- **Rule pháp lý (`BHYT_RULE`) và checklist chuyên môn nội bộ là hai lớp khác nhau.** Tầng 1 hiện tại chỉ chứa rule pháp lý (tính toàn vẹn dữ liệu bắt buộc để nộp hồ sơ hợp lệ). Checklist chứng minh chỉ định (XQ, biên bản PT...) thuộc một lớp khác, chưa cài trong bản này — xem mục "Việc chưa làm" bên dưới.
- **Không suy đoán khi thiếu dữ liệu ổn định.** Ví dụ: nếu EMR không đọc được `bhyt_tu_ngay`/`bhyt_den_ngay`, hệ thống không tự đỏ — chỉ bỏ qua rule liên quan đến hạn thẻ.
- **Rule cấu hình qua JSON, không hard-code trong code.** `config/hchanh/bhyt_pre_audit_rules.json` giữ `legal_source`, `legal_clause`, `action` cho từng `rule_id`. Cập nhật văn bản pháp luật chỉ cần sửa file này.
- **Không cộng điểm.** Trạng thái tổng = mức độ nặng nhất trong các finding (rule severity + override), theo đúng logic đề xuất gốc (mục 15 trong đề xuất thiết kế).
- **"Số tiền có nguy cơ" lấy giá trị lớn nhất trong các finding, không cộng dồn** — tránh tính trùng khi nhiều finding cùng quy về một khoản BHYT của đợt điều trị.

## Thang mức độ (`BHYT_SEVERITY`)

```text
INFO < WARNING < REVIEW < HIGH_RISK < BLOCK
```

Ánh xạ sang đánh giá tổng (`ASSESSMENT`):

```text
BLOCK ở bất kỳ finding nào      → "Không nên nộp"   (đỏ)
HIGH_RISK là mức nặng nhất      → "Nguy cơ cao"      (cam)
REVIEW/WARNING là mức nặng nhất → "Cần kiểm tra"     (vàng)
Không có finding nào            → "An toàn"          (xanh)
Thiếu profile/discharge         → "Không đủ dữ liệu để đánh giá" (xám)
```

## Tầng 1 — Tính toàn vẹn dữ liệu (đã cài đặt)

Chỉ dùng các trường đã xác nhận có thật trong dữ liệu hành chánh hiện tại (không suy đoán trường chưa tồn tại):

| Rule ID | Điều kiện | Mức độ |
| --- | --- | --- |
| `BHYT_T1_DISCHARGE_BEFORE_ADMISSION` | Ngày ra viện < ngày vào viện | BLOCK |
| `BHYT_T1_BHYT_CODE_MISSING` | Không tự túc nhưng chưa có `bhyt_code` | REVIEW |
| `BHYT_T1_CARD_EXPIRED_BEFORE_DISCHARGE` | `bhyt_den_ngay` < ngày ra viện | BLOCK |
| `BHYT_T1_CARD_NOT_YET_VALID_AT_ADMISSION` | `bhyt_tu_ngay` > ngày vào viện | BLOCK |
| `BHYT_T1_SERVICE_DATE_BEFORE_ADMISSION` | Có dòng bảng kê (`tg_ylenh`) trước ngày vào viện | BLOCK |
| `BHYT_T1_SERVICE_DATE_AFTER_DISCHARGE` | Có dòng bảng kê sau ngày ra viện | BLOCK |
| `BHYT_T1_PRIMARY_DIAGNOSIS_MISSING` | Không có chẩn đoán chính ra viện | BLOCK |
| `BHYT_T1_SURGERY_DATE_MISSING` | Có PT/TT nhưng không xác định được ngày thực hiện | BLOCK |
| `BHYT_T1_BENEFIT_LEVEL_INCONSISTENT` | Nhiều `muc_huong` khác nhau giữa các dòng BHYT cùng đợt | REVIEW |

Rule "mức hưởng bảng kê khác quyền lợi thẻ" trong đề xuất gốc **chưa cài đặt** vì dữ liệu hiện có chỉ đọc được `muc_huong` áp dụng trên từng dòng bảng kê, không có trường quyền lợi thẻ (mức hưởng khai báo) tách biệt để đối chiếu — tránh suy đoán khi chưa có nguồn dữ liệu ổn định.

## Tầng 2 — Ngày giường (đã cài đặt)

**Không tính lại ngày giường từ đầu.** Tầng này nhận `bedDaysReview` — kết quả `buildBedDaysReview()` mà `discharge_qa.js` đã tính sẵn (dùng chung cho cả QA hành chánh và BHYT) — qua tham số, để tránh hai nơi tính ra hai con số khác nhau cho cùng một hồ sơ. `runDischargeQA_Hchanh()` truyền `bedDaysReview` này vào `runBhytPreAudit()`.

| Rule ID | Điều kiện | Mức độ |
| --- | --- | --- |
| `BHYT_T2_SHORT_STAY_BED_CHARGED` | Thời gian nằm viện thực (giờ) ≤ 4 giờ nhưng `bed_days.so_ngay_tinh` > 0 | HIGH_RISK |
| `BHYT_T2_BED_DAYS_OVER_EXPECTED` | `bedDaysReview.status === 'mismatch'` và `actual_total > expected_total` (tính THỪA so với thời gian điều trị) | HIGH_RISK |

Hai điểm cố ý loại trừ để tránh báo sai:

- **Chỉ báo hướng tính THỪA**, không báo hướng tính THIẾU (`actual_total < expected_total`) — thiếu ngày là vấn đề hoàn thiện hồ sơ/doanh thu bệnh viện, không phải nguy cơ bị BHYT từ chối thanh toán; hướng này đã có `BED_DAYS_NEEDS_ADJUSTMENT`/`BED_DAYS_SHORT` riêng trong QA hành chánh.
- **Bỏ qua trường hợp 4–24 giờ** khi `expected_total === 0 && actual_total === 1`: một số hướng dẫn cho phép tính 1 ngày giường cho ca vào/ra trong cùng ngày nằm trên 4 giờ, dù công thức ngày lịch chung (ra − vào) ra 0 — nếu không loại trừ sẽ báo nhầm nguy cơ cho đúng trường hợp được phép.

`amount_at_risk` của `BHYT_T2_BED_DAYS_OVER_EXPECTED` lấy từ `bedDaysReview.amount.diff` đã tính sẵn (chỉ khi dương); nếu chưa tính được giá tiền, finding vẫn xuất hiện với `amount_at_risk = 0` — không suy đoán giá.

## Tầng 3 — Chẩn đoán ↔ PT/TT (đã cài đặt)

Dùng 3 mức COMPATIBLE / REVIEW / INCOMPATIBLE thay vì quy định cứng "chẩn đoán X chỉ được PT Y", đúng nguyên tắc mục 6 của đề xuất gốc. Bảng đối chiếu PT/TT ↔ mã ICD nằm trong **`config/hchanh/bhyt_dx_procedure_map.json`** — sửa/thêm PT/TT ở đây, không sửa code.

**Chỉ khai báo PT/TT đã có mã ICD cụ thể trong đề xuất thiết kế gốc** (thay khớp háng, tháo phương tiện kết hợp xương) — không tự suy đoán mã ICD cho PT/TT khác khi chưa có nguồn xác nhận chuyên môn. PT/TT chưa có trong bảng đối chiếu thì Tầng 3 bỏ qua, không đánh giá.

| Rule ID | Điều kiện | Mức độ |
| --- | --- | --- |
| `BHYT_T3_DX_PROCEDURE_INCOMPATIBLE` | PT khớp `match_keywords` của một mục trong `procedures[]`, và mã ICD chẩn đoán chính (`discharge.chan_doan_chinh_icd`) khớp `incompatible_icd_prefixes` | HIGH_RISK |
| `BHYT_T3_DX_PROCEDURE_NEEDS_REVIEW` | PT khớp một mục, ICD không khớp cả `compatible_icd_prefixes` lẫn `incompatible_icd_prefixes` (chưa rõ nhóm) | REVIEW |
| `BHYT_T3_IMPLANT_REMOVAL_NEEDS_EVIDENCE` | PT khớp `implant_removal.match_keywords` (tháo PTKHX/rút đinh/nẹp vít...) và **không** có chẩn đoán Z47.0 lẫn dòng bảng kê chứa từ khóa X-quang | HIGH_RISK |

Nếu `discharge.chan_doan_chinh_icd` rỗng (chưa tách được mã ICD từ chẩn đoán chính — trường này do worker tự regex ra, không phải lúc nào cũng có), Tầng 3 **bỏ qua hoàn toàn**, không suy đoán ICD từ text tự do.

Ví dụ khớp đúng đề xuất gốc (mục 5–6, ca "Danh Tân"): chỉ định tháo PTKHX với chẩn đoán "gãy xương" chung chung, chưa có XQ liền xương trong dữ liệu → `BHYT_T3_IMPLANT_REMOVAL_NEEDS_EVIDENCE` (🟠 Nguy cơ cao) thay vì tự động đỏ.

## Việc chưa làm (Tầng 4–8, theo đề xuất thiết kế gốc)

Khung (`makeFinding`, `BHYT_SEVERITY`, `ASSESSMENT`, rule config JSON) đã sẵn sàng để mở rộng thêm mà không đổi cấu trúc:

- Tầng 4 — CLS chứng minh chỉ định (`PROCEDURE_EXPECTED_EVIDENCE`).
- Tầng 5 — VTYT (7 cửa kiểm theo đề xuất: mã hợp lệ, trong danh mục, hiệu lực, phạm vi BHYT, trần thanh toán, số lượng khớp biên bản PT, tránh trùng giá DVKT).
- Tầng 6 — Thuốc.
- Tầng 7 — Trùng dịch vụ / người thực hiện / phạm vi hành nghề.
- Tầng 8 — Tính tiền BHYT theo mức hưởng + rule "trong gói".

Thêm tầng mới: viết hàm `checkXxx()` thuần trong `bhyt_pre_audit.js` (hoặc file riêng nếu tầng phức tạp), gọi trong `runBhytTier{N}()`, khai báo metadata rule trong `bhyt_pre_audit_rules.json`, rồi gộp vào `runBhytPreAudit()`. Không cần đổi UI hay điểm gọi trong `discharge_qa.js`.
