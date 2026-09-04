# -*- coding: utf-8 -*-
# worker/hchanh_fetch.py
# Fetch dữ liệu hành chánh từ EMR theo scope.
#
# Được gọi từ server/routes/hchanh.js.
# CLI: python hchanh_fetch.py --input ... --out ... --scope discharge --files profile,discharge,billing,bed_days,surgery
#
# Thiết kế:
#   - Mỗi "file" là 1 fetcher độc lập → có thể lấy lại lẻ từng phần.
#   - Ưu tiên HTTP (không mở Chrome), fallback Selenium nếu cần.
#   - Config-driven: URL các trang đặc biệt (bảng kê, giấy ra viện...) lấy từ config.json.
#     Nếu chưa cấu hình, worker tự suy luận từ link_map hoặc bỏ qua.

from __future__ import annotations

import argparse
import atexit
import json
import os
import re
from shared.text_utils import norm_vi as _norm
import sys
import time
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urljoin, urlparse, urlencode, parse_qsl, urlunparse

# ── Deps ──────────────────────────────────────────────────────────────────────
from utils import load_config, normalize_date

try:
    from utils import login_emr
    from shared.worker_session import WorkerSession as _WorkerSession
    _HAS_SELENIUM_LOGIN = True
except Exception:
    login_emr = None  # type: ignore
    _WorkerSession = None  # type: ignore
    _HAS_SELENIUM_LOGIN = False

try:
    from bs4 import BeautifulSoup
except ModuleNotFoundError:
    BeautifulSoup = None  # type: ignore

try:
    from emr_http_reader import EmrHttpSession
    _HAS_HTTP = True
except Exception:
    _HAS_HTTP = False
    EmrHttpSession = None  # type: ignore


try:
    from selenium_emr_helpers import (
        goto_inpatient_list as _selenium_goto_inpatient_list,
        set_inpatient_status_filter as _selenium_set_status_filter,
        search_patient as _selenium_search_patient,
        patient_row_exists as _selenium_patient_row_exists,
        wait_after_action as _selenium_wait_after_action,
        set_time_range_filter as _selenium_set_time_range_filter,
    )
    _HAS_SELENIUM_SEARCH = True
except Exception:
    _selenium_goto_inpatient_list = None  # type: ignore
    _selenium_set_status_filter = None    # type: ignore
    _selenium_search_patient = None       # type: ignore
    _selenium_patient_row_exists = None   # type: ignore
    _selenium_wait_after_action = None    # type: ignore
    _HAS_SELENIUM_SEARCH = False


# ── Helpers ───────────────────────────────────────────────────────────────────

def _t(v: Any, fb: str = "") -> str:
    return str(v or "").strip() or fb

# _norm → shared.text_utils.norm_vi


def _same_status(a: Any, b: Any) -> bool:
    aa = _norm(a)
    bb = _norm(b)
    return bool(aa and bb and (aa == bb or aa in bb or bb in aa))


def _research_status_candidates(primary: str, research_mode: bool = False) -> List[str]:
    """Danh sách trạng thái để tìm BN khi lấy dữ liệu nghiên cứu.

    Bước nghiên cứu thường gọi Hành chánh với trạng thái 'Hoàn tất'. Thực tế có ca
    trong cohort chưa ra viện hoặc đã tái nhập/đổi trạng thái nên không còn nằm ở
    filter 'Hoàn tất'. Với research_mode, thử thêm các trạng thái an toàn để vẫn
    lấy được profile/lịch sử y lệnh, đồng thời không tạo discharge giả.
    """
    first = _t(primary, "Đang thực hiện")
    out: List[str] = []
    for item in [first]:
        if item and not any(_same_status(item, x) for x in out):
            out.append(item)
    if research_mode:
        for item in ["Đang thực hiện", "Hoàn tất", "Đi mổ"]:
            if item and not any(_same_status(item, x) for x in out):
                out.append(item)
    return out

def _upsert_query(url: str, **params: str) -> str:
    p = urlparse(url)
    q = dict(parse_qsl(p.query, keep_blank_values=True))
    for k, v in params.items():
        q[k] = v
    return urlunparse((p.scheme, p.netloc, p.path, p.params, urlencode(q), p.fragment))


_EMR_SESSION_QUERY_KEYS = {
    "scope", "lang", "role", "usid", "st", "sid", "sessionid", "session_id",
}


def _is_emr_login_url(url: str) -> bool:
    """Nhận diện trường hợp EMR chuyển ngược về trang đăng nhập."""
    try:
        path = (urlparse(str(url or "")).path or "").lower().rstrip("/")
        return path.endswith("/login.aspx") or path.endswith("login.aspx")
    except Exception:
        return "login.aspx" in str(url or "").lower()


def _rebase_emr_patient_url(saved_url: str, current_session_url: str) -> str:
    """Ghép link hồ sơ đã lưu với mã phiên Selenium hiện tại.

    Link tên người bệnh/con mắt điều dưỡng lấy lúc quét danh sách có chứa `usid`
    và `st` của Chrome quét. Khi worker chi tiết mở Chrome mới, dùng nguyên link cũ
    sẽ bị EMR chuyển về login.aspx. Hàm này giữ các tham số nhận diện lượt điều trị
    (noitruid, tiepnhanid, kp, wpid, nextlink...) nhưng thay toàn bộ tham số phiên
    bằng phiên đang đăng nhập ở `current_session_url`.
    """
    saved = str(saved_url or "").strip()
    current = str(current_session_url or "").strip()
    if not saved:
        return ""
    if not current:
        return saved

    try:
        saved_abs = urljoin(current, saved)
        p_saved = urlparse(saved_abs)
        p_current = urlparse(current)

        # Bắt đầu bằng toàn bộ query của phiên hiện tại (scope/lang/role/usid/st).
        merged = dict(parse_qsl(p_current.query, keep_blank_values=True))
        # Chép các tham số hồ sơ từ link cũ, tuyệt đối không chép mã phiên cũ.
        for key, value in parse_qsl(p_saved.query, keep_blank_values=True):
            if str(key or "").lower() in _EMR_SESSION_QUERY_KEYS:
                continue
            merged[key] = value

        scheme = p_current.scheme or p_saved.scheme
        netloc = p_current.netloc or p_saved.netloc
        # Hồ sơ EMR đều chạy trên home.aspx; ưu tiên path của phiên hiện tại để
        # tránh vô tình giữ login.aspx hoặc endpoint cũ.
        path = p_current.path or p_saved.path or "/home.aspx"
        if path.lower().endswith("login.aspx") and p_saved.path:
            path = p_saved.path
        return urlunparse((scheme, netloc, path, "", urlencode(merged), ""))
    except Exception:
        return saved

def _drop_query(url: str, *keys: str) -> str:
    """Xóa tham số query khỏi URL, dùng khi đổi giữa link bác sĩ và mắt điều dưỡng."""
    p = urlparse(url)
    remove = {str(k).lower() for k in keys}
    q = [(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True) if k.lower() not in remove]
    return urlunparse((p.scheme, p.netloc, p.path, p.params, urlencode(q), p.fragment))

def _patient_link_key(ma_bn: str, kind: str) -> str:
    return f"{str(ma_bn or '').strip()}::{kind}"

def _as_nursing_url(url: str) -> str:
    """URL khi bấm con mắt điều dưỡng: dùng cho profile, buồng giường, VTYT."""
    if not url:
        return ""
    out = _upsert_query(url, wpid="dieuduongdraw")
    out = _drop_query(out, "nextlink")
    return out

def _as_doctor_url(url: str) -> str:
    """URL khi bấm tên người bệnh: dùng cho y lệnh, bảng kê, giấy tờ, ra viện."""
    if not url:
        return ""
    out = _upsert_query(url, wpid="bacsidraw")
    # Link tên BN trên danh sách thường kèm nextlink=lichsuylenh. Thêm lại để trang y lệnh render đúng.
    qs = dict(parse_qsl(urlparse(out).query, keep_blank_values=True))
    if not qs.get("nextlink"):
        out = _upsert_query(out, nextlink="lichsuylenh")
    return out

def _remember_patient_links(link_map: Dict[str, str], ma_bn: str, links: Dict[str, str]) -> None:
    """Lưu song song 2 đường vào hồ sơ: tên BN và mắt điều dưỡng."""
    code = str(ma_bn or "").strip()
    if not code:
        return
    doctor = links.get("doctor") or ""
    nursing = links.get("nursing") or ""
    if not doctor and nursing:
        doctor = _as_doctor_url(nursing)
    if not nursing and doctor:
        nursing = _as_nursing_url(doctor)
    if doctor:
        link_map[_patient_link_key(code, "doctor")] = doctor
    if nursing:
        link_map[_patient_link_key(code, "nursing")] = nursing
    if doctor or nursing:
        # Mặc định mới là link bấm tên người bệnh. Các fetcher cần mắt điều dưỡng sẽ gọi kind="nursing".
        link_map[code] = doctor or nursing

def _soup(html: str):
    if BeautifulSoup is None:
        raise RuntimeError("Thiếu bs4. Cài: pip install beautifulsoup4")
    return BeautifulSoup(html or "", "html.parser")

def _get_text(el) -> str:
    if el is None:
        return ""
    return re.sub(r"\s+", " ", el.get_text(" ", strip=True)).strip()

def _table_to_rows(table) -> List[Dict[str, str]]:
    """Parse <table> → list[dict] dùng hàng đầu tiên làm header."""
    if table is None:
        return []
    rows = table.find_all("tr")
    if not rows:
        return []
    headers = [_get_text(th) for th in rows[0].find_all(["th", "td"])]
    out = []
    for row in rows[1:]:
        cols = row.find_all("td")
        r = {}
        for i, col in enumerate(cols):
            h = headers[i] if i < len(headers) else f"col{i}"
            r[h] = _get_text(col)
        if any(v for v in r.values()):
            out.append(r)
    return out




# ── Research case trace ──────────────────────────────────────────────────────
# Log này phục vụ Kho nghiên cứu chạy ẩn: mỗi case ghi rõ bước, màn hình/thẻ đang vào,
# thấy gì, lấy gì, ghi gì. Server sẽ gom 10 case gần nhất vào research_case_trace_recent.json.
_TRACE_EVENTS: List[Dict[str, Any]] = []
# Mặc định KHÔNG in [TRACE] ra console để log dễ đọc — vẫn lưu đủ vào
# research_case_trace*.json để xem lại chi tiết qua UI khi cần debug sâu.
# Bật lại bằng biến môi trường RESEARCH_TRACE_CONSOLE=1 khi cần soi trực tiếp.
_TRACE_TO_CONSOLE = os.environ.get("RESEARCH_TRACE_CONSOLE", "0") == "1"
_ALLOWED_TRACE_TAGS = {
    # Case/session
    "CASE.START", "CASE.END", "INPUT.READ",
    "EMR.SESSION_INIT", "EMR.PATIENT_LINKS", "EMR.PATIENT_LINKS_SKIP_HTTP", "EMR.PATIENT_LINKS_EMPTY",
    "EMR.PATIENT_LINKS_RECOVERED", "EMR.PATIENT_LINKS_NOT_FOUND",
    # Generic fetch lifecycle
    "FETCH.START", "FETCH.END", "FETCH.NO_URL",
    # Order history: giữ tag cũ để tương thích, thêm tag mới để đọc rõ HTTP/fallback
    "ORDER_HISTORY.OPEN", "ORDER_HISTORY.SELECT_SHOW_ALL",
    "ORDER_HISTORY.PREFETCH_FOR_SURGERY", "ORDER_HISTORY.HTTP_OPEN",
    "ORDER_HISTORY.HTTP_SELECT_SHOW_ALL", "ORDER_HISTORY.HTTP_PARSE_WARDS",
    "ORDER_HISTORY.HTTP_PARSE_ROWS", "ORDER_HISTORY.MARKERS_DIRECT",
    "ORDER_HISTORY.SELENIUM_CLICK_OPEN", "ORDER_HISTORY.SELENIUM_PARSE_ROWS",
    "ORDER_HISTORY.FALLBACK_CLICK_OPEN", "ORDER_HISTORY.FALLBACK_SELECT_SHOW_ALL",
    "ORDER_HISTORY.FALLBACK_PARSE_ROWS", "ORDER_HISTORY.MARKERS_FALLBACK",
    "ORDER_HISTORY.PARSE_WARDS", "ORDER_HISTORY.PARSE_ROWS",
    "ORDER_HISTORY.PARSE_ROWS_FINAL", "ORDER_HISTORY.MARKERS_FINAL",
    "ORDER_HISTORY.DETECT_SURGERY_MARKER", "ORDER_HISTORY.REUSE_EXISTING",
    # Surgery gate/fetch
    "SURGERY.GATE_START", "SURGERY.GATE_DECISION", "SURGERY.GATE_SKIP",
    "SURGERY.FETCH_START", "SURGERY.SEARCH_RANGE", "SURGERY.OPEN_LIST", "SURGERY.SEARCH_LIST",
    "SURGERY.OPEN_DETAIL", "SURGERY.PARSE_DETAIL",
    # Output/error
    "OUTPUT.WRITE_JSON",
    "ERROR", "WARN", "ERROR.NO_URL", "ERROR.NO_URL_PROFILE",
    "ERROR.NO_URL_DISCHARGE", "ERROR.NO_URL_ORDER_HISTORY",
    "ERROR.NO_URL_SURGERY", "ERROR.NO_PATIENT_LINK",
    "ERROR.NO_NURSING_EYE_LINK", "ERROR.NO_DOCTOR_LINK",
    "ERROR.NO_SESSION", "ERROR.EMPTY_HTML", "ERROR.SESSION_EXPIRED",
    "ERROR.SELECTOR_NOT_FOUND",
}

def _trace_now() -> str:
    try:
        from datetime import datetime as _dt
        return _dt.now().isoformat(timespec="seconds")
    except Exception:
        return str(time.time())

def _trace_clip(value: Any, limit: int = 500) -> str:
    text = str(value or "")
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]

def trace_event(tag: str, step: str, screen: str = "", sees: str = "", takes: str = "",
                writes: str = "", target: str = "", data: Optional[Dict[str, Any]] = None) -> None:
    tag = str(tag or "").strip().upper().replace(" ", "_")
    if tag not in _ALLOWED_TRACE_TAGS:
        tag = "WARN"
    event: Dict[str, Any] = {
        "ts": _trace_now(),
        "tag": tag,
        "step": _trace_clip(step, 220),
        "screen": _trace_clip(screen, 220),
        "sees": _trace_clip(sees, 700),
        "takes": _trace_clip(takes, 700),
        "writes": _trace_clip(writes, 700),
        "target": _trace_clip(target, 320),
    }
    if data:
        safe_data: Dict[str, Any] = {}
        for k, v in data.items():
            if isinstance(v, (dict, list)):
                safe_data[str(k)] = v
            else:
                safe_data[str(k)] = _trace_clip(v, 500)
        event["data"] = safe_data
    _TRACE_EVENTS.append(event)
    if not _TRACE_TO_CONSOLE:
        return
    # In thêm một dòng có thẻ tag ở đầu để action_log.txt cũng đọc được khi server gom stdout.
    visible = f"[TRACE][{tag}] {event['step']}"
    if event.get("screen"):
        visible += f" | vào={event['screen']}"
    if event.get("sees"):
        visible += f" | thấy={event['sees']}"
    if event.get("takes"):
        visible += f" | lấy={event['takes']}"
    if event.get("writes"):
        visible += f" | ghi={event['writes']}"
    print(visible)

def trace_events() -> List[Dict[str, Any]]:
    return list(_TRACE_EVENTS)[-200:]

def _trace_no_url_tag(file_key: str) -> str:
    key = str(file_key or "").strip().lower()
    if key == "profile":
        return "ERROR.NO_URL_PROFILE"
    if key == "discharge":
        return "ERROR.NO_URL_DISCHARGE"
    if key == "order_history":
        return "ERROR.NO_URL_ORDER_HISTORY"
    if key == "surgery":
        return "ERROR.NO_URL_SURGERY"
    return "ERROR.NO_URL"


# ── Session init ──────────────────────────────────────────────────────────────
# Hành chánh dùng tài khoản riêng: lndieu / 123
# Tách biệt hoàn toàn với session của main_worker (tài khoản bác sĩ/điều dưỡng lâm sàng)

HCHANH_USERNAME = "lndieu"
HCHANH_PASSWORD = "123"

def _cfg_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on", "co", "có"}

def _build_hchanh_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """Config riêng cho module hành chánh, không làm thay đổi config gốc."""
    hchanh_config = dict(config or {})
    hchanh_config["username"] = config.get("hchanh_username") or HCHANH_USERNAME
    hchanh_config["password"] = config.get("hchanh_password") or HCHANH_PASSWORD
    return hchanh_config

def _build_inpatient_url_after_login(current_url: str, config: Dict[str, Any]) -> str:
    """Giữ usid/st sau đăng nhập Selenium rồi chuyển đến danh sách nội trú."""
    configured = str(config.get("url_inpatient_list") or "").strip()
    source = current_url or configured
    p_src = urlparse(source)
    p_cfg = urlparse(configured) if configured else p_src

    # Lấy query động từ URL sau login, bổ sung tham số cố định từ url_inpatient_list.
    q = dict(parse_qsl(p_src.query, keep_blank_values=True))
    q_cfg = dict(parse_qsl(p_cfg.query, keep_blank_values=True))
    for k in ("scope", "lang", "role"):
        if k in q_cfg and k not in q:
            q[k] = q_cfg[k]
    q["wpid"] = str(config.get("inpatient_wpid") or q_cfg.get("wpid") or "danhsachdieutrinoitrudraw")

    scheme = p_src.scheme or p_cfg.scheme
    netloc = p_src.netloc or p_cfg.netloc
    path = p_cfg.path or p_src.path or "/home.aspx"
    return urlunparse((scheme, netloc, path, "", urlencode(q), ""))

def _try_selenium_login_for_http(sess: "EmrHttpSession", hchanh_config: Dict[str, Any]) -> bool:
    """Fallback: mở Chrome đăng nhập thật, nhập phiên vào requests.Session rồi dùng HTTP để đọc."""
    if not _HAS_SELENIUM_LOGIN:
        print("WARN [hchanh-session] Không có Selenium nên không thể mở Chrome để đăng nhập.")
        return False

    headless = _cfg_bool(
        hchanh_config.get("hchanh_auth_headless"),
        _cfg_bool(hchanh_config.get("auth_cookie_headless"), False),
    )
    if _WorkerSession is None:
        raise RuntimeError("WorkerSession không khả dụng; cài selenium.")
    # WorkerSession chỉ đọc key `headless`; các key hchanh_* chỉ dùng để cấu hình riêng.
    hchanh_config = {**hchanh_config, "headless": headless}
    _ws_session = _WorkerSession(hchanh_config, "/dev/null")
    driver = wait = None
    try:
        print(f"LOG [hchanh-session] HTTP chưa vào được EMR; mở Chrome để đăng nhập tự động (headless={headless}).")
        _ws_session.__enter__()
        driver, wait = _ws_session.driver, _ws_session.wait

        nav_url = _build_inpatient_url_after_login(getattr(driver, "current_url", ""), hchanh_config)
        try:
            driver.get(nav_url)
            time.sleep(float(hchanh_config.get("hchanh_auth_wait_sec") or 1.2))
            if getattr(driver, "current_url", ""):
                nav_url = driver.current_url
        except Exception:
            pass

        try:
            sess._session_inpatient_url = nav_url
        except Exception:
            pass

        n = sess.import_selenium_cookies(driver.get_cookies())
        if n <= 0:
            print("WARN [hchanh-session] Chrome đã đăng nhập nhưng không đọc được phiên trình duyệt.")
            return False

        try:
            sess.save_cookies(inpatient_list_url=nav_url)
        except Exception:
            pass

        if not sess.verify_logged_in():
            print("WARN [hchanh-session] Đã nhập phiên trình duyệt nhưng HTTP vẫn bị trả về trang đăng nhập.")
            return False

        print("LOG [hchanh-session] Đăng nhập hành chánh thành công, sẵn sàng lấy dữ liệu EMR.")
        return True
    except Exception as e:
        print(f"ERROR [hchanh-session] Chrome login fallback thất bại: {type(e).__name__}: {e}")
        return False
    finally:
        try:
            _ws_session.__exit__(None, None, None)
        except Exception:
            pass

def _init_session(config: Dict[str, Any]) -> Optional["EmrHttpSession"]:
    """Đăng nhập EMR bằng tài khoản hành chánh riêng, có fallback Chrome khi HTTP không qua được login."""
    if not _HAS_HTTP:
        print("WARN [hchanh-session] emr_http_reader không khả dụng.")
        return None

    hchanh_config = _build_hchanh_config(config)
    try:
        sess = EmrHttpSession.from_config_dict(hchanh_config)
    except Exception as e:
        print(f"ERROR [hchanh-session] Không khởi tạo được HTTP session: {type(e).__name__}: {e}")
        return None

    try:
        sess.login()
        print("LOG [hchanh-session] Đã đăng nhập EMR bằng HTTP.")
        return sess
    except Exception as e:
        print(f"WARN [hchanh-session] HTTP login thất bại: {type(e).__name__}. Thử đăng nhập bằng Chrome...")

    if _try_selenium_login_for_http(sess, hchanh_config):
        return sess

    print("ERROR [hchanh-session] Không đăng nhập được EMR. Các mục cần trang chi tiết sẽ trả về no_session.")
    return None


def _date_to_dmy(value: Any) -> str:
    """Chuẩn hóa ngày UI/API về dd/mm/yyyy để EMR hiểu đúng tham số denngay."""
    raw = _t(value)
    if not raw:
        return ""
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})$", raw)
    if m:
        return f"{m.group(3).zfill(2)}/{m.group(2).zfill(2)}/{m.group(1)}"
    normalized = normalize_date(raw)
    return normalized or raw


def _xpath_literal(text: str) -> str:
    """Escape chuỗi dùng trong XPath."""
    if "'" not in text:
        return f"'{text}'"
    if '"' not in text:
        return f'"{text}"'
    parts = text.split("'")
    return "concat(" + ", \"'\", ".join(f"'{p}'" for p in parts) + ")"


def _extract_patient_links_from_selenium_page(driver: Any, ma_bn: str) -> Dict[str, str]:
    """Lấy đúng 2 loại link trong dòng BN:
    - doctor: link khi bấm tên người bệnh (wpid=bacsidraw, thường có nextlink=lichsuylenh)
    - nursing: link khi bấm con mắt điều dưỡng (wpid=dieuduongdraw)

    HTML thực tế của EMR có cả 2 link trên cùng một dòng. Không dùng lẫn nhau vì
    buồng giường/VTYT nằm ở trang điều dưỡng, còn y lệnh/bảng kê/giấy tờ dùng link tên BN.
    """
    try:
        from selenium.webdriver.common.by import By  # type: ignore
    except Exception:
        return {}

    code_lit = _xpath_literal(str(ma_bn or "").strip())
    row_xpaths = [
        f"//table[@id='tblNoiTru']//tbody//tr[.//*[contains(normalize-space(), {code_lit})]]",
        f"//table[contains(@id,'NoiTru')]//tr[.//*[contains(normalize-space(), {code_lit})]]",
        f"//tr[.//*[contains(normalize-space(), {code_lit})]]",
    ]
    rows = []
    for xp in row_xpaths:
        try:
            rows = driver.find_elements(By.XPATH, xp)
            if rows:
                break
        except Exception:
            continue

    links: Dict[str, str] = {}
    for row in rows:
        try:
            anchors = row.find_elements(By.XPATH, ".//a[@href]")
        except Exception:
            anchors = []
        for a in anchors:
            href = (a.get_attribute("href") or "").strip()
            if not href or "javascript:" in href.lower():
                continue
            href_l = href.lower()
            text = (a.text or "").strip()
            text_norm = _norm(text)
            cls = (a.get_attribute("class") or "").lower()
            html = (a.get_attribute("innerHTML") or "").lower()
            aid = (a.get_attribute("id") or "").lower()

            # Con mắt điều dưỡng: <a href="...wpid=dieuduongdraw..." class="..."><i class="far fa-eye"></i></a>
            if "wpid=dieuduongdraw" in href_l or "fa-eye" in html:
                links.setdefault("nursing", href)
                continue

            # Tên người bệnh: <a id="btna{noitruid}" href="...wpid=bacsidraw...nextlink=lichsuylenh...">HỌ TÊN</a>
            # Loại trừ các link số thứ tự, ngày giờ, mã BN, tuổi, giới tính, trạng thái...
            looks_like_name_link = (
                aid.startswith("btna")
                or ("wpid=bacsidraw" in href_l and "nextlink=lichsuylenh" in href_l and bool(text_norm)
                    and not re.fullmatch(r"[\d: /-]+", text_norm)
                    and text_norm not in {"nam", "nu", "nữ", "bao hiem", "bao hiem dung tuyen", "dang thuc hien"})
            )
            if looks_like_name_link:
                links.setdefault("doctor", href)

    # Fallback mềm: nếu chỉ bắt được một loại link thì suy ra loại còn lại bằng wpid.
    if links.get("nursing") and not links.get("doctor"):
        links["doctor"] = _as_doctor_url(links["nursing"])
    if links.get("doctor") and not links.get("nursing"):
        links["nursing"] = _as_nursing_url(links["doctor"])
    return links


def _extract_patient_href_from_selenium_page(driver: Any, ma_bn: str) -> str:
    """Tương thích code cũ: trả link bấm tên người bệnh trước."""
    links = _extract_patient_links_from_selenium_page(driver, ma_bn)
    return links.get("doctor") or links.get("nursing") or ""


def _find_patient_links_via_selenium(sess: "EmrHttpSession", ma_bn: str,
                                     config: Dict[str, Any], date_to: str,
                                     inpatient_status: str = "Đang thực hiện",
                                     date_from: str = "") -> Dict[str, str]:
    """Khi HTTP link_map thiếu, mở hoặc dùng lại Chrome để tìm BN theo trạng thái nội trú cần lấy.

    Khác bản cũ: không đóng Chrome sau khi tìm link. Cùng phiên Chrome này sẽ được dùng tiếp
    cho billing/bed_days/order_history/documents để tránh cảnh đóng-mở nhiều cửa sổ.
    """
    ctx = _ensure_hchanh_click_context(sess, ma_bn, config, date_from=date_from, date_to=date_to, reason="link", inpatient_status=inpatient_status)
    if not ctx:
        return {}
    links = dict(ctx.get("links") or {})
    denngay = _date_to_dmy(date_to)
    if denngay:
        links = {k: _upsert_query(v, denngay=denngay) for k, v in links.items() if v}
        ctx["links"] = links

    try:
        driver = ctx.get("driver")
        nav_url = ctx.get("nav_url") or ""
        if driver is not None and hasattr(sess, "import_selenium_cookies"):
            sess.import_selenium_cookies(driver.get_cookies())
        sess._session_inpatient_url = nav_url
        sess.save_cookies(inpatient_list_url=nav_url)
    except Exception:
        pass

    print(
        f"LOG [hchanh-link] Đã tìm được BN {ma_bn}: "
        f"ten_bn={'ok' if links.get('doctor') else 'missing'}, "
        f"mat_dd={'ok' if links.get('nursing') else 'missing'}."
    )
    return links


def _selenium_click_js(driver: Any, element: Any) -> None:
    """Click thật bằng Selenium/JS, dùng cho các màn hình EMR chỉ render dữ liệu sau khi bấm."""
    driver.execute_script("arguments[0].scrollIntoView({block:'center', inline:'center'});", element)
    time.sleep(0.15)
    try:
        element.click()
    except Exception:
        driver.execute_script("arguments[0].click();", element)


def _find_patient_row_for_click(driver: Any, ma_bn: str) -> Any:
    try:
        from selenium.webdriver.common.by import By  # type: ignore
    except Exception as e:
        raise RuntimeError(f"Selenium không khả dụng: {e}")

    code_lit = _xpath_literal(str(ma_bn or "").strip())
    row_xpaths = [
        f"//table[@id='tblNoiTru']//tbody//tr[.//*[contains(normalize-space(), {code_lit})]]",
        f"//table[contains(@id,'NoiTru')]//tr[.//*[contains(normalize-space(), {code_lit})]]",
        f"//tr[.//*[contains(normalize-space(), {code_lit})]]",
    ]
    for xp in row_xpaths:
        rows = driver.find_elements(By.XPATH, xp)
        if rows:
            return rows[0]
    raise RuntimeError(f"Không tìm thấy dòng BN {ma_bn} để bấm mở hồ sơ.")


def _click_patient_entry_from_row(driver: Any, row: Any, kind: str) -> str:
    """Bấm đúng cổng vào hồ sơ từ dòng danh sách.

    kind='nursing' → bấm con mắt điều dưỡng (wpid=dieuduongdraw).
    kind='doctor'  → bấm tên người bệnh (id btna..., wpid=bacsidraw).
    """
    try:
        from selenium.webdriver.common.by import By  # type: ignore
    except Exception as e:
        raise RuntimeError(f"Selenium không khả dụng: {e}")

    wanted = "nursing" if kind == "nursing" else "doctor"
    anchors = row.find_elements(By.XPATH, ".//a[@href]")

    # 1) Con mắt điều dưỡng.
    if wanted == "nursing":
        for a in anchors:
            href = (a.get_attribute("href") or "").strip()
            html = (a.get_attribute("innerHTML") or "").lower()
            if "wpid=dieuduongdraw" in href.lower() or "fa-eye" in html:
                _selenium_click_js(driver, a)
                _selenium_wait_after_action(driver, 1.0, ready_timeout=12)  # type: ignore[misc]
                return getattr(driver, "current_url", "") or href
        raise RuntimeError("Không tìm thấy con mắt điều dưỡng trong dòng BN.")

    # 2) Tên người bệnh.
    for a in anchors:
        href = (a.get_attribute("href") or "").strip()
        text = (a.text or "").strip()
        aid = (a.get_attribute("id") or "").lower()
        href_l = href.lower()
        text_norm = _norm(text)
        looks_name = (
            aid.startswith("btna")
            or ("wpid=bacsidraw" in href_l and "nextlink=lichsuylenh" in href_l and bool(text_norm)
                and not re.fullmatch(r"[\d: /-]+", text_norm)
                and text_norm not in {"nam", "nu", "nữ", "bao hiem", "bao hiem dung tuyen", "dang thuc hien"})
        )
        if looks_name:
            _selenium_click_js(driver, a)
            _selenium_wait_after_action(driver, 1.0, ready_timeout=12)  # type: ignore[misc]
            return getattr(driver, "current_url", "") or href

    raise RuntimeError("Không tìm thấy link tên người bệnh trong dòng BN.")



def _hchanh_action_markers(action: str) -> List[str]:
    act = str(action or "").strip().lower()
    return {
        "documents": ["divContentHSKT", "GetUrlBienBan", "Giấy tờ kèm theo", "GiayToKemTheo"],
        "billing": ["btnSuaChiPhi", "Tổng", "BHYT", "Viện phí"],
        # Với bed_days không được chờ theo chữ "Buồng giường" hoặc id btnBG vì
        # các marker đó đã có sẵn ở menu trước khi click. Phải chờ vùng kết quả
        # sau AJAX: div#vertical-timeline / tiêu đề "Thông tin buồng giường".
        "bed_days": ["vertical-timeline", "Thông tin buồng giường", "thongTinBuongGiuongBtns", "btnPhanBuongGiuong"],
        "order_history": ["lichsuylenh", "Y lệnh", "showAllTrangThaiYLenh"],
        "discharge": ["xutri_form", "divChiTietXuTri", "cbbXuTri", "cboTinhTrangRaVien", "txtThoiGianRa"],
    }.get(act, [])


