# -*- coding: utf-8 -*-
"""
worker/utils.py
Các hàm tiện ích dùng chung cho tất cả Python worker scripts.
  - load_config        : đọc config.json
  - normalize_date     : chuẩn hoá chuỗi ngày dd/mm → dd/mm/yyyy
  - init_driver        : khởi tạo Selenium ChromeDriver
  - login_emr          : đăng nhập vào hệ thống EMR qua Selenium
"""

import json
import os
import re
import sys
import time
import subprocess
from datetime import datetime
from typing import Any, Dict, Optional, Tuple


def _env_int(name: str, default: int, *, min_value: int = 1, max_value: int = 300) -> int:
    """Đọc biến môi trường dạng số nguyên, có chặn biên để tránh timeout vô hạn."""
    try:
        value = int(str(os.environ.get(name, default)).strip())
    except Exception:
        return default
    return max(min_value, min(max_value, value))

# ── Selenium (optional import — graceful fallback) ────────────────────────────
try:
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options as ChromeOptions
    from selenium.webdriver.chrome.service import Service as ChromeService
    from selenium.webdriver.common.by import By
    from selenium.webdriver.common.keys import Keys
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
    _HAS_SELENIUM = True
except ModuleNotFoundError:
    _HAS_SELENIUM = False
    webdriver = By = Keys = WebDriverWait = EC = ChromeOptions = ChromeService = None  # type: ignore



def _read_secret_env(value_name: str, file_name: str = "") -> str:
    value = str(os.environ.get(value_name, "") or "").strip()
    if value:
        return value
    if file_name:
        secret_path = str(os.environ.get(file_name, "") or "").strip()
        if secret_path:
            try:
                with open(secret_path, "r", encoding="utf-8") as handle:
                    return handle.read().strip()
            except Exception as exc:
                print(f"[utils] Không đọc được secret file {file_name}: {exc}", file=sys.stderr)
    return ""


