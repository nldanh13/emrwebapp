# -*- coding: utf-8 -*-
"""shared/date_utils.py — Tiện ích ngày/giờ dùng chung.

Thay thế các định nghĩa lặp lại trong:
  date_utils.py          → normalize_dmy(), parse_dmy()
  data_contract.py       → normalize_dmy() (inline copy)
  runtime_data_v2.py     → normalize_dmy() (inline copy)
  surgery_guard.py       → normalize_dmy(), parse_datetime()
  clinical_rules.py      → _normalize_dmy_date(), _extract_hhmm()
  generate_report.py     → _parse_dmy()
  vtyt_rules.py          → _parse_dmy()
  input_vtyt.py          → _parse_dmy()
  input_procedures.py    → _parse_date_dmy(), _parse_dt_from_text()
  hchanh_fetch.py        → _parse_dmy_str() (×3 lần ở dòng 2408/2609/3878)
  xu_ly_merge.py         → _extract_hhmm_any()
  main_worker.py         → _normalize_discharge_datetime()
  utils.py               → normalize_date()

Dùng:
  from shared.date_utils import (
      normalize_dmy, parse_dmy, parse_datetime_any,
      extract_hhmm, to_iso_date, iso_to_dmy,
  )
"""
from __future__ import annotations

import re
from datetime import datetime, date
from typing import Any, Optional


_DMY_FORMATS = ("%d/%m/%Y", "%d-%m-%Y", "%d/%m/%y", "%d-%m-%y")
_YEAR_FLOOR  = 2000
_YEAR_CEIL   = 2100


# ─── Chuẩn hoá ngày ─────────────────────────────────────────────────────────

def normalize_dmy(
    raw: Any,
    fallback: str = "",
    default_year: Optional[int] = None,
) -> str:
    """Chuẩn hoá ngày về ``dd/mm/YYYY``.

    Nhận:
      dd/mm/YYYY · dd-mm-YYYY · dd/mm/YY · YYYY-mm-dd · dd/mm (cần default_year)

    >>> normalize_dmy("18/06/2026")  → "18/06/2026"
    >>> normalize_dmy("2026-06-18")  → "18/06/2026"
    >>> normalize_dmy("18/06")       → "18/06/2026"  (nếu default_year=2026)
    """
    text = str(raw or "").strip()
    if not text:
        return fallback

    # ISO: yyyy-mm-dd hoặc yyyy/mm/dd
    m = re.match(r"^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$", text)
    if m:
        y, mo, d = int(m[1]), int(m[2]), int(m[3])
        if _is_valid_date(y, mo, d):
            return f"{d:02d}/{mo:02d}/{y:04d}"
        return fallback

    # dd/mm/YYYY hoặc dd-mm-YYYY
    m = re.match(r"^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$", text)
    if m:
        d, mo, y = int(m[1]), int(m[2]), int(m[3])
        if y < 100:
            y += 2000
        if _is_valid_date(y, mo, d):
            return f"{d:02d}/{mo:02d}/{y:04d}"
        return fallback

    # dd/mm không có năm
    m = re.match(r"^(\d{1,2})[/-](\d{1,2})$", text)
    if m:
        d, mo = int(m[1]), int(m[2])
        y = int(default_year or datetime.now().year)
        if _is_valid_date(y, mo, d):
            return f"{d:02d}/{mo:02d}/{y:04d}"
        return fallback

    # Thử strptime với các format đã biết
    for fmt in _DMY_FORMATS:
        try:
            return datetime.strptime(text, fmt).strftime("%d/%m/%Y")
        except ValueError:
            continue

    return fallback


def to_iso_date(raw: Any, fallback: str = "") -> str:
    """Chuyển ngày bất kỳ → YYYY-MM-DD (ISO 8601).

    >>> to_iso_date("18/06/2026")  → "2026-06-18"
    """
    dmy = normalize_dmy(raw, fallback="")
    if not dmy:
        return fallback
    m = re.match(r"(\d{2})/(\d{2})/(\d{4})", dmy)
    if m:
        return f"{m[3]}-{m[2]}-{m[1]}"
    return fallback


def iso_to_dmy(iso: Any, fallback: str = "") -> str:
    """Chuyển YYYY-MM-DD → dd/mm/YYYY.

    >>> iso_to_dmy("2026-06-18")  → "18/06/2026"
    """
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", str(iso or "").strip())
    if m:
        return f"{m[3]}/{m[2]}/{m[1]}"
    return fallback


# ─── Parse datetime ──────────────────────────────────────────────────────────

def parse_dmy(raw: Any) -> Optional[datetime]:
    """Parse chuỗi ngày thành datetime (00:00:00). None nếu không parse được."""
    dmy = normalize_dmy(raw, fallback="")
    if not dmy:
        return None
    try:
        return datetime.strptime(dmy, "%d/%m/%Y")
    except ValueError:
        return None


