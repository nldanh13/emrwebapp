# -*- coding: utf-8 -*-
import sys
import json
import os
import time
import re
import argparse
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple
from utils import load_config, normalize_date, login_emr
from shared.worker_session import WorkerSession
from urllib.parse import urlparse, urlencode, parse_qsl, urlunparse, urljoin

# Lazy import for HTTP reader (so a broken file won't crash the whole worker)
def _get_http_session(config: Dict[str, Any]):
    try:
        from emr_http_reader import EmrHttpSession  # local import
        return EmrHttpSession.from_config_dict(config)
    except Exception as e:
        # Do not crash; allow Selenium fallback
        print(f"[HTTP READ] Không thể khởi tạo HTTP session: {e} -> fallback Selenium")
        return None

from emr_parsers import extract_timeline_map_from_html, extract_ward_admissions_from_html
from date_utils import add_days_dmy, work_date_for_timeline_date
from runtime_data_v2 import merge_order_records, write_json_compact, generate_runtime_v2_files
try:
    from selenium import webdriver
    from selenium.webdriver.common.by import By
    from selenium.webdriver.common.keys import Keys
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
    from selenium.common.exceptions import TimeoutException as SeleniumTimeoutException
except ModuleNotFoundError:
    webdriver = None  # type: ignore
    By = Keys = WebDriverWait = EC = None  # type: ignore
    SeleniumTimeoutException = TimeoutError  # type: ignore

try:
    from selenium_emr_helpers import (
        set_inpatient_status_filter as _set_inpatient_status_filter,
        set_time_range_filter as _set_time_range_filter,
        patient_row_exists as _patient_row_exists,
    )
except Exception:  # pragma: no cover
    _set_inpatient_status_filter = None  # type: ignore
    _set_time_range_filter = None  # type: ignore
    _patient_row_exists = None  # type: ignore

try:
    from bs4 import BeautifulSoup
except ModuleNotFoundError:
    BeautifulSoup = None  # type: ignore

# Console UTF-8 (Windows-safe)
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass




def _debug_page(driver: Any, label: str) -> None:
    """Lưu HTML/screenshot khi Selenium không tìm được phần tử cần thiết."""
    try:
        safe = re.sub(r"[^a-zA-Z0-9_.-]+", "_", str(label or "debug"))[:80]
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        log_dir = os.path.join(os.getcwd(), "logs")
        os.makedirs(log_dir, exist_ok=True)
        html_path = os.path.join(log_dir, f"{safe}_{ts}.html")
        png_path = os.path.join(log_dir, f"{safe}_{ts}.png")
        with open(html_path, "w", encoding="utf-8") as f:
            f.write(driver.page_source or "")
        try:
            driver.save_screenshot(png_path)
        except Exception:
            png_path = ""
        print(f"[DEBUG] Đã lưu trang lỗi: {html_path}" + (f" | {png_path}" if png_path else ""))
    except Exception as e:
        print(f"[DEBUG] Không lưu được trang lỗi {label}: {e}")


def _selenium_page_load_timeout(default: int = 25) -> int:
    try:
        value = int(str(os.environ.get("SELENIUM_PAGE_LOAD_TIMEOUT", default)).strip())
    except Exception:
        return default
    return max(5, min(180, value))


def _safe_driver_get(driver: Any, url: str, label: str = "trang") -> bool:
    """Mở URL nhưng không để Chrome treo vô hạn ở trạng thái loading.

    EMR thường tải xong DOM nhưng request nền/AJAX còn pending, làm driver.get()
    không trả về. Khi quá timeout, dừng tải nền bằng window.stop() rồi để bước
    WebDriverWait kế tiếp quyết định trang đã đủ dữ liệu hay chưa.
    """
    timeout = _selenium_page_load_timeout()
    try:
        driver.set_page_load_timeout(timeout)
    except Exception:
        pass
    try:
        driver.get(url)
        return True
    except SeleniumTimeoutException:
        print(f"[WARN] Tải {label} quá {timeout}s; dừng loading nền và tiếp tục kiểm tra DOM.")
        try:
            driver.execute_script("window.stop();")
        except Exception as stop_exc:
            print(f"[WARN] Không gọi được window.stop() sau timeout {label}: {stop_exc}")
        return False


def _build_inpatient_url(base_url: str, wpid: str) -> str:
    """
    Lấy URL hiện tại sau login (có usid/st động) và thêm wpid để ra trang danh sách nội trú.
    Ví dụ: home.aspx?scope=sys&...&usid=xxx&st=yyy → thêm wpid=danhsachdieutrinoitrudraw
    """
    p = urlparse(base_url)
    q = dict(parse_qsl(p.query, keep_blank_values=True))
    q['wpid'] = wpid
    return urlunparse((p.scheme, p.netloc, p.path, p.params, urlencode(q), p.fragment))


DROP_KEYS = {
    "STT",
    "ĐD",
    "KQ",
    "Đối tượng",
    "ĐT chi tiết",
    "Tạm ứng",
    "Phải trả",
    "Trạng thái",
    "GT",  # duplicate of "Giới tính"
}



DETAIL_RECORD_KEYS = [
    "ma_bn", "ma_yt", "ho_ten", "tuoi", "gioi_tinh", "doi_tuong",
    "bac_si", "chan_doan", "tg_vao", "thoi_gian_vao_khoa",
    "khoa_chuyen_den", "khoa_dieu_tri", "ten_khoa_dieu_tri",
    "lich_su_khoa_dieu_tri", "xu_tri",
    "trang_thai", "Vi_Tri",
    "surgery_out", "surgery_out_time", "surgery_out_reason",
    "ngay_ra_vien", "gio_ra_vien", "ngay_ra_vien_date", "ra_vien_hom_nay",
]



def _extract_dmy_date_for_compare(value: Any) -> str:
    """Rút ngày dd/mm/yyyy từ chuỗi ngày/giờ để so sánh các mốc hành chính."""
    text = str(value or "").strip()
    if not text:
        return ""
    # Ưu tiên ngày đủ năm trong chuỗi như "08:36 25/05/2026" hoặc "25-05-2026".
    m = re.search(r"(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})", text)
    if not m:
        return ""
    dd, mm, yy = m.groups()
    yyyy = int(yy)
    if yyyy < 100:
        yyyy += 2000
    try:
        dt = datetime(yyyy, int(mm), int(dd))
    except Exception:
        return ""
    return dt.strftime("%d/%m/%Y")


def _dmy_sort_key(value: Any) -> Optional[datetime]:
    dmy = _extract_dmy_date_for_compare(value)
    if not dmy:
        return None
    try:
        return datetime.strptime(dmy, "%d/%m/%Y")
    except Exception:
        return None


def _latest_ward_admission_datetime(row: Dict[str, Any]) -> Optional[datetime]:
    """Lấy mốc vào khoa mới nhất của đợt điều trị hiện tại nếu đọc được."""
    candidates: List[Any] = []
    for key in ("thoi_gian_vao_khoa", "tg_vao", "thoi_gian_vao", "admission_time", "T/G vào", "Thời gian vào khoa"):
        val = row.get(key) if isinstance(row, dict) else ""
        if val:
            candidates.append(val)
    histories = []
    for key in ("lich_su_khoa_dieu_tri", "khoa_dieu_tri_history", "ward_admissions"):
        val = row.get(key) if isinstance(row, dict) else None
        if isinstance(val, list):
            histories.extend([x for x in val if isinstance(x, dict)])
    for item in histories:
        for key in ("thoi_gian_vao_khoa", "tg_vao", "ngay_vao", "time", "at", "Ngày vào"):
            val = item.get(key)
            if val:
                candidates.append(val)
    parsed = [_dmy_sort_key(x) for x in candidates]
    parsed = [x for x in parsed if x is not None]
    return max(parsed) if parsed else None


def _clear_discharge_fields(row: Dict[str, Any], *, reason: str = "") -> None:
    """Xoá các dấu hiệu ra viện cũ để không kéo sang đợt điều trị hiện tại."""
    if not isinstance(row, dict):
        return
    for key in (
        "ngay_ra_vien", "gio_ra_vien", "ngay_ra_vien_date", "ra_vien_hom_nay",
        "Ngày ra viện", "Giờ ra viện", "NgayRaVien", "discharge_date", "discharge_time",
    ):
        if key in row:
            row[key] = False if key == "ra_vien_hom_nay" else ""
    for key in ("xu_tri", "Xử trí", "XuTri", "Hướng xử trí", "disposition"):
        if key in row and _is_discharge_disposition_text(row.get(key)):
            row[key] = ""
    if row.get("care_mode") == "discharge_day":
        row["care_mode"] = ""
    events = row.get("care_special_events")
    if isinstance(events, list):
        row["care_special_events"] = [ev for ev in events if not (isinstance(ev, dict) and ev.get("type") == "discharge")]
    if reason:
        warnings = row.get("processing_warnings")
        if not isinstance(warnings, list):
            warnings = []
        msg = f"Đã bỏ mốc ra viện cũ: {reason}"
        if msg not in warnings:
            warnings.append(msg)
        row["processing_warnings"] = warnings


def _clear_stale_discharge_for_current_visit(row: Dict[str, Any]) -> bool:
    """Trả True nếu mốc ra viện bị xoá vì cũ hơn mốc vào khoa hiện tại.

    Trường hợp thực tế: người bệnh từng có nhãn ra viện ở đợt/phiên cũ, sau đó
    vào khoa lại. Khi chỉ cập nhật Y lệnh, row đầu vào còn mang ``Xử trí/Ngày ra
    viện`` cũ; nếu không xoá thì UI vẫn hiện "Xuất viện" và worker nhập sai kế
    hoạch chăm sóc.
    """
    if not isinstance(row, dict):
        return False
    discharge_dt = _dmy_sort_key(row.get("ngay_ra_vien_date") or row.get("ngay_ra_vien") or row.get("Ngày ra viện") or row.get("discharge_date"))
    if not discharge_dt:
        return False
    admission_dt = _latest_ward_admission_datetime(row)
    if admission_dt and discharge_dt < admission_dt:
        _clear_discharge_fields(row, reason=f"ngày ra viện {discharge_dt.strftime('%d/%m/%Y')} trước mốc vào khoa {admission_dt.strftime('%d/%m/%Y')}")
        return True
    return False


def _build_record(
    bn: Dict[str, Any],
    timeline_date: str,
    timeline_item: Dict[str, Any],
    *,
    ho_ten: str = "",
    vitri: str = "",
    doctor_from_page: str = "",
    bridge_end_date: Optional[str] = None,
) -> Dict[str, Any]:
    """Build một record KetQua_YLenh thống nhất cho cả HTTP path và Selenium path.

    Output chỉ giữ key chuẩn để tránh lặp alias trong ``03_order_text_by_patient_day.json``.
    """
    _clear_stale_discharge_for_current_visit(bn)
    rec = _canonical_patient_row_for_runtime(bn, include_order_text=False)

    if not rec.get("ma_bn"):
        rec["ma_bn"] = _compact_spaces(bn.get("Mã BN") or bn.get("Mã YT") or bn.get("ma_bn") or "")
    if ho_ten:
        rec["ho_ten"] = ho_ten
    if vitri:
        rec["Vi_Tri"] = vitri

    doc_day = timeline_item.get("Bác sĩ", "") or ""
    if not rec.get("bac_si"):
        rec["bac_si"] = _compact_spaces(doc_day or doctor_from_page or "")

    work_date = work_date_for_timeline_date(timeline_date, bridge_end_date)
    rec["ngay_lam"] = work_date
    if work_date != timeline_date:
        rec["source_date"] = timeline_date
        rec["bridge_source_date"] = timeline_date
        rec["bridge_work_date"] = work_date

    rec["Y lệnh"] = timeline_item.get("Y lệnh", "") or ""
    rec["Diễn biến"] = timeline_item.get("Diễn biến", "") or ""

    for dk in list(rec.keys()):
        if dk in DROP_KEYS:
            rec.pop(dk, None)

    return rec


