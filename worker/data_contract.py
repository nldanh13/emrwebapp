# -*- coding: utf-8 -*-
"""data_contract.py — Chuẩn schema/key cho dữ liệu EMR.

Mục tiêu:
- Mọi record đã xử lý có khóa đồng bộ ổn định: patient_day_key = ma_bn::yyyy-mm-dd.
- Có encounter_key để tách các đợt điều trị khi cùng mã người bệnh quay lại.
- Tên file runtime có thứ tự pipeline rõ ràng.
- Worker vẫn đọc được file cũ khi chạy standalone.
"""
from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime
from typing import Any, Dict, Iterable, Mapping, Optional

try:
    from date_utils import dmy_to_iso, normalize_dmy
except Exception:  # pragma: no cover
    def normalize_dmy(raw: Any, fallback: Optional[str] = None, default_year: Optional[int] = None) -> str:
        return str(raw or fallback or "").strip()
    def dmy_to_iso(raw: Any) -> str:
        text = normalize_dmy(raw)
        try:
            return datetime.strptime(text, "%d/%m/%Y").strftime("%Y-%m-%d")
        except Exception:
            return str(raw or "").strip()

DATA_CONTRACT_VERSION = "emr-dashboard-data-v2.1.0"

CANONICAL_RUNTIME_FILES = {
    # Legacy-compatible canonical files used by existing UI/workers.
    "raw": os.path.join("data", "01_raw_patient_rows.json"),
    "selected": os.path.join("data", "02_selected_patient_rows.json"),
    "orders": os.path.join("data", "03_order_text_by_patient_day.json"),
    "classified": os.path.join("data", "04_classified_patient_day_records.json"),
    # Normalized v2 files. These are generated from the legacy files and avoid
    # repeated patient metadata / duplicate bridge-day records.
    "patients": os.path.join("data", "patients.json"),
    "board_state": os.path.join("data", "board_state.json"),
    "order_days": os.path.join("data", "order_days.json"),
    "classified_days": os.path.join("data", "classified_days.json"),
    "warnings": os.path.join("data", "warnings.json"),
    "indexes": os.path.join("data", "indexes.json"),
}

LEGACY_RUNTIME_FILES = {
    "raw": ["data_raw.json"],
    "selected": ["data_sorted.json"],
    "orders": ["KetQua_YLenh.json"],
    "classified": ["DuLieu_PhanLoai.json", "data_phan_loai_chuan_v16.json"],
}

ENCOUNTER_HINT_KEYS = (
    "encounter_key", "ma_luot_dieu_tri", "ma_dieu_tri", "so_vao_vien", "ma_vao_vien",
    "thoi_gian_vao_khoa", "tg_vao", "thoi_gian_vao", "admission_time", "T/G vào", "Thời gian vào khoa",
    "khoa_dieu_tri", "ten_khoa_dieu_tri", "khoa_chuyen_den", "department", "ward_name",
)


def stable_hash(value: Any) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def patient_id(record: Mapping[str, Any] | None) -> str:
    record = record or {}
    return str(
        record.get("ma_bn") or record.get("Mã BN") or record.get("Mã YT") or record.get("ma_yt") or
        record.get("MaBN") or record.get("Ma_BN") or record.get("mabn") or record.get("id") or ""
    ).strip()


def normalize_date_key(value: Any) -> str:
    """Chuẩn ngày nội bộ về ISO yyyy-mm-dd; nhận cả dd/mm/yyyy và yyyy-mm-dd."""
    return dmy_to_iso(value) or str(value or "").strip()


def display_date(value: Any) -> str:
    return normalize_dmy(value) or str(value or "").strip()


