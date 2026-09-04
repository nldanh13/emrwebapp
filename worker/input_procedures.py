# -*- coding: utf-8 -*-
"""input_procedures.py — Tự động vào D/s Thủ thuật và nhập thực hiện thủ thuật.

Bản đầu tiên cho luồng CTCH thay băng:
  - Vào wpid=danhsachthuthuatdraw.
  - Tìm dòng theo mã BN/ngày.
  - Mở thủ thuật bằng link tên người bệnh.
  - Bấm "Vào thực hiện".
  - Điền giờ bắt đầu, giờ kết thúc = bắt đầu + 10 phút.
  - Chọn phương pháp vô cảm = Không.
  - Chọn thủ thuật viên theo lịch điều dưỡng.
  - Chọn mẫu tường trình = CTCH-thay băng.
  - Bấm Lưu/Hoàn tất nếu tìm thấy nút phù hợp.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Sequence, Tuple
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

try:
    from selenium.webdriver.common.by import By
    from selenium.webdriver.common.keys import Keys
    from selenium.webdriver.common.action_chains import ActionChains
    from selenium.webdriver.support import expected_conditions as EC
    from selenium.webdriver.support.ui import WebDriverWait
except Exception:  # pragma: no cover - cho phép unit test helper khi chưa cài Selenium
    By = Keys = ActionChains = EC = WebDriverWait = None  # type: ignore

from utils import chuan_hoa_unicode, get_nurse_by_shift, handle_popups, login_emr
from shared.text_utils import norm_vi as _norm
from shared.worker_session import WorkerSession, open_session
from shared.json_io import read_json_critical, read_json_optional
from selenium_emr_helpers import build_inpatient_url, debug_page, safe_js_click, wait_after_action
from task_progress_writer import mark_task_status, progress_path_from_input

try:
    from infusion_select2 import chon_select2_bac_si_y_ta
except Exception:
    chon_select2_bac_si_y_ta = None
try:
    from surgery_guard import should_skip_ward_input_at as _should_skip_surgery_at
except Exception:
    _should_skip_surgery_at = None

TASK_NAME = "input_procedures"
DEFAULT_WPID = "danhsachthuthuatdraw"
DEFAULT_TEMPLATE = "CTCH-thay băng"
DEFAULT_ANESTHESIA = "Không"
DEFAULT_DURATION_MINUTES = 10
PROCEDURE_KEYWORDS = (
    "thay băng", "thay bang",
    "cắt chỉ", "cat chi",
    "cắt chỉ vết mổ", "cat chi vet mo",
    "thay băng vết mổ", "thay bang vet mo",
)


class ProcedureAlreadyCompleted(RuntimeError):
    """Dòng thủ thuật đã có trạng thái Hoàn tất trên D/s Thủ thuật."""


def _log(msg: str) -> None:
    print(msg, flush=True)


def _read_json(path: str, default: Any, *, critical: bool = False) -> Any:
    if not path:
        return default
    if critical:
        expected = dict if isinstance(default, dict) else list if isinstance(default, list) else None
        return read_json_critical(path, default, expected_type=expected)
    return read_json_optional(path, default)


def _parse_date_dmy(s: Any) -> Optional[datetime]:
    text = str(s or "").strip()
    m = re.search(r"(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})", text)
    if not m:
        return None
    d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if y < 100:
        y += 2000
    try:
        return datetime(y, mo, d)
    except Exception:
        return None


def _date_key(dt: Optional[datetime]) -> str:
    return dt.strftime("%d/%m/%Y") if dt else ""


def _parse_dt_from_text(text: Any) -> Optional[datetime]:
    raw = str(text or "")
    patterns = [
        r"(\d{1,2}):(\d{2})\s+(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})",
        r"(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\s+(\d{1,2}):(\d{2})",
    ]
    for idx, pat in enumerate(patterns):
        m = re.search(pat, raw)
        if not m:
            continue
        try:
            if idx == 0:
                hh, mi, dd, mm, yyyy = int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4)), int(m.group(5))
            else:
                dd, mm, yyyy, hh, mi = int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4)), int(m.group(5))
            if yyyy < 100:
                yyyy += 2000
            return datetime(yyyy, mm, dd, hh, mi)
        except Exception:
            continue
    return None



def _resolve_discharge_dt(row: Dict[str, Any]) -> Optional[datetime]:
    """Lấy mốc ra viện của người bệnh nếu record có xử trí ra viện."""
    if not isinstance(row, dict):
        return None
    blob = _norm(" ".join(str(row.get(k) or "") for k in ("xu_tri", "Xử trí", "ngay_ra_vien", "gio_ra_vien", "ngay_ra_vien_date")))
    if "ra vien" not in blob and not row.get("ngay_ra_vien") and not row.get("gio_ra_vien"):
        return None
    date_part = str(row.get("ngay_ra_vien_date") or row.get("ngay_lam") or "").strip()
    time_part = str(row.get("gio_ra_vien") or "").strip()
    candidates = []
    if time_part and date_part:
        candidates.append(f"{time_part} {date_part}")
    candidates.extend([
        str(row.get("ngay_ra_vien") or "").strip(),
        str(row.get("Ngày ra viện") or "").strip(),
    ])
    for raw in candidates:
        dt = _parse_dt_from_text(raw)
        if dt:
            return dt
    return None


def _parse_task_discharge_dt(task: Dict[str, str]) -> Optional[datetime]:
    return _parse_dt_from_text(task.get("discharge_time") or "")


def _procedure_interval_before_discharge(start_dt: datetime, duration_minutes: int, discharge_dt: Optional[datetime]) -> Tuple[datetime, datetime]:
    """Tạo khoảng thủ thuật, bảo đảm giờ kết thúc trước giờ ra viện nếu có."""
    duration = max(int(duration_minutes or DEFAULT_DURATION_MINUTES), 1)
    end_dt = start_dt + timedelta(minutes=duration)
    if not discharge_dt:
        return start_dt, end_dt

    latest_end = discharge_dt - timedelta(minutes=1)
    # Nếu thủ thuật ở ngày sau ra viện thì không nên thực hiện.
    if start_dt.date() > discharge_dt.date():
        raise RuntimeError(f"Thủ thuật sau ngày ra viện ({_fmt_hhmm_dmy(discharge_dt)}), bỏ qua để tránh nhập sai thực tế.")

    if start_dt.date() == discharge_dt.date() and end_dt >= discharge_dt:
        adjusted_end = latest_end
        adjusted_start = adjusted_end - timedelta(minutes=duration)
        # Nếu giờ bắt đầu ban đầu vẫn trước mốc và đủ nằm trước giờ ra viện thì giữ bắt đầu, chỉ cắt giờ kết thúc.
        if start_dt < discharge_dt and start_dt < adjusted_end:
            adjusted_start = start_dt
        if adjusted_start >= adjusted_end:
            adjusted_start = adjusted_end - timedelta(minutes=1)
        _log(
            f"[DISCHARGE] Điều chỉnh giờ thủ thuật để kết thúc trước giờ ra viện "
            f"{_fmt_hhmm_dmy(discharge_dt)}: {_fmt_hhmm_dmy(start_dt)} → "
            f"{_fmt_hhmm_dmy(adjusted_start)} - {_fmt_hhmm_dmy(adjusted_end)}"
        )
        return adjusted_start, adjusted_end

    return start_dt, end_dt


def _truthy_config(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in ("1", "true", "yes", "y", "on", "co", "có"):
        return True
    if text in ("0", "false", "no", "n", "off", "khong", "không"):
        return False
    return default


def _adjust_procedure_start_for_actual_work(start_dt: datetime, service_name: str, config: dict) -> datetime:
    """
    DVKT thay băng/cắt chỉ thường được chỉ định lúc dự trù thuốc/y lệnh sớm
    nhưng điều dưỡng ca ngày mới thực hiện. Nếu giờ dự kiến < 07:00, không lấy
    giờ đó để chọn người trực; chuyển mốc thực hiện về 07:00 cùng ngày.
    
    Có thể tắt bằng config: procedure_adjust_early_to_work_shift=false.
    """
    if not _truthy_config(config.get("procedure_adjust_early_to_work_shift"), True):
        return start_dt
    if not _has_target_procedure_text(service_name):
        return start_dt
    if start_dt.hour < 7:
        adjusted = start_dt.replace(hour=7, minute=0, second=0, microsecond=0)
        _log(
            f"[SHIFT] Giờ thủ thuật {_fmt_hhmm_dmy(start_dt)} nằm trước 07:00 "
            f"nên dùng mốc thực hiện {_fmt_hhmm_dmy(adjusted)} để chọn người làm ca ngày."
        )
        return adjusted
    return start_dt


def _fmt_hhmm_dmy(dt: datetime) -> str:
    return dt.strftime("%H:%M %d/%m/%Y")


def _procedure_expected_values(
    config: dict,
    start_dt: datetime,
    discharge_dt: Optional[datetime] = None,
    service_name: str = "",
    task: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Tính một lần bộ giá trị chuẩn để dùng cho cả kiểm tra và nhập/sửa."""
    duration = int(config.get("procedure_duration_minutes") or DEFAULT_DURATION_MINUTES)
    if duration <= 0:
        duration = DEFAULT_DURATION_MINUTES

    actual_start = _adjust_procedure_start_for_actual_work(start_dt, service_name, config)
    actual_start, actual_end = _procedure_interval_before_discharge(actual_start, duration, discharge_dt)

    task = task or {}
    staff_name = str(task.get("procedure_staff_name") or config.get("procedure_staff_name") or "").strip()
    if not staff_name:
        force_shift = str(config.get("procedure_staff_shift") or "").strip().lower()
        if force_shift not in ("work", "oncall"):
            force_shift = None
        staff_name = get_nurse_by_shift(
            _fmt_hhmm_dmy(actual_start),
            config.get("ten_dieu_duong") or {},
            force_shift=force_shift,
        )

    return {
        "start_dt": actual_start,
        "end_dt": actual_end,
        "start_text": _fmt_hhmm_dmy(actual_start),
        "end_text": _fmt_hhmm_dmy(actual_end),
        "anesthesia": str(config.get("procedure_anesthesia_method") or DEFAULT_ANESTHESIA).strip(),
        "staff_name": str(staff_name or "").strip(),
        "template_name": str(task.get("procedure_template_name") or config.get("procedure_template_name") or DEFAULT_TEMPLATE).strip(),
    }


