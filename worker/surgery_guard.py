# -*- coding: utf-8 -*-
"""Guard helpers for patients who have gone to the operating room.

Ward-side automation must behave differently from discharge handling:
- Before the patient actually leaves the ward, normal care/infusion entries are valid.
- From the surgery/"đi mổ" cutoff onward, the patient may disappear from the ward list
  (Đang thực hiện) and move to a surgery status, so ward-side tasks must be skipped.

The surgery guard is intentionally strict: a patient is considered same-day
pre-operative only when the SAME work date has both:
1. an actual surgery/PT service indication in ``chi_dinh_dvkt``; and
2. one of the following confirmations: an explicit PT marker in order history
   (e.g. "Mã PT: 0/1", "PT: 0/1", "PT: 1/1"), an explicit same-day
   surgery-out timestamp, or a clinical diễn-biến line that explicitly says the
   patient was transferred/went to surgery (e.g. "Chuyển mổ").
Planned surgery, PPPT in clinical notes, or UI labels alone must not block ward care.
"""
from __future__ import annotations

import re
import unicodedata
from datetime import datetime
from typing import Any, Dict, Optional, Tuple

DEFAULT_SURGERY_OUT_HHMM = "11:00"


def norm_text(value: Any) -> str:
    s = str(value or "").strip().lower()
    s = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    s = s.replace("đ", "d")
    return " ".join(s.split())


def normalize_dmy(raw: Any) -> str:
    s = str(raw or "").strip()
    m = re.search(r"(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})", s)
    if not m:
        return ""
    try:
        d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if y < 100:
            y += 2000
        return f"{d:02d}/{mo:02d}/{y:04d}"
    except Exception:
        return ""


def parse_datetime(raw: Any, fallback_date: str = "") -> Optional[datetime]:
    text = str(raw or "").strip()
    fallback_date = normalize_dmy(fallback_date) or str(fallback_date or "").strip()
    if not text:
        return None

    patterns = [
        r"(\d{1,2}):(\d{2})\s+(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})",
        r"(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\s+(\d{1,2}):(\d{2})",
    ]
    for idx, pat in enumerate(patterns):
        m = re.search(pat, text)
        if not m:
            continue
        try:
            if idx == 0:
                hh, mi, dd, mo, yy = map(int, m.groups())
            else:
                dd, mo, yy, hh, mi = map(int, m.groups())
            if yy < 100:
                yy += 2000
            return datetime(yy, mo, dd, hh, mi)
        except Exception:
            continue

    if fallback_date:
        m = re.search(r"\b(\d{1,2}):(\d{2})\b", text)
        if m:
            return parse_datetime(f"{int(m.group(1)):02d}:{int(m.group(2)):02d} {fallback_date}")
        m = re.search(r"\b(\d{1,2})\s*(?:h|gio|giờ)\b", norm_text(text))
        if m:
            return parse_datetime(f"{int(m.group(1)):02d}:00 {fallback_date}")
    return None


def fmt_datetime(dt: Optional[datetime]) -> str:
    return dt.strftime("%H:%M %d/%m/%Y") if dt else ""


SURGERY_SERVICE_PATTERNS = [
    r"\bcat\s+loc\b",
    r"\bphau\s+thuat\b",
    r"\bket\s+hop\s+xuong\b",
    r"\bthay\s+khop\b",
    r"\bnoi\s+soi\b",
    r"\bmo\s+(?:cat|ket|thay|noi|lay|rut|thao)\b",
]

SURGERY_OUT_PATTERNS = [
    r"\bchuyen\s+mo\b",
    r"\bdi\s+mo\b",
    r"\bdang\s+di\s+mo\b",
    r"\bdua\s+benh\s+nhan\s+di\s+mo\b",
    r"\bbenh\s+(?:du\s+kien\s+)?mo\b",
    r"\bgay\s+me\s+hoi\s+suc\b",
    r"\bgmhs\b",
    r"\bkhong\s+con\s+o\s+khoa\b",
    r"\bkhong\s+thay\s+o\s+dang\s+thuc\s+hien\b",
]

