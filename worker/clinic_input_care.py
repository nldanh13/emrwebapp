# -*- coding: utf-8 -*-
"""Đọc và nhập chăm sóc cho người bệnh từ Khoa Khám Bệnh.

Quy tắc nghiệp vụ:
  - Nguồn: Danh sách điều trị nội trú (tblNoiTru), không dùng danh sách khám ngoại trú.
  - Khoa chuyển đến phải khớp "Khoa Khám Bệnh" (có thể cấu hình targetDepartment).
  - Ngày trong cột T/G vào phải đúng ngày người dùng chọn.
  - Thời gian lập phiếu chăm sóc phải đúng hoàn toàn T/G vào của từng dòng.

Chế độ chạy:
  python clinic_input_care.py preview <request.json> <output.json>
  python clinic_input_care.py input   <request.json> <result.json>

Ở chế độ input, worker quét lại danh sách trong cùng phiên đăng nhập và chỉ nhập các
BN vẫn còn khớp điều kiện. Không sử dụng URL phiên cũ từ lần preview.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
import unicodedata
from datetime import datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse

try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
except Exception:
    pass

from utils import load_config, login_emr, handle_popups, get_nurse_by_shift
from shared.worker_session import open_session
from nurse_emr_accounts import get_emr_account_for_nurse
from selenium_emr_helpers import (
    goto_inpatient_list,
    set_time_range_filter,
    wait_after_action,
)

try:
    from bs4 import BeautifulSoup
except Exception:  # pragma: no cover
    BeautifulSoup = None  # type: ignore

try:
    from selenium.webdriver.common.by import By
    from selenium.webdriver.common.keys import Keys
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
except Exception:  # pragma: no cover
    By = Keys = WebDriverWait = EC = None  # type: ignore

# Các module thao tác form phụ thuộc Selenium. Giữ import có điều kiện để các
# hàm parser thuần vẫn kiểm thử được trên máy không cài Chrome/Selenium.
try:
    from care_cache import (
        scan_cham_soc_cache,
        kiem_tra_bang_cached,
        open_cham_soc_by_id,
    )
    from care_form_actions import (
        set_thoi_gian_lap, dien_thong_tin,
    )
    from care_web_actions import (
        check_trang_thai_badge,
        click_thu_hoi_va_xoa,
        click_thu_hoi_cham_soc,
    )
except Exception:  # pragma: no cover - chỉ xảy ra ở môi trường test thiếu Selenium
    scan_cham_soc_cache = kiem_tra_bang_cached = None  # type: ignore
    open_cham_soc_by_id = set_thoi_gian_lap = dien_thong_tin = None  # type: ignore
    check_trang_thai_badge = click_thu_hoi_va_xoa = click_thu_hoi_cham_soc = None  # type: ignore


DEFAULT_TARGET_DEPARTMENT = "Khoa Khám Bệnh"
# Mỗi người bệnh nhập viện có 2 phiếu chăm sóc:
#   1. Khoa Khám Bệnh chuyển — lập đúng T/G vào, diễn biến "Phòng khám … nhận", chăm sóc "Kính chuyển … / Hồ sơ".
#   2. Khoa nhận — sau T/G vào WARD_MINUTES phút, diễn biến "Khoa … nhận", chăm sóc nhận người bệnh, có sinh hiệu:
#      ô người dùng gõ thì dùng số đó, ô trống thì điền như phiếu chăm sóc thường (dien_thong_tin, needs_vitals).
WARD_NAME = "Khoa Chấn Thương chỉnh hình - Thần kinh"
DEFAULT_CARE_CONTENT = "\n".join([f"Kính chuyển {WARD_NAME} nhận", "Hồ sơ"])
DEFAULT_WARD_CARE = "\n".join([
    "Nhận HS",
    "Lấy dấu hiệu sinh tồn",
    "Trình Bs trực",
    "Hướng dẫn nội quy khoa phòng",
    "Thực hiện CLS",
])
WARD_MINUTES = 15
VITAL_FIELDS = (("mach", "Mạch"), ("nhiet_do", "Nhiệt độ"), ("huyet_ap", "Huyết áp"), ("nhip_tho", "Nhịp thở"))
DEFAULT_DIEN_BIEN = "\n".join([
    "Phòng khám Chấn thương chỉnh hình - Thần kinh nhận",
    "Người bệnh tỉnh",
    "Tiếp xúc tốt",
    "Da niêm hồng",
    "Mạch rõ, chi ấm",
    "Đau vùng tổn thương",
    "Vận động hạn chế",
    "Tiền sử dị ứng thuốc chưa ghi nhận",
])

_WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def _compact(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _patient_code(value: Any) -> str:
    return re.sub(r"\D+", "", str(value or "")).strip()


def _norm(value: Any) -> str:
    text = str(value or "").strip().lower()
    text = unicodedata.normalize("NFD", text)
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    text = text.replace("đ", "d")
    return re.sub(r"\s+", " ", text).strip()


def _load_request(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data if isinstance(data, dict) else {}


def _write_json(path: str, obj: Any) -> None:
    tmp = path + ".tmp"
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def _dmy(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    m = re.search(r"(\d{4})-(\d{1,2})-(\d{1,2})", raw)
    if m:
        y, mo, d = m.groups()
        return f"{int(d):02d}/{int(mo):02d}/{int(y):04d}"
    m = re.search(r"(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})", raw)
    if not m:
        return ""
    d, mo, y = m.groups()
    yi = int(y)
    if yi < 100:
        yi += 2000
    try:
        datetime(yi, int(mo), int(d))
    except ValueError:
        return ""
    return f"{int(d):02d}/{int(mo):02d}/{yi:04d}"


def _parse_admission_time(value: Any) -> Tuple[str, str, int]:
    """Trả (HH:MM dd/mm/yyyy, dd/mm/yyyy, hour). Không đoán giờ/ngày."""
    raw = _compact(value)
    patterns = [
        r"(?P<h>\d{1,2}):(?P<m>\d{2})\s+(?P<d>\d{1,2}[/-]\d{1,2}[/-]\d{2,4})",
        r"(?P<d>\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\s+(?P<h>\d{1,2}):(?P<m>\d{2})",
    ]
    for pattern in patterns:
        m = re.search(pattern, raw)
        if not m:
            continue
        hour = int(m.group("h"))
        minute = int(m.group("m"))
        date = _dmy(m.group("d"))
        if not date or hour > 23 or minute > 59:
            return "", "", -1
        hhmm = f"{hour:02d}:{minute:02d}"
        return f"{hhmm} {date}", date, hour
    return "", "", -1


def _header_key(value: Any) -> str:
    n = _norm(value)
    aliases = {
        "ma bn": "ma_bn",
        "ma benh nhan": "ma_bn",
        "ma nguoi benh": "ma_bn",
        "ma yt": "ma_bn",
        "ho ten": "ho_ten",
        "ten bn": "ho_ten",
        "ten benh nhan": "ho_ten",
        "ten nguoi benh": "ho_ten",
        "t/g vao": "tg_vao",
        "tg vao": "tg_vao",
        "thoi gian vao": "tg_vao",
        "thoi gian vao khoa": "tg_vao",
        "ngay gio vao khoa": "tg_vao",
        "khoa chuyen den": "khoa_chuyen_den",
        "khoa chuyen": "khoa_chuyen_den",
        "khoa den": "khoa_chuyen_den",
        "khoa nhan": "khoa_chuyen_den",
        "khoa dieu tri": "khoa_chuyen_den",
        "ten khoa dieu tri": "khoa_chuyen_den",
        "trang thai": "trang_thai",
        "tinh trang": "trang_thai",
        "tuoi": "tuoi",
        "gt": "gioi_tinh",
        "gioi tinh": "gioi_tinh",
    }
    return aliases.get(n, re.sub(r"[^a-z0-9]+", "_", n).strip("_"))


def _cell_text(cell: Any) -> str:
    try:
        return _compact(cell.get_text(" ", strip=True))
    except Exception:
        return _compact(cell)


def _patient_name_from_cell(cell: Any) -> str:
    if cell is None:
        return ""
    try:
        for a in cell.find_all("a"):
            aid = str(a.get("id") or "")
            text = a.get_text("\n", strip=True)
            if aid.startswith("btna") and text:
                for line in re.split(r"[\r\n]+", text):
                    line = _compact(line)
                    if line and not _norm(line).startswith(("pm:", "pt:", "phong", "- pm", "- pt")):
                        return line
        raw = cell.get_text("\n", strip=True)
    except Exception:
        raw = str(cell or "")
    for line in re.split(r"[\r\n]+", raw):
        line = _compact(line)
        if line and not _norm(line).startswith(("pm:", "pt:", "phong", "- pm", "- pt")):
            return line
    return ""


def _extract_nursing_url(row: Any, base_url: str) -> str:
    try:
        for a in row.find_all("a"):
            href = str(a.get("href") or "").strip()
            html = str(a).lower()
            if href and ("wpid=dieuduongdraw" in href.lower() or "fa-eye" in html):
                return urljoin(base_url or "", href)
    except Exception:
        pass
    return ""


def _extract_doctor_url(row: Any, base_url: str) -> str:
    try:
        for a in row.find_all("a"):
            href = str(a.get("href") or "").strip()
            if not href:
                continue
            aid = str(a.get("id") or "").lower()
            href_l = href.lower()
            text = _norm(a.get_text(" ", strip=True))
            if aid.startswith("btna") or ("wpid=bacsidraw" in href_l and bool(text) and not re.fullmatch(r"[\d: /-]+", text or "")):
                full = urljoin(base_url or "", href)
                return _as_doctor_url(full)
    except Exception:
        pass
    return ""


def _as_doctor_url(url: str) -> str:
    raw = _compact(url)
    if not raw:
        return ""
    try:
        parsed = urlparse(raw)
        query = dict(parse_qsl(parsed.query, keep_blank_values=True))
        query["wpid"] = "bacsidraw"
        query["nextlink"] = "lichsuylenh"
        query.setdefault("page", "1")
        return parsed._replace(query=urlencode(query, doseq=True)).geturl()
    except Exception:
        return raw


def _department_matches(actual: Any, expected: Any = DEFAULT_TARGET_DEPARTMENT) -> bool:
    act = _norm(actual)
    exp = _norm(expected)
    if not act or not exp:
        return False
    return act == exp


def parse_inpatient_care_rows(
    html: str,
    care_date: Any,
    target_department: str = DEFAULT_TARGET_DEPARTMENT,
    base_url: str = "",
) -> List[Dict[str, Any]]:
    """Parse tblNoiTru và chỉ trả các dòng đúng ngày + đúng Khoa chuyển đến."""
    if BeautifulSoup is None:
        return []
    wanted_date = _dmy(care_date)
    if not wanted_date:
        return []

    soup = BeautifulSoup(html or "", "html.parser")
    table = soup.find("table", id="tblNoiTru")
    if table is None:
        for candidate in soup.find_all("table"):
            header_blob = _norm(" ".join(th.get_text(" ", strip=True) for th in candidate.find_all("th")))
            if "ma bn" in header_blob and ("t/g vao" in header_blob or "thoi gian vao" in header_blob):
                table = candidate
                break
    if table is None:
        return []

    headers = [_header_key(th.get_text(" ", strip=True)) for th in table.find_all("th")]
    body = table.find("tbody")
    trs = body.find_all("tr") if body else table.find_all("tr")[1:]
    out: List[Dict[str, Any]] = []
    seen = set()

    for row_index, tr in enumerate(trs):
        cells = tr.find_all("td")
        if not cells:
            continue
        values = [_cell_text(td) for td in cells]
        mapped: Dict[str, str] = {}
        mapped_cells: Dict[str, Any] = {}
        for idx, value in enumerate(values):
            if idx < len(headers) and headers[idx]:
                mapped[headers[idx]] = value
                mapped_cells[headers[idx]] = cells[idx]

        tg_raw = mapped.get("tg_vao") or (values[1] if len(values) > 1 else "")
        care_time_str, row_date, care_hour = _parse_admission_time(tg_raw)
        if not care_time_str or row_date != wanted_date:
            continue

        department = mapped.get("khoa_chuyen_den") or ""
        if not _department_matches(department, target_department):
            continue

        code = _patient_code(mapped.get("ma_bn") or (values[5] if len(values) > 5 else ""))
        if not re.fullmatch(r"\d{6,10}", code or ""):
            # Fallback phải lấy một mã độc lập, không lấy chuỗi số từ T/G vào.
            for idx, value in enumerate(values):
                if idx == 1:
                    continue
                m = re.fullmatch(r"\s*(\d{6,10})\s*", value or "")
                if m:
                    code = m.group(1)
                    break
        if not code:
            continue

        name_cell = mapped_cells.get("ho_ten") or (cells[6] if len(cells) > 6 else None)
        ho_ten = _patient_name_from_cell(name_cell) or mapped.get("ho_ten") or ""
        nursing_url = _extract_nursing_url(tr, base_url)
        doctor_url = _extract_doctor_url(tr, base_url)
        noitruid = ""
        if nursing_url:
            try:
                noitruid = dict(parse_qsl(urlparse(nursing_url).query, keep_blank_values=True)).get("noitruid", "")
            except Exception:
                noitruid = ""

        key = noitruid or f"{code}::{care_time_str}"
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "ma_bn": code,
            "ho_ten": ho_ten,
            "tuoi": mapped.get("tuoi") or "",
            "gioi_tinh": mapped.get("gioi_tinh") or "",
            "tg_vao": tg_raw,
            "thoi_gian_vao_khoa": tg_raw,
            "care_time_str": care_time_str,
            "care_hour": care_hour,
            "ngay_lam": row_date,
            "khoa_chuyen_den": department,
            "trang_thai": mapped.get("trang_thai") or "",
            "nursing_url": nursing_url,
            "doctor_url": doctor_url,
            "noitruid": noitruid,
            "row_index": row_index,
            "source": "inpatient_list_clinic_care",
        })

    out.sort(key=lambda r: (r.get("care_time_str") or "", r.get("ma_bn") or ""))
    return out


def _iso_from_dmy(dmy: str) -> str:
    try:
        return datetime.strptime(_dmy(dmy), "%d/%m/%Y").strftime("%Y-%m-%d")
    except Exception:
        return ""


def _weekday_key_from_iso(iso: str) -> str:
    try:
        return _WEEKDAY_NAMES[datetime.strptime(iso, "%Y-%m-%d").weekday()]
    except Exception:
        return ""


def _first_work_names(day_cfg: Any, key: str = "work") -> List[str]:
    if not isinstance(day_cfg, dict):
        return []
    return [str(n).strip() for n in (day_cfg.get(key) or []) if str(n).strip()]


def _clinic_nurses_for_date(schedule: Dict[str, Any], ngay_lam: str, key: str = "work") -> List[str]:
    """Tên trong Lịch Phòng khám theo ngày → thứ → mẫu mặc định. key='doctor' cho bác sĩ phòng khám."""
    sched = schedule or {}
    iso = _iso_from_dmy(ngay_lam)
    days = sched.get("days") or {}
    if iso and isinstance(days, dict) and iso in days:
        names = _first_work_names(days[iso], key)
        if names:
            return names
    if iso:
        weekday = _weekday_key_from_iso(iso)
        names = _first_work_names(sched.get(weekday) or {}, key)
        if names:
            return names
    return _first_work_names(sched.get("Default") or {}, key)


def clinic_doctors_for_date(schedule: Dict[str, Any], ngay_lam: str) -> List[str]:
    return _clinic_nurses_for_date(schedule, ngay_lam, "doctor")


def _refresh_inpatient_list(driver: Any, wait: Any) -> None:
    """Kích hoạt tải lại bảng sau khi đổi bộ lọc ngày."""
    if By is None or Keys is None:
        time.sleep(1.0)
        return
    try:
        search = driver.find_element(By.ID, "txtTimKiem")
        try:
            search.clear()
        except Exception:
            driver.execute_script("arguments[0].value='';", search)
        search.send_keys(Keys.ENTER)
        wait_after_action(driver, 1.0, ready_timeout=8)
    except Exception:
        time.sleep(1.0)
    try:
        if wait is not None and EC is not None:
            wait.until(EC.presence_of_element_located((By.ID, "tblNoiTru")))
    except Exception:
        time.sleep(1.0)


def _next_page(driver: Any) -> bool:
    if By is None:
        return False
    xpaths = [
        "//ul[contains(@class,'pagination')]//a[@rel='next']",
        "//ul[contains(@class,'pagination')]//a[contains(normalize-space(),'›')]",
        "//ul[contains(@class,'pagination')]//a[contains(normalize-space(),'Next')]",
    ]
    for xp in xpaths:
        try:
            for link in driver.find_elements(By.XPATH, xp):
                cls = (link.get_attribute("class") or "").lower()
                parent_cls = ""
                try:
                    parent_cls = (link.find_element(By.XPATH, "..").get_attribute("class") or "").lower()
                except Exception:
                    pass
                if "disabled" in cls or "disabled" in parent_cls:
                    continue
                if not link.is_displayed():
                    continue
                driver.execute_script("arguments[0].click();", link)
                wait_after_action(driver, 0.8, ready_timeout=8)
                return True
        except Exception:
            continue
    return False


def scan_matching_rows(
    driver: Any,
    wait: Any,
    config: Dict[str, Any],
    care_date: str,
    target_department: str,
    max_pages: int = 50,
) -> List[Dict[str, Any]]:
    """Đặt ngày T/G vào và quét mọi trang trong danh sách nội trú."""
    goto_inpatient_list(
        driver,
        wait,
        config,
        login_func=login_emr,
        log_func=print,
    )
    set_time_range_filter(driver, wait, care_date, care_date, log_func=print)
    _refresh_inpatient_list(driver, wait)

    all_rows: List[Dict[str, Any]] = []
    seen_keys = set()
    seen_pages = set()
    for page_index in range(max(1, int(max_pages or 50))):
        html = driver.page_source or ""
        page_hash = hashlib.sha1(html.encode("utf-8", errors="ignore")).hexdigest()
        if page_hash in seen_pages:
            break
        seen_pages.add(page_hash)
        page_rows = parse_inpatient_care_rows(
            html,
            care_date,
            target_department=target_department,
            base_url=driver.current_url or "",
        )
        for row in page_rows:
            key = row.get("noitruid") or f"{row.get('ma_bn')}::{row.get('care_time_str')}"
            if not key or key in seen_keys:
                continue
            seen_keys.add(key)
            all_rows.append(row)
        print(f"[CLINIC_CARE_SCAN] Trang {page_index + 1}: {len(page_rows)} dòng phù hợp")
        if not _next_page(driver):
            break

    all_rows.sort(key=lambda r: (r.get("care_time_str") or "", r.get("ma_bn") or ""))
    return all_rows


def _build_config(req: Dict[str, Any]) -> Dict[str, Any]:
    try:
        config = load_config()
    except Exception:
        config = {}
    config["url_login"] = _compact(req.get("loginUrl") or config.get("url_login") or "")
    config["username"] = _compact(req.get("username") or config.get("username") or "")
    config["password"] = str(req.get("password") or config.get("password") or "")
    config["headless"] = bool(req.get("headless", config.get("headless", True)))
    care_list_url = _compact(req.get("careListUrl") or req.get("listUrl") or config.get("url_inpatient_list") or "")
    if care_list_url:
        config["url_inpatient_list"] = care_list_url
        try:
            wpid = dict(parse_qsl(urlparse(care_list_url).query, keep_blank_values=True)).get("wpid")
            if wpid:
                config["inpatient_wpid"] = wpid
        except Exception:
            pass
    return config


def _row_identity(row: Dict[str, Any]) -> str:
    noitruid = _compact(row.get("noitruid") or "")
    if noitruid:
        return f"noitruid::{noitruid}"
    code = _patient_code(row.get("ma_bn"))
    time_str, _, _ = _parse_admission_time(row.get("care_time_str") or row.get("tg_vao"))
    return f"patient::{code}::{time_str}" if code and time_str else ""


def _validate_request(req: Dict[str, Any]) -> Tuple[str, str]:
    care_date = _dmy(req.get("careDate") or req.get("care_date"))
    target_department = _compact(req.get("targetDepartment") or req.get("target_department") or DEFAULT_TARGET_DEPARTMENT)
    if not care_date:
        raise ValueError("Ngày T/G vào không hợp lệ.")
    if not target_department:
        raise ValueError("Thiếu Khoa chuyển đến cần lọc.")
    return care_date, target_department


def _order_history_show_all_url(url: str) -> str:
    try:
        parsed = urlparse(url)
        query = dict(parse_qsl(parsed.query, keep_blank_values=True))
        query.setdefault("soLuongHienThi", "1000")
        query.setdefault("pageSize", "1000")
        query.setdefault("length", "1000")
        return parsed._replace(query=urlencode(query, doseq=True)).geturl()
    except Exception:
        return url


def _force_order_history_show_all_in_driver(driver: Any) -> None:
    if driver is None:
        return
    try:
        changed = driver.execute_script("""
            const sel = document.querySelector('#soLuongHienThi');
            if (!sel) return false;
            sel.value = '1000';
            sel.dispatchEvent(new Event('change', {bubbles: true}));
            if (typeof loadListYLenh === 'function') {
                try { loadListYLenh(); } catch (e) {}
            }
            return true;
        """)
        if changed:
            wait_after_action(driver, 1.0, ready_timeout=12)
    except Exception:
        pass


def _parse_order_history_dt(value: Any) -> Optional[datetime]:
    m = re.search(r"(\d{1,2}:\d{2})\s+(\d{1,2}/\d{1,2}/\d{4})", str(value or ""))
    if not m:
        return None
    try:
        return datetime.strptime(f"{m.group(2)} {m.group(1)}", "%d/%m/%Y %H:%M")
    except Exception:
        return None


def _parse_order_history_rows(html: str) -> List[Dict[str, Any]]:
    if BeautifulSoup is None:
        return []
    soup = BeautifulSoup(html or "", "html.parser")
    rows_out: List[Dict[str, Any]] = []
    current_date = ""
    dt_re = re.compile(r"\b\d{1,2}:\d{2}\s+\d{1,2}/\d{1,2}/\d{4}\b")

    for tbody in soup.find_all("tbody", id="tbodyylenh"):
        for tr in tbody.find_all("tr"):
            tds = tr.find_all("td")
            if not tds:
                continue
            if len(tds) == 1:
                current_date = _compact(tds[0].get_text(" ", strip=True))
                continue

            cols = [td.get_text(" ", strip=True) for td in tds]
            tg_idx = None
            for i, col in enumerate(cols):
                if dt_re.search(col):
                    tg_idx = i
                    break
            if tg_idx is None:
                continue

            so_phieu = cols[tg_idx - 1] if tg_idx >= 1 else ""
            tg_ylenh = dt_re.search(cols[tg_idx]).group(0) if dt_re.search(cols[tg_idx]) else cols[tg_idx]
            bac_si = cols[tg_idx + 1] if tg_idx + 1 < len(cols) else ""
            db_idx = tg_idx + 2
            yk_idx = tg_idx + 4
            a_db = tds[db_idx].find("a", attrs={"data-content": True}) if db_idx < len(tds) else None
            dien_bien = _compact(a_db["data-content"]) if a_db else (tds[db_idx].get_text(" ", strip=True) if db_idx < len(tds) else "")
            a_yl = tds[yk_idx].find("a", attrs={"data-content": True}) if yk_idx < len(tds) else None
            y_lenh_khac = _compact(a_yl["data-content"]) if a_yl else (tds[yk_idx].get_text(" ", strip=True) if yk_idx < len(tds) else "")
            rows_out.append({
                "ngay": current_date,
                "so_phieu": so_phieu,
                "tg_ylenh": tg_ylenh,
                "bac_si": bac_si,
                "dien_bien": dien_bien,
                "ten_y_lenh": (y_lenh_khac or dien_bien)[:500],
                "y_lenh_khac": y_lenh_khac[:1000],
            })

    deduped: List[Dict[str, Any]] = []
    seen = set()
    for row in sorted(rows_out, key=lambda r: (_parse_order_history_dt(r.get("tg_ylenh")) or datetime.max, r.get("so_phieu") or "")):
        key = row.get("so_phieu") or row.get("tg_ylenh") or ""
        if key and key in seen:
            continue
        if key:
            seen.add(key)
        deduped.append(row)
    return deduped


def _resolve_doctor_history_url(row: Dict[str, Any], fresh_rows: List[Dict[str, Any]]) -> str:
    """Chỉ dùng liên kết lấy lại từ lần quét hiện tại, không tin URL do client gửi lên."""
    row_key = _row_identity(row)
    if row_key:
        for candidate in fresh_rows:
            if _row_identity(candidate) == row_key:
                direct = _compact(candidate.get("doctor_url") or candidate.get("nursing_url") or "")
                if direct:
                    return _as_doctor_url(direct)
    code = _patient_code(row.get("ma_bn"))
    time_str, _, _ = _parse_admission_time(row.get("care_time_str") or row.get("tg_vao"))
    for candidate in fresh_rows:
        ccode = _patient_code(candidate.get("ma_bn"))
        ctime, _, _ = _parse_admission_time(candidate.get("care_time_str") or candidate.get("tg_vao"))
        if code and ccode == code and ((not time_str) or ctime == time_str):
            direct = _compact(candidate.get("doctor_url") or candidate.get("nursing_url") or "")
            if direct:
                return _as_doctor_url(direct)
    return ""


_PAIN_LOCATION_PATTERNS: List[Tuple[str, Tuple[str, ...]]] = [
    ("khớp cùng vai đòn", ("khop cung vai don",)),
    ("cột sống thắt lưng", ("cot song that lung", "that lung", "vung lung", "dau lung")),
    ("cột sống cổ", ("cot song co", "co gay", "vung gay")),
    ("cột sống ngực", ("cot song nguc",)),
    ("khớp thái dương hàm", ("khop thai duong ham", "thai duong ham")),
    ("xương đòn", ("xuong don",)),
    ("bả vai", ("ba vai",)),
    ("cổ tay", ("co tay",)),
    ("bàn tay", ("ban tay",)),
    ("ngón tay", ("ngon tay",)),
    ("khuỷu tay", ("khuyu tay", "khuy tay")),
    ("cẳng tay", ("cang tay",)),
    ("cánh tay", ("canh tay",)),
    ("khớp vai", ("khop vai", "vai")),
    ("khớp háng", ("khop hang", "vung hang", "hang")),
    ("khớp gối", ("khop goi", "vung goi", "goi")),
    ("cổ chân", ("co chan",)),
    ("bàn chân", ("ban chan",)),
    ("gót chân", ("got chan",)),
    ("ngón chân", ("ngon chan",)),
    ("cẳng chân", ("cang chan",)),
    ("đùi", ("vung dui", "dui")),
    ("xương chậu", ("xuong chau", "khung chau", "vung chau")),
    ("cùng cụt", ("cung cut",)),
    ("mông", ("vung mong", "mong")),
    ("liên sườn", ("lien suon",)),
    ("hạ sườn", ("ha suon",)),
    ("ngực", ("vung nguc", "nguc")),
    ("bụng", ("vung bung", "bung")),
    ("đầu", ("vung dau", "dau dau")),
    ("mặt", ("vung mat", "mat")),
    ("hàm", ("vung ham", "ham")),
]


def _extract_side(norm_segment: str, alias_start: int, alias_len: int) -> str:
    before = norm_segment[max(0, alias_start - 18):alias_start].strip()
    after = norm_segment[alias_start + alias_len:alias_start + alias_len + 18].strip()
    before_match = re.search(r"(?:^|\s)(ca hai ben|hai ben|2 ben|ben trai|ben phai|trai|phai)\s*$", before)
    after_match = re.match(r"^(ca hai ben|hai ben|2 ben|ben trai|ben phai|trai|phai)(?:\s|[,/()\-]|$)", after)
    token = (after_match or before_match)
    value = token.group(1) if token else ""
    if value in {"ca hai ben", "hai ben", "2 ben"}:
        return "hai bên"
    if value in {"ben trai", "trai"}:
        return "trái"
    if value in {"ben phai", "phai"}:
        return "phải"
    return ""


def _extract_pain_location(value: Any) -> str:
    """Chỉ lấy vị trí giải phẫu nằm trong câu/đoạn có từ 'đau'."""
    raw = str(value or "")
    segments = [seg.strip() for seg in re.split(r"[\r\n.;,]+", raw) if seg.strip()]
    pain_segments = []
    for segment in segments:
        normalized = _norm(segment)
        pain_count = len(re.findall(r"\bdau\b", normalized))
        if not pain_count:
            continue
        if pain_count == 1 and re.search(r"\b(khong|chua)\s+(?:con\s+)?dau\b", normalized):
            continue
        pain_segments.append(segment)
    if not pain_segments:
        return ""

    found: List[str] = []
    for segment in pain_segments:
        norm_segment = _norm(segment)
        for canonical, aliases in _PAIN_LOCATION_PATTERNS:
            matched = False
            for alias in aliases:
                pos = norm_segment.find(alias)
                if pos < 0:
                    continue
                side = _extract_side(norm_segment, pos, len(alias))
                label = f"{canonical} {side}".strip()
                if label not in found:
                    found.append(label)
                matched = True
                break
            if matched and len(found) >= 3:
                break
        if len(found) >= 3:
            break
    if not found:
        return ""
    if len(found) == 1:
        return found[0]
    return ", ".join(found[:-1]) + " và " + found[-1]


def _replace_pain_line(template: Any, pain_location: str) -> str:
    base = str(template or DEFAULT_DIEN_BIEN).strip()
    location = _compact(pain_location)
    if not base or not location:
        return ""
    lines = base.splitlines()
    for idx, line in enumerate(lines):
        if re.match(r"^\s*đau\b", line, flags=re.IGNORECASE) or _norm(line).startswith("dau "):
            indent = line[: len(line) - len(line.lstrip())]
            lines[idx] = f"{indent}Đau {location}"
            return "\n".join(lines).strip()
    return ""


def _pain_suggestion_from_first_order(template: Any, first_order_text: Any) -> Tuple[str, str]:
    location = _extract_pain_location(first_order_text)
    if not location:
        return "", ""
    return location, _replace_pain_line(template, location)


def _read_first_order_seed(driver: Any, history_url: str) -> Dict[str, Any]:
    driver.get(_order_history_show_all_url(history_url))
    wait_after_action(driver, 1.0, ready_timeout=12)
    _force_order_history_show_all_in_driver(driver)
    try:
        if WebDriverWait is not None and EC is not None and By is not None:
            WebDriverWait(driver, 8).until(EC.presence_of_element_located((By.TAG_NAME, "body")))
    except Exception:
        pass
    rows = _parse_order_history_rows(driver.page_source or "")
    if not rows:
        raise RuntimeError("Không đọc được lịch sử y lệnh.")
    first = rows[0]
    seed = _compact(first.get("dien_bien") or first.get("y_lenh_khac") or first.get("ten_y_lenh") or "")
    if not seed:
        raise RuntimeError("Y lệnh đầu tiên không có diễn biến để gợi ý.")
    return {
        "seed_dien_bien": seed,
        "first_order": first,
        "total_orders": len(rows),
    }


def _fetch_order_seed(req: Dict[str, Any], output_path: str) -> int:
    config = _build_config(req)
    care_date, target_department = _validate_request(req)
    template = str(req.get("dienBien") or req.get("dien_bien") or DEFAULT_DIEN_BIEN).strip()
    row = req.get("row") if isinstance(req.get("row"), dict) else {}
    if not isinstance(row, dict) or not _patient_code(row.get("ma_bn")):
        raise ValueError("Thiếu thông tin người bệnh để lấy y lệnh đầu tiên.")
    if not config.get("url_login") or not config.get("username") or not config.get("password"):
        raise ValueError("Thiếu URL đăng nhập hoặc tài khoản/mật khẩu.")

    with open_session(os.devnull, config=config) as ws:
        fresh_rows = scan_matching_rows(ws.driver, ws.wait, config, care_date, target_department)
        history_url = _resolve_doctor_history_url(row, fresh_rows)
        if not history_url:
            raise RuntimeError("Không tìm được liên kết lịch sử y lệnh của người bệnh này.")
        item = _read_first_order_seed(ws.driver, history_url)

    raw_seed = _compact(item.get("seed_dien_bien") or "")
    pain_location, suggested = _pain_suggestion_from_first_order(template, raw_seed)
    result = {
        "status": "ok",
        "message": "Đã lấy y lệnh đầu tiên và phân tích vị trí đau." if suggested else "Đã lấy y lệnh đầu tiên nhưng chưa nhận diện được vị trí đau.",
        **item,
        "raw_seed_dien_bien": raw_seed,
        "pain_location": pain_location,
        "suggested_dien_bien": suggested,
        "seed_dien_bien": suggested,
        "suggestion_available": bool(suggested),
    }
    _write_json(output_path, result)
    return 0


def _read_sheets_done(ws: Any, requested: Dict[str, Any], fresh_rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Xem tab Tình trạng chăm sóc (chỉ đọc): 2 phiếu đã Hoàn tất chưa, để bỏ ca không cần nhập."""
    fresh = next((f for f in fresh_rows if _row_identity(f) == _row_identity(requested)), None)
    if not fresh or not fresh.get("nursing_url") or scan_cham_soc_cache is None:
        return {"sheets_error": "Không mở được hồ sơ điều dưỡng để xem phiếu chăm sóc."}
    sheets = care_sheets(requested)
    _, day, _ = _parse_admission_time(sheets[0]["time_str"])
    try:
        _open_care_page(ws.driver, ws.wait, fresh)
        _, entries = scan_cham_soc_cache(ws.driver, day)
    except Exception as exc:
        return {"sheets_error": f"Không đọc được phiếu chăm sóc: {_compact(str(exc))[:200]}"}
    return {"sheets_done": {sh["key"]: sheet_done(entries or [], sh) for sh in sheets}}


