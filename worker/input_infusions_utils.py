# -*- coding: utf-8 -*-
"""input_infusions_utils.py — Tiện ích thuần (không Selenium) cho input_infusions.

Gồm: logging, parse date/time, chuẩn bị dữ liệu JSON, chuẩn hoá tên thuốc/nhân sự.
"""
# -*- coding: utf-8 -*-
import time
import json
import os
import sys
import io
import re
import unicodedata
from urllib.parse import urlparse, urlencode, parse_qsl, urlunparse
from datetime import datetime, timedelta
from shared.json_io import read_json_critical
try:
    from selenium import webdriver
    from selenium.webdriver.common.by import By
    from selenium.webdriver.common.keys import Keys
    from selenium.webdriver.common.action_chains import ActionChains
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
    from selenium.common.exceptions import TimeoutException
except ModuleNotFoundError:  # Cho phép import/test các helper thuần khi máy chưa cài Selenium
    webdriver = By = Keys = ActionChains = WebDriverWait = EC = None  # type: ignore
    class TimeoutException(Exception):
        pass
from utils import (
    load_config, strip_accents, get_nurse_by_shift, 
    init_driver, login_emr
)
import logging
from shared.logging_utils import make_worker_logger
try:
    from clinical_rules import medication_skip_decision
except Exception:
    medication_skip_decision = None
# ==============================================================================
# 1) HỆ THỐNG & CẤU HÌNH
# ==============================================================================
def _ensure_stdio_utf8():
    """Dat encoding UTF-8 ma khong thay the sys.stdout/sys.stderr.

    Khong dung sys.stdout = io.TextIOWrapper(...) vi khi chay pytest,
    stdout/stderr dang duoc pytest capture bang file tam. Thay the wrapper
    co the lam dong file capture som va gay loi:
    ValueError: I/O operation on closed file.
    """
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name, None)
        try:
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(encoding="utf-8", line_buffering=True)
        except Exception:
            pass


_ensure_stdio_utf8()

# ==============================================================================
# LOGGING
# ==============================================================================
LOG, setup_logging = make_worker_logger(
    "dich_truyen",
    debug_env="DICH_TRUYEN_DEBUG",
    log_file_env="DICH_TRUYEN_LOG_FILE",
    log_file_prefix="dich_truyen",
)


def _log(msg, *args, level=logging.INFO, **kwargs):
    """Wrapper gọi LOG — giữ nguyên cú pháp _log(...) cũ."""
    if args:
        msg = str(msg) + " " + " ".join(str(a) for a in args)
    LOG.log(level, str(msg))

def _parse_date_dmy(s):
    s = (s or "").strip()
    if not s:
        return None
    try:
        return datetime.strptime(s, "%d/%m/%Y").date()
    except Exception:
        return None

def _parse_hhmm_minutes(s: str):
    """Trả về số phút từ 00:00 dựa trên chuỗi có HH:MM hoặc dạng '8 giờ'."""
    s = (s or "").strip()
    if not s:
        return None

    m = re.search(r"(\d{1,2})\s*:\s*(\d{2})", s)
    if m:
        hh = int(m.group(1)); mm = int(m.group(2))
        if 0 <= hh <= 23 and 0 <= mm <= 59:
            return hh * 60 + mm

    m = re.search(r"\b(\d{1,2})\s*giờ\b", s, flags=re.IGNORECASE)
    if m:
        hh = int(m.group(1))
        if 0 <= hh <= 23:
            return hh * 60

    m = re.search(r"\b(\d{1,2})\b", s)
    if m:
        hh = int(m.group(1))
        if 0 <= hh <= 23:
            return hh * 60

    return None


