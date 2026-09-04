# -*- coding: utf-8 -*-
"""date_utils.py — Tiện ích ngày dùng chung cho worker.

Giữ riêng các helper này để tránh mỗi file tự parse ngày theo một kiểu khác nhau.
"""
from __future__ import annotations

from datetime import datetime, timedelta
import re
from typing import Any, Optional


_DMY_FORMATS = ("%d/%m/%Y", "%d-%m-%Y", "%d/%m/%y", "%d-%m-%y")


def normalize_dmy(raw: Any, fallback: Optional[str] = None, default_year: Optional[int] = None) -> str:
    """Chuẩn hoá ngày về ``dd/mm/YYYY``.

    Hỗ trợ:
    - dd/mm/YYYY, dd-mm-YYYY
    - dd/mm/YY, dd-mm-YY
    - dd/mm hoặc dd-mm, dùng ``default_year`` nếu truyền vào.
    """
    text = str(raw or "").strip()
    if not text:
        return fallback or ""

    # ISO yyyy-mm-dd / yyyy/mm/dd từ data v2 hoặc key mới.
    m_iso = re.match(r"^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$", text)
    if m_iso:
        y, m, d = map(int, m_iso.groups())
        try:
            datetime(y, m, d)
            return f"{d:02d}/{m:02d}/{y:04d}"
        except ValueError:
            return fallback or ""

    m_full = re.match(r"^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$", text)
    if m_full:
        d, m, y = map(int, m_full.groups())
        try:
            datetime(y, m, d)
            return f"{d:02d}/{m:02d}/{y:04d}"
        except ValueError:
            return fallback or ""

    m_short = re.match(r"^(\d{1,2})[/-](\d{1,2})$", text)
    if m_short:
        y = int(default_year or datetime.now().year)
        d, m = map(int, m_short.groups())
        return f"{d:02d}/{m:02d}/{y:04d}"

    for fmt in _DMY_FORMATS:
        try:
            return datetime.strptime(text, fmt).strftime("%d/%m/%Y")
        except ValueError:
            continue

    return fallback or ""


def parse_dmy(raw: Any) -> Optional[datetime]:
    text = normalize_dmy(raw)
    if not text:
        return None
    try:
        return datetime.strptime(text, "%d/%m/%Y")
    except ValueError:
        return None


def dmy_to_iso(raw: Any) -> str:
    dt = parse_dmy(raw)
    return dt.strftime("%Y-%m-%d") if dt else ""


def iso_to_dmy(raw: Any) -> str:
    return normalize_dmy(raw)


def add_days_dmy(raw: Any, days: int) -> str:
    dt = parse_dmy(raw)
    if not dt:
        return ""
    return (dt + timedelta(days=int(days))).strftime("%d/%m/%Y")


def previous_day_dmy(raw: Any) -> str:
    return add_days_dmy(raw, -1)


def work_date_for_timeline_date(date_full: str, bridge_end_date: Optional[str] = None) -> str:
    """Ngày làm việc dùng để nhập chăm sóc/dịch truyền cho một timeline date.

    Nếu ``date_full`` là ngày nối ca cuối cùng (bridge_end_date), y lệnh được
    giữ lại chỉ là các mốc trước 07:00 của ngày sau. Các mốc này thuộc tua trực
    của NGÀY TRƯỚC, vì downstream sẽ tự cộng ngày cho giờ 00/05/06.
    """
    date_norm = normalize_dmy(date_full)
    bridge_norm = normalize_dmy(bridge_end_date) if bridge_end_date else ""
    if date_norm and bridge_norm and date_norm == bridge_norm:
        return previous_day_dmy(date_norm) or date_norm
    return date_norm
