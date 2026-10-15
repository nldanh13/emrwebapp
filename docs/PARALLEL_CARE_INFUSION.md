# Tài khoản EMR khi nhập liệu (chăm sóc, dịch truyền, thủ thuật, VTYT)

## Quy tắc

- **Một lượt nhập = một lần đăng nhập.** Chăm sóc, dịch truyền, thủ thuật, VTYT đăng nhập EMR **một
  lần** bằng tài khoản của **điều dưỡng ca làm theo Lịch điều dưỡng của ngày đầu tiên** trong lượt,
  rồi nhập hết cả lượt (mọi người bệnh, mọi ngày) bằng phiên đó. Tài khoản lấy từ Thiết lập tài khoản → Tài khoản EMR
  (`secrets/nurse_emr_accounts.json`, xem `SECRETS.md`). Phiên được đánh dấu `single_login`:
  `WorkerSession.switch_account` từ chối đổi tài khoản giữa chừng.
  - **Chăm sóc (ngoại lệ, 10/2026):** EMR không còn cho Thu hồi để đổi Người lập. Mỗi phiếu lập bằng
    tài khoản EMR của chính điều dưỡng phụ trách giờ đó (`worker/care_owner_accounts.py`): phiên
    chăm sóc không có `single_login`, đăng nhập lần lượt từng tài khoản (ca làm trước, ca trực sau),
    mỗi tài khoản một lần cho cả lượt. Người phụ trách chưa có tài khoản EMR thì không nhập phiếu đó,
    ghi lỗi "chưa có tài khoản EMR của … (Cài đặt → Thiết lập tài khoản)".
  - Dịch truyền, thủ thuật: tên điều dưỡng/thủ thuật viên trên phiếu vẫn theo lịch từng giờ.
- **Sửa/xóa phiếu cũ** (dọn phiếu "Mới", phiếu sai giờ, phiếu sau mổ, phiếu thủ thuật sai, dịch truyền
  thừa) làm bằng tài khoản đang dùng.
  - **Chăm sóc:** phiếu cũ đứng tên người khác với người phụ trách giờ đó thì xóa (tài khoản đang
    dùng, không được thì tài khoản người lập cũ) rồi lập lại bằng tài khoản người phụ trách. Không
    xóa được thì không tạo thêm (tránh trùng), ghi lỗi để xử lý tay.
  - **Việc khác** (thủ thuật, dịch truyền, dọn phiếu): EMR không cho thì ghi lỗi và cảnh báo
    "Giữ nguyên một phiên đăng nhập… cần xử lý tay".
- Người ca làm **chưa có tài khoản EMR** hoặc ngày đó **chưa xếp lịch**: dùng tài khoản mặc định
  (tài khoản chung `emr.*`) và ghi cảnh báo `[WARN] Ngày dd/mm/yyyy: …` trong log tác vụ.
  Tài khoản EMR riêng theo người dùng Data Hub đã bỏ (10/2026): tài khoản EMR nhập liệu chỉ khai
  theo tên điều dưỡng.
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