def _has_hchanh_action_content(driver: Any, action: str) -> bool:
    act = str(action or "").strip().lower()
    markers = _hchanh_action_markers(act)
    try:
        html = getattr(driver, "page_source", "") or ""
    except Exception:
        return False
    if not markers:
        return bool(html)
    if not any(m in html for m in markers):
        return False
    # Với documents cần có vùng nội dung hoặc dấu hiệu bảng/phiếu sau khi AJAX hoàn tất.
    if act == "documents":
        return "divContentHSKT" in html or "GetUrlBienBan" in html or "table" in html.lower()
    return True


def _wait_for_hchanh_action_content(driver: Any, action: str, timeout: float = 10.0) -> bool:
    """Chờ DOM đổi sau khi bấm menu con. Trả True nếu đã thấy marker nội dung."""
    deadline = time.time() + max(1.0, float(timeout or 10.0))
    last_len = 0
    while time.time() < deadline:
        try:
            html = getattr(driver, "page_source", "") or ""
            if _has_hchanh_action_content(driver, action):
                return True
            if not _hchanh_action_markers(action) and len(html) != last_len:
                return True
            last_len = len(html)
        except Exception:
            pass
        time.sleep(0.35)
    return _has_hchanh_action_content(driver, action)



def _looks_like_storage_no(value: Any) -> bool:
    """True nếu giá trị giống số lưu trữ thật, không phải phân loại HSBA.

    Ví dụ hợp lệ: 03/008818/BT/2026, 008818, 8818.
    Ví dụ không hợp lệ: Bình thường, Tai nạn, Hẹn khám.
    """
    s = re.sub(r"\s+", " ", str(value or "").replace("\xa0", " ")).strip()
    if not s:
        return False
    sn = _norm(s)
    if sn in {"binh thuong", "tai nan", "khong", "co", "hen kham", "khong hen kham", "ra vien"}:
        return False
    # Số lưu trữ thực tế luôn có chữ số. Chấp nhận dạng đầy đủ có dấu /
    # hoặc chuỗi số để không loại các bệnh viện ghi ngắn.
    return bool(re.search(r"\d", s))


def _read_xutri_storage_value(driver: Any) -> str:
    """Đọc số lưu trữ trực tiếp từ DOM Ra Khoa.

    EMR có thể gán `txtSoLuuTru.value` bằng JavaScript mà không ghi ra
    attribute value trong HTML. Vì vậy phải đọc property `.value` bằng Selenium,
    không chỉ parse `page_source`.
    """
    try:
        value = driver.execute_script(
            r"""
            const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
            const direct = document.querySelector('#txtSoLuuTru') ||
                           document.querySelector('#txtSoLuuTruBA') ||
                           document.querySelector('#txtSoLuuTruHSBA') ||
                           document.querySelector('#txtSoLuuTruHoSo');
            if (direct) {
              const v = norm(direct.value || direct.getAttribute('value') || direct.textContent || '');
              if (v && /\d/.test(v)) return v;
            }
            const candidates = Array.from(document.querySelectorAll('input, textarea, select'));
            for (const el of candidates) {
              const hay = norm([
                el.id || '', el.name || '', el.getAttribute('placeholder') || '',
                el.getAttribute('aria-label') || '', el.closest('.form-group')?.textContent || ''
              ].join(' ')).toLowerCase();
              if ((hay.includes('lưu') || hay.includes('luu')) && (hay.includes('trữ') || hay.includes('tru'))) {
                const tag = (el.tagName || '').toLowerCase();
                let v = '';
                if (tag === 'select') {
                  const opt = el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
                  v = norm((opt && opt.textContent) || el.value || '');
                } else {
                  v = norm(el.value || el.getAttribute('value') || el.textContent || '');
                }
                if (v && /\d/.test(v)) return v;
              }
            }
            return '';
            """
        )
        return re.sub(r"\s+", " ", str(value or "")).strip()
    except Exception:
        return ""


def _wait_for_xutri_storage_probe(driver: Any, timeout: float = 5.0) -> str:
    """Chờ ngắn để EMR kịp gán số lưu trữ sau khi mở Ra Khoa.

    Nếu hồ sơ thật sự chưa có số lưu trữ thì trả rỗng sau timeout; không xem là
    lỗi kỹ thuật, UI sẽ hiển thị “Thiếu số lưu trữ”.
    """
    deadline = time.time() + max(0.5, float(timeout or 5.0))
    last_value = ""
    stable_hits = 0
    while time.time() < deadline:
        value = _read_xutri_storage_value(driver)
        if value:
            if value == last_value:
                stable_hits += 1
            else:
                stable_hits = 0
                last_value = value
            if stable_hits >= 1:
                return value
        time.sleep(0.35)
    return last_value

def _click_documents_action(driver: Any) -> bool:
    """Bấm đúng menu Thông tin chung → Giấy tờ kèm theo.

    Hàm JS onShowGiayToKemTheo(this) cần nhận chính thẻ <a> trong menu,
    không nên truyền document.body vì có thể không render bảng giấy tờ.
    """
    try:
        from selenium.webdriver.common.by import By  # type: ignore
    except Exception:
        return False

    # Mở nhóm "Thông tin chung" nếu menu đang bị thu gọn.
    try:
        driver.execute_script(
            """
            const anchors = Array.from(document.querySelectorAll('a'));
            const header = anchors.find(a => (a.textContent || '').trim().includes('Thông tin chung'));
            if (header) {
              const li = header.closest('li');
              if (li) {
                const ul = li.querySelector('ul');
                if (ul) ul.style.display = '';
                li.classList.add('active');
              }
            }
            """
        )
    except Exception:
        pass

    xps = [
        "//a[contains(@onclick,'onShowGiayToKemTheo')]",
        "//a[contains(@onclick,'GiayToKemTheo')]",
        "//a[normalize-space()='Giấy tờ kèm theo']",
        "//*[self::a or self::button or self::span][contains(normalize-space(),'Giấy tờ kèm theo')]",
    ]

    candidates = []
    seen = set()
    for xp in xps:
        try:
            for el in driver.find_elements(By.XPATH, xp):
                key = getattr(el, 'id', None) or (el.get_attribute('outerHTML') or '')[:200]
                if key in seen:
                    continue
                seen.add(key)
                candidates.append(el)
        except Exception:
            continue

    last_err = None
    for el in candidates:
        try:
            onclick = el.get_attribute('onclick') or ''
            text = (el.text or el.get_attribute('textContent') or '').strip()
            if 'onShowGiayToKemTheo' not in onclick and 'Giấy tờ kèm theo' not in text:
                continue
            # Ưu tiên gọi đúng function với đúng `this`. Nếu function không có thì click element.
            before_handles = list(getattr(driver, "window_handles", []) or [])
            driver.execute_script(
                """
                const a = arguments[0];
                try {
                  a.scrollIntoView({block:'center', inline:'center'});
                } catch(e) {}
                if (typeof onShowGiayToKemTheo === 'function') {
                  onShowGiayToKemTheo(a);
                  return true;
                }
                try { a.click(); return true; } catch(e) {}
                return false;
                """,
                el,
            )
            _switch_to_new_tab_if_any(driver, before_handles, timeout=3.0)
            _selenium_wait_after_action(driver, 1.0, ready_timeout=12)  # type: ignore[misc]
            _wait_for_hchanh_action_content(driver, 'documents', timeout=12)
            return True
        except Exception as e:
            last_err = e
            continue

    # Fallback cuối: tự tìm anchor bằng JS và gọi function với anchor đó.
    try:
        before_handles = list(getattr(driver, "window_handles", []) or [])
        ok = bool(driver.execute_script(
            """
            const a = Array.from(document.querySelectorAll('a')).find(x => {
              const oc = x.getAttribute('onclick') || '';
              const tx = (x.textContent || '').trim();
              return oc.includes('onShowGiayToKemTheo') || tx.includes('Giấy tờ kèm theo');
            });
            if (!a) return false;
            if (typeof onShowGiayToKemTheo === 'function') { onShowGiayToKemTheo(a); return true; }
            a.click();
            return true;
            """
        ))
        if ok:
            _switch_to_new_tab_if_any(driver, before_handles, timeout=3.0)
            _selenium_wait_after_action(driver, 1.0, ready_timeout=12)  # type: ignore[misc]
            _wait_for_hchanh_action_content(driver, 'documents', timeout=12)
            return True
    except Exception as e:
        last_err = e

    print(f"WARN [hchanh-click] Không bấm được menu Giấy tờ kèm theo: {last_err}", file=sys.stderr)
    return False


def _open_discharge_group(driver: Any) -> None:
    """Mở nhóm Tổng kết/Ra khoa nếu menu bên trái đang bị thu gọn."""
    try:
        driver.execute_script(
            r"""
            const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
            const lower = (s) => norm(s).toLowerCase();
            const anchors = Array.from(document.querySelectorAll('a'));
            const targets = anchors.filter(a => {
              const tx = lower(a.textContent);
              const oc = lower(a.getAttribute('onclick') || '');
              return tx.includes('tổng kết') || tx.includes('tong ket')
                  || tx.includes('ra khoa') || tx.includes('ra viện') || tx.includes('ra vien')
                  || oc.includes('onshowxutri');
            });
            for (const a of targets) {
              let li = a.closest('li');
              while (li) {
                li.classList.add('active', 'selected', 'open');
                const ul = li.querySelector(':scope > ul, :scope > .submenu, :scope > .collapse');
                if (ul) {
                  ul.style.display = 'block';
                  ul.classList.add('show', 'in');
                }
                const wrap = li.querySelector('.accordion-btn-wrap');
                if (wrap) wrap.classList.add('accordion-active');
                li = li.parentElement ? li.parentElement.closest('li') : null;
              }
            }
            return targets.length;
            """
        )
    except Exception:
        pass


def _click_discharge_action(driver: Any) -> bool:
    """Bấm đúng Tổng kết → Ra Khoa.

    HTML thực tế có dạng:
        <a onclick="onShowXuTri(this);">Ra Khoa</a>

    Vì vậy không được fallback bằng onShowXuTri(document.body). Hàm onShowXuTri cần
    chính thẻ <a> để xác định context/menu và render form ra khoa.
    """
    try:
        from selenium.webdriver.common.by import By  # type: ignore
    except Exception:
        return False

    _open_discharge_group(driver)

    xps = [
        "//a[contains(@onclick,'onShowXuTri')]",
        "//a[normalize-space()='Ra Khoa']",
        "//a[contains(normalize-space(),'Ra Khoa')]",
        "//*[self::a or self::button or self::span or self::li][contains(normalize-space(),'Ra Khoa')]",
        "//*[contains(@onclick,'TONGKETRAKHOA')]",
        "//*[self::a or self::button or self::span or self::li][contains(normalize-space(),'Tổng kết ra khoa')]",
    ]

    candidates = []
    seen = set()
    for xp in xps:
        try:
            for el in driver.find_elements(By.XPATH, xp):
                key = (el.get_attribute('outerHTML') or '')[:300]
                if key in seen:
                    continue
                seen.add(key)
                candidates.append(el)
        except Exception:
            continue

    last_err = None
    for el in candidates:
        try:
            before_handles = list(getattr(driver, "window_handles", []) or [])
            ret = driver.execute_script(
                r"""
                const raw = arguments[0];
                const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
                const node = raw && raw.closest ? raw : null;
                const a = node ? (node.matches('a,[onclick]') ? node : node.closest('a,[onclick]')) : null;
                if (!a) return 'no-anchor';

                let li = a.closest('li');
                while (li) {
                  li.classList.add('active', 'selected', 'open');
                  const ul = li.querySelector(':scope > ul, :scope > .submenu, :scope > .collapse');
                  if (ul) {
                    ul.style.display = 'block';
                    ul.classList.add('show', 'in');
                  }
                  li = li.parentElement ? li.parentElement.closest('li') : null;
                }
                try { a.scrollIntoView({block:'center', inline:'center'}); } catch(e) {}

                // Ưu tiên gọi đúng hàm với đúng this = thẻ <a> Ra Khoa.
                if (typeof onShowXuTri === 'function') {
                  onShowXuTri(a);
                  return 'onShowXuTri(anchor)';
                }
                try { a.click(); return 'click(anchor)'; } catch(e) {}
                return 'failed';
                """,
                el,
            )
            if ret and ret != 'failed':
                _switch_to_new_tab_if_any(driver, before_handles, timeout=3.0)
                _selenium_wait_after_action(driver, 1.0, ready_timeout=12)  # type: ignore[misc]
                if _wait_for_hchanh_action_content(driver, 'discharge', timeout=18):
                    print(f"LOG [hchanh-click] Đã mở Ra Khoa bằng {ret}.")
                    return True
        except Exception as e:
            last_err = e
            continue

    # Fallback cuối: tìm anchor trực tiếp trong DOM, kể cả khi menu ẩn/collapsed.
    try:
        before_handles = list(getattr(driver, "window_handles", []) or [])
        ret = driver.execute_script(
            r"""
            const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
            const lower = (s) => norm(s).toLowerCase();
            const anchors = Array.from(document.querySelectorAll('a'));
            const a = anchors.find(x => {
              const oc = lower(x.getAttribute('onclick') || '');
              const tx = lower(x.textContent || '');
              return oc.includes('onshowxutri') || tx === 'ra khoa' || tx.includes('ra khoa');
            });
            if (!a) return '';
            let li = a.closest('li');
            while (li) {
              li.classList.add('active', 'selected', 'open');
              const ul = li.querySelector(':scope > ul, :scope > .submenu, :scope > .collapse');
              if (ul) {
                ul.style.display = 'block';
                ul.classList.add('show', 'in');
              }
              li = li.parentElement ? li.parentElement.closest('li') : null;
            }
            try { a.scrollIntoView({block:'center', inline:'center'}); } catch(e) {}
            if (typeof onShowXuTri === 'function') {
              onShowXuTri(a);
              return 'onShowXuTri(anchor-js)';
            }
            try { a.click(); return 'click(anchor-js)'; } catch(e) {}
            return '';
            """
        )
        if ret:
            _switch_to_new_tab_if_any(driver, before_handles, timeout=3.0)
            _selenium_wait_after_action(driver, 1.0, ready_timeout=12)  # type: ignore[misc]
            if _wait_for_hchanh_action_content(driver, 'discharge', timeout=18):
                print(f"LOG [hchanh-click] Đã mở Ra Khoa bằng {ret}.")
                return True
    except Exception as e:
        last_err = e

    print(f"WARN [hchanh-click] Không mở được Tổng kết → Ra Khoa/onShowXuTri(this): {last_err}", file=sys.stderr)
    return False


def _open_cham_soc_group(driver: Any) -> None:
    """Mở nhóm menu Chăm sóc trong trang con mắt điều dưỡng.

    EMR có lúc nhóm Chăm sóc đang đóng, hoặc chỉ phần ul bị display:none.
    Buồng giường nằm đúng trong nhóm này: a#btnBG onclick=onShowBuongGiuong(this).
    """
    try:
        driver.execute_script(
            r"""
            const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
            const anchors = Array.from(document.querySelectorAll('a'));
            const header = anchors.find(a => norm(a.textContent).toLowerCase() === 'chăm sóc');
            if (!header) return false;
            const li = header.closest('li');
            if (!li) return false;
            li.classList.add('active', 'selected');
            const ul = li.querySelector('ul');
            if (ul) ul.style.display = 'block';
            const wrap = li.querySelector('.accordion-btn-wrap');
            if (wrap) wrap.classList.add('accordion-active');
            return true;
            """
        )
    except Exception:
        pass


def _has_bed_timeline_html(html: str) -> bool:
    h = str(html or '')
    return (
        'id="vertical-timeline"' in h
        or "id='vertical-timeline'" in h
        or 'Thông tin buồng giường' in h
        or 'thongTinBuongGiuongBtns' in h
        or 'btnPhanBuongGiuong' in h
    ) and ('Trạng thái:' in h or 'vertical-timeline' in h)


def _wait_for_bed_days_content(driver: Any, timeout: float = 15.0) -> bool:
    deadline = time.time() + max(1.0, float(timeout or 15.0))
    last_len = 0
    while time.time() < deadline:
        try:
            html = getattr(driver, 'page_source', '') or ''
            if _has_bed_timeline_html(html):
                return True
            # Nếu DOM đang đổi thì chờ thêm một nhịp AJAX.
            if len(html) != last_len:
                last_len = len(html)
        except Exception:
            pass
        time.sleep(0.35)
    return False


def _click_bed_days_action(driver: Any) -> bool:
    """Bấm đúng Chăm sóc → Buồng giường trong trang điều dưỡng.

    Không dùng XPath theo chữ chung chung vì chữ "Buồng giường" có thể nằm ở menu
    trước khi dữ liệu load, khiến code tưởng đã vào trang. Ưu tiên đúng:
        <a id="btnBG" onclick="onShowBuongGiuong(this);">Buồng giường</a>
    và gọi function với chính element đó làm `this`.
    """
    try:
        from selenium.webdriver.common.by import By  # type: ignore
    except Exception:
        return False

    _open_cham_soc_group(driver)

    candidates = []
    xps = [
        "//*[@id='btnBG']",
        "//a[contains(@onclick,'onShowBuongGiuong')]",
        "//a[normalize-space()='Buồng giường']",
    ]
    seen = set()
    for xp in xps:
        try:
            for el in driver.find_elements(By.XPATH, xp):
                key = (el.get_attribute('id') or '') + '|' + ((el.get_attribute('onclick') or '')[:80])
                if not key.strip():
                    key = (el.get_attribute('outerHTML') or '')[:120]
                if key in seen:
                    continue
                seen.add(key)
                candidates.append(el)
        except Exception:
            continue

    last_err = None
    for el in candidates:
        try:
            onclick = el.get_attribute('onclick') or ''
            text = (el.text or el.get_attribute('textContent') or '').strip()
            if 'onShowBuongGiuong' not in onclick and text != 'Buồng giường':
                continue
            before_handles = list(getattr(driver, 'window_handles', []) or [])
            ok = bool(driver.execute_script(
                """
                const a = arguments[0];
                try { a.scrollIntoView({block:'center', inline:'center'}); } catch(e) {}
                if (typeof onShowBuongGiuong === 'function') {
                  onShowBuongGiuong(a);
                  return true;
                }
                try { a.click(); return true; } catch(e) {}
                return false;
                """,
                el,
            ))
            if not ok:
                _selenium_click_js(driver, el)
            _switch_to_new_tab_if_any(driver, before_handles, timeout=3.0)
            _selenium_wait_after_action(driver, 1.0, ready_timeout=12)  # type: ignore[misc]
            if _wait_for_bed_days_content(driver, timeout=15):
                print("LOG [hchanh-click] Đã vào Chăm sóc → Buồng giường.")
            else:
                print("WARN [hchanh-click] Đã bấm Buồng giường nhưng chưa thấy vertical-timeline.", file=sys.stderr)
            return True
        except Exception as e:
            last_err = e
            continue

    # Fallback JS: tự tìm a#btnBG hoặc onclick=onShowBuongGiuong rồi gọi function.
    try:
        before_handles = list(getattr(driver, 'window_handles', []) or [])
        ok = bool(driver.execute_script(
            r"""
            const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
            const a = document.querySelector('#btnBG') ||
                      Array.from(document.querySelectorAll('a')).find(x => {
                        const oc = x.getAttribute('onclick') || '';
                        return oc.includes('onShowBuongGiuong') || norm(x.textContent) === 'Buồng giường';
                      });
            if (!a) return false;
            try { a.scrollIntoView({block:'center', inline:'center'}); } catch(e) {}
            if (typeof onShowBuongGiuong === 'function') { onShowBuongGiuong(a); return true; }
            a.click();
            return true;
            """
        ))
        if ok:
            _switch_to_new_tab_if_any(driver, before_handles, timeout=3.0)
            _selenium_wait_after_action(driver, 1.0, ready_timeout=12)  # type: ignore[misc]
            _wait_for_bed_days_content(driver, timeout=15)
            return True
    except Exception as e:
        last_err = e

    print(f"WARN [hchanh-click] Không bấm được Chăm sóc → Buồng giường: {last_err}", file=sys.stderr)
    return False

def _click_hchanh_action(driver: Any, action: str) -> bool:
    """Bấm tab/nút con sau khi đã mở hồ sơ.

    EMR nhiều chỗ không trả dữ liệu chỉ bằng requests GET; phải click nút để JS gọi AJAX
    rồi mới có bảng/form trong DOM. Hàm này ưu tiên id/onclick đã thấy trong HTML thực tế.
    """
    try:
        from selenium.webdriver.common.by import By  # type: ignore
    except Exception:
        return False

    act = str(action or "").strip().lower()
    if not act or act in {"profile", "order_history"}:
        return True
    if act == "documents":
        return _click_documents_action(driver)
    if act == "discharge":
        return _click_discharge_action(driver)
    if act == "bed_days":
        return _click_bed_days_action(driver)

    xpath_map = {
        "bed_days": [
            "//*[@id='btnBG']",
            "//*[contains(@onclick,'BUONGGIUONG')]",
            "//*[self::a or self::button or self::span or self::li][contains(normalize-space(),'Buồng giường')]",
        ],
        "vtyt": [
            "//*[contains(@onclick,'CHIDINHTHUOCVTYT')]",
            "//*[self::a or self::button or self::span or self::li][contains(normalize-space(),'VTYT')]",
            "//*[self::a or self::button or self::span or self::li][contains(normalize-space(),'Thêm thuốc')]",
        ],
        "billing": [
            "//*[@id='btnSuaChiPhi']",
            "//*[contains(@onclick,'OnSuaChiPhi')]",
            "//*[contains(@onclick,'XEMCHIPHI')]",
            "//*[self::a or self::button or self::span or self::li][contains(normalize-space(),'Xem chi phí')]",
            "//*[self::a or self::button or self::span or self::li][contains(normalize-space(),'Chi phí')]",
        ],
        "documents": [
            "//*[contains(@onclick,'onShowGiayToKemTheo')]",
            "//*[contains(@onclick,'GiayToKemTheo')]",
            "//*[self::a or self::button or self::span or self::li][contains(normalize-space(),'Giấy tờ kèm theo')]",
            "//*[self::a or self::button or self::span or self::li][contains(normalize-space(),'Giấy tờ')]",
        ],
        "discharge": [
            "//*[contains(@onclick,'onShowXuTri')]",
            "//*[contains(@onclick,'TONGKETRAKHOA')]",
            "//*[self::a or self::button or self::span or self::li][contains(normalize-space(),'Ra Khoa')]",
            "//*[self::a or self::button or self::span or self::li][contains(normalize-space(),'Tổng kết ra khoa')]",
            "//*[self::a or self::button or self::span or self::li][contains(normalize-space(),'Ra viện')]",
        ],
    }
    xps = xpath_map.get(act, [])
    before_handles = list(getattr(driver, "window_handles", []) or [])

    last_err: Optional[Exception] = None
    for xp in xps:
        try:
            els = driver.find_elements(By.XPATH, xp)
            for el in els:
                try:
                    if not el.is_displayed():
                        continue
                except Exception:
                    pass
                _selenium_click_js(driver, el)
                _selenium_wait_after_action(driver, 1.2, ready_timeout=12)  # type: ignore[misc]
                # Một số nút mở tab mới: bảng kê, sửa giấy tờ kèm theo...
                _switch_to_new_tab_if_any(driver, before_handles, timeout=5.0)
                if _wait_for_hchanh_action_content(driver, act, timeout=12):
                    return True
        except Exception as e:
            last_err = e
            continue

    # Fallback gọi hàm JS nếu nút bị ẩn nhưng function có sẵn trên trang.
    js_map = {
        "documents": "const a = Array.from(document.querySelectorAll('a')).find(x => (x.getAttribute('onclick')||'').includes('onShowGiayToKemTheo') || (x.textContent||'').includes('Giấy tờ kèm theo')); if (a && typeof onShowGiayToKemTheo === 'function') { onShowGiayToKemTheo(a); return true; } if (a) { a.click(); return true; } return false;",
        "discharge": "const a = Array.from(document.querySelectorAll('a')).find(x => ((x.getAttribute('onclick')||'').includes('onShowXuTri') || (x.textContent||'').trim().includes('Ra Khoa'))); if (a && typeof onShowXuTri === 'function') { onShowXuTri(a); return true; } if (a) { a.click(); return true; } return false;",
        "billing": "if (typeof OnSuaChiPhi === 'function') { OnSuaChiPhi(); return true; } return false;",
    }
    if act in js_map:
        try:
            before_handles = list(getattr(driver, "window_handles", []) or [])
            ok = bool(driver.execute_script(js_map[act]))
            if ok:
                _switch_to_new_tab_if_any(driver, before_handles, timeout=5.0)
                _selenium_wait_after_action(driver, 1.2, ready_timeout=12)  # type: ignore[misc]
                if _wait_for_hchanh_action_content(driver, act, timeout=12):
                    return True
        except Exception as e:
            last_err = e

    print(f"WARN [hchanh-click] Không bấm được action '{action}': {last_err}", file=sys.stderr)
    return False




# Cache Chrome trong suốt 1 lần chạy hchanh_fetch.py.
# Node thường gọi một worker cho một BN và nhiều file cùng lúc; nếu mỗi file tự mở Chrome
# thì vừa rối màn hình vừa tốn thời gian. Cache này giúp mở Chrome 1 lần, lấy đủ các mục,
# sau đó atexit mới đóng.
_HCHANH_CLICK_CACHE: Dict[str, Any] = {}


def _is_driver_alive(driver: Any) -> bool:
    try:
        _ = driver.current_url
        return True
    except Exception:
        return False


def _shutdown_hchanh_click_driver() -> None:
    driver = _HCHANH_CLICK_CACHE.get("driver")
    if driver is not None:
        try:
            driver.quit()
        except Exception:
            pass
    _HCHANH_CLICK_CACHE.clear()


atexit.register(_shutdown_hchanh_click_driver)


def _close_extra_tabs(driver: Any, keep_handle: str = "") -> None:
    """Đóng các tab phụ do Bảng kê/Sửa giấy tờ mở ra, giữ lại tab chính để lấy mục tiếp theo."""
    try:
        handles = list(driver.window_handles)
    except Exception:
        return
    if not handles:
        return
    if not keep_handle or keep_handle not in handles:
        keep_handle = handles[0]
    for h in list(handles):
        if h == keep_handle:
            continue
        try:
            driver.switch_to.window(h)
            driver.close()
        except Exception:
            pass
    try:
        driver.switch_to.window(keep_handle)
    except Exception:
        pass


def _switch_to_new_tab_if_any(driver: Any, before_handles: List[str], timeout: float = 5.0) -> bool:
    """Nếu thao tác vừa bấm mở tab mới, chuyển sang tab mới và chờ trang load."""
    deadline = time.time() + max(0.5, float(timeout or 5.0))
    before = set(before_handles or [])
    while time.time() < deadline:
        try:
            handles = list(driver.window_handles)
            new_handles = [h for h in handles if h not in before]
            if new_handles:
                driver.switch_to.window(new_handles[-1])
                try:
                    _selenium_wait_after_action(driver, 0.8, ready_timeout=12)  # type: ignore[misc]
                except Exception:
                    time.sleep(0.8)
                print("LOG [hchanh-tab] Đã chuyển sang tab mới do EMR mở sau khi bấm.")
                return True
        except Exception:
            pass
        time.sleep(0.2)
    return False


def _ensure_hchanh_click_context(sess: Optional["EmrHttpSession"], ma_bn: str,
                                 config: Dict[str, Any], date_to: str = "",
                                 reason: str = "click",
                                 inpatient_status: str = "Đang thực hiện",
                                 date_from: str = "") -> Optional[Dict[str, Any]]:
    """Mở hoặc dùng lại Chrome, đăng nhập và tìm đúng BN theo trạng thái nội trú."""
    if not (_HAS_SELENIUM_LOGIN and _HAS_SELENIUM_SEARCH):
        print("WARN [hchanh-click] Không đủ Selenium helper để thao tác trên EMR.", file=sys.stderr)
        return None

    code = str(ma_bn or "").strip()
    wanted_status = _t(inpatient_status, "Đang thực hiện")
    existing = _HCHANH_CLICK_CACHE.get("driver")
    wanted_from = _date_to_dmy(date_from) or str(date_from or "").strip()
    wanted_to = _date_to_dmy(date_to) or str(date_to or "").strip()
    direct_links_cfg = config.get("hchanh_direct_links") if isinstance(config.get("hchanh_direct_links"), dict) else {}
    direct_noitruid = _t(config.get("hchanh_target_noitruid") or config.get("records_check_noitruid"))
    direct_case_key = _t(config.get("hchanh_target_case_key") or config.get("records_check_case_key"))
    cache_same_direct = (
        _t(_HCHANH_CLICK_CACHE.get("direct_noitruid")) == direct_noitruid
        and _t(_HCHANH_CLICK_CACHE.get("direct_case_key")) == direct_case_key
    )
    if (existing is not None and _HCHANH_CLICK_CACHE.get("ma_bn") == code
            and _HCHANH_CLICK_CACHE.get("inpatient_status") == wanted_status
            and _HCHANH_CLICK_CACHE.get("date_from") == wanted_from
            and _HCHANH_CLICK_CACHE.get("date_to") == wanted_to
            and (not direct_links_cfg or cache_same_direct)
            and _is_driver_alive(existing)):
        print(f"LOG [hchanh-click] Dùng lại Chrome đang mở cho BN {code} | trạng thái={wanted_status}.")
        return _HCHANH_CLICK_CACHE

    # Nếu đang giữ Chrome của BN khác/lượt khác hoặc Chrome đã chết thì đóng sạch trước.
    if existing is not None:
        _shutdown_hchanh_click_driver()

    hchanh_config = _build_hchanh_config(config)
    headless = _cfg_bool(
        hchanh_config.get("hchanh_click_headless"),
        _cfg_bool(hchanh_config.get("hchanh_link_headless"), False),
    )
    direct_links_cfg = config.get("hchanh_direct_links") if isinstance(config.get("hchanh_direct_links"), dict) else {}
    direct_noitruid = _t(config.get("hchanh_target_noitruid") or config.get("records_check_noitruid"))
    direct_case_key = _t(config.get("hchanh_target_case_key") or config.get("records_check_case_key"))
    if _WorkerSession is None:
        raise RuntimeError("WorkerSession không khả dụng; cài selenium.")
    # WorkerSession chỉ đọc key `headless`; nếu không set key này thì dù hchanh_click_headless=True
    # Chrome vẫn mở cửa sổ theo config/headless=false.
    hchanh_config = {**hchanh_config, "headless": headless}
    _ws_click = _WorkerSession(hchanh_config, "/dev/null")
    driver = wait = None
    denngay = _date_to_dmy(date_to)
    try:
        action_text = "tìm link BN" if reason == "link" else "lấy dữ liệu hành chánh"
        print(f"LOG [hchanh-click] Mở Chrome một lần để {action_text}; BN={code}; headless={headless}.")
        _ws_click.__enter__()
        driver, wait = _ws_click.driver, _ws_click.wait
        nav_url = _selenium_goto_inpatient_list(       # type: ignore[misc]
            driver, wait, hchanh_config,
            login_func=login_emr,
            log_func=print,
        )
        try:
            if sess is not None and hasattr(sess, "import_selenium_cookies"):
                sess.import_selenium_cookies(driver.get_cookies())
                sess._session_inpatient_url = nav_url
                sess.save_cookies(inpatient_list_url=nav_url)
        except Exception:
            pass

        # Kiểm hồ sơ đã lưu sẵn link/noitruid của từng dòng Hoàn tất khi quét danh sách.
        # Nếu dùng lại quy trình tìm theo mã BN, EMR thường trả dòng đầu tiên của BN đó
        # (có thể là dòng chuyển khoa/phòng mổ), nên số lưu trữ ở Ra Khoa bị trống.
        # Vì vậy ưu tiên link trực tiếp này để mở đúng lượt điều trị.
        if direct_links_cfg:
            # Link được lưu từ phiên Chrome quét danh sách. Tự động thay usid/st
            # bằng phiên Chrome hiện tại trước khi mở, nếu không EMR sẽ redirect
            # về login.aspx dù link vẫn có noitruid đúng.
            links = {
                k: _rebase_emr_patient_url(_t(v), nav_url)
                for k, v in dict(direct_links_cfg).items()
                if k in {"doctor", "nursing"} and _t(v)
            }
            if links.get("doctor") and not links.get("nursing"):
                links["nursing"] = _as_nursing_url(links["doctor"])
            if links.get("nursing") and not links.get("doctor"):
                links["doctor"] = _as_doctor_url(links["nursing"])
            if links:
                if denngay:
                    links = {k: _upsert_query(v, denngay=denngay) for k, v in links.items() if v}
                main_handle = ""
                try:
                    main_handle = driver.current_window_handle
                except Exception:
                    pass
                _HCHANH_CLICK_CACHE.clear()
                _HCHANH_CLICK_CACHE.update({
                    "driver": driver,
                    "wait": wait,
                    "config": hchanh_config,
                    "ma_bn": code,
                    "links": links,
                    "nav_url": nav_url,
                    "main_handle": main_handle,
                    "inpatient_status": wanted_status,
                    "date_from": wanted_from,
                    "date_to": wanted_to,
                    "direct_noitruid": direct_noitruid,
                    "direct_case_key": direct_case_key,
                })
                print(
                    f"LOG [hchanh-click] Dùng link trực tiếp từ dòng scan Hoàn tất cho BN {code}: "
                    f"noitruid={direct_noitruid or '—'}; "
                    f"ten_bn={'ok' if links.get('doctor') else 'missing'}, "
                    f"mat_dd={'ok' if links.get('nursing') else 'missing'}."
                )
                return _HCHANH_CLICK_CACHE

        _selenium_set_status_filter(driver, wait, wanted_status, log_func=print)  # type: ignore[misc]
        if (date_from or date_to) and _selenium_set_time_range_filter is not None:
            _selenium_set_time_range_filter(driver, wait, date_from or date_to, date_to or date_from, log_func=print)  # type: ignore[misc]
        _selenium_search_patient(  # type: ignore[misc]
            driver, wait, hchanh_config, code,
            login_func=login_emr,
            log_func=print,
            after_enter_seconds=1.5,
        )
        try:
            _selenium_wait_after_action(driver, 0.5, ready_timeout=8)  # type: ignore[misc]
        except Exception:
            pass
        if not bool(_selenium_patient_row_exists(driver, code)):  # type: ignore[misc]
            print(f"WARN [hchanh-click] Không thấy BN {code} ở trạng thái {wanted_status}.", file=sys.stderr)
            try:
                _ws_click.__exit__(None, None, None)
            except Exception:
                pass
            return None

        links = _extract_patient_links_from_selenium_page(driver, code)
        if denngay:
            links = {k: _upsert_query(v, denngay=denngay) for k, v in links.items() if v}
        if not links:
            print(f"WARN [hchanh-click] Thấy BN {code} nhưng không lấy được link tên BN/con mắt điều dưỡng.", file=sys.stderr)
            try:
                _ws_click.__exit__(None, None, None)
            except Exception:
                pass
            return None

        main_handle = ""
        try:
            main_handle = driver.current_window_handle
        except Exception:
            pass

        _HCHANH_CLICK_CACHE.clear()
        _HCHANH_CLICK_CACHE.update({
            "driver": driver,
            "wait": wait,
            "config": hchanh_config,
            "ma_bn": code,
            "links": links,
            "nav_url": nav_url,
            "main_handle": main_handle,
            "inpatient_status": wanted_status,
            "date_from": wanted_from,
            "date_to": wanted_to,
        })
        print(
            f"LOG [hchanh-click] Sẵn sàng thao tác BN {code}: "
            f"ten_bn={'ok' if links.get('doctor') else 'missing'}, "
            f"mat_dd={'ok' if links.get('nursing') else 'missing'}."
        )
        return _HCHANH_CLICK_CACHE
    except Exception as e:
        print(f"ERROR [hchanh-click] Không khởi tạo được Chrome dùng chung: {type(e).__name__}: {e}", file=sys.stderr)
        try:
            _ws_click.__exit__(None, None, None)
        except Exception:
            pass
        return None