# _norm → shared.text_utils.norm_vi


def _short_service_key(service_name: str) -> str:
    text = re.sub(r"\s+", " ", str(service_name or "").strip())
    return text[:80] if text else ""


def _done_key(ma_bn: str, ngay: str, service_name: str = "") -> str:
    ma_bn = str(ma_bn or "").strip()
    ngay = str(ngay or "").strip()
    service = _short_service_key(service_name)
    base = f"{ma_bn}::{ngay}" if ngay else ma_bn
    return f"{base}::{service}" if service else base


def _has_target_procedure_text(text: Any) -> bool:
    n = _norm(text)
    if not n:
        return False
    return any(_norm(k) in n for k in PROCEDURE_KEYWORDS)


def _is_real_procedure_service(text: Any) -> bool:
    raw = str(text or "").strip()
    if not raw:
        return False
    n = _norm(raw)
    # Không lấy cảnh báo/y lệnh chưa lên mã DVKT vì trường hợp này không có dòng ở D/s Thủ thuật.
    if "chua len ma" in n or "chua len dvkt" in n or "canh bao" in n:
        return False
    return _has_target_procedure_text(raw)


def _extract_target_procedure_services(row: Dict[str, Any]) -> List[Dict[str, str]]:
    services: List[Dict[str, str]] = []
    seen = set()

    def add_item(item: Any, source: str = "") -> None:
        if isinstance(item, dict):
            ten = str(item.get("ten") or item.get("name") or item.get("label") or "").strip()
            gio = str(item.get("gio") or item.get("time") or item.get("thoi_gian") or "").strip()
            note = str(item.get("note") or "").strip()
        else:
            ten = str(item or "").strip()
            gio = ""
            note = ""
        if note and ("chua len ma" in _norm(note) or "canh bao" in _norm(note)):
            return
        if not _is_real_procedure_service(ten):
            return
        key = (_norm(ten), str(gio or "").strip())
        if key in seen:
            return
        seen.add(key)
        services.append({"ten": ten, "gio": gio, "source": source})

    cs = row.get("chi_dinh_khac") or {}
    if isinstance(cs, dict):
        for item in cs.get("thay_bang_cat_chi") or []:
            add_item(item, "chi_dinh_khac.thay_bang_cat_chi")

    for item in row.get("chi_dinh_dvkt") or []:
        add_item(item, "chi_dinh_dvkt")

    for key in ("dich_vu_ky_thuat", "dvkt", "ten_dich_vu", "ten_thu_thuat"):
        val = row.get(key)
        if isinstance(val, list):
            for item in val:
                add_item(item, key)
        elif val:
            add_item(val, key)

    return services


def _first_dmy_from_task(task: Dict[str, Any]) -> str:
    for key in ("ngay_lam", "date", "service_time", "thoi_gian", "time"):
        dt = _parse_date_dmy(task.get(key))
        if dt:
            return _date_key(dt)
    return ""