WARD_ACTIVE_PATTERNS = [
    r"\bdang\s+thuc\s+hien\b",
]

SURGERY_PLAN_PATTERNS = [
    r"\btrinh\s+duyet\s+mo\b",
    r"\bdu\s+kien\s+mo\b",
]

EXPLICIT_SURGERY_TIME_KEYS = [
    "surgery_out_time", "gio_di_mo", "thoi_gian_di_mo", "tg_di_mo",
    "gio_chuyen_mo", "thoi_gian_chuyen_mo", "tg_chuyen_mo",
    "ngay_gio_di_mo", "ngay_gio_chuyen_mo",
]

STATUS_KEYS = [
    "trang_thai", "TrangThai", "Trạng thái", "status", "tinh_trang", "Tình trạng",
    "xu_tri", "Xử trí",
]

STATUS_ONLY_KEYS = [
    "trang_thai", "TrangThai", "Trạng thái", "status", "tinh_trang", "Tình trạng",
]

# Yêu cầu nghiệp vụ: chỉ xem là BN chuẩn bị đi mổ trong ngày khi y lệnh
# của chính ngày đó có mã PT, ví dụ: "Mã PT: 0/1", "PT: 0/1" hoặc "PT: 1/1".
# Không dùng riêng chữ "Chuyển mổ"/"Dự kiến mổ" vì có thể là nút menu hoặc kế hoạch ngày mai.
PT_MARKER_RE = re.compile(
    r"\b(?:ma\s*)?(?:pt|pttt)\s*[:：]\s*\d+\s*/\s*\d+\b",
    flags=re.IGNORECASE,
)


def _matches_any(text: Any, patterns: list[str]) -> bool:
    blob = norm_text(text)
    if not blob:
        return False
    for pat in patterns:
        try:
            if re.search(pat, blob, flags=re.IGNORECASE):
                return True
        except re.error:
            continue
    return False


GENERIC_SURGERY_ACTION_LABELS = {
    # Nhãn nút/menu trên EMR, không phải nội dung lâm sàng.
    # Nếu các nhãn này bị scraper gom vào y_lệnh/diễn_biến, không được xem là BN đã đi mổ.
    "chuyen mo",
    "di mo",
    "phau thuat",
    "gay me hoi suc",
    "gmhs",
}


def _is_generic_surgery_action_label(value: Any) -> bool:
    text = norm_text(value)
    if not text:
        return True
    # Các nút thường chỉ có 1-3 từ, ví dụ: "Chuyển mổ".
    # Câu lâm sàng thật thường có thêm BN/ngày giờ/lý do.
    if text in GENERIC_SURGERY_ACTION_LABELS:
        return True
    return False


def _clinical_surgery_out_text_parts(record: Dict[str, Any]) -> list[str]:
    care = record.get("nhap_cham_soc") or {}
    ylk = record.get("y_lenh_khac") or {}
    raw_parts = [
        care.get("dien_bien") if isinstance(care, dict) else "",
        care.get("y_lenh") if isinstance(care, dict) else "",
    ]
    if isinstance(ylk, dict):
        raw_parts.extend(ylk.get("khac", []) or [])
        raw_parts.extend(ylk.get("moi_hoi_chan", []) or [])

    parts: list[str] = []
    for item in raw_parts:
        text = str(item or "").strip()
        if not text:
            continue
        # Chia theo dòng để loại riêng các nút/menu bị lẫn vào dữ liệu.
        for line in re.split(r"[\r\n]+", text):
            line = str(line or "").strip()
            if not line or _is_generic_surgery_action_label(line):
                continue
            parts.append(line)
    return parts