def _fetch_order_seeds(req: Dict[str, Any], output_path: str) -> int:
    """Lấy y lệnh đầu tiên cho toàn bộ danh sách trong một phiên đăng nhập."""
    config = _build_config(req)
    care_date, target_department = _validate_request(req)
    template = str(req.get("dienBien") or req.get("dien_bien") or DEFAULT_DIEN_BIEN).strip()
    requested_rows = [
        row for row in (req.get("rows") or [])
        if isinstance(row, dict) and _patient_code(row.get("ma_bn"))
    ][:120]
    if not requested_rows:
        raise ValueError("Không có người bệnh để lấy y lệnh đầu tiên.")
    if not config.get("url_login") or not config.get("username") or not config.get("password"):
        raise ValueError("Thiếu URL đăng nhập hoặc tài khoản/mật khẩu.")

    results: List[Dict[str, Any]] = []
    with open_session(os.devnull, config=config) as ws:
        fresh_rows = scan_matching_rows(ws.driver, ws.wait, config, care_date, target_department)
        for requested in requested_rows:
            key = _compact(requested.get("client_key") or "") or _row_identity(requested)
            code = _patient_code(requested.get("ma_bn"))
            item: Dict[str, Any] = {
                "row_key": key,
                "ma_bn": code,
                "ho_ten": _compact(requested.get("ho_ten") or ""),
                "success": False,
            }
            try:
                history_url = _resolve_doctor_history_url(requested, fresh_rows)
                if not history_url:
                    raise RuntimeError("Không tìm được liên kết lịch sử y lệnh.")
                seed_data = _read_first_order_seed(ws.driver, history_url)
                raw_seed = _compact(seed_data.get("seed_dien_bien") or "")
                pain_location, suggested = _pain_suggestion_from_first_order(template, raw_seed)
                item.update({
                    "success": True,
                    **seed_data,
                    "raw_seed_dien_bien": raw_seed,
                    "pain_location": pain_location,
                    "suggested_dien_bien": suggested,
                    "seed_dien_bien": suggested,
                    "suggestion_available": bool(suggested),
                })
                if not suggested:
                    item["error"] = "Đã đọc y lệnh đầu tiên nhưng không nhận diện được vị trí đau trong diễn biến."
            except Exception as exc:
                item["error"] = str(exc)
            item.update(_read_sheets_done(ws, requested, fresh_rows))
            results.append(item)

    succeeded = sum(1 for item in results if item.get("success"))
    suggested = sum(1 for item in results if item.get("suggestion_available"))
    unmatched = sum(1 for item in results if item.get("success") and not item.get("suggestion_available"))
    failed = len(results) - succeeded
    status = "ok" if not failed and not unmatched else ("partial" if succeeded else "error")
    result = {
        "status": status,
        "message": (
            f"Đã đọc y lệnh đầu tiên cho {succeeded}/{len(results)} người bệnh; "
            f"gợi ý được vị trí đau cho {suggested}, chưa nhận diện được {unmatched}, lỗi {failed}."
        ),
        "results": results,
        "succeeded": succeeded,
        "suggested": suggested,
        "unmatched": unmatched,
        "failed": failed,
    }
    _write_json(output_path, result)
    return 0 if succeeded else 2