def _resolve_doctor_by_time(bac_si_theo_gio, time_str: str) -> str:
    """Chọn bác sĩ theo giờ y lệnh gần nhất <= giờ truyền."""
    if not isinstance(bac_si_theo_gio, dict) or not bac_si_theo_gio:
        return ""

    t = _parse_hhmm_minutes(time_str)
    if t is None:
        return ""

    parsed = []
    for k, v in bac_si_theo_gio.items():
        kk = _parse_hhmm_minutes(k)
        if kk is None:
            continue
        doc = (v or "").strip()
        if not doc:
            continue
        parsed.append((kk, doc))

    if not parsed:
        return ""

    parsed.sort(key=lambda x: x[0])

    # ưu tiên mốc gần nhất trước/đúng giờ truyền
    cand = [x for x in parsed if x[0] <= t]
    if cand:
        return cand[-1][1]
    # nếu không có mốc trước đó, lấy mốc sớm nhất
    return parsed[0][1]



def _read_targets(targets_path):
    """Đọc file targets JSON. Hỗ trợ:
      - patientIds: [...]
      - from/to: dd/mm/yyyy
      - selectedDates: [...]
      - patientDates: { ma_bn: [dd/mm/yyyy, ...] }
    """
    if not targets_path or not os.path.exists(targets_path):
        return set(), None, None, set(), {}
    try:
        obj = read_json_critical(targets_path, {}, expected_type=dict) or {}
        ids = obj.get("patientIds") or []
        if isinstance(ids, str):
            ids = [ids]
        ids_set = set(str(x).strip() for x in ids if str(x).strip())
        d_from = _parse_date_dmy(obj.get("from"))
        d_to = _parse_date_dmy(obj.get("to"))
        selected_dates = set()
        for raw in (obj.get('selectedDates') or []):
            parsed = _parse_date_dmy(raw)
            if parsed:
                selected_dates.add(parsed.strftime('%d/%m/%Y'))
        patient_dates = {}
        raw_map = obj.get('patientDates') or {}
        if isinstance(raw_map, dict):
            for pid, values in raw_map.items():
                key = str(pid).strip()
                if not key:
                    continue
                dates = set()
                for raw in (values or []):
                    parsed = _parse_date_dmy(raw)
                    if parsed:
                        dates.add(parsed.strftime('%d/%m/%Y'))
                if dates:
                    patient_dates[key] = dates
        return ids_set, d_from, d_to, selected_dates, patient_dates
    except Exception as exc:
        raise RuntimeError(f'Targets dịch truyền không hợp lệ: {exc}') from exc


def _parse_any_dt(raw, fallback_date=''):
    """Parse các chuỗi giờ/ngày thường gặp trong JSON: HH:MM dd/mm/YYYY hoặc chỉ HH:MM + ngày fallback."""
    text = str(raw or '').strip()
    fallback_date = str(fallback_date or '').strip()
    if not text:
        return None
    for fmt in (
        "%H:%M %d/%m/%Y", "%H:%M %d/%m/%y",
        "%H:%M %d-%m-%Y", "%H:%M %d-%m-%y",
        "%d/%m/%Y %H:%M", "%d/%m/%y %H:%M",
        "%d-%m-%Y %H:%M", "%d-%m-%y %H:%M",
    ):
        try:
            return datetime.strptime(text, fmt)
        except Exception:
            pass
    m = re.search(r"(\d{1,2}):(\d{2})\s+(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})", text)
    if m:
        try:
            hh, mi, dd, mo, yy = map(int, m.groups())
            if yy < 100:
                yy += 2000
            return datetime(yy, mo, dd, hh, mi)
        except Exception:
            return None
    if fallback_date:
        m = re.search(r"\b(\d{1,2}):(\d{2})\b", text)
        if m:
            return _parse_any_dt(f"{int(m.group(1)):02d}:{int(m.group(2)):02d} {fallback_date}")
    return None


