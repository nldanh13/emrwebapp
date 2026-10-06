#!/usr/bin/env bash
# Cài EMR Data Hub lên VPS Ubuntu 22.04/24.04 — chạy MỘT lần, bằng quyền root:
#
#   sudo bash install.sh --domain emr.ten-mien.vn [--allow-ips "1.2.3.4 5.6.7.8"] [--repo URL] [--branch main]
#
# Làm: cài Node 22, Python, Chrome, màn hình ảo; tạo người dùng hệ thống "emr"; tải code về
# /opt/emrwebapp; build giao diện; tạo dịch vụ tự chạy; bật HTTPS (Caddy); tường lửa chỉ mở
# 22/80/443; sao lưu mỗi đêm. Chạy lại script này an toàn (không xóa dữ liệu đã có).
set -euo pipefail

DOMAIN=""
ALLOW_IPS=""
REPO="https://github.com/nldanh13/emrwebapp.git"
BRANCH="main"
APP_DIR="/opt/emrwebapp"
ENV_DIR="/etc/emrwebapp"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --allow-ips) ALLOW_IPS="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    *) echo "Không hiểu tham số: $1"; exit 1 ;;
  esac
done

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mLỗi: %s\033[0m\n' "$*"; exit 1; }

[[ $EUID -eq 0 ]] || die "Cần chạy bằng quyền root: sudo bash install.sh --domain ..."
[[ -n "$DOMAIN" ]] || die "Thiếu tên miền. Ví dụ: sudo bash install.sh --domain emr.ten-mien.vn"
. /etc/os-release
if [[ -f "$APP_DIR/vault.enc/gocryptfs.conf" ]] && ! mountpoint -q "$APP_DIR/vault"; then
  die "Kho dữ liệu đang khóa. Mở kho trên thiết bị tin cậy (trang web) rồi chạy lại."
fi
[[ "${ID:-}" == "ubuntu" ]] || die "Script này dành cho Ubuntu 22.04/24.04 (máy này: ${PRETTY_NAME:-không rõ})."

say "Đặt múi giờ Việt Nam"
timedatectl set-timezone Asia/Ho_Chi_Minh || true

say "Cài gói hệ thống (Python, màn hình ảo, phông chữ, sqlite, tường lửa)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates gnupg git build-essential \
  python3 python3-venv python3-pip xvfb xauth fonts-dejavu fonts-noto-core \
  sqlite3 gpg ufw debian-keyring debian-archive-keyring apt-transport-https

say "Cài Node.js 22"
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

say "Cài Google Chrome"
if ! command -v google-chrome >/dev/null; then
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list
  apt-get update -y && apt-get install -y google-chrome-stable
fi

say "Cài Caddy (HTTPS tự động)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

say "Tạo người dùng hệ thống 'emr' và tải code về $APP_DIR"
mkdir -p "$APP_DIR"
id emr >/dev/null 2>&1 || useradd --system --create-home --home-dir "$APP_DIR/.home" --shell /usr/sbin/nologin emr
if [[ -d "$APP_DIR/.git" ]]; then
  sudo -u emr git -C "$APP_DIR" fetch -q origin "$BRANCH"
  sudo -u emr git -C "$APP_DIR" checkout -q "$BRANCH"
  sudo -u emr git -C "$APP_DIR" pull -q --ff-only origin "$BRANCH"
else
  mkdir -p "$APP_DIR"
  chown emr:emr "$APP_DIR"
  tmp="$(mktemp -d)"; git clone -q --branch "$BRANCH" "$REPO" "$tmp/app"
  shopt -s dotglob; cp -a "$tmp/app/"* "$APP_DIR/"; shopt -u dotglob; rm -rf "$tmp"
  mkdir -p "$APP_DIR/.home"
  chown -R emr:emr "$APP_DIR"
fi

say "Cài thư viện Node và build giao diện"
cd "$APP_DIR"
sudo -u emr npm ci --no-audit --no-fund
sudo -u emr npm run build

say "Cài thư viện Python (môi trường ảo .venv)"
[[ -x "$APP_DIR/.venv/bin/python" ]] || sudo -u emr python3 -m venv "$APP_DIR/.venv"
sudo -u emr "$APP_DIR/.venv/bin/pip" install -q --upgrade pip
sudo -u emr "$APP_DIR/.venv/bin/pip" install -q -r requirements.txt

say "Thư mục bí mật và cấu hình"
sudo -u emr mkdir -p "$APP_DIR/secrets" "$APP_DIR/.runtime"
chmod 700 "$APP_DIR/secrets"
[[ -f "$APP_DIR/config/config.json" ]] || sudo -u emr cp "$APP_DIR/config/config.example.json" "$APP_DIR/config/config.json"
if [[ ! -f "$APP_DIR/secrets/secrets.json" ]]; then
  sudo -u emr cp "$APP_DIR/config/secrets.example.json" "$APP_DIR/secrets/secrets.json"
  chmod 600 "$APP_DIR/secrets/secrets.json"
fi
mkdir -p "$ENV_DIR"
if [[ ! -f "$ENV_DIR/emrwebapp.env" ]]; then
  cp "$APP_DIR/deploy/vps/emrwebapp.env.example" "$ENV_DIR/emrwebapp.env"
fi
chmod 600 "$ENV_DIR/emrwebapp.env"
if [[ ! -f "$ENV_DIR/backup.pass" ]]; then
  head -c 32 /dev/urandom | base64 > "$ENV_DIR/backup.pass"
fi
chmod 600 "$ENV_DIR/backup.pass"

say "Dịch vụ tự chạy (systemd)"
cp "$APP_DIR/deploy/vps/emrwebapp.service" /etc/systemd/system/emrwebapp.service
cp "$APP_DIR/deploy/vps/emrwebapp-backup.service" /etc/systemd/system/emrwebapp-backup.service
cp "$APP_DIR/deploy/vps/emrwebapp-backup.timer" /etc/systemd/system/emrwebapp-backup.timer
systemctl daemon-reload
systemctl enable --now emrwebapp-backup.timer
systemctl enable emrwebapp
systemctl restart emrwebapp

say "HTTPS (Caddy) cho $DOMAIN"
ip_rule=""
if [[ -n "$ALLOW_IPS" ]]; then
  ip_rule=$'@blocked not remote_ip '"$ALLOW_IPS"$'\n\trespond @blocked "Chỉ truy cập được từ mạng bệnh viện." 403'
fi
python3 - "$DOMAIN" "$ip_rule" "$APP_DIR/deploy/vps/Caddyfile.template" > /etc/caddy/Caddyfile <<'PY'
import sys
domain, rule, tpl = sys.argv[1], sys.argv[2], open(sys.argv[3]).read()
print(tpl.replace('__DOMAIN__', domain).replace('__IP_RULE__', rule or '# (không giới hạn IP)'))
PY
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

say "Tường lửa: chỉ mở SSH (22), HTTP (80), HTTPS (443)"
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

say "Xong phần cài đặt."
cat <<MSG

Việc tiếp theo (xem docs/TRIEN_KHAI_VPS.md):
  1. Tạo tài khoản quản trị đầu tiên:
       sudo -u emr env \$(cat $ENV_DIR/emrwebapp.env | grep -v '^#' | xargs) node $APP_DIR/scripts/users_cli.js tao-admin quantri "Quản trị"
  2. Điền tài khoản EMR:  sudo -u emr nano $APP_DIR/config/config.json  và  $APP_DIR/secrets/secrets.json
  3. Khởi động lại:       sudo systemctl restart emrwebapp
  4. Mở https://$DOMAIN trên máy bất kỳ, đăng nhập bằng tài khoản vừa tạo.

Mật khẩu giải mã bản sao lưu nằm ở $ENV_DIR/backup.pass — CHÉP RA NƠI AN TOÀN, mất là không mở được bản sao lưu.
MSG
