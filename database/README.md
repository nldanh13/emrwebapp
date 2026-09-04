# PostgreSQL foundation

Hệ thống vẫn chạy bằng JSON để tương thích. Thư mục này cung cấp schema đích cho quá trình chuyển đổi `Patient → Encounter → PatientDay` và lưu tác vụ/audit bền vững.

## Khởi tạo

```bash
export DATABASE_URL='postgresql://user:password@127.0.0.1:5432/emr_dashboard'
npm run db:migrate
```

Máy chạy migration cần có `psql`. Migration không tự sao chép dữ liệu bệnh nhân cũ; cần chạy quy trình đối chiếu trước khi đổi nguồn đọc chính.

## Chính sách

- Không lưu mật khẩu EMR, cookie Selenium hoặc access token trong database nghiệp vụ.
- `audit_events` là bảng append-only.
- Khóa ngày chuẩn là `encounter_day_key`, không chỉ `patient_id + date`.
- PDF/HTML lớn nằm trong kho file được bảo vệ; bảng `attachments` chỉ giữ metadata và SHA-256.
- Dữ liệu nghiên cứu có định danh phải có audit và quyền supervisor/admin.
