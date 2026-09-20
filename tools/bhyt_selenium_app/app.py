from __future__ import annotations

from datetime import datetime
import csv
import io
import json
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_file
from werkzeug.utils import secure_filename

from bhyt.mapping import DEFAULT_DOCTORS, load_records
from bhyt.portal import BhytPortal, PortalError, Worker
from bhyt.store import Store


ROOT = Path(__file__).resolve().parent
RUNTIME = ROOT / "runtime"
UPLOADS = RUNTIME / "uploads"
RUNTIME.mkdir(exist_ok=True)
UPLOADS.mkdir(exist_ok=True)


def load_config():
    path = ROOT / "config.json"
    if not path.exists():
        return {"allowed_doctors": DEFAULT_DOCTORS, "delay_seconds": 1.0}
    return json.loads(path.read_text(encoding="utf-8"))


config = load_config()
store = Store(RUNTIME / "bhyt_automation.sqlite3")
portal = BhytPortal(RUNTIME / "chrome_profile", timeout=int(config.get("timeout_seconds", 40)))
worker = Worker(portal, store)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024
app.secret_key = "local-bhyt-selenium"


@app.get("/")
def index():
    return render_template("index.html", doctors=config.get("allowed_doctors", DEFAULT_DOCTORS))


@app.get("/api/summary")
def api_summary():
    return jsonify({"summary": store.summary(), "worker": worker.status()})


@app.get("/api/records")
def api_records():
    records = store.list_records(
        doc_type=request.args.get("doc_type", ""),
        status=request.args.get("status", ""),
        search=request.args.get("search", ""),
    )
    return jsonify({"records": records})


@app.post("/api/import")
def api_import():
    files = request.files.getlist("files")
    if not files:
        return jsonify({"error": "Chưa chọn file Excel"}), 400
    paths = []
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    for uploaded in files:
        if not uploaded.filename.lower().endswith((".xlsx", ".xlsm")):
            return jsonify({"error": f"Không hỗ trợ file: {uploaded.filename}"}), 400
        name = secure_filename(uploaded.filename) or "du_lieu.xlsx"
        path = UPLOADS / f"{stamp}_{name}"
        uploaded.save(path)
        paths.append(path)
    try:
        records = load_records(paths, config.get("allowed_doctors", DEFAULT_DOCTORS))
        result = store.import_records(records)
        return jsonify({**result, "recognized": len(records), "summary": store.summary()})
    except Exception as exc:
        return jsonify({"error": f"Không đọc được dữ liệu: {exc}"}), 400


@app.post("/api/records/<int:record_id>/fields")
def api_update_fields(record_id: int):
    payload = request.get_json(force=True) or {}
    updates = payload.get("fields", {})
    allowed = {
        "so_kcb", "ma_ct", "so_seri", "ma_bhxh", "ma_the", "ho_ten",
        "ngay_sinh", "gioi_tinh", "ten_dv", "ngay_kcb", "chan_doan",
        "tu_ngay", "den_ngay", "ho_ten_cha", "ho_ten_me", "nguoi_dai_dien",
        "doctor_text", "ngay_ct", "ma_khoa", "dan_toc", "dia_chi",
        "pp_dieutri", "ghi_chu", "nghe_nghiep", "loai_giay_to", "so_cccd",
        "ngaycap_cccd", "noicap_cccd", "ngoaitru_tungay", "ngoaitru_denngay",
    }
    clean = {key: value for key, value in updates.items() if key in allowed}
    try:
        store.update_fields(record_id, clean)
        return jsonify({"record": store.get_record(record_id)})
    except KeyError:
        return jsonify({"error": "Không tìm thấy hồ sơ"}), 404


@app.post("/api/browser/start")
def api_browser_start():
    try:
        return jsonify({"message": portal.start(), "status": portal.session_status()})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.post("/api/browser/fill-login")
def api_browser_fill_login():
    payload = request.get_json(force=True) or {}
    facility_code = str(payload.get("facility_code", "")).strip()
    username = str(payload.get("username", "")).strip()
    password = str(payload.get("password", ""))
    if not facility_code or not username or not password:
        return jsonify({"error": "Cần nhập đủ Mã cơ sở KCB, tên đăng nhập và mật khẩu"}), 400
    try:
        if portal.driver is None:
            portal.start()
        message = portal.fill_login(facility_code, username, password)
        return jsonify({"message": message, "status": portal.session_status()})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.get("/api/browser/status")
def api_browser_status():
    try:
        return jsonify(portal.session_status())
    except Exception as exc:
        return jsonify({"logged_in": False, "error": str(exc)})


@app.post("/api/browser/close")
def api_browser_close():
    portal.close()
    return jsonify({"message": "Đã đóng Chrome"})


@app.post("/api/run")
def api_run():
    payload = request.get_json(force=True) or {}
    ids = [int(value) for value in payload.get("record_ids", [])]
    dry_run = bool(payload.get("dry_run", True))
    if not ids:
        records = store.list_records(doc_type=payload.get("doc_type", ""))
        ids = [item["id"] for item in records if item["status"] != "success" and item["ready"]]
    else:
        ids = list(dict.fromkeys(ids))
        selected = [store.get_record(record_id) for record_id in ids]
        selected = [record for record in selected if record]
        not_ready = [record for record in selected if not record["ready"]]
        if not_ready:
            names = ", ".join(record["patient_name"] for record in not_ready[:3])
            extra = "…" if len(not_ready) > 3 else ""
            return jsonify({
                "error": f"Có {len(not_ready)} hồ sơ thiếu dữ liệu: {names}{extra}. Hãy bấm Bổ sung trước."
            }), 400
        ids = [record["id"] for record in selected if record["status"] != "success"]
    if not ids:
        return jsonify({"error": "Không có hồ sơ sẵn sàng để chạy"}), 400
    if not dry_run and payload.get("confirmation") != "NHẬP THẬT":
        return jsonify({"error": "Cần nhập đúng cụm từ NHẬP THẬT để xác nhận"}), 400
    try:
        status = portal.session_status()
        if not status.get("logged_in"):
            return jsonify({"error": "Chưa đăng nhập Cổng BHYT trên Chrome"}), 400
        worker.start(ids, dry_run=dry_run, delay_seconds=float(config.get("delay_seconds", 1.0)))
        return jsonify({"message": "Đã bắt đầu", "count": len(ids), "dry_run": dry_run})
    except PortalError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.post("/api/stop")
def api_stop():
    worker.stop()
    return jsonify({"message": "Đã gửi yêu cầu dừng"})


@app.post("/api/reset")
def api_reset():
    payload = request.get_json(force=True) or {}
    ids = [int(value) for value in payload.get("record_ids", [])]
    store.reset_status(ids)
    return jsonify({"message": "Đã đặt lại trạng thái", "count": len(ids)})


@app.get("/api/logs")
def api_logs():
    return jsonify({"logs": store.recent_logs(200)})


@app.get("/export/status.csv")
def export_status():
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "ID", "Loại", "Họ tên", "Bác sĩ", "File nguồn", "Dòng nguồn",
        "Trạng thái", "Thông báo", "Số lần thử", "Cập nhật",
    ])
    for item in store.list_records():
        writer.writerow([
            item["id"], item["doc_type"], item["patient_name"], item["doctor_name"],
            item["source_file"], item["source_row"], item["status"], item["message"],
            item["attempt_count"], item["updated_at"],
        ])
    data = io.BytesIO(output.getvalue().encode("utf-8-sig"))
    return send_file(data, mimetype="text/csv", as_attachment=True, download_name="trang_thai_nhap_bhyt.csv")


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5005, debug=False, threaded=True)
