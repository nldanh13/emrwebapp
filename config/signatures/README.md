# Ảnh chữ ký theo điều dưỡng/bác sĩ

Ảnh chữ ký do tab "Lịch điều dưỡng" ghi vào thư mục này (PNG/JPEG, nền
trong suốt cho đẹp nhất) — dùng để tự động chèn chữ ký vào bộ phiếu
"IN RA VIỆN" (xem `worker/sign_discharge_bundle.py`). Con trỏ tới file
(`signature_file`) lưu trong `config/nurse_emr_accounts.json`.

Không commit ảnh chữ ký thật lên git — thư mục này chỉ giữ file này để có
mặt trong repo; ảnh thật bị `.gitignore` chặn (`config/signatures/*`).
