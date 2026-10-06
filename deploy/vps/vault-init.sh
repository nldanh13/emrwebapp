#!/usr/bin/env bash
# Mã hóa kho dữ liệu trên VPS — chạy MỘT lần, bằng quyền root, sau install.sh:
#
#   sudo bash /opt/emrwebapp/deploy/vps/vault-init.sh
#
# Sau khi chạy: dữ liệu người bệnh (.runtime) và bí mật (secrets: tài khoản, mật khẩu EMR) nằm trong
# ổ mã hóa /opt/emrwebapp/vault.enc (gocryptfs, AES-256-GCM). Mỗi lần VPS khởi động lại, kho KHÓA;
# trang web hiện "Mở kho dữ liệu" — mở bằng điện thoại/máy tin cậy (một nút nếu đã ghi nhớ).
# Danh sách thiết bị tin cậy (chỉ khóa công khai) nằm ngoài kho để trang Mở kho kiểm được chữ ký.
set -euo pipefail
APP_DIR="/opt/emrwebapp"
ENV_FILE="/etc/emrwebapp/emrwebapp.env"
ENC="$APP_DIR/vault.enc"
VAULT="$APP_DIR/vault"
TRUST_DIR="$APP_DIR/device_trust"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mLỗi: %s\033[0m\n' "$*"; exit 1; }

[[ $EUID -eq 0 ]] || die "Cần quyền root: sudo bash vault-init.sh"
[[ -f "$ENV_FILE" ]] || die "Chưa cài ứng dụng. Chạy install.sh trước."
[[ -f "$ENC/gocryptfs.conf" ]] && die "Kho đã được mã hóa từ trước ($ENC). Không làm lại."
if pgrep -u emr -f "$APP_DIR/worker/.*\.py" >/dev/null; then
  die "Đang có tác vụ EMR chạy. Chờ xong rồi chạy lại."
fi
[[ -e "$APP_DIR/secrets/trusted_devices.json" ]] || die "Chưa có thiết bị tin cậy nào. Đăng ký điện thoại của bạn trước (docs/TRIEN_KHAI_VPS.md mục Thiết bị tin cậy) — không có thì không mở được kho."

say "Cài gocryptfs"
command -v gocryptfs >/dev/null || { apt-get update -y && apt-get install -y gocryptfs fuse3; }

echo
echo "Đặt MẬT KHẨU KHO (ít nhất 12 ký tự). Mật khẩu này dùng mỗi khi VPS khởi động lại."
read -r -s -p "Mật khẩu kho: " P1; echo
read -r -s -p "Nhập lại:     " P2; echo
[[ "$P1" == "$P2" ]] || die "Hai lần nhập không giống nhau."
[[ ${#P1} -ge 12 ]] || die "Mật khẩu kho cần ít nhất 12 ký tự."

say "Dừng ứng dụng"
systemctl stop emrwebapp || true

say "Tạo ổ mã hóa $ENC"
mkdir -p "$ENC" "$VAULT"
chmod 700 "$ENC"
init_out="$(printf '%s\n' "$P1" | gocryptfs -init -q "$ENC" 2>&1)" || die "Không tạo được ổ mã hóa: $init_out"
printf '%s\n' "$P1" | gocryptfs -q -allow_other "$ENC" "$VAULT" || die "Không gắn được ổ mã hóa."
unset P1 P2

say "Chuyển dữ liệu vào kho"
mkdir -p "$TRUST_DIR" "$VAULT/runtime" "$VAULT/secrets"
mv "$APP_DIR/secrets/trusted_devices.json" "$TRUST_DIR/trusted_devices.json"
for pair in ".runtime:runtime" "secrets:secrets"; do
  src="$APP_DIR/${pair%%:*}"; dst="$VAULT/${pair##*:}"
  if [[ -d "$src" && ! -L "$src" ]]; then
    cp -a "$src/." "$dst/"
    # Xóa bản rõ cũ (shred từng file nếu có thể; ổ SSD không bảo đảm xóa hẳn — xem tài liệu).
    find "$src" -type f -exec shred -u {} + 2>/dev/null || true
    rm -rf "$src"
  fi
  ln -sfn "$dst" "$src"
  chown -h emr:emr "$src"
done
chown -R emr:emr "$VAULT/runtime" "$VAULT/secrets" "$TRUST_DIR"
chmod 700 "$VAULT/secrets" "$TRUST_DIR"

say "Cấu hình dịch vụ"
sed -i '/^EMR_TRUSTED_DEVICES_FILE=/d;/^EMR_VAULT_CIPHER_DIR=/d;/^EMR_VAULT_MOUNT_DIR=/d' "$ENV_FILE"
cat >> "$ENV_FILE" <<ENV
# Kho mã hóa (vault-init.sh). Danh sách thiết bị tin cậy nằm ngoài kho để trang Mở kho đọc được.
EMR_TRUSTED_DEVICES_FILE=$TRUST_DIR/trusted_devices.json
EMR_VAULT_CIPHER_DIR=$ENC
EMR_VAULT_MOUNT_DIR=$VAULT
ENV
cp "$APP_DIR/deploy/vps/emrwebapp-unlock.service" /etc/systemd/system/
mkdir -p /etc/systemd/system/emrwebapp.service.d
cp "$APP_DIR/deploy/vps/emrwebapp-vault.conf" /etc/systemd/system/emrwebapp.service.d/vault.conf
systemctl daemon-reload
systemctl enable emrwebapp-unlock >/dev/null
systemctl start emrwebapp

say "Xong. Kho đã mã hóa và đang mở."
cat <<MSG

Thông tin khôi phục của ổ mã hóa (MASTER KEY) — CHÉP RA GIẤY / trình quản lý mật khẩu, KHÔNG để trên VPS:
$init_out

Quên mật khẩu kho mà mất cả master key ở trên = MẤT TOÀN BỘ DỮ LIỆU.

Từ giờ mỗi khi VPS khởi động lại: mở trang web trên điện thoại tin cậy → "Mở kho" (lần đầu nhập
mật khẩu kho, chọn "Ghi nhớ trên thiết bị này" để lần sau chỉ bấm một nút).
Khóa kho bằng tay: sudo bash $APP_DIR/deploy/vps/lock.sh
MSG
