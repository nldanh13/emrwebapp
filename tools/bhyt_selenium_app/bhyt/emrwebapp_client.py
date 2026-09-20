from __future__ import annotations

import re
import unicodedata
from typing import Any, Iterable

import requests

from .mapping import DOC_BHXH, DOC_GRV, Record, validate_fields


class WebAppError(RuntimeError):
    pass


def normalize_person_text(value: Any) -> str:
    """Phải khớp CHÍNH XÁC normalizeText() trong src/components/SickLeaveTab.jsx —
    dùng để dựng lại đúng key mà web app đã dùng để lưu trạng thái đã nộp/ghi chú,
    nên không dùng chung normalize_text() của mapping.py (hàm đó còn bỏ tiền tố
    "bs"/"ths"... để so tên bác sĩ, khác mục đích)."""
    text = "" if value is None else str(value)
    text = unicodedata.normalize("NFD", text)
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    text = text.replace("Đ", "D").replace("đ", "d")
    text = text.lower()
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _review_note(row: dict[str, Any]) -> str:
    return str(row.get("ra_soat_ghi_chu_bo_sung") or row.get("ghi_chu_bo_sung") or "").strip()


def review_has_issue(row: dict[str, Any]) -> bool:
    """Giống hệt reviewHasIssue() trong SickLeaveTab.jsx — dùng để bỏ qua ca BHXH
    đang báo thiếu gì (cần sửa trên EMR trước khi nhập lên cổng)."""
    try:
        if float(row.get("so_loi_ra_soat") or 0) > 0:
            return True
    except (TypeError, ValueError):
        pass
    return "thieu" in normalize_person_text(_review_note(row))


def _bhxh_state_key(row: dict[str, Any]) -> str:
    identity = (
        normalize_person_text(row.get("ho_ten"))
        or str(row.get("dong_nguon") or "")
        or str(row.get("ma_so_bh") or "")
        or "unknown"
    )
    return (
        f"bhxh-ngt::{identity}::{row.get('ngay_sinh') or ''}::"
        f"{row.get('dieu_tri_tu_ngay') or ''}::{row.get('dieu_tri_den_ngay') or ''}"
    )


def _grv_state_key(row: dict[str, Any]) -> str:
    identity = (
        normalize_person_text(row.get("ho_ten"))
        or str(row.get("dong_nguon") or "")
        or str(row.get("ma_y_te") or "")
        or "unknown"
    )
    return (
        f"bhxh-nt::{identity}::{row.get('ngay_sinh') or ''}::"
        f"{row.get('ngay_vao_vien') or ''}::{row.get('ngay_ra_vien') or ''}"
    )


