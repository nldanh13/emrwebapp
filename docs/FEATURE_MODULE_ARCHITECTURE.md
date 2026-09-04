# Kiến trúc module và workflow độc lập

## Mục tiêu

Ứng dụng được chia thành ba lớp độc lập:

```text
Feature registry
  → Feature gate + dependency planner
    → Route/worker nghiệp vụ hiện có
```

Một chức năng bị tắt hoặc lỗi chỉ ảnh hưởng chính chức năng đó và các bước phụ thuộc trực tiếp. Những nhánh không phụ thuộc vẫn tiếp tục chạy.

Ví dụ trong quy trình nhập bệnh phòng:

```text
care.input       skipped/failed
infusion.input   vẫn chạy
procedure.input  vẫn chạy
input.verify     chạy nếu có ít nhất một kết quả nhập
```

## Thành phần

### 1. Registry

Cấu hình gốc:

```text
config/feature_registry.json
```

Cấu hình bật/tắt tại runtime:

```text
<EMR_RUNTIME_ROOT>/config/feature_overrides.json
```

Tệp gốc mô tả cấu trúc hệ thống. Tệp runtime chỉ ghi các override được phép và không sửa mã nguồn.

Mỗi chức năng khai báo:

```json
{
  "id": "infusion.input",
  "enabled": true,
  "protected": false,
  "requires": ["infusion.precheck-token", "orders.classified"],
  "provides": ["infusion.result"],
  "failurePolicy": "continue",
  "disabledPolicy": "skip",
  "timeoutMs": 1800000,
  "retry": {
    "maxAttempts": 1,
    "delayMs": 1000,
    "retryStatuses": [429, 502, 503, 504]
  },
  "executor": {
    "type": "http",
    "method": "POST",
    "path": "/run-input-infusions",
    "inputKey": "infusionTargets",
    "payloadRequired": true
  },
  "routes": [
    {
      "method": "POST",
      "path": "/run-input-infusions",
      "action": "execute",
      "gate": true
    }
  ]
}
```

### 2. Feature gate

Tệp:

```text
server/middleware/feature_gate.js
```

Gate chạy trước route nghiệp vụ. Khi module bị tắt, route của module đó trả:

```json
{
  "status": "skipped",
  "code": "FEATURE_DISABLED",
  "feature_id": "care.input"
}
```

Các route khác không bị ảnh hưởng. Backend là lớp kiểm soát cuối, nên giao diện cũ hoặc client ngoài cũng không thể gọi module đã tắt.

### 3. Artifact store

Tệp:

```text
server/services/artifact_store.js
```

Mỗi bước khai báo đầu vào `requires` và đầu ra `provides`. Trạng thái artifact được lưu theo session tại:

```text
<session>/state/artifacts.json
```

Artifact chỉ lưu metadata và tóm tắt an toàn, không lưu token precheck hoặc bí mật xác thực. Một yêu cầu dạng:

```text
care.result|infusion.result|procedure.result
```

có nghĩa chỉ cần một trong các artifact đó tồn tại.

### 4. Workflow planner

Tệp:

```text
server/services/workflow_planner.js
```

Planner không chạy thao tác EMR. Nó chỉ xác định từng bước là:

- `ready`: đủ điều kiện chạy.
- `needs-input`: thiếu payload do người dùng cung cấp.
- `skipped`: module hoặc bước đã tắt.
- `blocked`: thiếu artifact đầu vào.

Planner cho phép xem trước ảnh hưởng trước khi thực thi.

### 5. Workflow runner

Tệp:

```text
server/services/workflow_runner.js
```

Runner gọi lại các route nghiệp vụ hiện có qua loopback `127.0.0.1`, giữ nguyên xác thực, phân quyền, validation và worker Python. Mỗi bước có retry, timeout và chính sách lỗi riêng.

Trạng thái bước:

```text
pending
running
succeeded
partial
skipped
failed
blocked
cancelled
needs-input
```

Trạng thái workflow:

- `succeeded`: mọi bước cần thiết thành công.
- `partial`: có bước bị bỏ qua, chặn hoặc lỗi nhưng vẫn có nhánh hoàn tất.
- `failed`: không có nhánh hữu ích nào hoàn tất.
- `cancelled`: người dùng yêu cầu huỷ.

Kết quả workflow được lưu theo session tại:

```text
<session>/state/workflow_runs.json
```

## Chính sách lỗi

### `continue`

Lỗi bước hiện tại được ghi nhận, các bước độc lập tiếp tục. Dùng cho các nhánh nhập chăm sóc, dịch truyền, thủ thuật, in và xuất dữ liệu.

### `stop-dependents`

Chỉ các bước phụ thuộc vào đầu ra bị chặn; nhánh khác vẫn có thể chạy. Dùng cho lấy dữ liệu, phân loại và chuẩn bị input.

### `stop-workflow`

