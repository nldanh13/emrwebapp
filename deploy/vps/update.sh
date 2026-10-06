#!/usr/bin/env bash
# Cập nhật Data Hub lên bản mới nhất trên GitHub, rồi khởi động lại dịch vụ.
#
#   sudo bash /opt/emrwebapp/deploy/vps/update.sh            # từ chối nếu đang có tác vụ EMR chạy
#   sudo bash /opt/emrwebapp/deploy/vps/update.sh --force    # vẫn cập nhật (tác vụ đang chạy sẽ bị ngắt)
#
# Khởi động lại khi đang lấy/nhập EMR sẽ ngắt tác vụ giữa chừng (docs/UX_RULES.md 8.4), nên mặc
# định chỉ cập nhật lúc không có worker Python nào đang chạy.
set -euo pipefail
APP_DIR="/opt/emrwebapp"
BRANCH="${BRANCH:-main}"
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1
[[ $EUID -eq 0 ]] || { echo "Cần quyền root: sudo bash update.sh"; exit 1; }

if [[ $FORCE -eq 0 ]] && pgrep -u emr -f "$APP_DIR/worker/.*\.py" >/dev/null; then
  echo "Đang có tác vụ EMR chạy (lấy/nhập dữ liệu). Chờ xong rồi chạy lại, hoặc thêm --force nếu chấp nhận ngắt tác vụ."
  pgrep -u emr -af "$APP_DIR/worker/.*\.py" | sed 's/^/   /'
  exit 2
fi

VAULT_ON=0
[[ -f "$APP_DIR/vault.enc/gocryptfs.conf" ]] && VAULT_ON=1
if [[ $VAULT_ON -eq 1 ]] && ! mountpoint -q "$APP_DIR/vault"; then
  echo "Kho dữ liệu đang khóa. Mở kho trên thiết bị tin cậy (trang web) rồi chạy lại."
  exit 2
fi

cd "$APP_DIR"
before="$(sudo -u emr git rev-parse --short HEAD)"
sudo -u emr git fetch -q origin "$BRANCH"
sudo -u emr git checkout -q "$BRANCH"
sudo -u emr git pull -q --ff-only origin "$BRANCH"
after="$(sudo -u emr git rev-parse --short HEAD)"
if [[ "$before" == "$after" ]]; then
  echo "Đã là bản mới nhất ($after). Không cần cập nhật."
  exit 0
fi

echo "Cập nhật $before → $after"
sudo -u emr npm ci --no-audit --no-fund
sudo -u emr npm run build
sudo -u emr "$APP_DIR/.venv/bin/pip" install -q -r requirements.txt
# Bản mới có thể đổi file dịch vụ/sao lưu.
cp deploy/vps/emrwebapp.service deploy/vps/emrwebapp-backup.service deploy/vps/emrwebapp-backup.timer /etc/systemd/system/
if [[ $VAULT_ON -eq 1 ]]; then
  cp deploy/vps/emrwebapp-unlock.service /etc/systemd/system/
  mkdir -p /etc/systemd/system/emrwebapp.service.d
  cp deploy/vps/emrwebapp-vault.conf /etc/systemd/system/emrwebapp.service.d/vault.conf
fi
systemctl daemon-reload
systemctl restart emrwebapp
sleep 3
if systemctl is-active --quiet emrwebapp; then
  echo "Xong: đang chạy bản $after. Người dùng tải lại trang là thấy bản mới."
else
  echo "Dịch vụ không chạy được sau cập nhật. Xem lỗi: sudo journalctl -u emrwebapp -n 80"
  echo "Quay về bản cũ: cd $APP_DIR && sudo -u emr git checkout $before && sudo bash deploy/vps/update.sh --force"
  exit 1
fi