# ── 2 phiếu chăm sóc của 1 người bệnh nhập viện ─────────────────────────────

def ward_time(care_time: Any, minutes: int = WARD_MINUTES) -> str:
    """Giờ phiếu Khoa nhận mặc định: T/G vào + `minutes` phút. Rỗng nếu T/G vào không hợp lệ."""
    time_str, _, _ = _parse_admission_time(care_time)
    if not time_str:
        return ""
    return (datetime.strptime(time_str, "%H:%M %d/%m/%Y") + timedelta(minutes=minutes)).strftime("%H:%M %d/%m/%Y")


def ward_dien_bien(dien_bien: Any) -> str:
    """Diễn biến phiếu Khoa nhận: như phiếu Khám bệnh nhưng dòng đầu là "<Khoa> nhận"."""
    lines = [line for line in str(dien_bien or "").splitlines() if line.strip()]
    if lines and "nhan" in _norm(lines[0]):
        lines = lines[1:]
    return "\n".join([f"{WARD_NAME} nhận", *lines])


def vitals_errors(vitals: Any) -> List[str]:
    """Ô sinh hiệu người dùng đã gõ mà sai dạng thì báo. Ô trống được: điền như phiếu chăm sóc thường."""
    v = vitals if isinstance(vitals, dict) else {}
    out: List[str] = []
    checks = {
        "mach": lambda x: re.fullmatch(r"\d{2,3}", x) and 30 <= int(x) <= 220,
        "nhiet_do": lambda x: re.fullmatch(r"\d{2}([.,]\d)?", x) and 34 <= float(x.replace(",", ".")) <= 43,
        "huyet_ap": lambda x: re.fullmatch(r"\d{2,3}/\d{2,3}", x),
        "nhip_tho": lambda x: re.fullmatch(r"\d{1,2}", x) and 6 <= int(x) <= 60,
    }
    for key, label in VITAL_FIELDS:
        value = _compact(v.get(key))
        if value and not checks[key](value):
            out.append(f"{label} \"{value}\" không hợp lệ")
    return out