Dừng các bước còn lại. Chỉ dùng khi thật sự không thể tiếp tục an toàn.

## Các bước bảo vệ

Feature có `protected: true` không thể bị tắt qua API runtime. Hiện gồm các chốt kiểm tra trước nhập và xác minh sau nhập. Việc tách module không tạo đường bỏ qua:

- xác thực và phân quyền;
- phạm vi session;
- precheck theo đúng loại tác vụ;
- token precheck riêng từng nhánh;
- audit;
- xác minh sau ghi;
- hàng đợi tuần tự cho Selenium cùng session.

## API quản trị module

```text
GET    /api/features
GET    /api/features/:featureId
PATCH  /api/features/:featureId/state
DELETE /api/features/:featureId/state
POST   /api/features/reload
```

Ví dụ tắt riêng nhập chăm sóc:

```json
PATCH /api/features/care.input/state
{
  "enabled": false,
  "notes": "Tạm dừng nhập chăm sóc"
}
```

Chỉ vai trò `admin` được thay đổi trạng thái module/workflow.

## API workflow

```text
GET    /api/workflows
POST   /api/workflows/:workflowId/plan
POST   /api/workflows/:workflowId/run
GET    /api/workflows/runs
GET    /api/workflows/runs/:runId
POST   /api/workflows/runs/:runId/cancel
PATCH  /api/workflows/:workflowId/state
DELETE /api/workflows/:workflowId/state
GET    /api/artifacts
```

Payload chạy workflow có thể cấp dữ liệu riêng cho từng bước:

```json
{
  "inputs": {
    "patients": [{"patient_id": "..."}],
    "dateRange": {"from": "2026-08-04", "to": "2026-08-04"},
    "careTargets": {"targets": []},
    "infusionTargets": {"targets": []},
    "procedureTargets": {"targets": []}
  },
  "skip_steps": ["care.precheck", "care.input"]
}
```

`skip_steps` chỉ bỏ qua bước tùy chọn được chọn; nó không vô hiệu hóa validation bên trong route hoặc worker.

## Quy trình nhập bệnh phòng

Workflow `ward-input` tách ba nhánh:

```text
orders.fetch
→ orders.classify
→ input.prepare
   ├─ care.precheck      → care.input
   ├─ infusion.precheck  → infusion.input
   └─ procedure.precheck → procedure.input
→ input.verify
```

Mỗi nhánh có token precheck riêng. Tắt `care.input` không làm tắt `infusion.input` hay `procedure.input`.

## Giao diện

Màn hình **Bộ chức năng** cho phép:

- xem module đang bật/tắt;
- xem dependency và artifact đầu ra;
- bật/tắt module không được bảo vệ;
- xem kế hoạch workflow trước khi chạy;
- bật/tắt workflow;
- xem số artifact theo session.

Màn hình **Nhập bệnh phòng** đọc trạng thái runtime của từng module. Nút của module bị tắt được vô hiệu hóa riêng, các nút còn lại vẫn hoạt động.

## Thêm module mới

1. Tạo route/service/worker nghiệp vụ nhỏ và độc lập.
2. Thêm feature vào `config/feature_registry.json`.
3. Khai báo chính xác `requires`, `provides`, `executor` và `routes`.
4. Chọn `failurePolicy` phù hợp.
5. Thêm feature vào workflow bằng step có `id` duy nhất.
6. Gắn trạng thái module vào màn hình tương ứng.
7. Thêm test cho bật/tắt, dependency, lỗi từng phần và quyền quản trị.
8. Chạy:

```bash
npm run test:ci
npm run build
```

## Nguyên tắc thiết kế

- Một route ghi EMR chỉ thuộc một feature thực thi chính.
- Không dùng một biến `running` toàn cục để đại diện trạng thái nghiệp vụ của mọi module.
- Không ghi bí mật hoặc token ngắn hạn vào artifact store.
- Không dùng Host header bên ngoài làm địa chỉ gọi nội bộ.
- Không chạy song song hai worker Selenium dùng cùng session.
- `skipped`, `partial`, `blocked` và `failed` phải được phân biệt rõ.
- Tắt module không đồng nghĩa xóa dữ liệu cũ của module đó.

## Tách bước lấy y lệnh và phân loại

`server/services/order_pipeline.js` chứa riêng bước phân loại. Route lấy lại y lệnh một người bệnh có thể hoàn tất độc lập:

- phân loại bật và thành công: trả `ok`;
- phân loại tắt: giữ dữ liệu vừa lấy, trả thông tin `postprocess.status = skipped`;
- phân loại lỗi: giữ dữ liệu vừa lấy, trả HTTP 207 và `status = partial`.

Trong precheck trước nhập, quy tắc chặt hơn: nếu có dữ liệu mới nhưng phân loại bị tắt/lỗi, backend không phát token nhập và khôi phục bộ dữ liệu chính để tránh raw/classified lệch nhau.