def _prepare_direct_procedure_tasks(raw: Any) -> List[Dict[str, str]]:
    """Nhận task thủ thuật trực tiếp từ tab Phòng khám/outpatient."""
    if not isinstance(raw, dict):
        return []
    items = raw.get("procedureTasks") or raw.get("procedure_tasks") or []
    if not isinstance(items, list) or not items:
        return []
    tasks: List[Dict[str, str]] = []
    seen = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        ma_bn = str(item.get("ma_bn") or item.get("id") or "").strip()
        if not ma_bn:
            continue
        ngay = _first_dmy_from_task(item)
        service_name = str(item.get("service_name") or item.get("ten_thu_thuat") or "Thủ thuật phòng khám").strip()
        key = _done_key(ma_bn, ngay, service_name)
        if key in seen:
            continue
        seen.add(key)
        tasks.append({
            "ma_bn": ma_bn,
            "ngay_lam": ngay,
            "ho_ten": str(item.get("ho_ten") or item.get("name") or "").strip(),
            "service_name": service_name,
            "service_time": str(item.get("service_time") or item.get("thoi_gian") or "").strip(),
            "service_source": str(item.get("source") or "direct").strip(),
            "discharge_time": str(item.get("discharge_time") or "").strip(),
            "procedure_staff_name": str(item.get("procedure_staff_name") or "").strip(),
            "procedure_staff_role": str(item.get("procedure_staff_role") or "").strip(),
            "procedure_template_name": str(item.get("procedure_template_name") or "").strip(),
            "clinic_mode": "1" if raw.get("clinicMode") or raw.get("clinic_mode") else "",
        })
    if tasks:
        _log(f"[FILTER] Nhận trực tiếp {len(tasks)} thủ thuật từ tab Phòng khám.")
    return tasks


def _merge_target_config(base: dict, targets_path: str) -> dict:
    cfg = dict(base or {})
    raw = _read_json(targets_path, {}, critical=True) if targets_path else {}
    extra = {}
    if isinstance(raw, dict):
        extra = raw.get("clinicProcedureConfig") or raw.get("clinic_procedure_config") or {}
    if isinstance(raw, dict):
        cfg["repair_existing"] = bool(raw.get("repairExisting") or raw.get("repair_existing") or raw.get("allowRepairExisting"))
        if raw.get("directEmrSync") or raw.get("direct_emr_sync") or raw.get("visibleBrowser") or raw.get("visible_browser"):
            cfg["headless"] = False
            _log("[MODE] Chế độ đồng bộ trực tiếp: mở Chrome để kiểm tra / nhập / sửa thủ thuật trên EMR.")

    if isinstance(extra, dict):
        aliases = {
            "loginUrl": "url_login",
            "login_url": "url_login",
            "username": "username",
            "password": "password",
            "headless": "headless",
            "procedureTemplateName": "procedure_template_name",
            "procedure_template_name": "procedure_template_name",
            "procedureDurationMinutes": "procedure_duration_minutes",
            "procedure_duration_minutes": "procedure_duration_minutes",
        }
        for src, dst in aliases.items():
            if src in extra and extra.get(src) not in (None, ""):
                cfg[dst] = extra.get(src)
        # Cho phép truyền sẵn đúng key config.
        for key in ("url_login", "username", "password", "headless", "procedure_template_name", "procedure_duration_minutes"):
            if key in extra and extra.get(key) not in (None, ""):
                cfg[key] = extra.get(key)
    return cfg

def _read_targets(targets_path: str) -> Tuple[set[str], set[str], Dict[str, set[str]]]:
    raw = _read_json(targets_path, {}, critical=True) if targets_path else {}
    ids: set[str] = set()
    selected_dates: set[str] = set()
    patient_dates: Dict[str, set[str]] = {}

    for item in raw.get("patientIds") or []:
        sid = str(item or "").strip()
        if sid:
            ids.add(sid)

    for x in raw.get("selectedDates") or []:
        dt = _parse_date_dmy(x)
        if dt:
            selected_dates.add(_date_key(dt))

    pd = raw.get("patientDates") or {}
    if isinstance(pd, dict):
        for pid, arr in pd.items():
            sid = str(pid or "").strip()
            if not sid:
                continue
            vals: set[str] = set()
            for x in arr or []:
                dt = _parse_date_dmy(x)
                if dt:
                    vals.add(_date_key(dt))
            if vals:
                patient_dates[sid] = vals
                ids.add(sid)

    return ids, selected_dates, patient_dates


def _prepare_tasks(processed_path: str, targets_path: str) -> List[Dict[str, str]]:
    raw_targets = _read_json(targets_path, {}, critical=True) if targets_path else {}
    direct_tasks = _prepare_direct_procedure_tasks(raw_targets)
    if direct_tasks:
        return direct_tasks
    rows = _read_json(processed_path, [], critical=True)
    rows = rows if isinstance(rows, list) else []
    patient_ids, selected_dates, patient_dates = _read_targets(targets_path)

    tasks: List[Dict[str, str]] = []
    seen = set()
    skipped_no_service = 0
    skipped_surgery_out = 0

    def wanted_date_for_patient(pid: str, ngay: str) -> bool:
        if patient_dates.get(pid):
            return ngay in patient_dates[pid]
        if selected_dates:
            return ngay in selected_dates
        return True

    for row in rows:
        if not isinstance(row, dict):
            continue
        ma_bn = str(row.get("ma_bn") or row.get("id") or "").strip()
        if not ma_bn:
            continue
        if patient_ids and ma_bn not in patient_ids:
            continue
        dt = _parse_date_dmy(row.get("ngay_lam"))
        ngay = _date_key(dt) if dt else str(row.get("ngay_lam") or "").strip()
        if not ngay or not wanted_date_for_patient(ma_bn, ngay):
            continue

        services = _extract_target_procedure_services(row)
        if _should_skip_surgery_at and services:
            kept_services = []
            for svc in services:
                svc_time = svc.get('gio') or svc.get('time') or ''
                try:
                    skip_surgery, skip_reason, _cutoff = _should_skip_surgery_at(row, svc_time)
                except Exception:
                    skip_surgery, skip_reason, _cutoff = False, "", ""
                if skip_surgery:
                    skipped_surgery_out += 1
                    _log(f"[FILTER] Bỏ qua thủ thuật BN {ma_bn} ngày {ngay}: {skip_reason}")
                else:
                    kept_services.append(svc)
            services = kept_services

        if not services:
            skipped_no_service += 1
            continue

        for svc in services:
            service_name = str(svc.get("ten") or "").strip()
            key = _done_key(ma_bn, ngay, service_name)
            if key in seen:
                continue
            seen.add(key)
            discharge_dt = _resolve_discharge_dt(row)
            tasks.append({
                "ma_bn": ma_bn,
                "ngay_lam": ngay,
                "ho_ten": str(row.get("ho_ten") or row.get("name") or "").strip(),
                "service_name": service_name,
                "service_time": str(svc.get("gio") or "").strip(),
                "service_source": str(svc.get("source") or "").strip(),
                "discharge_time": _fmt_hhmm_dmy(discharge_dt) if discharge_dt else "",
            })

    if skipped_no_service:
        _log(f"[FILTER] Bỏ qua {skipped_no_service} BN/ngày vì không có DVKT thay băng/cắt chỉ.")
    if skipped_surgery_out:
        _log(f"[FILTER] Bỏ qua {skipped_surgery_out} BN/ngày vì người bệnh đã chuyển mổ/chưa nhận lại khoa.")
    _log(f"[FILTER] Số thủ thuật thay băng/cắt chỉ cần nhập: {len(tasks)}")
    return tasks

