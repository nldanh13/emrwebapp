# -*- coding: utf-8 -*-
"""
worker/input_care_utils.py — Hàm tiện ích thuần tuý cho input_care.py.

Module này chỉ chứa các hàm KHÔNG phụ thuộc vào Selenium, file I/O hoặc
cấu hình runtime. Mục đích:
  - Dễ test độc lập (không cần Chrome, không cần EMR)
  - Tách logic nghiệp vụ khỏi automation UI

Import trong input_care.py:
    from input_care_utils import (
        _norm_free_text, _canon_hhmm, _canon_time_key, _dt_from_time_key,
        _time_field_matches, kiem_tra_noi_dung_cham_soc, kiem_tra_ten_trung_khop,
        them_cham_soc_mac_dinh, tao_thoi_gian_lap,
        _hhmm_minutes_from_text, _special_event_time_full, _special_event_hour,
        _special_event_default_dien_bien, _special_event_default_care,
        _special_event_nurse_shift_override, _care_job_sort_key,
        _has_surgical_context, _sanitize_postop_text,
    )
"""

import re
import json
import logging
from datetime import datetime, timedelta

from utils import chuan_hoa_unicode

LOG = logging.getLogger("cham_soc")

POSTOP_RECEIVE_CARE = "Nhận hồ sơ + Lấy dấu hiệu sinh tồn + Trình Bác sĩ trực + Hướng dẫn ăn uống nghỉ ngơi sau mổ"



# ── Chuẩn hoá text & giờ ─────────────────────────────────────────────────────

def _norm_free_text(s: str) -> str:
    """Chuẩn hoá text để so sánh nội dung: bỏ khoảng trắng thừa, chuẩn unicode."""
    s = chuan_hoa_unicode(s)
    s = s.replace("\r", "\n")
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n+", "\n", s)
    s = "\n".join([ln.strip() for ln in s.split("\n") if ln.strip()])
    return s


def _canon_hhmm(s: str) -> str:
    """Chuẩn hoá giờ: '8:00', '08:00', '08h00' → '08:00'."""
    if not s:
        return ""
    m = re.search(r"(\d{1,2})\s*[:h]\s*(\d{2})", str(s))
    if not m:
        return ""
    return f"{int(m.group(1)):02d}:{m.group(2)}"


def _canon_time_key(time_full: str) -> str:
    """Chuẩn hoá key 'HH:MM dd/mm/yyyy' để so khớp giữa Web và tool."""
    if not time_full:
        return ""
    s = str(time_full).strip().replace("\xa0", " ")
    mdate = re.search(r"(\d{2}/\d{2}/\d{4})", s)
    d = mdate.group(1) if mdate else ""
    hhmm = _canon_hhmm(s)
    if hhmm and d:
        return f"{hhmm} {d}"
    return s.strip()


def _dt_from_time_key(time_key: str):
    """Parse 'HH:MM dd/mm/yyyy' → datetime hoặc None."""
    try:
        tk = _canon_time_key(time_key)
        m = re.search(r"(\d{2}:\d{2})\s+(\d{2}/\d{2}/\d{4})", tk)
        if not m:
            return None
        return datetime.strptime(f"{m.group(1)} {m.group(2)}", "%H:%M %d/%m/%Y")
    except Exception as _e:
        LOG.debug(f"[except] {_e}")
        return None



def parse_care_cutoff_datetime(raw, fallback=None):
    """Parse mốc chặn chăm sóc về datetime local, hoặc trả fallback.

    Hỗ trợ định dạng UI đang gửi: ``HH:MM dd/mm/yyyy``.
    Đồng thời nhận một số định dạng phổ biến để tương thích dữ liệu cũ.
    """
    if isinstance(raw, datetime):
        return raw
    text = str(raw or "").strip()
    if not text:
        return fallback
    formats = (
        "%H:%M %d/%m/%Y",
        "%d/%m/%Y %H:%M",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%dT%H:%M:%S",
    )
    for fmt in formats:
        try:
            return datetime.strptime(text[:19] if fmt.endswith(":%S") else text, fmt)
        except Exception:
            continue
    parsed = _dt_from_time_key(text)
    return parsed if parsed is not None else fallback


def is_care_time_due(time_key, cutoff_dt) -> bool:
    """True khi mốc chăm sóc không nằm sau cutoff.

    Nếu không parse được thời gian thì giữ lại để tránh bỏ sót dữ liệu hợp lệ.
    """
    if cutoff_dt is None:
        return True
    dt_obj = _dt_from_time_key(time_key)
    if dt_obj is None:
        return True
    return dt_obj <= cutoff_dt