def _open_patient_entry_from_context(ctx: Dict[str, Any], entry_kind: str, date_to: str = "") -> str:
    """Mở đúng cổng vào hồ sơ từ link đã lấy: tên BN hoặc con mắt điều dưỡng."""
    driver = ctx.get("driver")
    if driver is None:
        raise RuntimeError("Chrome context không có driver.")
    main_handle = str(ctx.get("main_handle") or "")
    _close_extra_tabs(driver, main_handle)

    links = dict(ctx.get("links") or {})
    wanted = "nursing" if entry_kind == "nursing" else "doctor"
    url = links.get(wanted) or (links.get("nursing") if wanted == "nursing" else links.get("doctor")) or ""
    if not url:
        raise RuntimeError(f"Không có link {'con mắt điều dưỡng' if wanted == 'nursing' else 'tên người bệnh'}.")
    # Luôn rebase thêm một lần ngay trước khi mở để bảo đảm ctx không giữ link
    # của phiên quét cũ sau khi Chrome được đăng nhập lại.
    nav_url = str(ctx.get("nav_url") or "")
    url = _rebase_emr_patient_url(url, nav_url)
    denngay = _date_to_dmy(date_to)
    if denngay:
        url = _upsert_query(url, denngay=denngay)
    links[wanted] = url
    ctx["links"] = links

    driver.get(url)
    try:
        _selenium_wait_after_action(driver, 1.0, ready_timeout=12)  # type: ignore[misc]
    except Exception:
        time.sleep(1.0)

    current_url = getattr(driver, "current_url", "") or ""
    if _is_emr_login_url(current_url):
        # Một số phiên EMR chỉ nhận lại token sau khi quay về URL danh sách hiện
        # tại. Thử phục hồi một lần; nếu vẫn login thì báo lỗi rõ, không tiếp tục
        # parse trang login thành discharge/CLS rỗng.
        print(
            f"WARN [hchanh-click] Link {wanted} bị chuyển về login.aspx; "
            "đang ghép lại link bằng phiên hiện tại và thử lại.",
            file=sys.stderr,
        )
        if nav_url:
            driver.get(nav_url)
            try:
                _selenium_wait_after_action(driver, 0.8, ready_timeout=10)  # type: ignore[misc]
            except Exception:
                time.sleep(0.8)
        retry_url = _rebase_emr_patient_url(url, nav_url or getattr(driver, "current_url", ""))
        if denngay:
            retry_url = _upsert_query(retry_url, denngay=denngay)
        driver.get(retry_url)
        try:
            _selenium_wait_after_action(driver, 1.0, ready_timeout=12)  # type: ignore[misc]
        except Exception:
            time.sleep(1.0)
        current_url = getattr(driver, "current_url", "") or ""
        if _is_emr_login_url(current_url):
            raise RuntimeError(
                "EMR từ chối link hồ sơ do phiên đăng nhập không hợp lệ; "
                "không tiếp tục đọc trang login như dữ liệu người bệnh."
            )
        url = retry_url
        links[wanted] = retry_url
        ctx["links"] = links

    try:
        ctx["main_handle"] = driver.current_window_handle
    except Exception:
        pass
    ctx["current_entry"] = wanted
    return current_url or url
def _fetch_hchanh_html_by_click(sess: Optional["EmrHttpSession"], ma_bn: str, config: Dict[str, Any],
                                entry_kind: str, action: str = "", date_to: str = "",
                                inpatient_status: str = "", date_from: str = "") -> Optional[Dict[str, Any]]:
    """Dùng Chrome dùng chung để mở đúng hồ sơ rồi bấm action cần thiết.

    - Không đóng/mở Chrome cho từng mục nữa.
    - Buồng giường/VTYT: mở cổng con mắt điều dưỡng.
    - Bảng kê/Y lệnh/Giấy tờ: mở cổng tên người bệnh.
    - Nếu EMR mở tab mới sau khi bấm Bảng kê hoặc Sửa giấy tờ, helper sẽ tự switch sang tab mới.
    """
    ctx = _ensure_hchanh_click_context(sess, ma_bn, config, date_from=date_from, date_to=date_to, reason="click", inpatient_status=(inpatient_status or config.get("hchanh_inpatient_status") or "Đang thực hiện"))
    if not ctx:
        return None

    driver = ctx.get("driver")
    nav_url = str(ctx.get("nav_url") or "")
    if driver is None:
        return None

    try:
        opened_url = _open_patient_entry_from_context(ctx, "nursing" if entry_kind == "nursing" else "doctor", date_to=date_to)
        print(f"LOG [hchanh-click] Mở {'con mắt điều dưỡng' if entry_kind == 'nursing' else 'tên người bệnh'}: {opened_url}")

        if date_to:
            print(f"LOG [hchanh-click] Mốc ngày kiểm tra: {date_to}")

        storage_probe = ""
        if action:
            clicked = _click_hchanh_action(driver, action)
            print(f"LOG [hchanh-click] Bấm action {action}: {'ok' if clicked else 'missing'}")
            if str(action or '').strip().lower() == 'discharge' and clicked:
                storage_probe = _wait_for_xutri_storage_probe(driver, timeout=6.0)
                print(f"LOG [hchanh-click] Số lưu trữ DOM: {'có ' + storage_probe if storage_probe else 'chưa thấy'}")

        try:
            if sess is not None and hasattr(sess, "import_selenium_cookies"):
                sess.import_selenium_cookies(driver.get_cookies())
                sess.save_cookies(inpatient_list_url=nav_url)
        except Exception:
            pass

        form_fields = {}
        try:
            form_fields = driver.execute_script(
                r"""
                const out = {};
                const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
                document.querySelectorAll('input, textarea, select').forEach((el, idx) => {
                  let val = '';
                  const tag = (el.tagName || '').toLowerCase();
                  if (tag === 'select') {
                    const opt = el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
                    val = norm((opt && opt.textContent) || el.value || '');
                  } else if (el.type === 'checkbox' || el.type === 'radio') {
                    val = el.checked ? (el.value || '1') : '';
                  } else {
                    val = norm(el.value || el.getAttribute('value') || el.textContent || '');
                  }
                  const keys = [el.id, el.name, el.getAttribute('data-id'), el.getAttribute('aria-label'), el.getAttribute('placeholder')]
                    .map(x => norm(x)).filter(Boolean);
                  keys.forEach(k => { if (!(k in out) || val) out[k] = val; });
                  if (val) out[`__field_${idx}`] = { id: el.id || '', name: el.name || '', placeholder: el.getAttribute('placeholder') || '', label: el.getAttribute('aria-label') || '', value: val };
                });
                return out;
                """
            ) or {}
        except Exception:
            form_fields = {}

        if storage_probe:
            if not isinstance(form_fields, dict):
                form_fields = {}
            # Luôn ghi đè vì EMR có thể có key txtSoLuuTru nhưng value rỗng trong
            # page_source; DOM probe mới là nguồn đúng.
            form_fields["txtSoLuuTru"] = storage_probe
            form_fields["so_luu_tru"] = storage_probe
            form_fields["__storage_probe"] = storage_probe

        return {
            "html": getattr(driver, "page_source", "") or "",
            "url": getattr(driver, "current_url", "") or opened_url,
            "entry_kind": entry_kind,
            "action": action,
            "fields": form_fields if isinstance(form_fields, dict) else {},
        }
    except Exception as e:
        print(f"ERROR [hchanh-click] Không bấm lấy được trang chi tiết: {type(e).__name__}: {e}", file=sys.stderr)
        return None

def _get_link_map(sess: EmrHttpSession) -> Dict[str, str]:
    """Lấy map ma_bn → URL hồ sơ từ trang danh sách nội trú.

    Parser cũ thường ưu tiên con mắt điều dưỡng. Tại đây chuẩn hóa thành 2 khóa:
    ma_bn::doctor  = bấm tên người bệnh
    ma_bn::nursing = bấm con mắt điều dưỡng
    """
    try:
        _, raw_map = sess.scan_all_inpatients()
        out: Dict[str, str] = {}
        for code, url in (raw_map or {}).items():
            code_s = str(code or "").strip()
            url_s = str(url or "").strip()
            if not code_s or not url_s:
                continue
            _remember_patient_links(out, code_s, {
                "doctor": _as_doctor_url(url_s),
                "nursing": _as_nursing_url(url_s),
            })
        return out
    except Exception as e:
        print(f"WARN: Không lấy được link_map: {e}", file=sys.stderr)
        return {}


def _patient_page_url(link_map: Dict[str, str], ma_bn: str,
                      config: Dict[str, Any], base_origin: str,
                      kind: str = "doctor") -> Optional[str]:
    """Tìm URL trang chi tiết BN.

    kind="doctor"  → link khi bấm tên BN: y lệnh, bảng kê, giấy tờ, ra viện.
    kind="nursing" → link con mắt điều dưỡng: profile, buồng giường, VTYT.
    """
    code = str(ma_bn or "").strip()
    wanted = "nursing" if kind == "nursing" else "doctor"
    url = link_map.get(_patient_link_key(code, wanted))
    if url:
        return url

    # Tương thích dữ liệu cũ: link_map[ma_bn] có thể là link điều dưỡng hoặc link tên BN.
    legacy = link_map.get(code)
    if legacy:
        return _as_nursing_url(legacy) if wanted == "nursing" else _as_doctor_url(legacy)

    tpl = config.get("url_patient_detail_template") or ""
    if tpl:
        guessed = tpl.replace("{ma_bn}", str(ma_bn))
        return _as_nursing_url(guessed) if wanted == "nursing" else _as_doctor_url(guessed)
    return None


# ── Fetcher: profile ──────────────────────────────────────────────────────────

