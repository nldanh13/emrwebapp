# -*- coding: utf-8 -*-
"""Liều MỖI LẦN dùng (mg) của một dòng thuốc — để chọn cách pha theo liều (vd. Vancomycin 1 g
pha 200 ml, 500 mg pha 100 ml). Không đoán: thiếu hàm lượng hoặc số lọ/ống mỗi lần thì trả None.
"""
import re

_STRENGTH = re.compile(r'(\d+(?:[.,]\d+)?)\s*(mg|mcg|µg|g|gm|gam)\b(?!\s*/\s*ml)', re.IGNORECASE)
_UNIT_MG = {'mg': 1.0, 'mcg': 0.001, 'µg': 0.001, 'g': 1000.0, 'gm': 1000.0, 'gam': 1000.0}


def _num(value):
    try:
        return float(str(value).strip().replace(',', '.'))
    except (TypeError, ValueError):
        return None


def strength_mg(drug):
    """Hàm lượng MỘT lọ/ống/viên (mg) từ ham_luong rồi tên thuốc; None nếu không có."""
    for key in ('ham_luong', 'ten_thuoc', 'ten_hien_thi'):
        text = str((drug or {}).get(key) or '').split('+')[0]
        m = _STRENGTH.search(text)
        if m:
            n = _num(m.group(1))
            if n:
                return n * _UNIT_MG[m.group(2).lower()]
    return None


def units_per_dose(drug, hours_count=None):
    """Số lọ/ống mỗi lần: so_lo_moi_lan; không có thì tổng ngày / số cữ (chỉ khi chia hết nửa đơn vị)."""
    per = _num((drug or {}).get('so_lo_moi_lan'))
    if per and per > 0:
        return per
    total = _num((drug or {}).get('so_luong'))
    if not total or total <= 0:
        return None
    n = hours_count or 1
    value = total / n
    return value if float(value * 2).is_integer() else None


def dose_mg_per_administration(drug, hours_count=None):
    s = strength_mg(drug)
    u = units_per_dose(drug, hours_count)
    if s is None or u is None:
        return None
    return round(s * u, 3)
