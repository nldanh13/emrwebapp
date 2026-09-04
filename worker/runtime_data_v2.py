# -*- coding: utf-8 -*-
"""runtime_data_v2.py — Chuẩn hoá runtime để giảm lặp dữ liệu.

Module này tạo thêm schema v2 song song với các file legacy đang được UI dùng.
Nguyên tắc:
- Legacy array vẫn giữ để không phá frontend/worker cũ.
- Dữ liệu v2 được normalize thành map theo khóa ổn định, tránh append trùng.
- Bridge 00:00-06:59 của ngày hôm sau là segment của patient-day, không phải record mới.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

try:
    from date_utils import normalize_dmy
except Exception:  # pragma: no cover
    def normalize_dmy(raw: Any, fallback: Optional[str] = None, default_year: Optional[int] = None) -> str:
        return str(raw or fallback or "").strip()

DATA_SCHEMA_V2 = "emr-dashboard-data-v2.1.0"

PATIENT_META_KEYS = {
    "Mã BN", "Mã YT", "ma_bn", "ma_yt", "id",
    "Họ tên", "ho_ten", "name",
    "Tuổi", "tuoi", "age", "Giới tính", "gioi_tinh", "sex",
    "Đối tượng", "doi_tuong", "object_type",
    "Bác sĩ", "bac_si", "doctor",
    "Chẩn đoán", "chan_doan", "diagnosis",
    "T/G vào", "TG vào", "Tg vào", "Thời gian vào", "Thời gian vào khoa",
    "Ngày giờ vào khoa", "thoi_gian_vao_khoa", "tg_vao", "thoi_gian_vao", "admission_time",
    "Khoa chuyển đến", "Khoa điều trị", "Tên khoa điều trị", "khoa_chuyen_den",
    "khoa_dieu_tri", "ten_khoa_dieu_tri", "department", "ward_name",
    "lich_su_khoa_dieu_tri", "khoa_dieu_tri_history", "ward_admissions",
    "Xử trí", "xu_tri", "disposition",
    "Trạng thái", "trang_thai", "TrangThai", "status", "tinh_trang",
    "ngay_ra_vien", "gio_ra_vien", "ngay_ra_vien_date", "ra_vien_hom_nay",
    "surgery_out", "surgery_out_time", "surgery_out_reason",
}

ROOM_KEYS = ("Vi_Tri", "phong_giuong", "so_phong", "room")

RECORD_DEBUG_KEYS = {
    "raw_order_events",
    "_raw", "raw", "source_segments",
}

DRUG_DEBUG_KEYS = {
    "raw_text", "raw_drug_part", "raw_usage_line", "raw_usage_part",
    "raw_usage", "source_text", "matched_text", "line_index",
    "catalog_match_debug", "debug", "trace",
}


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def stable_hash(value: Any, length: int = 16) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:length]


def write_json_compact(path: str | os.PathLike[str], value: Any) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f"{p.name}.tmp-{os.getpid()}-{int(datetime.now().timestamp() * 1000)}")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, p)


def write_json_pretty(path: str | os.PathLike[str], value: Any) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f"{p.name}.tmp-{os.getpid()}-{int(datetime.now().timestamp() * 1000)}")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
    os.replace(tmp, p)


def read_json(path: str | os.PathLike[str], fallback: Any = None) -> Any:
    try:
        p = Path(path)
        if not p.exists():
            return fallback
        with p.open("r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return fallback


def patient_id(row: Mapping[str, Any] | None) -> str:
    row = row or {}
    return str(
        row.get("ma_bn") or row.get("Mã BN") or row.get("Mã YT") or row.get("ma_yt") or
        row.get("MaBN") or row.get("Ma_BN") or row.get("mabn") or row.get("id") or ""
    ).strip()


def encounter_key(row: Mapping[str, Any] | None) -> str:
    """Khóa đợt điều trị ổn định nhưng vẫn tương thích data cũ.

    Nếu có mã lượt điều trị/encounter thật thì dùng trực tiếp. Nếu không, dùng
    mã BN + hash của thời gian vào khoa/khoa điều trị. Nếu thiếu các hint này,
    fallback về patient_id để không làm vỡ patient_day_key cũ.
    """
    row = row or {}
    pid = patient_id(row)
    if not pid:
        return ""
    explicit = _first(row, ["encounter_key", "ma_luot_dieu_tri", "ma_dieu_tri", "so_vao_vien", "ma_vao_vien"])
    if explicit:
        return explicit
    admission = _first(row, ["thoi_gian_vao_khoa", "tg_vao", "thoi_gian_vao", "admission_time", "T/G vào", "Thời gian vào khoa"])
    dept = _first(row, ["ten_khoa_dieu_tri", "khoa_dieu_tri", "khoa_chuyen_den", "department", "ward_name"])
    if admission or dept:
        return f"{pid}::enc::{stable_hash({'admission': admission, 'department': dept})}"
    return pid


def _first(row: Mapping[str, Any], keys: Iterable[str], default: str = "") -> str:
    for key in keys:
        val = row.get(key)
        if val is not None and str(val).strip() != "":
            return str(val).strip()
    return default




ADMIN_TG_VAO_KEYS = [
    "tg_vao", "T/G vào", "TG vào", "Tg vào", "Thời gian vào", "Thời gian vào khoa",
    "Ngày giờ vào khoa", "Ngày vào khoa", "Giờ vào khoa", "Vào khoa",
    "thoi_gian_vao", "thoi_gian_vao_khoa", "admission_time",
]
ADMIN_KHOA_KEYS = [
    "khoa_chuyen_den", "Khoa chuyển đến", "Khoa chuyển", "Khoa đến", "Khoa nhận",
    "Khoa điều trị", "Tên khoa điều trị", "Khoa hiện tại", "khoa_den", "khoa_nhan",
    "khoa_dieu_tri", "ten_khoa_dieu_tri", "department", "ward_name",
]
ADMIN_TRANG_THAI_KEYS = [
    "trang_thai", "Trạng thái", "Trạng thái NB", "Tình trạng", "Tình trạng người bệnh",
    "TrangThai", "status", "tinh_trang",
]
ADMIN_XU_TRI_KEYS = ["xu_tri", "Xử trí", "XuTri", "Hướng xử trí", "disposition"]


def canonical_legacy_row(row: Mapping[str, Any], *, include_order_text: bool = False) -> Dict[str, Any]:
    """Rút gọn một record legacy về field chuẩn, bỏ alias lặp.

    Dùng cho các file legacy-compatible như 01_raw/02_selected/03_order_text.
    Các parser vẫn chấp nhận alias khi đọc, nhưng file runtime chỉ lưu một tên.
    """
    row = row or {}
    out: Dict[str, Any] = {}

    def put(name: str, value: Any) -> None:
        if value not in (None, "", [], {}):
            out[name] = str(value).strip() if isinstance(value, str) else value

    put("ma_bn", _first(row, ["ma_bn", "Mã BN", "Mã YT", "ma_yt", "MaBN", "Ma_BN", "mabn", "id"]))
    put("ma_yt", _first(row, ["ma_yt", "Mã YT", "MaYT", "Ma_YT"]))
    put("ho_ten", _first(row, ["ho_ten", "Họ tên", "Tên bệnh nhân", "name", "Ten_BN", "ten_bn"]))
    put("tuoi", _first(row, ["tuoi", "Tuổi", "age"]))
    put("gioi_tinh", _first(row, ["gioi_tinh", "Giới tính", "GT", "sex"]))
    put("doi_tuong", _first(row, ["doi_tuong", "Đối tượng", "object_type"]))
    put("bac_si", _first(row, ["bac_si", "Bác sĩ", "doctor"]))
    put("chan_doan", _first(row, ["chan_doan", "Chẩn đoán", "diagnosis"]))
    admission_time = _first(row, ADMIN_TG_VAO_KEYS)
    department_name = _first(row, ADMIN_KHOA_KEYS)
    put("tg_vao", admission_time)
    put("thoi_gian_vao_khoa", admission_time)
    put("khoa_chuyen_den", department_name)
    put("khoa_dieu_tri", department_name)
    put("ten_khoa_dieu_tri", department_name)
    ward_history = row.get("lich_su_khoa_dieu_tri") or row.get("khoa_dieu_tri_history") or row.get("ward_admissions")
    if isinstance(ward_history, list) and ward_history:
        out["lich_su_khoa_dieu_tri"] = ward_history
    put("xu_tri", _first(row, ADMIN_XU_TRI_KEYS))
    put("trang_thai", _first(row, ADMIN_TRANG_THAI_KEYS))
    put("Vi_Tri", _first(row, ["Vi_Tri", "phong_giuong", "so_phong", "room"]))

    for key in [
        "surgery_out", "surgery_out_time", "surgery_out_reason",
        "ngay_ra_vien", "gio_ra_vien", "ngay_ra_vien_date", "ra_vien_hom_nay",
        "ngay_tu", "ngay_den", "ngay_lam", "source_date", "bridge_source_date", "bridge_work_date",
    ]:
        if key in row and row.get(key) not in (None, "", [], {}):
            out[key] = row.get(key)

    if include_order_text:
        for key in ["Y lệnh", "Diễn biến", "source_segments"]:
            if key in row and row.get(key) not in (None, "", [], {}):
                out[key] = row.get(key)

    return out


def canonical_legacy_rows(rows: Any, *, include_order_text: bool = False) -> List[Dict[str, Any]]:
    if not isinstance(rows, list):
        return []
    return [canonical_legacy_row(r, include_order_text=include_order_text) for r in rows if isinstance(r, Mapping)]


def _normalize_date_dmy(value: Any, fallback: str = "") -> str:
    return normalize_dmy(value, fallback=fallback, default_year=datetime.now().year)


def dmy_to_iso(value: Any) -> str:
    dmy = _normalize_date_dmy(value)
    if not dmy:
        return ""
    try:
        return datetime.strptime(dmy, "%d/%m/%Y").strftime("%Y-%m-%d")
    except Exception:
        return str(value or "").strip()


def iso_to_dmy(value: Any) -> str:
    text = str(value or "").strip()
    try:
        return datetime.strptime(text, "%Y-%m-%d").strftime("%d/%m/%Y")
    except Exception:
        return _normalize_date_dmy(text)


def work_date_dmy(row: Mapping[str, Any] | None) -> str:
    row = row or {}
    return _normalize_date_dmy(row.get("ngay_lam") or row.get("Ngày làm") or row.get("ngay") or row.get("date") or "")


def patient_day_key(row_or_patient_id: Mapping[str, Any] | str, work_date: Any = None) -> str:
    if isinstance(row_or_patient_id, Mapping):
        pid = patient_id(row_or_patient_id)
        dmy = work_date_dmy(row_or_patient_id)
    else:
        pid = str(row_or_patient_id or "").strip()
        dmy = _normalize_date_dmy(work_date)
    date_iso = dmy_to_iso(dmy) or str(work_date or "").strip()
    return f"{pid}::{date_iso}" if pid and date_iso else ""


def encounter_day_key(row_or_encounter: Mapping[str, Any] | str, work_date: Any = None) -> str:
    """Khóa ngày theo đúng đợt điều trị, song song với khóa tương thích cũ."""
    if isinstance(row_or_encounter, Mapping):
        ekey = encounter_key(row_or_encounter)
        dmy = work_date_dmy(row_or_encounter)
    else:
        ekey = str(row_or_encounter or "").strip()
        dmy = _normalize_date_dmy(work_date)
    date_iso = dmy_to_iso(dmy) or str(work_date or "").strip()
    return f"{ekey}::{date_iso}" if ekey and date_iso else ""


def _record_text_hash(record: Mapping[str, Any]) -> str:
    return stable_hash({
        "y_lenh": str(record.get("Y lệnh") or record.get("y_lenh") or "").strip(),
        "dien_bien": str(record.get("Diễn biến") or record.get("dien_bien") or "").strip(),
    })


def is_empty_order_record(record: Mapping[str, Any] | None) -> bool:
    record = record or {}
    return not str(record.get("Y lệnh") or record.get("y_lenh") or "").strip() and not str(record.get("Diễn biến") or record.get("dien_bien") or "").strip()


def _segment_from_order_record(record: Mapping[str, Any], source_index: int = 0) -> Dict[str, Any]:
    work_date = work_date_dmy(record)
    source_date = _normalize_date_dmy(record.get("source_date") or record.get("bridge_source_date") or work_date, fallback=work_date)
    source_type = "bridge_00_07" if source_date and work_date and source_date != work_date else "main_day"
    return {
        "source_date": source_date,
        "source_date_iso": dmy_to_iso(source_date),
        "source_type": source_type,
        "has_content": not is_empty_order_record(record),
        "text_hash": _record_text_hash(record),
        "source_index": source_index,
    }


def _append_unique_segment(target: Dict[str, Any], segment: Dict[str, Any]) -> None:
    items = target.setdefault("source_segments", [])
    sig = (segment.get("source_date"), segment.get("source_type"), segment.get("text_hash"))
    for old in items:
        if (old.get("source_date"), old.get("source_type"), old.get("text_hash")) == sig:
            return
    items.append(segment)


def _merge_text(existing: str, incoming: str) -> str:
    a = str(existing or "").strip()
    b = str(incoming or "").strip()
    if not b:
        return a
    if not a:
        return b
    if b in a:
        return a
    if a in b:
        return b
    parts: List[str] = []
    seen = set()
    for block in (a + "\n" + b).split("\n"):
        line = block.rstrip()
        sig = line.strip()
        if sig and sig in seen:
            continue
        if sig:
            seen.add(sig)
        parts.append(line)
    return "\n".join(parts).strip()


def merge_order_records(records: Any, *, skip_empty: bool = False) -> List[Dict[str, Any]]:
    """Gộp record y lệnh theo patient-day, loại lặp do bridge ngày sau.

    Hàm trả về shape legacy list để pipeline cũ đọc được, nhưng bảo đảm không có
    hai record cùng (Mã BN, ngày làm). Source bridge được lưu trong
    ``source_segments`` của record chính.
    """
    if not isinstance(records, list):
        return []

    by_key: Dict[str, Dict[str, Any]] = {}
    order: List[str] = []

    for idx, item in enumerate(records):
        if not isinstance(item, dict):
            continue
        rec = copy.deepcopy(item)
        pid = patient_id(rec)
        dmy = work_date_dmy(rec)
        if not pid or not dmy:
            key = f"__fallback__::{idx}::{stable_hash(rec)}"
        else:
            key = patient_day_key(pid, dmy)
        empty = is_empty_order_record(rec)
        if skip_empty and empty and key not in by_key:
            continue

        segment = _segment_from_order_record(rec, idx)
        existing = by_key.get(key)
        if existing is None:
            rec["ngay_lam"] = dmy or rec.get("ngay_lam") or ""
            rec.setdefault("ma_bn", pid)
            rec["source_segments"] = []
            _append_unique_segment(rec, segment)
            by_key[key] = rec
            order.append(key)
            continue

        _append_unique_segment(existing, segment)
        if empty:
            continue

        existing["Y lệnh"] = _merge_text(existing.get("Y lệnh") or existing.get("y_lenh") or "", rec.get("Y lệnh") or rec.get("y_lenh") or "")
        existing["Diễn biến"] = _merge_text(existing.get("Diễn biến") or existing.get("dien_bien") or "", rec.get("Diễn biến") or rec.get("dien_bien") or "")
        # Bù metadata còn thiếu, không ghi đè thông tin đã có.
        for k, v in rec.items():
            if k in {"Y lệnh", "Diễn biến", "y_lenh", "dien_bien", "source_segments"}:
                continue
            if existing.get(k) in (None, "", [], {}):
                existing[k] = v

    return [by_key[k] for k in order]


def canonical_patient(row: Mapping[str, Any]) -> Dict[str, Any]:
    pid = patient_id(row)
    ekey = encounter_key(row)
    admission = _first(row, ADMIN_TG_VAO_KEYS)
    department = _first(row, ADMIN_KHOA_KEYS)
    return {
        "patient_id": pid,
        "encounter_key": ekey,
        "active": True,
        "medical_id": _first(row, ["Mã YT", "ma_yt", "medical_id"]),
        "name": _first(row, ["Họ tên", "ho_ten", "name"]),
        "age": _first(row, ["Tuổi", "tuoi", "age"]),
        "sex": _first(row, ["Giới tính", "gioi_tinh", "sex"]),
        "object_type": _first(row, ["Đối tượng", "doi_tuong", "object_type"]),
        "admission_time": admission,
        "ward_admission_time": admission,
        "department": department,
        "department_name": department,
        "doctor": _first(row, ["Bác sĩ", "bac_si", "doctor"]),
        "diagnosis": _first(row, ["Chẩn đoán", "chan_doan", "diagnosis"]),
        "status": _first(row, ["Trạng thái", "trang_thai", "TrangThai", "status", "tinh_trang"]),
        "disposition": _first(row, ["Xử trí", "xu_tri", "disposition"]),
        "discharge_date": _first(row, ["ngay_ra_vien", "ngay_ra_vien_date"]),
        "discharge_time": _first(row, ["gio_ra_vien"]),
    }


def _merge_patient(existing: Dict[str, Any], incoming: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(existing or {})
    for k, v in (incoming or {}).items():
        if v not in (None, "", [], {}) and out.get(k) in (None, "", [], {}):
            out[k] = v
    return out


def build_patients(raw_rows: Any = None, selected_rows: Any = None, classified_rows: Any = None, order_rows: Any = None) -> Dict[str, Any]:
    patients: Dict[str, Dict[str, Any]] = {}
    for rows in [raw_rows, selected_rows, order_rows, classified_rows]:
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict):
                continue
            pid = patient_id(row)
            if not pid:
                continue
            incoming = canonical_patient(row)
            incoming = {k: v for k, v in incoming.items() if v not in (None, "", [], {})}
            patients[pid] = _merge_patient(patients.get(pid, {}), incoming)
            patients[pid].setdefault("patient_id", pid)
    return {
        "schema_version": DATA_SCHEMA_V2,
        "updated_at": _now_iso(),
        "patients": dict(sorted(patients.items(), key=lambda kv: kv[0])),
    }


def build_board_state(selected_rows: Any = None) -> Dict[str, Any]:
    rows = selected_rows if isinstance(selected_rows, list) else []
    selected_ids: List[str] = []
    selected_encounter_keys: List[str] = []
    rooms: Dict[str, str] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        pid = patient_id(row)
        if not pid:
            continue
        if pid not in selected_ids:
            selected_ids.append(pid)
        ekey = encounter_key(row)
        if ekey and ekey not in selected_encounter_keys:
            selected_encounter_keys.append(ekey)
        room = _first(row, ROOM_KEYS)
        if room:
            rooms[pid] = room
    return {
        "schema_version": DATA_SCHEMA_V2,
        "updated_at": _now_iso(),
        "selected_patient_ids": selected_ids,
        "selected_encounter_keys": selected_encounter_keys,
        "room_assignments": rooms,
        "hidden_patient_ids": [],
        "sort_order": selected_ids[:],
    }


def build_order_days(order_rows: Any = None) -> Dict[str, Any]:
    merged = merge_order_records(order_rows if isinstance(order_rows, list) else [], skip_empty=False)
    patient_days: Dict[str, Dict[str, Any]] = {}
    encounter_days: Dict[str, Dict[str, Any]] = {}
    for row in merged:
        pid = patient_id(row)
        dmy = work_date_dmy(row)
        key = patient_day_key(pid, dmy)
        encounter_key_value = encounter_key(row)
        encounter_day = encounter_day_key(encounter_key_value, dmy)
        if not key:
            continue
        y = str(row.get("Y lệnh") or row.get("y_lenh") or "")
        db = str(row.get("Diễn biến") or row.get("dien_bien") or "")
        record = {
            "key": key,
            "encounter_day_key": encounter_day,
            "patient_id": pid,
            "encounter_key": encounter_key_value,
            "work_date": dmy_to_iso(dmy),
            "display_date": dmy,
            "segments": row.get("source_segments") or [_segment_from_order_record(row, 0)],
            "merged_text": {"y_lenh": y, "dien_bien": db},
            "content_hash": stable_hash({"y_lenh": y, "dien_bien": db}),
            "has_content": bool(y.strip() or db.strip()),
        }
        patient_days[key] = record
        if encounter_day:
            encounter_days[encounter_day] = {**record, "key": encounter_day, "legacy_patient_day_key": key}
    return {
        "schema_version": DATA_SCHEMA_V2,
        "updated_at": _now_iso(),
        "patient_days": dict(sorted(patient_days.items(), key=lambda kv: kv[0])),
        "encounter_days": dict(sorted(encounter_days.items(), key=lambda kv: kv[0])),
    }


def _strip_drug_debug(value: Any) -> Any:
    if isinstance(value, list):
        return [_strip_drug_debug(x) for x in value]
    if isinstance(value, dict):
        return {k: _strip_drug_debug(v) for k, v in value.items() if k not in DRUG_DEBUG_KEYS}
    return value


def _compact_classified_record(row: Mapping[str, Any]) -> Dict[str, Any]:
    pid = patient_id(row)
    dmy = work_date_dmy(row)
    key = patient_day_key(pid, dmy)
    compact: Dict[str, Any] = {
        "key": key,
        "encounter_day_key": encounter_day_key(row),
        "patient_id": pid,
        "encounter_key": encounter_key(row),
        "work_date": dmy_to_iso(dmy),
        "display_date": dmy,
        "source_order_hash": str(row.get("order_signature") or row.get("_meta", {}).get("order_signature") or ""),
        "care": copy.deepcopy(row.get("nhap_cham_soc") or {}),
        "medications": _strip_drug_debug(copy.deepcopy(row.get("thuoc") or {})),
        "procedures": copy.deepcopy(row.get("chi_dinh_dvkt") or []),
        "other_orders": copy.deepcopy(row.get("chi_dinh_khac") or row.get("y_lenh_khac") or {}),
        "supplies": copy.deepcopy(row.get("vtyt") or {"items": [], "warnings": [], "source": "pending_after_merge"}),
        "warnings": copy.deepcopy(row.get("processing_warnings") or []),
    }
    # Giữ một số trường nghiệp vụ tổng hợp nhưng bỏ metadata người bệnh/debug thô.
    for key2 in ["tong_hop_gio_dung", "loai_benh_nhan", "rule_log"]:
        if key2 in row:
            compact[key2] = copy.deepcopy(row.get(key2))
    return {k: v for k, v in compact.items() if v not in (None, "")}


def build_classified_days(classified_rows: Any = None) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    rows = classified_rows if isinstance(classified_rows, list) else []
    patient_days: Dict[str, Dict[str, Any]] = {}
    encounter_days: Dict[str, Dict[str, Any]] = {}
    debug_events: List[Dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        compact = _compact_classified_record(row)
        key = compact.get("key")
        if not key:
            continue
        patient_days[key] = compact
        encounter_day = compact.get("encounter_day_key")
        if encounter_day:
            encounter_days[encounter_day] = {**compact, "key": encounter_day, "legacy_patient_day_key": key}
        for ev in row.get("raw_order_events") or []:
            if isinstance(ev, dict):
                debug_events.append({"patient_day_key": key, "encounter_day_key": encounter_day, **ev})
    return {
        "schema_version": DATA_SCHEMA_V2,
        "updated_at": _now_iso(),
        "patient_days": dict(sorted(patient_days.items(), key=lambda kv: kv[0])),
        "encounter_days": dict(sorted(encounter_days.items(), key=lambda kv: kv[0])),
    }, debug_events


def _warning_signature(warning: Mapping[str, Any]) -> str:
    """Khử trùng warning theo nội dung nghiệp vụ, không theo metadata phụ.

    Cùng một cảnh báo có thể xuất hiện trong file *_warnings.json và trong
    ``processing_warnings`` của record. Bản gắn vào record thường có thêm
    ``patient_day_key`` nên nếu hash toàn bộ object sẽ bị đếm đôi.
    """
    keys = (
        "code",
        "level",
        "ngay_lam",
        "ma_bn",
        "gio_y_lenh",
        "ten_thuoc",
        "message",
    )
    return stable_hash({k: warning.get(k, "") for k in keys})


def build_warnings(classified_rows: Any = None, warnings_payload: Any = None) -> Dict[str, Any]:
    warnings: List[Dict[str, Any]] = []
    if isinstance(warnings_payload, dict) and isinstance(warnings_payload.get("warnings"), list):
        warnings.extend([x for x in warnings_payload.get("warnings") if isinstance(x, dict)])
    if isinstance(classified_rows, list):
        for row in classified_rows:
            if not isinstance(row, dict):
                continue
            for w in row.get("processing_warnings") or []:
                if isinstance(w, dict):
                    ww = dict(w)
                    ww.setdefault("patient_day_key", patient_day_key(row))
                    warnings.append(ww)
    seen = set()
    deduped = []
    for w in warnings:
        sig = _warning_signature(w)
        if sig in seen:
            continue
        seen.add(sig)
        deduped.append(w)
    return {
        "schema_version": DATA_SCHEMA_V2,
        "updated_at": _now_iso(),
        "count": len(deduped),
        "warnings": deduped,
    }


def write_jsonl(path: str | os.PathLike[str], rows: Iterable[Mapping[str, Any]]) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f"{p.name}.tmp-{os.getpid()}-{int(datetime.now().timestamp() * 1000)}")
    with tmp.open("w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
    os.replace(tmp, p)


def generate_runtime_v2_files(
    runtime_dir: str | os.PathLike[str],
    *,
    raw_path: Optional[str | os.PathLike[str]] = None,
    selected_path: Optional[str | os.PathLike[str]] = None,
    orders_path: Optional[str | os.PathLike[str]] = None,
    classified_path: Optional[str | os.PathLike[str]] = None,
    warnings_path: Optional[str | os.PathLike[str]] = None,
) -> Dict[str, Any]:
    """Sinh các file data v2 từ những file legacy hiện có."""
    root = Path(runtime_dir)
    data_dir = root / "data"
    debug_dir = root / "debug"

    raw_rows = read_json(raw_path or data_dir / "01_raw_patient_rows.json", [])
    selected_rows = read_json(selected_path or data_dir / "02_selected_patient_rows.json", [])
    order_rows = read_json(orders_path or data_dir / "03_order_text_by_patient_day.json", [])
    classified_rows = read_json(classified_path or data_dir / "04_classified_patient_day_records.json", [])
    warnings_payload = read_json(warnings_path or data_dir / "04_classified_patient_day_records_warnings.json", {})

    patients = build_patients(raw_rows, selected_rows, classified_rows, order_rows)
    board_state = build_board_state(selected_rows)
    order_days = build_order_days(order_rows)
    classified_days, debug_events = build_classified_days(classified_rows)
    warnings = build_warnings(classified_rows, warnings_payload)

    write_json_compact(data_dir / "patients.json", patients)
    write_json_compact(data_dir / "board_state.json", board_state)
    write_json_compact(data_dir / "order_days.json", order_days)
    write_json_compact(data_dir / "classified_days.json", classified_days)
    write_json_compact(data_dir / "warnings.json", warnings)
    if debug_events:
        write_jsonl(debug_dir / "order_events.jsonl", debug_events)

    indexes = {
        "schema_version": DATA_SCHEMA_V2,
        "updated_at": _now_iso(),
        "patients_count": len(patients.get("patients") or {}),
        "selected_count": len(board_state.get("selected_patient_ids") or []),
        "order_days_count": len(order_days.get("patient_days") or {}),
        "classified_days_count": len(classified_days.get("patient_days") or {}),
        "encounter_order_days_count": len(order_days.get("encounter_days") or {}),
        "encounter_classified_days_count": len(classified_days.get("encounter_days") or {}),
        "warnings_count": warnings.get("count", 0),
    }
    write_json_compact(data_dir / "indexes.json", indexes)
    return indexes


__all__ = [
    "DATA_SCHEMA_V2", "write_json_compact", "write_json_pretty", "read_json",
    "patient_id", "encounter_key", "patient_day_key", "encounter_day_key", "merge_order_records", "generate_runtime_v2_files",
    "build_patients", "build_board_state", "build_order_days", "build_classified_days",
    "build_warnings", "is_empty_order_record", "dmy_to_iso", "iso_to_dmy",
    "canonical_legacy_row", "canonical_legacy_rows",
]