def fetch_profile(sess: Optional["EmrHttpSession"], ma_bn: str,
                  patient_row: Dict[str, Any], link_map: Dict[str, str],
                  config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Thông tin nền BN từ trang 'mắt điều dưỡng'.
    Parse chính xác theo id HTML đã xác nhận từ EMR thực tế:
      lblHoTen, lblNgaySinh, lblTuoi, lblDiaChi, lblDoiTuong,
      lblSoThe, lblLoai, lblTuNgay, lblDenNgay,
      lblNgayVaoVien, lblNgayRaVien, lblSoNgayDieuTri,
      lblChanDoanVaoVien, lblChanDoanRaVien
    """
    base: Dict[str, Any] = {
        "ma_bn":            _t(patient_row.get("ma_bn") or patient_row.get("Mã BN") or ma_bn),
        "ho_ten":           _t(patient_row.get("ho_ten") or patient_row.get("Họ tên")),
        "phong":            _t(patient_row.get("Vi_Tri") or patient_row.get("so_phong")),
        "bac_si":           _t(patient_row.get("bac_si_dieu_tri") or patient_row.get("bac_si")),
        "chan_doan":        _t(patient_row.get("chan_doan") or patient_row.get("Chẩn đoán")),
        "bhyt_code":        "",
        "bhyt_loai":        "",
        "bhyt_tu_ngay":     "",
        "bhyt_den_ngay":    "",
        "doi_tuong":        "",
        "tu_tuc":           False,
        "ngay_sinh":        "",
        "tuoi":             "",
        "dia_chi":          "",
        "ngay_vao_vien":    "",
        "ngay_ra_vien":     "",
        "so_ngay_dieu_tri": "",
        "chan_doan_vao":    "",
        "chan_doan_ra":     "",
        # Alias giữ tương thích với UI/data-contract cũ
        "ngay_vao":         "",
        "ngay_ra":          "",
        "_source":          "patient_row",
        "_fetch_status":    "ok",
    }

    if sess is None:
        base["_source"] = "patient_row_no_session"
        base["_fetch_status"] = "no_session"
        return base

    try:
        view_url = _patient_page_url(link_map, ma_bn, config, sess.base_origin, kind="nursing")
        if not view_url:
            print(f"WARN [profile] BN {ma_bn} không có link con mắt điều dưỡng trong link_map", file=sys.stderr)
            # Với luồng nghiên cứu, profile chỉ lấy từ input/cache không đủ tin cậy để coi là đã thấy BN trên HIS.
            # Nếu không có URL hồ sơ sau khi đã tìm trên danh sách nội trú, đánh dấu rõ là không tìm thấy
            # để backend không ghi một dòng profile giả và không làm người dùng tưởng ca này có dữ liệu sống.
            if patient_row.get("research_mode") or patient_row.get("is_research") or patient_row.get("Research key"):
                base["_source"] = "patient_row_no_his_link"
                base["_fetch_status"] = "no_url"
                base["_reason"] = "patient_not_found_in_his_inpatient_list"
            return base

        html, _ = sess.get_html(view_url)
        soup = _soup(html)

        def bi(id_: str) -> str:
            el = soup.find(id=id_)
            return el.get_text(strip=True) if el else ""

        # Thông tin bệnh nhân
        base["ho_ten"]           = bi("lblHoTen")   or base["ho_ten"]
        base["ngay_sinh"]        = bi("lblNgaySinh")
        base["tuoi"]             = bi("lblTuoi")
        base["dia_chi"]          = bi("lblDiaChi")
        base["doi_tuong"]        = bi("lblDoiTuong")
        base["tu_tuc"]           = "bảo hiểm" not in _norm(bi("lblDoiTuong"))

        # BHYT
        base["bhyt_code"]        = bi("lblSoThe")
        base["bhyt_loai"]        = bi("lblLoai")
        base["bhyt_tu_ngay"]     = bi("lblTuNgay")
        base["bhyt_den_ngay"]    = bi("lblDenNgay")

        # Thông tin điều trị chung
        base["ngay_vao_vien"]    = bi("lblNgayVaoVien")
        base["ngay_ra_vien"]     = bi("lblNgayRaVien")
        base["so_ngay_dieu_tri"] = bi("lblSoNgayDieuTri")
        base["chan_doan_vao"]    = bi("lblChanDoanVaoVien")
        base["chan_doan_ra"]     = bi("lblChanDoanRaVien")

        # Nếu HTTP chỉ trả khung rỗng, phải mở con mắt điều dưỡng bằng Chrome thật
        # để JS của EMR render đầy đủ khối Thông tin bệnh nhân / Thông tin điều trị chung.
        if not base.get("bhyt_code") or not base.get("ngay_vao_vien"):
            clicked = _fetch_hchanh_html_by_click(sess, ma_bn, config, "nursing", "profile", date_from=_t(patient_row.get("date_from") or patient_row.get("Ngày vào viện")), date_to=_t(patient_row.get("date_to") or patient_row.get("Ngày ra viện") or patient_row.get("Ngày vào viện")))
            if clicked and clicked.get("html"):
                soup2 = _soup(clicked.get("html") or "")

                def bi2(id_: str) -> str:
                    el = soup2.find(id=id_)
                    return el.get_text(strip=True) if el else ""

                base["ho_ten"]           = bi2("lblHoTen") or base["ho_ten"]
                base["ngay_sinh"]        = bi2("lblNgaySinh") or base.get("ngay_sinh", "")
                base["tuoi"]             = bi2("lblTuoi") or base.get("tuoi", "")
                base["dia_chi"]          = bi2("lblDiaChi") or base.get("dia_chi", "")
                base["doi_tuong"]        = bi2("lblDoiTuong") or base.get("doi_tuong", "")
                if base.get("doi_tuong"):
                    base["tu_tuc"] = "bảo hiểm" not in _norm(base.get("doi_tuong"))
                base["bhyt_code"]        = bi2("lblSoThe") or base.get("bhyt_code", "")
                base["bhyt_loai"]        = bi2("lblLoai") or base.get("bhyt_loai", "")
                base["bhyt_tu_ngay"]     = bi2("lblTuNgay") or base.get("bhyt_tu_ngay", "")
                base["bhyt_den_ngay"]    = bi2("lblDenNgay") or base.get("bhyt_den_ngay", "")
                base["ngay_vao_vien"]    = bi2("lblNgayVaoVien") or base.get("ngay_vao_vien", "")
                base["ngay_ra_vien"]     = bi2("lblNgayRaVien") or base.get("ngay_ra_vien", "")
                base["so_ngay_dieu_tri"] = bi2("lblSoNgayDieuTri") or base.get("so_ngay_dieu_tri", "")
                base["chan_doan_vao"]    = bi2("lblChanDoanVaoVien") or base.get("chan_doan_vao", "")
                base["chan_doan_ra"]     = bi2("lblChanDoanRaVien") or base.get("chan_doan_ra", "")
                base["_source"]          = "emr_dieuduong_click"

        # Cập nhật chan_doan tổng nếu chưa có
        if not base["chan_doan"]:
            base["chan_doan"] = base["chan_doan_vao"]

        # Alias giữ tương thích với UI cũ: HchahnTab đang đọc profile.ngay_vao.
        base["ngay_vao"] = base.get("ngay_vao_vien") or base.get("ngay_vao") or ""
        base["ngay_ra"] = base.get("ngay_ra_vien") or base.get("ngay_ra") or ""

        if not base.get("_source") or base.get("_source") == "patient_row":
            base["_source"] = "emr_dieuduong_page"
        base["_fetch_status"] = "ok"
        print(
            f"LOG [profile] {ma_bn}: {base['ho_ten']} | "
            f"BHYT={base['bhyt_code']} | vào={base['ngay_vao_vien']} | "
            f"source={base.get('_source')}"
        )

    except Exception as e:
        print(f"ERROR [profile] {ma_bn}: {e}", file=sys.stderr)
        base["_fetch_status"] = "error"
        base["_error"] = str(e)

    return base


    base = {
        "ma_bn":         _t(patient_row.get("ma_bn") or patient_row.get("Mã BN") or ma_bn),
        "ho_ten":        _t(patient_row.get("ho_ten") or patient_row.get("Họ tên")),
        "phong":         _t(patient_row.get("Vi_Tri") or patient_row.get("so_phong")),
        "bac_si":        _t(patient_row.get("bac_si_dieu_tri") or patient_row.get("bac_si") or patient_row.get("Bác sĩ")),
        "chan_doan":      _t(patient_row.get("chan_doan") or patient_row.get("Chẩn đoán")),
        "bhyt_code":     _t(patient_row.get("bhyt") or patient_row.get("BHYT") or patient_row.get("ma_bhyt") or patient_row.get("so_the_bhyt")),
        "doi_tuong":     _t(patient_row.get("doi_tuong") or patient_row.get("Đối tượng")),
        "tu_tuc":        "tu tuc" in _norm(patient_row.get("doi_tuong") or ""),
        "ngay_vao":      _t(patient_row.get("thoi_gian_vao_khoa") or patient_row.get("tg_vao") or patient_row.get("ngay_vao_vien")),
        "khoa":          _t(patient_row.get("ten_khoa_dieu_tri") or patient_row.get("khoa_dieu_tri")),
        "gioi_tinh":     _t(patient_row.get("gioi_tinh") or patient_row.get("Giới tính")),
        "tuoi":          _t(patient_row.get("tuoi") or patient_row.get("Tuổi")),
        "_source":       "patient_row",
        "_fetch_status": "ok",
    }

    # Cố gắng bổ sung từ trang dieuduongdraw
    if sess is None:
        return base

    try:
        base_origin = sess.base_origin
        view_url = _patient_page_url(link_map, ma_bn, config, base_origin, kind="nursing")
        if not view_url:
            print(f"WARN [profile] Không tìm thấy URL con mắt điều dưỡng BN {ma_bn} trong link_map", file=sys.stderr)
            return base

        html, _ = sess.get_html(view_url)
        soup = _soup(html)

        # Lấy bổ sung từ trang: tìm các label/value pattern phổ biến của EMR ASP.NET
        def _label_val(lbl_text: str) -> str:
            el = soup.find(lambda t: t.name and _norm(t.get_text()) == _norm(lbl_text))
            if el:
                nxt = el.find_next_sibling()
                if nxt:
                    return _get_text(nxt)
            # Tìm span/td theo id pattern
            for pattern in [lbl_text.lower().replace(" ", ""), lbl_text]:
                for tag in soup.find_all(["span", "label", "td"], string=re.compile(re.escape(pattern), re.IGNORECASE)):
                    nxt = tag.find_next_sibling()
                    if nxt:
                        v = _get_text(nxt)
                        if v:
                            return v
            return ""

        # Bổ sung nếu chưa có
        if not base["bac_si"]:
            base["bac_si"] = _label_val("Bác sĩ điều trị") or _label_val("Bác sĩ")
        if not base["chan_doan"]:
            base["chan_doan"] = _label_val("Chẩn đoán") or _label_val("Chẩn đoán chính")
        if not base["bhyt_code"]:
            base["bhyt_code"] = _label_val("Số thẻ BHYT") or _label_val("BHYT") or _label_val("Mã thẻ")
        if not base["ngay_vao"]:
            base["ngay_vao"] = _label_val("Ngày vào viện") or _label_val("Giờ vào")

        base["_source"] = "patient_row+emr_page"
    except Exception as e:
        print(f"WARN [profile] Không bổ sung được từ trang EMR: {e}", file=sys.stderr)

    return base


# ── Fetcher: discharge (giấy ra viện) ────────────────────────────────────────

def fetch_discharge(sess: Optional["EmrHttpSession"], ma_bn: str,
                    date_from: str, date_to: str,
                    link_map: Dict[str, str], config: Dict[str, Any],
                    patient_row: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Lấy thông tin ra viện/ra khoa từ trang Tổng kết → Ra Khoa.

    Ghi chú từ HTML thực tế: một số trường select không có thuộc tính selected
    trong HTML tĩnh (đặc biệt cbbXuTri), nhưng vùng chi tiết ra khoa và các
    select2-rendered vẫn có dữ liệu. Vì vậy parser phải ưu tiên select2, sau đó
    mới suy luận "Ra viện" từ cboTinhTrangRaVien/divChiTietXuTri.
    """

    patient_row = patient_row if isinstance(patient_row, dict) else {}

    base: Dict[str, Any] = {
        "ma_bn":             ma_bn,
        # Xử trí
        "xu_tri":            "",
        "loai_noi_tru":      "",
        "tinh_trang_ra":     "",
        "ket_qua":           "",
        "ly_do_cho_ve":      "",
        "bac_si":            "",
        "so_luu_tru":        "",
        # Thời gian
        "ngay_ra":           "",
        "gio_ra":            "",
        "raw_time":          "",
        "so_ngay_tai_khoa":  "",
        "tong_so_ngay_dt":   "",
        # Chẩn đoán
        "chan_doan_chinh":   "",
        "chan_doan_chinh_icd": "",
        "chan_doan_ra":      "",
        "chan_doan_vao":     "",
        "benh_kem":          [],
        "bien_chung":        "",
        "tai_bien":          "",
        "phan_loai_hsba":    "",
        "co_kq_tra_sau":     "",
        "chan_doan_vao_list": [],
        # Điều trị
        "ly_do_vao_vien":    "",
        "dau_hieu_lam_sang": "",
        "can_lam_sang":      "",
        "thuoc_da_su_dung":  "",
        "pp_dieu_tri":       "",
        "tinh_trang_bn_ra":  "",
        "huong_dieu_tri":    "",
        "loi_dan":           "",
        # Tái khám
        "hen_tai_kham":      "",
        "tg_hen_kham":       "",
        "phong_kham":        "",
        "nguoi_lien_he":     "",
        "sdt":               "",
        # Hồ sơ phim
        "phim_xquang":       0,
        "phim_ct":           0,
        "phim_sieu_am":      0,
        "phim_khac":         0,
        "toan_bo_ho_so":     "",
        # Nghỉ ngoại trú
        "ngay_bd_nghi_ngt":  "",
        "ngay_kt_nghi_ngt":  "",
        "so_ngay_nghi_ngt":  0,
        "_source":           "emr_xutri_form",
        "_fetch_status":     "pending",
    }

    def _compact_text(v: Any) -> str:
        return re.sub(r"\s+", " ", str(v or "").replace("\xa0", " ")).strip()

    def _digits_int(v: Any) -> int:
        raw = re.sub(r"\D", "", str(v or ""))
        return int(raw or 0)

    def _dedup_keep_order(items: List[str]) -> List[str]:
        seen = set()
        out: List[str] = []
        for item in items:
            t = _compact_text(item).replace("×", "").strip()
            if not t or t in {"Xóa xử trí"}:
                continue
            key = t.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(t)
        return out

    def _parse_dt_to_fields(raw: str) -> None:
        raw_s = _compact_text(raw)
        if not raw_s:
            return
        base["raw_time"] = raw_s
        m_dt = re.search(r"(\d{1,2}[/-]\d{1,2}[/-]\d{4})", raw_s)
        m_iso = re.search(r"(\d{4})-(\d{1,2})-(\d{1,2})", raw_s)
        m_hr = re.search(r"(\d{1,2}:\d{2})", raw_s)
        if m_dt:
            base["ngay_ra"] = m_dt.group(1).replace("-", "/")
        elif m_iso:
            base["ngay_ra"] = f"{int(m_iso.group(3)):02d}/{int(m_iso.group(2)):02d}/{m_iso.group(1)}"
        if m_hr:
            base["gio_ra"] = m_hr.group(1)

    def _explicit_discharge_text_from_row() -> str:
        keys = (
            "ngay_ra_vien", "ngay_ra_vien_date", "ngay_ra", "discharge_time",
            "discharge_date", "raw_discharge_time", "T/G ra", "TG ra",
            "Thời gian ra", "Thời gian ra viện", "Ngày ra viện", "Ngày ra",
        )
        for key in keys:
            value = _compact_text(patient_row.get(key))
            if value and (re.search(r"\d{1,2}[/-]\d{1,2}[/-]\d{4}", value) or re.search(r"\d{4}-\d{1,2}-\d{1,2}", value)):
                return value
        return ""

    # Danh sách Hoàn tất có thể đã chứa ngày ra. Giữ mốc này làm dự phòng,
    # nhưng vẫn ưu tiên giá trị đọc trực tiếp từ màn Ra Khoa ở các bước sau.
    explicit_discharge_time = _explicit_discharge_text_from_row()
    if explicit_discharge_time:
        _parse_dt_to_fields(explicit_discharge_time)

    def _apply_xutri_field_map(fields: Any, source: str = "emr_xutri_form_fields") -> None:
        """Bổ sung giá trị input lấy trực tiếp bằng Selenium.

        Một số input của EMR được gán bằng JS property nên `page_source` không có
        thuộc tính value. Riêng số lưu trữ thường rơi vào nhóm này, vì vậy phải
        đọc bằng element.value sau khi bấm Ra Khoa.
        """
        if not isinstance(fields, dict):
            return

        def fval(*keys: str) -> str:
            for key in keys:
                v = _compact_text(fields.get(key))
                if v:
                    return v
            return ""

        def fval_by_norm(*needles: str) -> str:
            needle_norms = [_norm(str(x or "")) for x in needles if str(x or "").strip()]
            if not needle_norms:
                return ""
            # Dạng trực tiếp: {id/name: value}
            for key, value in fields.items():
                if str(key).startswith("__field_"):
                    continue
                hay = _norm(str(key or ""))
                if all(n in hay for n in needle_norms):
                    v = _compact_text(value)
                    if v:
                        return v
            # Dạng chi tiết: {__field_i: {id,name,placeholder,label,value}}
            for value in fields.values():
                if not isinstance(value, dict):
                    continue
                hay = _norm(" ".join(str(value.get(k) or "") for k in ("id", "name", "placeholder", "label")))
                if all(n in hay for n in needle_norms):
                    v = _compact_text(value.get("value"))
                    if v:
                        return v
            return ""

        def keep_field(key: str, value: Any) -> None:
            v = _compact_text(value)
            if key == "so_luu_tru":
                if not _looks_like_storage_no(v):
                    return
                # Nếu trước đó bị parse nhầm “Bình thường/Tai nạn” từ Phân loại HSBA,
                # cho phép DOM probe ghi đè bằng số lưu trữ thật.
                if not _looks_like_storage_no(base.get(key)):
                    base[key] = v
                return
            if base.get(key):
                return
            if v:
                base[key] = v

        keep_field("so_luu_tru", fval("__storage_probe", "so_luu_tru", "txtSoLuuTru", "txtSoLuuTruBA", "txtSoLuuTruHSBA", "txtSoLuuTruHoSo")
                   or fval_by_norm("luu", "tru"))
        keep_field("so_ngay_tai_khoa", fval("txtSoNgayDT"))
        keep_field("tong_so_ngay_dt", fval("txtTongSoNgayDT"))
        dom_discharge_time = (
            fval(
                "txtThoiGianRa", "lblNgayRaVien", "lblNgayRa", "ngay_ra_vien",
                "ngay_ra", "discharge_time", "discharge_date", "raw_discharge_time",
            )
            or fval_by_norm("thoi", "gian", "ra")
            or fval_by_norm("ngay", "ra")
        )
        if dom_discharge_time:
            _parse_dt_to_fields(dom_discharge_time)
        if source and base.get("so_luu_tru"):
            base["_source_fields"] = source

    def _parse_xutri_html(html: str, source: str) -> bool:
        soup = _soup(html or "")
        if not soup:
            return False

        def input_val(id_: str) -> str:
            el = soup.find(id=id_)
            if not el:
                return ""
            return _compact_text(el.get("value") if el.has_attr("value") else el.get_text(" ", strip=True))

        def element_val(*ids: str) -> str:
            for id_ in ids:
                el = soup.find(id=id_)
                if not el:
                    continue
                value = _compact_text(el.get("value") if el.has_attr("value") else el.get_text(" ", strip=True))
                if value:
                    return value
            return ""

        def text_area(id_: str) -> str:
            el = soup.find(id=id_)
            if not el:
                return ""
            raw = el.get("value") if el.has_attr("value") and el.get("value") else el.get_text("\n", strip=False)
            return str(raw or "").strip()

        def selected_options(id_: str, allow_single_fallback: bool = True) -> List[str]:
            el = soup.find("select", id=id_)
            if not el:
                return []
            opts = [o.get_text(" ", strip=True) for o in el.find_all("option", selected=True)]
            vals = _dedup_keep_order(opts)
            if vals:
                return vals
            if allow_single_fallback:
                all_opts = _dedup_keep_order([o.get_text(" ", strip=True) for o in el.find_all("option")])
                # Nhiều select trong EMR chỉ có 1 option hợp lệ nhưng không gắn selected.
                if len(all_opts) == 1:
                    return all_opts
            return []

        def selected_text(id_: str, allow_single_fallback: bool = True) -> str:
            vals = selected_options(id_, allow_single_fallback=allow_single_fallback)
            return " | ".join(vals)

        def select2_rendered(id_: str) -> str:
            span = soup.find("span", id=f"select2-{id_}-container")
            if not span:
                return ""
            txt = _compact_text(span.get_text(" ", strip=True)).replace("×", "").strip()
            placeholders = {"", "Lời dặn", "Mã loại KCB", "Không", "Người giao hồ sơ", "Người nhận hồ sơ"}
            return "" if txt in placeholders else txt

        def field(id_: str, allow_single_fallback: bool = True) -> str:
            return select2_rendered(id_) or selected_text(id_, allow_single_fallback=allow_single_fallback)

        def any_form_value_by_norm(*needles: str) -> str:
            needle_norms = [_norm(str(x or '')) for x in needles if str(x or '').strip()]
            if not needle_norms:
                return ""
            for el in soup.find_all(["input", "textarea", "select"]):
                hay = " ".join([
                    str(el.get("id") or ""),
                    str(el.get("name") or ""),
                    str(el.get("placeholder") or ""),
                    str(el.get("title") or ""),
                    str(el.get("aria-label") or ""),
                    " ".join(el.get("class") or []),
                ])
                hay_n = _norm(hay)
                if all(n in hay_n for n in needle_norms):
                    if el.name == "select":
                        id_ = str(el.get("id") or "")
                        if id_:
                            v = field(id_)
                            if v:
                                return v
                    raw = el.get("value") if el.has_attr("value") else el.get_text(" ", strip=True)
                    v = _compact_text(raw)
                    if v:
                        return v
            return ""

        def neighbor_value_by_label(*needles: str) -> str:
            needle_norms = [_norm(str(x or '')) for x in needles if str(x or '').strip()]
            if not needle_norms:
                return ""
            label_tags = soup.find_all(["label", "span", "td", "th", "div"], string=True)
            for lab in label_tags:
                text_n = _norm(lab.get_text(" ", strip=True))
                if not all(n in text_n for n in needle_norms):
                    continue
                # label[for] → input/select/textarea#id
                for_id = str(lab.get("for") or "").strip()
                if for_id:
                    el = soup.find(id=for_id)
                    if el:
                        if el.name == "select":
                            v = field(for_id)
                        else:
                            v = _compact_text(el.get("value") if el.has_attr("value") else el.get_text(" ", strip=True))
                        if v:
                            return v
                # cùng hàng bảng: lấy ô ngay sau label, ưu tiên input trong ô đó
                tr = lab.find_parent("tr")
                if tr:
                    cells = tr.find_all(["td", "th"], recursive=False)
                    try:
                        pos = next(i for i, c in enumerate(cells) if c is lab or lab in c.descendants)
                    except StopIteration:
                        pos = -1
                    for cell in cells[pos + 1:] if pos >= 0 else []:
                        el = cell.find(["input", "textarea", "select"])
                        if el:
                            if el.name == "select":
                                id_ = str(el.get("id") or "")
                                v = field(id_) if id_ else ""
                            else:
                                v = _compact_text(el.get("value") if el.has_attr("value") else el.get_text(" ", strip=True))
                            if v:
                                return v
                        v = _compact_text(cell.get_text(" ", strip=True))
                        if v and not all(n in _norm(v) for n in needle_norms):
                            return v
                # sibling kế bên
                sib = lab.find_next_sibling()
                while sib is not None:
                    if getattr(sib, "name", None):
                        el = sib.find(["input", "textarea", "select"]) or sib
                        if getattr(el, "name", None) == "select":
                            id_ = str(el.get("id") or "")
                            v = field(id_) if id_ else ""
                        else:
                            v = _compact_text(el.get("value") if hasattr(el, "has_attr") and el.has_attr("value") else el.get_text(" ", strip=True))
                        if v and not all(n in _norm(v) for n in needle_norms):
                            return v
                    sib = sib.find_next_sibling()
            return ""

        def keep(key: str, val: Any) -> None:
            if base.get(key):
                return
            if isinstance(val, list):
                if val:
                    base[key] = val
            else:
                v = val if isinstance(val, int) else _compact_text(val)
                if v != "" and v is not None:
                    base[key] = v

        # Xử trí / ra khoa
        keep("xu_tri", field("cbbXuTri", allow_single_fallback=False))
        keep("loai_noi_tru", field("cbbLoaiNoiTru"))
        keep("tinh_trang_ra", field("cboTinhTrangRaVien"))
        keep("ket_qua", field("cboKetQuaDT"))
        keep("ly_do_cho_ve", field("cboLydoChove"))
        keep("bac_si", field("cboBacsi"))
        storage_candidate = (
            input_val("txtSoLuuTru")
            or input_val("txtSoLuuTruBA")
            or input_val("txtSoLuuTruHSBA")
            or input_val("txtSoLuuTruHoSo")
            or any_form_value_by_norm("luu", "tru")
            or neighbor_value_by_label("luu", "tru")
        )
        if _looks_like_storage_no(storage_candidate) and not _looks_like_storage_no(base.get("so_luu_tru")):
            base["so_luu_tru"] = _compact_text(storage_candidate)
        keep("so_ngay_tai_khoa", input_val("txtSoNgayDT"))
        keep("tong_so_ngay_dt", input_val("txtTongSoNgayDT"))

        raw_time = element_val(
            "txtThoiGianRa", "lblNgayRaVien", "lblNgayRa", "txtNgayRaVien",
            "txtNgayRa", "ngay_ra_vien", "ngay_ra",
        )
        if raw_time:
            _parse_dt_to_fields(raw_time)

        # cbbXuTri trong HTML Vũ Thành Đạt không có option selected. Nếu đã có
        # cboTinhTrangRaVien=Ra viện hoặc vùng divChiTietXuTri thì xác nhận là ca ra viện.
        if not base.get("xu_tri"):
            if base.get("tinh_trang_ra"):
                base["xu_tri"] = base["tinh_trang_ra"]
            elif soup.find(id="divChiTietXuTri") and (base.get("ket_qua") or soup.find(id="cboChanDoan")):
                base["xu_tri"] = "Ra viện"

        # Chẩn đoán vào khoa
        tbl = soup.find("table", id="tblChanDoan")
        if tbl and not base.get("chan_doan_vao_list"):
            cd_list = []
            for tr in tbl.find_all("tr"):
                tds = tr.find_all("td")
                if len(tds) >= 2:
                    ten = _compact_text(tds[0].get_text(" ", strip=True))
                    loai = _compact_text(tds[1].get_text(" ", strip=True))
                    if ten:
                        cd_list.append({"ten": ten, "loai": loai})
            base["chan_doan_vao_list"] = cd_list
            main_in = next((x.get("ten") for x in cd_list if "chính" in _norm(x.get("loai", ""))), "")
            if main_in:
                base["chan_doan_vao"] = main_in

        # Chẩn đoán ra viện
        cd_chinh = field("cboChanDoan") or text_area("txtChanDoanPhanBiet")
        keep("chan_doan_chinh", cd_chinh)
        keep("chan_doan_ra", text_area("txtChanDoanPhanBiet") or cd_chinh)
        if base.get("chan_doan_chinh") and not base.get("chan_doan_chinh_icd"):
            m_icd = re.match(r"\(?([A-Z]\d+\.?\d*)\)?", str(base["chan_doan_chinh"]).strip())
            if m_icd:
                base["chan_doan_chinh_icd"] = m_icd.group(1)

        bk_el = soup.find("select", id="cboBenhKemTheo")
        if bk_el and not base.get("benh_kem"):
            base["benh_kem"] = _dedup_keep_order([
                o.get_text(" ", strip=True)
                for o in bk_el.find_all("option", selected=True)
            ])

        keep("bien_chung", field("cboBienchung"))
        keep("tai_bien", field("cboTaibien"))
        keep("phan_loai_hsba", field("cboPhanLoaiHSBA"))
        keep("co_kq_tra_sau", field("cboCoKQTraSau"))

        # Nội dung điều trị
        keep("ly_do_vao_vien", text_area("txtLyDoVaoVien"))
        keep("dau_hieu_lam_sang", text_area("txtDauHieuLamSang"))
        keep("can_lam_sang", text_area("txtCanLamSang"))
        keep("thuoc_da_su_dung", text_area("txtThuocDaSuDung"))
        keep("pp_dieu_tri", text_area("txtPPDieuTri"))
        keep("tinh_trang_bn_ra", text_area("txtTinhTrangBN"))
        keep("huong_dieu_tri", text_area("txtHuongDieuTri"))
        keep("loi_dan", field("cboLoidan") or text_area("txtGhiChu"))

        # Hẹn tái khám
        keep("hen_tai_kham", field("cbbHenKham"))
        keep("tg_hen_kham", input_val("txtThoiGianHenKham"))
        keep("phong_kham", field("cbbHangDoiHenKham"))
        keep("nguoi_lien_he", input_val("txtNguoiLienHe"))
        keep("sdt", input_val("txtSDT"))

        # Hồ sơ, phim ảnh
        if not base.get("phim_xquang"):
            base["phim_xquang"] = _digits_int(input_val("txtHoSoXQuang"))
        if not base.get("phim_ct"):
            base["phim_ct"] = _digits_int(input_val("txtHoSoCT"))
        if not base.get("phim_sieu_am"):
            base["phim_sieu_am"] = _digits_int(input_val("txtHoSoSieuAm"))
        if not base.get("phim_khac"):
            base["phim_khac"] = _digits_int(input_val("txtHoSoKhac"))
        keep("toan_bo_ho_so", input_val("txtToanBoHoSo"))

        # Nghỉ ngoại trú sau điều trị
        keep("ngay_bd_nghi_ngt", input_val("txtTGBDNGHINGTSAUDT"))
        keep("ngay_kt_nghi_ngt", input_val("txtTGKTNGHINGTSAUDT"))
        if not base.get("so_ngay_nghi_ngt"):
            base["so_ngay_nghi_ngt"] = _digits_int(input_val("txtSNNGHINGTSAUDT"))

        if source:
            base["_source"] = source

        return bool(
            soup.find(id="xutri_form")
            or soup.find(id="divChiTietXuTri")
            or base.get("xu_tri")
            or base.get("tinh_trang_ra")
            or base.get("ket_qua")
            or base.get("chan_doan_chinh")
        )

    if sess is None:
        base["_fetch_status"] = "no_session"
        return base

    try:
        view_url = _patient_page_url(link_map, ma_bn, config, sess.base_origin)
        if not view_url:
            base["_fetch_status"] = "no_url"
            trace_event(
                "ERROR.NO_URL_DISCHARGE",
                "Không tạo được URL để mở thông tin ra viện",
                screen="D/s Điều trị nội trú / link_map",
                sees=f"ma_bn={ma_bn}; link_map_entries={len(link_map or {})}",
                takes="link tên BN hoặc mắt điều dưỡng",
                writes="output.discharge._fetch_status=no_url",
                target="output.discharge",
            )
            return base

        # 1) Thử HTTP trước. Một số phiên trả sẵn fragment xutri_form.
        discharge_wpid = config.get("discharge_wpid") or config.get("url_discharge_wpid") or ""
        target_url = _upsert_query(view_url, wpid=discharge_wpid) if discharge_wpid else view_url
        html, _ = sess.get_html(target_url)
        parsed_http = _parse_xutri_html(html, "emr_xutri_form_http")

        # 2) Nếu HTTP chỉ trả trang hồ sơ/không có chi tiết ra khoa, bấm thật menu Tổng kết → Ra Khoa.
        essential = bool(base.get("tinh_trang_ra") or base.get("ket_qua") or base.get("chan_doan_chinh") or base.get("benh_kem"))
        if not parsed_http or not essential:
            clicked = _fetch_hchanh_html_by_click(sess, ma_bn, config, "doctor", "discharge", date_from=date_from, date_to=date_to)
            if clicked and clicked.get("html"):
                _parse_xutri_html(str(clicked.get("html") or ""), "emr_xutri_form_click")
                _apply_xutri_field_map(clicked.get("fields"), "emr_xutri_form_click_fields")
                # Ưu tiên tuyệt đối số lưu trữ đọc trực tiếp từ DOM. Trước đây
                # parser HTML có thể bắt nhầm trường Phân loại HSBA thành
                # “Bình thường”/“Tai nạn”, làm mất số lưu trữ thật dù log DOM đã đọc được.
                fields = clicked.get("fields") if isinstance(clicked.get("fields"), dict) else {}
                dom_storage = _compact_text(
                    fields.get("__storage_probe")
                    or fields.get("txtSoLuuTru")
                    or fields.get("so_luu_tru")
                    or ""
                )
                if _looks_like_storage_no(dom_storage):
                    base["so_luu_tru"] = dom_storage
                    base["_source_fields"] = "emr_xutri_dom_probe"
                    print(f"LOG [discharge] Ưu tiên số lưu trữ DOM: {dom_storage}")

        # Có ca màn Ra Khoa trả được số lưu trữ nhưng txtThoiGianRa rỗng hoặc
        # ngày ra chỉ nằm ở phần Thông tin điều trị chung (lblNgayRaVien).
        # Chỉ mở thêm con mắt điều dưỡng khi vẫn chưa có ngày, để tránh tăng thời gian
        # cho các ca đã lấy đủ dữ liệu.
        if not base.get("ngay_ra"):
            try:
                profile_clicked = _fetch_hchanh_html_by_click(
                    sess, ma_bn, config, "nursing", "profile",
                    date_from=date_from, date_to=date_to,
                )
                if profile_clicked and profile_clicked.get("html"):
                    profile_soup = _soup(str(profile_clicked.get("html") or ""))
                    for field_id in ("lblNgayRaVien", "lblNgayRa", "txtThoiGianRa", "txtNgayRaVien"):
                        el = profile_soup.find(id=field_id) if profile_soup else None
                        value = _compact_text(
                            (el.get("value") if el and el.has_attr("value") else el.get_text(" ", strip=True))
                            if el else ""
                        )
                        if value:
                            _parse_dt_to_fields(value)
                            base["_source_discharge_time"] = "emr_dieuduong_lblNgayRaVien"
                            break
            except Exception as profile_exc:
                print(f"WARN [discharge] Không bổ sung được ngày ra từ con mắt điều dưỡng: {profile_exc}", file=sys.stderr)

        if not _looks_like_storage_no(base.get("so_luu_tru")):
            # Không để các giá trị Phân loại HSBA như “Bình thường”/“Tai nạn”
            # lọt ra UI như một số lưu trữ.
            base["so_luu_tru"] = ""

        essential = bool(base.get("tinh_trang_ra") or base.get("ket_qua") or base.get("chan_doan_chinh") or base.get("benh_kem"))
        base["_fetch_status"] = "ok" if essential else ("partial" if (parsed_http or base.get("xu_tri")) else "empty")

        print(f"LOG [discharge] {ma_bn}: so_luu_tru='{base.get('so_luu_tru', '')}' | "
              f"ngay_ra='{base.get('ngay_ra', '')}' | gio_ra='{base.get('gio_ra', '')}' | "
              f"xu_tri='{base['xu_tri']}' | "
              f"tinh_trang='{base['tinh_trang_ra']}' | "
              f"cd_chinh='{str(base['chan_doan_chinh'])[:40]}' | "
              f"benh_kem={len(base['benh_kem']) if isinstance(base.get('benh_kem'), list) else 0} | "
              f"ket_qua='{base['ket_qua']}' | hen='{base['hen_tai_kham']}' | status={base['_fetch_status']}")

    except Exception as e:
        print(f"ERROR [discharge] {ma_bn}: {e}", file=sys.stderr)
        base["_fetch_status"] = "error"
        base["_error"] = str(e)

    return base


# ── Fetcher: billing (bảng kê chi phí) ───────────────────────────────────────

def fetch_billing(sess: Optional["EmrHttpSession"], ma_bn: str,
                  link_map: Dict[str, str], config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Lấy bảng kê chi phí từ trang chiphichitietdraw (tab mới).

    Cách truy cập (đã xác nhận từ EMR thực tế):
    - Trang BN có nút <button id="btnSuaChiPhi" onclick="OnSuaChiPhi()">
    - Hàm OnSuaChiPhi() mở tab mới với URL:
        home.aspx?...&wpid=chiphichitietdraw&tiepnhanid={tiepnhanid}&...
    - tiepnhanid lấy từ link_map hoặc patient_row
    - Worker tự build URL từ base_origin + tiepnhanid

    Cấu trúc bảng (div#dsDichVu > table):
    - Cột: checkbox | STT | Thời gian y lệnh | Thời gian thực hiện | Mã DV |
            Tên DV | Chi tiết | Đối tượng | Thẻ BHYT | SL | Đơn giá |
            Chênh lệch | Tỷ lệ TT | Mức hưởng | T/vụ
    - Dòng nhóm (colspan=15, bg #ff9150): loại yêu cầu
    - Dòng khoa (colspan=15, không bg): tên khoa phòng
    - Đối tượng: "Bảo hiểm" → bhyt | "Viện phí" → self_pay |
                 "Trong gói" / "0" → zero | còn lại → unknown
    """
    base: Dict[str, Any] = {
        "ma_bn":       ma_bn,
        "rows":        [],
        "tong_bhyt":   0,
        "tong_tu_tuc": 0,
        "tong_mien":   0,
        "tong_cong":   0,
        "_source":     "emr_chiphichitietdraw",
        "_fetch_status": "pending",
    }

    if sess is None:
        base["_fetch_status"] = "no_session"
        return base

    def _money(s: str) -> float:
        return float(re.sub(r"[^\d.]", "", str(s or "")) or "0")

    try:
        # Build URL trang chi phí chi tiết
        # URL pattern: home.aspx?scope=sys&lang=vi&wpid=chiphichitietdraw&tiepnhanid={id}&...
        view_url = _patient_page_url(link_map, ma_bn, config, sess.base_origin)
        if not view_url:
            base["_fetch_status"] = "no_url"
            return base

        # Lấy tiepnhanid từ URL trang BN (query param) hoặc từ onclick của btnSuaChiPhi
        tiepnhan_id = ""
        parsed = urlparse(view_url)
        qs = dict(parse_qsl(parsed.query))
        tiepnhan_id = qs.get("tiepnhanid") or qs.get("tiepnhan") or ""

        if not tiepnhan_id:
            # Đọc trang BN để tìm tiepnhanid từ onclick btnSuaChiPhi
            html0, _ = sess.get_html(view_url)
            soup0 = _soup(html0)
            btn = soup0.find("button", id="btnSuaChiPhi") or \
                  soup0.find("button", string=re.compile(r"Sửa chi phí", re.I))
            if btn:
                onclick = btn.get("onclick", "")
                m = re.search(r"['\"]([0-9a-f-]{36})['\"]", onclick)
                if m:
                    tiepnhan_id = m.group(1)

        if not tiepnhan_id:
            # Bảng kê thường chỉ hiện sau khi bấm tên người bệnh rồi bấm nút chi phí.
            print(f"WARN [billing] Không tìm được tiepnhanid bằng HTTP cho BN {ma_bn}; chuyển sang bấm thật bằng Chrome.", file=sys.stderr)
            clicked = _fetch_hchanh_html_by_click(sess, ma_bn, config, "doctor", "billing")
            if clicked and clicked.get("html"):
                html = clicked["html"]
                soup = _soup(html)
                print(f"LOG [billing] {ma_bn}: đã lấy HTML bảng kê sau khi bấm nút chi phí.")
            else:
                base["_fetch_status"] = "no_tiepnhanid"
                return base
        else:
            # Build URL trang chiphichitietdraw
            billing_url = _upsert_query(view_url,
                                        wpid="chiphichitietdraw",
                                        tiepnhanid=tiepnhan_id)
            print(f"LOG [billing] {ma_bn}: URL = {billing_url}")

            html, _ = sess.get_html(billing_url)
            soup = _soup(html)

        # Bảng trong div#dsDichVu
        table = soup.select_one("div#dsDichVu table")
        if table is None:
            # Fallback: bảng lớn nhất
            tables = soup.find_all("table")
            table = max(tables, key=lambda t: len(t.find_all("tr"))) if tables else None

        if table is None:
            clicked = _fetch_hchanh_html_by_click(sess, ma_bn, config, "doctor", "billing")
            if clicked and clicked.get("html"):
                soup = _soup(clicked["html"])
                table = soup.select_one("div#dsDichVu table")
                if table is None:
                    tables = soup.find_all("table")
                    table = max(tables, key=lambda t: len(t.find_all("tr"))) if tables else None

        if table is None:
            base["_fetch_status"] = "no_table"
            return base

        rows_out = []
        tong_bhyt = tong_tt = tong_mien = tong_cong = 0.0
        current_loai_yc = ""
        current_khoa    = ""

        for tr in table.find_all("tr"):
            tds = tr.find_all("td")
            if not tds:
                continue

            # Dòng nhóm / dòng khoa: chỉ có 1 td với colspan
            if len(tds) == 1 and tds[0].get("colspan"):
                txt   = tds[0].get_text(strip=True)
                style = tds[0].get("style", "")
                if "ff9150" in style or "background" in style:
                    # Dòng nhóm loại yêu cầu (nền cam)
                    current_loai_yc = txt
                    current_khoa    = ""
                else:
                    # Dòng khoa phòng
                    current_khoa = txt
                continue

            # Dòng dữ liệu: cần đủ 15 cột
            # [0]chk [1]stt [2]tg_ylenh [3]tg_th [4]ma_dv [5]ten_dv [6]chi_tiet
            # [7]doi_tuong [8]so_the [9]sl [10]don_gia [11]chenh_lech [12]ty_le [13]muc_huong [14]tvụ
            if len(tds) < 14:
                continue

            ten_dv    = tds[5].get_text(strip=True)
            if not ten_dv:
                continue

            tg_ylenh  = tds[2].get_text(strip=True)
            ma_dv     = tds[4].get_text(strip=True)
            chi_tiet  = tds[6].get_text(strip=True)
            doi_tuong = tds[7].get_text(strip=True)
            so_the    = tds[8].get_text(strip=True)
            sl        = _money(tds[9].get_text(strip=True)) or 1.0
            don_gia   = _money(tds[10].get_text(strip=True))
            chenh_lech = _money(tds[11].get_text(strip=True)) if len(tds) > 11 else 0
            ty_le_tt  = tds[12].get_text(strip=True) if len(tds) > 12 else ""
            muc_huong = tds[13].get_text(strip=True) if len(tds) > 13 else ""
            thanh_tien = sl * don_gia

            # Phân nhóm đối tượng thanh toán
            dt_norm = _norm(doi_tuong)
            if any(k in dt_norm for k in ("bao hiem", "bhyt")):
                pg = "bhyt"
                tong_bhyt += thanh_tien
            elif any(k in dt_norm for k in ("vien phi", "tu tuc", "dich vu", "ngoai bhyt", "tt0")):
                pg = "self_pay"
                tong_tt += thanh_tien
            elif any(k in dt_norm for k in ("trong goi", "mien", "khong thu")) or don_gia == 0:
                pg = "zero"
                tong_mien += thanh_tien
            else:
                pg = "unknown"
            tong_cong += thanh_tien

            rows_out.append({
                "loai_yc":       current_loai_yc,
                "khoa":          current_khoa,
                "tg_ylenh":      tg_ylenh,
                "ma_dv":         ma_dv,
                "name":          ten_dv,
                "chi_tiet":      chi_tiet,
                "doi_tuong":     doi_tuong,
                "so_the_bh":     so_the,
                "sl":            sl,
                "don_gia":       don_gia,
                "chenh_lech":    chenh_lech,
                "ty_le_tt":      ty_le_tt,
                "muc_huong":     muc_huong,
                "thanh_tien":    thanh_tien,
                "payment_group": pg,
            })

        base["rows"]        = rows_out
        base["tong_bhyt"]   = round(tong_bhyt,   0)
        base["tong_tu_tuc"] = round(tong_tt,     0)
        base["tong_mien"]   = round(tong_mien,   0)
        base["tong_cong"]   = round(tong_cong,   0)
        base["_fetch_status"] = "ok"
        print(f"LOG [billing] {ma_bn}: {len(rows_out)} dòng | "
              f"BHYT={tong_bhyt:,.0f} | ViênPhí={tong_tt:,.0f} | Miễn={tong_mien:,.0f} | Tổng={tong_cong:,.0f}")

    except Exception as e:
        print(f"ERROR [billing] {ma_bn}: {e}", file=sys.stderr)
        base["_fetch_status"] = "error"
        base["_error"] = str(e)

    return base


    base: Dict[str, Any] = {
        "ma_bn":       ma_bn,
        "rows":        [],
        "tong_bhyt":   0,
        "tong_tu_tuc": 0,
        "tong_mien":   0,
        "tong_cong":   0,
        "_source":     "emr_billing_page",
        "_fetch_status": "pending",
    }

    if sess is None:
        base["_fetch_status"] = "no_session"
        return base

    try:
        base_origin = sess.base_origin
        billing_wpid = config.get("billing_wpid") or config.get("url_billing_wpid") or ""
        view_url = _patient_page_url(link_map, ma_bn, config, base_origin)

        if not view_url:
            print(f"WARN [billing] Không tìm thấy URL BN {ma_bn}", file=sys.stderr)
            base["_fetch_status"] = "no_url"
            return base

        # Thử tìm link bảng kê trong trang BN trước
        target_url: Optional[str] = None
        if billing_wpid:
            target_url = _upsert_query(view_url, wpid=billing_wpid)
        else:
            # Tự tìm link bảng kê / chi phí trong trang BN
            html0, _ = sess.get_html(view_url)
            soup0 = _soup(html0)
            for a in soup0.find_all("a", href=True):
                txt = _norm(a.get_text())
                href = a["href"]
                if any(kw in txt for kw in ("bang ke", "chi phi", "vien phi", "thanh toan")) \
                   or any(kw in href.lower() for kw in ("bangke", "chiphi", "vienph", "billing")):
                    target_url = urljoin(view_url, href)
                    print(f"LOG [billing] Tìm thấy link bảng kê: {target_url}")
                    break

        if not target_url:
            print(f"WARN [billing] Không tìm thấy trang bảng kê cho BN {ma_bn}. "
                  f"Thêm 'billing_wpid' vào config.json để chỉ định.", file=sys.stderr)
            base["_fetch_status"] = "no_billing_page"
            return base

        html, _ = sess.get_html(target_url)
        soup = _soup(html)

        # Tìm bảng chi phí — thường có id chứa "bangke", "chiphi", "gridview"
        table = None
        for t in soup.find_all("table"):
            tid = (t.get("id") or "").lower()
            tcls = " ".join(t.get("class") or []).lower()
            if any(kw in tid or kw in tcls
                   for kw in ("bangke", "chiphi", "gridview", "billing", "vienph")):
                table = t
                break
        if table is None:
            # Lấy bảng lớn nhất làm fallback
            all_tables = soup.find_all("table")
            if all_tables:
                table = max(all_tables, key=lambda t: len(t.find_all("tr")))

        rows_raw = _table_to_rows(table)
        rows_out = []
        tong_bhyt = tong_tt = tong_mien = tong_cong = 0.0

        for r in rows_raw:
            # Chuẩn hóa tên cột (tên cột EMR hay thay đổi)
            name = _t(r.get("Tên dịch vụ") or r.get("Tên thuốc") or r.get("Nội dung")
                      or r.get("Tên") or r.get("Dịch vụ") or r.get("Tên DVKT"))
            if not name:
                continue
            qty_raw  = _t(r.get("Số lượng") or r.get("SL") or r.get("Sl") or "1")
            price_raw = _t(r.get("Đơn giá") or r.get("Giá") or "0")
            total_raw = _t(r.get("Thành tiền") or r.get("Tổng") or r.get("Tổng tiền") or "0")
            payment   = _t(r.get("Đối tượng") or r.get("Nhóm TT") or r.get("Loại") or r.get("BHYT") or "")
            date_val  = _t(r.get("Ngày") or r.get("Ngày TH") or r.get("Ngày y lệnh") or "")

            def _money(s: str) -> float:
                return float(re.sub(r"[^\d.]", "", s) or "0")

            qty   = float(re.sub(r"[^\d.]", "", qty_raw) or "1") or 1.0
            price = _money(price_raw)
            total = _money(total_raw) or price * qty

            # Phân nhóm thanh toán
            pnorm = _norm(payment)
            if any(k in pnorm for k in ("tu tuc", "tt0", "khong bhyt", "dich vu", "ngoai bhyt")):
                pg = "self_pay"
                tong_tt += total
            elif any(k in pnorm for k in ("bhyt", "bao hiem", "muc huong", "80%", "95%", "100%")):
                pg = "bhyt"
                tong_bhyt += total
            elif any(k in pnorm for k in ("mien", "khong thu", "0 d")):
                pg = "zero"
                tong_mien += total
            else:
                pg = "unknown"
            tong_cong += total

            rows_out.append({
                "name":          name,
                "qty":           qty,
                "don_gia":       price,
                "thanh_tien":    total,
                "payment_group": pg,
                "payment_raw":   payment,
                "date":          date_val,
            })

        base["rows"]        = rows_out
        base["tong_bhyt"]   = round(tong_bhyt, 0)
        base["tong_tu_tuc"] = round(tong_tt, 0)
        base["tong_mien"]   = round(tong_mien, 0)
        base["tong_cong"]   = round(tong_cong, 0)
        base["_fetch_status"] = "ok"
        print(f"LOG [billing] {ma_bn}: {len(rows_out)} dòng | BHYT={tong_bhyt:,.0f} | TT={tong_tt:,.0f}")

    except Exception as e:
        print(f"ERROR [billing] {ma_bn}: {e}", file=sys.stderr)
        base["_fetch_status"] = "error"
        base["_error"] = str(e)

    return base


# ── Fetcher: bed_days (ngày giường) ──────────────────────────────────────────

def fetch_bed_days(sess: Optional["EmrHttpSession"], ma_bn: str,
                   date_from: str, date_to: str,
                   link_map: Dict[str, str], config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Lấy timeline buồng giường từ trang 'Chăm sóc → Buồng giường'.

    Cách EMR hiển thị (đã xác nhận từ HTML thực tế):
    - Click nút <a id="btnBG"> → trang load div#vertical-timeline
    - Mỗi đợt giường là 1 div.row bên trong div#vertical-timeline
    - Mỗi row có 2 cột:
        + Cột trái (div.col-xs-9): trạng thái badge, "Từ: HH:MM DD/MM/YYYY", "Đến: ...", người chỉ định, loại
        + Cột phải (h2): tên giường + phòng
    - Trạng thái: "Hoàn tất" (đỏ) | "Đang thực hiện" (xanh) | "Hủy"
    - Số ngày giường = tổng các đợt có trạng thái != Hủy
    - Tính số ngày mỗi đợt: (ngày_den.date - ngay_tu.date).days + 1, min=1
    """
    from datetime import datetime as _dt

    base: Dict[str, Any] = {
        "ma_bn":         ma_bn,
        "so_ngay_tinh":  0,    # tổng ngày giường đã được phân (trừ Hủy)
        "so_ngay_thuc":  0,    # tính từ profile: ngay_vao → ngay_ra
        "rows":          [],   # chi tiết từng đợt giường
        "warnings":      [],
        "_source":       "emr_buong_giuong",
        "_fetch_status": "pending",
    }

    # Tính so_ngay_thuc từ date_from/date_to nếu có
    def _parse_dmy(s: str):
        m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})", _t(s))
        if m:
            from datetime import date
            try: return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
            except: pass
        return None

    d_from = _parse_dmy(date_from)
    d_to   = _parse_dmy(date_to)
    if d_from and d_to:
        base["so_ngay_thuc"] = max(0, (d_to - d_from).days + 1)

    if sess is None:
        base["_fetch_status"] = "no_session"
        return base

    try:
        view_url = _patient_page_url(link_map, ma_bn, config, sess.base_origin, kind="nursing")
        if not view_url:
            base["_fetch_status"] = "no_url"
            return base

        # Buồng giường phải đi từ con mắt điều dưỡng, không dùng link tên BN.
        # Trang buồng giường: dùng wpid nếu có, không thì gọi thẳng view_url
        # (btnBG là onclick JS → server thường render fragment qua AJAX hoặc load cùng trang)
        bed_wpid = config.get("bed_days_wpid") or ""
        target_url = _upsert_query(view_url, wpid=bed_wpid) if bed_wpid else view_url
        html, _ = sess.get_html(target_url)
        soup = _soup(html)

        def _find_bed_timeline(soup_obj):
            # Chỉ nhận vùng kết quả thật sau khi bấm Chăm sóc → Buồng giường.
            # Không nhận menu bên trái chỉ vì có chữ "Buồng giường".
            tl = soup_obj.find("div", id="vertical-timeline")
            if tl is not None:
                return tl
            for d in soup_obj.find_all("div"):
                classes = d.get("class") or []
                text_norm = _norm(d.get_text(" ", strip=True))
                if "vertical-container" in classes and ("trang thai" in text_norm or "giuong" in text_norm):
                    return d
                if d.get("id") in {"ibox-content", "bgContent"} and "thong tin buong giuong" in text_norm and "trang thai" in text_norm:
                    return d
            return None

        # Parse từng đợt giường trong div#vertical-timeline. Nếu HTTP chỉ mở trang điều dưỡng
        # nhưng chưa click btnBG, timeline sẽ không có → chuyển sang Selenium bấm thật.
        timeline = _find_bed_timeline(soup)

        if timeline is None:
            clicked = _fetch_hchanh_html_by_click(sess, ma_bn, config, "nursing", "bed_days", date_from=date_from, date_to=date_to)
            if clicked and clicked.get("html"):
                soup = _soup(clicked["html"])
                timeline = _find_bed_timeline(soup)

        rows_out = []

        if timeline:
            for row_div in timeline.select("div.row"):
                col_left = row_div.select_one("div.col-xs-9, div.col-sm-9, div.col-md-9")
                if not col_left:
                    continue

                text_left = col_left.get_text("\n", strip=True)

                # Trạng thái
                badge = col_left.find("span", class_="badge")
                trang_thai = badge.get_text(strip=True) if badge else ""
                if not trang_thai:
                    continue

                # Từ / Đến
                tu_m  = re.search(r"Từ:\s*(.+)", text_left)
                den_m = re.search(r"Đến:\s*(.+)", text_left)
                ng_m  = re.search(r"Người chỉ định:\s*(.+)", text_left)
                loai_m = re.search(r"Loại:\s*(.+)", text_left)

                tu_str  = _t(tu_m.group(1))  if tu_m  else ""
                den_str = _t(den_m.group(1)) if den_m else ""

                # Tên giường từ cột phải
                h2 = row_div.find("h2")
                ten_giuong = h2.get_text(strip=True) if h2 else ""
                p_tag = row_div.find("p")
                mo_ta = p_tag.get_text(strip=True)[:120] if p_tag else ""

                # Tính số ngày đợt này
                def _parse_emr_dt(s: str):
                    # Format EMR: "HH:MM DD/MM/YYYY (Thứ N)"
                    m = re.search(r"(\d{1,2}:\d{2})\s+(\d{2}/\d{2}/\d{4})", s)
                    if m:
                        try: return _dt.strptime(f"{m.group(2)} {m.group(1)}", "%d/%m/%Y %H:%M")
                        except: pass
                    return None

                dt_tu  = _parse_emr_dt(tu_str)
                dt_den = _parse_emr_dt(den_str)
                so_ngay = 0
                if dt_tu and dt_den:
                    so_ngay = max(1, (dt_den.date() - dt_tu.date()).days + 1)

                rows_out.append({
                    "trang_thai":     trang_thai,
                    "tu":             tu_str,
                    "den":            den_str,
                    "so_ngay":        so_ngay,
                    "nguoi_chi_dinh": _t(ng_m.group(1))   if ng_m   else "",
                    "loai":           _t(loai_m.group(1)) if loai_m else "",
                    "ten_giuong":     ten_giuong,
                    "mo_ta":          mo_ta,
                })

        # Nếu có marker nhưng không parse được đợt nào, thử bấm thật một lần nữa.
        # Trường hợp thường gặp: page_source chỉ có menu Buồng giường, chưa có dữ liệu AJAX.
        if not rows_out:
            clicked = _fetch_hchanh_html_by_click(sess, ma_bn, config, "nursing", "bed_days", date_from=date_from, date_to=date_to)
            if clicked and clicked.get("html"):
                soup2 = _soup(clicked["html"])
                timeline2 = _find_bed_timeline(soup2)
                if timeline2 is not None and timeline2 is not timeline:
                    for row_div in timeline2.select("div.row"):
                        col_left = row_div.select_one("div.col-xs-9, div.col-sm-9, div.col-md-9")
                        if not col_left:
                            continue
                        text_left = col_left.get_text("\n", strip=True)
                        badge = col_left.find("span", class_="badge")
                        trang_thai = badge.get_text(strip=True) if badge else ""
                        if not trang_thai:
                            continue
                        tu_m  = re.search(r"Từ:\s*(.+)", text_left)
                        den_m = re.search(r"Đến:\s*(.+)", text_left)
                        ng_m  = re.search(r"Người chỉ định:\s*(.+)", text_left)
                        loai_m = re.search(r"Loại:\s*(.+)", text_left)
                        tu_str  = _t(tu_m.group(1))  if tu_m  else ""
                        den_str = _t(den_m.group(1)) if den_m else ""
                        h2 = row_div.find("h2")
                        ten_giuong = h2.get_text(strip=True) if h2 else ""
                        p_tag = row_div.find("p")
                        mo_ta = p_tag.get_text(strip=True)[:120] if p_tag else ""
                        def _parse_emr_dt2(s: str):
                            m = re.search(r"(\d{1,2}:\d{2})\s+(\d{2}/\d{2}/\d{4})", s)
                            if m:
                                try: return _dt.strptime(f"{m.group(2)} {m.group(1)}", "%d/%m/%Y %H:%M")
                                except Exception: pass
                            return None
                        dt_tu  = _parse_emr_dt2(tu_str)
                        dt_den = _parse_emr_dt2(den_str)
                        so_ngay = max(1, (dt_den.date() - dt_tu.date()).days + 1) if dt_tu and dt_den else 0
                        rows_out.append({
                            "trang_thai":     trang_thai,
                            "tu":             tu_str,
                            "den":            den_str,
                            "so_ngay":        so_ngay,
                            "nguoi_chi_dinh": _t(ng_m.group(1))   if ng_m   else "",
                            "loai":           _t(loai_m.group(1)) if loai_m else "",
                            "ten_giuong":     ten_giuong,
                            "mo_ta":          mo_ta,
                        })

        base["rows"] = rows_out

        # Tổng ngày giường = các đợt không bị Hủy
        valid_rows = [r for r in rows_out if "huy" not in _norm(r["trang_thai"])]
        base["so_ngay_tinh"] = sum(r["so_ngay"] for r in valid_rows)

        # Cảnh báo nếu chênh lệch với thực tế
        tinh = base["so_ngay_tinh"]
        thuc = base["so_ngay_thuc"]
        if tinh > 0 and thuc > 0:
            if tinh < thuc:
                base["warnings"].append(
                    f"Tính tiền {tinh} ngày giường nhưng thực tế nằm {thuc} ngày (thiếu {thuc - tinh} ngày)."
                )
            elif tinh > thuc:
                base["warnings"].append(
                    f"Tính tiền {tinh} ngày giường nhưng thực tế chỉ nằm {thuc} ngày (dư {tinh - thuc} ngày)."
                )

        base["_fetch_status"] = "ok"
        print(f"LOG [bed_days] {ma_bn}: {len(rows_out)} đợt giường | tinh={tinh} | thuc={thuc} | warnings={len(base['warnings'])}")

    except Exception as e:
        print(f"ERROR [bed_days] {ma_bn}: {e}", file=sys.stderr)
        base["_fetch_status"] = "error"
        base["_error"] = str(e)

    return base


    base: Dict[str, Any] = {
        "ma_bn":         ma_bn,
        "so_ngay_tinh":  0,
        "so_ngay_thuc":  0,
        "rows":          [],
        "warnings":      [],
        "_source":       "emr_bed_timeline",
        "_fetch_status": "pending",
    }

    # Tính ngày thực từ date_from / date_to
    def _parse_dmy(s: str):
        m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})", _t(s))
        if m:
            from datetime import date
            return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
        return None

    d_from = _parse_dmy(date_from)
    d_to   = _parse_dmy(date_to)
    if d_from and d_to:
        delta = (d_to - d_from).days + 1
        base["so_ngay_thuc"] = max(0, delta)

    if sess is None:
        base["_fetch_status"] = "no_session"
        return base

    try:
        base_origin = sess.base_origin
        bed_wpid = config.get("bed_days_wpid") or config.get("url_bed_days_wpid") or ""
        view_url = _patient_page_url(link_map, ma_bn, config, base_origin)

        if not view_url:
            base["_fetch_status"] = "no_url"
            return base

        target_url = _upsert_query(view_url, wpid=bed_wpid) if bed_wpid else view_url
        html, _ = sess.get_html(target_url)
        soup = _soup(html)

        # Tìm bảng / số ngày giường
        # Pattern 1: tìm text "tiền giường" / "ngày giường" và lấy số gần đó
        full_text = soup.get_text(" ")
        m_days = re.search(
            r"(?:tiền giường|ngày giường|số ngày giường|bed days?)[^\d]{0,30}(\d{1,4})",
            _norm(full_text)
        )
        if m_days:
            base["so_ngay_tinh"] = int(m_days.group(1))

        # Pattern 2: tìm bảng chứa từ "giường"
        bed_table = None
        for t in soup.find_all("table"):
            if "giuong" in _norm(str(t)):
                bed_table = t
                break
        if bed_table:
            rows_raw = _table_to_rows(bed_table)
            rows_out = []
            for r in rows_raw:
                ngay = _t(r.get("Ngày") or r.get("Từ ngày") or r.get("Ngày vào"))
                loai = _t(r.get("Loại giường") or r.get("Loại") or r.get("Buồng") or r.get("Phòng"))
                gia  = _t(r.get("Đơn giá") or r.get("Giá") or "0")
                so_ngay = _t(r.get("Số ngày") or r.get("SL") or "1")
                if ngay or loai:
                    rows_out.append({"ngay": ngay, "loai_giuong": loai, "don_gia": gia, "so_ngay": so_ngay})
            base["rows"] = rows_out
            if not base["so_ngay_tinh"] and rows_out:
                total_days = sum(int(re.sub(r"\D", "", r["so_ngay"]) or "1") for r in rows_out)
                base["so_ngay_tinh"] = total_days

        # Cảnh báo nếu chênh lệch
        tính = base["so_ngay_tinh"]
        thực = base["so_ngay_thuc"]
        if tính > 0 and thực > 0:
            if tính < thực:
                base["warnings"].append(
                    f"Tính tiền {tính} ngày giường nhưng thực tế nằm {thực} ngày (thiếu {thực - tính} ngày)."
                )
            elif tính > thực:
                base["warnings"].append(
                    f"Tính tiền {tính} ngày giường nhưng thực tế chỉ nằm {thực} ngày (dư {tính - thực} ngày)."
                )

        base["_fetch_status"] = "ok"
        print(f"LOG [bed_days] {ma_bn}: tinh={tính} thuc={thực} warnings={len(base['warnings'])}")

    except Exception as e:
        print(f"ERROR [bed_days] {ma_bn}: {e}", file=sys.stderr)
        base["_fetch_status"] = "error"
        base["_error"] = str(e)

    return base