def _has_postop_receive(record: Dict[str, Any]) -> bool:
    if str(record.get("care_mode") or "").strip() == "postop_receive_day":
        return True
    for ev in record.get("care_special_events") or []:
        if isinstance(ev, dict) and str(ev.get("type") or "") == "postop_receive":
            return True
    return False


def _has_same_day_discharge(record: Dict[str, Any]) -> bool:
    if str(record.get("care_mode") or "").strip() == "discharge_day":
        return True
    for ev in record.get("care_special_events") or []:
        if isinstance(ev, dict) and str(ev.get("type") or "") == "discharge":
            return True
    return False


def _extract_surgery_service_dt(record: Dict[str, Any]) -> Optional[datetime]:
    record_date = normalize_dmy(record.get("ngay_lam"))
    best: Optional[datetime] = None
    for item in record.get("chi_dinh_dvkt") or []:
        if not isinstance(item, dict):
            continue
        name = item.get("ten") or item.get("name") or ""
        if not _matches_any(name, SURGERY_SERVICE_PATTERNS):
            continue
        dt = parse_datetime(item.get("gio") or item.get("time") or "", fallback_date=record_date)
        if not dt:
            continue
        if record_date and dt.strftime("%d/%m/%Y") != record_date:
            continue
        if best is None or dt < best:
            best = dt
    return best


def _surgery_indication_name(item: Any) -> str:
    if isinstance(item, str):
        return item.strip()
    if not isinstance(item, dict):
        return ""
    return str(
        item.get("ten")
        or item.get("name")
        or item.get("ten_dich_vu")
        or item.get("service_name")
        or item.get("noi_dung")
        or ""
    ).strip()


def _same_day_surgery_indication(record: Dict[str, Any]) -> Tuple[bool, str]:
    """Require an actual same-day PT/DVKT order, not a plan or PPPT note.

    ``chi_dinh_dvkt`` is populated only from the ``+ Chỉ định DVKT`` section of the
    order history. A surgical method mentioned in diễn biến/hội chẩn (PPPT),
    ``Trình duyệt mổ`` or ``Đánh dấu vị trí mổ`` therefore does not satisfy this gate.
    """
    record_date = normalize_dmy(record.get("ngay_lam"))
    if not record_date:
        return False, ""
    for item in record.get("chi_dinh_dvkt") or []:
        name = _surgery_indication_name(item)
        if not name or not _matches_any(name, SURGERY_SERVICE_PATTERNS):
            continue
        if isinstance(item, dict):
            raw_time = (
                item.get("gio")
                or item.get("time")
                or item.get("thoi_gian")
                or item.get("tg_ylenh")
                or item.get("tg_y_lenh")
                or ""
            )
            if str(raw_time or "").strip():
                dt = parse_datetime(raw_time, fallback_date=record_date)
                if dt and dt.strftime("%d/%m/%Y") != record_date:
                    continue
        return True, name
    return False, ""


def _has_surgery_text(record: Dict[str, Any]) -> bool:
    # Không dùng nguyên blob thô vì scraper có thể lẫn nhãn nút/menu như "Chuyển mổ".
    # Chỉ xem là ngữ cảnh đi mổ khi có câu lâm sàng thật, không phải label đơn lẻ.
    parts = _clinical_surgery_out_text_parts(record)
    if not parts:
        return False
    blob = "\n".join(parts)
    return _matches_any(blob, SURGERY_OUT_PATTERNS)


def _has_surgery_plan_text(record: Dict[str, Any]) -> bool:
    care = record.get("nhap_cham_soc") or {}
    blob = "\n".join([
        str(care.get("dien_bien") or "") if isinstance(care, dict) else "",
        str(care.get("y_lenh") or "") if isinstance(care, dict) else "",
    ])
    return _matches_any(blob, SURGERY_PLAN_PATTERNS)


def _status_blob(record: Dict[str, Any]) -> str:
    return " ".join(str(record.get(k) or "") for k in STATUS_ONLY_KEYS)