def ward_oncall_nurse(config: Dict[str, Any], time_str: str) -> str:
    """Người nhận bệnh ở phiếu Khoa nhận = người trực theo Lịch điều dưỡng lúc đó."""
    if not time_str:
        return ""
    return _compact(get_nurse_by_shift(time_str, config.get("ten_dieu_duong") or {}, force_shift="oncall"))


def care_sheets(row: Dict[str, Any]) -> List[Dict[str, Any]]:
    """2 phiếu cần có của người bệnh, theo nội dung người dùng đã sửa (thiếu thì theo mẫu)."""
    time_str, _, hour = _parse_admission_time(row.get("care_time_str") or row.get("tg_vao"))
    dien_bien = str(row.get("dien_bien") or DEFAULT_DIEN_BIEN).strip()
    ward_at, _, ward_hour = _parse_admission_time(row.get("khoa_time_str") or ward_time(time_str))
    vitals = {k: _compact((row.get("vitals") or {}).get(k)) for k, _ in VITAL_FIELDS}
    done = row.get("sheets_done") if isinstance(row.get("sheets_done"), dict) else {}
    return [
        {"key": "kham", "label": "Khoa Khám Bệnh chuyển", "time_str": time_str, "hour": hour,
         "dien_bien": dien_bien, "cham_soc": str(row.get("cham_soc") or DEFAULT_CARE_CONTENT).strip(), "vitals": None,
         "expect_done": done.get("kham") is True},
        {"key": "khoa", "label": f"{WARD_NAME} nhận", "time_str": ward_at, "hour": ward_hour,
         "dien_bien": str(row.get("dien_bien_khoa") or ward_dien_bien(dien_bien)).strip(),
         "cham_soc": str(row.get("cham_soc_khoa") or DEFAULT_WARD_CARE).strip(), "vitals": vitals,
         "expect_done": done.get("khoa") is True},
    ]