# ── Fetcher: surgery (phân loại phẫu thuật) ──────────────────────────────────

def _build_surgery_list_url_from_current(current_url: str, config: Dict[str, Any]) -> str:
    """Build URL D/s Phẫu thuật từ phiên đang đăng nhập.

    Lưu ý: D/s Phẫu thuật là một mục menu ngang cấp với D/s Điều trị nội trú,
    không phải một tab trong hồ sơ BN. Vì vậy khi build URL từ trang hồ sơ BN
    phải bỏ các tham số theo người bệnh như noitruid/keyword/nextlink để tránh
    EMR vẫn giữ ngữ cảnh hồ sơ cũ và không mở đúng danh sách phẫu thuật.
    """
    configured = str(config.get("url_surgery_list") or config.get("surgery_list_url") or "").strip()
    source = current_url or configured or str(config.get("url_inpatient_list") or "")
    p_src = urlparse(source)
    p_cfg = urlparse(configured) if configured else p_src
    q_src = dict(parse_qsl(p_src.query, keep_blank_values=True))
    q_cfg = dict(parse_qsl(p_cfg.query, keep_blank_values=True)) if configured else {}

    # Giữ token phiên/role, nhưng bỏ toàn bộ tham số chi tiết BN/danh sách nội trú.
    q: Dict[str, str] = {}
    for k in ("scope", "lang", "role", "usid", "st"):
        if q_cfg.get(k):
            q[k] = q_cfg[k]
        elif q_src.get(k):
            q[k] = q_src[k]
    q["wpid"] = str(config.get("surgery_list_wpid") or q_cfg.get("wpid") or "danhsachphauthuatdraw")

    scheme = p_cfg.scheme or p_src.scheme or "http"
    netloc = p_cfg.netloc or p_src.netloc
    path = p_cfg.path or p_src.path or "/home.aspx"
    return urlunparse((scheme, netloc, path, "", urlencode(q), ""))


def _surgery_list_url_from_sidebar_html(html: str, current_url: str = "") -> str:
    """Lấy href D/s Phẫu thuật trực tiếp từ side-menu nếu trang hiện tại có menu.

    EMR đặt mục Phẫu thuật cùng side-menu với Điều trị Nội trú; href này là nguồn
    chính xác nhất vì đã có đúng role/usid/st và không kèm noitruid/keyword.
    """
    soup = _soup(html or "")
    candidates = []
    for a in soup.find_all("a", href=True):
        href = _t(a.get("href"))
        txt = _norm(a.get_text(" ", strip=True))
        if not href:
            continue
        href_l = href.lower()
        if "wpid=danhsachphauthuatdraw" in href_l or ("d/s phau thuat" in txt and "phauthuat" in href_l):
            candidates.append(href)
    if not candidates:
        return ""
    base = current_url or ""
    return urljoin(base, candidates[0]) if base else candidates[0]


def _open_surgery_list_page(driver: Any, fallback_url: str) -> str:
    """Mở D/s Phẫu thuật từ menu bên trái, fallback bằng URL đã build."""
    current = getattr(driver, "current_url", "") or fallback_url
    html = getattr(driver, "page_source", "") or ""
    sidebar_url = _surgery_list_url_from_sidebar_html(html, current)
    target = sidebar_url or fallback_url

    # Nếu có link trong menu thì bấm/call trực tiếp để giống thao tác tay; nếu không thì get URL.
    if sidebar_url:
        try:
            ok = driver.execute_script(
                r"""
                const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
                const links = Array.from(document.querySelectorAll('a[href]'));
                const a = links.find(x => /wpid=danhsachphauthuatdraw/i.test(x.getAttribute('href') || ''))
                       || links.find(x => norm(x.textContent).includes('d/s phau thuat'));
                if (!a) return false;
                try {
                    const li = a.closest('li');
                    const parentUl = li && li.parentElement;
                    if (parentUl && parentUl.classList.contains('collapse') && !parentUl.classList.contains('in')) {
                        parentUl.style.height = 'auto';
                        parentUl.classList.add('in');
                    }
                } catch(e) {}
                a.scrollIntoView({block:'center'});
                a.click();
                return true;
                """
            )
            if ok:
                try:
                    _selenium_wait_after_action(driver, 1.0, ready_timeout=12)  # type: ignore[misc]
                except Exception:
                    time.sleep(1.0)
                cur = getattr(driver, "current_url", "") or ""
                if "danhsachphauthuatdraw" in cur.lower() or "danhsachphauthuatdraw" in (getattr(driver, "page_source", "") or "").lower():
                    print("LOG [surgery] Đã mở D/s Phẫu thuật từ side-menu.")
                    return cur or sidebar_url
        except Exception as e:
            print(f"WARN [surgery] Không bấm được D/s Phẫu thuật trong side-menu: {e}", file=sys.stderr)

    driver.get(target)
    try:
        _selenium_wait_after_action(driver, 1.0, ready_timeout=12)  # type: ignore[misc]
    except Exception:
        time.sleep(1.0)
    return getattr(driver, "current_url", "") or target


def _set_input_value_js(driver: Any, selector: str, value: str) -> None:
    driver.execute_script(
        """
        const el = document.querySelector(arguments[0]);
        if (!el) return false;
        el.value = arguments[1];
        el.dispatchEvent(new Event('input', {bubbles:true}));
        el.dispatchEvent(new Event('change', {bubbles:true}));
        try { if (window.jQuery) window.jQuery(el).trigger('change'); } catch(e) {}
        return true;
        """,
        selector,
        value,
    )


def _set_select_value_js(driver: Any, selector: str, value: str) -> None:
    driver.execute_script(
        """
        const el = document.querySelector(arguments[0]);
        if (!el) return false;
        el.value = arguments[1];
        el.dispatchEvent(new Event('change', {bubbles:true}));
        try { if (window.jQuery) window.jQuery(el).trigger('change'); } catch(e) {}
        return true;
        """,
        selector,
        value,
    )


def _selected_text_from_soup(soup_obj: Any, element_id: str) -> str:
    el = soup_obj.find(id=element_id)
    if el is None:
        return ""
    name = (getattr(el, "name", "") or "").lower()
    if name in {"input", "textarea"}:
        return _t(el.get("value"))
    if name == "select":
        selected = [o.get_text(" ", strip=True) for o in el.find_all("option") if o.has_attr("selected")]
        if selected:
            return " · ".join(_t(x) for x in selected if _t(x))
        opt = el.find("option")
        return _get_text(opt) if opt else ""
    return _get_text(el)


def _field_data_id_from_soup(soup_obj: Any, element_id: str) -> str:
    el = soup_obj.find(id=element_id)
    if el is None:
        return ""
    return _t(el.get("data-id") or el.get("data_id") or el.get("value"))


_SURGERY_CLASS_BY_DATA_ID = {
    # input#txtPhanLoaiPTTT thường không có value hiển thị; EMR chỉ gắn data-id.
    # Các mã này được lấy từ DOM thực tế của trang Thông tin phẫu thuật.
    "5e5bc4f8-8be6-44f8-83f6-b32701074173": "Đặc biệt",
    "f964cad8-2587-4811-8a25-b3270107416d": "Loại 1",
    "cd7e1125-dde2-4821-a1e3-b3270107416f": "Loại 2",
    "419c0a21-feaf-4d0d-b957-b32701074171": "Loại 3",
    "932fddd2-e895-47a1-a388-b3270107416b": "Chưa phân loại",
}


def _surgery_class_from_data_id(data_id: Any) -> str:
    key = _t(data_id).lower()
    if not key:
        return ""
    return _SURGERY_CLASS_BY_DATA_ID.get(key, "")


def _surgery_class_from_soup(soup_obj: Any) -> Tuple[str, str]:
    """Trả về (tên phân loại, data-id) từ input#txtPhanLoaiPTTT.

    Trường này trong EMR là input disabled, nhiều ca value rỗng nhưng data-id có ý nghĩa:
    Đặc biệt/Loại 1/Loại 2/Loại 3/Chưa phân loại.
    """
    data_id = _field_data_id_from_soup(soup_obj, "txtPhanLoaiPTTT")
    label = _selected_text_from_soup(soup_obj, "txtPhanLoaiPTTT")
    if not label:
        label = _surgery_class_from_data_id(data_id)
    return label, data_id


def _parse_emr_datetime(value: Any):
    """Parse các mốc thời gian EMR: HH:mm dd/mm/yyyy, HH:mm dd-mm-yyyy, dd/mm/yyyy."""
    from datetime import datetime as _dt
    raw = _t(value)
    if not raw:
        return None
    raw = raw.replace("-", "/")
    patterns = [
        r"(\d{1,2}:\d{2})\s+(\d{1,2}/\d{1,2}/\d{4})",
        r"(\d{1,2}/\d{1,2}/\d{4})\s+(\d{1,2}:\d{2})",
        r"(\d{1,2}/\d{1,2}/\d{4})",
    ]
    for i, pat in enumerate(patterns):
        m = re.search(pat, raw)
        if not m:
            continue
        try:
            if i == 0:
                return _dt.strptime(f"{m.group(2)} {m.group(1)}", "%d/%m/%Y %H:%M")
            if i == 1:
                return _dt.strptime(f"{m.group(1)} {m.group(2)}", "%d/%m/%Y %H:%M")
            return _dt.strptime(m.group(1), "%d/%m/%Y")
        except Exception:
            continue
    return None


def _format_emr_datetime(dt: Any) -> str:
    try:
        return dt.strftime("%H:%M %d/%m/%Y")
    except Exception:
        return ""


def _format_emr_date(dt: Any) -> str:
    try:
        return dt.strftime("%d/%m/%Y")
    except Exception:
        return ""


def _parse_order_history_khoa_list_from_html(html: str) -> List[Dict[str, Any]]:
    """Lấy các mốc 'Khoa điều trị thứ ... (Ngày vào: ...)' trong Lịch sử y lệnh.

    Dùng cho nghiệp vụ hành chánh: sau phẫu thuật phải biết thời điểm BN được nhận
    lại vào khoa để đối chiếu ngày giường ngoại/nội.
    """
    soup = _soup(html)
    khoa_list: List[Dict[str, Any]] = []
    seen = set()
    for h5 in soup.find_all("h5"):
        onclick = h5.get("onclick", "") or ""
        text = h5.get_text(" ", strip=True)
        if "Khoa điều trị" not in text and "showAllTrangThaiYLenh" not in onclick:
            continue
        m_noi = re.search(r"showAllTrangThaiYLenh\('([^']+)'\)", onclick)
        m_stt = re.search(r"Khoa\s+điều\s+trị\s+thứ\s*(\d+)", text, flags=re.I)
        m_khoa = re.search(r"Khoa\s+điều\s+trị[^:]*:\s*(.+?)\s*\(", text, flags=re.I)
        m_vao = re.search(r"Ngày\s+vào:\s*([0-9]{1,2}:[0-9]{2}\s+[0-9]{1,2}/[0-9]{1,2}/[0-9]{4})", text, flags=re.I)
        m_cd = re.search(r"Chẩn\s*đoán:\s*(.+?)\s*-\s*Trạng\s*thái", text, flags=re.I)
        m_tt = re.search(r"Trạng\s*thái:\s*(.+?)\s*\)", text, flags=re.I)
        ngay_vao = _t(m_vao.group(1)) if m_vao else ""
        dt = _parse_emr_datetime(ngay_vao)
        row = {
            "thu_tu": int(m_stt.group(1)) if m_stt else None,
            "noitruid": _t(m_noi.group(1)) if m_noi else "",
            "ten_khoa": _t(m_khoa.group(1)) if m_khoa else "",
            "ngay_vao": ngay_vao,
            "ngay_vao_iso": dt.isoformat() if dt else "",
            "chan_doan": _t(m_cd.group(1)) if m_cd else "",
            "trang_thai": _t(m_tt.group(1)) if m_tt else "",
        }
        key = row["noitruid"] or f"{row['thu_tu']}|{row['ten_khoa']}|{row['ngay_vao']}"
        if key in seen:
            continue
        seen.add(key)
        if row["ten_khoa"] or row["ngay_vao"] or row["noitruid"]:
            khoa_list.append(row)
    khoa_list.sort(key=lambda r: (_parse_emr_datetime(r.get("ngay_vao")) or _parse_emr_datetime("01/01/1900"), r.get("thu_tu") or 0))
    return khoa_list