def _cfg_bool(config: Dict[str, Any], key: str, default: bool = False) -> bool:
    value = config.get(key, default)
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on", "co", "có"}


def _read_mode(config: Dict[str, Any]) -> str:
    """
    Mode đọc dữ liệu EMR.

    Thiết kế hiện tại bỏ cơ chế HTTP-only/cookie cho scan/details vì EMR có thể
    yêu cầu đăng nhập qua trình duyệt. Lấy dữ liệu dùng Selenium headless
    (không hiện cửa sổ Chrome), còn nhập liệu vẫn dùng các script nhập riêng và
    vẫn hiện Chrome thường nếu ``headless`` trong config là false.

    Các giá trị cũ như ``http_only``/``no_chrome`` được hiểu là "đọc ẩn"
    bằng Selenium headless để người dùng không phải sửa config cũ.
    """
    return "selenium"


def _http_read_enabled(config: Dict[str, Any]) -> bool:
    """Không dùng HTTP reader cho luồng lấy dữ liệu chính nữa."""
    return False


def _allow_selenium_read_fallback(config: Dict[str, Any]) -> bool:
    """Luôn dùng Selenium cho scan/details; Chrome được chạy headless khi đọc."""
    return True



def _read_selenium_headless(config: Dict[str, Any]) -> bool:
    """Headless riêng cho các tác vụ đọc dữ liệu.

    Không dùng chung key ``headless`` của các script nhập liệu, để lấy dữ liệu có thể
    chạy Chrome ẩn trong khi nhập liệu vẫn mở Chrome thường cho người dùng theo dõi.
    """
    if "data_read_headless" in config:
        return _cfg_bool(config, "data_read_headless", True)
    if "read_headless" in config:
        return _cfg_bool(config, "read_headless", True)
    return True


def _with_worker_headless(config: Dict[str, Any], headless: bool) -> Dict[str, Any]:
    """Trả về config mới có override headless cho một WorkerSession cụ thể.

    WorkerSession chỉ đọc khóa ``headless``. Các tác vụ đọc dữ liệu lại dùng
    ``data_read_headless``/``read_headless``, nên phải chuyển giá trị đã tính
    sang ``headless`` trước khi khởi tạo Selenium. Không sửa trực tiếp
    ``self.config`` để tránh ảnh hưởng các tác vụ nhập liệu cần mở Chrome thường.
    """
    patched = dict(config or {})
    patched["headless"] = bool(headless)
    return patched

def _raise_http_only_failure(task_name: str, error: Any) -> None:
    raise RuntimeError(
        f"{task_name} không dùng HTTP-only nữa. Lỗi trước khi chuyển sang Selenium headless: {error}. "
        "Hãy kiểm tra cấu hình đăng nhập EMR hoặc driver Chrome."
    )

DATE_FULL_RE = re.compile(r"\b(\d{2}/\d{2}/\d{4})\b")
TIME_RE = re.compile(r"\b(\d{1,2}:\d{2})\b")
DOC_RE = re.compile(r"Bác sĩ:\s*([^\n\r]+)")


def clean_name(name: Any) -> str:
    s = "" if name is None else str(name)
    s = s.strip()
    # Remove "- PM: ..." tail
    s = re.sub(r"\s*-\s*PM\s*:\s*.*$", "", s, flags=re.IGNORECASE).strip()
    s = re.sub(r"\s+", " ", s).strip()
    return s


def normalize_room_code(s: Any) -> str:
    """
    Accept: 'P02', 'P2', '02', '2' -> 'P02'. Return '' if invalid.
    """
    if s is None:
        return ""
    t = str(s).strip()
    if not t:
        return ""
    m = re.search(r"p\s*0*(\d{1,3})", t, re.IGNORECASE)
    if not m:
        m2 = re.search(r"(^|\D)\s*0*(\d{1,3})\s*($|\D)", t)
        if not m2:
            return ""
        n = m2.group(2)
    else:
        n = m.group(1)
    try:
        k = int(n)
    except Exception:
        return ""
    if k <= 0:
        return ""
    return f"P{k:02d}"


def _iter_dates_inclusive(d_from: str, d_to: str) -> List[str]:
    start = datetime.strptime(d_from, "%d/%m/%Y").date()
    end = datetime.strptime(d_to, "%d/%m/%Y").date()
    if end < start:
        start, end = end, start
    out: List[str] = []
    cur = start
    while cur <= end:
        out.append(cur.strftime("%d/%m/%Y"))
        cur += timedelta(days=1)
    return out


def _build_detail_date_plan(d_from: str, d_to: str) -> Dict[str, Any]:
    """
    Lập kế hoạch ngày cho task_details.

    Quy ước mới:
    - date_from → date_to là khoảng NGÀY LÀM VIỆC, bao gồm cả ngày cuối.
    - Worker tự mở hồ sơ tới sáng ngày kế tiếp của date_to để lấy các mốc
      00:00-06:59, rồi gán các mốc đó về ngày làm việc cuối.

    Nhờ vậy khi chọn 29/04 → 03/05, dữ liệu và lịch vẫn có đủ 29/04, 30/04,
    01/05, 02/05, 03/05; không còn bị rơi ngày 03/05 thành 02/05.
    """
    work_dates = _iter_dates_inclusive(d_from, d_to)
    if not work_dates:
        return {
            "work_dates": [],
            "timeline_dates": [],
            "fetch_until_date": d_to,
            "bridge_end_date": None,
        }

    final_work_date = work_dates[-1]
    bridge_end_date = add_days_dmy(final_work_date, 1) or None
    timeline_dates = list(work_dates)
    if bridge_end_date and bridge_end_date not in timeline_dates:
        timeline_dates.append(bridge_end_date)

    return {
        "work_dates": work_dates,
        "timeline_dates": timeline_dates,
        "fetch_until_date": bridge_end_date or final_work_date,
        "bridge_end_date": bridge_end_date,
    }