def _build_wpid_url(base_url: str, wpid: str) -> str:
    try:
        return build_inpatient_url(base_url, wpid)
    except Exception:
        p = urlparse(base_url or "")
        q = dict(parse_qsl(p.query, keep_blank_values=True))
        q["wpid"] = wpid
        return urlunparse((p.scheme, p.netloc, p.path, p.params, urlencode(q), p.fragment))


def _goto_procedure_list(driver: Any, wait: Any, config: dict) -> None:
    wpid = str(config.get("procedure_list_wpid") or DEFAULT_WPID).strip() or DEFAULT_WPID
    current = (driver.current_url or "").strip()
    configured = str(config.get("url_procedure_list") or "").strip()
    if "home.aspx" in current.lower() and "usid=" in current.lower():
        url = _build_wpid_url(current, wpid)
    elif configured:
        url = configured
    else:
        url = _build_wpid_url(current, wpid)
    _log(f"[NAV] Vào D/s Thủ thuật: {url}")
    driver.get(url)
    wait_after_action(driver, 1.0, ready_timeout=15)
    if "login.aspx" in (driver.current_url or "").lower():
        _log("[NAV] EMR trả về login.aspx, đăng nhập lại...")
        login_emr(driver, wait, config)
        current = (driver.current_url or "").strip()
        driver.get(_build_wpid_url(current, wpid))
        wait_after_action(driver, 1.0, ready_timeout=15)


def _set_input_value(driver: Any, field_id: str, value: str) -> None:
    el = WebDriverWait(driver, 15).until(EC.presence_of_element_located((By.ID, field_id)))
    driver.execute_script(
        "arguments[0].scrollIntoView({block:'center'});"
        "arguments[0].focus(); arguments[0].value=''; arguments[0].value=arguments[1];"
        "arguments[0].dispatchEvent(new Event('input', {bubbles:true}));"
        "arguments[0].dispatchEvent(new Event('change', {bubbles:true}));"
        "arguments[0].dispatchEvent(new Event('blur', {bubbles:true}));",
        el, str(value or "")
    )
    time.sleep(0.15)


def _try_search_on_list(driver: Any, wait: Any, ma_bn: str, ho_ten: str = "") -> None:
    candidates = [
        "txtTimKiem", "txtSearch", "txtKeyword", "txtTuKhoa", "txtSearchAll", "txtMaBN",
        "txtHoTen", "txtTukhoa", "txtSearchString",
    ]
    for field_id in candidates:
        try:
            el = driver.find_element(By.ID, field_id)
            if not el.is_displayed() or not el.is_enabled():
                continue
            el.click()
            try:
                el.clear()
            except Exception:
                driver.execute_script("arguments[0].value='';", el)
            el.send_keys(str(ma_bn))
            el.send_keys(Keys.ENTER)
            wait_after_action(driver, 0.5, ready_timeout=8)
            _click_filter_search(driver)
            _log(f"[SEARCH] Tìm thủ thuật theo mã BN {ma_bn} bằng #{field_id}")
            return
        except Exception:
            continue
    _log("[SEARCH] Không thấy ô tìm kiếm trên D/s Thủ thuật; sẽ dò trên bảng hiện tại.")


def _row_date_matches(row_text: str, wanted_date: str) -> bool:
    if not wanted_date:
        return True
    if wanted_date in row_text:
        return True
    dt = _parse_dt_from_text(row_text)
    return bool(dt and _date_key(dt) == wanted_date)


def _row_service_matches(row_text: str, service_name: str = "", clinic_mode: bool = False) -> bool:
    service_norm = _norm(service_name)
    row_norm = _norm(row_text)
    # Luồng phòng khám lấy Tên chỉ định từ popup TT. Nếu D/s Thủ thuật hiển thị tên này
    # thì khớp chính xác hơn để tránh mở nhầm khi một BN có nhiều TT cùng ngày.
    # Nếu không có service_name, hoặc caller fallback service_name="", chấp nhận theo BN/ngày.
    if clinic_mode:
        if not service_norm or service_norm in {"thu thuat phong kham", "chua doc popup tt"}:
            return True
        return service_norm in row_norm
    # Luồng nội trú chỉ nên xử lý dòng có tên DVKT thay băng/cắt chỉ.
    if not _has_target_procedure_text(row_text):
        return False
    if not service_norm:
        return True
    if service_norm in row_norm:
        return True
    # Tên ở danh sách có thể dài/ngắn khác y lệnh, nên chấp nhận cùng nhóm thay băng/cắt chỉ.
    return _has_target_procedure_text(service_name) and _has_target_procedure_text(row_text)


def _procedure_day_range_values(wanted_date: str) -> Tuple[str, str]:
    """Tạo giá trị cho bộ lọc Khoảng trên D/s Thủ thuật theo ngày cần nhập."""
    dt = _parse_date_dmy(wanted_date) or datetime.now()
    dmy = _date_key(dt)
    return f"00:00 {dmy}", f"23:59 {dmy}"


def _click_filter_search(driver: Any) -> bool:
    """Bấm nút Tìm kiếm của danh sách thủ thuật hoặc gọi FilterChange nếu có."""
    clicked = False
    try:
        btn = driver.find_element(By.ID, "btnTimKiem")
        if btn.is_displayed() and btn.is_enabled():
            safe_js_click(driver, btn)
            clicked = True
    except Exception:
        clicked = False
    if not clicked:
        try:
            clicked = bool(driver.execute_script(
                "if (typeof FilterChange === 'function') { FilterChange(); return true; } return false;"
            ))
        except Exception:
            clicked = False
    if clicked:
        wait_after_action(driver, 0.9, ready_timeout=12)
        handle_popups(driver)
    return clicked