def _status_says_ward_active(record: Dict[str, Any]) -> bool:
    return _matches_any(_status_blob(record), WARD_ACTIVE_PATTERNS)


def _status_says_surgery(record: Dict[str, Any]) -> bool:
    # Chỉ dùng trường trạng thái thật của danh sách nội trú; không dùng Xử trí để tránh suy luận nhầm.
    return _matches_any(_status_blob(record), SURGERY_OUT_PATTERNS)


def _explicit_surgery_dt(record: Dict[str, Any]) -> Optional[datetime]:
    record_date = normalize_dmy(record.get("ngay_lam"))
    for key in EXPLICIT_SURGERY_TIME_KEYS:
        dt = parse_datetime(record.get(key), fallback_date=record_date)
        if dt:
            return dt
    return None


def _default_cutoff_dt(record: Dict[str, Any]) -> Optional[datetime]:
    record_date = normalize_dmy(record.get("ngay_lam"))
    if not record_date:
        return None
    return parse_datetime(f"{DEFAULT_SURGERY_OUT_HHMM} {record_date}")


def _same_record_date(record: Dict[str, Any], dt: Optional[datetime]) -> bool:
    record_date = normalize_dmy(record.get("ngay_lam"))
    return bool(record_date and dt and dt.strftime("%d/%m/%Y") == record_date)


def _event_date_from_raw_order(ev: Dict[str, Any], record_date: str) -> str:
    for key in ("ngay_lam", "work_date", "ngay"):
        d = normalize_dmy(ev.get(key))
        if d:
            return d
    dt = parse_datetime(ev.get("gio_y_lenh") or ev.get("time") or "", fallback_date=record_date)
    if dt:
        return dt.strftime("%d/%m/%Y")
    return record_date


def _event_dt_from_raw_order(ev: Dict[str, Any], record_date: str) -> Optional[datetime]:
    for key in ("gio_y_lenh", "time", "thoi_gian", "tg_ylenh", "tg_y_lenh"):
        dt = parse_datetime(ev.get(key), fallback_date=record_date)
        if dt:
            return dt
    return None


def _same_day_pt_marker_from_raw_orders(record: Dict[str, Any]) -> Tuple[bool, Optional[datetime], str]:
    """Find same-day surgery marker in raw order events.

    This is the safest source for ward input automation. A future planned surgery can be
    present in notes, but it must not suppress today's care unless today's order history
    contains the PT marker itself.
    """
    record_date = normalize_dmy(record.get("ngay_lam"))
    if not record_date:
        return False, None, ""
    best_dt: Optional[datetime] = None
    best_text = ""
    for ev in record.get("raw_order_events") or []:
        if not isinstance(ev, dict):
            continue
        text = " ".join(str(ev.get(k) or "") for k in ("text", "kq_text", "row_text", "dien_bien"))
        if not PT_MARKER_RE.search(text):
            continue
        ev_date = _event_date_from_raw_order(ev, record_date)
        if ev_date != record_date:
            continue
        dt = _event_dt_from_raw_order(ev, record_date)
        if best_dt is None or (dt and dt < best_dt):
            best_dt = dt
            best_text = text.strip()
    if best_dt or best_text:
        return True, best_dt, best_text[:180]
    return False, None, ""


