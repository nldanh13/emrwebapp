# EMR Dashboard

Web app điều phối dữ liệu giường bệnh, y lệnh và tự động nhập EMR cho khoa nội trú. Giao diện React đọc/ghi qua một server Express; các thao tác cần thao túng EMR thật (không có API công khai) chạy bằng worker Python/Selenium ở phía sau.

## Kiến trúc tổng quan

```text
Browser (React/Vite)
   │  REST /api/*
   ▼
server.js (Express)
   ├─ server/routes/*        → route nghiệp vụ (board, patients, clinic, hchanh, report, workflows, ...)
   ├─ server/middleware/*    → auth, feature gate, security headers
   ├─ server/services/*      → task queue, artifact store, workflow planner/runner, audit, session
   └─ worker/*.py            → Selenium/HTTP đọc-ghi EMR thật, sinh báo cáo PDF, xử lý dữ liệu
```

Ứng dụng được chia thành các module (feature) độc lập, khai báo trong `config/feature_registry.json` và điều phối qua feature gate + workflow planner/runner. Một module bị tắt hoặc lỗi chỉ ảnh hưởng chính module đó và các bước phụ thuộc trực tiếp — xem chi tiết ở [`docs/FEATURE_MODULE_ARCHITECTURE.md`](docs/FEATURE_MODULE_ARCHITECTURE.md).

### Thư mục chính

| Thư mục | Nội dung |
| --- | --- |
| `src/` | Giao diện React (components theo màn hình: bedboard, nurse, patient, records, report, shift, hchanh, adminWorkflow...) |
| `server/` | API Express: routes, middleware, services (task queue, workflow, audit, session) |
| `worker/` | Script Python chạy Selenium/HTTP để đọc/ghi EMR thật và sinh báo cáo |
| `config/` | Cấu hình runtime: đăng nhập EMR, feature registry, quy tắc nghiệp vụ, danh mục VTYT |
| `database/` | Schema PostgreSQL đích (tùy chọn, xem `database/README.md`) |
| `scripts/` | Script vận hành: build/release, health check, migrate, dọn dữ liệu, test tích hợp |
| `docs/` | Tài liệu kiến trúc, bảo mật & vận hành, changelog |
| `research/` | Công cụ hỗ trợ nghiên cứu/khai thác dữ liệu (SQLite store, xem `research/README_SQLITE.md`) |
| `tests/` | Test Python (pytest) |

## Chạy dự án

Yêu cầu Node.js ≥ 20.19, Python 3 (cho worker), Chrome + ChromeDriver (Selenium ≥ 4.6 có thể tự quản lý driver).

```bash
npm install
pip install -r requirements.txt
cp config/config.example.json config/config.json   # điền tài khoản/thông tin EMR thật, không commit file này
```

Chạy dev (UI + API riêng, có hot reload):

```bash
npm run dev
# UI:  http://localhost:5173
# API: http://localhost:3001
```

Chạy production-style (build UI rồi phục vụ qua Express):

```bash
npm start
# → http://localhost:3001
```

## Script hữu ích

| Lệnh | Mục đích |
| --- | --- |
| `npm run test` | Test Python (pytest) |
| `npm run test:ui` | Test UI (vitest) |
| `npm run test:ci` | Toàn bộ pipeline kiểm tra trước khi merge (pytest, syntax worker, lint, vitest, smoke test workflow...) |
| `npm run check` | Health check runtime |
| `npm run db:migrate` | Chạy migration PostgreSQL (tùy chọn, xem `database/README.md`) |
| `npm run archive:audit` | Kiểm tra bảo mật kho archive session |

Chạy đầy đủ trước khi mở PR:

```bash
npm run test:ci
npm run build
```

## Cấu hình & bảo mật

- Không commit `config/config.json`, mật khẩu hay token — dùng biến môi trường/file secret (`EMR_PASSWORD_FILE`, `EMR_USERS_FILE`, ...).
- Hệ thống thiết kế cho mạng nội bộ có kiểm soát, không public trực tiếp ra Internet.
- Export dữ liệu nghiên cứu mặc định ẩn danh; export có định danh yêu cầu vai trò `supervisor`/`admin` và cờ môi trường riêng.
- Chi tiết đầy đủ: [`docs/SECURITY_AND_OPERATIONS.md`](docs/SECURITY_AND_OPERATIONS.md).

## Tài liệu khác

- [`docs/FEATURE_MODULE_ARCHITECTURE.md`](docs/FEATURE_MODULE_ARCHITECTURE.md) — module hóa, feature gate, workflow planner/runner, cách thêm module mới.
- [`docs/PARALLEL_CARE_INFUSION.md`](docs/PARALLEL_CARE_INFUSION.md) — chạy song song hai tài khoản EMR (chăm sóc + dịch truyền).
- [`docs/SECURITY_AND_OPERATIONS.md`](docs/SECURITY_AND_OPERATIONS.md) — bảo mật, secret, retention, backup, khôi phục sự cố.
- [`docs/CHANGELOG_2.3.0.md`](docs/CHANGELOG_2.3.0.md) — thay đổi phiên bản gần nhất.
- [`docs/BHYT_PRE_AUDIT.md`](docs/BHYT_PRE_AUDIT.md) — tiền giám định BHYT trước khi nộp hồ sơ (rule engine, thang mức độ, Tầng 1 đã cài đặt).
- [`database/README.md`](database/README.md) — schema PostgreSQL đích (tùy chọn).
- [`research/README_SQLITE.md`](research/README_SQLITE.md) — công cụ nghiên cứu dữ liệu.