def _apply_procedure_date_range_filter(driver: Any, wait: Any, wanted_date: str, config: dict) -> None:
    """
    D/s Thủ thuật mặc định tải 'Trong ngày'. Với thủ thuật của ngày hôm qua/ngày khác,
    phải chuyển cbbLoai sang 'Khoảng' và đặt dtTuNgay/dtDenNgay theo ngày cần nhập
    trước khi tìm mã bệnh nhân.
    """
    if not _truthy_config((config or {}).get("procedure_force_date_range_filter"), True):
        return
    dt = _parse_date_dmy(wanted_date)
    if not dt:
        _log(f"[FILTER] Không xác định được ngày thủ thuật từ '{wanted_date}', giữ bộ lọc thời gian hiện tại.")
        return

    start_value, end_value = _procedure_day_range_values(wanted_date)
    try:
        WebDriverWait(driver, 12).until(EC.presence_of_element_located((By.ID, "cbbLoai")))
    except Exception:
        _log("[FILTER] Không thấy bộ lọc thời gian #cbbLoai trên D/s Thủ thuật; bỏ qua đặt khoảng ngày.")
        return

    try:
        ok = bool(driver.execute_script(
            r"""
            const startValue = arguments[0];
            const endValue = arguments[1];

            function fire(el, name) {
              try { el.dispatchEvent(new Event(name, { bubbles: true })); } catch (e) {}
            }
            function clearPickerLimits(el) {
              if (!window.jQuery || !el) return;
              try {
                const picker = window.jQuery(el).data('DateTimePicker');
                if (picker) {
                  try { picker.minDate(false); } catch (e) {}
                  try { picker.maxDate(false); } catch (e) {}
                }
              } catch (e) {}
            }
            function setDateInput(id, value) {
              const el = document.getElementById(id);
              if (!el) return false;
              clearPickerLimits(el);
              try { el.focus(); } catch (e) {}
              el.value = value;
              fire(el, 'input');
              fire(el, 'change');
              fire(el, 'blur');
              if (window.jQuery) {
                try {
                  const $el = window.jQuery(el);
                  const picker = $el.data('DateTimePicker');
                  if (picker && typeof picker.date === 'function') {
                    try { picker.date(value); } catch (e) {}
                  }
                  $el.val(value).trigger('dp.change').trigger('change');
                } catch (e) {}
              }
              return true;
            }

            const select = document.getElementById('cbbLoai');
            if (!select) return false;
            select.value = '7';
            try {
              for (const opt of Array.from(select.options || [])) opt.selected = (opt.value === '7');
            } catch (e) {}
            if (typeof ThoiGianValueChange === 'function') {
              try { ThoiGianValueChange(select); } catch (e) {}
            }
            fire(select, 'change');
            if (window.jQuery) {
              try { window.jQuery(select).val('7').trigger('change'); } catch (e) {}
            }
            const rangeBox = document.getElementById('data_5');
            if (rangeBox) rangeBox.style.display = 'block';

            return setDateInput('dtTuNgay', startValue) && setDateInput('dtDenNgay', endValue);
            """,
            start_value,
            end_value,
        ))
    except Exception as exc:
        _log(f"[FILTER] Lỗi đặt khoảng ngày thủ thuật {wanted_date}: {exc}")
        return

    if not ok:
        _log(f"[FILTER] Không đặt được khoảng ngày {wanted_date}; tiếp tục tìm trên danh sách hiện tại.")
        return

    _log(f"[FILTER] Đặt D/s Thủ thuật theo Khoảng: {start_value} - {end_value}")
    if not _click_filter_search(driver):
        _log("[FILTER] Không bấm được nút Tìm kiếm sau khi đặt khoảng; sẽ tiếp tục tìm mã BN trên bảng hiện tại.")


def _find_matching_rows(driver: Any, ma_bn: str, wanted_date: str, service_name: str = "", clinic_mode: bool = False) -> List[Any]:
    rows: List[Any] = []
    xpaths = [
        f"//tr[.//a[contains(normalize-space(.), '{ma_bn}')]]",
        f"//tr[td[contains(normalize-space(.), '{ma_bn}')]]",
        f"//tr[contains(normalize-space(.), '{ma_bn}')]",
    ]
    seen_ids = set()
    for xp in xpaths:
        try:
            for row in driver.find_elements(By.XPATH, xp):
                try:
                    marker = row.get_attribute("access_id") or row.id
                except Exception:
                    marker = id(row)
                if marker in seen_ids:
                    continue
                seen_ids.add(marker)
                text = row.text or ""
                if ma_bn in text and _row_date_matches(text, wanted_date) and _row_service_matches(text, service_name, clinic_mode=clinic_mode):
                    rows.append(row)
        except Exception:
            continue
    return rows


def _row_status_text(row: Any) -> str:
    """Lấy cột Trạng thái ở D/s Thủ thuật; cột này thường là td cuối cùng, có badge Hoàn tất/Chờ thực hiện."""
    try:
        tds = row.find_elements(By.TAG_NAME, "td")
    except Exception:
        tds = []
    if tds:
        for idx in (13, len(tds) - 1):
            if 0 <= idx < len(tds):
                text = (tds[idx].text or "").strip()
                if text:
                    return text
    try:
        badges = row.find_elements(By.XPATH, ".//span[contains(@class,'badge')]")
        for badge in reversed(badges):
            text = (badge.text or "").strip()
            if text:
                return text
    except Exception:
        pass
    return ""


def _is_completed_procedure_row(row: Any) -> bool:
    return "hoan tat" in _norm(_row_status_text(row))


def _split_rows_by_completion(rows: Sequence[Any]) -> Tuple[List[Any], List[Any]]:
    pending: List[Any] = []
    completed: List[Any] = []
    for row in rows or []:
        if _is_completed_procedure_row(row):
            completed.append(row)
        else:
            pending.append(row)
    return pending, completed

def _try_next_page(driver: Any) -> bool:
    next_xpaths = [
        "//a[contains(@class,'paginate_button') and not(contains(@class,'disabled')) and (normalize-space(.)='Next' or contains(normalize-space(.),'Sau') or contains(normalize-space(.),'›') or contains(normalize-space(.),'»'))]",
        "//li[not(contains(@class,'disabled'))]/a[normalize-space(.)='Next' or contains(normalize-space(.),'Sau') or contains(normalize-space(.),'›') or contains(normalize-space(.),'»')]",
    ]
    for xp in next_xpaths:
        try:
            btn = driver.find_element(By.XPATH, xp)
            if btn.is_displayed() and btn.is_enabled():
                safe_js_click(driver, btn)
                wait_after_action(driver, 0.8, ready_timeout=8)
                return True
        except Exception:
            continue
    return False


