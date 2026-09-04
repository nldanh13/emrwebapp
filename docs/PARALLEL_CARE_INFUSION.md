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

## Vì sao an toàn khi chạy song song

`server/services/task_queue.js` gắn mỗi tác vụ nặng với một `accountKey`
(tài khoản EMR mà tác vụ đó đăng nhập). Hai tác vụ dùng CHUNG một `accountKey`
không bao giờ chạy Selenium/HTTP session cùng lúc, bất kể `MAX_HEAVY_JOBS` là
bao nhiêu — chỉ những tác vụ dùng accountKey KHÁC NHAU (ví dụ `default` cho
chăm sóc/hành chánh và `infusion` cho dịch truyền) mới thật sự chạy song song.
Vì vậy nếu bạn KHÔNG cấu hình `infusion_username`/`infusion_password`, dịch
truyền tự động dùng lại tài khoản chính và vẫn chạy tuần tự với các tác vụ
khác như trước — tăng `MAX_HEAVY_JOBS` một mình không làm hai tác vụ cùng
tài khoản chạy song song.