def _apply_secret_overrides(config: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(config or {})
    mapping = {
        "username": ("EMR_USERNAME", "EMR_USERNAME_FILE"),
        "password": ("EMR_PASSWORD", "EMR_PASSWORD_FILE"),
        "hchanh_username": ("EMR_HCHANH_USERNAME", "EMR_HCHANH_USERNAME_FILE"),
        "hchanh_password": ("EMR_HCHANH_PASSWORD", "EMR_HCHANH_PASSWORD_FILE"),
        # Tài khoản riêng cho dịch truyền — cho phép chạy song song với chăm sóc
        # (xem docs/PARALLEL_CARE_INFUSION.md). Không đặt thì input_infusions.py
        # tự dùng lại tài khoản chính, hành vi giữ nguyên như trước.
        "infusion_username": ("EMR_INFUSION_USERNAME", "EMR_INFUSION_USERNAME_FILE"),
        "infusion_password": ("EMR_INFUSION_PASSWORD", "EMR_INFUSION_PASSWORD_FILE"),
    }
    for key, (env_name, file_env) in mapping.items():
        value = _read_secret_env(env_name, file_env)
        if value:
            out[key] = value

    require_env = str(os.environ.get("EMR_REQUIRE_SECRET_ENV", "") or "").strip().lower() in {"1", "true", "yes", "on"}
    if require_env:
        missing = [key for key, (env_name, file_env) in mapping.items() if out.get(key) and not (_read_secret_env(env_name, file_env))]
        if missing:
            raise RuntimeError(
                "Credential dạng rõ trong config đã bị chặn bởi EMR_REQUIRE_SECRET_ENV. "
                f"Hãy chuyển các khóa sau sang biến môi trường/secret file: {', '.join(missing)}"
            )
    return out

# ── load_config ───────────────────────────────────────────────────────────────

def _deep_merge_config(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = dict(base or {})
    for key, value in (override or {}).items():
        if (
            isinstance(value, dict)
            and isinstance(out.get(key), dict)
        ):
            out[key] = _deep_merge_config(out[key], value)
        else:
            out[key] = value
    return out


def load_config() -> Dict[str, Any]:
    """
    Đọc và merge config.json theo thứ tự ưu tiên thấp → cao:
      1. <thư mục script>/../config/config.json  (cấu hình thật: URL/tài khoản)
      2. <thư mục script>/config.json            (khi chạy tay từ worker/)
      3. <cwd>/config.json                       (override session, thường chỉ lịch ĐD)
      4. APP_CONFIG_PATH                         (server.js truyền vào)

    Lý do merge: file config theo session không nên chứa username/password.
    Nó chỉ cần override các phần như ten_dieu_duong/ds_dieu_duong, còn credential
    lấy từ config gốc.
    """
    script_dir = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(script_dir, "..", "config", "config.json"),
        os.path.join(script_dir, "config.json"),
        os.path.join(os.getcwd(), "config.json"),
    ]

    env_path = os.environ.get("APP_CONFIG_PATH", "").strip()
    if env_path:
        candidates.append(env_path)

    merged: Dict[str, Any] = {}
    found = False
    seen = set()

    for path in candidates:
        path = os.path.normpath(path)
        if path in seen:
            continue
        seen.add(path)
        if os.path.isfile(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    cfg = json.load(f)
                if isinstance(cfg, dict):
                    merged = _deep_merge_config(merged, cfg)
                    found = True
            except Exception as e:
                print(f"[utils] Cảnh báo: đọc config '{path}' lỗi: {e}", file=sys.stderr)

    if found:
        return _apply_secret_overrides(merged)

    env_only = _apply_secret_overrides({})
    if env_only:
        return env_only
    print("[utils] Cảnh báo: Không tìm thấy config.json. Trả về dict rỗng.", file=sys.stderr)
    return {}


# ── normalize_date ────────────────────────────────────────────────────────────

def normalize_date(s: Any, default_year: Any = None) -> Optional[str]:
    """
    Chuẩn hoá chuỗi ngày về dạng "dd/mm/yyyy".

    Chấp nhận:
      - "dd/mm/yyyy"  hoặc  "dd-mm-yyyy"   → trả về nguyên (đã validate)
      - "dd/mm"       hoặc  "dd-mm"         → ghép default_year
      - Trả về None nếu không parse được
    """
    if s is None:
        return None
    s = str(s).strip()
    if not s:
        return None

    year_str = str(default_year) if default_year else str(datetime.now().year)

    # dd/mm/yyyy hoặc dd-mm-yyyy
    m = re.match(r"^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$", s)
    if m:
        dd, mm, yyyy = m.group(1).zfill(2), m.group(2).zfill(2), m.group(3)
        if _valid_date(dd, mm, yyyy):
            return f"{dd}/{mm}/{yyyy}"
        return None

    # dd/mm hoặc dd-mm
    m = re.match(r"^(\d{1,2})[/\-](\d{1,2})$", s)
    if m:
        dd, mm = m.group(1).zfill(2), m.group(2).zfill(2)
        if _valid_date(dd, mm, year_str):
            return f"{dd}/{mm}/{year_str}"
        return None

    return None


def _valid_date(dd: str, mm: str, yyyy: str) -> bool:
    try:
        datetime(int(yyyy), int(mm), int(dd))
        return True
    except ValueError:
        return False


# ── init_driver ───────────────────────────────────────────────────────────────

def init_driver(headless: bool = False) -> Tuple[Any, Any]:
    """
    Khởi tạo Selenium ChromeDriver.
    Trả về tuple (driver, WebDriverWait(driver, 30)).
    Raise RuntimeError nếu selenium chưa được cài.
    """
    if not _HAS_SELENIUM:
        raise RuntimeError(
            "Thiếu thư viện selenium. Hãy cài: pip install selenium"
        )

    options = ChromeOptions()

    # EMR có vài trang/AJAX giữ trạng thái loading rất lâu. Nếu để strategy mặc định
    # "normal", driver.get(...) có thể đứng ở bước tải hồ sơ BN dù DOM đã đủ để đọc.
    # "eager" trả quyền điều khiển ngay sau DOMContentLoaded; phần cần đọc vẫn được
    # chờ bằng WebDriverWait ở từng tác vụ. Có thể override bằng biến môi trường.
    page_load_strategy = (os.environ.get("SELENIUM_PAGE_LOAD_STRATEGY") or "eager").strip().lower()
    if page_load_strategy not in {"normal", "eager", "none"}:
        page_load_strategy = "eager"
    try:
        options.page_load_strategy = page_load_strategy
    except Exception:
        pass

    if headless:
        # Dùng dạng --headless để tránh một số máy Windows/ChromeDriver mở cửa sổ đen
        # khi dùng --headless=new. Có thể override bằng SELENIUM_HEADLESS_ARG nếu cần debug.
        headless_arg = (os.environ.get("SELENIUM_HEADLESS_ARG") or "--headless").strip()
        if headless_arg:
            options.add_argument(headless_arg)
        options.add_argument("--window-position=-32000,-32000")
        options.add_argument("--mute-audio")

    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-gpu")
    options.add_argument("--disable-extensions")
    options.add_argument("--disable-infobars")
    options.add_argument("--window-size=1366,900")
    options.add_argument("--start-maximized")
    options.add_argument("--disable-blink-features=AutomationControlled")
    options.add_argument("--lang=vi-VN")
    options.add_experimental_option("excludeSwitches", ["enable-logging"])  # tắt DevTools log

    # Selenium 4.6+ tự quản lý ChromeDriver qua selenium-manager.
    # Trên Windows, ChromeDriver/Python đôi khi bật một cửa sổ console đen; ẩn cửa sổ này
    # để chế độ chạy ẩn đúng nghĩa không làm che giao diện web app.
    service = ChromeService()
    try:
        if sys.platform.startswith("win") and hasattr(subprocess, "CREATE_NO_WINDOW"):
            service.creation_flags = subprocess.CREATE_NO_WINDOW
    except Exception:
        pass
    driver = webdriver.Chrome(service=service, options=options)

    # Không để Selenium chờ tải trang vô hạn. Khi timeout ở trang hồ sơ BN,
    # worker sẽ window.stop() và tiếp tục kiểm tra DOM thay vì treo cả tiến trình.
    page_load_timeout = _env_int("SELENIUM_PAGE_LOAD_TIMEOUT", 25, min_value=5, max_value=180)
    script_timeout = _env_int("SELENIUM_SCRIPT_TIMEOUT", 25, min_value=5, max_value=180)
    try:
        driver.set_page_load_timeout(page_load_timeout)
    except Exception:
        pass
    try:
        driver.set_script_timeout(script_timeout)
    except Exception:
        pass

    try:
        if not headless:
            driver.maximize_window()
    except Exception:
        pass
    wait   = WebDriverWait(driver, 30)

    return driver, wait


# ── login_emr ─────────────────────────────────────────────────────────────────

def _save_login_debug(driver: Any, label: str = "login_failed") -> None:
    try:
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        log_dir = os.path.join(os.getcwd(), "logs")
        os.makedirs(log_dir, exist_ok=True)
        html_path = os.path.join(log_dir, f"{label}_{ts}.html")
        png_path = os.path.join(log_dir, f"{label}_{ts}.png")
        with open(html_path, "w", encoding="utf-8") as f:
            f.write(driver.page_source or "")
        try:
            driver.save_screenshot(png_path)
        except Exception:
            png_path = ""
        print(f"[login_emr] Debug login: {html_path}" + (f" | {png_path}" if png_path else ""))
    except Exception as e:
        print(f"[login_emr] Không lưu được debug login: {e}")


def _find_login_input(driver: Any, wait: Any, field_id: str, fallback_xpath: str) -> Any:
    # Ưu tiên ID như config; nếu EMR đổi id hoặc đang render khác, thử name/xpath fallback.
    candidates = [
        (By.ID, field_id),
        (By.NAME, field_id),
        (By.CSS_SELECTOR, f"input#{field_id}"),
        (By.XPATH, fallback_xpath),
    ]
    last_err = None
    for by, value in candidates:
        try:
            return wait.until(EC.presence_of_element_located((by, value)))
        except Exception as e:
            last_err = e
    raise last_err or RuntimeError(f"Không tìm thấy field login: {field_id}")


def login_emr(driver: Any, wait: Any, config: Dict[str, Any]) -> None:
    """
    Đăng nhập vào hệ thống EMR qua Selenium.
    Bản này kiểm tra đăng nhập thật sự thành công; nếu còn ở login.aspx sẽ báo lỗi rõ và lưu debug.
    """
    if not _HAS_SELENIUM:
        raise RuntimeError("Thiếu thư viện selenium.")

    url      = (config.get("url_login") or "").strip()
    username = (config.get("username")  or "").strip()
    password = (config.get("password")  or "").strip()

    if not url:
        raise RuntimeError("Thiếu 'url_login' trong config.json")
    if not username or not password:
        raise RuntimeError("Thiếu 'username' hoặc 'password' trong config.json")

    user_field   = config.get("login_user_field",   "txtLoginName")
    pass_field   = config.get("login_pass_field",   "txtPassword")
    button_field = config.get("login_button_field", "btnLogin")

    print(f"[login_emr] Đang đăng nhập: {url}")
    driver.get(url)

    def is_logged_in() -> bool:
        current = (driver.current_url or "").lower()
        html = (driver.page_source or "").lower()
        if "login.aspx" not in current and ("home.aspx" in current or "wpid=" in current or "đăng xuất" in html or "logout" in html):
            return True
        return False

    last_err = None
    for attempt in range(1, 4):
        try:
            u_el = _find_login_input(driver, wait, user_field, "//input[@type='text' or @type='email' or contains(@placeholder,'Tài khoản') or contains(@placeholder,'tài khoản')]")
            p_el = _find_login_input(driver, wait, pass_field, "//input[@type='password' or contains(@placeholder,'Mật khẩu') or contains(@placeholder,'mật khẩu')]")

            try:
                u_el.click()
                u_el.send_keys(Keys.CONTROL, "a")
                u_el.send_keys(username)
            except Exception:
                driver.execute_script("arguments[0].value = arguments[1];", u_el, username)

            try:
                p_el.click()
                p_el.send_keys(Keys.CONTROL, "a")
                p_el.send_keys(password)
            except Exception:
                driver.execute_script("arguments[0].value = arguments[1];", p_el, password)

            clicked = False
            for by, value in [
                (By.ID, button_field),
                (By.NAME, button_field),
                (By.XPATH, "//button[contains(normalize-space(), 'Đăng nhập') or contains(normalize-space(), 'Login')]"),
                (By.XPATH, "//input[@type='submit' or @type='button']"),
            ]:
                try:
                    btn = driver.find_element(by, value)
                    driver.execute_script("arguments[0].click();", btn)
                    clicked = True
                    break
                except Exception:
                    continue
            if not clicked:
                p_el.send_keys(Keys.ENTER)

            try:
                WebDriverWait(driver, 10).until(lambda d: is_logged_in())
            except Exception:
                # Nhiều bản EMR bắt event Enter ổn hơn click.
                try:
                    p_el.send_keys(Keys.ENTER)
                    WebDriverWait(driver, 8).until(lambda d: is_logged_in())
                except Exception as e:
                    last_err = e

            if is_logged_in():
                print(f"[login_emr] Đã vào: {driver.current_url}")
                return

            print(f"[login_emr] Lần {attempt} chưa qua login, thử lại...")
            time.sleep(1.0)
        except Exception as e:
            last_err = e
            time.sleep(1.0)

    _save_login_debug(driver, "login_failed")
    raise RuntimeError(f"Đăng nhập EMR không thành công, vẫn ở trang login. Lỗi gần nhất: {last_err}")


# ── strip_accents ─────────────────────────────────────────────────────────────

def strip_accents(s: str) -> str:
    """
    Bỏ dấu tiếng Việt bằng cách NFD-normalize rồi loại combining marks.
    Ví dụ: 'Nguyễn' → 'Nguyen', 'điều dưỡng' → 'dieu duong'
    """
    import unicodedata
    s = str(s or '')
    # NFC trước để chuẩn hoá các ký tự tổ hợp
    s = unicodedata.normalize('NFC', s)
    # Chuyển sang NFD để tách base char + combining diacritical
    s = unicodedata.normalize('NFD', s)
    # Bỏ tất cả combining diacritical marks (category Mn)
    s = ''.join(ch for ch in s if unicodedata.category(ch) != 'Mn')
    # Sửa 'đ' / 'Đ' (không phải combining mark — cần xử lý riêng)
    s = s.replace('\u0111', 'd').replace('\u0110', 'D')
    return s


# ── chuan_hoa_unicode ─────────────────────────────────────────────────────────

def chuan_hoa_unicode(s: str) -> str:
    """
    Chuẩn hoá Unicode cho chuỗi tiếng Việt:
      - NFC normalize
      - Bỏ dấu (strip_accents)
      - Chuyển về chữ thường
      - Thu gọn khoảng trắng
    Dùng để so sánh tên điều dưỡng, nội dung phiếu chăm sóc.
    """
    if s is None:
        return ''
    s = str(s)
    import unicodedata as _ud
    s = _ud.normalize('NFC', s)
    s = strip_accents(s).lower()
    s = ' '.join(s.split())
    return s


# ── get_nurse_by_shift ────────────────────────────────────────────────────────

def get_nurse_by_shift(time_str: str, config_names: Any, force_shift: str = None) -> str:
    """
    Trả về tên điều dưỡng phụ trách tại thời điểm time_str dựa trên lịch config_names.

    Quy tắc ca:
      - Ca làm (work)  : 07:00 – 10:59  và  13:00 – 16:59
      - Ca trực (oncall): 11:00 – 12:59  và  17:00 – 06:59 (hôm sau)
      - 00:00 – 06:59  : vẫn thuộc ca trực của ngày hôm trước.

    Lưu ý quan trọng:
      Nếu lịch được lưu theo ngày cụ thể trong days[YYYY-MM-DD], các giờ 00:00–06:59
      phải tra cứu bằng ngày hôm trước. Nếu không, chương trình sẽ đổi sang người trực
      của ngày mới ngay lúc 00:00.

    config_names là dict ten_dieu_duong từ config.json:
      { "Monday": {"work": [...], "oncall": [...]}, "days": {...} }

    Trả về chuỗi rỗng nếu không tìm được.
    """
    import re as _re
    from datetime import datetime as _dt, timedelta as _td

    _WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

    def _iso_from_dt(dt_obj):
        return f"{dt_obj.year:04d}-{dt_obj.month:02d}-{dt_obj.day:02d}"

    def _dt_from_parts(day, month, year, hour_value, minute_value):
        y = int(year)
        if y < 100:
            y += 2000
        return _dt(y, int(month), int(day), int(hour_value), int(minute_value))

    # ── Parse giờ và ngày từ time_str ────────────────────────────────────────
    hour = None
    weekday_idx = None  # 0=Mon … 6=Sun
    date_iso = ''       # ngày thật của thời điểm y lệnh
    lookup_iso = ''     # ngày dùng để tra lịch trực

    if time_str:
        raw = str(time_str)

        # Dạng "HH:MM DD/MM/YYYY" hoặc "HH:MM DD/MM/YY"
        m = _re.search(r'(\d{1,2}):(\d{2})\s+(\d{1,2})/(\d{1,2})/(\d{2,4})', raw)
        if m:
            try:
                dt = _dt_from_parts(m.group(3), m.group(4), m.group(5), m.group(1), m.group(2))
                hour = dt.hour
                weekday_idx = dt.weekday()
                date_iso = _iso_from_dt(dt)
            except Exception:
                pass

        # Dạng "DD/MM/YYYY HH:MM" hoặc "DD/MM/YY HH:MM"
        if hour is None:
            m_alt = _re.search(r'(\d{1,2})/(\d{1,2})/(\d{2,4})\s+(\d{1,2}):(\d{2})', raw)
            if m_alt:
                try:
                    dt = _dt_from_parts(m_alt.group(1), m_alt.group(2), m_alt.group(3), m_alt.group(4), m_alt.group(5))
                    hour = dt.hour
                    weekday_idx = dt.weekday()
                    date_iso = _iso_from_dt(dt)
                except Exception:
                    pass

        if hour is None:
            # Chỉ có giờ "HH:MM"
            m2 = _re.search(r'(\d{1,2}):(\d{2})', raw)
            if m2:
                try:
                    hour = int(m2.group(1))
                except Exception:
                    pass

    now = _dt.now()
    if hour is None:
        hour = now.hour
    if weekday_idx is None:
        weekday_idx = now.weekday()
    if not date_iso:
        date_iso = _iso_from_dt(now)

    # ── Xác định ca: shift = 'work' | 'oncall'; và ngày tra lịch ─────────────
    lookup_iso = date_iso
    if 0 <= hour <= 6:
        # Đêm khuya → vẫn là ca trực ngày hôm trước, kể cả khi dùng lịch days[YYYY-MM-DD].
        try:
            y, mo, d = [int(x) for x in date_iso.split('-')]
            prev_dt = _dt(y, mo, d) - _td(days=1)
            lookup_iso = _iso_from_dt(prev_dt)
            weekday_idx = prev_dt.weekday()
        except Exception:
            weekday_idx = (weekday_idx - 1) % 7
        day_key = _WEEKDAY_NAMES[weekday_idx]
        shift = 'oncall'
    elif 7 <= hour <= 10:
        day_key = _WEEKDAY_NAMES[weekday_idx]
        shift = 'work'
    elif 11 <= hour <= 12:
        day_key = _WEEKDAY_NAMES[weekday_idx]
        shift = 'oncall'
    elif 13 <= hour <= 16:
        day_key = _WEEKDAY_NAMES[weekday_idx]
        shift = 'work'
    else:  # 17 – 23
        day_key = _WEEKDAY_NAMES[weekday_idx]
        shift = 'oncall'

    forced_shift = str(force_shift or '').strip().lower()
    if forced_shift in ('work', 'oncall'):
        shift = forced_shift

    # ── Tra cứu trong config_names ────────────────────────────────────────────
    if not isinstance(config_names, dict):
        return ''

    def _first_name(d: dict, key: str) -> str:
        bucket = d.get(key) or []
        if isinstance(bucket, list) and bucket:
            return str(bucket[0]).strip()
        if isinstance(bucket, str):
            return bucket.strip()
        return ''

    # Ưu tiên lịch ngày cụ thể nếu cấu hình có dạng days[YYYY-MM-DD].
    # Với 00:00–06:59 phải dùng lookup_iso = ngày hôm trước.
    days_cfg = config_names.get('days') if isinstance(config_names, dict) else {}
    if isinstance(days_cfg, dict) and lookup_iso:
        exact_cfg = days_cfg.get(lookup_iso) or {}
        if isinstance(exact_cfg, dict):
            name = _first_name(exact_cfg, shift)
            if not name:
                other = 'work' if shift == 'oncall' else 'oncall'
                name = _first_name(exact_cfg, other)
            if name:
                return name

    day_cfg = config_names.get(day_key) or config_names.get('Default') or {}
    if not isinstance(day_cfg, dict):
        return ''

    name = _first_name(day_cfg, shift)
    if not name:
        # fallback: thử shift còn lại
        other = 'work' if shift == 'oncall' else 'oncall'
        name = _first_name(day_cfg, other)
    if not name:
        # fallback toàn bộ config
        for dk in _WEEKDAY_NAMES + ['Default']:
            dc = config_names.get(dk) or {}
            if isinstance(dc, dict):
                name = _first_name(dc, 'work') or _first_name(dc, 'oncall')
                if name:
                    break

    return name

# ── handle_popups ─────────────────────────────────────────────────────────────

def handle_popups(driver: Any) -> bool:
    """
    Xử lý và đóng các popup/alert của trình duyệt trong quá trình tự động hoá Selenium.
    Hỗ trợ:
      - Browser alert/confirm/prompt (driver.switch_to.alert)
      - SweetAlert (.sweet-alert .confirm)
      - Bootstrap modal (.modal.show .btn-primary, .btn-ok, .close)
      - Nút 'Đóng' / 'OK' / 'Xác nhận' / 'Close' thông thường

    Trả về True nếu đã đóng ít nhất một popup.
    """
    if driver is None:
        return False

    closed_any = False

    # 1) Browser native alert
    try:
        from selenium.webdriver.support.ui import WebDriverWait as _WDW
        from selenium.webdriver.support import expected_conditions as _EC
        alert = _WDW(driver, 1).until(_EC.alert_is_present())
        alert.accept()
        closed_any = True
    except Exception:
        pass

    # 2) SweetAlert
    try:
        from selenium.webdriver.common.by import By as _By
        btn = driver.find_element(_By.CSS_SELECTOR, '.sweet-alert .confirm, .swal2-confirm')
        if btn.is_displayed():
            driver.execute_script('arguments[0].click();', btn)
            closed_any = True
    except Exception:
        pass

    # 3) Bootstrap modal — nút confirm / close
    try:
        from selenium.webdriver.common.by import By as _By
        selectors = [
            '.modal.show .btn-primary',
            '.modal.show .btn-ok',
            '.modal.show .btn-success',
            '.modal.show [data-dismiss="modal"]',
            '.modal.show .close',
        ]
        for sel in selectors:
            try:
                el = driver.find_element(_By.CSS_SELECTOR, sel)
                if el.is_displayed():
                    driver.execute_script('arguments[0].click();', el)
                    closed_any = True
                    break
            except Exception:
                pass
    except Exception:
        pass

    # 4) Nút văn bản phổ biến (Đóng / OK / Xác nhận)
    if not closed_any:
        try:
            from selenium.webdriver.common.by import By as _By
            xpath = (
                "//button[not(ancestor::*[contains(@style,'display:none') or contains(@style,'display: none')])]"
                "[contains(translate(normalize-space(text()),'abcdefghijklmnopqrstuvwxyz','ABCDEFGHIJKLMNOPQRSTUVWXYZ'),'OK')"
                " or contains(normalize-space(text()),'Đóng')"
                " or contains(normalize-space(text()),'Xác nhận')"
                " or contains(normalize-space(text()),'Đồng ý')]"
            )
            btns = driver.find_elements(_By.XPATH, xpath)
            for b in btns:
                try:
                    if b.is_displayed() and b.is_enabled():
                        driver.execute_script('arguments[0].click();', b)
                        closed_any = True
                        break
                except Exception:
                    pass
        except Exception:
            pass

    return closed_any