def _open_procedure_row(
    driver: Any,
    wait: Any,
    ma_bn: str,
    wanted_date: str,
    service_name: str = "",
    clinic_mode: bool = False,
    allow_completed_update: bool = False,
    return_meta: bool = False,
):
    rows = _find_matching_rows(driver, ma_bn, wanted_date, service_name, clinic_mode=clinic_mode)
    for _ in range(4):
        if rows:
            break
        if not _try_next_page(driver):
            break
        rows = _find_matching_rows(driver, ma_bn, wanted_date, service_name, clinic_mode=clinic_mode)
    if not rows and clinic_mode and service_name:
        _log(f"[WARN] Không khớp chính xác Tên chỉ định '{service_name}' trên D/s Thủ thuật; fallback theo BN/ngày.")
        rows = _find_matching_rows(driver, ma_bn, wanted_date, "", clinic_mode=True)
    if not rows:
        raise RuntimeError(
            f"Không tìm thấy dòng thủ thuật thay băng/cắt chỉ của BN {ma_bn}"
            + (f" ngày {wanted_date}" if wanted_date else "")
            + (f" | DVKT: {service_name}" if service_name else "")
        )

    pending_rows, completed_rows = _split_rows_by_completion(rows)
    if completed_rows and not pending_rows and not allow_completed_update:
        status_text = _row_status_text(completed_rows[0]) or "Hoàn tất"
        _log(
            f"[DONE] Thủ thuật BN {ma_bn}"
            + (f" ngày {wanted_date}" if wanted_date else "")
            + (f" | {service_name}" if service_name else "")
            + f" đã có trạng thái '{status_text}' trên D/s Thủ thuật; bỏ qua nhập lại."
        )
        raise ProcedureAlreadyCompleted("Đã Hoàn tất trên D/s Thủ thuật")
    if completed_rows and not pending_rows and allow_completed_update:
        status_text = _row_status_text(completed_rows[0]) or "Hoàn tất"
        _log(
            f"[REPAIR] Thủ thuật BN {ma_bn}"
            + (f" ngày {wanted_date}" if wanted_date else "")
            + (f" | {service_name}" if service_name else "")
            + f" đã '{status_text}', vẫn mở để Thu hồi/sửa nhân sự theo lịch mới."
        )
    if completed_rows and pending_rows:
        _log(
            f"[SKIP] Có {len(completed_rows)} dòng đã Hoàn tất của BN {ma_bn}; "
            f"sẽ mở {len(pending_rows)} dòng chưa hoàn tất còn lại."
        )

    row_is_completed = not bool(pending_rows)
    row = pending_rows[0] if pending_rows else rows[0]
    tds = row.find_elements(By.TAG_NAME, "td")
    row_text = row.text or ""
    start_dt = None
    if len(tds) >= 2:
        start_dt = _parse_dt_from_text(tds[1].text)
    if start_dt is None:
        start_dt = _parse_dt_from_text(row_text)
    if start_dt is None:
        base_date = _parse_date_dmy(wanted_date) or datetime.now()
        start_dt = base_date.replace(hour=7, minute=0, second=0, microsecond=0)

    link = None
    if len(tds) >= 4:
        try:
            link = tds[3].find_element(By.TAG_NAME, "a")
        except Exception:
            link = None
    if link is None:
        try:
            link = row.find_element(By.TAG_NAME, "a")
        except Exception:
            link = None
    if link is None:
        raise RuntimeError("Tìm thấy dòng thủ thuật nhưng không có link để mở")

    status_text = _row_status_text(row)
    _log(
        f"[OPEN] Mở thủ thuật BN {ma_bn} | {service_name or 'DVKT thay băng/cắt chỉ'} "
        f"| trạng thái: {status_text or 'không rõ'} | giờ dự kiến: {_fmt_hhmm_dmy(start_dt)}"
    )
    safe_js_click(driver, link)
    wait_after_action(driver, 1.0, ready_timeout=15)
    if return_meta:
        return start_dt, row_is_completed, status_text
    return start_dt

def _select_native_option(driver: Any, field_id: str, target_text: str) -> bool:
    try:
        ok = driver.execute_script(
            r"""
            const id = arguments[0], target = (arguments[1] || '').toLowerCase();
            const norm = s => (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g,'d').replace(/Đ/g,'D').toLowerCase().trim();
            const sel = document.getElementById(id);
            if (!sel || !sel.options) return false;
            const t = norm(target);
            let best = -1;
            for (let i = 0; i < sel.options.length; i++) {
              const txt = norm(sel.options[i].text || sel.options[i].label || '');
              if (txt === t || txt.includes(t) || t.includes(txt)) { best = i; break; }
            }
            if (best < 0) return false;
            sel.selectedIndex = best;
            sel.options[best].selected = true;
            sel.dispatchEvent(new Event('change', {bubbles:true}));
            if (window.jQuery) {
              try { window.jQuery(sel).trigger('change'); } catch(e) {}
              try { window.jQuery(sel).trigger({type:'select2:select', params:{data:{id:sel.options[best].value, text:sel.options[best].text}}}); } catch(e) {}
            }
            return true;
            """,
            field_id, target_text,
        )
        time.sleep(0.25)
        return bool(ok)
    except Exception:
        return False


def _select2_current_text(driver: Any, field_id: str) -> str:
    try:
        el = driver.find_element(By.ID, f"select2-{field_id}-container")
        return ((el.text or "") + " " + (el.get_attribute("title") or "")).strip()
    except Exception:
        return ""


def _field_value(driver: Any, field_id: str) -> str:
    try:
        el = driver.find_element(By.ID, field_id)
        return str(el.get_attribute("value") or el.text or "").strip()
    except Exception:
        return ""


def _select_current_text(driver: Any, field_id: str) -> str:
    parts = [_select2_current_text(driver, field_id)]
    try:
        native = driver.find_element(By.ID, field_id)
        native_text = driver.execute_script(
            "const s=arguments[0]; if(!s) return ''; "
            "const o=s.options && s.selectedIndex>=0 ? s.options[s.selectedIndex] : null; "
            "return o ? (o.text || o.label || o.value || '') : (s.value || '');",
            native,
        )
        parts.append(str(native_text or "").strip())
    except Exception:
        pass
    return " ".join(x for x in parts if x).strip()


def _text_matches(expected: str, actual: str) -> bool:
    e = _norm(expected)
    a = _norm(actual)
    if not e:
        return True
    if not a:
        return False
    return e == a or e in a or a in e


def _same_minute(expected_dt: datetime, actual_text: str) -> bool:
    actual_dt = _parse_dt_from_text(actual_text)
    if not actual_dt:
        return False
    return actual_dt.replace(second=0, microsecond=0) == expected_dt.replace(second=0, microsecond=0)


def _compare_procedure_form(driver: Any, expected: Dict[str, Any]) -> List[str]:
    """Đối chiếu phiếu thủ thuật đang mở với dữ liệu chuẩn, không thay đổi phiếu."""
    errors: List[str] = []
    start_actual = _field_value(driver, "txtTgBatDau")
    end_actual = _field_value(driver, "txtTgKetThuc")
    if not start_actual:
        errors.append("không đọc được giờ bắt đầu")
    elif not _same_minute(expected["start_dt"], start_actual):
        errors.append(f"giờ bắt đầu '{start_actual}' ≠ '{expected['start_text']}'")
    if not end_actual:
        errors.append("không đọc được giờ kết thúc")
    elif not _same_minute(expected["end_dt"], end_actual):
        errors.append(f"giờ kết thúc '{end_actual}' ≠ '{expected['end_text']}'")

    checks = [
        ("phương pháp vô cảm", expected.get("anesthesia") or "", _select_current_text(driver, "cbbPhuongPhapVoCam")),
        ("thủ thuật viên", expected.get("staff_name") or "", _select_current_text(driver, "cbbTTChinh")),
        ("mẫu tường trình", expected.get("template_name") or "", _select_current_text(driver, "cbbMauTuongTrinh")),
    ]
    for label, wanted, actual in checks:
        if wanted and not _text_matches(wanted, actual):
            errors.append(f"{label} '{actual or 'trống'}' ≠ '{wanted}'")
    return errors


def _open_select2(driver: Any, wait: Any, field_id: str) -> bool:
    container_id = f"select2-{field_id}-container"
    selectors = [
        f"span[aria-labelledby='{container_id}']",
        f"#{container_id}",
        f"#{container_id} + span.select2-selection__arrow",
    ]
    for sel in selectors:
        try:
            el = wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, sel)))
            safe_js_click(driver, el)
            WebDriverWait(driver, 4).until(
                EC.visibility_of_element_located((By.CSS_SELECTOR, "span.select2-container--open input.select2-search__field"))
            )
            return True
        except Exception:
            continue
    try:
        driver.execute_script("if(window.jQuery){ var el=document.getElementById(arguments[0]); if(el) window.jQuery(el).select2('open'); }", field_id)
        WebDriverWait(driver, 4).until(
            EC.visibility_of_element_located((By.CSS_SELECTOR, "span.select2-container--open input.select2-search__field"))
        )
        return True
    except Exception:
        return False


