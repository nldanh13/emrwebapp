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

1. **EMR có mở được từ Internet không**: tắt wifi, bật 4G trên điện thoại, mở trang đăng nhập EMR.
   - Mở được: VPS vào EMR trực tiếp; xóa dòng `EMR_BRIDGE_MODE=1` trong file cấu hình (mục 2).
   - Không mở được (EMR chỉ dùng trong bệnh viện): vẫn dùng được, qua **cầu nối tab EMR** (mục 4b) —
     trình duyệt trên một máy bệnh viện lấy trang EMR giúp VPS.
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

Trên VPS bật sẵn `EMR_REQUIRE_TRUSTED_DEVICE=1`: **máy chưa tin cậy, dù đăng nhập đúng, không nhận
dữ liệu nào** — chỉ thấy trang "Thiết bị này chưa được tin cậy" để đăng ký. Thiết bị tin cậy dùng bình
thường và mở lại không phải đăng nhập. (Muốn tắt: xóa dòng đó trong `/etc/emrwebapp/emrwebapp.env`
rồi `sudo systemctl restart emrwebapp` — không khuyên.)

1. Trên điện thoại: đăng nhập → trang **Thiết bị này chưa được tin cậy** → *Đăng ký thiết bị này*.
2. Trên VPS lấy mã xác nhận (dùng một lần, 10 phút):

   ```bash
   sudo -u emr env $(grep -v '^#' /etc/emrwebapp/emrwebapp.env | xargs) node /opt/emrwebapp/scripts/users_cli.js ma-tin-cay
   ```
3. Nhập mã 8 số trên điện thoại → **Xác nhận**. Xong.

Thiết bị khác (máy khoa, máy nhà): đăng ký trên máy đó, rồi trên điện thoại bấm **Duyệt**.
Mất điện thoại: dùng máy tin cậy khác bấm **Thu hồi**; hết máy tin cậy thì lấy mã mới trên VPS.

### Mã hóa kho dữ liệu (nên làm, sau khi đã có thiết bị tin cậy)

Dữ liệu người bệnh (`.runtime`) và bí mật (`secrets`: tài khoản, mật khẩu EMR) được cất trong một ổ
**mã hóa** (gocryptfs, AES-256). Ai lấy được ổ đĩa VPS / bản chụp ổ đĩa của nhà cung cấp cũng chỉ thấy
dữ liệu đã mã hóa.

```bash
sudo bash /opt/emrwebapp/deploy/vps/vault-init.sh
```

- Đặt **mật khẩu kho** (≥ 12 ký tự). Script in ra **master key** — chép ra giấy / trình quản lý mật
  khẩu, không để trên VPS. Quên mật khẩu kho mà mất cả master key = **mất toàn bộ dữ liệu**.
- Mỗi lần VPS khởi động lại, kho **khóa**; mở trang web sẽ thấy **Mở kho dữ liệu**. Mở trên
  **điện thoại tin cậy**: lần đầu nhập mật khẩu kho và để chọn *Ghi nhớ trên thiết bị này* → lần sau
  chỉ bấm **Mở kho**. Máy chưa tin cậy không gửi được mật khẩu; nhập sai 5 lần khóa 15 phút.
- Khóa kho ngay (nghi bị xâm nhập, tạm ngưng dùng): `sudo bash /opt/emrwebapp/deploy/vps/lock.sh`.
- Giới hạn cần biết: khi kho **đang mở**, máy chủ đọc được dữ liệu (nó cần để chạy EMR). Mã hóa bảo vệ
  lúc VPS tắt/khởi động lại, ổ đĩa bị sao chép, bản sao lưu; người chiếm được quyền root lúc kho đang
  mở vẫn đọc được — vì vậy vẫn cần SSH bằng khóa và tường lửa (mục 9).
- Dữ liệu cũ trước khi mã hóa được xóa bằng `shred`, nhưng ổ SSD không bảo đảm xóa hẳn: VPS đã chạy dữ
  liệu thật trước khi mã hóa thì an toàn nhất là cài lại VPS mới, chạy `vault-init.sh` trước rồi mới
  chuyển dữ liệu vào.

## 4. Tài khoản EMR

```bash
sudo -u emr nano /opt/emrwebapp/secrets/secrets.json   # emr.username / emr.password ... (docs/SECRETS.md)
sudo -u emr nano /opt/emrwebapp/config/config.json     # địa chỉ EMR, cấu hình khoa
sudo systemctl restart emrwebapp
```

Kiểm tra VPS vào được EMR: `curl -sI https://<địa-chỉ-EMR> | head -1` phải ra `HTTP/... 200` hoặc `302`.

## 4b. Cầu nối tab EMR (EMR chỉ mở được trong bệnh viện)

VPS không vào được EMR, nên mượn **tab trình duyệt trên một máy bệnh viện** (đang đăng nhập EMR) để
lấy trang EMR. Máy bệnh viện không cài gì.

```
Máy bệnh viện: tab EMR (đã đăng nhập) ◄──► tab "Cầu nối EMR" ◄──Internet──► VPS (Data Hub)
                                                                    ▲
                                    Ở nhà / bất kỳ đâu: mở Data Hub, bấm Thu thập
```