def _same_day_pt_marker_from_text(record: Dict[str, Any]) -> Tuple[bool, Optional[datetime], str]:
    """Fallback when raw_order_events is unavailable.

    Only accepts text that contains both a same-date clue and a PT marker. This prevents
    notes like "dự kiến ngày mai mổ" from blocking today's care.
    """
    record_date = normalize_dmy(record.get("ngay_lam"))
    if not record_date:
        return False, None, ""
    care = record.get("nhap_cham_soc") or {}
    ylk = record.get("y_lenh_khac") or {}
    parts: list[str] = []
    if isinstance(care, dict):
        parts.extend([str(care.get("y_lenh") or ""), str(care.get("dien_bien") or "")])
    if isinstance(ylk, dict):
        parts.extend(str(x or "") for x in (ylk.get("khac") or []))
        parts.extend(str(x or "") for x in (ylk.get("moi_hoi_chan") or []))
    for raw in parts:
        for line in re.split(r"[\r\n]+", str(raw or "")):
            if not PT_MARKER_RE.search(line):
                continue
            line_date = normalize_dmy(line)
            if line_date and line_date != record_date:
                continue
            # Nếu dòng không có ngày riêng, chấp nhận fallback là ngày của bản ghi vì
            # nhap_cham_soc.y_lenh thường đã được tách theo ngày làm.
            dt = parse_datetime(line, fallback_date=record_date) or _default_cutoff_dt(record)
            return True, dt, line.strip()[:180]
    return False, None, ""


def _same_day_pt_marker(record: Dict[str, Any]) -> Tuple[bool, Optional[datetime], str]:
    found, dt, text = _same_day_pt_marker_from_raw_orders(record)
    if found:
        return found, dt, text
    return _same_day_pt_marker_from_text(record)


def _same_day_clinical_surgery_out_marker(record: Dict[str, Any]) -> Tuple[bool, str]:
    """Detect a true clinical same-day "Chuyển mổ/Đi mổ" note.

    This intentionally reads only ``nhap_cham_soc.dien_bien``. We do not inspect
    raw UI blobs or the medication/order text here because those sources can contain
    menu labels such as "Chuyển mổ". The caller additionally requires an actual
    same-day surgery service in ``chi_dinh_dvkt``; the two-factor combination keeps
    the guard conservative while covering real records whose order-history PT marker
    is unavailable after precheck/classification.
    """
    care = record.get("nhap_cham_soc") or {}
    if not isinstance(care, dict):
        return False, ""
    dien_bien = str(care.get("dien_bien") or "")
    if not dien_bien.strip():
        return False, ""

    patterns = [
        r"\bchuyen\s+mo\b",
        r"\bdi\s+mo\b",
        r"\bdua\s+benh\s+nhan\s+di\s+mo\b",
        r"\bchuyen\s+benh\s+nhan\s+.*\bmo\b",
    ]
    for raw_line in re.split(r"[\r\n]+", dien_bien):
        line = str(raw_line or "").strip()
        if not line:
            continue
        if _matches_any(line, patterns):
            return True, line[:180]
    return False, ""


def detect_surgery_out(record: Dict[str, Any]) -> Tuple[bool, Optional[datetime], str]:
    """Return (is_surgery_context_without_receive, cutoff_dt, reason).

    Strict two-factor rule for ward care:
    - Factor 1: same-day surgery/PT service in ``chi_dinh_dvkt``.
    - Factor 2: same-day PT marker in order history, explicit surgery-out timestamp,
      or a clinical diễn-biến line explicitly saying "Chuyển mổ/Đi mổ".
    - UI labels, PPPT in clinical notes and planned surgery alone never activate the guard.
    """
    if not isinstance(record, dict):
        return False, None, ""
    if _has_postop_receive(record):
        return False, None, ""
    if _has_same_day_discharge(record):
        return False, None, ""

    has_indication, indication_name = _same_day_surgery_indication(record)
    if not has_indication:
        return False, None, ""

    explicit_dt = _explicit_surgery_dt(record)
    if explicit_dt and _same_record_date(record, explicit_dt):
        reason = f"Có chỉ định PT cùng ngày: {indication_name}; có mốc chuyển mổ {fmt_datetime(explicit_dt)}"
        return True, explicit_dt, reason

    has_pt, pt_dt, pt_text = _same_day_pt_marker(record)
    if has_pt:
        cutoff = pt_dt or _default_cutoff_dt(record)
        reason = f"Có chỉ định PT cùng ngày: {indication_name}; y lệnh cùng ngày có mã PT"
        if pt_text:
            reason += f": {pt_text}"
        if cutoff:
            reason += f"; chặn thao tác tại khoa từ {fmt_datetime(cutoff)}"
        return True, cutoff, reason

    # Một số lần precheck/classification không còn giữ được dòng PT: x/y từ lịch sử
    # y lệnh, nhưng phần diễn biến lâm sàng của đúng ngày vẫn ghi rõ "Chuyển mổ".
    # Chỉ chấp nhận tín hiệu này khi đã có DVKT phẫu thuật cùng ngày; dùng giờ DVKT
    # làm cutoff thay vì một giờ mặc định để không giữ nhầm các phiếu sau mốc mổ.
    has_clinical_out, clinical_text = _same_day_clinical_surgery_out_marker(record)
    if has_clinical_out:
        cutoff = _extract_surgery_service_dt(record) or _default_cutoff_dt(record)
        reason = f"Có chỉ định PT cùng ngày: {indication_name}; diễn biến cùng ngày ghi chuyển/đi mổ"
        if clinical_text:
            reason += f": {clinical_text}"
        if cutoff:
            reason += f"; chặn thao tác tại khoa từ {fmt_datetime(cutoff)}"
        return True, cutoff, reason

    # Có chỉ định PT nhưng chưa có mã PT/mốc chuyển mổ: mới là kế hoạch hoặc chuẩn bị,
    # chưa đủ căn cứ khẳng định người bệnh đã rời khoa đi mổ.
    return False, None, ""