def _resolve_discharge_dt(entry, entry_date_key=''):
    """Lấy mốc ra viện từ record nếu có xử trí ra viện."""
    if not isinstance(entry, dict):
        return None
    # Chỉ tạo mốc cắt dịch truyền khi có thời gian/ngày ra viện rõ ràng.
    # Chỉ riêng "Xử trí: Ra viện" chưa đủ, vì có ca chuẩn bị ra viện ngày mai
    # nhưng dữ liệu ngày đang lấy vẫn cần thực hiện y lệnh hôm nay.
    has_explicit_discharge_time = bool(entry.get('ngay_ra_vien') or entry.get('gio_ra_vien') or entry.get('ngay_ra_vien_date') or entry.get('Ngày ra viện'))
    if not has_explicit_discharge_time:
        return None

    candidates = [
        entry.get('ngay_ra_vien'),
        entry.get('Ngày ra viện'),
    ]
    date_part = str(entry.get('ngay_ra_vien_date') or entry_date_key or entry.get('ngay_lam') or '').strip()
    time_part = str(entry.get('gio_ra_vien') or '').strip()
    if time_part and date_part:
        candidates.insert(0, f"{time_part} {date_part}")
    for raw in candidates:
        dt = _parse_any_dt(raw, fallback_date=date_part)
        if dt:
            return dt
    return None


def _infusion_after_discharge_decision(item, discharge_dt, entry_date_key=''):
    """True nếu dịch truyền nằm sau giờ ra viện hoặc chạy lố qua mốc ra viện."""
    if not discharge_dt or not isinstance(item, dict):
        return False, ''
    start_dt = _parse_any_dt(item.get('tg_bat_dau') or item.get('gio_dung'), fallback_date=entry_date_key)
    end_dt = _parse_any_dt(item.get('tg_ket_thuc'), fallback_date=entry_date_key)
    med_name = item.get('ten_hien_thi') or item.get('ten_thuoc') or ''
    cutoff = discharge_dt.strftime('%H:%M %d/%m/%Y')
    if start_dt and start_dt >= discharge_dt:
        return True, f"Sau giờ ra viện {cutoff}, không thực hiện truyền dịch: {med_name}"
    if end_dt and end_dt > discharge_dt:
        return True, f"Dịch truyền kết thúc sau giờ ra viện {cutoff}, không thực hiện: {med_name}"
    return False, ''

