from __future__ import annotations

from datetime import datetime
import csv
import io
import json
import re
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_file
from werkzeug.utils import secure_filename

from bhyt.emr import EmrError, EmrPortal
from bhyt.emrwebapp_client import WebAppError, fetch_records_from_webapp
from bhyt.mapping import DEFAULT_DOCTORS, load_records
from bhyt.pdf_phieu import PhieuPdfError, parse_phieu_pdf
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
        return {"allowed_doctors": DEFAULT_DOCTORS, "delay_seconds": 1.0, "webapp_base_url": ""}
    data = json.loads(path.read_text(encoding="utf-8"))
    data.setdefault("webapp_base_url", "")
    return data


config = load_config()
store = Store(RUNTIME / "bhyt_automation.sqlite3")
portal = BhytPortal(
    RUNTIME / "chrome_profile",
    timeout=int(config.get("timeout_seconds", 40)),
    headless=bool(config.get("headless", True)),
    selectors=config.get("portal_selectors") or {},
    debug_dir=RUNTIME / "debug",
)
# Các field hồ sơ cho phép cập nhật (sửa tay hoặc bù từ EMR/PDF phiếu).
_UPDATE_FIELDS = {
    "so_kcb", "ma_ct", "so_seri", "ma_bhxh", "ma_the", "ho_ten",
    "ngay_sinh", "gioi_tinh", "ten_dv", "ngay_kcb", "chan_doan",
    "tu_ngay", "den_ngay", "ho_ten_cha", "ho_ten_me", "nguoi_dai_dien",
    "doctor_text", "ngay_ct", "ma_khoa", "dan_toc", "dia_chi",
    "pp_dieutri", "ghi_chu", "nghe_nghiep", "loai_giay_to", "so_cccd",
    "ngaycap_cccd", "noicap_cccd", "ngoaitru_tungay", "ngoaitru_denngay",
}

# EMR nội bộ — nhập "Giấy chứng nhận nghỉ việc hưởng BHXH" (mục tiêu 2), khác cổng BHYT.
_emr_cfg = config.get("emr") or {}
emr = EmrPortal(
    base_url=_emr_cfg.get("base_url", ""),
    profile_dir=RUNTIME / "emr_chrome_profile",
    timeout=int(config.get("timeout_seconds", 40)),
    headless=bool(config.get("headless", True)),
    selectors=_emr_cfg.get("selectors") or {},
    debug_dir=RUNTIME / "debug",
    download_dir=RUNTIME / "emr_downloads",
)

# Worker tự lấy dữ liệu phiếu từ EMR (emr) khi hồ sơ còn thiếu, rồi nhập lên cổng.
worker = Worker(portal, store, emr)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024
app.secret_key = "local-bhyt-selenium"