def annotate_record(record: Dict[str, Any]) -> Dict[str, Any]:
    """Attach surgery-out metadata used by preview and input workers."""
    if not isinstance(record, dict):
        return record
    is_out, cutoff, reason = detect_surgery_out(record)
    if not is_out:
        if str(record.get("care_mode") or "") == "surgery_out_day":
            record["care_mode"] = "normal"
        record.pop("surgery_out", None)
        return record
    record["surgery_out"] = True
    if cutoff:
        record["surgery_out_time"] = fmt_datetime(cutoff)
    record["surgery_out_reason"] = reason
    if not record.get("care_mode") or str(record.get("care_mode")) == "normal":
        record["care_mode"] = "surgery_out_day"
    return record


def surgery_cutoff(record: Dict[str, Any]) -> Tuple[bool, Optional[datetime], str]:
    return detect_surgery_out(record)


def should_skip_ward_input_at(record: Dict[str, Any], start_time: Any, end_time: Any = None) -> Tuple[bool, str, str]:
    """Return (skip, reason, cutoff_text) for one specific ward-side action."""
    is_out, cutoff, reason = detect_surgery_out(record)
    if not is_out or not cutoff:
        return False, "", ""
    record_date = normalize_dmy(record.get("ngay_lam"))
    start_dt = parse_datetime(start_time, fallback_date=record_date)
    end_dt = parse_datetime(end_time, fallback_date=record_date) if end_time else None
    cutoff_text = fmt_datetime(cutoff)
    if start_dt and start_dt >= cutoff:
        return True, f"{reason}; bỏ qua mốc {fmt_datetime(start_dt)} vì từ {cutoff_text} người bệnh có thể đã ở trạng thái đi mổ.", cutoff_text
    if end_dt and end_dt > cutoff:
        return True, f"{reason}; bỏ qua vì thời gian kết thúc {fmt_datetime(end_dt)} vượt mốc đi mổ {cutoff_text}.", cutoff_text
    return False, "", cutoff_text


def should_skip_ward_inputs(record: Dict[str, Any]) -> Tuple[bool, str, str]:
    """Legacy compatibility: no longer skips the whole patient.

    A patient may still have valid 08:00 care before going to surgery later.
    Use should_skip_ward_input_at() for each specific time.
    """
    is_out, cutoff, reason = detect_surgery_out(record)
    if not is_out:
        return False, "", ""
    return False, reason, fmt_datetime(cutoff)