def sheet_done(entries: Iterable[Dict[str, Any]], sheet: Dict[str, Any]) -> bool:
    """Phiếu đã Hoàn tất trên EMR thì không cần nhập (không sửa phiếu đã hoàn tất).
    Phiếu Khám bệnh: có phiếu Hoàn tất đúng T/G vào. Phiếu Khoa nhận: có phiếu Hoàn tất cùng ngày ở giờ đã chọn,
    hoặc nội dung là phiếu nhận ("Nhận HS" / diễn biến bắt đầu "Khoa … nhận") — khoa có thể đã tự lập giờ khác."""
    _, day, _ = _parse_admission_time(sheet.get("time_str"))
    for e in entries or []:
        if "hoan tat" not in _norm(e.get("status")):
            continue
        if _compact(e.get("time_full")) == sheet.get("time_str"):
            return True
        if sheet.get("key") == "khoa" and _compact(e.get("date")) == day:
            first = _norm((str(e.get("dien_bien") or "").splitlines() or [""])[0])
            if "nhan hs" in _norm(e.get("cham_soc")) or (first.startswith("khoa") and "nhan" in first):
                return True
    return False


def _preview(req: Dict[str, Any], output_path: str) -> int:
    config = _build_config(req)
    care_date, target_department = _validate_request(req)
    if not config.get("url_login") or not config.get("username") or not config.get("password"):
        raise ValueError("Thiếu URL đăng nhập hoặc tài khoản/mật khẩu.")
    with open_session(os.devnull, config=config) as ws:
        rows = scan_matching_rows(ws.driver, ws.wait, config, care_date, target_department)
    fallback_nurses = _configured_fallback_nurses(config)
    public_rows = []
    for row in rows:
        public_row = dict(row)
        public_row["has_nursing_link"] = bool(row.get("nursing_url"))
        nurses = _effective_nurses(req, config, row.get("care_time_str") or row.get("tg_vao") or care_date, fallback_nurses)
        public_row["dieu_duong"] = nurses[0] if nurses else ""
        public_row["can_input"] = bool(row.get("nursing_url") and nurses)
        public_row["nguoi_nhan"] = ward_oncall_nurse(config, ward_time(row.get("care_time_str") or row.get("tg_vao")))
        public_row["thieu_tai_khoan"] = [n for n in (public_row["dieu_duong"], public_row["nguoi_nhan"])
                                         if n and not get_emr_account_for_nurse(n)]
        public_rows.append(public_row)
    result = {
        "status": "ok",
        "message": (
            f"Tìm thấy {len(rows)} người bệnh có T/G vào ngày {care_date} "
            f"và Khoa chuyển đến = {target_department}."
        ),
        "care_date": care_date,
        "target_department": target_department,
        "rows": public_rows,
        "summary": {
            "total": len(rows),
            "with_nursing_url": sum(1 for r in rows if r.get("nursing_url")),
            "missing_nursing_url": sum(1 for r in rows if not r.get("nursing_url")),
        },
    }
    _write_json(output_path, result)
    return 0


