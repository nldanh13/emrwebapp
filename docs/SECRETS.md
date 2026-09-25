# Quản lý mật khẩu, token và khóa (secrets)

Mọi bí mật của hệ thống nằm ở **một thư mục duy nhất: `secrets/`** ở gốc repo. Thư mục này đã có trong `.gitignore` và bị loại khỏi gói release (`npm run package:clean`), nên không bao giờ bị commit hay đóng gói nhầm.

```text
secrets/
├── secrets.json              ← mật khẩu EMR (chung / hành chánh / dịch truyền), token app, salt, API key
├── users.json                ← tài khoản đăng nhập app (token từng người + tài khoản EMR riêng)
├── nurse_emr_accounts.json   ← tài khoản EMR theo tên điều dưỡng trong lịch trực
└── backup/<thời điểm>/       ← bản sao file cũ do `secrets:migrate` tạo (vẫn chứa mật khẩu)
```

Các phần còn lại trong `config/` (URL, lịch điều dưỡng, quy tắc nghiệp vụ...) **không chứa mật khẩu**, nên có thể chia sẻ khi cần hỗ trợ.

## Thiết kế

| Thành phần | Vai trò |
| --- | --- |
| `config/secrets_manifest.json` | Danh mục **mọi** bí mật: khóa, vị trí trong `secrets.json`, biến môi trường ghi đè, mô tả. Không chứa giá trị. |
| `server/services/secret_store.js` | Nơi duy nhất server Node đọc bí mật. |
| `worker/shared/secret_store.py` | Nơi duy nhất worker Python đọc bí mật. Có test bảo đảm cho cùng kết quả với bản Node. |
| `config/secrets.example.json` | Mẫu `secrets/secrets.json` (để trống). |
| `scripts/secrets_tool.js` | Lệnh kiểm tra, chuyển đổi, quét repo (xem bên dưới). |

Mỗi bí mật được tìm theo thứ tự (cao → thấp):

1. **Biến môi trường**, ví dụ `EMR_PASSWORD`. Server dùng cách này để truyền tài khoản EMR riêng của người đang thao tác xuống worker, nên biến môi trường luôn được ưu tiên.
2. **File chứa giá trị** qua `<TÊN_BIẾN>_FILE`, ví dụ `EMR_PASSWORD_FILE=/run/secrets/emr_pw`. Cách này hợp với Docker/secret store của hệ điều hành.
3. **`secrets/secrets.json`**: cách khuyến nghị cho máy chạy tại khoa.
4. *(Chỉ tài khoản EMR)* `config/config.json`, vị trí cũ. Vẫn đọc được để máy đang chạy không bị gãy, nhưng `secrets:check` sẽ cảnh báo. Đặt `EMR_REQUIRE_SECRET_ENV=1` thì vị trí cũ bị chặn hẳn.

Với `users.json` và `nurse_emr_accounts.json`: dùng `EMR_USERS_FILE` / `EMR_NURSE_ACCOUNTS_FILE` nếu có đặt. Nếu không, app dùng `secrets/<tên file>`. Máy chưa chuyển thì app vẫn đọc `config/<tên file>` cũ.

## Danh mục bí mật

| Khóa trong `secrets.json` | Biến môi trường | Dùng cho |
| --- | --- | --- |
| `emr.username`, `emr.password` | `EMR_USERNAME`, `EMR_PASSWORD` | Tài khoản EMR chung (quét, lấy dữ liệu, nhập khi người dùng chưa có tài khoản riêng) — **bắt buộc** |
| `hchanh.username`, `hchanh.password` | `EMR_HCHANH_USERNAME`, `EMR_HCHANH_PASSWORD` | Module Hành chánh / Kiểm hồ sơ — bắt buộc nếu dùng module này |
| `infusion.username`, `infusion.password` | `EMR_INFUSION_USERNAME`, `EMR_INFUSION_PASSWORD` | Dịch truyền chạy song song (tùy chọn, xem `PARALLEL_CARE_INFUSION.md`) |
| `app.token` | `EMR_APP_TOKEN` | Token chung khi mở app ra LAN mà không dùng `users.json` |
| `app.log_hash_salt` | `EMR_LOG_HASH_SALT` | Salt băm định danh trong nhật ký hoạt động |
| `google_sheet.write_token` | `EMR_GOOGLE_SHEET_WRITE_TOKEN` | Ghi Google Sheet nộp hồ sơ |
| `database.url` | `DATABASE_URL` | PostgreSQL (tùy chọn) |
| `anthropic.api_key` | `ANTHROPIC_API_KEY` | Bộ đọc y lệnh dịch truyền bằng LLM (tùy chọn) |

## Lệnh

```bash
npm run secrets:check            # bí mật nào đã có, lấy từ đâu, cảnh báo mật khẩu yếu/vị trí cũ/quyền file
npm run secrets:migrate          # XEM TRƯỚC việc gom bí mật cũ về secrets/ (không đổi gì)
npm run secrets:migrate:apply    # thực hiện
npm run secrets:scan             # quét file đang commit xem có mật khẩu/token thật không (CI chạy lệnh này)
```

`secrets:check` và các lệnh khác không bao giờ in giá trị bí mật ra màn hình.

### Chuyển máy đang chạy sang `secrets/` (làm một lần)

1. Dừng server.
2. Chạy `npm run secrets:migrate` và đọc danh sách sẽ chuyển.
3. Chạy `npm run secrets:migrate:apply`. Lệnh này sẽ:
   - chuyển `username/password`, `hchanh_*`, `infusion_*` từ `config/config.json` sang `secrets/secrets.json`, sau đó để trống ở `config.json`;
   - chuyển `EMR_APP_TOKEN`, `EMR_GOOGLE_SHEET_WRITE_TOKEN`... từ `.env` sang `secrets/secrets.json` và comment dòng cũ trong `.env`;
   - chuyển `config/users.json` và `config/nurse_emr_accounts.json` vào `secrets/`;
   - lưu bản sao file cũ vào `secrets/backup/<thời điểm>/`;
   - nếu cùng một khóa có ở cả hai nơi mà giá trị khác nhau, **giữ nguyên cả hai** và báo để bạn tự quyết định.
4. Khởi động lại server rồi chạy `npm run secrets:check`.
5. Khi mọi thứ chạy ổn, xóa `secrets/backup/`.

### Máy mới

```bash
npm run secrets:migrate:apply    # tạo secrets/secrets.json từ mẫu
# rồi mở secrets/secrets.json và điền emr.username / emr.password (và hchanh.* nếu dùng Hành chánh)
```

## Quy tắc

- **Không** thêm `process.env.XXX_TOKEN` hay `os.environ["XXX_PASSWORD"]` mới rải rác trong code. Muốn thêm bí mật mới: khai trong `config/secrets_manifest.json` và `config/secrets.example.json`, rồi đọc bằng `getSecret('<key>')` (Node) hoặc `get_secret("<key>")` (Python).
- **Không** viết mật khẩu mặc định trong code. Nếu thiếu bí mật thì báo lỗi rõ ràng, chỉ ra nơi cần điền.
- File mẫu (`*.example.json`) chỉ để trống hoặc dùng placeholder `replace-with-...`. CI (`secrets:scan`) sẽ báo lỗi nếu có giá trị thật.
- Backup `secrets/` riêng, mã hóa, và không gửi kèm khi cần hỗ trợ (dùng `npm run debug:bundle`).
- Khi nhân sự nghỉ hoặc khi nghi ngờ bị lộ: đổi mật khẩu trên EMR trước, sau đó cập nhật `secrets/`.
