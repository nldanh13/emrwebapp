#!/usr/bin/env bash
# Sao lưu dữ liệu Data Hub (chạy mỗi đêm bằng emrwebapp-backup.timer, hoặc tay: sudo bash backup.sh).
# Gồm: .runtime (dữ liệu, kho người bệnh, kho nghiên cứu, nhật ký), secrets/, config/.
# Mã hóa bằng mật khẩu trong /etc/emrwebapp/backup.pass (gpg AES256). Giữ 14 bản gần nhất.
#
# Giải mã khi cần khôi phục:
#   gpg --batch --passphrase-file /etc/emrwebapp/backup.pass -d <file>.tar.gz.gpg | tar xz -C /tmp/khoiphuc
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/emrwebapp}"
DEST="${BACKUP_DIR:-/var/backups/emrwebapp}"
KEEP="${BACKUP_KEEP:-14}"
PASS_FILE="${BACKUP_PASS_FILE:-/etc/emrwebapp/backup.pass}"
stamp="$(date +%Y%m%d_%H%M)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$DEST"; chmod 700 "$DEST"

# Kho người bệnh (SQLite): chép bằng lệnh .backup để bản sao nhất quán dù app đang ghi.
db="$APP_DIR/.runtime/kho_benh_nhan/kho.sqlite3"
if [[ -f "$db" ]]; then
  sqlite3 "$db" ".backup '$work/kho.sqlite3'"
fi

items=()
for p in .runtime secrets config research_store care_baseline_store; do
  [[ -e "$APP_DIR/$p" ]] && items+=("$p")
done
out="$DEST/emrwebapp_$stamp.tar.gz.gpg"
tar -C "$APP_DIR" --exclude='.runtime/kho_benh_nhan/kho.sqlite3*' -czf - "${items[@]}" -C "$work" $( [[ -f "$work/kho.sqlite3" ]] && echo kho.sqlite3 ) \
  | gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase-file "$PASS_FILE" -o "$out"
chmod 600 "$out"
echo "Đã sao lưu: $out ($(du -h "$out" | cut -f1))"

ls -1t "$DEST"/emrwebapp_*.tar.gz.gpg 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
