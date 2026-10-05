# Tài khoản EMR khi nhập liệu (chăm sóc, dịch truyền, thủ thuật, VTYT)

## Quy tắc

- **Nhập liệu** (ghi vào EMR) đăng nhập bằng tài khoản EMR của **điều dưỡng ca làm theo Lịch
  điều dưỡng** của ngày đang nhập. Tài khoản lấy từ Thiết lập tài khoản
  (`secrets/nurse_emr_accounts.json`, xem `SECRETS.md`).
  - Chăm sóc: người ca làm nhập hết phiếu của ngày, kể cả phiếu giờ trực. Phiếu giờ trực:
    Hoàn tất → Thu hồi → đổi Người lập sang người trực → Hoàn tất, tất cả **bằng tài khoản ca làm**.
    Các bước này theo đúng macro người dùng ghi lại; không đăng nhập tài khoản người trực.
  - Nhập nhiều ngày: người bệnh/phiếu được xếp theo ngày. Mỗi ngày đổi sang tài khoản ca làm
    của ngày đó, và chỉ đổi khi khác tài khoản đang dùng.
  - Dịch truyền nhập theo từng người bệnh. Nếu một người bệnh có nhiều ngày với người ca làm khác
    nhau, cả lượt dùng tài khoản ca làm của ngày đầu tiên và có cảnh báo trong log tác vụ.
- Người ca làm **chưa có tài khoản EMR** hoặc ngày đó **chưa xếp lịch**: dùng tài khoản mặc định
  và ghi cảnh báo `[WARN] Ngày dd/mm/yyyy: …` trong log tác vụ.
  - Tài khoản mặc định là tài khoản EMR riêng của người đang đăng nhập Data Hub, nếu có.
  - Không có thì dùng tài khoản chung `emr.*`.
- **Quét, lấy dữ liệu, xem trước** (không ghi vào EMR) vẫn dùng tài khoản mặc định.

Mã nguồn chính:

- `worker/nurse_emr_accounts.py`: `resolve_entry_account` và `EntryAccountResolver`.
- `worker/shared/worker_session.py`: `WorkerSession.use_entry_account`.
- Test: `tests/test_entry_account_schedule.py`.

## Không còn chạy song song chăm sóc và dịch truyền

Trước đây dịch truyền dùng tài khoản riêng (`infusion.*` / `EMR_INFUSION_USERNAME`) để chạy song song
với chăm sóc. Nay mọi tác vụ nhập đều dùng tài khoản ca làm theo lịch. Vì vậy chúng chạy **lần lượt**
trên cùng một làn `accountKey = 'default'` của `server/services/task_queue.js`, để không mở hai phiên
cùng một tài khoản. Cấu hình `infusion.*` cũ không còn được dùng khi nhập dịch truyền.

`task_queue.js` vẫn hỗ trợ làn theo `accountKey` (`scripts/task_queue_account_lane_test.js`): hai
tác vụ cùng `accountKey` không bao giờ chạy chồng lên nhau.
