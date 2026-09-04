import time
import json
import os
import sys
import io
import re
import random
import unicodedata
import logging
import traceback
from urllib.parse import urlparse, urlencode, parse_qsl, urlunparse
from logging.handlers import RotatingFileHandler
import builtins as _builtins
from datetime import datetime, timedelta
from care_templates import (
    DIEN_BIEN_BASE_LINES,
    build_dien_bien,
    extend_care_parts,
    extract_actions_by_hour,
    extract_action_care_labels_by_hour,
    build_placeholder_context,
    TRUYEN_MAU_CARE_SLOTS,
)
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from utils import (
    load_config, chuan_hoa_unicode, normalize_date,
    get_nurse_by_shift, login_emr, handle_popups
)
from shared.worker_session import WorkerSession, open_session
from shared.json_io import read_json_critical
from shared.logging_utils import make_worker_logger

from selenium_emr_helpers import (
    build_inpatient_url as _build_inpatient_url,
    debug_page as _debug_page_base,
    ensure_inpatient_list as _ensure_inpatient_list_base,
    goto_inpatient_list as _goto_inpatient_list_base,
    search_patient as _search_patient_base,
    search_patient_on_ward_or_raise as _search_patient_on_ward_or_raise_base,
    wait_ready as _wait_ready,
    wait_after_action as _wait_after_action,
    safe_js_click as _safe_js_click,
)
try:
    from clinical_rules import apply_clinical_rules_to_record
except Exception:
    apply_clinical_rules_to_record = None
try:
    from surgery_guard import should_skip_ward_input_at as _should_skip_surgery_at, surgery_cutoff as _surgery_cutoff
except Exception:
    _should_skip_surgery_at = None
    _surgery_cutoff = None

# ── Import các hàm tiện ích thuần từ module con ───────────────────────────────
from input_care_utils import (
    _norm_free_text, _canon_hhmm, _canon_time_key, _dt_from_time_key,
    _time_field_matches, kiem_tra_noi_dung_cham_soc, kiem_tra_ten_trung_khop,
    them_cham_soc_mac_dinh, tao_thoi_gian_lap, build_regular_care_hours,
    _hhmm_minutes_from_text, _special_event_time_full, _special_event_hour,
    _special_event_default_dien_bien, _special_event_default_care,
    _special_event_nurse_shift_override, _care_job_sort_key,
    _has_surgical_context, _sanitize_postop_text,
    _has_postop_receive_context, POSTOP_RECEIVE_CARE,
)

from task_progress_writer import mark_task_status, progress_path_from_input

from care_web_actions import (
    check_trang_thai_badge, click_thu_hoi_va_xoa, click_thu_hoi_cham_soc,
)
from care_cache import (
    scan_cham_soc_cache, cleanup_cham_soc_cache, kiem_tra_bang_cached,
    open_cham_soc_by_id, don_dep_phieu_sai, kiem_tra_bang, tool_rows_at_or_after,
)
from care_form_actions import (
    set_thoi_gian_lap, dien_thong_tin, set_log_context as set_care_form_log_context,
)

# ==============================================================================
# LOGGING / DEBUG TRACE
# ==============================================================================
LOG, setup_logging = make_worker_logger(
    "cham_soc",
    debug_env="CHAM_SOC_DEBUG",
    log_file_env="CHAM_SOC_LOG_FILE",
    log_file_prefix="cham_soc_debug",
)
LOG_CTX = {"bn": "", "name": "", "date": ""}

def _ctx_prefix():
    bn = LOG_CTX.get("bn") or ""
    name = LOG_CTX.get("name") or ""
    date = LOG_CTX.get("date") or ""
    parts = []
    if bn: parts.append(f"BN={bn}")
    if name: parts.append(f"NAME={name}")
    if date: parts.append(f"DATE={date}")
    return "[" + " ".join(parts) + "] " if parts else ""


