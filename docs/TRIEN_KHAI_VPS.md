# Chạy Data Hub trên VPS — máy nào trong bệnh viện cũng dùng được

Mô hình:

```
Máy tính bất kỳ trong BV ──wifi/Internet──► https://emr.ten-mien.vn   (VPS: Data Hub + Chrome chạy ẩn)
  (chỉ mở trình duyệt,                              │
   đăng nhập tên + mật khẩu)                        └──Internet──► EMR bệnh viện
```

Máy bệnh viện **không cài gì**. Máy của bạn tắt cũng được. Mọi việc lấy/nhập EMR chạy trên VPS.

---

## 0. Kiểm tra trước khi thuê

1. **EMR mở được từ Internet**: tắt wifi, bật 4G trên điện thoại, mở trang đăng nhập EMR. Không mở
   được thì VPS cũng không vào được — dừng ở đây, cần VPN của bệnh viện.
2. **Được phép đưa dữ liệu ra máy chủ thuê**: kho có họ tên, mã BN, kết quả xét nghiệm (dữ liệu sức
   khỏe — Nghị định 13/2023). Hỏi lãnh đạo khoa / phòng CNTT trước khi chạy với dữ liệu thật.
3. **IP Internet của bệnh viện** (để chỉ cho mạng bệnh viện vào): trên một máy trong BV mở
   `https://ifconfig.me`, ghi lại số hiện ra (vd. `113.161.x.x`). Hỏi CNTT nếu BV có nhiều đường mạng.

## 1. Thuê VPS và tên miền

| Mục | Gợi ý |
|---|---|
| Nhà cung cấp | Trong nước: Viettel IDC, VNPT, FPT Cloud, BizFly… (dữ liệu ở Việt Nam, EMR ít chặn) |
| Cấu hình | 4 vCPU, 8 GB RAM, 80 GB SSD (Chrome + Python tốn RAM) |
| Hệ điều hành | **Ubuntu 24.04** (hoặc 22.04) |
| Tên miền | Mua một tên miền hoặc dùng tên miền con, vd. `emr.ten-mien.vn` |

Trong trang quản lý tên miền, tạo bản ghi **A**: `emr` → **IP của VPS**. Đợi 5–30 phút cho có hiệu lực.

## 2. Cài đặt (một lệnh)

Đăng nhập VPS (Windows: mở **PowerShell**, gõ `ssh root@<IP-VPS>`), rồi chạy:

```bash
git clone https://github.com/nldanh13/emrwebapp.git /root/emr-setup
sudo bash /root/emr-setup/deploy/vps/install.sh --domain emr.ten-mien.vn --allow-ips "113.161.x.x"
```

- `--allow-ips`: chỉ IP bệnh viện vào được (nhiều IP thì cách nhau bằng dấu cách). Bỏ tham số này
  thì mọi nơi trên Internet đều mở được trang đăng nhập — vẫn phải có mật khẩu, nhưng kém an toàn hơn.
- Repo riêng tư: thêm `--repo https://<token>@github.com/nldanh13/emrwebapp.git`.

Script tự làm: múi giờ Việt Nam; Node 22, Python, Google Chrome, màn hình ảo; người dùng hệ thống
`emr`; code ở `/opt/emrwebapp`; dịch vụ tự chạy; HTTPS tự gia hạn (Caddy); tường lửa chỉ mở
22/80/443; sao lưu mỗi đêm 02:30. Chạy lại script lần nữa không mất dữ liệu.

## 3. Tài khoản quản trị đầu tiên

```bash
cd /opt/emrwebapp
sudo -u emr env $(grep -v '^#' /etc/emrwebapp/emrwebapp.env | xargs) node scripts/users_cli.js tao-admin quantri "Quản trị"
```

Nhập mật khẩu (ẩn, ít nhất 8 ký tự) hai lần. Rồi `sudo systemctl restart emrwebapp`.

Mở `https://emr.ten-mien.vn` → **Tên đăng nhập** `quantri` + mật khẩu vừa đặt.

Người dùng khác: vào tab **Thiết lập tài khoản** → Thêm tài khoản → điền *Tên đăng nhập* và *Mật khẩu
đăng nhập*. Quên mật khẩu: quản trị đặt lại ở cùng chỗ, hoặc trên VPS:
`... node scripts/users_cli.js dat-mat-khau <ten>`.

Đăng nhập sai 5 lần thì tài khoản đó (từ máy đó) bị khóa 15 phút.

### Thiết bị tin cậy (điện thoại / máy của bạn)

Chỉ thiết bị tin cậy được xem dữ liệu thật; thiết bị tin cậy mở lại không phải đăng nhập.

1. Trên điện thoại: đăng nhập → tab **Thiết lập tài khoản** → **Thiết bị tin cậy** → *Đăng ký thiết bị này*.
2. Trên VPS lấy mã xác nhận (dùng một lần, 10 phút):

   ```bash
   sudo -u emr env $(grep -v '^#' /etc/emrwebapp/emrwebapp.env | xargs) node /opt/emrwebapp/scripts/users_cli.js ma-tin-cay
   ```