def _pick_select2_text(driver: Any, wait: Any, field_id: str, target_text: str, allow_first: bool = False) -> bool:
    target_text = str(target_text or "").strip()
    if not target_text:
        return False

    cur = _select2_current_text(driver, field_id)
    if cur and (_norm(target_text) in _norm(cur) or _norm(cur) in _norm(target_text)):
        return True

    if _select_native_option(driver, field_id, target_text):
        cur = _select2_current_text(driver, field_id)
        if not cur or _norm(target_text) in _norm(cur) or _norm(cur) in _norm(target_text):
            return True

    if not _open_select2(driver, wait, field_id):
        return False

    search = wait.until(EC.visibility_of_element_located((By.CSS_SELECTOR, "span.select2-container--open input.select2-search__field")))
    try:
        search.click()
        search.send_keys(Keys.CONTROL, "a")
        search.send_keys(Keys.DELETE)
    except Exception:
        pass
    search.send_keys(target_text)
    driver.execute_script(
        "arguments[0].dispatchEvent(new Event('input',{bubbles:true}));"
        "arguments[0].dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'Enter'}));",
        search,
    )
    time.sleep(0.9)

    try:
        options = driver.find_elements(By.XPATH, "//li[contains(@class,'select2-results__option') and not(contains(@class,'loading-results')) and not(contains(@class,'disabled'))]")
    except Exception:
        options = []

    chosen = None
    target_norm = _norm(target_text)
    for opt in options:
        txt = opt.text or ""
        if not txt.strip():
            continue
        opt_norm = _norm(txt)
        if target_norm == opt_norm or target_norm in opt_norm or opt_norm in target_norm:
            chosen = opt
            break
    if chosen is None and allow_first:
        for opt in options:
            if (opt.text or "").strip():
                chosen = opt
                break
    if chosen is None:
        return False

    try:
        ActionChains(driver).move_to_element(chosen).pause(0.05).click(chosen).perform()
    except Exception:
        safe_js_click(driver, chosen)
    time.sleep(0.4)
    return bool(_select2_current_text(driver, field_id))


def _click_by_id_any(driver: Any, ids: Sequence[str]) -> bool:
    for field_id in ids:
        try:
            el = driver.find_element(By.ID, field_id)
            if el.is_displayed() and el.is_enabled():
                safe_js_click(driver, el)
                wait_after_action(driver, 0.7, ready_timeout=8)
                handle_popups(driver)
                return True
        except Exception:
            continue
    return False


def _click_button_text_any(driver: Any, texts: Sequence[str]) -> bool:
    lowered = [_norm(t) for t in texts]
    try:
        buttons = driver.find_elements(By.XPATH, "//button|//input[@type='button' or @type='submit']|//a[contains(@class,'btn')]")
    except Exception:
        buttons = []
    for btn in buttons:
        try:
            if not btn.is_displayed() or not btn.is_enabled():
                continue
            label = (btn.text or btn.get_attribute("value") or btn.get_attribute("title") or "").strip()
            n = _norm(label)
            if n and any(x == n or x in n for x in lowered):
                safe_js_click(driver, btn)
                wait_after_action(driver, 0.8, ready_timeout=8)
                handle_popups(driver)
                return True
        except Exception:
            continue
    return False


def _click_save_finish(driver: Any) -> bool:
    clicked = _click_by_id_any(driver, [
        "btnSave", "btnLuu", "btnGhi", "btnGhiNhan", "btnSaveTT", "btnLuuTT",
        "btnSaveTuongTrinh", "btnLuuTuongTrinh", "btnSaveThuThuat", "btnUpdate",
    ])
    if not clicked:
        clicked = _click_button_text_any(driver, ["Lưu", "Ghi nhận", "Cập nhật"])
    clicked = _click_by_id_any(driver, [
        "btnHoanTat", "btnHOANTAT", "btnPopupHOANTAT", "btnKetThuc", "btnFinish", "btnHT",
    ]) or clicked
    _click_button_text_any(driver, ["Hoàn tất", "Kết thúc"])
    return clicked


def _click_recall_procedure_if_available(driver: Any, wait: Any) -> bool:
    """Nếu thủ thuật đã Hoàn tất, bấm Thu hồi để mở khóa form sửa; không xóa dữ liệu."""
    xpaths = [
        "//button[@id='btnPopupTHUHOI' or @id='btnTHUHOI' or @id='btnThuHoi']",
        "//button[contains(normalize-space(.),'Thu hồi') or contains(@title,'Thu hồi')]",
        "//input[(contains(@value,'Thu hồi') or contains(@title,'Thu hồi')) and (@type='button' or @type='submit')]",
    ]
    for xp in xpaths:
        try:
            btn = WebDriverWait(driver, 2).until(EC.element_to_be_clickable((By.XPATH, xp)))
            _log("[ACTION] Bấm Thu hồi thủ thuật để sửa lại nhân sự")
            safe_js_click(driver, btn)
            wait_after_action(driver, 0.8, ready_timeout=8)
            return True
        except Exception:
            continue
    return False


def _enter_execution_form_for_check(driver: Any, wait: Any) -> None:
    """Mở form thực hiện nhưng chưa Thu hồi, để có thể kiểm tra phiếu Hoàn tất trước."""
    try:
        btn = WebDriverWait(driver, 8).until(EC.element_to_be_clickable((By.ID, "btnVAOTH")))
        _log("[ACTION] Bấm Vào thực hiện")
        safe_js_click(driver, btn)
        wait_after_action(driver, 1.0, ready_timeout=12)
    except Exception:
        _log("[ACTION] Không thấy nút Vào thực hiện; thử điền trực tiếp nếu form đã mở.")
    WebDriverWait(driver, 15).until(EC.presence_of_element_located((By.ID, "txtTgBatDau")))