def min_care_cutoff(*values):
    """Lấy mốc sớm nhất trong các cutoff hợp lệ."""
    parsed = [parse_care_cutoff_datetime(v) for v in values]
    parsed = [x for x in parsed if x is not None]
    return min(parsed) if parsed else None

def _time_field_matches(val_time: str, target_time_str: str) -> bool:
    """So sánh giờ field txtThoiGianLap với time_str (không bị lệch '8:00' vs '08:00')."""
    v = _canon_hhmm(val_time)
    t = _canon_hhmm(target_time_str)
    return bool(v and t and v == t)


def _hhmm_minutes_from_text(raw) -> int | None:
    """Parse giờ từ chuỗi bất kỳ → số phút từ 00:00, hoặc None nếu không tìm được."""
    m = re.search(r"(\d{1,2}):(\d{2})", str(raw or ""))
    if not m:
        return None
    try:
        h = int(m.group(1))
        mi = int(m.group(2))
        if 0 <= h <= 23 and 0 <= mi <= 59:
            return h * 60 + mi
    except Exception:
        pass
    return None


# ── Kiểm tra nội dung & tên ──────────────────────────────────────────────────

def kiem_tra_noi_dung_cham_soc(cham_soc_hien_tai: str, noi_dung_mong_muon: str) -> bool:
    """So sánh nội dung chăm sóc hiện tại với mong muốn (chấp nhận khác biệt nhỏ).

    Điều kiện đạt: mỗi "mục" trong noi_dung_mong_muon xuất hiện trong cham_soc_hien_tai
    sau khi chuẩn hoá unicode và khoảng trắng.
    """
    actual   = _norm_free_text(cham_soc_hien_tai)
    expected = _norm_free_text(noi_dung_mong_muon)
    if not expected:
        return True
    if not actual:
        return False
    # Mỗi thành phần trên EMR thường được nối bằng dấu "+". Tách riêng để
    # kiểm tra chính xác từng mục nhưng vẫn chấp nhận thứ tự/ khoảng trắng khác.
    parts = re.split(r"\n|;|•|- |\s*\+\s*", expected)
    parts = [p.strip() for p in parts if p and p.strip()]
    if not parts:
        return expected in actual
    return all(p in actual for p in parts)


def kiem_tra_ten_trung_khop(ten_tren_web, danh_sach_ten_config) -> bool:
    """Kiểm tra tên trên web có khớp với danh sách tên config (so sánh unicode đã chuẩn hoá)."""
    web_norm = chuan_hoa_unicode(ten_tren_web)
    if isinstance(danh_sach_ten_config, str):
        danh_sach_ten_config = [danh_sach_ten_config]
    for name in danh_sach_ten_config:
        cfg_norm = chuan_hoa_unicode(name)
        if cfg_norm in web_norm or web_norm in cfg_norm:
            return True
    return False


# ── Logic chăm sóc ───────────────────────────────────────────────────────────

def them_cham_soc_mac_dinh(care_parts, gio, med_hours, add_default_vitals=True,
                            has_reserve_orders=False) -> list:
    """Bổ sung chăm sóc mặc định theo giờ (không trùng lặp).

    - Giờ có thuốc → thêm 'Thực hiện chỉ định thuốc'
    - Mốc 5h, 16h → thêm 'Lấy dấu hiệu sinh tồn'
    - Không tự thêm 'Dự trù thuốc' vào nội dung chăm sóc
    """
    out  = list(care_parts or [])
    seen = {chuan_hoa_unicode(x) for x in out if str(x or "").strip()}

    def _add(item):
        s = str(item or "").strip()
        if not s:
            return
        key = chuan_hoa_unicode(s)
        if key in seen:
            return
        seen.add(key)
        out.append(s)

    # has_reserve_orders được giữ trong chữ ký hàm để tương thích code cũ,
    # nhưng không còn dùng để sinh nội dung chăm sóc.
    if gio in set(med_hours or []):
        _add("Thực hiện chỉ định thuốc")
    if add_default_vitals and gio in [5, 16]:
        _add("Lấy dấu hiệu sinh tồn")

    return out


def _has_reserve_orders(entry) -> bool:
    """Kiểm tra BN có y lệnh dự trù (gio_y_lenh < 07:00) không."""
    thuoc = (entry or {}).get("thuoc") or {}
    for cat in ("dich_truyen", "thuoc_tiem", "thuoc_uong"):
        for item in (thuoc.get(cat) or []):
            gio_yl = str(item.get("gio_y_lenh") or "").strip()
            if not gio_yl:
                continue
            try:
                h = (int(gio_yl.split(":")[0]) if ":" in gio_yl
                     else int(gio_yl.replace("giờ", "").strip()))
                if h < 7:
                    return True
            except (ValueError, AttributeError):
                pass
    return False