def _fetch_order_history_khoa_list(sess: Optional["EmrHttpSession"], ma_bn: str,
                                   date_from: str, date_to: str,
                                   link_map: Dict[str, str], config: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Mở Lịch sử y lệnh và lấy mốc vào khoa/nhận khoa sau mổ."""
    rows: List[Dict[str, Any]] = []
    if sess is not None:
        try:
            view_url = _patient_page_url(link_map, ma_bn, config, sess.base_origin)
            if view_url:
                order_url = _upsert_query(view_url,
                                          wpid="bacsidraw",
                                          tg="6",
                                          tungay=date_from or "01/01/2026",
                                          denngay=date_to or "31/12/2026",
                                          nextlink="lichsuylenh",
                                          page="1")
                html, _ = sess.get_html(_order_history_show_all_url(order_url))
                rows = _parse_order_history_khoa_list_from_html(html)
        except Exception as e:
            print(f"WARN [postop-ward] Không đọc được mốc vào khoa bằng HTTP: {e}", file=sys.stderr)
    if rows:
        return rows

    # Một số EMR chỉ dựng nhóm khoa sau khi click tên BN thật.
    try:
        clicked = _fetch_hchanh_html_by_click(sess, ma_bn, config, "doctor", "order_history", date_from=date_from, date_to=date_to)
        if clicked and clicked.get("html"):
            rows = _parse_order_history_khoa_list_from_html(clicked["html"])
    except Exception as e:
        print(f"WARN [postop-ward] Không đọc được mốc vào khoa sau khi click: {e}", file=sys.stderr)
    return rows


def _parse_order_history_surgery_markers_from_html(html: str) -> List[Dict[str, Any]]:
    """Lấy các dòng Lịch sử y lệnh có dấu hiệu phẫu thuật.

    Ví dụ EMR: dòng y lệnh "Chuyển mổ" có cột kết quả "PT: 1/1" và bác sĩ
    hiển thị thêm "(PT: PHÒNG PHẪU THUẬT)". Mốc TG Y lệnh của dòng này là
    thời điểm chỉ định phẫu thuật cần dùng để tìm trong Phẫu thuật → D/s Phẫu thuật.
    """
    soup = _soup(html)
    out: List[Dict[str, Any]] = []
    seen = set()
    current_date = ""
    dt_re = re.compile(r"\b\d{1,2}:\d{2}\s+\d{1,2}/\d{1,2}/\d{4}\b")
    for tbody in soup.find_all("tbody", id="tbodyylenh"):
        for tr in tbody.find_all("tr"):
            tds = tr.find_all("td")
            if not tds:
                continue
            if len(tds) == 1:
                maybe_date = _get_text(tds[0])
                if re.search(r"\d{1,2}/\d{1,2}/\d{4}", maybe_date):
                    current_date = maybe_date
                continue
            row_text = _get_text(tr)
            row_html = str(tr)
            hay = _norm(" ".join([
                row_text,
                " ".join(_t(a.get("data-content")) for a in tr.find_all("a", attrs={"data-content": True})),
                row_html,
            ]))
            has_pt = (
                re.search(r"\bPT\s*:\s*\d+\s*/\s*\d+", row_text, flags=re.I)
                or "(pt:" in hay
                or "chuyen mo" in hay
                or "phau thuat" in hay
                or "phong phau thuat" in hay
                or "onshowlichsuchung('pt'" in hay
                or 'onshowlichsuchung("pt"' in hay
            )
            if not has_pt:
                continue
            tg_ylenh = ""
            for td in tds:
                txt_td = _get_text(td)
                m_dt = dt_re.search(txt_td)
                if m_dt:
                    tg_ylenh = m_dt.group(0)
                    break
            if not tg_ylenh and current_date:
                tg_ylenh = current_date
            dt = _parse_emr_datetime(tg_ylenh)
            ngay = _format_emr_date(dt) if dt else current_date
            # Cố gắng lấy vài cột theo vị trí, chịu được bảng có/không có cột checkbox.
            cols = [_get_text(td) for td in tds]
            tg_idx = None
            for i, col in enumerate(cols):
                if dt_re.search(col):
                    tg_idx = i
                    break
            so_phieu = cols[tg_idx - 1] if tg_idx is not None and tg_idx >= 1 else ""
            bac_si = cols[tg_idx + 1] if tg_idx is not None and tg_idx + 1 < len(cols) else ""
            dien_bien = ""
            if tg_idx is not None and tg_idx + 2 < len(tds):
                a_db = tds[tg_idx + 2].find("a", attrs={"data-content": True})
                dien_bien = _t(a_db.get("data-content")) if a_db else _get_text(tds[tg_idx + 2])
            kq_text = ""
            if tg_idx is not None and tg_idx + 3 < len(tds):
                kq_text = _get_text(tds[tg_idx + 3])
            key = so_phieu or tg_ylenh or row_text[:80]
            if key in seen:
                continue
            seen.add(key)
            out.append({
                "ngay": ngay,
                "tg_ylenh": tg_ylenh,
                "so_phieu": so_phieu,
                "bac_si": bac_si,
                "dien_bien": dien_bien,
                "kq_text": kq_text,
                "row_text": row_text[:500],
            })
    out.sort(key=lambda r: _parse_emr_datetime(r.get("tg_ylenh")) or _parse_emr_datetime(r.get("ngay")) or _parse_emr_datetime("01/01/1900"))
    return out



def _order_history_show_all_url(url: str) -> str:
    """Thêm các tham số phổ biến để trang Lịch sử y lệnh trả tối đa dòng.

    EMR có select #soLuongHienThi với option value=1000 (Tất cả). Một số màn hình
    chỉ đọc từ DOM/JS, một số đọc từ query; thêm query không hại nếu server bỏ qua.
    """
    try:
        return _upsert_query(url, soLuongHienThi="1000", pageSize="1000", length="1000")
    except Exception:
        return url


def _force_order_history_show_all_in_driver(driver: Any) -> None:
    """Chọn 'Tất cả' trong Lịch sử y lệnh và gọi loadListYLenh() nếu có.

    Dùng cho nhánh Selenium/click thật. Nhánh HTTP vẫn có fallback bằng query string.
    """
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
            try:
                _selenium_wait_after_action(driver, 1.0, ready_timeout=12)  # type: ignore[misc]
            except Exception:
                time.sleep(1.0)
    except Exception:
        pass

def _history_range_from_patient_url(link_map: Dict[str, str], ma_bn: str,
                                    config: Dict[str, Any], base_origin: str,
                                    date_from: str, date_to: str) -> Tuple[str, str]:
    """Lấy khoảng lịch sử rộng đang có trên URL BN, fallback về khoảng UI."""
    tu = _date_to_dmy(date_from) or date_from or ""
    den = _date_to_dmy(date_to) or date_to or tu
    try:
        view_url = _patient_page_url(link_map, ma_bn, config, base_origin)
        q = dict(parse_qsl(urlparse(view_url or "").query, keep_blank_values=True))
        q_tu = _date_to_dmy(q.get("tungay") or "") or q.get("tungay") or ""
        q_den = _date_to_dmy(q.get("denngay") or "") or q.get("denngay") or ""
        if q_tu:
            tu = q_tu
        if q_den:
            den = q_den
    except Exception:
        pass
    return tu, den


def _fetch_order_history_surgery_markers(sess: Optional["EmrHttpSession"], ma_bn: str,
                                         date_from: str, date_to: str,
                                         link_map: Dict[str, str], config: Dict[str, Any]) -> Dict[str, Any]:
    """Đọc Lịch sử y lệnh để lấy mốc PT trước, rồi mới tìm D/s phẫu thuật."""
    out: Dict[str, Any] = {"markers": [], "ward_admissions": [], "history_from": date_from, "history_to": date_to}
    if sess is None:
        return out
    try:
        hist_from, hist_to = _history_range_from_patient_url(link_map, ma_bn, config, sess.base_origin, date_from, date_to)
        out["history_from"] = hist_from
        out["history_to"] = hist_to
        view_url = _patient_page_url(link_map, ma_bn, config, sess.base_origin)
        html = ""
        if view_url:
            order_url = _upsert_query(view_url,
                                      wpid="bacsidraw",
                                      tg="6",
                                      tungay=hist_from or date_from or "01/01/2026",
                                      denngay=hist_to or date_to or "31/12/2026",
                                      nextlink="lichsuylenh",
                                      page="1")
            show_all_url = _order_history_show_all_url(order_url)
            trace_event(
                "ORDER_HISTORY.HTTP_SELECT_SHOW_ALL",
                "HTTP mở lịch sử y lệnh ở chế độ Tất cả",
                screen="Lịch sử y lệnh / select#soLuongHienThi",
                sees="set query soLuongHienThi=1000; pageSize=1000; length=1000",
                takes="HTML toàn bộ y lệnh để dò mốc PT",
                writes="html lịch sử y lệnh tạm thời",
                target=show_all_url,
            )
            html, _ = sess.get_html(show_all_url)
        markers = _parse_order_history_surgery_markers_from_html(html or "")
        ward = _parse_order_history_khoa_list_from_html(html or "")
        trace_event(
            "ORDER_HISTORY.MARKERS_DIRECT",
            "Dò dấu hiệu phẫu thuật bằng HTML HTTP trực tiếp",
            screen="Lịch sử y lệnh / HTTP direct",
            sees=f"markers={len(markers)}; khoa={len(ward)}",
            takes="PT:, PHÒNG PHẪU THUẬT, Chuyển mổ, TRÌNH DUYỆT MỔ, phẫu thuật",
            writes="order_history_surgery_markers + ward_admissions",
            target="output.surgery.order_history_surgery_markers",
        )
        if not markers and not ward:
            trace_event(
                "ORDER_HISTORY.FALLBACK_CLICK_OPEN",
                "HTTP không thấy bảng y lệnh, fallback bấm tên người bệnh",
                screen="D/s Điều trị nội trú → tên người bệnh → Lịch sử y lệnh",
                sees="markers=0 và khoa=0 từ HTML trực tiếp",
                takes="HTML sau thao tác click thật",
                writes="parse lại markers/khoa",
                target="_fetch_hchanh_html_by_click(order_history)",
            )
            clicked = _fetch_hchanh_html_by_click(sess, ma_bn, config, "doctor", "order_history", date_from=hist_from or date_from, date_to=hist_to or date_to)
            if clicked and clicked.get("html"):
                html = clicked.get("html") or ""
                markers = _parse_order_history_surgery_markers_from_html(html)
                ward = _parse_order_history_khoa_list_from_html(html)
                trace_event("ORDER_HISTORY.MARKERS_FALLBACK", "Parse lại mốc PT sau click fallback", screen="Lịch sử y lệnh / click fallback", sees=f"markers={len(markers)}; khoa={len(ward)}", takes="HTML fallback", writes="markers/khoa cập nhật", target="output.surgery")
        out["markers"] = markers
        out["ward_admissions"] = ward
    except Exception as e:
        print(f"WARN [surgery] Không đọc được mốc PT từ lịch sử y lệnh: {e}", file=sys.stderr)
        out["_error"] = str(e)
    return out


def _order_history_row_has_surgery_marker(row: Dict[str, Any]) -> bool:
    """Kiểm tra dấu hiệu PT trên row đã parse từ Lịch sử y lệnh.

    Ưu tiên cờ has_surgery_marker đã được parser gắn. Nếu row cũ chưa có cờ,
    dò lại trên các trường text để không phải mở lại màn hình Lịch sử y lệnh.
    """
    if not isinstance(row, dict):
        return False
    if row.get("has_surgery_marker") is True:
        return True
    hay = _norm(" ".join(_t(row.get(k)) for k in [
        "kq_text", "bac_si", "dien_bien", "y_lenh_khac", "ten_y_lenh", "row_text", "services"
    ]))
    raw = " ".join(_t(row.get(k)) for k in ["kq_text", "row_text"])
    return bool(
        re.search(r"\bPT\s*:\s*\d+\s*/\s*\d+", raw, flags=re.I)
        or "(pt:" in hay
        or "chuyen mo" in hay
        or "trinh duyet mo" in hay
        or "phau thuat" in hay
        or "phong phau thuat" in hay
        or "onshowlichsuchung('pt'" in hay
        or 'onshowlichsuchung("pt"' in hay
    )


def _surgery_gate_from_order_history(order_history: Optional[Dict[str, Any]],
                                     date_from: str, date_to: str) -> Dict[str, Any]:
    """Tạo thông tin gate phẫu thuật từ output.order_history đã lấy trước.

    Mục tiêu: không mở Lịch sử y lệnh lần thứ hai chỉ để dò PT. Rows đã parse
    là nguồn chính; ward_admissions/khoa_list được dùng để ghép khoa sau mổ.
    """
    out: Dict[str, Any] = {
        "markers": [],
        "ward_admissions": [],
        "history_from": date_from,
        "history_to": date_to,
        "_source": "output.order_history.rows",
    }
    if not isinstance(order_history, dict):
        return out
    rows = order_history.get("rows") if isinstance(order_history.get("rows"), list) else []
    markers: List[Dict[str, Any]] = []
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or not _order_history_row_has_surgery_marker(row):
            continue
        tg_ylenh = _t(row.get("tg_ylenh") or row.get("thoi_gian") or row.get("ngay"))
        dt = _parse_emr_datetime(tg_ylenh)
        ngay = _format_emr_date(dt) if dt else (_date_to_dmy(tg_ylenh) or _t(row.get("ngay")))
        key = _t(row.get("so_phieu")) or tg_ylenh or _t(row.get("row_text"))[:120]
        if key in seen:
            continue
        seen.add(key)
        markers.append({
            "ngay": ngay,
            "tg_ylenh": tg_ylenh,
            "so_phieu": _t(row.get("so_phieu")),
            "bac_si": _t(row.get("bac_si")),
            "dien_bien": _t(row.get("dien_bien")),
            "kq_text": _t(row.get("kq_text")),
            "y_lenh_khac": _t(row.get("y_lenh_khac")),
            "khoa": _t(row.get("khoa")),
            "row_text": _t(row.get("row_text"))[:500],
            "_source": "output.order_history.rows",
        })
    markers.sort(key=lambda r: _parse_emr_datetime(r.get("tg_ylenh")) or _parse_emr_datetime(r.get("ngay")) or _parse_emr_datetime("01/01/1900"))
    out["markers"] = markers
    ward = order_history.get("ward_admissions") or order_history.get("khoa_list") or []
    out["ward_admissions"] = ward if isinstance(ward, list) else []
    out["total_rows"] = len(rows)
    return out


def _unique_dmy_dates(values: List[str]) -> List[str]:
    seen = set()
    out: List[str] = []
    for val in values or []:
        dt = _parse_emr_datetime(val)
        dmy = _format_emr_date(dt) if dt else _date_to_dmy(val) or _t(val)
        if not dmy or not re.match(r"\d{1,2}/\d{1,2}/\d{4}$", dmy):
            continue
        if dmy in seen:
            continue
        seen.add(dmy)
        out.append(dmy)
    return out



def _surgery_marker_search_ranges(marker_dates: List[str], history_from: str = "", history_to: str = "", window_days: int = 1) -> List[Tuple[str, str]]:
    """Tạo khoảng tìm phẫu thuật từ mốc y lệnh.

    D/s Phẫu thuật có thể ghi ngày lệch so với TG y lệnh (duyệt mổ trước, mổ sau,
    hoặc ca mổ kết thúc qua ngày). Vì vậy mỗi mốc PT được mở rộng ±window_days và
    các khoảng chồng nhau được merge để giảm số lần mở D/s Phẫu thuật.
    """
    from datetime import timedelta as _td
    win = max(0, int(window_days or 0))
    ranges: List[Tuple[Any, Any]] = []
    for d in marker_dates or []:
        dt = _parse_emr_datetime(d)
        if not dt:
            dmy = _date_to_dmy(d) or _t(d)
            dt = _parse_emr_datetime(dmy)
        if not dt:
            continue
        ranges.append((dt - _td(days=win), dt + _td(days=win)))
    if not ranges:
        hf = _parse_emr_datetime(history_from)
        ht = _parse_emr_datetime(history_to)
        if hf and ht:
            ranges.append((hf, ht))
    ranges.sort(key=lambda x: x[0])
    merged: List[Tuple[Any, Any]] = []
    for start, end in ranges:
        if not merged:
            merged.append((start, end))
            continue
        last_start, last_end = merged[-1]
        if start <= last_end + _td(days=1):
            merged[-1] = (last_start, max(last_end, end))
        else:
            merged.append((start, end))
    out: List[Tuple[str, str]] = []
    for start, end in merged:
        out.append((_format_emr_date(start), _format_emr_date(end)))
    return out


def _pair_surgeries_with_postop_ward(surgeries: List[Dict[str, Any]], ward_admissions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Ghép mỗi ca phẫu thuật với mốc nhận bệnh/vào khoa gần nhất sau đó.

    Nếu dòng DS phẫu thuật chỉ có ngày, vẫn chấp nhận mốc vào khoa cùng ngày hoặc ngày sau.
    """
    ward_dt_rows = []
    for w in ward_admissions or []:
        dt = _parse_emr_datetime(w.get("ngay_vao"))
        if dt:
            ward_dt_rows.append((dt, w))
    ward_dt_rows.sort(key=lambda x: x[0])

    out: List[Dict[str, Any]] = []
    used_keys = set()
    for surg in surgeries or []:
        detail = surg.get("detail") if isinstance(surg.get("detail"), dict) else {}
        ref_raw = detail.get("ket_thuc") or detail.get("bat_dau") or surg.get("ket_thuc") or surg.get("bat_dau") or surg.get("thoi_gian")
        ref_dt = _parse_emr_datetime(ref_raw)
        # Nếu chỉ có ngày từ danh sách phẫu thuật, bắt đầu từ 00:00 ngày đó.
        ref_date = _format_emr_date(ref_dt) if ref_dt else ""
        best = None
        best_dt = None
        for dt, ward in ward_dt_rows:
            key = ward.get("noitruid") or f"{ward.get('ngay_vao')}|{ward.get('ten_khoa')}"
            if key in used_keys:
                continue
            if ref_dt:
                same_day = ref_date and _format_emr_date(dt) == ref_date
                if dt >= ref_dt or same_day:
                    best = ward
                    best_dt = dt
                    break
            elif ref_date and _format_emr_date(dt) >= ref_date:
                best = ward
                best_dt = dt
                break
        if best:
            key = best.get("noitruid") or f"{best.get('ngay_vao')}|{best.get('ten_khoa')}"
            used_keys.add(key)
            surg = {
                **surg,
                "nhan_khoa_sau_pt": best.get("ngay_vao") or _format_emr_datetime(best_dt),
                "khoa_sau_pt": best.get("ten_khoa") or "",
                "postop_ward": best,
            }
            detail = {**detail,
                      "nhan_khoa_sau_pt": surg.get("nhan_khoa_sau_pt"),
                      "khoa_sau_pt": surg.get("khoa_sau_pt"),
                      "postop_ward": best}
            surg["detail"] = detail
        out.append(surg)
    return out


def _wait_for_surgery_list_rows(driver: Any, ma_bn: str, timeout: float = 15.0) -> bool:
    deadline = time.time() + max(1.0, float(timeout or 15.0))
    code = str(ma_bn or "").strip()
    while time.time() < deadline:
        try:
            html = getattr(driver, "page_source", "") or ""
            if "danhsachphauthuatdraw" in (getattr(driver, "current_url", "") or "") and code in html:
                if "phauthuatdraw" in html or "access_id" in html:
                    return True
        except Exception:
            pass
        time.sleep(0.35)
    return False


def _parse_surgery_list_rows(html: str, ma_bn: str) -> List[Dict[str, Any]]:
    soup = _soup(html)
    out: List[Dict[str, Any]] = []
    code = str(ma_bn or "").strip()
    for tr in soup.find_all("tr"):
        tds = tr.find_all("td")
        if len(tds) < 8:
            continue
        row_text = _get_text(tr)
        if code and code not in row_text:
            continue
        href = ""
        for a in tr.find_all("a", href=True):
            h = a.get("href") or ""
            if "wpid=phauthuatdraw" in h or "phauthuatid=" in h:
                href = h
                break
        phauthuatid = _t(tr.get("access_id"))
        if not phauthuatid and href:
            q = dict(parse_qsl(urlparse(href).query, keep_blank_values=True))
            phauthuatid = _t(q.get("phauthuatid"))
        cols = [_get_text(td) for td in tds]
        out.append({
            "stt": cols[0] if len(cols) > 0 else "",
            "ma_bn": cols[1] if len(cols) > 1 else code,
            "ho_ten": cols[2] if len(cols) > 2 else "",
            "gioi_tinh": cols[3] if len(cols) > 3 else "",
            "tuoi": cols[4] if len(cols) > 4 else "",
            "phong_mo": cols[5] if len(cols) > 5 else "",
            "noi_chuyen_mo": cols[6] if len(cols) > 6 else "",
            "noi_dung_phau_thuat": cols[7] if len(cols) > 7 else "",
            "tinh_trang": cols[8] if len(cols) > 8 else "",
            "thoi_gian": cols[9] if len(cols) > 9 else "",
            "trang_thai": cols[10] if len(cols) > 10 else "",
            "doi_tuong": cols[11] if len(cols) > 11 else "",
            "tam_ung": cols[12] if len(cols) > 12 else "",
            "phauthuatid": phauthuatid,
            "url": href,
        })
    return out


def _parse_surgery_detail_html(html: str) -> Dict[str, Any]:
    soup = _soup(html)
    phan_loai_pt, phan_loai_pt_id = _surgery_class_from_soup(soup)
    fields = {
        "bat_dau": _selected_text_from_soup(soup, "txtBatDauPT"),
        "ket_thuc": _selected_text_from_soup(soup, "txtKetThucPT"),
        "dich_vu_phau_thuat": _selected_text_from_soup(soup, "cbbChiDinhMoPT"),
        "doi_tuong_dv": _selected_text_from_soup(soup, "cbbDoiTuongPT"),
        "phan_loai_pt": phan_loai_pt,
        "phan_loai_pt_id": phan_loai_pt_id,
        "pp_vo_cam": _selected_text_from_soup(soup, "cbbPPGayMePT"),
        "phuong_phap_pt": _selected_text_from_soup(soup, "cbbPhuongPhapPT"),
        "icd9": _selected_text_from_soup(soup, "cbbICD9"),
        "chan_doan_truoc_pt": _selected_text_from_soup(soup, "txtChuanDoanTruocMoPT"),
        "chan_doan_sau_pt": _selected_text_from_soup(soup, "txtChuanDoanSauMoPT"),
        "icd10_truoc_pt": _selected_text_from_soup(soup, "cbbIcdChanDoanTruocPT"),
        "icd10_sau_pt": _selected_text_from_soup(soup, "cbbChuanDoanSauPT"),
        "mo_ta_pppt": _selected_text_from_soup(soup, "txtMoTaPPPT"),
        "bs_mo_chinh": _selected_text_from_soup(soup, "cbbBacSiPT"),
        "gay_me_chinh": _selected_text_from_soup(soup, "cbbBacSiGayMeChinh"),
        "ptv_phu_1": _selected_text_from_soup(soup, "cbbBacSiPhuMo1"),
        "ptv_phu_2": _selected_text_from_soup(soup, "cbbBacSiPhuMo2"),
        "dd_dung_cu": _selected_text_from_soup(soup, "cbbDieuDuongDungCu"),
        "ktv_phu_me": _selected_text_from_soup(soup, "cbbKtvPhuMe"),
        "dien_bien_benh": _selected_text_from_soup(soup, "txtDienBienBenh"),
        "dan_do_sau_pt": _selected_text_from_soup(soup, "txtDanDoSauPT"),
    }
    # Bệnh kèm theo sau PT: select2 multiple.
    benh_kem = _selected_text_from_soup(soup, "cboBenhKemTheoSauPT")
    if benh_kem:
        fields["benh_kem_theo_sau_pt"] = [x.strip() for x in re.split(r"\s*·\s*", benh_kem) if x.strip()]
    # Người hoàn tất từ dòng đỏ ở title.
    el_done = soup.find(id="txtTTHoanTat")
    if el_done:
        fields["hoan_tat_text"] = _get_text(el_done)
    return fields


def fetch_surgery(sess: Optional["EmrHttpSession"], ma_bn: str,
                  date_from: str, date_to: str,
                  link_map: Dict[str, str], config: Dict[str, Any],
                  existing_order_history: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Lấy D/s phẫu thuật và Phân loại PT từ trang Phẫu thuật → D/s Phẫu thuật.

    Luồng EMR đã xác nhận:
      Phẫu thuật → D/s Phẫu thuật → tìm mã BN/khoảng ngày → bấm tên BN
      → đọc form Thông tin phẫu thuật, đặc biệt input#txtPhanLoaiPTTT.
    """
    base: Dict[str, Any] = {
        "ma_bn": ma_bn,
        "surgeries": [],
        "total": 0,
        "phan_loai_pt_list": [],
        "_source": "emr_danhsachphauthuatdraw",
        "_fetch_status": "pending",
    }
    if sess is None:
        base["_fetch_status"] = "no_session"
        return base
    if not (_HAS_SELENIUM_LOGIN and _HAS_SELENIUM_SEARCH):
        base["_fetch_status"] = "no_selenium"
        return base

    try:
        ctx = _ensure_hchanh_click_context(sess, ma_bn, config, date_from=date_from, date_to=date_to, reason="surgery", inpatient_status=(config.get("hchanh_inpatient_status") or "Đang thực hiện"))
        if not ctx:
            base["_fetch_status"] = "no_url"
            return base
        driver = ctx.get("driver")
        if driver is None:
            base["_fetch_status"] = "no_driver"
            return base

        # Bước 1: lấy mốc chỉ định PT từ Lịch sử y lệnh.
        # Nếu order_history đã được prefetch trong cùng case, dùng lại rows đã parse
        # để tránh mở Lịch sử y lệnh lần thứ hai.
        if isinstance(existing_order_history, dict) and existing_order_history.get("rows") is not None:
            history_info = _surgery_gate_from_order_history(existing_order_history, date_from, date_to)
            trace_event(
                "ORDER_HISTORY.MARKERS_FINAL",
                "Dùng Lịch sử y lệnh đã lấy trước để dò mốc PT",
                screen="output.order_history.rows",
                sees=f"rows={history_info.get('total_rows', 0)}; markers={len(history_info.get('markers') or [])}; khoa={len(history_info.get('ward_admissions') or [])}",
                takes="rows[].has_surgery_marker và các cột KQ dịch vụ/Bác sĩ/Diễn biến/Y lệnh khác",
                writes="order_history_surgery_markers + ward_admissions",
                target="output.surgery.order_history_surgery_markers",
            )
        else:
            history_info = _fetch_order_history_surgery_markers(sess, ma_bn, date_from, date_to, link_map, config)
        surgery_markers = history_info.get("markers") or []
        ward_admissions = history_info.get("ward_admissions") or []
        marker_dates = _unique_dmy_dates([m.get("tg_ylenh") or m.get("ngay") for m in surgery_markers if isinstance(m, dict)])
        print(f"LOG [surgery] {ma_bn}: lịch sử y lệnh có {len(surgery_markers)} mốc PT" + (f" ({', '.join(marker_dates)})" if marker_dates else ""))
        trace_event(
            "SURGERY.GATE_DECISION",
            "Đánh giá cổng phẫu thuật từ lịch sử y lệnh",
            screen="Lịch sử y lệnh",
            sees=f"{len(surgery_markers)} mốc PT; ngày={', '.join(marker_dates) if marker_dates else '—'}",
            takes="marker từ cột Kết quả dịch vụ/Bác sĩ/Diễn biến/Y lệnh khác",
            writes="quyết định có mở D/s Phẫu thuật hay không",
            target="surgery_gate",
        )

        if not surgery_markers:
            # Không có dấu hiệu PT trong Lịch sử y lệnh → không mở D/s Phẫu thuật.
            # Tránh tốn thời gian và tránh báo thiếu giả cho các ca nội trú không mổ.
            base["order_history_surgery_markers"] = []
            base["ward_admissions"] = ward_admissions
            base["_fetch_status"] = "ok"
            base["_skip_surgery_lookup_reason"] = "no_pt_marker_in_order_history"
            trace_event(
                "SURGERY.GATE_SKIP",
                "Không mở D/s Phẫu thuật vì lịch sử y lệnh không có mốc PT",
                screen="Lịch sử y lệnh",
                sees="không có PT:/Chuyển mổ/TRÌNH DUYỆT MỔ/PHÒNG PHẪU THUẬT",
                takes="surgeries=[]",
                writes="_skip_surgery_lookup_reason=no_pt_marker_in_order_history",
                target="output.surgery",
            )
            print(f"LOG [surgery] {ma_bn}: Lịch sử y lệnh không có mốc PT, bỏ qua D/s phẫu thuật")
            return base

        trace_event(
            "SURGERY.FETCH_START",
            "Bắt đầu mở D/s Phẫu thuật sau khi gate có mốc PT",
            screen="Phẫu thuật → D/s Phẫu thuật",
            sees=f"markers={len(surgery_markers)}; ngày={', '.join(marker_dates) if marker_dates else '—'}",
            takes="ngày mốc PT từ Lịch sử y lệnh",
            writes="chuẩn bị tìm danh sách phẫu thuật",
            target="output.surgery",
        )

        # Dùng cùng phiên Chrome đã đăng nhập, chuyển sang trang D/s Phẫu thuật.
        current = getattr(driver, "current_url", "") or ctx.get("nav_url") or ""
        list_url = _build_surgery_list_url_from_current(str(current), config)

        def _search_surgery_list_once(tu: str, den: str) -> List[Dict[str, Any]]:
            # D/s Phẫu thuật nằm trong side-menu cùng cấp với D/s Điều trị nội trú.
            # Ưu tiên lấy/bấm link thật từ menu để giữ đúng role/usid/st của phiên.
            opened_list_url = _open_surgery_list_page(driver, list_url)
            trace_event(
                "SURGERY.OPEN_LIST",
                "Mở D/s Phẫu thuật sau khi đã có mốc PT",
                screen="Phẫu thuật → D/s Phẫu thuật",
                sees=f"url={opened_list_url}",
                takes="trang danh sách phẫu thuật",
                writes="chuẩn bị set filter loại/khoảng ngày/Mã BN",
                target=opened_list_url,
            )
            _set_select_value_js(driver, "#cbbLoai", "7")
            try:
                driver.execute_script("const d=document.querySelector('#data_5'); if (d) d.style.display='block';")
            except Exception:
                pass
            if tu:
                _set_input_value_js(driver, "#dtTuNgay", f"00:00 {tu}")
            if den:
                _set_input_value_js(driver, "#dtDenNgay", f"23:59 {den}")
            _set_input_value_js(driver, "#txtTimKiem", str(ma_bn))
            try:
                driver.execute_script("if (typeof FilterChange === 'function') { FilterChange(); return true; }")
            except Exception:
                pass
            try:
                from selenium.webdriver.common.by import By  # type: ignore
                for xp in ["//*[@id='btnTimKiem']", "//button[contains(normalize-space(),'Tìm kiếm')]"]:
                    els = driver.find_elements(By.XPATH, xp)
                    if els:
                        _selenium_click_js(driver, els[0])
                        break
            except Exception:
                pass
            try:
                _selenium_wait_after_action(driver, 1.0, ready_timeout=12)  # type: ignore[misc]
            except Exception:
                time.sleep(1.0)
            _wait_for_surgery_list_rows(driver, ma_bn, timeout=15)
            found = _parse_surgery_list_rows(getattr(driver, "page_source", "") or "", ma_bn)
            trace_event(
                "SURGERY.SEARCH_LIST",
                "Tìm ca phẫu thuật theo ngày mốc y lệnh",
                screen="D/s Phẫu thuật",
                sees=f"{len(found)} dòng trong khoảng {tu} → {den}",
                takes="phauthuatid/url/thời gian/nội dung phẫu thuật",
                writes="rows phẫu thuật tạm để mở chi tiết",
                target="output.surgery.surgeries",
            )
            print(f"LOG [surgery] {ma_bn}: tìm D/s phẫu thuật {tu} → {den}: {len(found)} dòng | url={opened_list_url}")
            return found

        # Bước 2: tìm D/s phẫu thuật theo ngày lấy được từ Lịch sử y lệnh.
        # Không tìm đúng 1 ngày nữa: mốc y lệnh có thể là duyệt mổ/chuyển mổ, còn D/s
        # Phẫu thuật có thể ghi ngày mổ hoặc ngày kết thúc lệch ±1 ngày.
        hist_from = history_info.get("history_from") or ""
        hist_to = history_info.get("history_to") or ""
        try:
            marker_window = int(config.get("hchanh_surgery_marker_day_window", 1) or 1)
        except Exception:
            marker_window = 1
        search_ranges: List[Tuple[str, str]] = _surgery_marker_search_ranges(marker_dates, hist_from, hist_to, marker_window)
        if not search_ranges:
            tu0 = _date_to_dmy(date_from) or date_from
            den0 = _date_to_dmy(date_to) or date_to or tu0
            search_ranges.append((tu0, den0))
        if hist_from and hist_to and (hist_from, hist_to) not in search_ranges:
            # Fallback rộng chỉ chạy nếu các khoảng marker không có dòng nào.
            wide_range = (hist_from, hist_to)
        else:
            wide_range = None
        trace_event(
            "SURGERY.SEARCH_RANGE",
            "Tạo khoảng tìm phẫu thuật từ mốc y lệnh có đệm ngày",
            screen="D/s Phẫu thuật / bộ lọc ngày",
            sees=f"marker_dates={', '.join(marker_dates) if marker_dates else '—'}; window_days={marker_window}; ranges={'; '.join([a + ' → ' + b for a, b in search_ranges])}",
            takes="ngày PT marker từ order_history",
            writes="search_ranges cho D/s Phẫu thuật",
            target="surgery_search_ranges",
        )

        rows = []
        seen_pt = set()
        for tu, den in search_ranges:
            for r in _search_surgery_list_once(tu, den):
                key = r.get("phauthuatid") or r.get("url") or f"{r.get('thoi_gian')}|{r.get('noi_dung_phau_thuat')}"
                if key in seen_pt:
                    continue
                seen_pt.add(key)
                rows.append(r)
        if not rows and wide_range:
            trace_event(
                "SURGERY.SEARCH_RANGE",
                "Không có dòng trong khoảng marker, thử lại toàn khoảng lịch sử",
                screen="D/s Phẫu thuật / bộ lọc ngày",
                sees=f"0 dòng từ marker ranges; wide={wide_range[0]} → {wide_range[1]}",
                takes="history_from/history_to",
                writes="fallback search range",
                target="surgery_search_ranges",
            )
            for r in _search_surgery_list_once(wide_range[0], wide_range[1]):
                key = r.get("phauthuatid") or r.get("url") or f"{r.get('thoi_gian')}|{r.get('noi_dung_phau_thuat')}"
                if key in seen_pt:
                    continue
                seen_pt.add(key)
                rows.append(r)

        if not rows:
            base["order_history_surgery_markers"] = surgery_markers
            base["ward_admissions"] = ward_admissions
            base["_fetch_status"] = "ok"
            first_range = search_ranges[0] if search_ranges else (date_from, date_to)
            trace_event(
                "SURGERY.SEARCH_LIST",
                "Có mốc PT nhưng D/s Phẫu thuật không trả dòng phù hợp",
                screen="D/s Phẫu thuật",
                sees=f"0 dòng trong khoảng {first_range[0]} → {first_range[1]}",
                takes="markers vẫn được lưu để QA",
                writes="surgeries=[]",
                target="output.surgery",
            )
            print(f"LOG [surgery] {ma_bn}: không có phẫu thuật trong khoảng {first_range[0]} → {first_range[1]}")
            return base

        origin = ""
        try:
            p = urlparse(getattr(driver, "current_url", "") or list_url)
            origin = f"{p.scheme}://{p.netloc}"
        except Exception:
            origin = ""

        out_rows: List[Dict[str, Any]] = []
        for row in rows[:10]:  # tránh mở quá nhiều nếu EMR trả nhiều dòng trùng.
            detail = {}
            href = _t(row.get("url"))
            if href:
                detail_url = urljoin(origin + "/", href) if origin else href
                try:
                    driver.get(detail_url)
                    try:
                        _selenium_wait_after_action(driver, 1.2, ready_timeout=12)  # type: ignore[misc]
                    except Exception:
                        time.sleep(1.2)
                    # Chờ form chi tiết render.
                    deadline = time.time() + 12
                    while time.time() < deadline:
                        html = getattr(driver, "page_source", "") or ""
                        if "txtPhanLoaiPTTT" in html or "Thông tin phẫu thuật" in html:
                            break
                        time.sleep(0.3)
                    detail = _parse_surgery_detail_html(getattr(driver, "page_source", "") or "")
                    detail["url"] = getattr(driver, "current_url", "") or detail_url
                except Exception as e:
                    detail = {"_error": str(e)}
            merged = {**row, "detail": detail}
            # Đưa vài trường quan trọng lên top-level để UI đọc nhanh.
            for k in ["phan_loai_pt", "bat_dau", "ket_thuc", "dich_vu_phau_thuat", "phuong_phap_pt", "pp_vo_cam", "icd9", "bs_mo_chinh"]:
                if detail.get(k):
                    merged[k] = detail.get(k)
            out_rows.append(merged)

        if not ward_admissions:
            ward_admissions = _fetch_order_history_khoa_list(sess, ma_bn,
                                                            history_info.get("history_from") or date_from,
                                                            history_info.get("history_to") or date_to,
                                                            link_map, config)
        if ward_admissions:
            out_rows = _pair_surgeries_with_postop_ward(out_rows, ward_admissions)

        phan_loai = []
        for r in out_rows:
            val = _t(r.get("phan_loai_pt") or (r.get("detail") or {}).get("phan_loai_pt"))
            if val and val not in phan_loai:
                phan_loai.append(val)
        base["surgeries"] = out_rows
        base["total"] = len(out_rows)
        base["phan_loai_pt_list"] = phan_loai
        base["order_history_surgery_markers"] = surgery_markers
        base["ward_admissions"] = ward_admissions
        base["postop_ward_admissions"] = [r.get("postop_ward") for r in out_rows if isinstance(r.get("postop_ward"), dict)]
        base["latest"] = out_rows[-1] if out_rows else None
        base["_fetch_status"] = "ok"
        print(f"LOG [surgery] {ma_bn}: {len(out_rows)} phẫu thuật | phân loại={', '.join(phan_loai) or '—'} | mốc vào khoa={len(ward_admissions)}")
    except Exception as e:
        print(f"ERROR [surgery] {ma_bn}: {e}", file=sys.stderr)
        base["_fetch_status"] = "error"
        base["_error"] = str(e)
    return base


# ── Fetcher: cls (Xem kết quả → Lịch sử CĐHA) ────────────────────────────────


def _split_vn_datetime_text(value: Any) -> Tuple[str, str]:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    m = re.search(r"(?:(\d{1,2}:\d{2})\s+)?(\d{1,2}/\d{1,2}/\d{4})", text)
    if not m:
        return "", ""
    return m.group(2) or "", m.group(1) or ""


def _parse_any_dmy_date(value: Any):
    text = str(value or "")
    m = re.search(r"(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})", text)
    if not m:
        m = re.search(r"(\d{4})-(\d{1,2})-(\d{1,2})", text)
        if m:
            from datetime import date
            try:
                return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
            except ValueError:
                return None
        return None
    from datetime import date
    try:
        return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
    except ValueError:
        return None


def _in_dmy_range(value: Any, date_from: str = "", date_to: str = "") -> bool:
    d = _parse_any_dmy_date(value)
    if d is None:
        return True
    d_f = _parse_any_dmy_date(date_from)
    d_t = _parse_any_dmy_date(date_to or date_from)
    if d_f and d < d_f:
        return False
    if d_t and d > d_t:
        return False
    return True


def _guess_cdha_group(name: Any) -> str:
    hay = _norm(name)
    if re.search(r"(^|[^a-z0-9])(mri|cong huong tu)([^a-z0-9]|$)", hay):
        return "MRI"
    if re.search(r"(^|[^a-z0-9])(ct|msct|scanner)([^a-z0-9]|$)", hay) or "cat lop" in hay:
        return "CT"
    if re.search(r"(^|[^a-z0-9])(xq|x quang|x-quang|x ray|xray)([^a-z0-9]|$)", hay) or "chup phim" in hay:
        return "XQ"
    return "CĐHA"


def _wait_results_popup_ready(driver: Any, timeout: float = 10.0) -> bool:
    deadline = time.time() + max(1.0, float(timeout or 10.0))
    selectors = [
        "#litabLichSuCDHA", "#divLichSuCDHAContent", "a[href='#tabLichSuCDHA']",
        "#litabLichSuXN", "#divLichSuXNContent", ".modal.show", ".modal.in",
    ]
    while time.time() < deadline:
        try:
            for css in selectors:
                els = driver.find_elements("css selector", css)
                if els:
                    return True
        except Exception:
            pass
        time.sleep(0.25)
    return False


def _open_results_popup_action(driver: Any) -> bool:
    """Mở menu Thăm khám → Xem kết quả.

    HTML EMR thực tế: <a onclick="onShowLichSuChung('', this);">Xem kết quả</a>.
    Phải truyền chính thẻ anchor vào function, giống cách người dùng bấm trên menu.
    """
    try:
        from selenium.webdriver.common.by import By  # type: ignore
    except Exception:
        return False

    last_err = None
    xps = [
        "//a[contains(@onclick,'onShowLichSuChung')]",
        "//*[self::a or self::button or self::span or self::li][contains(normalize-space(),'Xem kết quả')]",
        "//*[self::a or self::button or self::span or self::li][contains(normalize-space(),'Xem KQ')]",
    ]
    candidates = []
    seen = set()
    for xp in xps:
        try:
            for el in driver.find_elements(By.XPATH, xp):
                key = (el.get_attribute('outerHTML') or '')[:300]
                if key in seen:
                    continue
                seen.add(key)
                candidates.append(el)
        except Exception as e:
            last_err = e

    for el in candidates:
        try:
            before_handles = list(getattr(driver, "window_handles", []) or [])
            ret = driver.execute_script(
                r"""
                const raw = arguments[0];
                const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
                const a = raw && raw.closest ? (raw.matches('a,[onclick]') ? raw : raw.closest('a,[onclick]')) : null;
                if (!a) return 'no-anchor';
                let li = a.closest('li');
                while (li) {
                  li.classList.add('active','selected','open');
                  const ul = li.querySelector(':scope > ul, :scope > .submenu, :scope > .collapse');
                  if (ul) { ul.style.display = 'block'; ul.classList.add('show','in'); }
                  li = li.parentElement ? li.parentElement.closest('li') : null;
                }
                try { a.scrollIntoView({block:'center', inline:'nearest'}); } catch(e) {}
                if (typeof onShowLichSuChung === 'function') {
                  onShowLichSuChung('', a);
                  return 'onShowLichSuChung(anchor)';
                }
                try { a.click(); return 'click(anchor)'; } catch(e) {}
                return 'failed';
                """,
                el,
            )
            if ret and ret != 'failed':
                _switch_to_new_tab_if_any(driver, before_handles, timeout=3.0)
                try:
                    _selenium_wait_after_action(driver, 1.0, ready_timeout=12)  # type: ignore[misc]
                except Exception:
                    time.sleep(1.0)
                if _wait_results_popup_ready(driver, timeout=12):
                    print(f"LOG [cls] Đã mở Xem kết quả bằng {ret}.")
                    return True
        except Exception as e:
            last_err = e
            continue

    # Fallback JS nếu anchor đang ẩn/collapsed.
    try:
        before_handles = list(getattr(driver, "window_handles", []) or [])
        ret = driver.execute_script(
            r"""
            const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
            const anchors = Array.from(document.querySelectorAll('a,[onclick],button,span'));
            const a = anchors.find(x => {
              const oc = norm(x.getAttribute('onclick') || '');
              const tx = norm(x.textContent || '');
              return oc.includes('onshowlichsuchung') || tx.includes('xem kết quả') || tx.includes('xem ket qua') || tx.includes('xem kq');
            });
            if (!a) return '';
            let li = a.closest('li');
            while (li) {
              li.classList.add('active','selected','open');
              const ul = li.querySelector(':scope > ul, :scope > .submenu, :scope > .collapse');
              if (ul) { ul.style.display = 'block'; ul.classList.add('show','in'); }
              li = li.parentElement ? li.parentElement.closest('li') : null;
            }
            try { a.scrollIntoView({block:'center', inline:'nearest'}); } catch(e) {}
            if (typeof onShowLichSuChung === 'function') { onShowLichSuChung('', a); return 'onShowLichSuChung(js)'; }
            try { a.click(); return 'click(js)'; } catch(e) {}
            return '';
            """
        )
        if ret:
            _switch_to_new_tab_if_any(driver, before_handles, timeout=3.0)
            try:
                _selenium_wait_after_action(driver, 1.0, ready_timeout=12)  # type: ignore[misc]
            except Exception:
                time.sleep(1.0)
            if _wait_results_popup_ready(driver, timeout=12):
                print(f"LOG [cls] Đã mở Xem kết quả bằng {ret}.")
                return True
    except Exception as e:
        last_err = e

    print(f"WARN [cls] Không mở được menu Xem kết quả: {last_err}", file=sys.stderr)
    return False


def _open_cdha_tab_in_results_popup(driver: Any) -> bool:
    try:
        before_handles = list(getattr(driver, "window_handles", []) or [])
        ret = driver.execute_script(
            r"""
            function fire(el){
              if(!el) return false;
              try { el.scrollIntoView({block:'center', inline:'nearest'}); } catch(e) {}
              try { el.click(); return true; } catch(e) {}
              try {
                ['mouseover','mousedown','mouseup','click'].forEach(function(t){
                  el.dispatchEvent(new MouseEvent(t,{view:window,bubbles:true,cancelable:true}));
                });
                return true;
              } catch(e) { return false; }
            }
            var el = document.getElementById('litabLichSuCDHA') || document.querySelector("a[href='#tabLichSuCDHA']");
            if (typeof onShowCDHA === 'function') { try { onShowCDHA(); return 'onShowCDHA'; } catch(e) {} }
            if (fire(el)) return 'click-tab';
            var links = Array.from(document.querySelectorAll('a,button,span'));
            var target = links.find(function(x){
              var hay = ((x.id||'') + ' ' + (x.getAttribute('onclick')||'') + ' ' + (x.textContent||'')).toLowerCase();
              return hay.indexOf('cdha') >= 0 || hay.indexOf('cđha') >= 0 || hay.indexOf('chẩn đoán hình ảnh') >= 0;
            });
            if (fire(target)) return 'fallback-tab';
            return '';
            """
        )
        if ret:
            _switch_to_new_tab_if_any(driver, before_handles, timeout=1.0)
            try:
                _selenium_wait_after_action(driver, 1.0, ready_timeout=12)  # type: ignore[misc]
            except Exception:
                time.sleep(1.0)
            return True
    except Exception:
        pass
    return False


def _cdha_content_state(driver: Any) -> str:
    """Trả về trạng thái vùng lịch sử CĐHA: ready / empty / pending.

    Không được xem việc vùng nội dung chưa tải sau timeout là "không có CĐHA".
    Chỉ trả về ``empty`` khi EMR đã hiển thị một thông báo rỗng rõ ràng.
    """
    empty_markers = (
        "không có dữ liệu",
        "không tìm thấy dữ liệu",
        "chưa có dữ liệu",
        "không có kết quả",
        "no data available",
        "no matching records",
    )
    try:
        divs = driver.find_elements("css selector", "#divLichSuCDHAContent")
    except Exception:
        return "pending"

    for div in divs:
        try:
            html = div.get_attribute("innerHTML") or ""
        except Exception:
            html = ""
        soup = _soup(html)
        if soup.find("table", id="tbDichVu") is not None or soup.find("table") is not None:
            return "ready"
        normalized = _norm(_get_text(soup))
        if normalized and any(_norm(marker) in normalized for marker in empty_markers):
            return "empty"
    return "pending"


def _wait_cdha_table(driver: Any, timeout: float = 12.0) -> str:
    deadline = time.time() + max(1.0, float(timeout or 12.0))
    while time.time() < deadline:
        state = _cdha_content_state(driver)
        if state in {"ready", "empty"}:
            return state
        time.sleep(0.35)
    return "timeout"


def _parse_cdha_results_from_driver(driver: Any, date_from: str = "", date_to: str = "") -> List[Dict[str, Any]]:
    """Đọc toàn bộ lịch sử CĐHA đã Hoàn tất của đúng người bệnh.

    ``date_from`` và ``date_to`` vẫn được giữ trong chữ ký để tương thích với các
    lời gọi cũ, nhưng cố ý không dùng để lọc. Kết quả XQ/CT/MRI có thể được chỉ
    định trước lúc người bệnh vào khoa hiện tại; lọc theo thời gian vào/ra khoa
    sẽ làm thiếu phim trong phần Kiểm hồ sơ.
    """
    try:
        div = driver.find_element("css selector", "#divLichSuCDHAContent")
    except Exception:
        return []
    html = div.get_attribute("innerHTML") or ""
    soup = _soup(html)
    table = soup.find("table", id="tbDichVu") or soup.find("table")
    if table is None:
        return []

    results: List[Dict[str, Any]] = []
    current_room = ""
    for tr in table.find_all("tr"):
        tds = tr.find_all("td")
        if len(tds) == 1 and tds[0].get("colspan"):
            current_room = _get_text(tds[0])
            continue
        if len(tds) < 6:
            continue
        status = _get_text(tds[5]) if len(tds) > 5 else ""
        if status and "hoan tat" not in _norm(status):
            continue
        time_text = _get_text(tds[1]) if len(tds) > 1 else ""
        name = _get_text(tds[2]) if len(tds) > 2 else ""
        if not name:
            continue
        ngay, gio = _split_vn_datetime_text(time_text)
        onclick = ""
        a = tds[6].find("a") if len(tds) > 6 else None
        if a is not None:
            onclick = _t(a.get("onclick"))
        group = _guess_cdha_group(name)
        results.append({
            "name": name,
            "ten_dv": name,
            "nhom_dich_vu": group,
            "loai": group,
            "tg_chi_dinh": time_text,
            "ngay_chi_dinh": ngay,
            "gio_chi_dinh": gio,
            "nguoi_chi_dinh": _get_text(tds[4]) if len(tds) > 4 else "",
            "trang_thai": status,
            "phong": current_room,
            "onclick": onclick,
        })
    return results


def fetch_cls(sess: Optional[EmrHttpSession], ma_bn: str,
              date_from: str, date_to: str,
              link_map: Dict[str, str], config: Dict[str, Any]) -> Dict[str, Any]:
    """Lấy toàn bộ CĐHA từ Thăm khám → Xem kết quả → Lịch sử CĐHA.

    Dùng cho tab Kiểm hồ sơ để đếm XQ/CT/MRI theo tất cả dịch vụ CĐHA đã Hoàn tất
    của đúng người bệnh. Không giới hạn theo thời gian vào/ra khoa vì nhiều phim
    được thực hiện trước khi người bệnh chuyển đến khoa hiện tại.
    """
    base: Dict[str, Any] = {
        "ma_bn": ma_bn,
        "results": [],
        "_source": "emr_results_popup_cdha",
        "date_from": date_from,
        "date_to": date_to,
        "history_scope": "all_completed_cdha",
        "date_filter_applied": False,
        "_fetch_status": "pending",
    }

    try:
        ctx = _ensure_hchanh_click_context(
            sess, ma_bn, config,
            date_from=date_from,
            date_to=date_to,
            reason="cls",
            inpatient_status=config.get("hchanh_inpatient_status") or "Hoàn tất",
        )
        if not ctx:
            base["_fetch_status"] = "no_session"
            return base
        driver = ctx.get("driver")
        if driver is None:
            base["_fetch_status"] = "no_session"
            return base

        opened_url = _open_patient_entry_from_context(ctx, "doctor", date_to=date_to)
        print(f"LOG [cls] Mở tên người bệnh để Xem kết quả: {opened_url}")
        if not _open_results_popup_action(driver):
            base["_fetch_status"] = "no_results_popup"
            return base
        if not _open_cdha_tab_in_results_popup(driver):
            base["_fetch_status"] = "no_cdha_tab"
            return base
        cdha_state = _wait_cdha_table(driver, timeout=15)
        if cdha_state == "empty":
            base["_fetch_status"] = "empty"
            base["counts"] = {"xq": 0, "ct": 0, "mri": 0, "total_cdha": 0}
            return base
        if cdha_state != "ready":
            base["_fetch_status"] = "cdha_timeout"
            base["_error"] = "Không tải được bảng lịch sử CĐHA sau 15 giây."
            return base

        results = _parse_cdha_results_from_driver(driver, date_from, date_to)
        base["results"] = results
        base["counts"] = {
            "xq": sum(1 for r in results if r.get("nhom_dich_vu") == "XQ"),
            "ct": sum(1 for r in results if r.get("nhom_dich_vu") == "CT"),
            "mri": sum(1 for r in results if r.get("nhom_dich_vu") == "MRI"),
            "total_cdha": len(results),
        }
        # Bảng đã tải thành công nhưng không có dòng hoàn tất trong toàn bộ lịch sử
        # là trạng thái rỗng hợp lệ, khác hoàn toàn với timeout tải bảng.
        base["_fetch_status"] = "ok" if results else "empty"
        print(
            f"LOG [cls] {ma_bn}: toàn bộ lịch sử CĐHA đã hoàn tất={len(results)} "
            f"(không lọc ngày vào/ra khoa) | XQ={base['counts']['xq']} "
            f"CT={base['counts']['ct']} MRI={base['counts']['mri']}"
        )
        return base
    except Exception as e:
        print(f"ERROR [cls] {ma_bn}: {type(e).__name__}: {e}", file=sys.stderr)
        base["_fetch_status"] = "error"
        base["_error"] = str(e)
        return base

def _parse_dmy_str(s: str):
    m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})", _t(s))
    if m:
        from datetime import date
        try:
            return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
        except ValueError:
            return None
    return None


# ── Dispatch ──────────────────────────────────────────────────────────────────

def fetch_order_history(sess: Optional["EmrHttpSession"], ma_bn: str,
                        date_from: str, date_to: str,
                        link_map: Dict[str, str], config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Lấy lịch sử y lệnh từ trang bacsidraw.

    URL pattern (đã xác nhận):
        home.aspx?wpid=bacsidraw
            &noitruid={noitruid}   ← ID đợt điều trị (từ showAllTrangThaiYLenh)
            &kp={kp}               ← ID khoa phòng
            &tg=6                  ← khoảng thời gian (6=khoảng tùy chọn)
            &tungay={date_from}    ← dd/mm/yyyy
            &denngay={date_to}     ← dd/mm/yyyy
            &nextlink=lichsuylenh
            &page=1

    - Không có AJAX: tất cả y lệnh nằm sẵn trong HTML (JS chỉ ẩn/hiện).
    - Có nhiều khoa → nhiều noitruid → fetch từng khoa, gộp lại.
    - noitruid lấy từ onclick="showAllTrangThaiYLenh('{noitruid}')" trong h5.
    - Chỉ lấy khoa cuối cùng (khoa hiện tại) nếu có nhiều khoa.
      Hoặc lấy tất cả khoa và gộp y lệnh.

    Cấu trúc bảng → xem fetch_order_history_from_html().
    """
    from datetime import datetime as _dt

    base: Dict[str, Any] = {
        "ma_bn":             ma_bn,
        "total":             0,
        "completed":         0,
        "incomplete":        0,
        "no_service":        0,
        "after_discharge":   0,
        "khoa_list":         [],   # danh sách khoa điều trị
        "ward_admissions":   [],   # mốc vào khoa/nhận khoa từ lịch sử y lệnh
        "rows":              [],
        "incomplete_rows":   [],
        "after_discharge_rows": [],
        "_source":           "emr_bacsidraw",
        "_fetch_status":     "pending",
    }

    def _parse_dt(s: str):
        m = re.search(r"(\d{1,2}:\d{2})\s+(\d{2}/\d{2}/\d{4})", str(s or ""))
        if m:
            try: return _dt.strptime(f"{m.group(2)} {m.group(1)}", "%d/%m/%Y %H:%M")
            except: pass
        return None

    def _parse_rows_from_html(html: str, dt_discharge) -> List[Dict]:
        """Parse tất cả tbody#tbodyylenh trong 1 trang.

        Bảng EMR có thể có hoặc không có cột checkbox ở đầu dòng, nên không dùng
        index cố định tuyệt đối. Tìm cột TG y lệnh trước rồi suy ra các cột liên quan.
        """
        soup = _soup(html)
        rows_out = []
        current_date = ""
        dt_re = re.compile(r"\b\d{1,2}:\d{2}\s+\d{1,2}/\d{1,2}/\d{4}\b")

        for tbody in soup.find_all("tbody", id="tbodyylenh"):
            for tr in tbody.find_all("tr"):
                tds = tr.find_all("td")
                if not tds:
                    continue

                if len(tds) == 1:
                    current_date = tds[0].get_text(strip=True)
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
                bac_si   = cols[tg_idx + 1] if tg_idx + 1 < len(cols) else ""

                db_idx = tg_idx + 2
                kq_idx = tg_idx + 3
                yk_idx = tg_idx + 4
                cdcs_idx = tg_idx + 5
                cddd_idx = tg_idx + 6
                tvt_idx = tg_idx + 7
                dv_idx = tg_idx + 8

                a_db = tds[db_idx].find("a", attrs={"data-content": True}) if db_idx < len(tds) else None
                dien_bien = _t(a_db["data-content"]) if a_db else (tds[db_idx].get_text(" ", strip=True) if db_idx < len(tds) else "")

                kq_text = tds[kq_idx].get_text(" ", strip=True) if kq_idx < len(tds) else ""
                service_matches = []
                if kq_idx < len(tds):
                    for a_svc in tds[kq_idx].find_all("a"):
                        svc_text = a_svc.get_text(" ", strip=True)
                        m_svc = re.search(r"([A-Za-zÀ-ỹ0-9_./-]+)\s*:\s*(\d+)\s*/\s*(\d+)", svc_text)
                        if m_svc:
                            service_matches.append((m_svc.group(1), m_svc.group(2), m_svc.group(3)))
                if not service_matches:
                    service_matches = re.findall(r"([A-Za-zÀ-ỹ0-9_./-]+)\s*:\s*(\d+)\s*/\s*(\d+)", kq_text)
                services = {m[0]: {"done": int(m[1]), "total": int(m[2]), "pending": max(0, int(m[2]) - int(m[1]))} for m in service_matches}
                incomplete_services = [
                    f"{name}: {svc['done']}/{svc['total']} (còn {svc['pending']})"
                    for name, svc in services.items() if svc.get("pending", 0) > 0
                ]

                a_yl = tds[yk_idx].find("a", attrs={"data-content": True}) if yk_idx < len(tds) else None
                y_lenh_khac = _t(a_yl["data-content"]) if a_yl else (tds[yk_idx].get_text(" ", strip=True) if yk_idx < len(tds) else "")
                cd_cs = tds[cdcs_idx].get_text(" ", strip=True) if cdcs_idx < len(tds) else ""
                a_dd = tds[cddd_idx].find("a", attrs={"data-content": True}) if cddd_idx < len(tds) else None
                cd_dd = _t(a_dd["data-content"]) if a_dd else (tds[cddd_idx].get_text(" ", strip=True) if cddd_idx < len(tds) else "")

                if not services:
                    status = "no_service"
                elif all(v["done"] == v["total"] for v in services.values()):
                    status = "completed"
                else:
                    status = "incomplete"

                tvt_style = tds[tvt_idx].get("style", "").lower() if tvt_idx < len(tds) else ""
                dv_style  = tds[dv_idx].get("style", "").lower() if dv_idx < len(tds) else ""
                pending_flags = []
                if "#fdf500" in tvt_style:
                    pending_flags.append("Thuốc/VTYT chưa hoàn tất")
                if "#fdf500" in dv_style:
                    pending_flags.append("Dịch vụ chưa hoàn tất")
                incomplete_detail_parts = incomplete_services + pending_flags
                incomplete_detail = "; ".join(incomplete_detail_parts)

                dt = _parse_dt(tg_ylenh)
                after = bool(dt and dt_discharge and dt > dt_discharge)

                row_text = _get_text(tr)
                rows_out.append({
                    "ngay":       current_date,
                    "so_phieu":   so_phieu,
                    "tg_ylenh":   tg_ylenh,
                    "bac_si":     bac_si,
                    "dien_bien":  dien_bien[:500],
                    "ten_y_lenh": (y_lenh_khac or dien_bien)[:500],
                    "y_lenh_khac": y_lenh_khac[:1000],
                    "cd_cs":      cd_cs,
                    "cd_dd":      cd_dd,
                    "services":   services,
                    "incomplete_services": incomplete_services,
                    "incomplete_detail": incomplete_detail,
                    "kq_text":    kq_text,
                    "status":     status,
                    "tvt_pend":   "#fdf500" in tvt_style,
                    "dv_pend":    "#fdf500" in dv_style,
                    "after_discharge": after,
                    "has_surgery_marker": bool(_parse_order_history_surgery_markers_from_html(str(tr))),
                    "row_text": row_text[:1000],
                })
        return rows_out

    def _finish_order_history(rows: List[Dict], khoa_list: List[Dict[str, Any]]) -> Dict[str, Any]:
        seen_phieu = set()
        deduped = []
        for r in rows or []:
            key = r.get("so_phieu") or r.get("tg_ylenh")
            if key and key in seen_phieu:
                continue
            if key:
                seen_phieu.add(key)
            deduped.append(r)

        incomplete_rows      = [r for r in deduped if r.get("status") == "incomplete"]
        after_discharge_rows = [r for r in deduped if r.get("after_discharge")]
        surgery_marker_rows  = [r for r in deduped if r.get("has_surgery_marker")]
        trace_event(
            "ORDER_HISTORY.PARSE_ROWS_FINAL",
            "Parse và dedup toàn bộ y lệnh sau khi đã chọn Tất cả",
            screen="Lịch sử y lệnh / tbody#tbodyylenh",
            sees=f"raw_rows={len(rows or [])}; deduped={len(deduped)}; incomplete={len(incomplete_rows)}; after_discharge={len(after_discharge_rows)}",
            takes="Số phiếu, TG y lệnh, bác sĩ, diễn biến, KQ dịch vụ, y lệnh khác, CĐCS, CĐDD, T/VT, DV",
            writes="output.order_history.rows",
            target="hchanh_order_history.csv sau khi backend flatten",
        )
        trace_event(
            "ORDER_HISTORY.MARKERS_FINAL",
            "Đánh dấu dòng y lệnh có dấu hiệu PT từ rows cuối cùng",
            screen="Lịch sử y lệnh / rows đã parse",
            sees=f"{len(surgery_marker_rows)} dòng có PT marker",
            takes="PT:, PHÒNG PHẪU THUẬT, Chuyển mổ, TRÌNH DUYỆT MỔ, phẫu thuật",
            writes="rows[].has_surgery_marker",
            target="output.order_history.rows",
        )

        base["khoa_list"]            = khoa_list or []
        base["ward_admissions"]      = khoa_list or []
        base["rows"]                 = deduped
        base["total"]                = len(deduped)
        base["completed"]            = sum(1 for r in deduped if r.get("status") == "completed")
        base["incomplete"]           = len(incomplete_rows)
        base["no_service"]           = sum(1 for r in deduped if r.get("status") == "no_service")
        base["after_discharge"]      = len(after_discharge_rows)
        base["incomplete_rows"]      = incomplete_rows
        base["after_discharge_rows"] = after_discharge_rows
        base["_discharge_date"]      = date_to
        base["_fetch_status"]        = "ok"

        print(f"LOG [order_history] {ma_bn}: {len(khoa_list or [])} khoa | "
              f"total={base['total']} | incomplete={base['incomplete']} | "
              f"after_discharge={base['after_discharge']}")
        return base

    if sess is None:
        base["_fetch_status"] = "no_session"
        return base

    try:
        view_url = _patient_page_url(link_map, ma_bn, config, sess.base_origin)
        if not view_url:
            base["_fetch_status"] = "no_url"
            trace_event(
                "ERROR.NO_URL_ORDER_HISTORY",
                "Không tạo được URL để mở Lịch sử y lệnh",
                screen="D/s Điều trị nội trú / link_map",
                sees=f"ma_bn={ma_bn}; link_map_entries={len(link_map or {})}",
                takes="link tên BN hoặc mắt điều dưỡng",
                writes="output.order_history._fetch_status=no_url",
                target="output.order_history",
            )
            return base

        # Ngày ra viện để đối chiếu (date_to = ngày ra)
        dt_discharge = _parse_dt(f"23:59 {date_to}") if date_to else None

        if bool(config.get("hchanh_order_history_selenium_first", False)):
            trace_event(
                "ORDER_HISTORY.SELENIUM_CLICK_OPEN",
                "Mở Lịch sử y lệnh bằng Selenium/click, bỏ qua HTTP direct",
                screen="D/s Điều trị nội trú → tên người bệnh → Lịch sử y lệnh",
                sees="research_selenium_first=1; HTTP direct thường không có divDsYLenh/tbody",
                takes="HTML sau thao tác click thật",
                writes="parse rows/khoa từ DOM đã render",
                target="_fetch_hchanh_html_by_click(order_history)",
            )
            clicked = _fetch_hchanh_html_by_click(sess, ma_bn, config, "doctor", "order_history", date_from=date_from, date_to=date_to)
            if clicked and clicked.get("html"):
                clicked_html = clicked.get("html") or ""
                rows = _parse_rows_from_html(clicked_html, dt_discharge)
                khoa_list = _parse_order_history_khoa_list_from_html(clicked_html)
                trace_event(
                    "ORDER_HISTORY.SELENIUM_PARSE_ROWS",
                    "Parse y lệnh sau Selenium/click",
                    screen="Lịch sử y lệnh / DOM đã render / tbody#tbodyylenh",
                    sees=f"rows={len(rows)}; khoa={len(khoa_list or [])}",
                    takes="HTML sau click",
                    writes="output.order_history.rows + khoa_list",
                    target="output.order_history",
                )
                if rows or khoa_list:
                    return _finish_order_history(rows, khoa_list)
            trace_event(
                "WARN",
                "Selenium/click không lấy được y lệnh, fallback sang HTTP direct",
                screen="Lịch sử y lệnh",
                sees="rows=0; khoa=0",
                takes="HTML direct fallback",
                writes="tiếp tục thử HTTP",
                target="ORDER_HISTORY.HTTP_SELECT_SHOW_ALL",
            )

        # ── Bước 1: Fetch trang BN chính để lấy noitruid và kp ────────────────
        # Trang mặc định khi bấm vào BN đã là lịch sử y lệnh (wpid=bacsidraw)
        # noitruid nằm trong: h5 onclick="showAllTrangThaiYLenh('{noitruid}')"

        # Thử lấy trang lịch sử y lệnh trực tiếp
        base_origin = sess.base_origin
        parsed_view = urlparse(view_url)
        base_qs = dict(parse_qsl(parsed_view.query))

        # Build URL lịch sử y lệnh (thêm nextlink=lichsuylenh)
        order_url = _upsert_query(view_url,
                                  wpid="bacsidraw",
                                  tg="6",
                                  tungay=date_from or "01/01/2026",
                                  denngay=date_to or "31/12/2026",
                                  nextlink="lichsuylenh",
                                  page="1")

        show_all_url = _order_history_show_all_url(order_url)
        trace_event(
            "ORDER_HISTORY.HTTP_SELECT_SHOW_ALL",
            "HTTP đọc lịch sử y lệnh với số lượng hiển thị Tất cả",
            screen="Lịch sử y lệnh / select#soLuongHienThi",
            sees="option value=1000 tương ứng Tất cả",
            takes="HTML lịch sử y lệnh đầy đủ",
            writes="html0 để parse khoa/noitruid/y lệnh",
            target=show_all_url,
        )
        html0, _ = sess.get_html(show_all_url)
        soup0 = _soup(html0)

        # ── Bước 2: Thu thập danh sách khoa + noitruid ────────────────────────
        khoa_list = []
        for h5 in soup0.find_all("h5"):
            onclick = h5.get("onclick", "")
            m_noi = re.search(r"showAllTrangThaiYLenh\('([^']+)'\)", onclick)
            if not m_noi:
                continue
            noitruid = m_noi.group(1)

            # Lấy tên khoa và ngày vào từ text
            h5_text = h5.get_text(" ", strip=True)
            m_khoa  = re.search(r"Khoa điều trị[^:]*:\s*(.+?)\s*\(", h5_text)
            m_vao   = re.search(r"Ngày vào:\s*([\d:/ ]+)", h5_text)
            ten_khoa = _t(m_khoa.group(1)) if m_khoa else ""
            ngay_vao = _t(m_vao.group(1))  if m_vao  else ""

            # Lấy kp từ checkbox class trong tbody của khoa này
            kp = ""
            tbody_id = f"tbodyylenh"  # tất cả dùng cùng id nên lấy từ context
            # Tìm input checkbox trong cùng section, class "ckYL{noitruid}"
            for inp in soup0.find_all("input", class_=re.compile(f"ckYL{re.escape(noitruid)}")):
                # class có dạng: "ckYL{noitruid} chkYlI{noitruid}"
                # kp thường trong URL của trang — lấy từ base_qs
                kp = base_qs.get("kp", "")
                break

            khoa_list.append({
                "noitruid": noitruid,
                "ten_khoa": ten_khoa,
                "ngay_vao": ngay_vao,
                "kp":       kp,
            })

        base["khoa_list"] = khoa_list
        base["ward_admissions"] = khoa_list
        trace_event(
            "ORDER_HISTORY.HTTP_PARSE_WARDS",
            "Parse các khoa điều trị từ HTML HTTP trực tiếp",
            screen="Lịch sử y lệnh / divDsYLenh / h5[onclick=showAllTrangThaiYLenh]",
            sees=f"{len(khoa_list)} khoa/noitruid",
            takes="noitruid, tên khoa, ngày vào",
            writes="output.order_history.khoa_list + ward_admissions",
            target="output.order_history",
        )

        if not khoa_list:
            # Không tìm thấy khoa → parse trang hiện tại luôn. Nếu vẫn rỗng, bấm tên BN thật bằng Chrome
            # vì một số trang chỉ dựng lịch sử y lệnh sau thao tác click trên UI.
            print(f"WARN [order_history] Không tìm thấy noitruid, parse trang hiện tại", file=sys.stderr)
            rows = _parse_rows_from_html(html0, dt_discharge)
            if not rows:
                trace_event(
                    "ORDER_HISTORY.FALLBACK_CLICK_OPEN",
                    "HTTP không parse được y lệnh, fallback bấm tên người bệnh",
                    screen="D/s Điều trị nội trú → tên người bệnh → Lịch sử y lệnh",
                    sees="khoa=0 và rows=0 từ HTML HTTP trực tiếp",
                    takes="HTML sau thao tác click thật",
                    writes="parse lại rows/khoa",
                    target="_fetch_hchanh_html_by_click(order_history)",
                )
                clicked = _fetch_hchanh_html_by_click(sess, ma_bn, config, "doctor", "order_history", date_from=date_from, date_to=date_to)
                if clicked and clicked.get("html"):
                    clicked_html = clicked["html"]
                    rows = _parse_rows_from_html(clicked_html, dt_discharge)
                    clicked_khoa = _parse_order_history_khoa_list_from_html(clicked_html)
                    if clicked_khoa:
                        khoa_list = clicked_khoa
                        base["khoa_list"] = clicked_khoa
                        base["ward_admissions"] = clicked_khoa
                    trace_event(
                        "ORDER_HISTORY.FALLBACK_PARSE_ROWS",
                        "Parse lại y lệnh sau click fallback",
                        screen="Lịch sử y lệnh / click fallback / tbody#tbodyylenh",
                        sees=f"rows={len(rows)}; khoa={len(clicked_khoa or [])}",
                        takes="HTML fallback",
                        writes="output.order_history.rows + khoa_list",
                        target="output.order_history",
                    )
                    print(f"LOG [order_history] Parse sau khi bấm tên BN: {len(rows)} y lệnh")
        else:
            # ── Bước 3: Fetch từng khoa và gộp y lệnh ─────────────────────────
            # Ưu tiên: tất cả khoa để có bức tranh đầy đủ
            # Với BN ra viện, y lệnh của khoa nào cũng phải hoàn tất
            rows = []
            for khoa in khoa_list:
                noitruid = khoa["noitruid"]
                kp_id    = khoa["kp"] or base_qs.get("kp", "")

                khoa_url = _upsert_query(view_url,
                                         wpid="bacsidraw",
                                         noitruid=noitruid,
                                         kp=kp_id,
                                         tg="6",
                                         tungay=date_from or "01/01/2026",
                                         denngay=date_to or "31/12/2026",
                                         nextlink="lichsuylenh",
                                         page="1")

                print(f"LOG [order_history] Fetch khoa: {khoa['ten_khoa'][:40]}")
                try:
                    show_all_khoa_url = _order_history_show_all_url(khoa_url)
                    trace_event(
                        "ORDER_HISTORY.HTTP_OPEN",
                        "HTTP mở từng khoa điều trị trong lịch sử y lệnh",
                        screen="Lịch sử y lệnh / từng khối Khoa điều trị",
                        sees=f"khoa={khoa['ten_khoa'][:80]}; noitruid={noitruid}",
                        takes="HTML bảng y lệnh của khoa",
                        writes="rows gắn tên khoa",
                        target=show_all_khoa_url,
                    )
                    html_khoa, _ = sess.get_html(show_all_khoa_url)
                    khoa_rows    = _parse_rows_from_html(html_khoa, dt_discharge)
                    # Gắn tên khoa vào từng row
                    for r in khoa_rows:
                        r["khoa"] = khoa["ten_khoa"]
                    rows.extend(khoa_rows)
                    print(f"LOG [order_history]   → {len(khoa_rows)} y lệnh")
                except Exception as e:
                    print(f"WARN [order_history] Lỗi fetch khoa {noitruid}: {e}", file=sys.stderr)

        _finish_order_history(rows, khoa_list)


    except Exception as e:
        print(f"ERROR [order_history] {ma_bn}: {e}", file=sys.stderr)
        base["_fetch_status"] = "error"
        base["_error"] = str(e)

    return base



def _find_documents_table(soup: Any) -> Any:
    """Tìm bảng Giấy tờ kèm theo sau khi bấm onShowGiayToKemTheo."""
    # Vùng đúng thường là div#divContentHSKT, nhưng một số giao diện nhúng vào divNoiTruContent.
    for div_id in ("divContentHSKT", "divNoiTruContent", "divContent", "divKetQua"):
        div = soup.find("div", id=div_id)
        if div:
            table = div.find("table", id="sample") or div.find("table")
            if table:
                return table

    # Ưu tiên table có link GetUrlBienBan hoặc header giống bảng giấy tờ.
    for table in soup.find_all("table"):
        text = _get_text(table)
        html = str(table)
        if "GetUrlBienBan" in html or "Loại phiếu" in text or "Người tạo" in text or "Mô tả" in text:
            return table

    return soup.find("table", id="sample")

def fetch_documents(sess: Optional["EmrHttpSession"], ma_bn: str,
                    link_map: Dict[str, str], config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Lấy danh sách giấy tờ kèm theo từ trang 'Thông tin chung → Giấy tờ kèm theo'.

    Cách truy cập (đã xác nhận):
    - Menu trái: Thông tin chung → Giấy tờ kèm theo → onclick="onShowGiayToKemTheo(this)"
    - Nội dung load vào div#divNoiTruContent

    Cấu trúc bảng (table#sample trong div#divContentHSKT):
    - Dòng header khoa: td[colspan=6], bg #f2f2f2
    - Dòng phiếu: 6 cột
      [0] Nút in (div.dropdown) → CÓ = đã hoàn tất, KHÔNG = chưa hoàn tất
      [1] Loại phiếu
      [2] Ngày tạo
      [3] Người tạo
      [4] Mô tả
      [5] Tác vụ: href GetUrlBienBan('{hosoid}') → lấy hosoid

    Phiếu chưa hoàn tất → bấm nút Sửa → mở:
        wpid=loadformdongdraw&noitruid={noitruid}&hosoid={hosoid}
    → Nếu form rỗng: bấm Xóa
    → Nếu có dữ liệu: bấm Hoàn tất

    Trạng thái sau hoàn tất:
        _obj.TRANGTHAI == 1 hoặc 2 → nút Thu hồi hiện, nút Hoàn tất ẩn → đã hoàn tất
        _obj.TRANGTHAI == khác → nút Hoàn tất hiện → chưa hoàn tất
    """
    base: Dict[str, Any] = {
        "ma_bn":          ma_bn,
        "total":          0,
        "hoan_tat":       0,
        "chua_hoan_tat":  0,
        "rows":           [],
        "chua_ht_rows":   [],
        "_source":        "emr_giaytokemtheo",
        "_fetch_status":  "pending",
    }

    if sess is None:
        base["_fetch_status"] = "no_session"
        return base

    try:
        view_url = _patient_page_url(link_map, ma_bn, config, sess.base_origin)
        if not view_url:
            base["_fetch_status"] = "no_url"
            return base

        # Trang giấy tờ kèm theo
        docs_wpid = config.get("documents_wpid") or ""
        target_url = _upsert_query(view_url, wpid=docs_wpid) if docs_wpid else view_url
        html, _ = sess.get_html(target_url)
        soup = _soup(html)

        # Tìm bảng giấy tờ (table#sample trong div#divContentHSKT)
        table = _find_documents_table(soup)

        if table is None:
            # Giấy tờ kèm theo chỉ xuất hiện sau khi bấm tên BN rồi bấm menu/tab giấy tờ.
            clicked = _fetch_hchanh_html_by_click(sess, ma_bn, config, "doctor", "documents")
            if clicked and clicked.get("html"):
                soup = _soup(clicked["html"])
                table = _find_documents_table(soup)
                if table is None:
                    try:
                        debug_dir = os.path.join(str(config.get("runtime_dir") or ".runtime"), "hchanh_debug")
                        os.makedirs(debug_dir, exist_ok=True)
                        debug_path = os.path.join(debug_dir, f"documents_{ma_bn}.html")
                        with open(debug_path, "w", encoding="utf-8") as f:
                            f.write(clicked.get("html") or "")
                        print(f"WARN [documents] Không thấy bảng giấy tờ; đã lưu HTML debug: {debug_path}", file=sys.stderr)
                    except Exception:
                        pass

        if table is None:
            base["_fetch_status"] = "no_table"
            return base

        rows_out = []
        current_khoa = ""

        for tr in table.find_all("tr"):
            tds = tr.find_all("td")
            if not tds:
                continue

            # Dòng header khoa (colspan=6)
            if len(tds) == 1 and tds[0].get("colspan"):
                current_khoa = tds[0].get_text(strip=True)
                continue

            if len(tds) < 6:
                continue

            col_in    = tds[0]
            loai_phieu = tds[1].get_text(strip=True)
            ngay_tao   = tds[2].get_text(strip=True)
            nguoi_tao  = tds[3].get_text(strip=True)
            mo_ta      = tds[4].get_text(strip=True)

            # Lấy hosoid từ href GetUrlBienBan('{hosoid}')
            hosoid = ""
            for a in tds[5].find_all("a", href=True):
                m = re.search(r"GetUrlBienBan\('([^']+)'\)", a.get("href", ""))
                if m:
                    hosoid = m.group(1)
                    break

            # Phiếu có nút in (div.dropdown) = đã hoàn tất
            has_print  = bool(col_in.find("div", class_="dropdown"))

            # URL trang hoàn tất (để worker có thể mở nếu cần)
            hoantat_url = ""
            if hosoid and not has_print:
                # Cần noitruid — lấy từ view_url hoặc link_map
                parsed_v = urlparse(view_url)
                qs_v = dict(parse_qsl(parsed_v.query))
                noitruid = qs_v.get("noitruid") or ""
                hoantat_url = _upsert_query(view_url,
                                             wpid="loadformdongdraw",
                                             hosoid=hosoid,
                                             **({} if not noitruid else {"noitruid": noitruid}))

            rows_out.append({
                "khoa":        current_khoa,
                "loai_phieu":  loai_phieu,
                "ngay_tao":    ngay_tao,
                "nguoi_tao":   nguoi_tao,
                "mo_ta":       mo_ta,
                "hosoid":      hosoid,
                "hoan_tat":    has_print,
                "hoantat_url": hoantat_url,
            })

        chua_ht_rows = [r for r in rows_out if not r["hoan_tat"]]

        base["rows"]          = rows_out
        base["total"]         = len(rows_out)
        base["hoan_tat"]      = sum(1 for r in rows_out if r["hoan_tat"])
        base["chua_hoan_tat"] = len(chua_ht_rows)
        base["chua_ht_rows"]  = chua_ht_rows
        base["_fetch_status"] = "ok"

        print(f"LOG [documents] {ma_bn}: total={base['total']} | "
              f"hoan_tat={base['hoan_tat']} | chua_ht={base['chua_hoan_tat']}")

    except Exception as e:
        print(f"ERROR [documents] {ma_bn}: {e}", file=sys.stderr)
        base["_fetch_status"] = "error"
        base["_error"] = str(e)

    return base


def run_hchanh_fetch(input_path: str, out_path: str, scope: str,
                     files: List[str], date_from: str, date_to: str,
                     inpatient_status: str = "", headless: bool = False) -> int:
    if not os.path.exists(input_path):
        print(f"ERROR: Không tìm thấy file input {input_path}", file=sys.stderr)
        return 1

    with open(input_path, "r", encoding="utf-8") as f:
        patient_row = json.load(f)

    ma_bn = _t(patient_row.get("ma_bn") or patient_row.get("Mã BN") or patient_row.get("Mã YT"))
    if not ma_bn:
        print("ERROR: Input thiếu ma_bn", file=sys.stderr)
        return 1

    trace_event(
        "CASE.START",
        "Bắt đầu xử lý một ca nghiên cứu hành chánh/y lệnh",
        screen="worker/hchanh_fetch.py",
        sees=f"input={os.path.basename(input_path)}; files={','.join(files)}",
        takes=f"Mã BN={ma_bn}; Mã NC={_t(patient_row.get('research_code') or patient_row.get('Mã NC'))}; Họ tên={_t(patient_row.get('ho_ten') or patient_row.get('Họ tên'))}",
        writes="khởi tạo trace cho case",
        target="research_case_trace_recent.json",
    )
    trace_event(
        "INPUT.READ",
        "Đọc input JSON do backend tạo cho case",
        screen="hchanh_auto_raw/input_*.json hoặc order_history_auto_raw/input_*.json",
        sees=f"date_from={date_from or patient_row.get('date_from') or ''}; date_to={date_to or patient_row.get('date_to') or ''}; inpatient_status={inpatient_status or patient_row.get('inpatient_status') or ''}",
        takes="ma_bn, research_code, date_from, date_to, inpatient_status, research_mode",
        writes="chuẩn bị gọi các fetcher theo files",
        target=out_path,
    )

    if not date_from:
        date_from = _t(patient_row.get("date_from") or patient_row.get("ngay_vao") or "")
    if not date_to:
        date_to = _t(patient_row.get("date_to") or date_from)

    # UI truyền YYYY-MM-DD, EMR nội bộ lại dùng dd/mm/yyyy.
    date_from = _date_to_dmy(date_from) or date_from
    date_to = _date_to_dmy(date_to) or date_to

    print(f"LOG: hchanh_fetch | BN={ma_bn} | scope={scope} | files={files} | {date_from} → {date_to}")
    trace_event(
        "INPUT.READ",
        "Chuẩn hóa khoảng ngày trước khi vào EMR",
        screen="tham số tìm kiếm EMR",
        sees=f"scope={scope}; files={','.join(files)}",
        takes=f"{date_from or '—'} → {date_to or '—'}",
        writes="dùng khoảng ngày này cho lịch sử y lệnh, ra viện, phẫu thuật",
        target="EMR query/date filters",
    )

    config = load_config()
    if headless:
        config["headless"] = True
        config["hchanh_click_headless"] = True
        config["hchanh_link_headless"] = True
        config["hchanh_auth_headless"] = True
    requested_inpatient_status = _t(inpatient_status or patient_row.get("inpatient_status") or patient_row.get("research_inpatient_status") or config.get("hchanh_inpatient_status"), "Đang thực hiện")
    research_mode = bool(patient_row.get("research_mode") or patient_row.get("is_research") or patient_row.get("Research key"))
    if research_mode:
        # Trong Kho nghiên cứu, HTTP direct của D/s nội trú/y lệnh thường trả HTML thiếu dữ liệu.
        # Đi thẳng Selenium/click giảm 3-5 giây/ca và tránh log nhiễu.
        config["hchanh_research_selenium_first"] = True
        config["hchanh_order_history_selenium_first"] = True
    matched_inpatient_status = requested_inpatient_status
    config["hchanh_inpatient_status"] = requested_inpatient_status
    print(f"LOG: Trạng thái nội trú dùng để tìm BN: {requested_inpatient_status}")

    # Khởi tạo session một lần, dùng cho tất cả fetcher
    trace_event(
        "EMR.SESSION_INIT",
        "Khởi tạo phiên EMR cho nghiên cứu",
        screen="Đăng nhập/khôi phục session hành chánh",
        sees=f"headless={'1' if headless else '0'}; requested_status={requested_inpatient_status}",
        takes="cookie/session HTTP hoặc Selenium fallback",
        writes="sess + base_origin để đọc link hồ sơ",
        target="EmrHttpSession/link_map",
    )
    sess = _init_session(config)
    link_map: Dict[str, str] = {}

    # Tab Kiểm hồ sơ truyền sẵn link/noitruid từ dòng đã quét Hoàn tất.
    # Ưu tiên các link này để mở đúng lượt điều trị và tránh tìm lại theo mã BN.
    direct_links: Dict[str, str] = {}
    for key in ("record_doctor_url", "doctor_url", "patient_doctor_url", "emr_doctor_url"):
        val = _t(patient_row.get(key))
        if val:
            direct_links["doctor"] = _as_doctor_url(val)
            break
    for key in ("record_nursing_url", "nursing_url", "patient_nursing_url", "emr_nursing_url"):
        val = _t(patient_row.get(key))
        if val:
            direct_links["nursing"] = _as_nursing_url(val)
            break
    if direct_links:
        _remember_patient_links(link_map, ma_bn, direct_links)
        config["hchanh_direct_links"] = direct_links
        config["hchanh_target_noitruid"] = _t(patient_row.get("noitruid") or patient_row.get("noi_tru_id") or patient_row.get("NoiTruID"))
        config["hchanh_target_case_key"] = _t(patient_row.get("case_key") or patient_row.get("encounter_key") or patient_row.get("storage_key"))
        trace_event(
            "EMR.PATIENT_LINKS_FROM_INPUT",
            "Dùng link hồ sơ/noitruid đã lưu từ dòng scan Hoàn tất",
            screen="D/s Điều trị nội trú / row scan",
            sees=f"direct_links={','.join(sorted(direct_links.keys()))}",
            takes=f"Mã BN={ma_bn}; noitruid={_t(patient_row.get('noitruid'))}",
            writes="link_map dùng trực tiếp, không cần tìm lại theo mã BN nếu đủ link",
            target="memory:link_map",
        )
    if sess is not None:
        selenium_first = bool(research_mode or config.get("hchanh_research_selenium_first", True))
        if selenium_first:
            trace_event(
                "EMR.PATIENT_LINKS_SKIP_HTTP",
                "Bỏ qua HTTP link_map vì nghiên cứu chạy ổn định hơn bằng Selenium/click",
                screen="D/s Điều trị nội trú",
                sees="HTTP link_map thường rỗng với Kho nghiên cứu",
                takes=f"Mã BN={ma_bn}; trạng thái={requested_inpatient_status}",
                writes="đi thẳng vào _find_patient_links_via_selenium",
                target="memory:link_map",
            )
        else:
            link_map = _get_link_map(sess)
            trace_event(
                "EMR.PATIENT_LINKS",
                "Đọc link_map danh sách nội trú",
                screen="D/s Điều trị nội trú",
                sees=f"link_map={len(link_map)} entries",
                takes=f"link tên BN + mắt điều dưỡng cho Mã BN {ma_bn}",
                writes="link_map dùng cho profile/discharge/order_history/surgery",
                target="memory:link_map",
            )
            if not link_map:
                trace_event(
                    "EMR.PATIENT_LINKS_EMPTY",
                    "link_map HTTP rỗng, sẽ chuyển sang Selenium/click fallback",
                    screen="D/s Điều trị nội trú",
                    sees="link_map=0 entries",
                    takes="không có link tên BN/mắt điều dưỡng từ HTTP",
                    writes="chuẩn bị tìm BN bằng Selenium theo trạng thái nội trú",
                    target="_find_patient_links_via_selenium",
                )
        if ma_bn not in link_map:
            if not selenium_first:
                print(f"WARN: BN {ma_bn} không có trong link_map HTTP hiện tại "
                      f"(thường do filter danh sách khác). Sẽ tìm thêm bằng Selenium theo trạng thái đã chọn.", file=sys.stderr)
            recovered_links: Dict[str, str] = {}
            for candidate_status in _research_status_candidates(requested_inpatient_status, research_mode=research_mode):
                config["hchanh_inpatient_status"] = candidate_status
                recovered_links = _find_patient_links_via_selenium(
                    sess, ma_bn, config, date_to,
                    inpatient_status=candidate_status,
                    date_from=date_from,
                )
                if recovered_links:
                    matched_inpatient_status = candidate_status
                    if not _same_status(candidate_status, requested_inpatient_status):
                        print(
                            f"WARN: BN {ma_bn} không thấy ở '{requested_inpatient_status}' "
                            f"nhưng tìm thấy ở '{candidate_status}'. Sẽ lấy phần có thể lấy được theo trạng thái hiện tại.",
                            file=sys.stderr,
                        )
                    break
            if recovered_links:
                _remember_patient_links(link_map, ma_bn, recovered_links)
                trace_event(
                    "EMR.PATIENT_LINKS_RECOVERED",
                    "Tìm được link hồ sơ BN bằng Selenium/click",
                    screen="D/s Điều trị nội trú",
                    sees=f"recovered_links={','.join(sorted(recovered_links.keys()))}",
                    takes=f"Mã BN={ma_bn}; trạng thái={matched_inpatient_status}",
                    writes="bổ sung link vào link_map để các fetcher dùng",
                    target="memory:link_map",
                )
            else:
                config["hchanh_inpatient_status"] = requested_inpatient_status
                tried = ", ".join(_research_status_candidates(requested_inpatient_status, research_mode=research_mode))
                trace_event(
                    "ERROR.NO_PATIENT_LINK",
                    "Không lấy được URL hồ sơ BN sau khi thử Selenium/click",
                    screen="D/s Điều trị nội trú",
                    sees=f"link_map_entries={len(link_map)}; tried_status={tried}; selenium_first={1 if selenium_first else 0}",
                    takes=f"Mã BN={ma_bn}",
                    writes="các file chi tiết có thể trả no_url",
                    target="link_map",
                )
                print(
                    f"WARN: Không lấy được URL hồ sơ BN {ma_bn} sau khi tìm trên HIS "
                    f"(trạng thái đã thử: {tried}). Các file chi tiết sẽ trả no_url.",
                    file=sys.stderr,
                )
        else:
            matched_inpatient_status = requested_inpatient_status
    config["hchanh_inpatient_status"] = matched_inpatient_status

    output: Dict[str, Any] = {}

    def _fetch_status_symbol(status: str) -> str:
        status = _t(status).lower()
        if status == "ok":
            return "✓"
        if status in {"empty", "partial"}:
            return "!"
        if status in {"error", "no_url", "no_session", "timeout"}:
            return "×"
        return "·"

    for file_key in files:
        if file_key in output:
            print(f"LOG:   Bỏ qua [{file_key}] vì đã lấy trước đó.")
            trace_event("ORDER_HISTORY.REUSE_EXISTING", f"Bỏ qua {file_key} vì đã lấy trước trong cùng case", sees="output đã có key", takes=file_key, writes="không gọi lại fetcher", target="output")
            continue
        print(f"LOG:   Đang lấy [{file_key}]...")
        start_tag = "SURGERY.GATE_START" if file_key == "surgery" else "FETCH.START"
        start_step = (
            "Bắt đầu cổng phẫu thuật: lấy y lệnh trước rồi mới quyết định mở D/s Phẫu thuật"
            if file_key == "surgery" else f"Bắt đầu lấy file {file_key}"
        )
        trace_event(
            start_tag,
            start_step,
            screen=("Lịch sử y lệnh → Phẫu thuật" if file_key == "surgery" else f"EMR/{file_key}"),
            sees=f"Mã BN={ma_bn}; khoảng={date_from} → {date_to}",
            takes=("order_history gate + surgery nếu có marker PT" if file_key == "surgery" else f"{file_key}"),
            writes="sẽ ghi vào output JSON và CSV nghiên cứu tương ứng",
            target=out_path,
        )
        try:
            if file_key == "profile":
                result = fetch_profile(sess, ma_bn, patient_row, link_map, config)
            elif file_key == "discharge":
                if research_mode and not _same_status(matched_inpatient_status, "Hoàn tất"):
                    result = {
                        "_fetch_status": "empty",
                        "_reason": "patient_not_completed_currently",
                        "ma_bn": ma_bn,
                        "requested_inpatient_status": requested_inpatient_status,
                        "matched_inpatient_status": matched_inpatient_status,
                    }
                    print(
                        f"WARN [discharge] BN {ma_bn} đang ở trạng thái '{matched_inpatient_status}', "
                        "không tạo dữ liệu ra viện giả cho nghiên cứu.",
                        file=sys.stderr,
                    )
                else:
                    result = fetch_discharge(sess, ma_bn, date_from, date_to, link_map, config, patient_row=patient_row)
            elif file_key == "billing":
                result = fetch_billing(sess, ma_bn, link_map, config)
            elif file_key == "bed_days":
                result = fetch_bed_days(sess, ma_bn, date_from, date_to, link_map, config)
            elif file_key == "surgery":
                # Nghiên cứu: luôn lấy Lịch sử y lệnh trước. Từ đó xác định có mốc PT hay không;
                # nếu không có PT thì fetch_surgery sẽ không mở D/s Phẫu thuật.
                if "order_history" not in output:
                    print("LOG:   Đang lấy [order_history] trước để dò mốc PT...")
                    trace_event(
                        "ORDER_HISTORY.PREFETCH_FOR_SURGERY",
                        "Trước khi tìm phẫu thuật phải lấy lịch sử y lệnh",
                        screen="Lịch sử y lệnh",
                        sees="file surgery được yêu cầu nhưng chưa có order_history trong output",
                        takes="toàn bộ y lệnh để dò PT",
                        writes="output.order_history trước, sau đó mới xét mở D/s Phẫu thuật",
                        target="output.order_history",
                    )
                    oh = fetch_order_history(sess, ma_bn, date_from, date_to, link_map, config)
                    if isinstance(oh, dict):
                        oh.setdefault("requested_inpatient_status", requested_inpatient_status)
                        oh.setdefault("matched_inpatient_status", matched_inpatient_status)
                    output["order_history"] = oh
                    oh_status = oh.get("_fetch_status", "?") if isinstance(oh, dict) else "?"
                    print(f"LOG:   {_fetch_status_symbol(oh_status)} order_history → {oh_status}")
                result = fetch_surgery(sess, ma_bn, date_from, date_to, link_map, config, existing_order_history=output.get("order_history"))
            elif file_key == "cls":
                result = fetch_cls(sess, ma_bn, date_from, date_to, link_map, config)
            elif file_key == "order_history":
                result = fetch_order_history(sess, ma_bn, date_from, date_to, link_map, config)
            elif file_key == "documents":
                result = fetch_documents(sess, ma_bn, link_map, config)
            else:
                print(f"WARN: Không có fetcher cho '{file_key}', bỏ qua.", file=sys.stderr)
                continue
            if isinstance(result, dict):
                result.setdefault("requested_inpatient_status", requested_inpatient_status)
                result.setdefault("matched_inpatient_status", matched_inpatient_status)
                if not _same_status(matched_inpatient_status, requested_inpatient_status):
                    result.setdefault("status_fallback_used", True)
            output[file_key] = result
            status = result.get("_fetch_status", "?") if isinstance(result, dict) else "?"
            print(f"LOG:   {_fetch_status_symbol(status)} {file_key} → {status}")
            if isinstance(result, dict) and str(status).lower() == "no_url":
                trace_event(
                    _trace_no_url_tag(file_key),
                    f"Không có URL để lấy file {file_key}",
                    screen=f"EMR/{file_key}",
                    sees=f"link_map_entries={len(link_map or {})}; matched_status={matched_inpatient_status}",
                    takes=f"Mã BN={ma_bn}; file={file_key}",
                    writes=f"output.{file_key}._fetch_status=no_url",
                    target=out_path,
                )
            row_count = ""
            if isinstance(result, dict):
                if isinstance(result.get("rows"), list):
                    row_count = f"rows={len(result.get('rows') or [])}"
                elif isinstance(result.get("surgeries"), list):
                    row_count = f"surgeries={len(result.get('surgeries') or [])}"
            trace_event(
                "FETCH.END",
                f"Kết thúc lấy file {file_key}",
                screen=f"EMR/{file_key}",
                sees=f"status={status}; {row_count}",
                takes=f"dữ liệu {file_key} đã parse",
                writes=f"output.{file_key}",
                target=out_path,
            )
        except Exception as e:
            trace_event("ERROR", f"Lỗi khi lấy file {file_key}", screen=f"EMR/{file_key}", sees=str(e), takes=file_key, writes="output error", target=out_path)
            print(f"ERROR: Lấy {file_key} thất bại: {e}", file=sys.stderr)
            output[file_key] = {"_fetch_status": "error", "_error": str(e), "ma_bn": ma_bn}

    trace_event(
        "OUTPUT.WRITE_JSON",
        "Ghi output JSON của case",
        screen="worker output",
        sees=f"keys={','.join(output.keys())}",
        takes="output từ các fetcher",
        writes=f"JSON gồm dữ liệu và _case_trace ({len(trace_events())} events)",
        target=out_path,
    )
    output["_case_trace"] = trace_events()

    os.makedirs(os.path.dirname(out_path) if os.path.dirname(out_path) else ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    ok_count = sum(1 for k, v in output.items() if not str(k).startswith("_") and isinstance(v, dict) and v.get("_fetch_status") == "ok")
    attention_count = sum(1 for k, v in output.items() if not str(k).startswith("_") and isinstance(v, dict) and v.get("_fetch_status") in {"empty", "partial"})
    error_count = sum(1 for k, v in output.items() if not str(k).startswith("_") and isinstance(v, dict) and v.get("_fetch_status") in {"error", "no_url", "no_session", "timeout"})
    suffix_parts = []
    if attention_count:
        suffix_parts.append(f"{attention_count} cần xử lý nội dung")
    if error_count:
        suffix_parts.append(f"{error_count} lỗi kỹ thuật")
    suffix = ("; " + "; ".join(suffix_parts)) if suffix_parts else ""
    print(f"LOG: Xong. {ok_count}/{len(files)} files OK{suffix} → {out_path}")
    return 0


# ── CLI ───────────────────────────────────────────────────────────────────────

def build_arg_parser():
    p = argparse.ArgumentParser(description="Fetch dữ liệu hành chánh từ EMR")
    p.add_argument("--input",  required=True)
    p.add_argument("--out",    required=True)
    p.add_argument("--scope",  default="discharge",
                   choices=["daily", "admission", "surgery", "discharge"])
    p.add_argument("--files",  default="profile,discharge,billing,bed_days,surgery")
    p.add_argument("--from",   dest="date_from", default="")
    p.add_argument("--to",     dest="date_to",   default="")
    p.add_argument("--status", dest="inpatient_status", default="", help="Trạng thái nội trú khi tìm BN: Đang thực hiện hoặc Hoàn tất")
    p.add_argument("--headless", action="store_true", help="Ép Chrome helper chạy headless nếu fetcher phải fallback Selenium")
    return p


if __name__ == "__main__":
    args = build_arg_parser().parse_args()
    files = [f.strip() for f in (args.files or "").split(",") if f.strip()]
    sys.exit(run_hchanh_fetch(
        input_path=args.input,
        out_path=args.out,
        scope=args.scope,
        files=files,
        date_from=args.date_from,
        date_to=args.date_to,
        inpatient_status=args.inpatient_status,
        headless=args.headless,
    ))