# ==============================================================================
# 2) CHUẨN BỊ DỮ LIỆU
# ==============================================================================
def chuan_bi_du_lieu_json(json_path, patient_ids=None, date_from=None, date_to=None, selected_dates=None, patient_dates=None):
    """Đọc JSON và gom theo ma_bn -> list[dịch truyền cần nhập + task dọn bản sai].

    Điểm quan trọng:
    - Dịch truyền bị rule loại khỏi dữ liệu chuẩn vẫn cần được đưa vào cleanup task.
      Nếu không, bản dịch truyền sai đã nhập ở EMR từ lần chạy trước sẽ nằm lại mãi.
    - Nếu bệnh nhân không còn dịch truyền nào cần nhập nhưng còn cleanup task, vẫn phải mở BN để xóa.
    """
    patient_ids = patient_ids or set()
    selected_dates = selected_dates or set()
    patient_dates = patient_dates or {}
    try:
        if not os.path.exists(json_path):
            _log(f"[!] Không tìm thấy file: {json_path}")
            return {}

        raw_data = read_json_critical(json_path, [], expected_type=list)

        final_data = {}
        for entry in raw_data:
            ma_bn = str(entry.get('ma_bn', '')).strip()
            if not ma_bn:
                continue

            if patient_ids and ma_bn not in patient_ids:
                continue

            # lọc theo ngày làm (nếu có)
            entry_date_str = str(entry.get('ngay_lam') or '').strip()
            d = _parse_date_dmy(entry_date_str) if (date_from or date_to or selected_dates or patient_dates) else None
            if (date_from or date_to or selected_dates or patient_dates) and d is None:
                continue
            if date_from and d < date_from:
                continue
            if date_to and d > date_to:
                continue
            entry_date_key = d.strftime('%d/%m/%Y') if d else entry_date_str
            wanted_dates = patient_dates.get(ma_bn)
            if wanted_dates:
                if entry_date_key not in wanted_dates:
                    continue
            elif selected_dates:
                if entry_date_key not in selected_dates:
                    continue

            thuoc_obj = entry.get('thuoc') or {}
            discharge_dt = _resolve_discharge_dt(entry, entry_date_key)

            # Đánh dấu ngày mà script được quyền quản lý phiếu truyền dịch.
            # Dùng để dọn các dòng cũ/thừa trên EMR không còn nằm trong dữ liệu chuẩn
            # của ngày đang chạy, ví dụ Paracetamol/Tramadol từng bị nhập nhầm từ lần trước.
            # Chỉ dọn trong các ngày đã được lọc ở trên, không đụng tới ngày ngoài phạm vi.
            if entry_date_key:
                final_data.setdefault(ma_bn, [])
                if not any(x.get("__managed_date") and x.get("Managed_Date") == entry_date_key for x in final_data[ma_bn] if isinstance(x, dict)):
                    final_data[ma_bn].append({
                        "__managed_date": True,
                        "Managed_Date": entry_date_key,
                    })

            # 1) Cleanup các dịch truyền đã bị rule loại ở bước post-process.
            #    Ví dụ: thuốc sau mổ/trong mổ/SM, thuốc trước giờ nhận khoa.
            rule_log = entry.get('rule_log') or {}
            for sk in (rule_log.get('skipped_medications') or []):
                if not isinstance(sk, dict):
                    continue
                if str(sk.get('category') or '').strip() != 'dich_truyen':
                    continue
                _append_cleanup_tasks(
                    final_data,
                    ma_bn,
                    {
                        'ten_thuoc': sk.get('ten_thuoc') or '',
                        'tg_bat_dau': sk.get('gio_dung') or '',
                        'gio_dung': sk.get('gio_dung') or '',
                        'duong_dung_goc': sk.get('duong_dung_goc') or '',
                        'category': 'dich_truyen',
                    },
                    entry_date_key,
                    reason=sk.get('reason') or 'Dịch truyền đã bị rule loại khỏi dữ liệu chuẩn.',
                    source_category='rule_log.skipped_medications',
                )

            # 2) Cleanup riêng cho TRAMADOL khi hiện tại đã được phân loại là tiêm bắp.
            #    Nếu lần chạy trước từng nhập dạng TTM + NaCl, bản đó phải bị xóa.
            for inj in (thuoc_obj.get('thuoc_tiem') or []):
                if _looks_like_tramadol_im(inj):
                    _append_cleanup_tasks(
                        final_data,
                        ma_bn,
                        inj,
                        entry_date_key,
                        reason='TRAMADOL hiện tại là tiêm bắp/TB; xóa bản truyền cũ nếu còn trên EMR.',
                        source_category='thuoc_tiem.tramadol_tb',
                    )

            # 3) Dịch truyền còn hợp lệ để nhập.
            danh_sach_truyen = thuoc_obj.get('dich_truyen') or []

            for item in danh_sach_truyen:
                # Chặn phụ khi người dùng nhập dịch truyền từ dữ liệu runtime cũ chưa post-process lại.
                # Nếu bị chặn, không chỉ bỏ qua mà còn tạo cleanup task để xóa bản cũ đã nhập sai.
                if medication_skip_decision:
                    should_skip, meta = medication_skip_decision(item, "dich_truyen")
                    if should_skip:
                        _log(
                            f"[RULE][SKIP_INFUSION] {item.get('ten_hien_thi') or item.get('ten_thuoc') or ''} | "
                            f"{item.get('duong_dung_goc') or item.get('duong_dung') or ''} | "
                            f"{meta.get('reason') or 'Bỏ qua theo rule'}"
                        )
                        _append_cleanup_tasks(
                            final_data,
                            ma_bn,
                            item,
                            entry_date_key,
                            reason=meta.get('reason') or 'Dịch truyền bị bỏ qua theo rule.',
                            source_category='runtime.medication_skip_decision',
                        )
                        continue

                skip_discharge, discharge_reason = _infusion_after_discharge_decision(item, discharge_dt, entry_date_key)
                if skip_discharge:
                    _log(f"[RULE][SKIP_INFUSION_DISCHARGE] {discharge_reason}")
                    _append_cleanup_tasks(
                        final_data,
                        ma_bn,
                        item,
                        entry_date_key,
                        reason=discharge_reason,
                        source_category='runtime.discharge_guard',
                    )
                    continue

                bac_si_time = _resolve_doctor_by_time(entry.get('bac_si_theo_gio'), item.get('tg_bat_dau') or item.get('tg_ket_thuc') or item.get('gio_dung'))
                _the_tich = int(float(item.get('the_tich', 0) or 0))

                # Guard cuối trước Selenium:
                # TRASOLU/Tramadol pha NaCl là dịch truyền; 2ml trong tên 100mg/2ml
                # là thể tích ống thuốc, không phải thể tích túi truyền.
                _name_blob = _norm_text(" ".join([
                    str(item.get('ten_thuoc') or ''),
                    str(item.get('hoat_chat') or ''),
                    str(item.get('ten_hien_thi') or ''),
                ]))
                _route_blob = _norm_text(" ".join([
                    str(item.get('duong_dung') or ''),
                    str(item.get('duong_dung_goc') or ''),
                    str(item.get('raw_usage_line') or ''),
                ]))
                _dm = str(item.get('dung_moi') or '').upper().strip()
                _is_tramadol_nacl = (
                    ('tramadol' in _name_blob or 'trasolu' in _name_blob)
                    and (
                        _dm in ('NACL_0.9', 'SODIUM_0.9')
                        or 'nacl' in _route_blob
                        or 'natri clorid' in _route_blob
                        or 'sodium chloride' in _route_blob
                    )
                    and (
                        str(item.get('duong_dung') or '').upper().strip() == 'TTM'
                        or 'ttm' in _route_blob
                        or 'truyen' in _route_blob
                    )
                )
                if _is_tramadol_nacl and _the_tich < 50:
                    _bag_candidates = [
                        item.get('the_tich_lay_ml'),
                        item.get('the_tich_pha_du_ml'),
                        item.get('tui_dich_truyen_ml'),
                    ]
                    _bag_ml = 0
                    for _raw_bag in _bag_candidates:
                        try:
                            _v = int(float(_raw_bag or 0))
                        except Exception:
                            _v = 0
                        if _v >= 50:
                            _bag_ml = _v
                            break
                    if _bag_ml < 50:
                        _bag_ml = 100
                    _log(
                        f"[DATA_GUARD] {item.get('ten_thuoc') or 'TRAMADOL'}: "
                        f"đổi thể tích vận hành {_the_tich}ml -> {_bag_ml}ml vì pha NaCl TTM."
                    )
                    _the_tich = _bag_ml

                _full_name = _build_display_med_name(item)
                _search_name = _build_search_med_name(item)

                # Tốc độ truyền: chỉ đặt mặc định 30 giọt/phút khi là TTM.
                # TMC (tiêm mạch chậm) không có tốc độ giọt/phút — để trống tránh nhập sai.
                _toc_do_raw = str(item.get('toc_do') or '').strip()
                _duong_dung = str(item.get('duong_dung') or '').strip().upper()
                if not _toc_do_raw and _duong_dung == 'TTM':
                    _toc_do_raw = '30'

                final_data.setdefault(ma_bn, [])
                final_data[ma_bn].append({
                    "Search_Name": _search_name,
                    "Full_Name": _full_name,
                    "Ten_Thuoc_Goc": (item.get('ten_thuoc') or '').strip(),
                    "Hoat_Chat": (item.get('hoat_chat') or '').strip(),
                    "Dung_Moi": (item.get('dung_moi') or '').strip(),
                    "The_Tich": _the_tich,
                    "Toc_Do": _toc_do_raw,
                    "Bac_Si": (str(item.get("bac_si") or bac_si_time or entry.get("bac_si") or "").strip()),
                    "Time_Start_Str": (item.get('tg_bat_dau') or '').strip(),
                    "Time_End_Str": (item.get('tg_ket_thuc') or '').strip()
                })
        return final_data
    except Exception as e:
        _log(f"[!] Lỗi đọc JSON: {e}")
        return {}