def _verify_opened_patient(driver: Any, row: Dict[str, Any]) -> bool:
    html = driver.page_source or ""
    code = _patient_code(row.get("ma_bn"))
    if code and re.search(rf"(?<!\d){re.escape(code)}(?!\d)", html):
        return True
    name = _norm(row.get("ho_ten"))
    if name and name in _norm(BeautifulSoup(html, "html.parser").get_text(" ", strip=True) if BeautifulSoup else html):
        return True
    return False


_SESSION_KEYS = {"usid", "st"}


def _with_current_session(saved_url: str, current_url: str) -> str:
    """Link hồ sơ quét lúc đầu mang usid/st của phiên đã quét (tài khoản bác sĩ). Sau khi đổi sang
    tài khoản điều dưỡng (Chrome mới, phiên mới) phải thay bằng usid/st của phiên đang đăng nhập,
    không thì EMR đẩy về trang đăng nhập."""
    cur = dict(parse_qsl(urlparse(current_url or "").query, keep_blank_values=True))
    fresh = {k: v for k, v in cur.items() if k.lower() in _SESSION_KEYS and v}
    if not fresh:
        return saved_url
    p = urlparse(saved_url)
    query = [(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True) if k.lower() not in _SESSION_KEYS]
    return urlunparse((p.scheme, p.netloc, p.path, p.params, urlencode(query + list(fresh.items())), p.fragment))


def _open_care_page(driver: Any, wait: Any, row: Dict[str, Any]) -> None:
    url = _compact(row.get("nursing_url") or "")
    if not url:
        raise RuntimeError("Dòng người bệnh không có liên kết điều dưỡng.")
    driver.get(_with_current_session(url, str(getattr(driver, "current_url", "") or "")))
    wait_after_action(driver, 0.8, ready_timeout=12)
    if not _verify_opened_patient(driver, row):
        raise RuntimeError("Không xác nhận được đúng mã/tên người bệnh sau khi mở hồ sơ điều dưỡng.")

    # Nếu chưa ở tab Tình trạng chăm sóc thì bấm đúng nút tab.
    try:
        if driver.find_elements(By.ID, "btnThemCS"):
            return
    except Exception:
        pass
    try:
        btn = wait.until(EC.element_to_be_clickable((By.ID, "btnTTCS")))
        driver.execute_script("arguments[0].click();", btn)
        wait_after_action(driver, 0.8, ready_timeout=10)
    except Exception as exc:
        raise RuntimeError(f"Không mở được tab Tình trạng chăm sóc: {exc}")


def _effective_nurses(
    req: Dict[str, Any],
    config: Dict[str, Any],
    care_time: str,
    fallback_nurses: List[str],
) -> List[str]:
    """Chọn điều dưỡng bằng đúng lịch chung mà nhập bệnh phòng đang dùng."""
    manual = _compact((req.get("clinicSchedule") or req.get("clinic_schedule") or {}).get("nurseName") or "")
    if manual:
        return [manual]

    # Giữ tương thích cấu hình riêng cũ nếu đơn vị đã khai báo.
    schedule = config.get("clinic_nurse_schedule") or {}
    scheduled = _clinic_nurses_for_date(schedule, _dmy(care_time))
    if scheduled:
        return scheduled

    # Luồng chuẩn: dùng ten_dieu_duong và quy tắc ca theo đúng T/G vào,
    # giống input_care/input_infusions/input_procedures của bệnh phòng.
    shared_name = _compact(get_nurse_by_shift(care_time, config.get("ten_dieu_duong") or {}))
    if shared_name:
        return [shared_name]
    return fallback_nurses


