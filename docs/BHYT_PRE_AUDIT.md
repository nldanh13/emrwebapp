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
| Rule engine + Tầng 1 | `server/services/hchanh/bhyt_pre_audit.js` |
| Tiện ích ngày/giờ dùng chung | `server/services/hchanh/vn_datetime.js` (tách ra từ `discharge_qa.js` để tránh phụ thuộc vòng) |
| Metadata rule (nguồn pháp lý, hành động) | `config/hchanh/bhyt_pre_audit_rules.json` |
| Nơi gọi vào | `server/services/hchanh/discharge_qa.js` → `runDischargeQA_Hchanh()` gắn kết quả vào `qa.bhyt` |
| Hiển thị | `src/components/hchanh/HchahnTab.jsx` → `BhytAssessmentBox` (trong `DetailPanel`, ngay dưới khối QA hành chánh) |
| Test | `scripts/bhyt_pre_audit_tier1_test.js` (chạy trong `npm run test:ci`) |

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

## Việc chưa làm (Tầng 2–8, theo đề xuất thiết kế gốc)

Khung (`makeFinding`, `BHYT_SEVERITY`, `ASSESSMENT`, rule config JSON) đã sẵn sàng để mở rộng thêm mà không đổi cấu trúc:

- Tầng 2 — Ngày giường (đã có logic tương tự trong `checkBedDays`/`buildBedDaysReview` của `discharge_qa.js`; cần đánh giá có tái dùng hay tách riêng cho BHYT).
- Tầng 3 — Chẩn đoán ↔ PT/TT (3 mức COMPATIBLE/REVIEW/INCOMPATIBLE).
- Tầng 4 — CLS chứng minh chỉ định (`PROCEDURE_EXPECTED_EVIDENCE`).
- Tầng 5 — VTYT (7 cửa kiểm theo đề xuất: mã hợp lệ, trong danh mục, hiệu lực, phạm vi BHYT, trần thanh toán, số lượng khớp biên bản PT, tránh trùng giá DVKT).
- Tầng 6 — Thuốc.
- Tầng 7 — Trùng dịch vụ / người thực hiện / phạm vi hành nghề.
- Tầng 8 — Tính tiền BHYT theo mức hưởng + rule "trong gói".

Thêm tầng mới: viết hàm `checkXxx()` thuần trong `bhyt_pre_audit.js` (hoặc file riêng nếu tầng phức tạp), gọi trong `runBhytTier{N}()`, khai báo metadata rule trong `bhyt_pre_audit_rules.json`, rồi gộp vào `runBhytPreAudit()`. Không cần đổi UI hay điểm gọi trong `discharge_qa.js`.