def encounter_key(record: Mapping[str, Any] | None) -> str:
    """Khóa đợt điều trị.

    Nếu EMR có mã lượt điều trị thì dùng trực tiếp. Nếu chưa có, tạo khóa ổn định
    từ mã BN + thời gian vào khoa + khoa điều trị. Nếu thiếu hint đợt điều trị thì
    fallback về ma_bn để không phá dữ liệu cũ.
    """
    record = record or {}
    pid = patient_id(record)
    if not pid:
        return ""
    explicit = str(record.get("encounter_key") or record.get("ma_luot_dieu_tri") or record.get("ma_dieu_tri") or record.get("so_vao_vien") or record.get("ma_vao_vien") or "").strip()
    if explicit:
        return explicit
    admission = str(record.get("thoi_gian_vao_khoa") or record.get("tg_vao") or record.get("thoi_gian_vao") or record.get("admission_time") or record.get("T/G vào") or record.get("Thời gian vào khoa") or "").strip()
    dept = str(record.get("ten_khoa_dieu_tri") or record.get("khoa_dieu_tri") or record.get("khoa_chuyen_den") or record.get("department") or record.get("ward_name") or "").strip()
    if admission or dept:
        return f"{pid}::enc::{stable_hash({'admission': admission, 'department': dept})}"
    return pid


def patient_day_key(record: Mapping[str, Any]) -> str:
    ma_bn = patient_id(record)
    ngay = normalize_date_key(record.get("ngay_lam") or record.get("Ngày làm") or record.get("ngay") or record.get("date") or "")
    return f"{ma_bn}::{ngay}" if ma_bn and ngay else stable_hash(record)


def order_signature(record: Mapping[str, Any]) -> str:
    payload = {
        "ma_bn": patient_id(record),
        "ngay_lam": normalize_date_key(record.get("ngay_lam") or record.get("ngay") or record.get("date") or ""),
        "bac_si": record.get("bac_si") or record.get("Bác sĩ") or "",
        "gio_y_lenh": record.get("gio_y_lenh") or "",
        "y_lenh": (record.get("nhap_cham_soc") or {}).get("y_lenh") or record.get("Y lệnh") or record.get("y_lenh") or "",
        "dien_bien": (record.get("nhap_cham_soc") or {}).get("dien_bien") or record.get("Diễn biến") or record.get("dien_bien") or "",
    }
    return stable_hash(payload)


def attach_record_contract(record: Dict[str, Any]) -> Dict[str, Any]:
    """Gắn metadata đồng bộ không phá cấu trúc cũ."""
    if not isinstance(record, dict):
        return record
    key = patient_day_key(record)
    ekey = encounter_key(record)
    record.setdefault("schema_version", DATA_CONTRACT_VERSION)
    record.setdefault("patient_day_key", key)
    record.setdefault("sync_key", key)
    if ekey:
        record.setdefault("encounter_key", ekey)
    dmy = display_date(record.get("ngay_lam") or record.get("ngay") or record.get("date") or "")
    iso = normalize_date_key(dmy)
    if iso:
        record.setdefault("work_date", iso)
    if dmy:
        record.setdefault("display_date", dmy)
    record.setdefault("order_signature", order_signature(record))
    meta = record.get("_meta") if isinstance(record.get("_meta"), dict) else {}
    meta.update({
        "schema_version": DATA_CONTRACT_VERSION,
        "patient_day_key": key,
        "encounter_key": ekey,
        "work_date": iso,
        "display_date": dmy,
        "order_signature": record.get("order_signature"),
    })
    record["_meta"] = meta
    return record


def first_existing_runtime_file(root_dir: str, logical_name: str) -> Optional[str]:
    candidates = []
    canonical = CANONICAL_RUNTIME_FILES.get(logical_name)
    if canonical:
        candidates.append(os.path.join(root_dir, canonical))
    candidates.extend(os.path.join(root_dir, x) for x in LEGACY_RUNTIME_FILES.get(logical_name, []))
    for path in candidates:
        if os.path.exists(path):
            return path
    return None


def build_manifest(root_dir: str) -> Dict[str, Any]:
    files = {}
    for logical, relpath in CANONICAL_RUNTIME_FILES.items():
        full = os.path.join(root_dir, relpath)
        files[logical] = {
            "path": relpath.replace(os.sep, "/"),
            "legacy": LEGACY_RUNTIME_FILES.get(logical, []),
            "exists": os.path.exists(full),
        }
    return {
        "schema": DATA_CONTRACT_VERSION,
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "files": files,
    }


__all__ = [
    "DATA_CONTRACT_VERSION", "CANONICAL_RUNTIME_FILES", "LEGACY_RUNTIME_FILES",
    "stable_hash", "patient_id", "normalize_date_key", "display_date", "encounter_key",
    "patient_day_key", "order_signature", "attach_record_contract",
    "first_existing_runtime_file", "build_manifest",
]