def _compact_detail_input_records(data: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Giữ field cần dùng ở dạng canonical để tránh lặp alias trong runtime."""
    compacted: List[Dict[str, Any]] = []
    for row in data:
        if not isinstance(row, dict):
            continue
        compacted.append(_canonical_patient_row_for_runtime(row, include_order_text=False))
    return compacted

def _norm_text_no_accent(raw: Any) -> str:
    """Chuẩn hoá nhẹ để dò các cụm như 'ra viện' dù có/không dấu."""
    try:
        import unicodedata
        text = str(raw or "").strip().lower().replace("đ", "d")
        text = unicodedata.normalize("NFD", text)
        text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
        return re.sub(r"\s+", " ", text)
    except Exception:
        return str(raw or "").strip().lower()


def _is_discharge_disposition_text(value: Any) -> bool:
    norm = _norm_text_no_accent(value)
    return bool(re.search(r"\b(?:ra|xuat)\s*vien\b", norm))


def _is_status_like_value(value: Any) -> bool:
    norm = _norm_text_no_accent(value)
    return norm in {"dang thuc hien", "hoan tat", "di mo", "dang di mo", "khong thuc hien"}


def _has_discharge_disposition(row: Dict[str, Any]) -> bool:
    raw = " ".join(str(row.get(k) or "") for k in ("Xử trí", "xu_tri", "XuTri", "xử trí"))
    return _is_discharge_disposition_text(raw)


def _normalize_discharge_datetime(raw: Any, default_year: Optional[str] = None) -> str:
    """Chuẩn hoá '09:00 25-04-2026' hoặc '09:00 25/04/2026' -> '09:00 25/04/2026'."""
    text = str(raw or "").strip()
    if not text:
        return ""
    text = re.sub(r"\s+", " ", text)
    patterns = [
        r"(\d{1,2}):(\d{2})\s+(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})",
        r"(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})\s+(\d{1,2}):(\d{2})",
    ]
    m = re.search(patterns[0], text)
    if m:
        hh, mi, dd, mo, yy = m.groups()
    else:
        m = re.search(patterns[1], text)
        if not m:
            return text
        dd, mo, yy, hh, mi = m.groups()
    yy = yy.strip()
    if len(yy) == 2:
        yy = f"20{yy}"
    if len(yy) != 4 and default_year:
        yy = str(default_year)
    return f"{int(hh):02d}:{int(mi):02d} {int(dd):02d}/{int(mo):02d}/{yy}"


def _date_part_from_discharge_datetime(raw: Any) -> str:
    s = str(raw or "")
    m = re.search(r"(\d{1,2})/(\d{1,2})/(\d{4})", s)
    if not m:
        return ""
    return f"{int(m.group(1)):02d}/{int(m.group(2)):02d}/{m.group(3)}"


def _time_part_from_discharge_datetime(raw: Any) -> str:
    s = str(raw or "")
    m = re.search(r"(\d{1,2}):(\d{2})", s)
    if not m:
        return ""
    return f"{int(m.group(1)):02d}:{int(m.group(2)):02d}"


def _extract_discharge_datetime_from_html(html: str, default_year: Optional[str] = None) -> str:
    """Đọc label id='lblNgayRaVien' trên trang con mắt điều dưỡng."""
    if not html:
        return ""
    try:
        soup = BeautifulSoup(html or "", "html.parser") if BeautifulSoup else None
        if soup:
            el = soup.find(id="lblNgayRaVien")
            if el:
                val = el.get_text(" ", strip=True)
                norm = _normalize_discharge_datetime(val, default_year=default_year)
                if norm:
                    return norm
            # fallback: tìm dòng có chữ Ngày ra viện rồi lấy label gần đó
            txt = soup.get_text("\n", strip=True)
        else:
            txt = html
    except Exception:
        txt = html

    m = re.search(r"Ngày\s+ra\s+viện\s*(\d{1,2}:\d{2}\s+\d{1,2}[-/]\d{1,2}[-/]\d{2,4})", txt, flags=re.IGNORECASE)
    if m:
        return _normalize_discharge_datetime(m.group(1), default_year=default_year)
    m = re.search(r"(\d{1,2}:\d{2}\s+\d{1,2}[-/]\d{1,2}[-/]\d{2,4})", txt)
    if m and "ra viện" in txt.lower():
        return _normalize_discharge_datetime(m.group(1), default_year=default_year)
    return ""


def _attach_discharge_info(row: Dict[str, Any], html: str, date_to_full: str, default_year: Optional[str] = None) -> None:
    """Nếu cột Xử trí có ra viện thì đọc ngày ra viện trên trang ĐD và gắn vào row."""
    if not isinstance(row, dict) or not _has_discharge_disposition(row):
        return
    raw_xu_tri = row.get("Xử trí") or row.get("xu_tri") or ""
    row["xu_tri"] = str(raw_xu_tri or "").strip()
    discharge_dt = _extract_discharge_datetime_from_html(html, default_year=default_year)
    if discharge_dt:
        row["ngay_ra_vien"] = discharge_dt
        row["gio_ra_vien"] = _time_part_from_discharge_datetime(discharge_dt)
        row["ngay_ra_vien_date"] = _date_part_from_discharge_datetime(discharge_dt)
        row["ra_vien_hom_nay"] = bool(row["ngay_ra_vien_date"] and row["ngay_ra_vien_date"] == date_to_full)
        print(f"LOG: BN {row.get('Mã BN') or row.get('Mã YT') or row.get('ma_bn') or ''} có xử trí ra viện | Ngày ra viện: {discharge_dt} | hôm nay={row['ra_vien_hom_nay']}")
    else:
        row["ra_vien_hom_nay"] = False
        print(f"LOG: Có xử trí ra viện nhưng chưa đọc được lblNgayRaVien cho BN {row.get('Mã BN') or row.get('Mã YT') or row.get('ma_bn') or ''}")


def _attach_ward_admission_history(row: Dict[str, Any], html: str) -> List[Dict[str, Any]]:
    """Gắn lịch sử các khoa điều trị đọc từ header tab Y lệnh vào row.

    Header mẫu trong EMR: "Khoa điều trị thứ 3: ... (Ngày vào: HH:MM dd/mm/yyyy - Chẩn đoán: ...)".
    Đây là nguồn đầy đủ hơn danh sách nội trú vì một người bệnh có thể qua nhiều khoa.
    """
    if not isinstance(row, dict):
        return []
    try:
        history = extract_ward_admissions_from_html(html)
    except Exception as exc:
        print(f"LOG: Không đọc được lịch sử khoa điều trị từ HTML Y lệnh: {exc}")
        return []
    if not history:
        return []

    row["lich_su_khoa_dieu_tri"] = history
    row["khoa_dieu_tri_history"] = history
    row["ward_admissions"] = history

    def current_key(item: Dict[str, Any]) -> Tuple[int, str]:
        n = item.get("thu_tu")
        try:
            order_no = int(n)
        except Exception:
            order_no = -1
        return (order_no, str(item.get("thoi_gian_vao_khoa") or ""))

    current = max(history, key=current_key)
    admission_time = str(current.get("thoi_gian_vao_khoa") or "").strip()
    department_name = str(current.get("ten_khoa_dieu_tri") or current.get("khoa_dieu_tri") or "").strip()
    diagnosis = str(current.get("chan_doan") or "").strip()

    if admission_time:
        row["tg_vao"] = admission_time
        row["thoi_gian_vao"] = admission_time
        row["thoi_gian_vao_khoa"] = admission_time
        row["T/G vào"] = admission_time
    if department_name:
        row["khoa_chuyen_den"] = department_name
        row["khoa_dieu_tri"] = department_name
        row["ten_khoa_dieu_tri"] = department_name
        row["Khoa chuyển đến"] = department_name
    if diagnosis and not _is_useful_admin_value(row.get("chan_doan")) and not _is_useful_admin_value(row.get("Chẩn đoán")):
        row["chan_doan"] = diagnosis

    ma_bn = row.get("Mã BN") or row.get("Mã YT") or row.get("ma_bn") or ""
    print(f"LOG: BN {ma_bn} có {len(history)} mốc khoa điều trị; hiện tại: {admission_time} | {department_name}")
    return history


# ── Cập nhật thông tin hành chính khi quét/lấy y lệnh ───────────────────────
ADMIN_FIELD_ALIASES: Dict[str, List[str]] = {
    "tg_vao": [
        "T/G vào", "TG vào", "Tg vào", "Thời gian vào", "Thời gian vào khoa",
        "Ngày giờ vào khoa", "Ngày vào khoa", "Giờ vào khoa", "Vào khoa",
        "tg_vao", "thoi_gian_vao", "thoi_gian_vao_khoa",
    ],
    # Field chuẩn mới: mốc ngày giờ người bệnh vào/nhận tại khoa điều trị.
    # Vẫn đồng bộ với tg_vao để không phá các rule cũ đang đọc tg_vao.
    "thoi_gian_vao_khoa": [
        "Thời gian vào khoa", "Ngày giờ vào khoa", "T/G vào", "TG vào", "Tg vào",
        "Ngày vào khoa", "Giờ vào khoa", "Vào khoa", "txtThoiGianVaoKhoa",
        "tg_vao", "thoi_gian_vao", "thoi_gian_vao_khoa", "admission_time",
    ],
    "khoa_chuyen_den": [
        "Khoa chuyển đến", "Khoa chuyển", "Khoa đến", "Khoa nhận", "Khoa điều trị",
        "Tên khoa điều trị", "Khoa hiện tại", "Đơn vị điều trị",
        "khoa_chuyen_den", "khoa_den", "khoa_nhan", "khoa_dieu_tri", "ten_khoa_dieu_tri",
    ],
    # Field chuẩn mới: tên khoa điều trị hiện tại/đích đến khi lấy dữ liệu.
    "ten_khoa_dieu_tri": [
        "Tên khoa điều trị", "Khoa điều trị", "Khoa hiện tại", "Khoa đang điều trị",
        "Đơn vị điều trị", "Khoa nhận", "Khoa chuyển đến", "cbbKhoa", "cboKhoa",
        "ten_khoa_dieu_tri", "khoa_dieu_tri", "department", "ward_name",
    ],
    "xu_tri": [
        "Xử trí", "Hướng xử trí", "Tình trạng xử trí", "Xử trí ra viện",
        "xu_tri", "XuTri", "huong_xu_tri", "disposition",
    ],
    "trang_thai": [
        "Trạng thái", "Trạng thái NB", "Tình trạng", "Tình trạng người bệnh",
        "trang_thai", "TrangThai", "status", "tinh_trang",
    ],
    "ngay_ra_vien": [
        "T/G ra", "TG ra", "Tg ra", "Thời gian ra", "Thời gian ra viện",
        "Ngày giờ ra viện", "Ngày ra viện", "Ngày ra", "Giờ ra viện",
        "ngay_ra_vien", "ngay_ra", "discharge_time", "discharge_date", "raw_discharge_time",
    ],
}


def _compact_spaces(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _is_useful_admin_value(value: Any) -> bool:
    s = _compact_spaces(value)
    if not s:
        return False
    low = _norm_text_no_accent(s)
    return low not in {"-", "--", "none", "null", "undefined", "chon", "lua chon"}


def _is_admin_label_text(value: Any) -> bool:
    norm = _norm_text_no_accent(value)
    if not norm:
        return False
    return norm in {_norm_text_no_accent(alias) for aliases in ADMIN_FIELD_ALIASES.values() for alias in aliases}


def _get_first_admin_value(row: Dict[str, Any], aliases: List[str]) -> str:
    for key in aliases:
        if key in row and _is_useful_admin_value(row.get(key)):
            return _compact_spaces(row.get(key))
    alias_norms = {_norm_text_no_accent(a) for a in aliases}
    for key, value in row.items():
        if _norm_text_no_accent(key) in alias_norms and _is_useful_admin_value(value):
            return _compact_spaces(value)
    return ""




def _first_value_by_keys(row: Dict[str, Any], keys: List[str]) -> str:
    for key in keys:
        if key in row and _is_useful_admin_value(row.get(key)):
            return _compact_spaces(row.get(key))
    return ""


def _canonical_patient_row_for_runtime(row: Dict[str, Any], *, include_order_text: bool = False) -> Dict[str, Any]:
    """Trả về bản ghi runtime gọn, chỉ giữ một tên field chuẩn cho mỗi dữ liệu.

    Parser vẫn đọc được nhiều alias từ EMR, nhưng file JSON runtime không nên lưu
    hàng chục alias như ``TG vào``, ``Tg vào``, ``Thời gian vào``... cùng một giá trị.
    """
    if not isinstance(row, dict):
        return {}
    out: Dict[str, Any] = {}

    def put(name: str, value: Any) -> None:
        if _is_useful_admin_value(value):
            out[name] = _compact_spaces(value)

    put("ma_bn", _first_value_by_keys(row, ["ma_bn", "Mã BN", "Mã YT", "ma_yt", "MaBN", "Ma_BN", "mabn", "id"]))
    put("ma_yt", _first_value_by_keys(row, ["ma_yt", "Mã YT", "MaYT", "Ma_YT"]))
    put("ho_ten", _first_value_by_keys(row, ["ho_ten", "Họ tên", "Tên bệnh nhân", "name", "Ten_BN", "ten_bn"]))
    put("tuoi", _first_value_by_keys(row, ["tuoi", "Tuổi", "age"]))
    put("gioi_tinh", _first_value_by_keys(row, ["gioi_tinh", "Giới tính", "GT", "sex"]))
    put("doi_tuong", _first_value_by_keys(row, ["doi_tuong", "Đối tượng", "object_type"]))
    put("bac_si", _first_value_by_keys(row, ["bac_si", "Bác sĩ", "doctor"]))
    put("chan_doan", _first_value_by_keys(row, ["chan_doan", "Chẩn đoán", "diagnosis"]))
    tg_vao_khoa = _get_first_admin_value(row, ADMIN_FIELD_ALIASES["thoi_gian_vao_khoa"]) or _get_first_admin_value(row, ADMIN_FIELD_ALIASES["tg_vao"])
    ten_khoa = _get_first_admin_value(row, ADMIN_FIELD_ALIASES["ten_khoa_dieu_tri"]) or _get_first_admin_value(row, ADMIN_FIELD_ALIASES["khoa_chuyen_den"])
    put("tg_vao", tg_vao_khoa)
    put("thoi_gian_vao_khoa", tg_vao_khoa)
    put("khoa_chuyen_den", ten_khoa)
    put("khoa_dieu_tri", ten_khoa)
    put("ten_khoa_dieu_tri", ten_khoa)
    ward_history = row.get("lich_su_khoa_dieu_tri") or row.get("khoa_dieu_tri_history") or row.get("ward_admissions")
    if isinstance(ward_history, list) and ward_history:
        out["lich_su_khoa_dieu_tri"] = ward_history
    put("xu_tri", _get_first_admin_value(row, ADMIN_FIELD_ALIASES["xu_tri"]))
    put("trang_thai", _get_first_admin_value(row, ADMIN_FIELD_ALIASES.get("trang_thai", [])))
    ngay_ra_vien = _get_first_admin_value(row, ADMIN_FIELD_ALIASES.get("ngay_ra_vien", []))
    put("ngay_ra_vien", ngay_ra_vien)
    put("ngay_ra_vien_date", _date_part_from_discharge_datetime(ngay_ra_vien))
    put("Vi_Tri", _first_value_by_keys(row, ["Vi_Tri", "phong_giuong", "so_phong", "room"]))

    # Các cờ/trạng thái nghiệp vụ cần giữ lại.
    for key in [
        "surgery_out", "surgery_out_time", "surgery_out_reason",
        "ngay_ra_vien", "gio_ra_vien", "ngay_ra_vien_date", "ra_vien_hom_nay",
        "ngay_tu", "ngay_den", "ngay_lam", "source_date", "bridge_source_date", "bridge_work_date",
    ]:
        if key in row and row.get(key) not in (None, "", [], {}):
            out[key] = row.get(key)

    if include_order_text:
        for key in ["Y lệnh", "Diễn biến", "source_segments"]:
            if key in row and row.get(key) not in (None, "", [], {}):
                out[key] = row.get(key)

    return out


def _canonicalize_rows_for_runtime(rows: List[Dict[str, Any]], *, include_order_text: bool = False) -> List[Dict[str, Any]]:
    return [_canonical_patient_row_for_runtime(r, include_order_text=include_order_text) for r in (rows or []) if isinstance(r, dict)]

def _normalize_admin_fields(row: Dict[str, Any], *, overwrite: bool = False) -> Dict[str, Any]:
    """Chuẩn hoá field hành chính sang key ổn định, không bơm alias vào runtime.

    Trước đây hàm này ghi cùng một giá trị vào nhiều key như ``TG vào``,
    ``Tg vào``, ``Thời gian vào khoa``... để tương thích. Cách đó làm file
    runtime phình và khó đọc. Bây giờ chỉ ghi các key chuẩn: ``tg_vao``,
    ``thoi_gian_vao_khoa``, ``khoa_chuyen_den``, ``khoa_dieu_tri``,
    ``ten_khoa_dieu_tri``, ``xu_tri``, ``trang_thai``. Các alias chỉ dùng để đọc.
    """
    if not isinstance(row, dict):
        return row

    tg_vao_khoa = _get_first_admin_value(row, ADMIN_FIELD_ALIASES["thoi_gian_vao_khoa"]) or _get_first_admin_value(row, ADMIN_FIELD_ALIASES["tg_vao"])
    ten_khoa = _get_first_admin_value(row, ADMIN_FIELD_ALIASES["ten_khoa_dieu_tri"]) or _get_first_admin_value(row, ADMIN_FIELD_ALIASES["khoa_chuyen_den"])
    values = {
        "tg_vao": tg_vao_khoa,
        "thoi_gian_vao_khoa": tg_vao_khoa,
        "khoa_chuyen_den": ten_khoa,
        "khoa_dieu_tri": ten_khoa,
        "ten_khoa_dieu_tri": ten_khoa,
        "xu_tri": _get_first_admin_value(row, ADMIN_FIELD_ALIASES["xu_tri"]),
        "trang_thai": _get_first_admin_value(row, ADMIN_FIELD_ALIASES.get("trang_thai", [])),
    }
    for key, value in values.items():
        if value and (overwrite or not _is_useful_admin_value(row.get(key))):
            row[key] = value
    ward_history = row.get("lich_su_khoa_dieu_tri") or row.get("khoa_dieu_tri_history") or row.get("ward_admissions")
    if isinstance(ward_history, list) and ward_history:
        row["lich_su_khoa_dieu_tri"] = ward_history
    return row

def _selected_option_text(select_el: Any) -> str:
    """Lấy text option đang chọn, tránh tự lấy option đầu tiên/placeholder khi HTML không render selected."""
    if not select_el:
        return ""

    def usable_option_text(opt: Any) -> str:
        if not opt:
            return ""
        text = _compact_spaces(opt.get_text(" ", strip=True))
        low = _norm_text_no_accent(text)
        value_low = _norm_text_no_accent(opt.get("value") or "")
        if low in {"khac", "tat ca", "chon khoa", "chon xu tri", "chon trang thai"}:
            return ""
        if value_low in {"", "-1", "0", "khac", "chon", "lua chon"} and low in {"", "khac", "chon", "lua chon"}:
            return ""
        return text if _is_useful_admin_value(text) else ""

    # Nguồn đúng nhất là option có selected. Không fallback bừa sang option đầu tiên vì thường là "Khác"/"Chọn".
    for opt in select_el.find_all("option"):
        if opt.has_attr("selected"):
            val = usable_option_text(opt)
            if val:
                return val

    # Một số trang render value ở chính select thay vì selected option.
    selected_value = str(select_el.get("value") or "").strip()
    if selected_value:
        for opt in select_el.find_all("option"):
            if str(opt.get("value") or "").strip() == selected_value:
                val = usable_option_text(opt)
                if val:
                    return val

    return ""

def _text_from_nearby_label(soup: Any, labels: List[str]) -> str:
    if not soup:
        return ""
    label_norms = [_norm_text_no_accent(x) for x in labels]

    # Ưu tiên id/name hay gặp trong trang chi tiết.
    tokens = []
    joined = " ".join(label_norms)
    if "vao" in joined:
        tokens += ["tgvao", "tgvaokhoa", "thoigianvao", "thoigianvaokhoa", "ngayvaokhoa", "txtthoigianvaokhoa"]
    if "khoa" in joined:
        tokens += ["khoachuyenden", "khoachuyen", "khoaden", "khoanhan", "khoadieutri", "tenkhoadieutri", "khoahientai", "donvidieutri", "txtkhoadieutri", "cbbkhoa", "cbokhoa"]
    if "xu tri" in joined or "xutri" in joined:
        tokens += ["xutri", "huongxutri"]
    if "trang thai" in joined or "tinh trang" in joined or "status" in joined:
        tokens += ["trangthai", "tinhtrang", "status"]

    for el in soup.find_all(True):
        ident = _norm_text_no_accent(" ".join([el.get("id") or "", el.get("name") or "", " ".join(el.get("class") or [])]))
        ident = re.sub(r"[^a-z0-9]+", "", ident)
        if tokens and any(tok in ident for tok in tokens):
            if el.name in {"input", "textarea"}:
                val = el.get("value") or ""
            elif el.name == "select":
                val = _selected_option_text(el)
            else:
                val = el.get("title") or el.get_text(" ", strip=True)
            if _is_useful_admin_value(val):
                return _compact_spaces(val)

    for el in soup.find_all(True):
        txt = _compact_spaces(el.get_text(" ", strip=True))
        if not txt or len(txt) > 120:
            continue
        norm = _norm_text_no_accent(txt)
        if _is_admin_label_text(txt):
            continue
        matched = ""
        for label, label_norm in zip(labels, label_norms):
            if norm == label_norm or norm.startswith(label_norm + ":") or label_norm in norm:
                matched = label
                break
        if not matched:
            continue

        # Nếu node chứa select thì chỉ tin option đang chọn; không gom toàn bộ text option.
        child_select = el.find("select") if hasattr(el, "find") else None
        if child_select is not None:
            val = _selected_option_text(child_select)
            if val:
                return _compact_spaces(val)
            continue

        # Nếu chính node chứa cả nhãn và value.
        val = re.sub(r"^" + re.escape(matched) + r"\s*[:：-]?\s*", "", txt, flags=re.IGNORECASE).strip()
        if _is_useful_admin_value(val) and not _is_admin_label_text(val) and _norm_text_no_accent(val) != _norm_text_no_accent(matched):
            return _compact_spaces(val)

        # Nếu value nằm trong parent nhỏ.
        for parent_name in ("div", "td", "tr", "li"):
            parent = el.find_parent(parent_name)
            if not parent:
                continue
            parent_select = parent.find("select") if hasattr(parent, "find") else None
            if parent_select is not None:
                val = _selected_option_text(parent_select)
                if val:
                    return _compact_spaces(val)
                continue
            ptxt = _compact_spaces(parent.get_text(" ", strip=True))
            if not ptxt or len(ptxt) > 260:
                continue
            val = re.sub(r"^.*?" + re.escape(matched) + r"\s*[:：-]?\s*", "", ptxt, flags=re.IGNORECASE).strip()
            if _is_useful_admin_value(val) and not _is_admin_label_text(val) and _norm_text_no_accent(val) != _norm_text_no_accent(matched):
                return _compact_spaces(val)

        # Hoặc sibling kế bên.
        sib = el.find_next_sibling()
        checks = 0
        while sib is not None and checks < 4:
            checks += 1
            try:
                if getattr(sib, "name", "") in {"input", "textarea"}:
                    val = sib.get("value") or ""
                elif getattr(sib, "name", "") == "select":
                    val = _selected_option_text(sib)
                else:
                    val = sib.get_text(" ", strip=True)
            except Exception:
                val = ""
            if _is_useful_admin_value(val):
                return _compact_spaces(val)
            sib = sib.find_next_sibling()

    return ""


def _regex_extract_admin_fields(page_text: str) -> Dict[str, str]:
    out: Dict[str, str] = {}
    text = re.sub(r"[ \t]+", " ", str(page_text or ""))
    specs = {
        "tg_vao": [
            r"(?:T/G|TG|Thời\s+gian|Ngày\s+giờ|Ngày|Giờ)\s+vào(?:\s+khoa)?\s*[:：-]?\s*([^\n\r]{3,80})",
            r"Vào\s+khoa\s*[:：-]?\s*([^\n\r]{3,80})",
        ],
        "khoa_chuyen_den": [
            r"Khoa\s+chuyển\s+đến\s*[:：-]?\s*([^\n\r]{3,120})",
            r"Khoa\s+nhận\s*[:：-]?\s*([^\n\r]{3,120})",
            r"Khoa\s+điều\s+trị\s*[:：-]?\s*([^\n\r]{3,120})",
            r"Tên\s+khoa\s+điều\s+trị\s*[:：-]?\s*([^\n\r]{3,120})",
        ],
        "ten_khoa_dieu_tri": [
            r"Tên\s+khoa\s+điều\s+trị\s*[:：-]?\s*([^\n\r]{3,120})",
            r"Khoa\s+điều\s+trị\s*[:：-]?\s*([^\n\r]{3,120})",
            r"Khoa\s+hiện\s+tại\s*[:：-]?\s*([^\n\r]{3,120})",
            r"Đơn\s+vị\s+điều\s+trị\s*[:：-]?\s*([^\n\r]{3,120})",
        ],
        "xu_tri": [
            r"(?:Hướng\s+)?Xử\s+trí(?:\s+ra\s+viện)?\s*[:：-]?\s*([^\n\r]{2,120})",
        ],
        "trang_thai": [
            r"(?:Trạng\s+thái|Tình\s+trạng)(?:\s+người\s+bệnh|\s+NB)?\s*[:：-]?\s*([^\n\r]{2,80})",
        ],
    }
    for key, patterns in specs.items():
        for pat in patterns:
            m = re.search(pat, text, flags=re.IGNORECASE)
            if not m:
                continue
            val = _compact_spaces(m.group(1))
            val = re.split(r"\b(?:Khoa chuyển đến|Khoa nhận|Khoa điều trị|Tên khoa điều trị|Khoa hiện tại|Đơn vị điều trị|Xử trí|Trạng thái|Tình trạng|Chẩn đoán|T/G vào|Thời gian vào|Thời gian vào khoa)\b", val, maxsplit=1, flags=re.IGNORECASE)[0].strip()
            if _is_admin_label_text(val):
                continue
            if _is_useful_admin_value(val):
                out[key] = val
                break
    return out


def _extract_patient_admin_info_from_html(html: str) -> Dict[str, str]:
    info: Dict[str, str] = {}
    if not html:
        return info
    try:
        soup = BeautifulSoup(html or "", "html.parser") if BeautifulSoup else None
    except Exception:
        soup = None

    if soup:
        for key, aliases in ADMIN_FIELD_ALIASES.items():
            val = _text_from_nearby_label(soup, aliases)
            if _is_useful_admin_value(val):
                info[key] = val
        regex_soup = BeautifulSoup(str(soup), "html.parser") if BeautifulSoup else soup
        try:
            for opt in regex_soup.find_all("option"):
                opt.decompose()
        except Exception:
            pass
        page_text = regex_soup.get_text("\n", strip=True)
    else:
        page_text = html

    for key, val in _regex_extract_admin_fields(page_text).items():
        info.setdefault(key, val)
    return _normalize_admin_fields(info)




def _merge_admin_from_list_row(row: Dict[str, Any], list_row: Dict[str, Any]) -> Dict[str, Any]:
    """Gộp lại thông tin hành chính từ dòng danh sách nội trú.

    Dòng danh sách là nguồn đúng nhất cho cột Xử trí (ví dụ: "Ra viện Đỡ giảm").
    Trang chi tiết đôi khi chỉ hiện trạng thái hiện tại, nên không được để mất giá trị này.
    """
    if not isinstance(row, dict) or not isinstance(list_row, dict):
        return row
    src = dict(list_row)
    _normalize_admin_fields(src, overwrite=False)

    # Chỉ cập nhật các trường hành chính ổn định; không đụng Y lệnh/Diễn biến.
    for key in ("tg_vao", "thoi_gian_vao_khoa", "khoa_chuyen_den", "khoa_dieu_tri", "ten_khoa_dieu_tri"):
        val = src.get(key)
        if _is_useful_admin_value(val):
            row[key] = _compact_spaces(val)

    xu_tri = src.get("xu_tri") or src.get("Xử trí") or src.get("XuTri") or src.get("Hướng xử trí")
    trang_thai = src.get("trang_thai") or src.get("Trạng thái") or src.get("TrangThai") or src.get("status")

    # Nếu danh sách nội trú hiện tại nói BN đang thực hiện và cột Xử trí không còn ra viện,
    # phải xoá mốc ra viện cũ từ lần quét trước. Nếu không, cập nhật Y lệnh riêng BN sẽ
    # tiếp tục giữ "Xuất viện" dù HIS đã đổi lại không ra viện.
    if _is_discharge_disposition_text(row.get("xu_tri") or row.get("Xử trí") or ""):
        current_active = _norm_text_no_accent(trang_thai) in {"dang thuc hien", "dang dieu tri", "dang nam vien"}
        current_not_discharge = not _is_discharge_disposition_text(xu_tri)
        if current_active and current_not_discharge:
            _clear_discharge_fields(row, reason="danh sách nội trú hiện tại không còn xử trí ra viện")

    if _is_useful_admin_value(xu_tri):
        old = row.get("xu_tri") or row.get("Xử trí") or ""
        # Nếu danh sách có ra viện thì luôn ưu tiên danh sách.
        # Nếu không phải ra viện thì vẫn cho cập nhật khi giá trị cũ rỗng/giống trạng thái.
        if _is_discharge_disposition_text(xu_tri) or not _is_useful_admin_value(old) or _is_status_like_value(old):
            row["xu_tri"] = _compact_spaces(xu_tri)
            # Giữ alias này trong bộ nhớ để tương thích một số test/đoạn cũ;
            # khi ghi file runtime sẽ được canonicalize và bỏ alias.
            row["Xử trí"] = _compact_spaces(xu_tri)

    if _is_useful_admin_value(trang_thai):
        row["trang_thai"] = _compact_spaces(trang_thai)
        row["Trạng thái"] = _compact_spaces(trang_thai)
    return _normalize_admin_fields(row, overwrite=False)


def _extract_list_row_for_patient_from_html(html: str, ma_bn: Any) -> Dict[str, Any]:
    """Lấy một dòng trong tblNoiTru theo mã BN từ HTML danh sách."""
    if not html or BeautifulSoup is None:
        return {}
    code = str(ma_bn or "").strip()
    if not code:
        return {}
    try:
        soup = BeautifulSoup(html or "", "html.parser")
        table = soup.find("table", id="tblNoiTru")
        if not table:
            return {}
        headers = [_compact_spaces(th.get_text(" ", strip=True)) for th in table.find_all("th")]
        body = table.find("tbody")
        rows = body.find_all("tr") if body else table.find_all("tr")[1:]
        for tr in rows:
            cols = tr.find_all("td")
            if not cols:
                continue
            texts = [_compact_spaces(td.get_text(" ", strip=True)) for td in cols]
            # Ưu tiên đúng ô mã BN; fallback kiểm tra toàn dòng.
            matched = False
            for idx, h in enumerate(headers):
                if idx < len(texts) and _norm_text_no_accent(h) in {"ma bn", "ma yt"} and texts[idx] == code:
                    matched = True
                    break
            if not matched and code not in " ".join(texts):
                continue
            out: Dict[str, Any] = {}
            for idx, val in enumerate(texts):
                if idx < len(headers) and headers[idx]:
                    out[headers[idx]] = val
            return _normalize_admin_fields(out, overwrite=False)
    except Exception:
        return {}
    return {}

def _merge_patient_admin_info(row: Dict[str, Any], html: str, *, overwrite: bool = True) -> Dict[str, Any]:
    if not isinstance(row, dict):
        return row
    _normalize_admin_fields(row, overwrite=False)
    info = _extract_patient_admin_info_from_html(html)
    for key, val in info.items():
        if _is_useful_admin_value(val):
            if key in {"tg_vao", "thoi_gian_vao_khoa"}:
                row["tg_vao"] = val
                row["thoi_gian_vao"] = val
                row["thoi_gian_vao_khoa"] = val
                row["T/G vào"] = val
            elif key in {"khoa_chuyen_den", "ten_khoa_dieu_tri"}:
                row["khoa_chuyen_den"] = val
                row["khoa_dieu_tri"] = val
                row["ten_khoa_dieu_tri"] = val
                row["Khoa chuyển đến"] = val
            elif key == "xu_tri":
                # Trang chi tiết đôi khi trả về trạng thái hiện tại (ví dụ "Đang thực hiện")
                # vào field gần nhãn Xử trí, làm mất giá trị từ danh sách như "Ra viện Đỡ giảm".
                # Nếu giá trị cũ đã có ra viện, hoặc giá trị mới chỉ giống trạng thái, thì giữ Xử trí cũ.
                old_xu_tri = row.get("Xử trí") or row.get("xu_tri") or ""
                old_status = row.get("Trạng thái") or row.get("trang_thai") or row.get("status") or ""
                if _is_discharge_disposition_text(old_xu_tri) and not _is_discharge_disposition_text(val):
                    continue
                if old_xu_tri and _norm_text_no_accent(old_xu_tri) != _norm_text_no_accent(old_status) and _is_status_like_value(val):
                    continue
                row["xu_tri"] = val
                row["Xử trí"] = val
            elif key == "trang_thai":
                row["trang_thai"] = val
                row["Trạng thái"] = val
    return _normalize_admin_fields(row, overwrite=overwrite)


class AutoWorker:
    def __init__(self):
        self.base_dir = os.path.dirname(os.path.abspath(__file__))
        self.config = load_config() # Gọi thẳng hàm từ utils
        self.driver = None
        self.wait = None


    # --- TASK 0: AUTH HTTP COOKIE ---
    def task_auth_http_session(self, headless: Optional[bool] = None):
        """Mở Chrome một lần để đăng nhập EMR và lưu cookie cho các lần quét HTTP/no-Chrome.

        Tác vụ này không quét/nhập dữ liệu. Nó chỉ tạo ``.runtime/auth/emr_http_cookies.json``.
        Sau đó ``scan``/``details`` có thể dùng HTTP-cookie mà không cần mở Chrome.
        """
        is_headless = _cfg_bool(self.config, "auth_cookie_headless", False) if headless is None else bool(headless)
        _ws = WorkerSession(_with_worker_headless(self.config, is_headless), "/dev/null")
        _ws.__enter__()
        driver, wait = _ws.driver, _ws.wait
        try:
            wpid = self.config.get("inpatient_wpid", "danhsachdieutrinoitrudraw")
            nav_url = _build_inpatient_url(driver.current_url, wpid)
            try:
                _safe_driver_get(driver, nav_url, "danh sách nội trú sau auth-cookie")
                time.sleep(1.0)
                # Nếu EMR redirect URL sau khi vào webpart, dùng URL cuối cùng.
                if driver.current_url:
                    nav_url = driver.current_url
            except Exception:
                # Cookie đã có sau login; vẫn lưu để HTTP thử dùng.
                pass

            sess = _get_http_session(self.config)
            if sess is None:
                raise RuntimeError("Không khởi tạo được HTTP session để lưu cookie.")
            try:
                sess._session_inpatient_url = nav_url  # giữ URL có usid/st mới sau Selenium login
            except Exception:
                pass
            n = sess.import_selenium_cookies(driver.get_cookies())
            if n <= 0:
                raise RuntimeError("Chrome đã đăng nhập nhưng không đọc được cookie nào từ trình duyệt.")
            cookie_path = sess.save_cookies(inpatient_list_url=nav_url)
            try:
                if not sess.verify_logged_in():
                    raise RuntimeError("Cookie đã lưu nhưng HTTP vẫn bị trả về trang login.")
            except Exception as exc:
                raise RuntimeError(f"Đã lấy cookie nhưng kiểm tra HTTP chưa thành công: {exc}")
            print(f"SUCCESS: Đã lưu phiên HTTP-cookie cho chế độ no-Chrome: {cookie_path}")
        finally:
            try:
                _ws.__exit__(None, None, None)
            except Exception:
                pass

    # --- TASK 1: SCAN LIST ---
    def task_scan(self, out_path: str = "data_raw.json", status_name: str = "", date_from: str = "", date_to: str = ""):
        if BeautifulSoup is None:
            raise RuntimeError("Thiếu thư viện bs4. Hãy cài: pip install beautifulsoup4")

        # --- READ MODE: lấy dữ liệu bằng Selenium headless, không hiện Chrome ---
        read_mode = _read_mode(self.config)
        allow_selenium_fallback = _allow_selenium_read_fallback(self.config)

        status_filter = str(status_name or "").strip()
        # Khi cần quét một trạng thái cụ thể (ví dụ Hoàn tất), phải dùng Selenium
        # để đổi combobox trạng thái trên màn hình danh sách trước khi đọc bảng.
        use_http_scan = _http_read_enabled(self.config) and not status_filter

        if use_http_scan:
            try:
                sess = _get_http_session(self.config)
                if sess is None:
                    raise RuntimeError("HTTP session không khả dụng")
                sess.login()
                all_data, _link_map = sess.scan_all_inpatients()
                all_data = _canonicalize_rows_for_runtime(all_data, include_order_text=False)
                write_json_compact(out_path, all_data)
                print(f"SUCCESS(HTTP/no-Chrome): Quét xong! Đã lưu {len(all_data)} dòng vào {out_path}")
                return
            except Exception as e:
                if not allow_selenium_fallback:
                    _raise_http_only_failure("Scan danh sách BN", e)
                print(f"[HTTP READ] Scan lỗi: {e} -> fallback Selenium vì data_read_mode={read_mode}")
        elif not allow_selenium_fallback and not status_filter:
            _raise_http_only_failure("Scan danh sách BN", "HTTP reader đang tắt")

        is_headless = _read_selenium_headless(self.config)
        print(f"[READ] Lấy dữ liệu bằng Chrome headless (không hiện cửa sổ): headless={is_headless}")
        _ws_scan = WorkerSession(_with_worker_headless(self.config, is_headless), "/dev/null")
        _ws_scan.__enter__()
        self.driver, self.wait = _ws_scan.driver, _ws_scan.wait
        try:

            wpid = self.config.get("inpatient_wpid", "danhsachdieutrinoitrudraw")
            post_login_url = self.driver.current_url
            nav_url = _build_inpatient_url(post_login_url, wpid)
            print(f"[SCAN] Chuyển đến danh sách nội trú: {nav_url}")
            _safe_driver_get(self.driver, nav_url, "danh sách nội trú scan")
            # Chờ bảng tblNoiTru render xong (AJAX) — tối đa 15s
            try:
                self.wait.until(EC.presence_of_element_located((By.ID, "tblNoiTru")))
            except Exception:
                time.sleep(3.0)  # Fallback nếu bảng chưa hiện

            if status_filter and _set_inpatient_status_filter:
                try:
                    print(f"[SCAN] Chọn trạng thái nội trú: {status_filter}")
                    _set_inpatient_status_filter(self.driver, self.wait, status_filter, log_func=print)
                    try:
                        self.wait.until(EC.presence_of_element_located((By.ID, "tblNoiTru")))
                    except Exception:
                        time.sleep(1.0)
                except Exception as exc:
                    print(f"WARN: Không đổi được trạng thái danh sách sang {status_filter}: {exc}")
            elif status_filter:
                print("WARN: Không có helper đổi trạng thái, worker sẽ đọc trạng thái mặc định của EMR.")

            # Với Kiểm hồ sơ, lọc đúng khoảng ngay trên EMR thay vì quét toàn bộ
            # danh sách Hoàn tất rồi mới lọc phía Node. Cách này tránh bỏ sót ca do
            # phân trang AJAX trên danh sách hàng trăm/hàng nghìn dòng.
            requested_from = str(date_from or "").strip()
            requested_to = str(date_to or requested_from).strip()
            if (requested_from or requested_to) and _set_time_range_filter:
                try:
                    before_filter = self.driver.execute_script("""
                        const p=(document.querySelector('.currentPaging')||{}).textContent||'';
                        const t=document.querySelector('#tblNoiTru tbody');
                        return p+'|'+(t?t.innerText.slice(0,500):'');
                    """)
                    _set_time_range_filter(self.driver, self.wait, requested_from, requested_to, log_func=print)
                    # Helper đặt giá trị; bấm Tìm kiếm sau khi cả hai ô ngày đã có dữ liệu.
                    clicked = False
                    try:
                        btns = self.driver.find_elements(By.ID, "btnTimKiem")
                        if btns:
                            self.driver.execute_script("arguments[0].click();", btns[0])
                            clicked = True
                    except Exception:
                        clicked = False
                    if not clicked:
                        try:
                            self.driver.execute_script("if (typeof FilterChange === 'function') { FilterChange(); }")
                        except Exception:
                            pass
                    try:
                        WebDriverWait(self.driver, 20).until(lambda d: d.execute_script("""
                            const p=(document.querySelector('.currentPaging')||{}).textContent||'';
                            const t=document.querySelector('#tblNoiTru tbody');
                            return p+'|'+(t?t.innerText.slice(0,500):'');
                        """) != before_filter)
                    except Exception:
                        time.sleep(2.0)
                    print(f"[SCAN] Đã áp dụng khoảng trực tiếp trên EMR: {requested_from} → {requested_to}")
                except Exception as exc:
                    print(f"WARN: Không áp dụng được khoảng ngày trực tiếp trên EMR: {exc}")

            all_data: List[Dict[str, Any]] = []
            seen_cases = set()
            visited_pages = set()

            while True:
                soup = BeautifulSoup(self.driver.page_source, "html.parser")
                table = soup.find("table", id="tblNoiTru")
                if table:
                    headers = [th.get_text(strip=True) for th in table.find_all("th")]
                    rows = table.find("tbody").find_all("tr") if table.find("tbody") else table.find_all("tr")[1:]

                    for row in rows:
                        cols = row.find_all("td")
                        if len(cols) > 5:
                            r_data: Dict[str, Any] = {}
                            for i, col in enumerate(cols):
                                if i < len(headers):
                                    val = col.get_text(" ", strip=True)
                                    # name column may contain <a>
                                    if ("Tên" in headers[i] or "Họ" in headers[i]) and col.find("a"):
                                        val = col.find("a").get_text(" ", strip=True)
                                    r_data[headers[i]] = val
                            out_row = _canonical_patient_row_for_runtime(r_data, include_order_text=False)

                            # Lưu link hồ sơ ngay từ dòng scan. Tab Kiểm hồ sơ cần xử lý theo từng ca/lượt
                            # Hoàn tất, không chỉ theo mã BN. Các link này chứa noitruid nên worker chi tiết
                            # có thể mở đúng lượt điều trị và không phải tìm lại theo mã BN từng lần.
                            try:
                                base_url = self.driver.current_url or nav_url
                                links = {}
                                for col in cols:
                                    for a in col.find_all("a", href=True):
                                        href = str(a.get("href") or "").strip()
                                        if not href or href.lower().startswith("javascript:"):
                                            continue
                                        full_href = urljoin(base_url, href)
                                        href_l = full_href.lower()
                                        html_l = str(a.decode_contents() or "").lower()
                                        text_l = str(a.get_text(" ", strip=True) or "").strip().lower()
                                        aid_l = str(a.get("id") or "").lower()
                                        if "wpid=dieuduongdraw" in href_l or "fa-eye" in html_l:
                                            links.setdefault("nursing", full_href)
                                        elif aid_l.startswith("btna") or ("wpid=bacsidraw" in href_l and "nextlink=lichsuylenh" in href_l):
                                            links.setdefault("doctor", full_href)
                                if links.get("doctor"):
                                    out_row["record_doctor_url"] = links["doctor"]
                                    out_row["doctor_url"] = links["doctor"]
                                if links.get("nursing"):
                                    out_row["record_nursing_url"] = links["nursing"]
                                    out_row["nursing_url"] = links["nursing"]
                                any_url = links.get("doctor") or links.get("nursing") or ""
                                if any_url:
                                    qs_link = dict(parse_qsl(urlparse(any_url).query, keep_blank_values=True))
                                    if qs_link.get("noitruid"):
                                        out_row["noitruid"] = qs_link.get("noitruid")
                                    if qs_link.get("tiepnhanid"):
                                        out_row["tiepnhanid"] = qs_link.get("tiepnhanid")
                            except Exception as link_exc:
                                out_row["record_link_error"] = str(link_exc)[:160]

                            if status_filter:
                                out_row["inpatient_status"] = status_filter
                                out_row["trang_thai"] = status_filter
                                out_row["Trạng thái"] = status_filter
                            # Không ghi trùng khi AJAX trả lại trang cũ hoặc một ca xuất hiện lặp.
                            case_sig = (
                                str(out_row.get("ma_bn") or "").strip(),
                                str(out_row.get("noitruid") or "").strip(),
                                str(out_row.get("tg_vao") or out_row.get("thoi_gian_vao_khoa") or "").strip(),
                            )
                            if case_sig not in seen_cases:
                                seen_cases.add(case_sig)
                                all_data.append(out_row)

                # Next page: phải chờ số trang hoặc nội dung bảng thật sự đổi.
                try:
                    next_btns = self.driver.find_elements(By.XPATH, "//ul[contains(@class,'pagination')]//a[contains(normalize-space(), '›') or contains(@aria-label,'Next')]")
                    page_info = self.driver.find_element(By.CLASS_NAME, "currentPaging").text
                    m = re.search(r"(\d+)\s*/\s*(\d+)", page_info)
                    if not m or not next_btns:
                        break
                    curr, total = int(m.group(1)), int(m.group(2))
                    if curr in visited_pages:
                        print(f"WARN: Phát hiện lặp trang {curr}/{total}; dừng để không nhân bản dữ liệu.")
                        break
                    visited_pages.add(curr)
                    if curr >= total:
                        break
                    before_sig = self.driver.execute_script("""
                        const p=(document.querySelector('.currentPaging')||{}).textContent||'';
                        const t=document.querySelector('#tblNoiTru tbody');
                        return p+'|'+(t?t.innerText.slice(0,800):'');
                    """)
                    self.driver.execute_script("arguments[0].click();", next_btns[0])
                    try:
                        WebDriverWait(self.driver, 20).until(lambda d: d.execute_script("""
                            const p=(document.querySelector('.currentPaging')||{}).textContent||'';
                            const t=document.querySelector('#tblNoiTru tbody');
                            return p+'|'+(t?t.innerText.slice(0,800):'');
                        """) != before_sig)
                    except Exception:
                        print(f"WARN: Trang {curr + 1}/{total} không đổi sau 20 giây; dừng để tránh bỏ/nhân bản ca.")
                        break
                    time.sleep(0.25)
                except Exception as page_exc:
                    print(f"WARN: Dừng phân trang do lỗi: {page_exc}")
                    break

            write_json_compact(out_path, all_data)
            print(f"SUCCESS(Selenium): Quét xong! Đã lưu {len(all_data)} dòng vào {out_path}")
        except Exception as e:
            print(f"ERROR: {e}")
            raise
        finally:
            try:
                _ws_scan.__exit__(None, None, None)
            except Exception:
                pass

    # ------------------------------
    # Helpers for details
    # ------------------------------
    def _search_and_open_patient(self, ma_bn: str, denngay: str, row: Optional[Dict[str, Any]] = None) -> bool:
        """
        Tìm BN trong danh sách nội trú, mở nút xem chi tiết đầu tiên và gắn denngay.
        Bản này chờ AJAX kỹ hơn và lưu log debug nếu không tìm thấy.
        """
        code = str(ma_bn).strip()
        found_status = ""

        def _do_search_once() -> None:
            try:
                search = WebDriverWait(self.driver, 20).until(EC.element_to_be_clickable((By.ID, "txtTimKiem")))
            except Exception:
                _debug_page(self.driver, "details_missing_txtTimKiem_before_search")
                raise RuntimeError("Không thấy ô tìm kiếm txtTimKiem ở trang danh sách nội trú")
            try:
                search.click()
                search.send_keys(Keys.CONTROL, "a")
                search.send_keys(code)
                search.send_keys(Keys.ENTER)
            except Exception:
                # fallback JS nếu clear/send_keys bị chặn
                self.driver.execute_script("arguments[0].value = arguments[1];", search, code)
                search.send_keys(Keys.ENTER)
            try:
                WebDriverWait(self.driver, 12).until(lambda d: code in (d.page_source or ""))
            except Exception:
                time.sleep(1.5)

        # Quy tắc trạng thái:
        # - Đang thực hiện: còn ở khoa.
        # - Hoàn tất: vẫn mở để lấy y lệnh/cữ thuốc ngày ra viện.
        # - Đi mổ: đánh dấu rời khoa/GMHS, không nhập tác vụ tại khoa.
        for status_name in ("Đang thực hiện", "Hoàn tất", "Đi mổ"):
            if _set_inpatient_status_filter:
                try:
                    _set_inpatient_status_filter(self.driver, self.wait, status_name, log_func=print)
                except Exception:
                    pass
            _do_search_once()
            row_exists = False
            try:
                row_exists = bool(_patient_row_exists(self.driver, code)) if _patient_row_exists else (code in (self.driver.page_source or ""))
            except Exception:
                row_exists = code in (self.driver.page_source or "")
            if row_exists:
                found_status = status_name
                break

        if not found_status:
            if isinstance(row, dict):
                row["trang_thai"] = "Không thấy ở Đang thực hiện/Hoàn tất/Đi mổ"
                row["Trạng thái"] = row["trang_thai"]
                row["surgery_out"] = True
                row["surgery_out_reason"] = "Không thấy người bệnh ở trạng thái Đang thực hiện, Hoàn tất hoặc Đi mổ; có thể đã chuyển khoa Gây mê hồi sức/không còn ở khoa hiện tại."
            print(f"LOG: Không thấy BN {ma_bn} ở Đang thực hiện/Hoàn tất/Đi mổ; có thể đã chuyển GMHS/không còn ở khoa.")
            try:
                if _set_inpatient_status_filter:
                    _set_inpatient_status_filter(self.driver, self.wait, "Đang thực hiện", log_func=print)
            except Exception:
                pass
            return False

        if isinstance(row, dict):
            # Lấy lại cột Xử trí ngay từ dòng danh sách hiện tại. Đây là nguồn có "Ra viện Đỡ giảm".
            # Nếu bỏ qua bước này, trang chi tiết có thể chỉ trả "Đang thực hiện" và làm mất giờ ra viện.
            try:
                _list_row = _extract_list_row_for_patient_from_html(self.driver.page_source or "", code)
                if _list_row:
                    _merge_admin_from_list_row(row, _list_row)
            except Exception:
                pass

            row["trang_thai"] = found_status
            row["Trạng thái"] = found_status
            if found_status == "Đi mổ":
                row["surgery_out"] = True
                row["surgery_out_reason"] = "Người bệnh đang ở trạng thái Đi mổ, chưa nhận lại khoa."

        # Ưu tiên link/nút Xem trong bảng. Nếu không có chữ Xem thì lấy link có href hợp lệ ở dòng BN.
        selectors = [
            # Ưu tiên con mắt điều dưỡng, vì trang này có lblNgayRaVien.
            f"//table[@id='tblNoiTru']//tbody//tr[.//*[contains(normalize-space(), '{code}')]]//a[contains(@href, 'wpid=dieuduongdraw')]",
            f"//table[@id='tblNoiTru']//tbody//tr[.//*[contains(normalize-space(), '{code}')]]//a[i[contains(@class, 'fa-eye') or contains(@class, 'far')]]",
            f"//table[@id='tblNoiTru']//tbody//tr[.//*[contains(normalize-space(), '{code}')]]//a[contains(normalize-space(), 'Xem') or contains(@title, 'Xem') or contains(@class, 'warning') or contains(@class, 'btn-outline')]",
            f"//table[@id='tblNoiTru']//tbody//tr[.//*[contains(normalize-space(), '{code}')]]//a[@href]",
        ]
        candidates = []
        for xp in selectors:
            try:
                candidates = self.driver.find_elements(By.XPATH, xp)
                if candidates:
                    break
            except Exception:
                continue

        if not candidates:
            _debug_page(self.driver, f"details_no_view_link_{ma_bn}")
            print(f"LOG: Không tìm thấy nút Xem cho BN {ma_bn}")
            return False

        href = ""
        for a in candidates:
            try:
                href = a.get_attribute("href") or ""
                if href and "javascript:" not in href.lower():
                    break
            except Exception:
                href = ""

        if not href:
            _debug_page(self.driver, f"details_empty_href_{ma_bn}")
            print(f"LOG: Nút Xem không có href cho BN {ma_bn}")
            return False

        if "denngay=" in href:
            new_url = re.sub(r"(denngay=)([^&]+)", f"denngay={denngay}", href)
        else:
            sep = "&" if "?" in href else "?"
            new_url = href + f"{sep}denngay={denngay}"

        print(f"LOG: Mở hồ sơ BN {ma_bn} đến ngày {denngay}")
        _safe_driver_get(self.driver, new_url, f"hồ sơ BN {ma_bn}")
        try:
            WebDriverWait(self.driver, 15).until(
                lambda d: ("login.aspx" not in (d.current_url or "").lower()) and (
                    "divMenuContent" in (d.page_source or "") or "Y lệnh" in (d.page_source or "") or "Lịch sử" in (d.page_source or "")
                )
            )
        except Exception:
            _debug_page(self.driver, f"details_patient_page_not_ready_{ma_bn}")
        return True

    def _click_ylenh_tab(self) -> bool:
        """Mở tab Lịch sử/Y lệnh và chờ timeline render."""
        candidates = [
            (By.ID, "btnLSYLenh"),
            (By.CSS_SELECTOR, "#btnLSYLenh"),
            (By.XPATH, "//a[contains(@id,'YLenh') or contains(@href,'YLenh') or contains(@onclick,'YLenh')]"),
            (By.XPATH, "//a[contains(normalize-space(), 'Y lệnh') or contains(normalize-space(), 'Y lệnh điều trị')]"),
            (By.XPATH, "//*[contains(normalize-space(), 'Y lệnh')]/ancestor::a[1]"),
        ]
        clicked = False
        last_err = None
        for by, value in candidates:
            try:
                el = WebDriverWait(self.driver, 8).until(EC.element_to_be_clickable((by, value)))
                self.driver.execute_script("arguments[0].scrollIntoView({block:'center'});", el)
                time.sleep(0.2)
                self.driver.execute_script("arguments[0].click();", el)
                clicked = True
                break
            except Exception as e:
                last_err = e

        if not clicked:
            _debug_page(self.driver, "details_cannot_click_ylenh_tab")
            print(f"LOG: Không click được tab Y lệnh: {last_err}")
            return False

        # Chờ timeline hoặc nội dung y lệnh xuất hiện sau AJAX.
        try:
            WebDriverWait(self.driver, 15).until(
                lambda d: (
                    "vertical-timeline-block" in (d.page_source or "")
                    or "Bác sĩ:" in (d.page_source or "")
                    or "+ Thuốc" in (d.page_source or "")
                    or "+ Y lệnh" in (d.page_source or "")
                )
            )
        except Exception:
            _debug_page(self.driver, "details_ylenh_timeline_not_loaded")
            print("LOG: Đã bấm tab Y lệnh nhưng timeline chưa render")
            return False

        time.sleep(0.5)
        return True

    def _extract_timeline_map(self, bridge_end_date: Optional[str] = None, start_boundary_date: Optional[str] = None) -> Tuple[Dict[str, Dict[str, Any]], Optional[str]]:
        """
        Wrapper: parse current page_source (after opening LSYLenh) using the shared HTML parser.
        bridge_end_date: nếu có, coi đây là ngày nối ca và chỉ giữ các y lệnh/thực hiện trước 07:00.
        start_boundary_date: ngày đầu khoảng làm việc; bỏ các mốc trước 07:00 của ngày này.
        """
        html = self.driver.page_source
        return extract_timeline_map_from_html(
            html,
            bridge_end_date=bridge_end_date,
            start_boundary_date=start_boundary_date,
        )

    # --- TASK 2: DETAILS (Standard B: 1 record / BN / day) ---
    def task_details(
        self,
        input_path: str = "data_sorted.json",
        out_path: str = "KetQua_YLenh.json",
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        rooms: Optional[List[str]] = None,
        skip_empty: bool = False,
        data_override: Optional[List[Dict[str, Any]]] = None,
    ):
        if BeautifulSoup is None:
            raise RuntimeError("Thiếu thư viện bs4. Hãy cài: pip install beautifulsoup4")
        # Load input
        if data_override is not None:
            data = data_override
        else:
            if not os.path.exists(input_path):
                print(f"ERROR: Chưa có file {input_path}")
                return
            with open(input_path, "r", encoding="utf-8") as f:
                data = json.load(f)

        if not isinstance(data, list):
            print("ERROR: Input data phải là list")
            return

        # Giảm dữ liệu dư ngay từ đầu để nhẹ hơn (bỏ mapping bác sĩ theo giờ)
        data = _compact_detail_input_records(data)
        for row in data:
            _normalize_admin_fields(row, overwrite=False)

        # Rooms filter
        room_set: Optional[set] = None
        if rooms:
            room_set = set()
            for r in rooms:
                nr = normalize_room_code(r)
                if nr:
                    room_set.add(nr)
            if room_set:
                data = [
                    bn for bn in data
                    if normalize_room_code(bn.get("Vi_Tri") or bn.get("phong_giuong") or "") in room_set
                ]

        # Date range:
        # Lưu ý: ngày đầu người dùng chọn phải lấy đủ cả các y lệnh sáng sớm
        # 00:00-06:59. Trước đây truyền start_boundary_date=date_from_full
        # xuống parser nên các block 05:00 của ngày đầu bị loại, làm mất thuốc
        # ngày bắt đầu như 01/05. Chỉ còn giữ cơ chế bridge cho ngày SAU ngày cuối.
        default_year = str(self.config.get("nam_lam_viec", datetime.now().year))

        # Fallback: read from first record (frontend payload often includes ngay_tu/ngay_den)
        if (not date_from) and data:
            date_from = data[0].get("ngay_tu") or data[0].get("ngay_lam")
        if (not date_to) and data:
            date_to = data[0].get("ngay_den") or date_from

        # Final fallback: today
        if not date_from:
            date_from = datetime.now().strftime("%d/%m/%Y")
        if not date_to:
            date_to = date_from

        date_from_full = normalize_date(date_from, default_year)
        date_to_full = normalize_date(date_to, default_year)
        if date_from_full is None or date_to_full is None:
            print("ERROR: Không xác định được ngày lấy.")
            return

        date_plan = _build_detail_date_plan(date_from_full, date_to_full)
        dates = date_plan["work_dates"]
        timeline_dates = date_plan["timeline_dates"]
        fetch_until_date_full = date_plan["fetch_until_date"]
        bridge_end_date = date_plan["bridge_end_date"]
        # Compact input rows early to reduce memory / noise (canonical keys only).
        data = _canonicalize_rows_for_runtime(data, include_order_text=False)
        bridge_msg = f" | nối ca đến {bridge_end_date} trước 07:00" if bridge_end_date else ""
        print(
            f"LOG: Bắt đầu lấy dữ liệu ngày làm: {date_from_full} → {date_to_full}{bridge_msg} | BN: {len(data)} | Phòng: "
            f"{','.join(sorted(room_set)) if room_set else 'ALL'}"
        )

        # --- READ MODE: mặc định HTTP-only để lấy chi tiết không mở Chrome ---
        read_mode = _read_mode(self.config)
        allow_selenium_fallback = _allow_selenium_read_fallback(self.config)

        if _http_read_enabled(self.config):
            try:
                sess = _get_http_session(self.config)
                if sess is None:
                    raise RuntimeError("HTTP session không khả dụng")
                sess.login()

                # Build a map: ma_bn -> patient_view_url by scanning inpatient list pages once
                _rows, link_map = sess.scan_all_inpatients()
                list_row_by_ma: Dict[str, Dict[str, Any]] = {}
                for _r in _rows or []:
                    _normalize_admin_fields(_r, overwrite=False)
                    _ma = str(_r.get("Mã BN") or _r.get("Mã YT") or _r.get("ma_bn") or "").strip()
                    if _ma:
                        list_row_by_ma[_ma] = _r

                # Heuristic: if we can't retrieve timeline HTML (vertical-timeline-block), switch to Selenium
                can_http_timeline = None

                records_http: List[Dict[str, Any]] = []
                for i, bn in enumerate(data):
                    ma_bn = bn.get("Mã BN") or bn.get("Mã YT") or bn.get("ma_bn") or ""
                    ho_ten = clean_name(bn.get("Họ tên") or bn.get("ho_ten") or "")
                    vitri = bn.get("Vi_Tri") or bn.get("phong_giuong") or ""

                    if not ma_bn:
                        continue

                    print(f"LOG(HTTP): [{i+1}/{len(data)}] Xử lý: {ho_ten} ({ma_bn})")

                    _list_row = list_row_by_ma.get(str(ma_bn).strip())
                    if _list_row:
                        _merge_admin_from_list_row(bn, _list_row)

                    view_url = link_map.get(str(ma_bn).strip())
                    if not view_url:
                        # HTTP scan chỉ thấy trạng thái mặc định. Nếu BN không có ở đây, fallback Selenium
                        # để kiểm tra thêm “Hoàn tất” (ra viện) và “Đi mổ”.
                        msg = f"Không thấy BN {ma_bn} trong link_map HTTP của danh sách hiện tại"
                        if not allow_selenium_fallback:
                            raise RuntimeError(msg)
                        print(f"LOG(HTTP): {msg} -> fallback Selenium kiểm tra Đang thực hiện/Hoàn tất/Đi mổ")
                        can_http_timeline = False
                        break

                    patient_html, patient_url = sess.fetch_patient_page(view_url, denngay=fetch_until_date_full)
                    _merge_patient_admin_info(bn, patient_html, overwrite=True)
                    if _has_discharge_disposition(bn):
                        _attach_discharge_info(bn, patient_html, date_to_full, default_year=default_year)
                    ylenh_pair = sess.try_get_ylenh_html(patient_html, patient_url)

                    if not ylenh_pair:
                        msg = f"Không tìm thấy HTML tab Y lệnh qua HTTP cho BN {ma_bn}"
                        if not allow_selenium_fallback:
                            raise RuntimeError(msg)
                        can_http_timeline = False
                        break

                    y_html, _y_url = ylenh_pair
                    _attach_ward_admission_history(bn, y_html)
                    _clear_stale_discharge_for_current_visit(bn)
                    if "vertical-timeline-block" not in (y_html or ""):
                        msg = f"HTML Y lệnh qua HTTP không có vertical-timeline-block cho BN {ma_bn}"
                        if not allow_selenium_fallback:
                            raise RuntimeError(msg)
                        can_http_timeline = False
                        break

                    timeline_map, doctor_from_page = extract_timeline_map_from_html(y_html, bridge_end_date=bridge_end_date, start_boundary_date=None)
                    can_http_timeline = True

                    for d in timeline_dates:
                        item = timeline_map.get(d, {"Y lệnh": "", "Diễn biến": "", "Bác sĩ": ""})
                        yl = item.get("Y lệnh", "") or ""
                        db = item.get("Diễn biến", "") or ""

                        doc_day = item.get("Bác sĩ", "") or ""
                        if skip_empty and (not yl) and (not db):
                            continue

                        rec = _build_record(
                            bn, d, item,
                            ho_ten=ho_ten,
                            vitri=vitri,
                            doctor_from_page=doctor_from_page or "",
                            bridge_end_date=bridge_end_date,
                        )
                        records_http.append(rec)

                if can_http_timeline is True:
                    records_http = merge_order_records(records_http, skip_empty=skip_empty)
                    records_http = _canonicalize_rows_for_runtime(records_http, include_order_text=True)
                    write_json_compact(out_path, records_http)
                    try:
                        generate_runtime_v2_files(os.environ.get("WORKER_RUNTIME_DIR") or os.path.dirname(os.path.dirname(os.path.abspath(out_path))), selected_path=input_path, orders_path=out_path)
                    except Exception as _v2_exc:
                        print(f"[DATA V2] Cảnh báo: chưa sinh được data v2 sau details HTTP: {_v2_exc}")

                    print(f"SUCCESS(HTTP): Hoàn tất! Xuất {len(records_http)} record đã gộp/khử trùng -> {out_path}")
                    return

                if not allow_selenium_fallback:
                    _raise_http_only_failure("Lấy chi tiết/Y lệnh", "Không lấy được timeline qua HTTP")
                print("[HTTP READ] Không lấy được timeline (Y lệnh) qua HTTP -> fallback Selenium")

            except Exception as e:
                if not allow_selenium_fallback:
                    _raise_http_only_failure("Lấy chi tiết/Y lệnh", e)
                print(f"[HTTP READ] Details lỗi: {e} -> fallback Selenium vì data_read_mode={read_mode}")
        elif not allow_selenium_fallback:
            _raise_http_only_failure("Lấy chi tiết/Y lệnh", "HTTP reader đang tắt")

        records: List[Dict[str, Any]] = []

        is_headless = _read_selenium_headless(self.config)
        print(f"[READ] Lấy chi tiết/Y lệnh bằng Chrome headless (không hiện cửa sổ): headless={is_headless}")
        _ws_details = WorkerSession(_with_worker_headless(self.config, is_headless), "/dev/null")
        _ws_details.__enter__()
        self.driver, self.wait = _ws_details.driver, _ws_details.wait
        try:

            wpid = self.config.get("inpatient_wpid", "danhsachdieutrinoitrudraw")
            post_login_url = self.driver.current_url
            nav_url = _build_inpatient_url(post_login_url, wpid)
            print(f"[DETAILS] Chuyển đến danh sách nội trú: {nav_url}")
            _safe_driver_get(self.driver, nav_url, "danh sách nội trú details")
            try:
                self.wait.until(EC.presence_of_element_located((By.ID, "txtTimKiem")))
                print("[DETAILS] Đã vào danh sách nội trú, thấy ô tìm kiếm txtTimKiem")
            except Exception:
                _debug_page(self.driver, "details_missing_txtTimKiem_after_nav")
                raise RuntimeError("Đã đăng nhập nhưng không vào được danh sách nội trú hoặc không thấy ô txtTimKiem")

            for i, bn in enumerate(data):
                ma_bn = bn.get("Mã BN") or bn.get("Mã YT") or bn.get("ma_bn") or ""
                ho_ten = clean_name(bn.get("Họ tên") or bn.get("ho_ten") or "")
                vitri = bn.get("Vi_Tri") or bn.get("phong_giuong") or ""

                if not ma_bn:
                    continue

                print(f"LOG: [{i+1}/{len(data)}] Xử lý: {ho_ten} ({ma_bn})")

                try:
                    opened = self._search_and_open_patient(str(ma_bn), denngay=fetch_until_date_full, row=bn)
                    if not opened:
                        continue

                    _merge_patient_admin_info(bn, self.driver.page_source or "", overwrite=True)

                    if _has_discharge_disposition(bn):
                        try:
                            WebDriverWait(self.driver, 6).until(
                                lambda d: ("lblNgayRaVien" in (d.page_source or "")) or ("Ngày ra viện" in (d.page_source or ""))
                            )
                        except Exception:
                            pass
                        _attach_discharge_info(bn, self.driver.page_source or "", date_to_full, default_year=default_year)

                    if not self._click_ylenh_tab():
                        print(f"LOG: Bỏ qua BN {ma_bn} vì không mở/không tải được tab Y lệnh")
                        continue

                    _attach_ward_admission_history(bn, self.driver.page_source or "")
                    _clear_stale_discharge_for_current_visit(bn)
                    timeline_map, doctor_from_page = self._extract_timeline_map(bridge_end_date=bridge_end_date, start_boundary_date=None)
                    if not timeline_map:
                        _debug_page(self.driver, f"details_empty_timeline_{ma_bn}")
                        print(f"LOG: Bỏ qua BN {ma_bn} vì parser không đọc được timeline Y lệnh")
                        continue

                    print(f"LOG: Đọc được timeline {len(timeline_map)} ngày cho BN {ma_bn}: {', '.join(sorted(timeline_map.keys()))}")

                    for d in timeline_dates:
                        item = timeline_map.get(d, {"Y lệnh": "", "Diễn biến": "", "Bác sĩ": ""})
                        yl = item.get("Y lệnh", "") or ""
                        db = item.get("Diễn biến", "") or ""

                        doc_day = item.get("Bác sĩ", "") or ""
                        if skip_empty and (not yl) and (not db):
                            continue

                        rec = _build_record(
                            bn, d, item,
                            ho_ten=ho_ten,
                            vitri=vitri,
                            doctor_from_page=doctor_from_page or "",
                            bridge_end_date=bridge_end_date,
                        )
                        records.append(rec)

                    # Quay về danh sách bằng URL cố định thay vì driver.back() để tránh lệch history stack.
                    try:
                        _safe_driver_get(self.driver, nav_url, "quay lại danh sách sau khi đọc BN")
                        self.wait.until(EC.presence_of_element_located((By.ID, "txtTimKiem")))
                    except Exception:
                        _debug_page(self.driver, f"details_return_list_failed_{ma_bn}")

                except Exception as e:
                    print(f"LOG: Lỗi BN {ma_bn}: {e}")
                    try:
                        _safe_driver_get(self.driver, nav_url, "khôi phục danh sách sau lỗi BN")
                        self.wait.until(EC.presence_of_element_located((By.ID, "txtTimKiem")))
                    except Exception:
                        _debug_page(self.driver, f"details_recover_list_failed_{ma_bn}")

            # Write output: gộp theo patient-day để bridge 00:00-06:59 không tạo record trùng.
            records = merge_order_records(records, skip_empty=skip_empty)
            records = _canonicalize_rows_for_runtime(records, include_order_text=True)
            write_json_compact(out_path, records)
            try:
                generate_runtime_v2_files(os.environ.get("WORKER_RUNTIME_DIR") or os.path.dirname(os.path.dirname(os.path.abspath(out_path))), selected_path=input_path, orders_path=out_path)
            except Exception as _v2_exc:
                print(f"[DATA V2] Cảnh báo: chưa sinh được data v2 sau details Selenium: {_v2_exc}")

            if not records:
                raise RuntimeError("Không lấy được record y lệnh nào. Xem file debug trong thư mục logs của session.")

            non_empty = sum(1 for r in records if (r.get("Y lệnh") or r.get("Diễn biến")))
            if non_empty == 0:
                raise RuntimeError("Có mở hồ sơ nhưng không đọc được nội dung Y lệnh/Diễn biến nào. Xem file debug trong thư mục logs của session.")

            print(f"SUCCESS: Hoàn tất! Xuất {len(records)} record đã gộp/khử trùng ({non_empty} có nội dung) -> {out_path}")

        except Exception as e:
            print(f"ERROR: Tổng quan: {e}")
            raise
        finally:
            try:
                _ws_details.__exit__(None, None, None)
            except Exception:
                pass



def build_arg_parser():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    p_auth = sub.add_parser("auth-http")
    p_auth.add_argument("--headless", action="store_true", help="lấy cookie bằng Chrome headless")

    p_scan = sub.add_parser("scan")
    p_scan.add_argument("--out", default="data_raw.json")
    p_scan.add_argument("--status", default="", help="Trạng thái nội trú cần quét, ví dụ: Hoàn tất")
    p_scan.add_argument("--headless", action="store_true", help="Ép Chrome scan chạy ẩn")
    p_scan.add_argument("--date-from", default="", help="Ngày bắt đầu yyyy-mm-dd hoặc dd/mm/yyyy")
    p_scan.add_argument("--date-to", default="", help="Ngày kết thúc yyyy-mm-dd hoặc dd/mm/yyyy")

    p_det = sub.add_parser("details")
    p_det.add_argument("--input", default="data_sorted.json")
    p_det.add_argument("--out", default="KetQua_YLenh.json")
    p_det.add_argument("--from", dest="date_from", default=None, help="dd/mm hoặc dd/mm/yyyy")
    p_det.add_argument("--to", dest="date_to", default=None, help="dd/mm hoặc dd/mm/yyyy")
    p_det.add_argument("--rooms", default="", help="P01,P02 hoặc 01,02")
    p_det.add_argument("--skip-empty", action="store_true")

    return p


if __name__ == "__main__":
    args = build_arg_parser().parse_args()
    w = AutoWorker()

    if args.cmd == "auth-http":
        w.task_auth_http_session(headless=bool(getattr(args, "headless", False)))
    elif args.cmd == "scan":
        if bool(getattr(args, "headless", False)):
            w.config["headless"] = True
            w.config["data_read_headless"] = True
            w.config["read_headless"] = True
        w.task_scan(
            out_path=args.out,
            status_name=getattr(args, "status", ""),
            date_from=getattr(args, "date_from", ""),
            date_to=getattr(args, "date_to", ""),
        )
    elif args.cmd == "details":
        rooms = [x.strip() for x in (args.rooms or "").split(",") if x.strip()]
        w.task_details(
            input_path=args.input,
            out_path=args.out,
            date_from=args.date_from,
            date_to=args.date_to,
            rooms=rooms if rooms else None,
            skip_empty=bool(args.skip_empty),
        )