def tao_thoi_gian_lap(target_hour: int, ngay_lam_viec: str) -> str:
    """Tạo chuỗi 'HH:MM dd/mm/yyyy' cho mốc giờ cần nhập chăm sóc."""
    dt_obj = datetime.strptime(ngay_lam_viec, "%d/%m/%Y")
    if target_hour in [0, 5, 6]:   # Giờ thuộc ngày hôm sau (ca đêm)
        dt_obj = dt_obj + timedelta(days=1)
    return f"{target_hour:02d}:00 {dt_obj.strftime('%d/%m/%Y')}"


def build_regular_care_hours(
    med_hours,
    actions_by_hour=None,
    action_care_labels_by_hour=None,
    *,
    is_postop_receive_day=False,
    is_discharge_day=False,
    is_admission_transfer_day=False,
):
    """Tạo tập giờ chăm sóc thường quy cho một ngày làm việc.

    Quy tắc quan trọng: không tự sinh 05-08-16 khi JSON của ngày đó không có
    bất kỳ tín hiệu chăm sóc thường quy nào. Điều này tránh tạo phiếu mới cho
    các ngày mà người bệnh đã chuyển/đi mổ và phần y lệnh ngày hiện tại đã rỗng.

    Các ngày đặc biệt vẫn giữ hành vi cũ:
    - nhận hậu phẫu: 16:00 + 05:00 hôm sau;
    - ra viện: 08:00 (sau đó guard ra viện sẽ cắt theo giờ thật);
    - nhận/chuyển khoa: cho phép baseline 05-08-16 rồi cắt theo giờ nhận khoa.
    """
    hours = {int(h) for h in (med_hours or set()) if isinstance(h, int) or str(h).isdigit()}
    has_regular_signal = bool(
        hours
        or (isinstance(actions_by_hour, dict) and actions_by_hour)
        or (isinstance(action_care_labels_by_hour, dict) and action_care_labels_by_hour)
    )

    if is_postop_receive_day:
        hours.update({5, 16})
    elif is_discharge_day:
        hours.add(8)
    elif has_regular_signal or is_admission_transfer_day:
        hours.update({5, 8, 16})

    return hours, has_regular_signal


# ── Sự kiện đặc biệt (nhập viện / ra viện / chuyển khoa) ─────────────────────

def _special_event_time_full(ev: dict, ngay_lam_viec: str) -> str:
    """Lấy time_full của sự kiện đặc biệt, fallback về time_label + ngày."""
    if not isinstance(ev, dict):
        return ""
    tf = str(ev.get("time_full") or "").strip()
    if tf:
        return tf
    tl = str(ev.get("time_label") or "").strip()
    if tl and ngay_lam_viec:
        return f"{tl} {ngay_lam_viec}"
    return tl