def _val(row: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = row.get(key)
        if value not in (None, ""):
            return str(value)
    return ""


def _map_bhxh_row(row: dict[str, Any]) -> dict[str, str]:
    """Dịch tên field từ parse_bhxh_sick_leave_list.py (worker/) sang tên field
    nội bộ mà bhyt/portal.py đang dùng để điền form mẫu 07 — xem FIELD_MAP.md
    trong thư mục này nếu BHXH đổi tên cột và cần cập nhật lại 2 bên."""
    return {
        "ma_ct": _val(row, "ma_chung_tu"),
        "so_seri": _val(row, "so_seri"),
        "so_kcb": "",  # File BHXH xuất không có cột này — luôn cần bổ sung tay (nút "Bổ sung")
        "mau_so": _val(row, "mau_so") or "07",
        "ma_bhxh": _val(row, "ma_so_bh"),
        "ma_the": _val(row, "ma_the"),
        "ho_ten": _val(row, "ho_ten"),
        "ngay_sinh": _val(row, "ngay_sinh"),
        "gioi_tinh": _val(row, "gioi_tinh"),
        "ten_dv": _val(row, "don_vi"),
        "ngay_kcb": "",
        "chan_doan": _val(row, "chan_doan"),
        "tu_ngay": _val(row, "dieu_tri_tu_ngay"),
        "den_ngay": _val(row, "dieu_tri_den_ngay"),
        "ho_ten_cha": _val(row, "ho_ten_cha"),
        "ho_ten_me": _val(row, "ho_ten_me"),
        "nguoi_dai_dien": _val(row, "thu_truong"),
        "doctor_text": _val(row, "nguoi_hanh_nghe", "bac_si_trong_danh_sach"),
        "ngay_ct": _val(row, "ngay_chung_tu"),
        "loai_giay_to": "",
        "so_cccd": "",
        "ngaycap_cccd": "",
        "noicap_cccd": "",
    }


def _map_grv_row(row: dict[str, Any]) -> dict[str, str]:
    return {
        "ma_ct": _val(row, "so_luu_tru"),
        "so_seri": _val(row, "ma_y_te"),
        "ma_bhxh": _val(row, "ma_so_bh"),
        "ma_the": _val(row, "ma_the"),
        "ho_ten": _val(row, "ho_ten"),
        "ngay_sinh": _val(row, "ngay_sinh"),
        "ho_ten_me": _val(row, "ho_ten_me"),
        "ho_ten_cha": _val(row, "ho_ten_cha"),
        "gioi_tinh": _val(row, "gioi_tinh"),
        "nghe_nghiep": _val(row, "nghe_nghiep"),
        "ma_khoa": _val(row, "khoa"),
        "dan_toc": _val(row, "dan_toc"),
        "dia_chi": _val(row, "dia_chi"),
        "tu_ngay": _val(row, "ngay_vao_vien"),
        "den_ngay": _val(row, "ngay_ra_vien"),
        "dc_thainghen": _val(row, "dinh_chi_thai_nghen"),
        "tuoi_thai": _val(row, "tuoi_thai"),
        "chan_doan": _val(row, "chan_doan"),
        "pp_dieutri": _val(row, "phuong_phap_dieu_tri"),
        "ghi_chu": _val(row, "ghi_chu"),
        "nguoi_dai_dien": _val(row, "thu_truong_don_vi"),
        "doctor_text": _val(row, "truong_khoa", "bac_si_trong_danh_sach"),
        "ngay_ct": _val(row, "ngay_chung_tu"),
        "ngoaitru_tungay": _val(row, "dieu_tri_ngoai_tru_tu_ngay"),
        "ngoaitru_denngay": _val(row, "dieu_tri_ngoai_tru_den_ngay"),
        "loai_giay_to": "Không có giấy tờ",
        "so_cccd": "",
        "ngaycap_cccd": "",
        "noicap_cccd": "",
    }


def _get_json(base: str, path: str, headers: dict[str, str]) -> dict[str, Any]:
    try:
        resp = requests.get(f"{base}{path}", headers=headers, timeout=20)
    except requests.RequestException as exc:
        raise WebAppError(f"Không gọi được {path}: {exc}") from exc
    if resp.status_code == 401:
        raise WebAppError("Web app từ chối truy cập (401) — kiểm tra lại token EMR_APP_TOKEN nếu server có bật.")
    if not resp.ok:
        raise WebAppError(f"Web app trả lỗi {resp.status_code} ở {path}")
    try:
        return resp.json()
    except ValueError as exc:
        raise WebAppError(f"Phản hồi không phải JSON ở {path}: {exc}") from exc


def fetch_records_from_webapp(
    base_url: str,
    session_id: str,
    app_token: str = "",
    allowed_doctors: Iterable[str] | None = None,
    skip_flagged: bool = True,
    skip_submitted: bool = True,
) -> tuple[list[Record], dict[str, int]]:
    """Lấy dữ liệu đã rà soát từ tab "Nghỉ ốm" của emrwebapp (GET /api/sick-leave-import
    + /api/sick-leave-state) thay vì đọc lại file Excel — dùng đúng bảng đã khớp tên/đã
    lọc sẵn của app, tránh xử lý 2 lần 2 nơi. Không đụng gì tới Selenium/cổng BHYT; chỉ
    thay nguồn nạp Record so với load_records() (đọc Excel) trong mapping.py.
    """
    if not base_url.strip():
        raise WebAppError("Thiếu URL server web app.")
    if not session_id.strip():
        raise WebAppError("Thiếu Mã phiên (session ID) — lấy ở tab Nghỉ ốm trên web app.")

    base = base_url.strip().rstrip("/")
    headers = {"x-session-id": session_id.strip()}
    if app_token.strip():
        headers["x-app-token"] = app_token.strip()

    import_data = _get_json(base, "/api/sick-leave-import", headers)
    if import_data.get("status") != "ok":
        raise WebAppError(import_data.get("message") or "Không lấy được dữ liệu đã nhập từ web app.")
    imported = import_data.get("import") or {}
    outpatient = imported.get("outpatient") or []
    inpatient = imported.get("inpatient") or []
    if not outpatient and not inpatient:
        raise WebAppError(
            "Web app chưa có dữ liệu BHXH nào (import file .xlsx ở tab Nghỉ ốm trước, rồi thử lại)."
        )

    state_data = _get_json(base, "/api/sick-leave-state", headers)
    entries = state_data.get("entries") or {}

    allowed = {normalize_person_text(name) for name in allowed_doctors} if allowed_doctors else None

    records: list[Record] = []
    stats = {"skipped_issue": 0, "skipped_submitted": 0, "skipped_doctor": 0}

    def build(row: dict[str, Any], doc_type: str, sheet: str, state_key_fn, map_fn) -> None:
        if skip_flagged and review_has_issue(row):
            stats["skipped_issue"] += 1
            return
        if skip_submitted and entries.get(state_key_fn(row), {}).get("submitted"):
            stats["skipped_submitted"] += 1
            return
        fields = map_fn(row)
        doctor = normalize_person_text(fields.get("doctor_text"))
        if allowed and doctor not in allowed:
            stats["skipped_doctor"] += 1
            return
        try:
            source_row = int(row.get("dong_nguon") or 0)
        except (TypeError, ValueError):
            source_row = 0
        record = Record(
            doc_type=doc_type,
            source_file="web_app_sick_leave_import",
            source_sheet=sheet,
            source_row=source_row,
            fields=fields,
            raw=row,
        )
        record.issues = validate_fields(doc_type, fields)
        records.append(record)

    for row in outpatient:
        build(row, DOC_BHXH, "Ngoại trú", _bhxh_state_key, _map_bhxh_row)
    for row in inpatient:
        build(row, DOC_GRV, "Nội trú", _grv_state_key, _map_grv_row)

    return records, stats