**Lần đầu ở một máy bệnh viện** (một lần cho mỗi máy):

1. Mở `https://emr.ten-mien.vn` → Kho nghiên cứu → Thu thập. Khung vàng **"Chưa nối tab EMR"** có nút
   **Data Hub** — **kéo** nút đó lên thanh dấu trang (Ctrl + Shift + B để hiện thanh).
   Không kéo được: bấm **Chép mã nút**, rồi tạo dấu trang mới (Ctrl + D → Thêm… → dán vào ô URL).

**Mỗi lần dùng:**

1. Trên máy bệnh viện: mở EMR, đăng nhập, vào **danh sách nội trú**.
2. Bấm nút **Data Hub** trên thanh dấu trang → mở tab **Cầu nối EMR** (đăng nhập Data Hub nếu hỏi) →
   hiện **"Đang nối EMR ✓"**.
3. Để yên **cả hai tab**. Rời máy thì bấm **Windows + L** (khóa màn hình, vẫn chạy). Đừng bấm chuyển
   trang trên tab EMR đó — muốn dùng EMR thì mở tab khác.
4. Ở bất kỳ đâu: mở Data Hub → Kho nghiên cứu → **Thu thập**. Khung xanh **"Máy BV: đang nối ✓"**.

**Bản này lấy được / chưa lấy được qua cầu nối:**

| Lấy được | Chưa (bản sau) |
|---|---|
| Hồ sơ, ra viện, bảng kê, buồng giường, y lệnh, giấy tờ — phần đọc trang EMR | XN/CĐHA (còn bấm trên Chrome) — để "chưa lấy", không tính lỗi |
| Người bệnh **có trong danh sách nội trú** đang hiện trên EMR, hoặc dòng đã có sẵn link hồ sơ | Tìm người bệnh **đã ra viện** (phải bấm lọc trên EMR) |
| | Phẫu thuật, lịch sử CĐHA (phải bấm trên EMR) — hiện "chưa lấy được qua tab EMR" |

- VPS **không cần tài khoản/mật khẩu EMR** ở chế độ này (dùng phiên đăng nhập trên máy bệnh viện).
  Vẫn cần `config/config.json` có địa chỉ EMR **giống** địa chỉ trên thanh địa chỉ máy bệnh viện
  (vd. `http://192.168.2.26:2026/...`).
- EMR tự đăng xuất: khung chuyển đỏ "EMR đã đăng xuất" → đăng nhập lại EMR trên máy đó, bấm lại nút.
- Máy bệnh viện không cần là thiết bị tin cậy: tab cầu nối chỉ chuyển trang EMR **lên** VPS, không đọc
  được dữ liệu trong kho.
- ⚠️ Tab EMR đăng nhập bằng tài khoản của bạn: người khác ngồi vào máy có thể dùng EMR dưới tên bạn.
  Luôn khóa màn hình khi rời máy.

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
- Đã mã hóa kho: bản sao lưu chứa nguyên ổ mã hóa `vault.enc` — khôi phục cần **cả** `backup.pass`
  **và** mật khẩu kho. Giải nén `vault.enc` về `/opt/emrwebapp/vault.enc` rồi mở kho như bình thường;
  kho người bệnh sao lưu nhất quán nằm ở `.runtime/kho_benh_nhan/kho.backup.sqlite3`.
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
| "Chưa nối tab EMR" khi bấm Thu thập | Mục 4b: trên máy bệnh viện mở EMR, bấm nút Data Hub, để yên hai tab |
| Bấm nút Data Hub không thấy gì | Trình duyệt chặn cửa sổ bật lên: cho phép bật lên với trang EMR rồi bấm lại |
| Trang hiện "Mở kho dữ liệu" | VPS vừa khởi động lại: mở kho trên thiết bị tin cậy. Không hiện trang: `sudo systemctl status emrwebapp-unlock` |
| Quên mật khẩu kho | Mở bằng master key: `sudo gocryptfs -masterkey <key> -allow_other /opt/emrwebapp/vault.enc /opt/emrwebapp/vault` rồi đổi mật khẩu: `gocryptfs -passwd -masterkey <key> /opt/emrwebapp/vault.enc` |

## 9. An toàn — kiểm tra lại sau khi cài

- [ ] `/etc/emrwebapp/emrwebapp.env` có dòng `EMR_USERS_FILE=...` (thiếu dòng này app **bỏ qua đăng nhập**).
- [ ] Mở trang từ 4G (ngoài BV): bị chặn nếu đã đặt `--allow-ips`.
- [ ] Đăng nhập trên một máy CHƯA đăng ký: chỉ thấy trang "Thiết bị này chưa được tin cậy", không thấy dữ liệu.
- [ ] Mỗi người một tài khoản riêng, mật khẩu ≥ 8 ký tự; người nghỉ việc thì tắt tài khoản.
- [ ] Đổi đăng nhập SSH sang khóa (SSH key) và tắt đăng nhập root bằng mật khẩu.
- [ ] Đã chép `backup.pass` ra nơi an toàn và thử khôi phục một lần.
- [ ] Đã chạy `vault-init.sh`, chép master key ra giấy; thử `sudo reboot` rồi mở kho bằng điện thoại.