# ==============================================================================
# 3) HÀM PHỤ: CHUẨN HÓA & SO SÁNH
# ==============================================================================
def _norm_text(s: str) -> str:
    if s is None:
        return ""
    s = str(s).strip().lower()
    s = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    s = " ".join(s.split())
    return s


def _norm_time_str(s: str) -> str:
    """Chuẩn hóa chuỗi giờ về dạng HH:MM dd/mm/YYYY nếu parse được.

    Hàm này được dùng ngay trong input_infusions_utils khi đọc JSON,
    nên phải nằm ở đây thay vì chỉ nằm trong infusion_cleanup.py.
    """
    s = str(s or "").strip()
    if not s:
        return ""

    for fmt in (
        "%H:%M %d/%m/%Y",
        "%H:%M %d/%m/%y",
        "%H:%M %d-%m-%Y",
        "%H:%M %d-%m-%y",
    ):
        try:
            dt = datetime.strptime(s, fmt)
            return dt.strftime("%H:%M %d/%m/%Y")
        except Exception:
            pass

    # Trường hợp thiếu số 0, ví dụ: 8:00 2/2/2026
    m = re.match(r"^(\d{1,2}):(\d{2})\s+(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$", s)
    if m:
        try:
            h, mi, d, mo, y = map(int, m.groups())
            if y < 100:
                y += 2000
            dt = datetime(y, mo, d, h, mi)
            return dt.strftime("%H:%M %d/%m/%Y")
        except Exception:
            pass

    return s