def _fill_one_procedure(driver: Any, wait: Any, config: dict, start_dt: datetime, discharge_dt: Optional[datetime] = None, service_name: str = "", task: Optional[Dict[str, str]] = None) -> None:
    expected = _procedure_expected_values(config, start_dt, discharge_dt, service_name, task)
    start_text = expected["start_text"]
    end_text = expected["end_text"]
    _log(f"[FILL] Giờ bắt đầu: {start_text} | kết thúc: {end_text}")
    _set_input_value(driver, "txtTgBatDau", start_text)
    _set_input_value(driver, "txtTgKetThuc", end_text)

    anesthesia = expected["anesthesia"]
    if anesthesia:
        ok = _pick_select2_text(driver, wait, "cbbPhuongPhapVoCam", anesthesia, allow_first=False)
        _log(f"[FILL] Phương pháp vô cảm '{anesthesia}': {'OK' if ok else 'KHÔNG CHỌN ĐƯỢC'}")
        if not ok:
            raise RuntimeError(f"Không chọn được phương pháp vô cảm: {anesthesia}")

    staff_name = expected["staff_name"]
    if not staff_name:
        raise RuntimeError("Không xác định được thủ thuật viên từ lịch điều dưỡng")
    _log(f"[FILL] Thủ thuật viên: {staff_name}")
    staff_ok = False
    if chon_select2_bac_si_y_ta:
        staff_ok = chon_select2_bac_si_y_ta(driver, "cbbTTChinh", staff_name, timeout=15)
    if not staff_ok:
        _log(f"[FILL] Thử chọn thủ thuật viên bằng fallback Select2: {staff_name}")
        staff_ok = _pick_select2_text(driver, wait, "cbbTTChinh", staff_name, allow_first=False)
    if not staff_ok:
        raise RuntimeError(f"Không chọn được thủ thuật viên: {staff_name}")

    template_name = expected["template_name"]
    if template_name:
        ok = _pick_select2_text(driver, wait, "cbbMauTuongTrinh", template_name, allow_first=True)
        _log(f"[FILL] Mẫu tường trình '{template_name}': {'OK' if ok else 'KHÔNG CHỌN ĐƯỢC'}")
        if not ok:
            raise RuntimeError(f"Không chọn được mẫu tường trình: {template_name}")
        wait_after_action(driver, 0.8, ready_timeout=8)

    if not _click_save_finish(driver):
        raise RuntimeError("Đã điền form nhưng không tìm thấy nút Lưu/Hoàn tất để bấm")


def _process_task(driver: Any, wait: Any, config: dict, task: Dict[str, str]) -> str:
    ma_bn = task.get("ma_bn") or ""
    ngay = task.get("ngay_lam") or ""
    ho_ten = task.get("ho_ten") or ""
    service_name = task.get("service_name") or ""
    _goto_procedure_list(driver, wait, config)
    _apply_procedure_date_range_filter(driver, wait, ngay, config)
    _try_search_on_list(driver, wait, ma_bn, ho_ten)
    allow_completed_update = bool(config.get("repair_existing"))
    start_dt, is_completed, status_text = _open_procedure_row(
        driver,
        wait,
        ma_bn,
        ngay,
        service_name,
        clinic_mode=bool(task.get("clinic_mode")),
        allow_completed_update=allow_completed_update,
        return_meta=True,
    )
    discharge_dt = _parse_task_discharge_dt(task)
    expected = _procedure_expected_values(config, start_dt, discharge_dt, service_name, task)
    _enter_execution_form_for_check(driver, wait)

    if is_completed:
        errors = _compare_procedure_form(driver, expected)
        if not errors:
            _log(
                f"[PERFECT] Phiếu thủ thuật đã đúng; giữ nguyên, không Thu hồi: "
                f"{ma_bn} | {ngay} | {service_name}"
            )
            return "perfect"

        _log(f"[UPDATE] Phiếu đã {status_text or 'Hoàn tất'} nhưng sai: {'; '.join(errors)}")
        if not _click_recall_procedure_if_available(driver, wait):
            raise RuntimeError(
                "Phiếu thủ thuật đã có nhưng sai; EMR không cho Thu hồi nên không sửa và không tạo trùng. "
                + "; ".join(errors)
            )
        WebDriverWait(driver, 15).until(EC.presence_of_element_located((By.ID, "txtTgBatDau")))
        action = "updated"
    else:
        _log(f"[MISSING] Thủ thuật chưa Hoàn tất; nhập và hoàn tất phiếu: {ma_bn} | {ngay} | {service_name}")
        action = "created"

    _fill_one_procedure(driver, wait, config, start_dt, discharge_dt=discharge_dt, service_name=service_name, task=task)
    return action

def main() -> int:
    processed_path = sys.argv[1] if len(sys.argv) >= 2 else ""
    targets_path = sys.argv[2] if len(sys.argv) >= 3 else ""
    base_dir = os.path.dirname(os.path.abspath(processed_path or __file__))
    result_path = os.path.join(base_dir, "input_procedures_result.json")
    progress_path = progress_path_from_input(processed_path or __file__)

    from utils import load_config
    config = _merge_target_config(load_config(), targets_path)
    tasks = _prepare_tasks(processed_path, targets_path)
    if not tasks:
        reason = "Không có bệnh nhân/ngày phù hợp để nhập thủ thuật."
        _log(f"[!] {reason}")
        WorkerSession.skip(result_path, reason)
        return 0

    _log(f">>> Chuẩn bị nhập thủ thuật cho {len(tasks)} BN/ngày")
    with open_session(result_path, config=config) as ws:
        for task in tasks:
            ma_bn = task.get("ma_bn") or ""
            ngay = task.get("ngay_lam") or ""
            service_name = task.get("service_name") or ""
            key = _done_key(ma_bn, ngay, service_name)
            _log(f"\n[{ma_bn} {task.get('ho_ten') or ''} | {ngay} | {service_name or 'DVKT thay băng/cắt chỉ'}]")
            mark_task_status(progress_path, TASK_NAME, key, "running")
            try:
                action = _process_task(ws.driver, ws.wait, ws.config, task)
                ws.mark_success(key, action=action)
                mark_task_status(progress_path, TASK_NAME, key, "done")
                if action == "perfect":
                    _log(f"[OK] Phiếu thủ thuật đã đúng, bỏ qua không sửa: {key}")
                elif action == "updated":
                    _log(f"[OK] Đã Thu hồi và cập nhật phiếu thủ thuật sai: {key}")
                else:
                    _log(f"[OK] Đã nhập/hoàn tất thủ thuật còn thiếu: {key}")
            except ProcedureAlreadyCompleted as e:
                msg = str(e) or "Đã Hoàn tất trên D/s Thủ thuật"
                ws.mark_success(key, already_completed=True, message=msg)
                mark_task_status(progress_path, TASK_NAME, key, "done")
                _log(f"[OK] Ghi nhận Hoàn tất, chuyển người bệnh tiếp theo: {key} | {msg}")
            except Exception as e:
                msg = str(e)
                ws.mark_failed(key, msg)
                mark_task_status(progress_path, TASK_NAME, key, "failed", msg)
                _log(f"[FAIL] {key}: {msg}")
                try:
                    debug_page(ws.driver, f"procedure_fail_{ma_bn}_{ngay.replace('/', '-')}", log_func=_log)
                except Exception:
                    pass
                try:
                    _goto_procedure_list(ws.driver, ws.wait, ws.config)
                except Exception:
                    pass
    return 0


if __name__ == "__main__":
    rc = main()
    try:
        rp = os.path.join(os.path.dirname(os.path.abspath(sys.argv[1] if len(sys.argv) >= 2 else __file__)), "input_procedures_result.json")
        if os.path.exists(rp):
            data = json.load(open(rp, encoding="utf-8"))
            if data.get("failed"):
                sys.exit(2)
    except Exception:
        pass
    sys.exit(rc if isinstance(rc, int) else 0)