def parse_datetime_any(raw: Any, fallback_date: str = "") -> Optional[datetime]:
    """Parse chuỗi ngày/giờ linh hoạt, hỗ trợ nhiều định dạng EMR.

    Ví dụ input nhận được từ HIS:
      "18/06/2026 14:30"
      "14:30 18/06/2026"
      "18/06/2026"
      "2026-06-18T14:30:00"
    """
    text = str(raw or "").strip()
    if not text:
        return None

    # ISO datetime
    m = re.match(r"^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})", text)
    if m:
        try:
            return datetime.strptime(f"{m[1]} {m[2]}", "%Y-%m-%d %H:%M")
        except ValueError:
            pass

    # "HH:MM dd/mm/YYYY" hoặc "dd/mm/YYYY HH:MM"
    m = re.match(r"(\d{1,2}:\d{2})\s+(\d{1,2}/\d{1,2}/\d{4})", text)
    if m:
        try:
            return datetime.strptime(f"{m[2]} {m[1]}", "%d/%m/%Y %H:%M")
        except ValueError:
            pass

    m = re.match(r"(\d{1,2}/\d{1,2}/\d{4})\s+(\d{1,2}:\d{2})", text)
    if m:
        try:
            return datetime.strptime(f"{m[1]} {m[2]}", "%d/%m/%Y %H:%M")
        except ValueError:
            pass

    # Chỉ có ngày
    dt = parse_dmy(text)
    if dt:
        return dt

    # Chỉ có ngày, dùng fallback_date
    m = re.match(r"^(\d{1,2}:\d{2})$", text)
    if m and fallback_date:
        base = normalize_dmy(fallback_date)
        if base:
            try:
                return datetime.strptime(f"{base} {m[1]}", "%d/%m/%Y %H:%M")
            except ValueError:
                pass

    return None


# ─── Giờ / phút ─────────────────────────────────────────────────────────────

def extract_hhmm(raw: Any) -> str:
    """Trích xuất chuỗi HH:MM từ text. Trả về "" nếu không tìm thấy.

    >>> extract_hhmm("08:30 18/06/2026")  → "08:30"
    >>> extract_hhmm("lúc 14h30")         → "14:30"
    """
    text = str(raw or "")
    m = re.search(r"\b(\d{1,2}):(\d{2})\b", text)
    if m:
        return f"{int(m[1]):02d}:{m[2]}"
    m = re.search(r"\b(\d{1,2})\s*h\s*(\d{2})\b", text, re.IGNORECASE)
    if m:
        return f"{int(m[1]):02d}:{m[2]}"
    return ""


def hhmm_to_minutes(hhmm: str) -> Optional[int]:
    """Chuyển "HH:MM" → số phút trong ngày (0–1439).

    >>> hhmm_to_minutes("08:30")  → 510
    """
    m = re.match(r"^(\d{1,2}):(\d{2})$", str(hhmm or "").strip())
    if not m:
        return None
    return int(m[1]) * 60 + int(m[2])


def minutes_to_hhmm(minutes: int) -> str:
    """Chuyển số phút trong ngày → "HH:MM".

    >>> minutes_to_hhmm(510)  → "08:30"
    """
    minutes = int(minutes) % (24 * 60)
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def parse_hours_from_text(gio_dung: str) -> list[int]:
    """Trích xuất list giờ [0–23] từ chuỗi gio_dung.

    Hỗ trợ:
      "8 giờ, 16 giờ, 22 giờ"     → [8, 16, 22]
      "8h - 16h - 20h"             → [8, 16, 20]
      "03:35, 16 giờ"              → [3, 16]
      "sáng chiều tối"             → [8, 16, 20]
    """
    if not gio_dung:
        return []

    text = str(gio_dung)
    out: list[int] = []
    seen: set[int] = set()

    def _add(raw_h: Any) -> None:
        try:
            h = int(raw_h)
        except Exception:
            return
        if 0 <= h <= 23 and h not in seen:
            seen.add(h)
            out.append(h)

    # Nhóm gộp: "8-16-20 giờ"
    consumed: list[tuple[int, int]] = []
    for m in re.finditer(
        r"(?<![\\d/])((?:2[0-3]|[01]?\d)(?:\s*[-–—]\s*(?:2[0-3]|[01]?\d))+)\s*(?:giờ|gio|h)(?![a-zA-ZÀ-ỹ0-9])",
        text, re.IGNORECASE,
    ):
        consumed.append(m.span())
        for h in re.findall(r"(?:2[0-3]|[01]?\d)", m.group(1)):
            _add(h)

    def _in_consumed(pos: int) -> bool:
        return any(a <= pos < b for a, b in consumed)

    for m in re.finditer(
        r"(?P<hhmm>\b(?P<h1>[01]?\d|2[0-3]):(?P<m1>[0-5]\d)\b)"
        r"|(?P<hour>\b(?P<h2>[01]?\d|2[0-3])\s*(?:giờ|gio|h)(?![a-zA-ZÀ-ỹ0-9]))",
        text, re.IGNORECASE,
    ):
        if _in_consumed(m.start()):
            continue
        _add(m.group("h1") if m.group("hhmm") else m.group("h2"))

    if not out:
        for pat, h in [
            (r"\bsáng\b|\bsang\b", 8),
            (r"\btrưa\b|\btrua\b", 12),
            (r"\bchiều\b|\bchieu\b", 16),
            (r"\btối\b|\btoi\b", 20),
            (r"\bđêm\b|\bdem\b|\bkhuya\b", 22),
        ]:
            if re.search(pat, text, re.IGNORECASE):
                _add(h)

    return out


# ─── Internal ────────────────────────────────────────────────────────────────

def _is_valid_date(y: int, m: int, d: int) -> bool:
    try:
        date(y, m, d)
        return _YEAR_FLOOR <= y <= _YEAR_CEIL
    except ValueError:
        return False