# ── CORS có kiểm soát ─────────────────────────────────────────────────────────
# Cho phép trang "Nghỉ ốm" của web app chính (React, chạy trên origin khác —
# vd http://localhost:3001) gọi thẳng API này để nhúng UI ngay trong tab đó,
# thay vì mở tab riêng. Vì Flask này chỉ bind 127.0.0.1 (không lộ ra mạng), chỉ
# trang nào chạy TRÊN CHÍNH MÁY NÀY mới gọi được — nhưng vẫn giới hạn origin
# được phép đọc phản hồi (chỉ localhost/127.0.0.1) để trang lạ mở trong tab
# khác trên cùng máy không dò/đọc được dữ liệu qua CORS.
_ALLOWED_ORIGIN_RE = re.compile(r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$")


@app.after_request
def _apply_cors(response):
    origin = request.headers.get("Origin", "")
    if _ALLOWED_ORIGIN_RE.match(origin):
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        response.headers["Vary"] = "Origin"
    return response


@app.get("/")
def index():
    return render_template(
        "index.html",
        doctors=config.get("allowed_doctors", DEFAULT_DOCTORS),
        webapp_base_url=config.get("webapp_base_url", ""),
    )


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


@app.post("/api/phieu/parse-pdf")
def api_phieu_parse_pdf():
    """Đọc file PDF "Giấy chứng nhận nghỉ việc" (ngoại trú/phòng khám, mẫu 07) mà EMR
    xuất ra khi bấm "Xem phiếu". Bản PDF này có đủ cả Số KCB, Số seri, CCCD nên dùng
    làm nguồn điền lên cổng BHXH. Nếu có record_id thì bù các field vào hồ sơ."""
    uploaded = request.files.get("file")
    if uploaded is None or not (uploaded.filename or "").strip():
        return jsonify({"error": "Chưa chọn file PDF phiếu"}), 400
    if not uploaded.filename.lower().endswith(".pdf"):
        return jsonify({"error": f"Chỉ nhận file PDF: {uploaded.filename}"}), 400

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    name = secure_filename(uploaded.filename) or "phieu.pdf"
    path = UPLOADS / f"{stamp}_{name}"
    uploaded.save(path)
    try:
        result = parse_phieu_pdf(path)
    except PhieuPdfError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Không đọc được phiếu PDF: {exc}"}), 500

    # Chỉ bù các field dùng được cho hồ sơ (bỏ mau_so/so_ngay_nghi — không phải field lưu).
    mergeable = {k: v for k, v in result["fields"].items() if k in _UPDATE_FIELDS}
    record_id = (request.form.get("record_id") or "").strip()
    updated = False
    if record_id and mergeable:
        try:
            store.update_fields(int(record_id), mergeable)
            updated = True
        except (KeyError, ValueError):
            return jsonify({"error": "Không tìm thấy hồ sơ để cập nhật"}), 404
    return jsonify({
        "doc_type": result["doc_type"],
        "mau_so": result.get("mau_so", "07"),
        "fields": result["fields"],
        "merged": mergeable,
        "updated": updated,
    })


@app.post("/api/import-from-webapp")
def api_import_from_webapp():
    """Lấy hồ sơ trực tiếp từ tab "Nghỉ ốm" của web app (bảng đã rà soát) thay
    vì đọc lại file Excel — xem bhyt/FIELD_MAP.md để biết cách ánh xạ field."""
    payload = request.get_json(force=True) or {}
    base_url = str(payload.get("base_url", "")).strip()
    session_id = str(payload.get("session_id", "")).strip()
    app_token = str(payload.get("app_token", "")).strip()
    if not base_url or not session_id:
        return jsonify({"error": "Cần nhập URL server và Mã phiên (session ID)"}), 400

    # Chỉ lưu URL server để lần sau khỏi gõ lại — session ID/token không lưu ra đĩa
    # (giống nguyên tắc không lưu mật khẩu cổng BHYT của công cụ này).
    config["webapp_base_url"] = base_url
    try:
        (ROOT / "config.json").write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass

    try:
        records, stats = fetch_records_from_webapp(
            base_url, session_id, app_token,
            allowed_doctors=config.get("allowed_doctors", DEFAULT_DOCTORS),
        )
        result = store.import_records(records)
        return jsonify({
            **result,
            **stats,
            "recognized": len(records),
            "summary": store.summary(),
        })
    except WebAppError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": f"Không lấy được dữ liệu từ web app: {exc}"}), 500


@app.post("/api/records/<int:record_id>/fields")
def api_update_fields(record_id: int):
    payload = request.get_json(force=True) or {}
    updates = payload.get("fields", {})
    clean = {key: value for key, value in updates.items() if key in _UPDATE_FIELDS}
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


@app.get("/api/browser/captcha")
def api_browser_captcha():
    """Ảnh CAPTCHA (PNG base64) để hiện trong Data Hub; người dùng gõ ở Data Hub."""
    try:
        return jsonify(portal.get_captcha_image())
    except PortalError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": f"Không lấy được CAPTCHA: {exc}"}), 500


@app.post("/api/browser/refresh-captcha")
def api_browser_refresh_captcha():
    try:
        return jsonify(portal.refresh_captcha())
    except PortalError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": f"Không đổi được CAPTCHA: {exc}"}), 500


@app.post("/api/browser/login")
def api_browser_login():
    """Đăng nhập cổng từ máy chủ, CAPTCHA do người dùng gõ ở Data Hub."""
    payload = request.get_json(force=True) or {}
    facility_code = str(payload.get("facility_code", "")).strip()
    username = str(payload.get("username", "")).strip()
    password = str(payload.get("password", ""))
    captcha = str(payload.get("captcha", "")).strip()
    if not facility_code or not username or not password or not captcha:
        return jsonify({"error": "Cần nhập đủ Mã cơ sở KCB, tên đăng nhập, mật khẩu và CAPTCHA"}), 400
    try:
        return jsonify(portal.submit_login(facility_code, username, password, captcha))
    except PortalError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": f"Lỗi khi đăng nhập: {exc}"}), 500


@app.post("/api/browser/capture")
def api_browser_capture():
    """Lưu HTML + ảnh một trang của cổng (sau khi đăng nhập) để gửi cho kỹ thuật dựng
    tiếp phần tra cứu/nhập. Mặc định lấy các trang cần thiết."""
    payload = request.get_json(force=True) or {}
    pages = payload.get("pages") or [
        ["/ThongTuyenLSKCB/Index", "tra-cuu-the"],
        ["/PhuLuc3/CreateNew", "giay-ra-vien-03"],
        ["/PhuLuc07/CreateNew", "giay-nghi-07"],
    ]
    out = []
    try:
        for path, name in pages:
            out.append(portal.capture(str(path), str(name)))
        return jsonify({"captured": out, "dir": str(RUNTIME / "debug")})
    except PortalError as exc:
        return jsonify({"error": str(exc), "captured": out}), 400
    except Exception as exc:
        return jsonify({"error": f"Không lấy được trang: {exc}", "captured": out}), 500


@app.post("/api/browser/lookup-thong-tuyen")
def api_browser_lookup_thong_tuyen():
    """Tra cứu thông tuyến: nhập mã thẻ BHYT, họ tên, năm sinh. Luôn chụp trang kết quả."""
    payload = request.get_json(force=True) or {}
    ma_the = str(payload.get("ma_the", "")).strip()
    ho_ten = str(payload.get("ho_ten", "")).strip()
    nam_sinh = str(payload.get("nam_sinh", "")).strip()
    if not ma_the and not ho_ten:
        return jsonify({"error": "Cần ít nhất mã thẻ BHYT hoặc họ tên để tra cứu."}), 400
    try:
        return jsonify(portal.lookup_thong_tuyen(ma_the, ho_ten, nam_sinh))
    except PortalError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Lỗi khi tra cứu thông tuyến: {exc}"}), 500


@app.post("/api/browser/dump")
def api_browser_dump():
    payload = request.get_json(force=True) or {}
    name = str(payload.get("name", "trang-hien-tai")).strip() or "trang-hien-tai"
    try:
        return jsonify(portal.dump_page(name))
    except PortalError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        return jsonify({"error": f"Không lưu được trang: {exc}"}), 500


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


# ── EMR nội bộ: nhập giấy nghỉ (mục tiêu 2) ───────────────────────────────────
@app.get("/api/emr/status")
def api_emr_status():
    try:
        return jsonify(emr.session_status())
    except Exception as exc:  # noqa: BLE001
        return jsonify({"logged_in": False, "error": str(exc)})


@app.post("/api/emr/login")
def api_emr_login():
    payload = request.get_json(force=True) or {}
    username = str(payload.get("username", "")).strip()
    password = str(payload.get("password", ""))
    if not username or not password:
        return jsonify({"error": "Cần nhập tên đăng nhập và mật khẩu EMR"}), 400
    try:
        return jsonify(emr.login(username, password))
    except EmrError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Lỗi khi đăng nhập EMR: {exc}"}), 500


@app.post("/api/emr/open-cert")
def api_emr_open_cert():
    """Mở form giấy nghỉ cho một người bệnh (theo tên), CHƯA điền gì."""
    payload = request.get_json(force=True) or {}
    patient = str(payload.get("patient_name", "")).strip()
    record_id = payload.get("record_id")
    if not patient and record_id is not None:
        record = store.get_record(int(record_id))
        if record:
            patient = str(record.get("patient_name", "")).strip()
    if not patient:
        return jsonify({"error": "Thiếu tên người bệnh để mở form giấy nghỉ"}), 400
    try:
        return jsonify(emr.open_cert_for_patient(patient))
    except EmrError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Lỗi khi mở form giấy nghỉ: {exc}"}), 500


@app.post("/api/emr/capture")
def api_emr_capture():
    """Lưu HTML + ảnh form giấy nghỉ đang mở để gửi kỹ thuật khớp id."""
    payload = request.get_json(force=True) or {}
    name = str(payload.get("name", "form-giay-nghi")).strip() or "form-giay-nghi"
    try:
        return jsonify(emr.capture_cert(name))
    except EmrError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Không lưu được form: {exc}"}), 500


@app.post("/api/emr/read-cert")
def api_emr_read_cert():
    """ĐỌC dữ liệu form giấy nghỉ đang mở (không sửa gì trên EMR). Nếu có record_id thì
    bù các field đọc được vào hồ sơ để điền lên cổng BHXH."""
    payload = request.get_json(force=True) or {}
    record_id = payload.get("record_id")
    try:
        result = emr.read_cert()
        updated = False
        if record_id is not None and result.get("fields"):
            try:
                store.update_fields(int(record_id), result["fields"])
                updated = True
            except KeyError:
                return jsonify({"error": "Không tìm thấy hồ sơ để cập nhật"}), 404
        return jsonify({**result, "updated": updated})
    except EmrError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Lỗi khi đọc form giấy nghỉ: {exc}"}), 500


@app.post("/api/emr/read-phieu-pdf")
def api_emr_read_phieu_pdf():
    """Tự bấm "Xem phiếu" trên EMR cho một người bệnh, tải file PDF về và đọc.
    Nếu có record_id thì bù các field (đủ cả Số KCB, Số seri, CCCD) vào hồ sơ."""
    payload = request.get_json(force=True) or {}
    patient_name = str(payload.get("patient_name", "")).strip()
    record_id = payload.get("record_id")
    if not patient_name and record_id is not None:
        try:
            rec = store.get_record(int(record_id))
            patient_name = (rec or {}).get("patient_name", "")
        except (KeyError, ValueError):
            patient_name = ""
    if not patient_name:
        return jsonify({"error": "Thiếu tên người bệnh (chọn 1 hồ sơ hoặc gõ tên)."}), 400
    try:
        result = emr.read_phieu_pdf(patient_name)
        mergeable = {k: v for k, v in result.get("fields", {}).items() if k in _UPDATE_FIELDS}
        updated = False
        if record_id is not None and mergeable:
            try:
                store.update_fields(int(record_id), mergeable)
                updated = True
            except (KeyError, ValueError):
                return jsonify({"error": "Không tìm thấy hồ sơ để cập nhật"}), 404
        return jsonify({**result, "merged": mergeable, "updated": updated})
    except EmrError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Lỗi khi đọc phiếu từ EMR: {exc}"}), 500


@app.post("/api/emr/harvest-sick-leave")
def api_emr_harvest_sick_leave():
    """Cuối ngày: quét Danh sách Khám bệnh trên EMR → lọc ca còn tuổi lao động →
    ca nào có phiếu nghỉ (Xem phiếu) thì gom lại và nạp vào danh sách hồ sơ để
    nhập lên cổng. Người dùng không phải bấm vào từng người."""
    from bhyt.mapping import Record, validate_fields

    payload = request.get_json(silent=True) or {}
    try:
        out = emr.harvest_sick_leave(ref_year=payload.get("ref_year"), limit=payload.get("limit"))
    except EmrError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Lỗi khi quét danh sách khám: {exc}"}), 500

    records = []
    for item in out.get("found", []):
        fields = item.get("fields") or {}
        if not fields:
            continue
        rec = Record(doc_type=item.get("doc_type") or "BHXH07", source_file="EMR-phieu",
                     source_sheet="danh-sach-kham", source_row=0, fields=fields, raw={})
        rec.issues = validate_fields(rec.doc_type, fields)
        records.append(rec)
    imported = store.import_records(records) if records else {"added": 0, "updated": 0}
    return jsonify({
        "scanned": out.get("scanned", 0),
        "working_age": out.get("working_age", 0),
        "found": len(out.get("found", [])),
        **imported,
        "summary": store.summary(),
    })


@app.post("/api/emr/close")
def api_emr_close():
    emr.close()
    return jsonify({"message": "Đã đóng trình duyệt EMR"})


@app.post("/api/run")
def api_run():
    payload = request.get_json(force=True) or {}
    ids = [int(value) for value in payload.get("record_ids", [])]
    dry_run = bool(payload.get("dry_run", True))
    # Tự lấy dữ liệu phiếu từ EMR cho hồ sơ còn thiếu (người dùng không phải điền tay).
    auto_enrich = bool(payload.get("auto_enrich", False))
    if not ids:
        records = store.list_records(doc_type=payload.get("doc_type", ""))
        # Khi tự bù từ EMR thì lấy cả hồ sơ còn thiếu (worker sẽ bù trước khi nhập).
        ids = [item["id"] for item in records
               if item["status"] != "success" and (auto_enrich or item["ready"])]
    else:
        ids = list(dict.fromkeys(ids))
        selected = [store.get_record(record_id) for record_id in ids]
        selected = [record for record in selected if record]
        if not auto_enrich:
            not_ready = [record for record in selected if not record["ready"]]
            if not_ready:
                names = ", ".join(record["patient_name"] for record in not_ready[:3])
                extra = "…" if len(not_ready) > 3 else ""
                return jsonify({
                    "error": f"Có {len(not_ready)} hồ sơ thiếu dữ liệu: {names}{extra}. "
                             "Bật 'Tự lấy dữ liệu từ EMR' hoặc bấm Bổ sung trước."
                }), 400
        ids = [record["id"] for record in selected if record["status"] != "success"]
    if not ids:
        return jsonify({"error": "Không có hồ sơ sẵn sàng để chạy"}), 400
    if auto_enrich and not emr.session_status().get("logged_in"):
        return jsonify({"error": "Chưa đăng nhập EMR nội bộ để tự lấy dữ liệu phiếu."}), 400
    if not dry_run and payload.get("confirmation") != "NHẬP THẬT":
        return jsonify({"error": "Cần nhập đúng cụm từ NHẬP THẬT để xác nhận"}), 400
    try:
        status = portal.session_status()
        if not status.get("logged_in"):
            return jsonify({"error": "Chưa đăng nhập Cổng BHYT trên Chrome"}), 400
        worker.start(ids, dry_run=dry_run, delay_seconds=float(config.get("delay_seconds", 1.0)),
                     auto_enrich=auto_enrich)
        return jsonify({"message": "Đã bắt đầu", "count": len(ids), "dry_run": dry_run,
                        "auto_enrich": auto_enrich})
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
