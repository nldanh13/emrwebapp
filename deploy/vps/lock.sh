#!/usr/bin/env bash
# Khóa kho dữ liệu ngay (vd. nghi VPS bị xâm nhập, hoặc tạm ngưng dùng):
#
#   sudo bash /opt/emrwebapp/deploy/vps/lock.sh            # từ chối nếu đang có tác vụ EMR chạy
#   sudo bash /opt/emrwebapp/deploy/vps/lock.sh --force
#
# Dừng ứng dụng, tháo ổ mã hóa, bật lại trang "Mở kho dữ liệu". Mở lại bằng thiết bị tin cậy.
set -euo pipefail
APP_DIR="/opt/emrwebapp"
VAULT="$APP_DIR/vault"
[[ $EUID -eq 0 ]] || { echo "Cần quyền root: sudo bash lock.sh"; exit 1; }
[[ -f "$APP_DIR/vault.enc/gocryptfs.conf" ]] || { echo "Kho chưa được mã hóa (chưa chạy vault-init.sh)."; exit 1; }
if ! mountpoint -q "$VAULT"; then echo "Kho đang khóa sẵn."; systemctl start emrwebapp-unlock; exit 0; fi
if [[ "${1:-}" != "--force" ]] && pgrep -u emr -f "$APP_DIR/worker/.*\.py" >/dev/null; then
  echo "Đang có tác vụ EMR chạy. Chờ xong rồi chạy lại, hoặc thêm --force nếu chấp nhận ngắt tác vụ."
  exit 2
fi
systemctl stop emrwebapp
sync
fusermount3 -u "$VAULT" 2>/dev/null || fusermount -u "$VAULT" 2>/dev/null || umount "$VAULT"
systemctl start emrwebapp-unlock
echo "Đã khóa kho. Trang web giờ hiện \"Mở kho dữ liệu\"; mở bằng thiết bị tin cậy."
