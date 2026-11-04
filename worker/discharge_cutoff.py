"""Mốc ra viện khi EMR chỉ cho NGÀY ra viện, chưa rõ GIỜ.

Không biết người bệnh rời khoa lúc nào nên chỉ sinh mục chăm sóc/dịch truyền tới
mốc cuối cùng có căn cứ trong ngày ra viện: giờ y lệnh muộn nhất của ngày đó
(lệnh ra viện nằm trong đó), tối thiểu 08:00 (cữ chăm sóc của ngày ra viện).

Cùng quy tắc với ``getInferredDischargeCutoff`` trong
``server/utils/patient_helpers/preview.js`` (màn "Xem trước khi nhập"); hai bên
dùng chung ca test ở ``tests/fixtures/discharge_unknown_time_cases.json``.
"""

import re
from datetime import datetime, timedelta
from typing import Any, Dict, Optional

DISCHARGE_DAY_MIN_EVIDENCE_HOUR = 8

_HHMM_RE = re.compile(r"\d{1,2}:\d{2}")
_DMY_RE = re.compile(r"(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})")


def _normalize_dmy(raw: Any) -> str:
    m = _DMY_RE.search(str(raw or ""))
    if not m:
        return ""
    year = int(m.group(3))
    if year < 100:
        year += 2000
    return f"{int(m.group(1)):02d}/{int(m.group(2)):02d}/{year}"


def _parse_dt(raw: Any, fallback_date: str = "") -> Optional[datetime]:
    text = str(raw or "")
    m = re.search(r"(\d{1,2}):(\d{2})\s+(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})", text)
    if m:
        hh, mi, dd, mo, yy = map(int, m.groups())
    else:
        m = re.search(r"(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\s+(\d{1,2}):(\d{2})", text)
        if m:
            dd, mo, yy, hh, mi = map(int, m.groups())
        else:
            hm = re.search(r"\b(\d{1,2}):(\d{2})\b", text)
            date = _normalize_dmy(fallback_date)
            if not hm or not date:
                return None
            dd, mo, yy = map(int, date.split("/"))
            hh, mi = int(hm.group(1)), int(hm.group(2))
    if yy < 100:
        yy += 2000
    try:
        return datetime(yy, mo, dd, hh, mi)
    except ValueError:
        return None


def inferred_discharge_cutoff(record: Dict[str, Any], work_date: str = "") -> Optional[Dict[str, datetime]]:
    """Trả về {"last_evidence", "cutoff"} hoặc None nếu không áp dụng.

    ``cutoff`` = ``last_evidence`` + 1 phút để dùng chung phép so "trước giờ ra
    viện" của luồng có giờ thật (mục đúng ``last_evidence`` vẫn được giữ).
    Chỉ áp dụng khi ngày ra viện trùng ngày làm và không có giờ ra viện nào.
    """
    if not isinstance(record, dict):
        return None
    ngay_lam = _normalize_dmy(work_date or record.get("ngay_lam"))
    if not ngay_lam:
        return None
    for ev in record.get("care_special_events") or []:
        if isinstance(ev, dict) and ev.get("type") == "discharge":
            if _HHMM_RE.search(str(ev.get("time_full") or ev.get("time_label") or "")):
                return None
    for key in ("ngay_ra_vien", "Ngày ra viện", "gio_ra_vien"):
        if _HHMM_RE.search(str(record.get(key) or "")):
            return None
    discharge_date = _normalize_dmy(
        record.get("ngay_ra_vien_date") or record.get("ngay_ra_vien") or record.get("Ngày ra viện")
    ) or (ngay_lam if record.get("ra_vien_hom_nay") else "")
    if not discharge_date or discharge_date != ngay_lam:
        return None

    dd, mo, yy = map(int, ngay_lam.split("/"))
    last_evidence = datetime(yy, mo, dd, DISCHARGE_DAY_MIN_EVIDENCE_HOUR, 0)
    for ev in record.get("raw_order_events") or []:
        if not isinstance(ev, dict):
            continue
        ev_date = _normalize_dmy(ev.get("ngay_lam") or ev.get("work_date") or ev.get("ngay")) or ngay_lam
        if ev_date != ngay_lam:
            continue
        raw = ev.get("gio_y_lenh") or ev.get("time") or ev.get("thoi_gian") or ev.get("tg_ylenh") or ev.get("tg_y_lenh")
        dt = _parse_dt(raw, ngay_lam)
        if dt and dt.date() == last_evidence.date() and dt > last_evidence:
            last_evidence = dt
    return {"last_evidence": last_evidence, "cutoff": last_evidence + timedelta(minutes=1)}