def _configured_fallback_nurses(config: Dict[str, Any]) -> List[str]:
    try:
        from utils import lay_danh_sach_tat_ca_ten  # type: ignore
        return lay_danh_sach_tat_ca_ten(config.get("ten_dieu_duong"))
    except Exception:
        return []


def _row_dien_bien(row: Dict[str, Any], fallback: str = DEFAULT_DIEN_BIEN) -> str:
    """Lấy diễn biến đã lưu riêng cho BN; chỉ dùng mẫu chung khi dữ liệu cũ chưa có trường này."""
    value = str((row or {}).get("dien_bien") or (row or {}).get("dienBien") or "").strip()
    return value or str(fallback or DEFAULT_DIEN_BIEN).strip()


def _input_one(
    ws: Any,
    row: Dict[str, Any],
    nurses: List[str],
    care_content: str,
    dien_bien: str,
    needs_vitals: bool,
    vitals: Optional[Dict[str, str]] = None,
    done_check: Optional[Any] = None,
    require_done: bool = False,
) -> Dict[str, Any]:
    required_actions = (
        scan_cham_soc_cache, kiem_tra_bang_cached,
        open_cham_soc_by_id, set_thoi_gian_lap, dien_thong_tin,
        check_trang_thai_badge, click_thu_hoi_va_xoa, click_thu_hoi_cham_soc,
    )
    if any(action is None for action in required_actions):
        return {"success": False, "error": "Thiếu Selenium hoặc module thao tác phiếu chăm sóc."}
    time_str, ngay_lam, hour = _parse_admission_time(row.get("care_time_str") or row.get("tg_vao"))
    if not time_str or not ngay_lam or hour < 0:
        return {"success": False, "error": "T/G vào không hợp lệ; không được tự thay bằng giờ khác."}
    if not nurses:
        return {"success": False, "error": "Không xác định được điều dưỡng để lập phiếu chăm sóc."}

    driver, wait = ws.driver, ws.wait
    print(f"[CLINIC_CARE] {row.get('ma_bn')} | {time_str} | {row.get('khoa_chuyen_den')} | ĐD={nurses}")
    _open_care_page(driver, wait, row)

    scan_targets = [time_str]
    cs_cache, cs_entries = scan_cham_soc_cache(driver, ngay_lam, hours_needed=scan_targets)
    if done_check is not None and done_check(cs_entries or []):
        # Phiếu đã Hoàn tất (người khác lập hoặc lập tay): giữ nguyên, không sửa.
        return {"success": True, "skipped": True, "reason": "Đã có phiếu Hoàn tất", "error": None, "time_str": time_str}
    if require_done:
        return {"success": False, "error": "Lúc tìm đã có phiếu Hoàn tất nhưng nay không thấy; nhập đủ nội dung rồi tìm lại."}
    # Luồng này chỉ bổ sung phiếu tại đúng T/G vào. Không chạy dọn cache vì có thể
    # xóa nhầm phiếu chăm sóc khác do điều dưỡng đang lập cho cùng người bệnh.
    expected_creator = nurses[0]
    status, care_id, existing_creator = kiem_tra_bang_cached(
        cs_cache,
        time_str,
        hour,
        care_content,
        nurses,
        dien_bien,
        needs_vitals=needs_vitals or bool(vitals),
        expected_creator=expected_creator,
    )
    if status == "PERFECT":
        return {"success": True, "error": None, "time_str": time_str, "nurse": nurses, "already_correct": True}
    if status == "SKIP":
        return {"success": True, "skipped": True, "reason": "Phiếu đã có", "error": None, "time_str": time_str}

    # EMR hiện chỉ cho đúng tài khoản người tạo phiếu tự sửa/xóa phiếu của họ
    # (worker/shared/worker_session.py là nơi tập trung xử lý đổi/khôi phục
    # tài khoản — xem WorkerSession.switch_to_creator_account/restore_account).
    # Nếu phiếu cũ (đang sửa/xóa) do người khác lập, phải đổi sang đúng tài
    # khoản của người đó rồi mới thao tác, và đổi lại đúng tài khoản gốc của
    # lượt nhập này (dùng để tạo phiếu mới) trước khi thoát hàm.
    original_username = str(ws.config.get("username") or "").strip()
    original_password = str(ws.config.get("password") or "")
    switched_away = False

    def _reopen(w, _ma_bn):
        _open_care_page(w.driver, w.wait, row)

    def _restore_original_account():
        nonlocal driver, wait
        ws.restore_account(original_username, original_password, row.get("ma_bn"), reopen=_reopen)
        driver, wait = ws.driver, ws.wait

    if status in ("UPDATE", "EDIT") and existing_creator:
        if not ws.switch_to_creator_account(existing_creator, row.get("ma_bn"), reopen=_reopen):
            return {
                "success": False,
                "error": (
                    f"{time_str}: không đổi được tài khoản EMR của người lập phiếu cũ "
                    f"'{existing_creator}' — không tự sửa/xóa được (chưa cấu hình tài "
                    "khoản hoặc đổi/mở lại hồ sơ thất bại)."
                ),
            }
        driver, wait = ws.driver, ws.wait
        switched_away = True

    try:
        if status == "UPDATE":
            if care_id:
                open_cham_soc_by_id(driver, care_id)
            wait.until(EC.visibility_of_element_located((By.ID, "txtThoiGianLap")))
            click_thu_hoi_cham_soc(driver)
        elif status == "EDIT":
            if care_id:
                open_cham_soc_by_id(driver, care_id)
            wait.until(EC.visibility_of_element_located((By.ID, "txtThoiGianLap")))
            click_thu_hoi_va_xoa(driver)
            if switched_away:
                # Phiếu mới phải được tạo dưới đúng tài khoản gốc của lượt nhập
                # này, không phải tài khoản người tạo phiếu cũ vừa xóa.
                _restore_original_account()
                switched_away = False

        try:
            wait.until(EC.element_to_be_clickable((By.ID, "btnThemCS"))).click()
            wait.until(EC.visibility_of_element_located((By.ID, "txtThoiGianLap")))
        except Exception as exc:
            return {"success": False, "error": f"Không mở được form phiếu chăm sóc: {exc}"}

        config_name = {"Default": {"work": nurses, "oncall": [], "admin": []}}
        for attempt in range(1, 4):
            if not set_thoi_gian_lap(driver, time_str, max_retry=2):
                print(f"[WARN] Không đặt đúng T/G vào ở lần {attempt}")
                time.sleep(0.5)
                continue
            form_ok = dien_thong_tin(
                driver,
                hour,
                time_str,
                care_content,
                nurses,
                dien_bien,
                needs_vitals=needs_vitals,
                config_ten_goc=config_name,
                vitals=vitals,
            )
            if not form_ok:
                print(f"[WARN] Không chọn/verify được Người lập ở lần {attempt}")
                time.sleep(0.5)
                continue
            try:
                save = driver.find_element(By.ID, "btnSaveChamSocPopupDraw")
                driver.execute_script("arguments[0].click();", save)
            except Exception as exc:
                return {"success": False, "error": f"Không nhấn được Lưu: {exc}"}
            time.sleep(1.5)
            handle_popups(driver)
            try:
                complete = driver.find_element(By.ID, "btnPopupHOANTAT")
                driver.execute_script("arguments[0].click();", complete)
            except Exception:
                pass
            time.sleep(2.0)
            handle_popups(driver)
            if "Hoàn tất" in check_trang_thai_badge(driver):
                return {"success": True, "error": None, "time_str": time_str, "nurse": nurses}

        return {"success": False, "error": f"{time_str}: Không lưu/hoàn tất được phiếu chăm sóc."}
    finally:
        if switched_away:
            # UPDATE: toàn bộ sửa+lưu vừa chạy dưới tài khoản người lập cũ (bắt
            # buộc) — đổi lại đúng tài khoản gốc dù thành công hay lỗi.
            _restore_original_account()