def _special_event_hour(ev: dict) -> int:
    """Lấy giờ (0-23) của sự kiện đặc biệt."""
    mins = _hhmm_minutes_from_text(
        (ev or {}).get("time_full") or (ev or {}).get("time_label")
    )
    return 0 if mins is None else int(mins // 60)


def _special_event_default_dien_bien(ev: dict) -> str:
    """Diễn biến mặc định theo loại sự kiện đặc biệt."""
    ev_type = (ev or {}).get("type") if isinstance(ev, dict) else ""
    if ev_type == "discharge":
        return "Người bệnh xuất viện"
    if ev_type in ("clinic_admission", "ward_receive", "interdepartment_receive"):
        return "Người bệnh tỉnh"
    return (
        "Khoa Ngoại Chấn Thương Chỉnh Hình và Thần Kinh nhận bệnh\n"
        "Người bệnh tỉnh\n"
        "Tiếp xúc tốt\n"
        "Da niêm hồng\n"
        "Mạch rõ, chi ấm\n"
        "Đau vết mổ\n"
        "Vết mổ chưa ghi nhận dịch thấm băng"
    )


def _special_event_default_care(ev: dict) -> str:
    """Chăm sóc mặc định theo loại sự kiện đặc biệt."""
    ev_type = (ev or {}).get("type") if isinstance(ev, dict) else ""
    if ev_type == "discharge":
        return "Hoàn tất hồ sơ ra viện + Cấp giấy ra viện + Cấp thuốc theo toa + Hướng dẫn tái khám"
    if ev_type == "clinic_admission":
        return "Hoàn tất hồ sơ nhập viện + Kính chuyển Khoa Ngoại Chấn Thương Chỉnh Hình và Thần Kinh + Hồ sơ"
    if ev_type == "ward_receive":
        return "Nhận hồ sơ + Lấy dấu hiệu sinh tồn + Trình Bác sĩ trực + Hướng dẫn nội quy khoa phòng + Thực hiện cận lâm sàng"
    if ev_type == "interdepartment_receive":
        return "Nhận hồ sơ + Lấy dấu hiệu sinh tồn + Trình Bác sĩ trực + Hướng dẫn nội quy khoa phòng"
    return POSTOP_RECEIVE_CARE


def _special_event_nurse_shift_override(ev: dict) -> str:
    """Chính sách điều dưỡng cho sự kiện đặc biệt: '' | 'work' | 'oncall'."""
    if not isinstance(ev, dict):
        return ""

    ev_type = str(ev.get("type") or "").strip().lower()

    # Các mốc nhận người bệnh/nhận chuyển khoa vẫn dùng lịch ca theo giờ bình thường:
    # 07:00-10:59, 13:00-16:59 -> người làm; 11:00-12:59, 17:00-06:59 -> người trực.
    # Bỏ qua nurse_shift_override cũ nếu file dữ liệu đã từng được tạo với rule ép người trực.
    if ev_type in ("clinic_admission", "ward_receive", "interdepartment_receive"):
        return ""

    forced = str(ev.get("nurse_shift_override") or ev.get("force_nurse_shift") or "").strip().lower()
    if forced in ("work", "oncall"):
        return forced
    return ""


# ── Sắp xếp & lọc ────────────────────────────────────────────────────────────

def _care_job_sort_key(job: dict):
    """Sort key cho danh sách job chăm sóc theo giờ."""
    tf = str((job or {}).get("time_str") or "")
    try:
        return datetime.strptime(tf, "%H:%M %d/%m/%Y")
    except Exception:
        mins = _hhmm_minutes_from_text(tf)
        return datetime(1900, 1, 1, int((mins or 0) // 60), int((mins or 0) % 60))


def _norm_no_accent_text(value) -> str:
    """Lowercase + bỏ dấu để match rule đơn giản."""
    try:
        import unicodedata
        s = str(value or "").lower().replace("đ", "d")
        s = unicodedata.normalize("NFD", s)
        s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
        return re.sub(r"\s+", " ", s).strip()
    except Exception as _e:
        LOG.debug(f"[except] {_e}")
        return str(value or "").lower()


def _has_postop_receive_context(entry_obj) -> bool:
    """Ca nhận/chuyển khoa nhưng thực chất là hậu phẫu/GMHS trả về khoa."""
    try:
        raw = json.dumps(entry_obj or {}, ensure_ascii=False)
    except Exception as _e:
        LOG.debug(f"[except] {_e}")
        raw = str(entry_obj or "")
    s = _norm_no_accent_text(raw)
    if not s:
        return False
    patterns = [
        r"\bhau\s+phau\b",
        r"\bsau\s+mo\b",
        r"\bphong\s+phau\s+thuat\b",
        r"\bgay\s+me\s+hoi\s+suc\b",
        r"\bgmhs\b",
        r"\bpt\s*0?1\b",
        r"\bvet\s+mo\b",
        r"\bket\s+hop\s+xuong\b",
        r"\bthay\s+khop\b",
        r"\bnoi\s+soi\b",
    ]
    return any(re.search(pat, s, flags=re.IGNORECASE) for pat in patterns)


def _has_surgical_context(entry_obj, actions_set=None) -> bool:
    """Heuristic: phát hiện ngữ cảnh phẫu thuật để cho phép nội dung 'vết mổ/sau mổ'."""
    actions_set = actions_set or set()
    if any(a in actions_set for a in ("THAY_BANG", "CAT_CHI", "THAO_BANG", "CHAM_SOC_VET_THUONG")):
        return True
    try:
        s = json.dumps(entry_obj or {}, ensure_ascii=False).lower()
    except Exception as _e:
        LOG.debug(f"[except] {_e}")
        s = str(entry_obj).lower()
    keywords = [
        "phẫu thuật", "hau phau", "hậu phẫu", "sau mổ", "vết mổ", "mo ", "mổ", "pt ",
        "phau thuat", "mổ lấy", "mổ nội soi", "mổ hở",
    ]
    return any(k in s for k in keywords)


def _sanitize_postop_text(text_in: str) -> str:
    """Bỏ các mảnh văn bản liên quan 'vết mổ/sau mổ' nếu không có ngữ cảnh phẫu thuật."""
    if not text_in:
        return text_in
    parts = [p.strip() for p in text_in.split(" + ")]
    kept  = [p for p in parts if "vết mổ" not in p.lower() and "sau mổ" not in p.lower()]
    return " + ".join(kept).strip()
