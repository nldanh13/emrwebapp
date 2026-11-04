# -*- coding: utf-8 -*-
"""Bỏ cữ thuốc đã trả lại khoa dược.

EMR ghi "x N" của thuốc là số còn lại sau khi trả, còn dòng cách dùng vẫn giữ
nguyên lịch ban đầu. Ví dụ block 05:00 04/11/2026:

    PARACETAMOL 10MG/ML x 1 (Túi) / TTM C g/p 8h - 16h - 22h.
    + Thuốc trả: -Paracetamol 10mg/ml x 2 Túi

Ban đầu kê 1 + 2 = 3 túi cho 3 cữ; sau khi trả 2 túi chỉ còn cữ 8h. Nếu giữ đủ
3 cữ, bước nhập dịch truyền sẽ nhập thừa 16h và 22h lên EMR.

Quy tắc: chỉ áp dụng khi thuốc có dòng trả cùng block. Số cữ còn lại =
số còn lại / (tổng ban đầu / số cữ); giữ các cữ đầu theo thứ tự y lệnh ghi.
"""
import re
import unicodedata

from xu_ly_config import parse_hours_from_gio_dung


def _fold(text):
    s = unicodedata.normalize("NFD", str(text or ""))
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    s = s.replace("đ", "d").replace("Đ", "D").upper()
    s = re.sub(r"\([^)]*\)", " ", s)
    s = re.sub(r"[^A-Z0-9%]+", " ", s)
    return " ".join(s.split())


def _qty(value):
    m = re.search(r"\d+(?:[.,]\d+)?", str(value or ""))
    if not m:
        return None
    try:
        return float(m.group(0).replace(",", "."))
    except ValueError:
        return None


def _same_drug(drug, returned):
    a = _fold(drug.get("ten_thuoc"))
    b = _fold(returned.get("ten_thuoc"))
    if not a or not b:
        return False
    return a == b or a.startswith(b + " ") or b.startswith(a + " ")


def _kept_gio_dung(gio_dung, hours, keep):
    parts = [p.strip() for p in str(gio_dung or "").split(",") if p.strip()]
    if len(parts) == len(hours):
        return ", ".join(parts[:keep])
    return ", ".join(f"{h} giờ" for h in hours[:keep])


def trim_returned_doses(drug_lists, returned_list, warnings=None):
    """Sửa tại chỗ gio_dung của thuốc trong ``drug_lists`` theo ``returned_list``.

    Trả về danh sách cảnh báo đã thêm (cũng được nối vào ``warnings`` nếu có).
    """
    added = []
    returned_list = [r for r in (returned_list or []) if isinstance(r, dict)]
    if not returned_list:
        return added
    for drugs in drug_lists or []:
        for drug in drugs or []:
            if not isinstance(drug, dict):
                continue
            hours = parse_hours_from_gio_dung(drug.get("gio_dung", ""))
            if len(hours) < 2:
                continue
            remaining = _qty(drug.get("so_luong"))
            if not remaining or remaining <= 0:
                continue
            returned_qty = 0.0
            for r in returned_list:
                if _same_drug(drug, r):
                    returned_qty += _qty(r.get("so_luong")) or 0.0
            if returned_qty <= 0:
                continue
            per_dose = (remaining + returned_qty) / len(hours)
            if per_dose <= 0:
                continue
            keep = int(remaining / per_dose + 1e-9)
            if keep < 1 or keep >= len(hours):
                continue
            kept_hours = hours[:keep]
            dropped = hours[keep:]
            drug["gio_dung_truoc_tra"] = drug.get("gio_dung", "")
            drug["gio_dung"] = _kept_gio_dung(drug.get("gio_dung", ""), hours, keep)
            drug["cu_bo_do_tra"] = dropped
            dose_map = drug.get("so_luong_moi_gio")
            if isinstance(dose_map, dict) and dose_map:
                drug["so_luong_moi_gio"] = {
                    k: v for k, v in dose_map.items() if _qty(k) is not None and int(_qty(k)) in kept_hours
                }
            name = drug.get("ten_thuoc") or ""
            # Nước cất chỉ là dung môi pha thuốc chính, thuốc chính đã có cảnh báo riêng.
            if "NUOC CAT" in _fold(name):
                continue
            warn = {
                "code": "RETURNED_DOSES_DROPPED",
                "level": "warning",
                "message": (
                    f"{name}: còn {_fmt_num(remaining)} sau khi trả {_fmt_num(returned_qty)}, "
                    f"chỉ giữ cữ {_fmt_hours(kept_hours)}, bỏ cữ {_fmt_hours(dropped)}. Kiểm tra lại y lệnh trước khi nhập."
                ),
                "gio_y_lenh": drug.get("gio_y_lenh", ""),
            }
            added.append(warn)
            if warnings is not None:
                warnings.append(warn)
    return added


def _fmt_num(x):
    return str(int(x)) if float(x).is_integer() else str(x).replace(".", ",")


def _fmt_hours(hours):
    return ", ".join(f"{h}h" for h in hours)


def split_discharge_prescription(record):
    """Tách toa ra viện khỏi thuốc uống trong viện của phiếu xuất viện.

    Thuốc uống trong phiếu bác sĩ cho xuất viện mà số lượng nhiều hơn số cữ
    một ngày (vd CEFUROXIM x 10 viên, sáng 1 tối 1) là thuốc mang về, không
    sinh cữ trong ngày. Chuyển sang record["toa_ra_vien"]. Trả về số thuốc đã tách.
    """
    thuoc = (record or {}).get("thuoc") or {}
    oral = thuoc.get("thuoc_uong") or []
    keep, moved = [], []
    for drug in oral:
        if not isinstance(drug, dict):
            keep.append(drug)
            continue
        qty = _qty(drug.get("so_luong"))
        per_day = len(parse_hours_from_gio_dung(drug.get("gio_dung", ""))) or 1
        if qty is not None and qty > per_day:
            drug["toa_ra_vien"] = True
            moved.append(drug)
        else:
            keep.append(drug)
    if not moved:
        return 0
    thuoc["thuoc_uong"] = keep
    toa = record.setdefault("toa_ra_vien", [])
    toa.extend(moved)
    record.setdefault("processing_warnings", []).append({
        "code": "DISCHARGE_PRESCRIPTION_SPLIT",
        "level": "info",
        "message": "Toa ra viện, không sinh cữ trong ngày: " + ", ".join(
            f"{d.get('ten_thuoc') or ''} x {d.get('so_luong') or ''}".strip() for d in moved
        ),
        "gio_y_lenh": moved[0].get("gio_y_lenh", ""),
    })
    return len(moved)