def _input_patient(ws: Any, fresh: Dict[str, Any], nurses: List[str], sheets: List[Dict[str, Any]],
                   needs_vitals: bool) -> Dict[str, Any]:
    """Nhập lần lượt 2 phiếu (Khám bệnh chuyển, Khoa nhận). Phiếu đã Hoàn tất thì bỏ qua;
    phiếu đầu lỗi thì không lập phiếu sau. Phiếu nào lập bằng chính tài khoản EMR của người lập
    phiếu đó (EMR không cho Thu hồi để đổi Người lập nữa)."""
    # Kiểm tra cả 2 phiếu trước khi ghi gì lên EMR.
    for sheet in sheets:
        if sheet.get("nurses") == [] and not sheet.get("expect_done"):
            return {"success": False, "error": f"{sheet['label']}: chưa có người trực trong Lịch điều dưỡng lúc {sheet['time_str']}."}
        owner = (sheet.get("nurses") or nurses or [""])[0]
        if not sheet.get("expect_done") and not get_emr_account_for_nurse(owner):
            return {"success": False, "error": f"{sheet['label']}: chưa có tài khoản EMR của {owner or 'người lập'} "
                                               "(Cài đặt → Thiết lập tài khoản), không nhập để tránh sai người lập."}
        if not sheet.get("time_str"):
            return {"success": False, "error": f"{sheet['label']}: giờ lập phiếu không hợp lệ."}
        if sheet["key"] == "khoa" and not _after(sheet["time_str"], sheets[0]["time_str"]):
            return {"success": False, "error": f"{sheet['label']}: giờ phiếu phải sau T/G vào {sheets[0]['time_str']}."}
        if sheet.get("vitals") is not None and not sheet.get("expect_done"):
            bad = vitals_errors(sheet["vitals"])
            if bad:
                return {"success": False, "error": f"{sheet['label']}: sinh hiệu {', '.join(bad)}."}
    notes: List[str] = []
    all_skipped = True
    for sheet in sheets:
        owner = (sheet.get("nurses") or nurses)[0]
        if not sheet.get("expect_done") and not ws.switch_to_creator_account(
                owner, fresh.get("ma_bn"), reopen=lambda w, _ma_bn: _open_care_page(w.driver, w.wait, fresh)):
            return {"success": False, "error": f"{sheet['label']}: không đăng nhập được tài khoản EMR của {owner}.",
                    "time_str": sheets[0]["time_str"]}
        res = _input_one(
            ws, {**fresh, "care_time_str": sheet["time_str"]}, sheet.get("nurses") or nurses, sheet["cham_soc"], sheet["dien_bien"],
            needs_vitals or sheet.get("vitals") is not None,
            vitals=None if sheet.get("expect_done") else {k: v for k, v in (sheet.get("vitals") or {}).items() if v},
            done_check=lambda entries, sh=sheet: sheet_done(entries, sh), require_done=bool(sheet.get("expect_done")),
        )
        if not res.get("success"):
            return {"success": False, "error": f"{sheet['label']}: {res.get('error') or 'không nhập được'}",
                    "time_str": sheets[0]["time_str"]}
        all_skipped = all_skipped and bool(res.get("skipped"))
        notes.append(f"{sheet['label']} {sheet['time_str']}: "
                     + ("đã có" if res.get("skipped") else ("đã đúng" if res.get("already_correct") else "đã nhập")))
    out: Dict[str, Any] = {"success": True, "error": None, "time_str": sheets[0]["time_str"], "nurse": nurses, "sheets": notes}
    if all_skipped:
        out.update({"skipped": True, "reason": "Đã có đủ 2 phiếu Hoàn tất"})
    return out


def _after(later: str, earlier: str) -> bool:
    try:
        return datetime.strptime(later, "%H:%M %d/%m/%Y") > datetime.strptime(earlier, "%H:%M %d/%m/%Y")
    except ValueError:
        return False


def _input(req: Dict[str, Any], result_path: str) -> int:
    config = _build_config(req)
    care_date, target_department = _validate_request(req)
    requested_rows = [r for r in (req.get("rows") or []) if isinstance(r, dict) and _patient_code(r.get("ma_bn"))]
    if not requested_rows:
        raise ValueError("Không có người bệnh đã được xem trước để nhập chăm sóc.")

    care_content = str(req.get("careContent") or DEFAULT_CARE_CONTENT).strip()
    dien_bien = str(req.get("dienBien") or DEFAULT_DIEN_BIEN).strip()
    needs_vitals = bool(req.get("needsVitals", False))

    fallback_nurses = _configured_fallback_nurses(config)

    with open_session(result_path, config=config, result_kwargs={"mode": "clinic_inpatient_care"}) as ws:
        fresh_rows = scan_matching_rows(ws.driver, ws.wait, config, care_date, target_department)
        fresh_map: Dict[str, Dict[str, Any]] = {}
        for fresh in fresh_rows:
            key = _row_identity(fresh)
            if key:
                fresh_map[key] = fresh

        for idx, requested in enumerate(requested_rows, 1):
            code = _patient_code(requested.get("ma_bn"))
            requested_time, requested_date, _ = _parse_admission_time(
                requested.get("care_time_str") or requested.get("tg_vao")
            )
            result_key = f"{code}::{requested_time or requested_date or idx}"
            if requested.get("nhap") is False:
                ws.mark_skipped(result_key, "Không cần nhập (đã đủ phiếu hoặc người dùng bỏ chọn).")
                continue
            if requested_date != care_date:
                ws.mark_failed(result_key, "T/G vào không cùng ngày đã chọn.")
                continue
            fresh = fresh_map.get(_row_identity(requested))
            if not fresh:
                ws.mark_skipped(
                    result_key,
                    "Không còn thấy dòng khớp Khoa chuyển đến và T/G vào khi quét lại; không nhập để tránh nhầm hồ sơ.",
                )
                continue
            saved_nurse = _compact(requested.get("dieu_duong") or "")
            nurses = [saved_nurse] if saved_nurse else _effective_nurses(req, config, requested_time or fresh.get("care_time_str") or care_date, fallback_nurses)
            sheets = care_sheets({
                **requested,
                "care_time_str": requested_time,
                "dien_bien": _row_dien_bien(requested, dien_bien),
                "cham_soc": requested.get("cham_soc") or care_content,
            })
            oncall = ward_oncall_nurse(config, sheets[1]["time_str"])
            sheets[1]["nurses"] = [oncall] if oncall else []
            try:
                ws.results[result_key] = _input_patient(ws, fresh, nurses, sheets, needs_vitals)
            except Exception as exc:
                ws.mark_failed(result_key, exc)

    failed = sum(1 for value in ws.results.values() if not value.get("success"))
    return 2 if failed else 0


def main(argv: Optional[List[str]] = None) -> int:
    args = list(argv or sys.argv[1:])
    if len(args) < 2:
        print("Cách dùng: clinic_input_care.py [preview|input|order-seed|order-seeds] <request.json> <output.json>")
        return 1
    if args[0] in {"preview", "input", "order-seed", "order-seeds"}:
        mode = args[0]
        if len(args) < 3:
            print("Thiếu request/output path.")
            return 1
        request_path, output_path = args[1], args[2]
    else:
        # Tương thích lời gọi cũ: mặc định là input.
        mode = "input"
        request_path, output_path = args[0], args[1]

    try:
        req = _load_request(request_path)
        if mode == "preview":
            return _preview(req, output_path)
        if mode == "order-seed":
            return _fetch_order_seed(req, output_path)
        if mode == "order-seeds":
            return _fetch_order_seeds(req, output_path)
        return _input(req, output_path)
    except Exception as exc:
        print(f"[LỖI] {type(exc).__name__}: {exc}")
        if mode in {"preview", "order-seed", "order-seeds"}:
            try:
                payload = {"status": "error", "message": str(exc), "rows": []} if mode == "preview" else {"status": "error", "message": str(exc), "results": []}
                _write_json(output_path, payload)
            except Exception:
                pass
        return 1


if __name__ == "__main__":
    sys.exit(main())