def _build_display_med_name(item):
    base = (item.get('ten_hien_thi') or item.get('ten_thuoc') or '').strip()
    if not base:
        return ''
    if item.get('tu_tuc') and not re.match(r'^\(\s*TT\s*\)', base, flags=re.IGNORECASE):
        return f"(TT) {base}"
    return base


def _build_search_med_name(item):
    base = (item.get('ten_thuoc') or item.get('ten_hien_thi') or '').strip()
    base = re.sub(r'^\(\s*TT\s*\)\s*', '', base, flags=re.IGNORECASE).strip()
    base = base.split('+')[0].strip()
    tokens = [t for t in re.split(r'\s+', base) if t]
    kept = []
    for tok in tokens:
        norm = _norm_text(tok)
        if re.search(r'\d', tok) and re.search(r'(mg|mcg|g|gram|ml|%|ui|iu)', norm, flags=re.IGNORECASE):
            break
        kept.append(tok)
    return (" ".join(kept).strip() or base).strip()


def _extract_times_for_cleanup(raw, fallback_date=''):
    """Tách các giờ cần dọn bản dịch truyền cũ.

    Hỗ trợ:
      - '16:00 24/04/2026'
      - '16:00 24-04-2026'
      - '20 giờ'
      - 'SM-16h-22h'
    Nếu chuỗi chỉ có giờ, dùng ngày làm của record làm fallback.
    """
    raw = str(raw or '').strip()
    fallback_date = str(fallback_date or '').strip()
    out = []

    def _add(dt_text):
        norm = _norm_time_str(dt_text)
        if norm and norm not in out:
            out.append(norm)

    # Có đủ giờ + ngày.
    for m in re.finditer(r"\b(\d{1,2})\s*:\s*(\d{2})\s+(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b", raw):
        hh, mi, dd, mo, yy = m.groups()
        yy = int(yy)
        if yy < 100:
            yy += 2000
        _add(f"{int(hh):02d}:{int(mi):02d} {int(dd):02d}/{int(mo):02d}/{yy:04d}")

    if out:
        return out

    if not fallback_date:
        return out

    # Chỉ có giờ, ví dụ 16:00.
    for m in re.finditer(r"\b(\d{1,2})\s*:\s*(\d{2})\b", raw):
        hh, mi = int(m.group(1)), int(m.group(2))
        if 0 <= hh <= 23 and 0 <= mi <= 59:
            _add(f"{hh:02d}:{mi:02d} {fallback_date}")

    # Dạng 20 giờ, 20h, SM-16h-22h.
    for m in re.finditer(r"(?<!\d)(\d{1,2})\s*(?:h|giờ|gio)\b", raw, flags=re.IGNORECASE):
        hh = int(m.group(1))
        if 0 <= hh <= 23:
            _add(f"{hh:02d}:00 {fallback_date}")

    return out