# 1. CẤU HÌNH HỆ THỐNG & HỖ TRỢ THỜI GIAN
# ==============================================================================
def _ensure_stdio_utf8():
    """Dat encoding UTF-8 ma khong thay the stream chuan.

    Ly do: pytest tren Python 3.14/Windows dung capture file tam.
    Neu import module roi gan lai sys.stdout/sys.stderr bang TextIOWrapper,
    wrapper cu co the bi dong som, lam pytest loi o cuoi phien test:
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

def lay_danh_sach_tat_ca_ten(config_names):
    names = []
    seen = set()

    def _add(name):
        s = str(name or '').strip()
        if not s:
            return
        key = chuan_hoa_unicode(s)
        if key in seen:
            return
        seen.add(key)
        names.append(s)

    def _consume(value):
        if isinstance(value, list):
            for item in value:
                _add(item)
            return
        if isinstance(value, dict):
            for k in ('work', 'oncall', 'ca_lam', 'ca_truc', 'caLam', 'caTruc', 'regular', 'day', 'night', 'direct'):
                sub = value.get(k)
                if isinstance(sub, list):
                    for item in sub:
                        _add(item)
                elif isinstance(sub, str):
                    _add(sub)
            return
        if isinstance(value, str):
            _add(value)

    if isinstance(config_names, dict):
        for _, value in config_names.items():
            _consume(value)

    if not names:
        return ['Lê Ngọc Diệu']
    return names




def _debug_page(driver, label="debug"):
    log_dir = None
    try:
        log_dir = os.path.join(RUNTIME_DIR if "RUNTIME_DIR" in globals() else os.getcwd(), "logs")
    except Exception:
        log_dir = None
    return _debug_page_base(driver, label, log_dir=log_dir, log_func=print)


# _goto_inpatient_list, _ensure_inpatient_list, _search_patient
# → dùng ws.goto_inpatient_list(), ws.ensure_inpatient_list(), ws.search_patient()

# ==============================================================================
# 2. CÁC HÀM HỖ TRỢ LOGIC WEB
# ==============================================================================

# _norm_free_text → đã chuyển sang input_care_utils.py

# _canon_hhmm → đã chuyển sang input_care_utils.py

# _canon_time_key → đã chuyển sang input_care_utils.py

# _dt_from_time_key → đã chuyển sang input_care_utils.py

# _time_field_matches → đã chuyển sang input_care_utils.py

# kiem_tra_noi_dung_cham_soc → đã chuyển sang input_care_utils.py

# kiem_tra_ten_trung_khop → đã chuyển sang input_care_utils.py

# them_cham_soc_mac_dinh → đã chuyển sang input_care_utils.py


# tao_thoi_gian_lap → đã chuyển sang input_care_utils.py

# _hhmm_minutes_from_text → đã chuyển sang input_care_utils.py

# _special_event_time_full → đã chuyển sang input_care_utils.py

# _special_event_hour → đã chuyển sang input_care_utils.py

# _special_event_default_dien_bien → đã chuyển sang input_care_utils.py

# _special_event_default_care → đã chuyển sang input_care_utils.py

# _special_event_nurse_shift_override → đã chuyển sang input_care_utils.py

# _care_job_sort_key → đã chuyển sang input_care_utils.py

# _has_surgical_context → đã chuyển sang input_care_utils.py

# _sanitize_postop_text → đã chuyển sang input_care_utils.py



# ==============================================================================
# 2B. CACHE + DỌN PHIẾU (TỐI ƯU: CHỈ QUÉT 1 LẦN ĐẦU + 1 LẦN CUỐI/BN)
# ==============================================================================
























# ==============================================================================
# 2b. TRUYỀN MÁU — Sinh phiếu chăm sóc từ giờ nhận máu
# ==============================================================================

def _build_truyen_mau_events(gio_nhan_mau: str, ngay_lam_viec: str) -> list:
    """Tạo 4 phiếu chăm sóc truyền máu tại T, T+1h, T+2h, T+3h53m.

    Args:
        gio_nhan_mau:   Giờ nhận máu dạng "HH:MM" do điều dưỡng nhập từ UI.
        ngay_lam_viec:  Ngày làm việc dạng "dd/mm/yyyy".

    Returns:
        Danh sách dict special_event tương thích với hệ thống input_care.
    """
    from datetime import datetime, timedelta

    gio_nhan_mau = str(gio_nhan_mau or "").strip()
    ngay_lam_viec = str(ngay_lam_viec or "").strip()

    # Parse giờ nhận máu
    m = re.match(r"^(\d{1,2}):(\d{2})$", gio_nhan_mau)
    if not m:
        print(f"   [WARN] truyen_mau: giờ nhận máu không hợp lệ '{gio_nhan_mau}' — bỏ qua phiếu truyền máu.")
        return []

    try:
        base_dt = datetime.strptime(f"{m.group(1).zfill(2)}:{m.group(2)} {ngay_lam_viec}", "%H:%M %d/%m/%Y")
    except ValueError:
        print(f"   [WARN] truyen_mau: không parse được datetime từ '{gio_nhan_mau} {ngay_lam_viec}' — bỏ qua.")
        return []

    events = []
    for slot in TRUYEN_MAU_CARE_SLOTS:
        slot_dt = base_dt + timedelta(minutes=slot["offset_minutes"])
        hhmm    = slot_dt.strftime("%H:%M")
        ngay    = slot_dt.strftime("%d/%m/%Y")
        time_full = f"{hhmm} {ngay}"
        total_min = slot_dt.hour * 60 + slot_dt.minute

        events.append({
            "type":          "truyen_mau",
            "label":         slot["label"],
            "source_date":   ngay_lam_viec,
            "time_full":     time_full,
            "time_label":    hhmm,
            "time_minutes":  total_min,
            "dien_bien":     slot["dien_bien"],
            "cham_soc":      slot["cham_soc"],
            "needs_vitals":  True,
        })
    return events




def _parse_care_datetime(raw, default_date=None):
    """Parse linh hoạt các mốc giờ/ngày dùng cho rule chăm sóc.

    Hỗ trợ:
    - HH:MM dd/mm/yyyy hoặc HH:MM dd-mm-yyyy
    - dd/mm/yyyy HH:MM hoặc dd-mm-yyyy HH:MM
    - HH:MM + default_date
    Trả về datetime hoặc None.
    """
    text = str(raw or "").strip().replace("\xa0", " ")
    if not text:
        return None
    text = re.sub(r"\s+", " ", text)

    patterns = [
        r"(\d{1,2}):(\d{2})\s+(\d{1,2})[/-](\d{1,2})[/-](\d{4})",
        r"(\d{1,2})[/-](\d{1,2})[/-](\d{4})\s+(\d{1,2}):(\d{2})",
    ]
    m = re.search(patterns[0], text)
    if m:
        hh, mi, dd, mo, yyyy = m.groups()
        try:
            return datetime(int(yyyy), int(mo), int(dd), int(hh), int(mi))
        except ValueError:
            return None

    m = re.search(patterns[1], text)
    if m:
        dd, mo, yyyy, hh, mi = m.groups()
        try:
            return datetime(int(yyyy), int(mo), int(dd), int(hh), int(mi))
        except ValueError:
            return None

    if default_date:
        m = re.search(r"(\d{1,2}):(\d{2})", text)
        if m:
            try:
                base = datetime.strptime(str(default_date).strip().replace("-", "/"), "%d/%m/%Y")
                return base.replace(hour=int(m.group(1)), minute=int(m.group(2)), second=0, microsecond=0)
            except Exception:
                return None
    return None


def _same_calendar_date(dt_obj, ddmmyyyy):
    if dt_obj is None or not ddmmyyyy:
        return False
    try:
        d = datetime.strptime(str(ddmmyyyy).strip().replace("-", "/"), "%d/%m/%Y")
        return dt_obj.date() == d.date()
    except Exception:
        return False


def _discharge_cutoff_from_entry(entry_obj, special_events=None, work_date=None):
    """Lấy mốc ra viện từ event đặc biệt hoặc từ các trường ngay_ra_vien/gio_ra_vien.

    Quan trọng: không chỉ dùng ra_vien_hom_nay. Có ca ngày làm 08/05 nhưng
    trường ngay_ra_vien = '13:00 07/05/2026'; các ca này phải bị chặn hoàn toàn.
    """
    work_date = str(work_date or (entry_obj or {}).get("ngay_lam") or "").strip()
    for ev in (special_events or []):
        if not isinstance(ev, dict) or ev.get("type") != "discharge":
            continue
        raw = ev.get("time_full") or ev.get("time_label")
        dt_obj = _parse_care_datetime(raw, default_date=work_date)
        if dt_obj is not None:
            return dt_obj

    if not isinstance(entry_obj, dict):
        return None

    raw_full = str(entry_obj.get("ngay_ra_vien") or "").strip()
    dt_obj = _parse_care_datetime(raw_full, default_date=work_date)
    if dt_obj is not None:
        return dt_obj

    gio = str(entry_obj.get("gio_ra_vien") or "").strip()
    ngay = str(entry_obj.get("ngay_ra_vien_date") or entry_obj.get("ngay_ra_vien_ngay") or "").strip()
    if gio and ngay:
        dt_obj = _parse_care_datetime(f"{gio} {ngay}")
        if dt_obj is not None:
            return dt_obj

    return None


def _is_time_before_discharge(time_key, discharge_dt, *, allow_equal=False):
    if discharge_dt is None:
        return True
    dt_obj = _parse_care_datetime(time_key) or _dt_from_time_key(time_key)
    if dt_obj is None:
        return True
    return dt_obj <= discharge_dt if allow_equal else dt_obj < discharge_dt


def _make_discharge_event_from_dt(discharge_dt, work_date):
    """Tạo event chăm sóc ra viện từ mốc Ngày ra viện của hồ sơ.

    Fallback này bảo đảm input_care vẫn nhập phiếu ra viện đúng giờ bác sĩ cho
    xuất viện, kể cả khi file JSON cũ/chưa qua clinical_rules chưa có
    care_special_events[type=discharge].
    """
    if discharge_dt is None:
        return None
    try:
        hhmm = discharge_dt.strftime("%H:%M")
        record_date = discharge_dt.strftime("%d/%m/%Y")
        if work_date and str(work_date).strip() and not _same_calendar_date(discharge_dt, work_date):
            return None
        return {
            "type": "discharge",
            "source_date": record_date,
            "time_full": f"{hhmm} {record_date}",
            "time_label": hhmm,
            "time_minutes": discharge_dt.hour * 60 + discharge_dt.minute,
            "title": "Ra viện",
            "dien_bien": "Người bệnh xuất viện",
            "cham_soc": "Hoàn tất hồ sơ ra viện + Cấp giấy ra viện + Cấp thuốc theo toa + Hướng dẫn tái khám",
            "needs_vitals": False,
            "recognition": {"source": "ngay_ra_vien_fallback"},
        }
    except Exception:
        return None


def _has_discharge_event_at(special_events, discharge_dt, work_date):
    if discharge_dt is None:
        return False
    target = discharge_dt.strftime("%H:%M %d/%m/%Y")
    for ev in special_events or []:
        if not isinstance(ev, dict) or ev.get("type") != "discharge":
            continue
        tf = _special_event_time_full(ev, work_date)
        ev_dt = _parse_care_datetime(tf) or _dt_from_time_key(tf)
        if ev_dt is not None and ev_dt == discharge_dt:
            return True
        if _canon_time_key(tf) == target:
            return True
    return False


def _format_order_hours_after_discharge(hours, work_date, discharge_dt):
    """Trả về các giờ y lệnh/chăm sóc vượt quá giờ ra viện để cảnh báo rõ."""
    out = []
    if discharge_dt is None:
        return out
    for h in sorted(set(hours or [])):
        if not isinstance(h, int):
            continue
        time_key = tao_thoi_gian_lap(h, work_date)
        dt_obj = _parse_care_datetime(time_key) or _dt_from_time_key(time_key)
        if dt_obj is not None and dt_obj > discharge_dt:
            out.append(time_key)
    return out

# ==============================================================================
# 3. MAIN
# ==============================================================================
def main():
    global CONFIG_TEN_GOC
    CONFIG = load_config()
    CONFIG_TEN_GOC = CONFIG.get('ten_dieu_duong')
    LIST_NURSE = lay_danh_sach_tat_ca_ten(CONFIG_TEN_GOC)
    setup_logging()
    
    print(">>> Bắt đầu nhập chăm sóc")
    
    base_dir = os.path.dirname(os.path.abspath(__file__))

    # Cho phép truyền đường dẫn JSON từ Node:
    # Tách positional args (bỏ qua flags như --debug, --log-file)
    argv = sys.argv[1:]
    pos_args = []
    _skip = False
    for a in argv:
        if _skip:
            _skip = False
            continue
        if a == "--debug":
            continue
        if a.startswith("--log-file="):
            continue
        if a == "--log-file":
            _skip = True
            continue
        pos_args.append(a)

    #   python input_care.py <processedPath> <targetsPath>
    # Khi chạy standalone, ưu tiên dùng file output chuẩn mới của webapp:
    # .runtime/data/04_classified_patient_day_records.json
    targets_path = None

    # 1) Ưu tiên arg[0] (positional) nếu được truyền và tồn tại
    json_path = None
    if len(pos_args) >= 1 and pos_args[0]:
        cand = pos_args[0]
        if os.path.exists(cand):
            json_path = cand

    # 2) Nếu không có arg hợp lệ, tự dò các vị trí thường dùng
    if not json_path:
        candidates = [
            os.path.join(base_dir, ".runtime", "data", "04_classified_patient_day_records.json"),
            os.path.join(base_dir, "data", "04_classified_patient_day_records.json"),
            os.path.join(base_dir, ".runtime", "DuLieu_PhanLoai.json"),
            os.path.join(base_dir, "DuLieu_PhanLoai.json"),
            os.path.join(base_dir, "data_phan_loai_chuan_v16.json"),  # legacy fallback
        ]
        for cand in candidates:
            if os.path.exists(cand):
                json_path = cand
                break

    # targets (lọc BN/ngày) nếu được truyền
    if len(pos_args) >= 2 and pos_args[1]:
        targets_path = pos_args[1]

    if not json_path or not os.path.exists(json_path):
        print("LỖI: Không tìm thấy file JSON đầu vào.")
        print("Gợi ý: hãy chạy bước 'Xử Lý JSON Đã Lấy' để tạo .runtime/data/04_classified_patient_day_records.json,")
        print("hoặc chạy tool với tham số: python input_care.py <classified_patient_day_records.json> <targets.json>")
        sys.exit(1)

    # Đường dẫn file kết quả — Node.js đọc dù không có dữ liệu phù hợp để nhập.
    result_path = os.path.join(os.path.dirname(os.path.abspath(json_path)), "input_care_result.json")
    progress_path = progress_path_from_input(json_path)

    print(">>> Đang đọc dữ liệu JSON...")
    try:
        raw_data = read_json_critical(json_path, [], expected_type=list)

        # Chặn phụ khi người dùng nhập chăm sóc từ dữ liệu runtime cũ chưa post-process lại.
        # Rule chính nằm ở xu_ly.py; đoạn này giúp tính lại tong_hop_gio_dung trước khi sinh giờ chăm sóc.
        if apply_clinical_rules_to_record:
            raw_data = [apply_clinical_rules_to_record(x) for x in (raw_data or [])]
    except Exception as e:
        print(f"\nLỗi đọc JSON: {e}")
        sys.exit(1)

    # Đọc targets nếu có (lọc theo Mã BN và ngày làm việc theo UI)
    targets = {}
    if targets_path and os.path.exists(targets_path):
        try:
            targets = read_json_critical(targets_path, {}, expected_type=dict) or {}
        except Exception as _e:
            print(f">>> [ERROR] Targets nhập EMR không hợp lệ: {_e}")
            sys.exit(1)

    patient_filter = set(str(x).strip() for x in (targets.get('patientIds') or []) if str(x).strip())
    range_from_str = (targets.get('from') or '').strip()  # dd/mm/yyyy
    range_to_str = (targets.get('to') or '').strip()      # dd/mm/yyyy
    selected_dates_raw = [str(x).strip() for x in (targets.get('selectedDates') or []) if str(x).strip()]
    patient_dates_raw = targets.get('patientDates') if isinstance(targets.get('patientDates'), dict) else {}
    # Giờ nhận máu do điều dưỡng nhập từ UI, ưu tiên dạng {"ma_bn::ngay_lam": "HH:MM"}.
    # Vẫn nhận legacy {ma_bn: "HH:MM"} cho dữ liệu/phiên cũ.
    truyen_mau_times = targets.get('truyen_mau_times') if isinstance(targets.get('truyen_mau_times'), dict) else {}

    direct_emr_sync = bool(targets.get('directEmrSync') or targets.get('direct_emr_sync'))
    visible_browser = bool(targets.get('visibleBrowser') or targets.get('visible_browser'))
    if direct_emr_sync or visible_browser:
        CONFIG['headless'] = False
        print(">>> Chế độ đồng bộ trực tiếp: mở Chrome để kiểm tra / nhập / sửa chăm sóc trên EMR.")

    # Không dùng giờ bấm nút hoặc preview để giới hạn chăm sóc.
    # Các mốc chỉ bị loại bởi rule lâm sàng: nhận khoa, đi mổ, nhận hậu phẫu và ra viện.


    def _get_truyen_mau_time(ma_bn, ngay_chuan):
        keyed = f"{str(ma_bn or '').strip()}::{str(ngay_chuan or '').strip()}"
        return str((truyen_mau_times or {}).get(keyed) or (truyen_mau_times or {}).get(str(ma_bn or '').strip()) or "").strip()

    def _parse_ddmmyyyy(date_str):
        try:
            return datetime.strptime(str(date_str).strip(), '%d/%m/%Y')
        except Exception:
            return None

    date_hint_year = None
    for cand in [range_from_str, range_to_str, *selected_dates_raw]:
        parsed = _parse_ddmmyyyy(cand)
        if parsed:
            date_hint_year = parsed.year
            break

    from_dt = _parse_ddmmyyyy(range_from_str)
    to_dt = _parse_ddmmyyyy(range_to_str)
    if from_dt and to_dt and from_dt > to_dt:
        from_dt, to_dt = to_dt, from_dt

    selected_dates = set()
    for raw in selected_dates_raw:
        normalized = normalize_date(raw, default_year=date_hint_year)
        if normalized:
            selected_dates.add(normalized)

    patient_dates = {}
    for pid, values in (patient_dates_raw or {}).items():
        key = str(pid).strip()
        if not key:
            continue
        dates = set()
        for raw in (values or []):
            normalized = normalize_date(raw, default_year=date_hint_year)
            if normalized:
                dates.add(normalized)
        if dates:
            patient_dates[key] = dates

    # Nếu JSON là dict (1 BN), đưa về list cho đồng nhất
    if isinstance(raw_data, dict):
        raw_data = [raw_data]

    raw_data = list(raw_data or [])

    if patient_filter:
        raw_data = [e for e in raw_data if str(e.get('ma_bn', '')).strip() in patient_filter]
        print(f">>> Lọc theo patientIds: còn {len(raw_data)} dòng dữ liệu.")

    def _normalized_entry_date(entry_obj):
        return normalize_date(entry_obj.get('ngay_lam', ''), default_year=date_hint_year)

    def _is_before_work_start_same_date(raw_time, work_date, start_hour=7):
        """True nếu raw_time là mốc trước 07:00 đúng vào ngày làm việc.

        Các mốc này thuộc tua trực ngày trước nên không gán vào chăm sóc của
        ngày bắt đầu hiện tại. Ví dụ: 05:00 29/04/2026 không thuộc ngày làm
        29/04 nếu ca bắt đầu từ 07:00.
        """
        text = str(raw_time or '').strip()
        work_date = str(work_date or '').strip()
        if not text or not work_date:
            return False
        m = re.search(r'(\d{1,2}):(\d{2})\s+(\d{2}/\d{2}/\d{4})', text)
        if not m:
            return False
        try:
            hh = int(m.group(1))
            mi = int(m.group(2))
        except Exception:
            return False
        return m.group(3) == work_date and (hh * 60 + mi) < int(start_hour) * 60

    def _parse_any_discharge_dt(entry_obj, work_date=''):
        """Lấy mốc ra viện trực tiếp từ record, kể cả khi không có special_event ngày hiện tại."""
        if not isinstance(entry_obj, dict):
            return None
        candidates = []
        date_part = str(entry_obj.get('ngay_ra_vien_date') or work_date or entry_obj.get('ngay_lam') or '').strip()
        time_part = str(entry_obj.get('gio_ra_vien') or '').strip()
        if time_part and date_part:
            candidates.append(f"{time_part} {date_part}")
        candidates.extend([
            str(entry_obj.get('ngay_ra_vien') or '').strip(),
            str(entry_obj.get('Ngày ra viện') or '').strip(),
        ])
        for raw in candidates:
            if not raw:
                continue
            dt = _dt_from_time_key(raw)
            if dt is not None:
                return dt
            m = re.search(r'(\d{1,2}):(\d{2}).*?(\d{1,2})[/-](\d{1,2})[/-](\d{4})', raw)
            if m:
                try:
                    hh, mi, dd, mm, yy = map(int, m.groups())
                    return datetime(yy, mm, dd, hh, mi)
                except Exception:
                    pass
            if time_part and date_part and re.search(r'\d{1,2}[/-]\d{1,2}[/-]\d{4}', raw):
                try:
                    return datetime.strptime(f"{time_part} {date_part}", "%H:%M %d/%m/%Y")
                except Exception:
                    pass
        return None

    def _drop_actions_before_work_start_same_date(chi_dinh_khac, work_date):
        if not isinstance(chi_dinh_khac, dict):
            return chi_dinh_khac or {}
        cleaned = dict(chi_dinh_khac)
        for key in ('thay_bang_cat_chi', 'duong_mau_mao_mach'):
            items = cleaned.get(key)
            if not isinstance(items, list):
                continue
            cleaned[key] = [
                item for item in items
                if not (isinstance(item, dict) and _is_before_work_start_same_date(item.get('gio'), work_date))
            ]
        vltl = cleaned.get('vat_ly_tri_lieu')
        if isinstance(vltl, str) and _is_before_work_start_same_date(vltl, work_date):
            cleaned['vat_ly_tri_lieu'] = ''
        elif isinstance(vltl, list):
            cleaned['vat_ly_tri_lieu'] = [
                item for item in vltl
                if not (isinstance(item, dict) and _is_before_work_start_same_date(item.get('gio'), work_date))
            ]
        return cleaned

    # Chỉ giữ các dòng có ngày thật sự nằm trong phạm vi UI chọn.
    if from_dt or to_dt or selected_dates or patient_dates:
        filtered_rows = []
        for entry in raw_data:
            ma_bn = str(entry.get('ma_bn', '')).strip()
            ngay_chuan = _normalized_entry_date(entry)
            entry_dt = _parse_ddmmyyyy(ngay_chuan)
            keep = True
            if from_dt and to_dt:
                keep = bool(entry_dt and from_dt <= entry_dt <= to_dt)
            elif from_dt:
                keep = bool(entry_dt and entry_dt.date() == from_dt.date())
            elif to_dt:
                keep = bool(entry_dt and entry_dt.date() == to_dt.date())

            if keep and patient_dates.get(ma_bn):
                keep = ngay_chuan in patient_dates.get(ma_bn, set())
            elif keep and selected_dates:
                keep = ngay_chuan in selected_dates

            if keep:
                filtered_rows.append(entry)
        raw_data = filtered_rows
        print(f">>> Lọc theo ngày dữ liệu: còn {len(raw_data)} dòng trong phạm vi chọn.")

    # Gộp dữ liệu theo (Mã Bệnh Nhân, Ngày Làm Việc thực tế trong file)
    patient_data = {}
    for entry in raw_data:
        ma_bn = str(entry.get('ma_bn', '')).strip()
        if not ma_bn:
            continue

        ngay_chuan = _normalized_entry_date(entry)
        patient_key = (ma_bn, ngay_chuan)

        if patient_key not in patient_data:
            patient_data[patient_key] = {
                "ma_bn": ma_bn,
                "ho_ten": entry.get('ho_ten', ''),
                "ngay_lam_viec": ngay_chuan,
                "hours": set(),                 # giờ thực hiện thuốc (từ tong_hop_gio_dung)
                "actions_by_hour": {},          # {hour_int: set({"THAY_BANG", ...})}
                "action_care_labels_by_hour": {}, # {hour_int: {action: [tên chỉ định gốc]}}
                "special_events": [],           # phiếu chăm sóc đặc biệt, ví dụ nhận bệnh sau mổ/chuyển khoa lúc 13:35
                "care_mode": entry.get("care_mode") or "",
                "entry": entry                  # dữ liệu gốc để suy luận placeholder
            }

        # 1. Lấy giờ dùng thuốc
        gio_dung = entry.get('tong_hop_gio_dung', [])
        patient_data[patient_key]["hours"].update(gio_dung)
        patient_data[patient_key]["entry"] = entry
        if entry.get("care_mode"):
            patient_data[patient_key]["care_mode"] = entry.get("care_mode")
        for ev in (entry.get("care_special_events") or []):
            if not isinstance(ev, dict):
                continue
            ev_key = (ev.get("type"), ev.get("time_full") or ev.get("time_label"))
            existed = False
            for old_ev in patient_data[patient_key]["special_events"]:
                if (old_ev.get("type"), old_ev.get("time_full") or old_ev.get("time_label")) == ev_key:
                    existed = True
                    break
            if not existed:
                patient_data[patient_key]["special_events"].append(ev)

        # 1b. Thêm phiếu truyền máu nếu UI truyền giờ nhận máu cho BN này
        _truyen_mau_info = (entry.get("chi_dinh_khac") or {}).get("truyen_mau") or {}
        if _truyen_mau_info.get("co_truyen_mau"):
            _gio_nhan_mau = _get_truyen_mau_time(ma_bn, ngay_chuan)
            if _gio_nhan_mau:
                _tm_events = _build_truyen_mau_events(_gio_nhan_mau, ngay_chuan)
                for _ev in _tm_events:
                    _ev_key = (_ev.get("type"), _ev.get("time_full"))
                    _existed = any(
                        (o.get("type"), o.get("time_full") or o.get("time_label")) == _ev_key
                        for o in patient_data[patient_key]["special_events"]
                    )
                    if not _existed:
                        patient_data[patient_key]["special_events"].append(_ev)
                print(f"   [TRUYEN_MAU] BN {ma_bn}: thêm {len(_tm_events)} phiếu truyền máu từ {_gio_nhan_mau} ({ngay_chuan})")

        # 2. Trích xuất actions theo giờ (dựa trên JSON chuẩn hoá) để bổ sung vào mẫu diễn biến / chăm sóc
        actions_by_hour = patient_data[patient_key]["actions_by_hour"]

        chi_dinh_khac = _drop_actions_before_work_start_same_date(entry.get("chi_dinh_khac", {}) or {}, ngay_chuan)
        extracted = extract_actions_by_hour(chi_dinh_khac)
        for h, acts in extracted.items():
            actions_by_hour.setdefault(h, set()).update(acts)

        # Giữ tên DVKT/chỉ định đầy đủ để nội dung nhập EMR giống hệt preview.
        labels_by_hour = patient_data[patient_key]["action_care_labels_by_hour"]
        extracted_labels = extract_action_care_labels_by_hour(chi_dinh_khac)
        for h, action_map in extracted_labels.items():
            hour_bucket = labels_by_hour.setdefault(h, {})
            for action_id, labels in action_map.items():
                label_bucket = hour_bucket.setdefault(action_id, [])
                existing_norm = {chuan_hoa_unicode(x) for x in label_bucket}
                for label in labels:
                    label_text = str(label or "").strip()
                    label_norm = chuan_hoa_unicode(label_text)
                    if label_text and label_norm not in existing_norm:
                        label_bucket.append(label_text)
                        existing_norm.add(label_norm)

    print(f"OK. Đã tổng hợp {len(patient_data)} nhóm bệnh nhân/ngày.")

    if not patient_data:
        print(">>> Không có dữ liệu chăm sóc phù hợp sau khi lọc. Dừng, không mở EMR.")
        WorkerSession.skip(result_path, "Không có dữ liệu chăm sóc phù hợp sau khi lọc.")
        return 0

    def _after_login(ws: WorkerSession) -> None:
        ws.ensure_inpatient_list()

    with open_session(result_path, config=CONFIG, post_login=_after_login) as ws:
        driver, wait = ws.driver, ws.wait

        count = 0
        for patient_key, info in patient_data.items():
            ma_bn = info.get("ma_bn") or patient_key[0]
            count += 1
            med_hours = info["hours"]
            actions_by_hour = info.get("actions_by_hour", {})
            action_care_labels_by_hour = info.get("action_care_labels_by_hour", {})
            special_events = info.get("special_events") or []
            care_mode = info.get("care_mode") or ""
            entry_obj = info.get("entry") or {}

            # Nếu ca đã có phiếu nhận hậu phẫu/chuyển về khoa thì không dùng thêm
            # phiếu nhận khoa/chuyển khoa lấy từ cột T/G vào. Tránh tạo dư 2 phiếu
            # gần nhau như 13:38 + 13:41 ở ca hậu phẫu.
            # LƯU Ý: vẫn phải giữ phiếu ra viện nếu bác sĩ cho ra viện trong cùng ngày.
            # Trường hợp thực tế: BN nhận hậu phẫu 09:31 và bác sĩ cho xuất viện 14:00;
            # nếu lọc chỉ còn postop_receive thì web Data Hub có mốc ra viện nhưng EMR
            # không được nhập phiếu chăm sóc ra viện.
            if any(isinstance(ev, dict) and ev.get("type") == "postop_receive" for ev in special_events):
                special_events = [
                    ev for ev in special_events
                    if isinstance(ev, dict) and ev.get("type") in ("postop_receive", "discharge")
                ]

            care_mode = "postop_receive_day" if any(
                isinstance(ev, dict) and ev.get("type") == "postop_receive" for ev in special_events
            ) else care_mode
            is_postop_receive_day = (care_mode == "postop_receive_day") or any(
                isinstance(ev, dict) and ev.get("type") == "postop_receive" for ev in special_events
            )
            is_discharge_day = (care_mode == "discharge_day") or any(
                isinstance(ev, dict) and ev.get("type") == "discharge" for ev in special_events
            )
            is_admission_transfer_day = (care_mode == "admission_transfer_day") or any(
                isinstance(ev, dict) and ev.get("type") in ("clinic_admission", "ward_receive", "interdepartment_receive") for ev in special_events
            )
            ngay_lam_viec = info["ngay_lam_viec"]
            # Đặt context ngay đầu BN/ngày, trước mọi rule/cảnh báo. Tránh log
            # ra viện/phẫu thuật bị gắn nhầm sang người bệnh vừa xử lý trước đó.
            LOG_CTX.update({'bn': ma_bn, 'name': info.get('ho_ten', ''), 'date': ngay_lam_viec})
            set_care_form_log_context(ma_bn, info.get('ho_ten', ''), ngay_lam_viec)
            discharge_cutoff_dt = _discharge_cutoff_from_entry(entry_obj, special_events, ngay_lam_viec)
            if discharge_cutoff_dt is not None and _same_calendar_date(discharge_cutoff_dt, ngay_lam_viec):
                # Có ca chỉ có field ngay_ra_vien/gio_ra_vien, không có care_special_events.
                # Vẫn xem là ngày ra viện để không tự sinh cữ 16:00/05:00 sau ra viện.
                # Đồng thời tạo phiếu chăm sóc ra viện đúng mốc giờ bác sĩ cho xuất viện.
                is_discharge_day = True
                if not _has_discharge_event_at(special_events, discharge_cutoff_dt, ngay_lam_viec):
                    _discharge_ev = _make_discharge_event_from_dt(discharge_cutoff_dt, ngay_lam_viec)
                    if _discharge_ev:
                        special_events.append(_discharge_ev)
                        LOG.info(_ctx_prefix() + f"[discharge_guard] add_discharge_care_event={_discharge_ev.get('time_full')}")

            receive_time_key = None
            receive_dt = None
            discharge_minutes = None
            discharge_dt = None
            admission_start_dt = None
            admission_fallback_dt = None
            for ev in special_events:
                if not isinstance(ev, dict):
                    continue
                ev_type = str(ev.get("type") or "").strip()
                ev_time_key = _special_event_time_full(ev, ngay_lam_viec)
                ev_dt = _parse_care_datetime(ev_time_key) or _dt_from_time_key(ev_time_key)

                if ev_type == "postop_receive":
                    if receive_dt is None or (ev_dt is not None and ev_dt < receive_dt):
                        receive_dt = ev_dt
                        receive_time_key = ev_time_key

                if ev_type == "discharge" and discharge_dt is None:
                    discharge_minutes = _hhmm_minutes_from_text(ev.get("time_full") or ev.get("time_label"))
                    discharge_dt = ev_dt

                if ev_type in ("ward_receive", "interdepartment_receive") and ev_dt is not None:
                    # Mốc bắt đầu chăm sóc tại khoa ưu tiên giờ khoa thực sự nhận BN,
                    # không dùng giờ phòng khám hoàn tất nhập viện nếu có cả hai mốc.
                    if admission_start_dt is None or ev_dt < admission_start_dt:
                        admission_start_dt = ev_dt
                elif ev_type == "clinic_admission" and ev_dt is not None:
                    if admission_fallback_dt is None or ev_dt < admission_fallback_dt:
                        admission_fallback_dt = ev_dt

            if admission_start_dt is None:
                admission_start_dt = admission_fallback_dt

            if discharge_cutoff_dt is not None:
                discharge_dt = discharge_dt or discharge_cutoff_dt
                discharge_minutes = discharge_minutes if discharge_minutes is not None else (discharge_cutoff_dt.hour * 60 + discharge_cutoff_dt.minute)

            all_hours, has_regular_care_signal = build_regular_care_hours(
                med_hours,
                actions_by_hour,
                action_care_labels_by_hour,
                is_postop_receive_day=is_postop_receive_day,
                is_discharge_day=is_discharge_day,
                is_admission_transfer_day=is_admission_transfer_day,
            )
            # Ngày đi mổ rồi nhận lại:
            # - Không tự sinh phiếu 08:00 buổi sáng trước lúc nhận khoa.
            # - Vẫn giữ cữ 16:00 cùng ngày và 05:00 ngày mai để lấy dấu hiệu sinh tồn như chăm sóc cũ.
            # Ngày ra viện:
            # - Ghi cữ 08:00 như cũ.
            # - Thêm phiếu đặc biệt đúng giờ ra viện.
            # - Không tự sinh cữ 16:00 sau khi người bệnh đã xuất viện.
            if not has_regular_care_signal and not (
                is_postop_receive_day or is_discharge_day or is_admission_transfer_day
            ):
                # Không tự tạo bộ giờ 05-08-16 chỉ vì BN còn nằm trong danh sách.
                # Nếu JSON ngày đó không còn thuốc/chỉ định chăm sóc và không phải
                # ngày nhận khoa/ra viện/hậu phẫu thì không có căn cứ tạo phiếu mới.
                LOG.info(_ctx_prefix() + "[care_schedule] no_regular_signal=True; baseline_hours_not_added")

            if is_admission_transfer_day and admission_start_dt is not None:
                # So sánh datetime thật thay vì chỉ so số giờ. Nhờ đó 05:00 ngày
                # hôm sau luôn được giữ khi BN nhận khoa buổi chiều/tối.
                all_hours = {
                    h for h in all_hours
                    if isinstance(h, int)
                    and ((_parse_care_datetime(tao_thoi_gian_lap(h, ngay_lam_viec))
                          or _dt_from_time_key(tao_thoi_gian_lap(h, ngay_lam_viec))) >= admission_start_dt)
                }

            if is_postop_receive_day and receive_dt is not None:
                # Cùng nguyên tắc datetime thật: nhận hậu phẫu sau 16:00 thì bỏ
                # cữ 16:00, nhưng vẫn giữ 05:00 sáng hôm sau.
                all_hours = {
                    h for h in all_hours
                    if isinstance(h, int)
                    and ((_parse_care_datetime(tao_thoi_gian_lap(h, ngay_lam_viec))
                          or _dt_from_time_key(tao_thoi_gian_lap(h, ngay_lam_viec))) >= receive_dt)
                }

            discharge_rule_reason = ""
            if discharge_dt is not None:
                # Cảnh báo riêng cho các y lệnh/giờ chăm sóc phát sinh sau giờ ra viện.
                # Các mốc này không được nhập; phiếu ra viện vẫn được nhập đúng giờ ra viện.
                _order_like_hours = set(med_hours or set()) | set(actions_by_hour.keys() if isinstance(actions_by_hour, dict) else [])
                _late_order_times = _format_order_hours_after_discharge(_order_like_hours, ngay_lam_viec, discharge_dt)
                if _late_order_times:
                    late_text = ", ".join(_late_order_times)
                    LOG.warning(_ctx_prefix() + f"[CẢNH BÁO][Y_LENH_SAU_RA_VIEN] cutoff={discharge_dt.strftime('%H:%M %d/%m/%Y')} skipped={late_text}")
                    print(f"   [CẢNH BÁO] Có y lệnh/giờ chăm sóc sau giờ ra viện {discharge_dt.strftime('%H:%M %d/%m/%Y')} → không nhập: {late_text}")

                kept_hours = set()
                skipped_after_discharge = []
                for _h in all_hours:
                    if not isinstance(_h, int):
                        skipped_after_discharge.append(_h)
                        continue
                    _time_key = tao_thoi_gian_lap(_h, ngay_lam_viec)
                    if _is_time_before_discharge(_time_key, discharge_dt, allow_equal=False):
                        kept_hours.add(_h)
                    else:
                        skipped_after_discharge.append(_h)
                if skipped_after_discharge:
                    discharge_rule_reason = f"Người bệnh đã ra viện lúc {discharge_dt.strftime('%H:%M %d/%m/%Y')}"
                    LOG.info(_ctx_prefix() + f"[discharge_guard] skip_hours_after_discharge={sorted(skipped_after_discharge)} cutoff={discharge_dt.strftime('%H:%M %d/%m/%Y')}")
                    print(f"   [RULE] {discharge_rule_reason} → bỏ giờ: {sorted(skipped_after_discharge)}")
                all_hours = kept_hours

                kept_special_events = []
                skipped_special_events = []
                for _ev in special_events:
                    _tf = _special_event_time_full(_ev, ngay_lam_viec) if isinstance(_ev, dict) else ""
                    _allow_equal = isinstance(_ev, dict) and _ev.get("type") == "discharge"
                    if _is_time_before_discharge(_tf, discharge_dt, allow_equal=_allow_equal):
                        kept_special_events.append(_ev)
                    else:
                        skipped_special_events.append(_tf)
                if skipped_special_events:
                    LOG.info(_ctx_prefix() + f"[discharge_guard] skip_special_events_after_discharge={skipped_special_events}")
                special_events = kept_special_events

            surgery_active, surgery_reason, surgery_cutoff_text = False, "", ""
            if _surgery_cutoff:
                try:
                    surgery_active, _surgery_cutoff_dt, surgery_reason = _surgery_cutoff(entry_obj)
                    surgery_cutoff_text = _surgery_cutoff_dt.strftime("%H:%M %d/%m/%Y") if _surgery_cutoff_dt else ""
                except Exception:
                    surgery_active, surgery_reason, surgery_cutoff_text = False, "", ""

            if surgery_active and _should_skip_surgery_at:
                kept_hours = set()
                skipped_hours = []
                for _h in all_hours:
                    _time_key = tao_thoi_gian_lap(_h, ngay_lam_viec)
                    try:
                        _skip, _reason, _cutoff = _should_skip_surgery_at(entry_obj, _time_key)
                    except Exception:
                        _skip, _reason, _cutoff = False, "", ""
                    if _skip:
                        skipped_hours.append(_h)
                    else:
                        kept_hours.add(_h)
                if skipped_hours:
                    LOG.info(_ctx_prefix() + f"[surgery_guard] skip_hours_after_surgery={sorted(skipped_hours)} cutoff={surgery_cutoff_text}")
                    print(f"   [RULE] Người bệnh có ngữ cảnh đi mổ/chuyển mổ → bỏ các giờ sau mốc {surgery_cutoff_text or 'đi mổ'}: {sorted(skipped_hours)}")
                all_hours = kept_hours

                kept_special_events = []
                skipped_special_events = []
                for _ev in special_events:
                    _tf = _special_event_time_full(_ev, ngay_lam_viec) if isinstance(_ev, dict) else ""
                    try:
                        _skip_ev, _reason_ev, _cutoff_ev = _should_skip_surgery_at(entry_obj, _tf)
                    except Exception:
                        _skip_ev, _reason_ev, _cutoff_ev = False, "", ""
                    if _skip_ev:
                        skipped_special_events.append(_tf)
                    else:
                        kept_special_events.append(_ev)
                if skipped_special_events:
                    LOG.info(_ctx_prefix() + f"[surgery_guard] skip_special_events_after_surgery={skipped_special_events}")
                special_events = kept_special_events

            # Không cắt theo thời điểm hiện tại/preview. Nút chăm sóc xử lý đủ toàn bộ
            # các mốc thuộc BN/ngày sau khi đã qua guard nhận khoa, đi mổ và ra viện.

            sorted_hours = sorted(list(all_hours))
            special_time_keys = [_special_event_time_full(ev, ngay_lam_viec) for ev in special_events if isinstance(ev, dict)]
            special_time_keys = [x for x in special_time_keys if x]
            scan_targets = list(sorted_hours) + special_time_keys

            print(f"\n[IDENTIFY] BN {ma_bn} ({info['ho_ten']}) | Ngày: {ngay_lam_viec} | Giờ: {sorted_hours} | Phiếu đặc biệt: {special_time_keys}")
            LOG.info(_ctx_prefix() + f"[patient] med_hours={sorted(list(med_hours))} actions_hours={sorted(list(actions_by_hour.keys()))} action_labels_hours={sorted(list(action_care_labels_by_hour.keys()))} full_hours={sorted_hours} special_events={special_time_keys} care_mode={care_mode}")

            # Key để báo cáo kết quả về Node.js — dạng "ma_bn::ngay_lam_viec"
            result_key = f"{ma_bn}::{ngay_lam_viec}" if ngay_lam_viec else ma_bn

            if not sorted_hours and not special_time_keys and not surgery_active:
                reason = discharge_rule_reason or surgery_reason or "Không còn giờ chăm sóc hợp lệ sau khi áp dụng rule."
                print(f"   [SKIP] {reason}")
                ws.results[result_key] = {"success": True, "error": None, "skipped": True, "reason": reason}
                mark_task_status(progress_path, "input_care", result_key, "skipped", reason)
                continue

            try:
                ws.search_patient(ma_bn, allow_completed=is_discharge_day)
            except Exception as _e:
                err_text = str(_e)
                if surgery_active or ("Đi mổ" in err_text) or ("Gây mê hồi sức" in err_text) or ("không còn ở khoa" in err_text.lower()):
                    reason = (surgery_reason or "Người bệnh không còn ở trạng thái Đang thực hiện") + f"; {_e}"
                    print(f"   [SKIP] {reason}")
                    ws.results[result_key] = {"success": True, "error": None, "skipped": True, "reason": reason}
                    mark_task_status(progress_path, "input_care", result_key, "skipped", reason)
                    continue
                raise
            mark_task_status(progress_path, "input_care", result_key, "running")

            try:
                wait.until(EC.element_to_be_clickable((By.XPATH, "//i[contains(@class, 'fa-eye')]"))).click()
                wait.until(EC.element_to_be_clickable((By.ID, "btnTTCS"))).click()
                _wait_after_action(driver, 0.8, ready_timeout=10)
            except Exception as _e:  # was: bare except
                LOG.debug(f"[except] {_e}")
                print("   [!] Không vào được hồ sơ.")
                ws.results[result_key] = {"success": False, "error": f"Không vào được hồ sơ: {_e}"}
                mark_task_status(progress_path, "input_care", result_key, "failed", f"Không vào được hồ sơ: {_e}")
                ws.goto_inpatient_list(); continue

            # Quét 1 lần đầu/BN để tạo cache (không quét lại mỗi giờ) + dọn phiếu 'Mới' (dư) / sai giờ (do tool)
            cs_cache, _entries0 = scan_cham_soc_cache(driver, ngay_lam_viec, hours_needed=scan_targets)
            LOG.info(_ctx_prefix() + f"[cache] scanned_rows={len(_entries0)} keys={len(cs_cache)}")
            cleanup_cham_soc_cache(
                driver,
                cs_cache,
                sorted_hours,
                LIST_NURSE,
                phase="ĐẦU",
                extra_valid_time_keys=special_time_keys,
                protect_before_time_key=receive_time_key if is_postop_receive_day else None,
                remove_tool_rows_at_or_after_time_key=surgery_cutoff_text if surgery_active else None,
            )

            entry_obj = info.get("entry") or {}

            care_jobs = []
            for ev in special_events:
                if not isinstance(ev, dict):
                    continue
                time_str_ev = _special_event_time_full(ev, ngay_lam_viec)
                if not time_str_ev:
                    continue
                ev_type = str(ev.get("type") or "").strip().lower()
                ev_care = str(ev.get("cham_soc") or "").strip() or _special_event_default_care(ev)
                # Dữ liệu đã phân loại trước đó có thể còn lưu event chuyển khoa thường
                # nhưng toàn bộ record có dấu hiệu hậu phẫu/GMHS trả về khoa. Khi đó
                # tuyệt đối không dùng mẫu "Hướng dẫn nội quy khoa phòng".
                if ev_type in ("ward_receive", "interdepartment_receive") and _has_postop_receive_context(entry_obj):
                    ev_care = POSTOP_RECEIVE_CARE
                care_jobs.append({
                    "kind": "special",
                    "time_str": time_str_ev,
                    "hour": _special_event_hour(ev),
                    "dien_bien": str(ev.get("dien_bien") or "").strip() or _special_event_default_dien_bien(ev),
                    "care": ev_care,
                    "needs_vitals": bool(ev.get("needs_vitals", False if ev.get("type") == "discharge" else True)),
                    "nurse_shift_override": _special_event_nurse_shift_override(ev),
                    "actions_set": set(),
                })

            for h in sorted_hours:
                care_jobs.append({
                    "kind": "regular",
                    "time_str": tao_thoi_gian_lap(h, ngay_lam_viec),
                    "hour": h,
                    "needs_vitals": False,
                    "actions_set": set(actions_by_hour.get(h, set())),
                    "action_care_labels": dict(action_care_labels_by_hour.get(h, {}) or {}),
                })

            if surgery_active and _should_skip_surgery_at:
                _kept_jobs = []
                for _job in care_jobs:
                    _ts = _job.get("time_str") or tao_thoi_gian_lap(int(_job.get("hour") or 0), ngay_lam_viec)
                    try:
                        _skip_job, _reason_job, _cutoff_job = _should_skip_surgery_at(entry_obj, _ts)
                    except Exception:
                        _skip_job, _reason_job, _cutoff_job = False, "", ""
                    if _skip_job:
                        LOG.info(_ctx_prefix() + f"[surgery_guard] skip_care_job time={_ts} reason={_reason_job}")
                    else:
                        _kept_jobs.append(_job)
                care_jobs = _kept_jobs

            care_jobs = sorted(care_jobs, key=_care_job_sort_key)
            job_failures = []

            for job in care_jobs:
                h = int(job.get("hour") or 0)
                time_str = job.get("time_str") or tao_thoi_gian_lap(h, ngay_lam_viec)
                actions_set = set(job.get("actions_set") or set())
                needs_vitals = bool(job.get("needs_vitals", False))

                if job.get("kind") == "special":
                    final_care_content = str(job.get("care") or "").strip()
                    dien_bien_text = str(job.get("dien_bien") or "").strip() or "Người bệnh tỉnh"
                else:
                    # Chăm sóc: xử lý toàn bộ giờ có trong dữ liệu/tập giờ tính toán
                    care_parts = []

                    # Bổ sung chăm sóc mặc định:
                    # - giờ có thuốc: 'Thực hiện chỉ định thuốc'
                    # - không thêm 'Dự trù thuốc' vào chăm sóc
                    # - mặc định ở 5h/16h: 'Lấy dấu hiệu sinh tồn'
                    # - ngày nhận bệnh sau mổ/chuyển khoa vẫn giữ cữ 16h và 5h ngày mai để lấy dấu hiệu sinh tồn.
                    care_parts = them_cham_soc_mac_dinh(
                        care_parts,
                        h,
                        med_hours,
                        add_default_vitals=True,
                    )

                    # Bổ sung chăm sóc theo action. Nếu có tên chỉ định gốc thì
                    # dùng nguyên tên đó để khớp giao diện (không rút gọn thành
                    # "Thay băng"). Action không có nhãn gốc mới dùng mẫu mặc định.
                    action_care_labels = job.get("action_care_labels") or {}
                    covered_actions = set()
                    existing_norm = {chuan_hoa_unicode(x) for x in care_parts}
                    for action_id in sorted(actions_set):
                        labels = action_care_labels.get(action_id) or []
                        if not labels:
                            continue
                        covered_actions.add(action_id)
                        for label in labels:
                            label_text = str(label or "").strip()
                            label_norm = chuan_hoa_unicode(label_text)
                            if label_text and label_norm not in existing_norm:
                                care_parts.append(label_text)
                                existing_norm.add(label_norm)

                    care_parts = extend_care_parts(care_parts, actions_set - covered_actions)

                    # Diễn biến:
                    # - Chỉ cữ 8h dùng nhận định chi tiết ở ngày thường
                    # - Ngày nhận bệnh sau mổ/chuyển khoa: diễn biến chi tiết nằm ở phiếu đặc biệt, giờ khác chỉ ghi 'Người bệnh tỉnh'
                    if (not is_postop_receive_day) and (not is_admission_transfer_day) and h == 8:
                        ctx = build_placeholder_context(entry_obj)
                        dien_bien_text = build_dien_bien(DIEN_BIEN_BASE_LINES, actions_set, ctx) or "Người bệnh tỉnh"
                    else:
                        dien_bien_text = "Người bệnh tỉnh"

                    final_care_content = " + ".join(care_parts)
                    final_care_content = final_care_content[0].upper() + final_care_content[1:] if final_care_content else ""

                    # Chặn nội dung 'sau mổ/vết mổ' khi dữ liệu không có ngữ cảnh phẫu thuật/vết thương
                    if final_care_content and (("vết mổ" in final_care_content.lower()) or ("sau mổ" in final_care_content.lower())):
                        has_ctx = _has_surgical_context(entry_obj, actions_set)
                        LOG.info(_ctx_prefix() + f"[postop_guard] detected_postop_text=True has_surgical_context={has_ctx}")
                        if not has_ctx:
                            before = final_care_content
                            final_care_content = _sanitize_postop_text(final_care_content)
                            LOG.warning(_ctx_prefix() + f"[sanitize_postop] removed_postop_parts. before='{before[:120]}' after='{final_care_content[:120]}'")

                LOG.debug(_ctx_prefix() + f"[expected] h={h} time='{time_str}' kind={job.get('kind')} actions={sorted(list(actions_set))} care='{(final_care_content or '')[:200]}' dien_bien='{(dien_bien_text or '')[:160]}'")
                print(f"   + Giờ {time_str}:", end=" ")

                expected_creator = ""
                try:
                    expected_creator = get_nurse_by_shift(time_str, CONFIG_TEN_GOC or {})
                except Exception as _e:
                    LOG.debug(f"[except] {_e}")

                stt, care_id = kiem_tra_bang_cached(
                    cs_cache,
                    time_str,
                    h,
                    final_care_content,
                    LIST_NURSE,
                    dien_bien_text,
                    needs_vitals=needs_vitals,
                    expected_creator=expected_creator,
                )

                if stt == "PERFECT":
                    print("-> [RESULT] OK (đã đúng, không cần sửa).")
                    continue
                elif stt == "SKIP":
                    msg_skip = f"{time_str}: đã có phiếu nhưng EMR không trả mã sửa/xóa; không tạo trùng"
                    print("-> [RESULT] KHÔNG SỬA ĐƯỢC (không tạo trùng).")
                    job_failures.append(msg_skip)
                    LOG.warning(_ctx_prefix() + f"[job_uneditable] {msg_skip}")
                    continue
                elif stt == "UPDATE":
                    print("-> [ACTION] SỬA PHIẾU CŨ: Sửa → Thu hồi → cập nhật → Hoàn tất.", end=" ")
                    try:
                        if care_id:
                            open_cham_soc_by_id(driver, care_id)
                        else:
                            raise RuntimeError("Không lấy được id phiếu")
                        wait.until(EC.visibility_of_element_located((By.ID, "txtThoiGianLap")))
                        click_thu_hoi_cham_soc(driver)
                    except Exception as _e:
                        print(f"[WARN] Không mở/thu hồi được phiếu cũ: {_e}", end=" ")
                elif stt == "EDIT":
                    print("-> [ACTION] THU HỒI/XÓA PHIẾU CŨ.", end=" ")
                    try:
                        if care_id:
                            open_cham_soc_by_id(driver, care_id)
                        else:
                            raise RuntimeError("Không lấy được id phiếu")
                        wait.until(EC.visibility_of_element_located((By.ID, "txtThoiGianLap")))
                        click_thu_hoi_va_xoa(driver)
                    except Exception as _e:
                        print(f"[WARN] Không thu hồi/xóa được: {_e}")
                        # vẫn tiếp tục tạo lại phiếu mới
                    print("-> TẠO LẠI.", end=" ")
                    _safe_js_click(driver, wait.until(EC.element_to_be_clickable((By.ID, "btnThemCS"))))
                else:
                    print("-> TẠO MỚI.", end=" ")
                    _safe_js_click(driver, wait.until(EC.element_to_be_clickable((By.ID, "btnThemCS"))))

                wait.until(EC.visibility_of_element_located((By.ID, "txtThoiGianLap")))

                success = False
                for attempt in range(1, 4):
                    # 1) Set giờ trước (đợi ổn định), tránh việc điền các trường rồi bị reset do đổi giờ
                    ok_time = set_thoi_gian_lap(driver, time_str, max_retry=2)
                    if not ok_time:
                        print(f"[Sai giờ] -> Retry.", end=" ")
                        time.sleep(0.5)
                        continue

                    # 2) Điền các trường khác
                    LOG.debug(_ctx_prefix() + f"[fill] hour={h} time='{time_str}' attempt={attempt} care_len={len(final_care_content or '')} db_len={len(dien_bien_text or '')} needs_vitals={needs_vitals}")
                    form_ok = dien_thong_tin(
                        driver, h, time_str, final_care_content, LIST_NURSE, dien_bien_text,
                        needs_vitals=needs_vitals, config_ten_goc=CONFIG_TEN_GOC,
                    )
                    if not form_ok:
                        print("[Sai Người lập] -> Retry.", end=" ")
                        LOG.warning(_ctx_prefix() + f"[fill_failed] time='{time_str}' reason=invalid_creator attempt={attempt}")
                        time.sleep(0.5)
                        continue
                    btn_luu = driver.find_element(By.ID, "btnSaveChamSocPopupDraw")
                    driver.execute_script("arguments[0].click();", btn_luu)
                    time.sleep(1.5); handle_popups(driver)

                    try:
                        btn_hoan_tat = driver.find_element(By.ID, "btnPopupHOANTAT")
                        driver.execute_script("arguments[0].click();", btn_hoan_tat)
                    except Exception as _e:  # was: bare except
                        LOG.debug(f"[except] {_e}")
                        pass

                    time.sleep(2); handle_popups(driver)
                    stt_badge = check_trang_thai_badge(driver)
                    if "Hoàn tất" in stt_badge:
                        print("-> [RESULT] XONG.")
                        success = True
                        break
                    elif "Mới" in stt_badge:
                        print(".", end=" ")
                    else:
                        if "Hoàn tất" in stt_badge:
                            success = True
                            break

                if not success:
                    msg_fail = f"{time_str}: không lưu/hoàn tất được phiếu chăm sóc"
                    job_failures.append(msg_fail)
                    print(" -> FAIL.")
                    LOG.warning(_ctx_prefix() + f"[job_failed] {msg_fail}")
                try:
                    back_btn = driver.find_element(By.XPATH, "//a[contains(@onclick, 'fnbackFormChamSoc')]")
                    driver.execute_script("arguments[0].click();", back_btn)
                    time.sleep(1)
                except Exception as _e:  # was: bare except
                    LOG.debug(f"[except] {_e}")
                    pass

            # Quét lại 1 lần cuối/BN để dọn phiếu 'Mới' (dư) sau khi nhập xong toàn bộ khung giờ
            try:
                cs_cache_end, _entries1 = scan_cham_soc_cache(driver, ngay_lam_viec, hours_needed=scan_targets)
                cleanup_cham_soc_cache(
                    driver,
                    cs_cache_end,
                    sorted_hours,
                    LIST_NURSE,
                    phase="CUỐI",
                    extra_valid_time_keys=special_time_keys,
                    protect_before_time_key=receive_time_key if is_postop_receive_day else None,
                    remove_tool_rows_at_or_after_time_key=surgery_cutoff_text if surgery_active else None,
                )

                # Ngày chuyển/đi mổ cần verify thật trên EMR sau cleanup. Nếu còn
                # phiếu do tool tạo sau cutoff thì không được báo OK giả.
                if surgery_active and surgery_cutoff_text:
                    cs_cache_verify, _entries_verify = scan_cham_soc_cache(
                        driver, ngay_lam_viec, hours_needed=None
                    )
                    _leftovers = tool_rows_at_or_after(
                        cs_cache_verify, surgery_cutoff_text, LIST_NURSE
                    )
                    if _leftovers:
                        _leftover_times = sorted({str(x.get("time_full") or "") for x in _leftovers if x.get("time_full")})
                        _msg = (
                            f"Còn phiếu chăm sóc do tool tạo sau mốc đi mổ {surgery_cutoff_text}: "
                            + ", ".join(_leftover_times[:8])
                        )
                        if len(_leftover_times) > 8:
                            _msg += f" ... (+{len(_leftover_times) - 8})"
                        LOG.warning(_ctx_prefix() + f"[surgery_guard][FINAL_VERIFY_FAIL] {_msg}")
                        print(f"   [FAIL][SURGERY_VERIFY] {_msg}")
                        job_failures.append(_msg)
                    else:
                        LOG.info(_ctx_prefix() + f"[surgery_guard][FINAL_VERIFY_OK] Không còn phiếu tool sau cutoff={surgery_cutoff_text}")
            except Exception as _e:
                print(f"   [WARN] Final check lỗi: {_e}")

            # Quay về danh sách bằng URL/session hiện tại thay vì driver.back() để tránh lệch history stack.
            ws.goto_inpatient_list()
            # Nếu có bất kỳ giờ nào nhập thất bại → không mark done cả ngày.
            if job_failures:
                err_text = "; ".join(job_failures[:8])
                if len(job_failures) > 8:
                    err_text += f"; ... (+{len(job_failures) - 8} lỗi)"
                ws.results[result_key] = {"success": False, "error": err_text, "failed_jobs": job_failures}
                mark_task_status(progress_path, "input_care", result_key, "failed", err_text)
            elif result_key not in ws.results:
                ws.results[result_key] = {"success": True, "error": None}
                mark_task_status(progress_path, "input_care", result_key, "done")

        print("\n>>> TẤT CẢ ĐÃ XỬ LÝ XONG!")
        (input(">>> Nhấn ENTER để thoát...") if sys.stdin.isatty() else None)

    # driver.quit() + write_worker_result() chạy tự động khi thoát with
    failed_count = sum(1 for v in ws.results.values() if not v.get("success"))
    return 2 if failed_count > 0 else 0

if __name__ == "__main__":
    rc = main()
    sys.exit(rc if isinstance(rc, int) else 0)