3. Nhập mã 8 số trên điện thoại → **Xác nhận**. Xong.

Thiết bị khác (máy khoa, máy nhà): đăng ký trên máy đó, rồi trên điện thoại bấm **Duyệt**.
Mất điện thoại: dùng máy tin cậy khác bấm **Thu hồi**; hết máy tin cậy thì lấy mã mới trên VPS.

## 4. Tài khoản EMR

```bash
sudo -u emr nano /opt/emrwebapp/secrets/secrets.json   # emr.username / emr.password ... (docs/SECRETS.md)
sudo -u emr nano /opt/emrwebapp/config/config.json     # địa chỉ EMR, cấu hình khoa
sudo systemctl restart emrwebapp
```

Kiểm tra VPS vào được EMR: `curl -sI https://<địa-chỉ-EMR> | head -1` phải ra `HTTP/... 200` hoặc `302`.

## 5. Chuyển dữ liệu đang có từ máy của bạn (nếu muốn giữ)

Trên máy đang chạy hiện nay, **tắt app** (đóng cửa sổ `npm start`), rồi chép 3 thư mục lên VPS bằng
WinSCP (hoặc `scp -r`): `.runtime`, `secrets`, `config` → `/opt/emrwebapp/`. Sau đó trên VPS:

```bash
sudo chown -R emr:emr /opt/emrwebapp/.runtime /opt/emrwebapp/secrets /opt/emrwebapp/config
sudo chmod 700 /opt/emrwebapp/secrets
sudo systemctl restart emrwebapp
```

## 6. Cập nhật khi có bản mới

```bash
sudo bash /opt/emrwebapp/deploy/vps/update.sh
```

Script **từ chối** khi đang có tác vụ lấy/nhập EMR chạy (khởi động lại sẽ ngắt tác vụ). Chờ xong rồi
chạy lại; thật cần thì thêm `--force`. Cập nhật lỗi thì script in sẵn lệnh quay về bản cũ.

## 7. Sao lưu và khôi phục

- Mỗi đêm 02:30, bản sao lưu **mã hóa** ở `/var/backups/emrwebapp/` (giữ 14 bản). Chạy tay:
  `sudo systemctl start emrwebapp-backup`.
- **Mật khẩu giải mã** ở `/etc/emrwebapp/backup.pass` — chép ra nơi an toàn (USB, trình quản lý mật
  khẩu). Mất file này là không mở được bản sao lưu.
- Nên tải bản sao lưu về máy khác định kỳ (WinSCP). VPS hỏng thì bản sao lưu nằm trên VPS cũng mất.
- Khôi phục:

  ```bash
  sudo systemctl stop emrwebapp
  mkdir /tmp/khoiphuc
  gpg --batch --passphrase-file /etc/emrwebapp/backup.pass -d /var/backups/emrwebapp/<file>.tar.gz.gpg | tar xz -C /tmp/khoiphuc
  # chép .runtime / secrets / config từ /tmp/khoiphuc về /opt/emrwebapp;
  # kho người bệnh: /tmp/khoiphuc/kho.sqlite3 → /opt/emrwebapp/.runtime/kho_benh_nhan/kho.sqlite3
  sudo chown -R emr:emr /opt/emrwebapp && sudo systemctl start emrwebapp
  ```

## 8. Khi có sự cố

| Hiện tượng | Xem / làm |
|---|---|
| Trang không mở | `sudo systemctl status emrwebapp caddy`; tên miền đã trỏ đúng IP chưa |
| "Chỉ truy cập được từ mạng bệnh viện" | Máy đang ở ngoài BV, hoặc IP bệnh viện đổi → chạy lại install.sh với `--allow-ips` mới |
| Lỗi khi lấy/nhập EMR | `sudo journalctl -u emrwebapp -n 200`; thử `curl -sI https://<EMR>` trên VPS |
| VPS hết RAM | Nâng lên 8–16 GB; mỗi tác vụ EMR mở một Chrome |
| Quên mật khẩu quản trị | Mục 3, lệnh `dat-mat-khau` |

## 9. An toàn — kiểm tra lại sau khi cài

- [ ] `/etc/emrwebapp/emrwebapp.env` có dòng `EMR_USERS_FILE=...` (thiếu dòng này app **bỏ qua đăng nhập**).
- [ ] Mở trang từ 4G (ngoài BV): bị chặn nếu đã đặt `--allow-ips`.
- [ ] Mỗi người một tài khoản riêng, mật khẩu ≥ 8 ký tự; người nghỉ việc thì tắt tài khoản.
- [ ] Đổi đăng nhập SSH sang khóa (SSH key) và tắt đăng nhập root bằng mật khẩu.
- [ ] Đã chép `backup.pass` ra nơi an toàn và thử khôi phục một lần.