def _cleanup_display_name(obj):
    """Lấy tên thuốc/dịch để tìm và xóa bản truyền cũ."""
    if not isinstance(obj, dict):
        return ''
    name = (
        obj.get('ten_hien_thi') or obj.get('ten_thuoc') or obj.get('Full_Name') or
        obj.get('ten') or obj.get('name') or ''
    )
    name = str(name or '').strip()
    if obj.get('tu_tuc') and name and not re.match(r'^\(\s*TT\s*\)', name, flags=re.IGNORECASE):
        name = f"(TT) {name}"
    return name


def _append_cleanup_tasks(final_data, ma_bn, obj, entry_date_key='', reason='', source_category=''):
    """Thêm task xóa bản dịch truyền cũ đã bị rule loại khỏi dữ liệu chuẩn.

    Không tạo cleanup task cho thuốc tự túc (tu_tuc=True) — đây là thuốc bệnh nhân tự mua,
    không được xóa tự động dù không nằm trong dữ liệu chuẩn hiện tại.
    """
    if not ma_bn or not isinstance(obj, dict):
        return

    # Bảo vệ thuốc tự túc: không xoá tự động
    if obj.get("tu_tuc"):
        return

    name = _cleanup_display_name(obj)
    if not name:
        return

    time_sources = [
        obj.get('tg_bat_dau'),
        obj.get('Time_Start_Str'),
        obj.get('gio_dung'),
        obj.get('gio'),
        obj.get('duong_dung_goc'),
        obj.get('duong_dung'),
        obj.get('ghi_chu'),
        obj.get('note'),
    ]
    times = []
    for raw in time_sources:
        for t in _extract_times_for_cleanup(raw, entry_date_key):
            if t not in times:
                times.append(t)

    if not times:
        return

    final_data.setdefault(ma_bn, [])
    for t in times:
        final_data[ma_bn].append({
            "__cleanup_only": True,
            "Search_Name": _build_search_med_name({"ten_thuoc": name}),
            "Full_Name": name,
            "Time_Start_Str": t,
            "Cleanup_Reason": reason or "Dịch truyền đã bị rule loại khỏi dữ liệu chuẩn, cần xóa bản cũ nếu còn trên EMR.",
            "Cleanup_Source": source_category or str(obj.get('category') or ''),
        })


def _looks_like_tramadol_im(item):
    """TRAMADOL ưu tiên tiêm bắp. Nếu trước đó từng nhập dạng truyền, cần dọn bản truyền cũ."""
    if not isinstance(item, dict):
        return False
    blob = _norm_text(" ".join(str(item.get(k) or '') for k in [
        'ten_hien_thi', 'ten_thuoc', 'duong_dung_goc', 'duong_dung', 'ghi_chu', 'note'
    ]))
    if 'tramadol' not in blob:
        return False
    # Chỉ ép dọn khi y lệnh hiện tại là tiêm bắp/TB, không phải TTM/truyền.
    if any(x in blob for x in ['ttm', 'truyen', 'truyen tinh mach', 'giot/ph', 'giot phut']):
        return False
    return any(x in blob for x in ['tiem bap', ' tb', 'tb ', '(tb)', 'bap'])


