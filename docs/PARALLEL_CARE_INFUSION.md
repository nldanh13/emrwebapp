# Chạy song song chăm sóc và dịch truyền

Ứng dụng có thể mở hai Chrome độc lập:

- Chăm sóc dùng `EMR_USERNAME` / `EMR_PASSWORD` (hoặc tài khoản chính trong `config/config.json`).
- Dịch truyền ưu tiên `EMR_INFUSION_USERNAME` / `EMR_INFUSION_PASSWORD`.

Thiết lập trên Windows PowerShell trước khi chạy:

```powershell
$env:EMR_INFUSION_USERNAME="tai_khoan_dich_truyen"
$env:EMR_INFUSION_PASSWORD="mat_khau_dich_truyen"
npm start
```

Hoặc đặt hai khóa `infusion_username`, `infusion_password` trong
`config/config.json`. File thật này đã nằm trong `.gitignore`; không đưa mật
khẩu vào `config.example.json`, mã nguồn, log hoặc ZIP chia sẻ.

`MAX_HEAVY_JOBS` mặc định là `2`. Có thể đặt lại thành `1` để quay về chế độ
tuần tự.
