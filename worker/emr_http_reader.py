# -*- coding: utf-8 -*-
from __future__ import annotations

"""
READ-ONLY HTTP helper for EMR pages.

Level-1 design:
- Use HTTP (requests) to READ pages (scan list / try read Y lệnh).
- Fallback to Selenium for anything that requires JS/AJAX or write actions.

Important:
- This module only submits the normal login <form> (ASP.NET WebForms) the same way a browser would.
- No "API reverse engineering" logic is included.
"""

import json
import os
import re
import time
from datetime import datetime
from pathlib import Path
from dataclasses import dataclass
from typing import Dict, Optional, Tuple, List, Callable
from urllib.parse import urlparse, urljoin, parse_qsl, urlencode, urlunparse

try:
    import requests
except ModuleNotFoundError:  # pragma: no cover
    requests = None  # type: ignore

try:
    from bs4 import BeautifulSoup
except ModuleNotFoundError:  # pragma: no cover
    BeautifulSoup = None  # type: ignore

from emr_parsers import parse_noitru_page


# -------------------------
# URL helpers
# -------------------------
def _upsert_query(url: str, **params: str) -> str:
    p = urlparse(url)
    q = dict(parse_qsl(p.query, keep_blank_values=True))
    for k, v in params.items():
        q[k] = v
    new_query = urlencode(q, doseq=True)
    return urlunparse((p.scheme, p.netloc, p.path, p.params, new_query, p.fragment))


def _replace_or_add_denngay(url: str, denngay: str) -> str:
    if "denngay=" in url:
        return re.sub(r"(denngay=)([\d/]+)", rf"\g<1>{denngay}", url)
    return _upsert_query(url, denngay=denngay)


def _abs(base_origin: str, url_or_path: str) -> str:
    if not url_or_path:
        return ""
    if url_or_path.startswith("http://") or url_or_path.startswith("https://"):
        return url_or_path
    return urljoin(base_origin, url_or_path)



def _default_cookie_file() -> str:
    """Cookie jar dùng cho HTTP read-only, đặt ngoài session để quét lại không cần Chrome."""
    runtime_dir = (os.environ.get("WORKER_RUNTIME_DIR") or "").strip()
    try:
        if runtime_dir:
            p = Path(runtime_dir).resolve()
            root = p.parent.parent if p.parent.name.lower() == "sessions" else p.parent
        else:
            # cwd thường là project root khi gọi main_worker từ server.js
            root = Path.cwd().resolve() / ".runtime"
        return str(root / "auth" / "emr_http_cookies.json")
    except Exception:
        return str(Path.cwd() / ".runtime" / "auth" / "emr_http_cookies.json")


def _cfg_bool_value(value: object, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on", "co", "có"}

# -------------------------
# Config / Session
# -------------------------
@dataclass
class EmrHttpConfig:
    url_login: str
    username: str
    password: str
    url_inpatient_list: str

    # identifiers you see in the HTML (usually id). We'll resolve to the real "name" at runtime.
    login_user_field: str = "txtLoginName"
    login_pass_field: str = "txtPassword"
    login_button_field: str = "btnLogin"
    login_button_value: str = "Đăng nhập"

    login_post_url: Optional[str] = None
    timeout_sec: int = 30
    request_delay_ms: int = 80
    max_retries: int = 2
    cookie_file: str = ""
    use_cached_cookies: bool = True


class EmrHttpSession:
    """
    READ ONLY tasks:
      - scan_all_inpatients()
      - fetch_patient_page()
      - try_get_ylenh_html()
    """

    def __init__(self, cfg: EmrHttpConfig):
        if requests is None:
            raise RuntimeError("Thiếu requests. Hãy cài: pip install requests")
        if BeautifulSoup is None:
            raise RuntimeError("Thiếu bs4. Hãy cài: pip install beautifulsoup4")

        self.cfg = cfg
        self.s = requests.Session()
        self._last_request_at = 0.0

        # More browser-like headers (some intranet apps depend on these)
        self.s.headers.update(
            {
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/145.0 Safari/537.36"
                ),
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "vi,en-US;q=0.9,en;q=0.8",
                "Connection": "keep-alive",
            }
        )

        p = urlparse(cfg.url_login)
        self.base_origin = f"{p.scheme}://{p.netloc}"
        self._session_inpatient_url: str = ""

    @classmethod
    def from_config_dict(cls, config: Dict) -> "EmrHttpSession":
        url_login = (config.get("url_login") or "").strip()
        username = (config.get("username") or "").strip()
        password = (config.get("password") or "").strip()
        url_inpatient_list = (config.get("url_inpatient_list") or "").strip()

        if not (url_login and username and password and url_inpatient_list):
            raise RuntimeError("Thiếu cấu hình HTTP. Cần: url_login, username, password, url_inpatient_list")

        cfg = EmrHttpConfig(
            url_login=url_login,
            username=username,
            password=password,
            url_inpatient_list=url_inpatient_list,
            login_user_field=(config.get("login_user_field") or "txtLoginName"),
            login_pass_field=(config.get("login_pass_field") or "txtPassword"),
            login_button_field=(config.get("login_button_field") or "btnLogin"),
            login_button_value=(config.get("login_button_value") or "Đăng nhập"),
            login_post_url=(config.get("login_post_url") or None),
            timeout_sec=int(config.get("http_timeout_sec") or 30),
            request_delay_ms=int(config.get("http_read_request_delay_ms") or config.get("http_request_delay_ms") or 80),
            max_retries=max(0, int(config.get("http_read_max_retries") or config.get("http_max_retries") or 2)),
            cookie_file=(config.get("http_cookie_file") or os.environ.get("EMR_HTTP_COOKIE_FILE") or _default_cookie_file()),
            use_cached_cookies=_cfg_bool_value(config.get("http_use_cached_cookies"), True),
        )
        return cls(cfg)

    # -------------------------
    # Low-level HTTP
    # -------------------------
    def _throttle(self) -> None:
        """
        Giữ nhịp request tối thiểu để không bắn dồn vào EMR.
        Mặc định 80ms: đủ nhẹ cho web nội bộ nhưng vẫn nhanh hơn mở Chrome nhiều lần.
        """
        delay = max(0, int(self.cfg.request_delay_ms or 0)) / 1000.0
        if delay <= 0:
            return
        now = time.perf_counter()
        wait = delay - (now - self._last_request_at)
        if wait > 0:
            time.sleep(wait)

    def _request_html(self, method: str, url: str, **kwargs) -> Tuple[str, str]:
        u = _abs(self.base_origin, url)
        attempts = max(1, int(self.cfg.max_retries or 0) + 1)
        last_exc = None
        for attempt in range(1, attempts + 1):
            self._throttle()
            try:
                r = self.s.request(method, u, allow_redirects=True, timeout=self.cfg.timeout_sec, **kwargs)
                self._last_request_at = time.perf_counter()
                # Retry nhẹ với lỗi server tạm thời. Không retry 401/403 để tránh gây tải vô ích.
                if r.status_code >= 500 and attempt < attempts:
                    time.sleep(min(0.8, 0.2 * attempt))
                    continue
                r.raise_for_status()
                return r.text, r.url
            except Exception as exc:
                last_exc = exc
                if attempt >= attempts:
                    break
                time.sleep(min(0.8, 0.2 * attempt))
        raise last_exc  # type: ignore[misc]

    def get_html(self, url: str) -> Tuple[str, str]:
        return self._request_html("GET", url)

    def post_html(self, url: str, data: Dict[str, str], referer: Optional[str] = None) -> Tuple[str, str]:
        headers = {}
        if referer:
            headers["Referer"] = referer
            # some apps validate Origin/Referer
            headers["Origin"] = self.base_origin
        return self._request_html("POST", url, data=data, headers=headers)


    # -------------------------
    # Cookie cache for HTTP-only read
    # -------------------------
    def _effective_inpatient_url(self) -> str:
        return getattr(self, "_session_inpatient_url", "") or self.cfg.url_inpatient_list

    def load_cookies(self) -> bool:
        """Nạp cookie đã lấy từ Selenium trước đó. Không ghi log giá trị cookie."""
        if not getattr(self.cfg, "use_cached_cookies", True) or not getattr(self.cfg, "cookie_file", ""):
            return False
        p = Path(getattr(self.cfg, "cookie_file", ""))
        if not p.exists():
            return False
        try:
            with p.open("r", encoding="utf-8") as f:
                data = json.load(f)
            max_age_hours = max(1, min(168, int(os.environ.get("EMR_HTTP_COOKIE_MAX_AGE_HOURS", "8") or 8)))
            created_raw = str(data.get("created_at") or "") if isinstance(data, dict) else ""
            if created_raw:
                try:
                    created_at = datetime.fromisoformat(created_raw)
                    if created_at.tzinfo is None:
                        created_at = created_at.astimezone()
                    age_seconds = (datetime.now().astimezone() - created_at).total_seconds()
                    if age_seconds > max_age_hours * 3600:
                        try:
                            p.unlink()
                        except Exception:
                            pass
                        return False
                except Exception:
                    return False
            cookies = data.get("cookies") if isinstance(data, dict) else None
            if not isinstance(cookies, list) or not cookies:
                return False
            self.s.cookies.clear()
            for c in cookies:
                if not isinstance(c, dict):
                    continue
                name = str(c.get("name") or "").strip()
                value = str(c.get("value") or "")
                if not name:
                    continue
                domain = str(c.get("domain") or urlparse(self.cfg.url_login).hostname or "").strip() or None
                path = str(c.get("path") or "/")
                try:
                    self.s.cookies.set(name, value, domain=domain, path=path)
                except Exception:
                    self.s.cookies.set(name, value)
            self._session_inpatient_url = str(data.get("inpatient_list_url") or data.get("url_inpatient_list") or "").strip()
            return bool(self.s.cookies)
        except Exception:
            return False

    def import_selenium_cookies(self, cookies: List[Dict[str, object]]) -> int:
        """Nhập cookie từ Selenium driver.get_cookies() vào requests.Session."""
        count = 0
        self.s.cookies.clear()
        for c in cookies or []:
            if not isinstance(c, dict):
                continue
            name = str(c.get("name") or "").strip()
            value = str(c.get("value") or "")
            if not name:
                continue
            domain = str(c.get("domain") or urlparse(self.cfg.url_login).hostname or "").strip() or None
            path = str(c.get("path") or "/")
            try:
                self.s.cookies.set(name, value, domain=domain, path=path)
            except Exception:
                self.s.cookies.set(name, value)
            count += 1
        return count

    def save_cookies(self, *, inpatient_list_url: str = "") -> str:
        """Lưu cookie HTTP vào .runtime/auth. Không lưu username/password."""
        path = Path(getattr(self.cfg, "cookie_file", "") or _default_cookie_file())
        path.parent.mkdir(parents=True, exist_ok=True)
        cookies = []
        for c in self.s.cookies:
            cookies.append({
                "name": c.name,
                "value": c.value,
                "domain": c.domain,
                "path": c.path or "/",
                "secure": bool(getattr(c, "secure", False)),
                "expires": getattr(c, "expires", None),
            })
        payload = {
            "schema": "emr-http-cookie-cache-v1",
            "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "base_origin": self.base_origin,
            "url_login_host": urlparse(self.cfg.url_login).netloc,
            "inpatient_list_url": inpatient_list_url or self._session_inpatient_url or self.cfg.url_inpatient_list,
            "cookies": cookies,
        }
        tmp = path.with_suffix(path.suffix + ".tmp")
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, path)
        try:
            os.chmod(path, 0o600)
        except Exception:
            pass
        return str(path)

    def verify_logged_in(self) -> bool:
        """Kiểm tra cookie/session hiện tại có vào được trang danh sách không."""
        html, _final = self.get_html(self._effective_inpatient_url())
        return not self._looks_like_login(html)

    # -------------------------
    # Login (WebForms-friendly)
    # -------------------------
    def _looks_like_login(self, html: str) -> bool:
        if not html:
            return False
        low = html.lower()
        # common signals
        if "type=\"password\"" in low or "type='password'" in low:
            return True
        if "txtloginname" in low or "txtpassword" in low:
            return True
        if "đăng nhập" in low or "dang nhap" in low:
            return True
        return False

    def _pick_input_name(self, form, preferred_id_or_name: str, input_type: Optional[str] = None) -> Optional[str]:
        """
        Return the actual field name to post.
        We try by id then by name, then a heuristic match by input type.
        """
        # 1) by id
        el = form.find("input", id=preferred_id_or_name)
        if el and (el.get("name") or el.get("id")):
            return el.get("name") or el.get("id")

        # 2) by name
        el = form.find("input", attrs={"name": preferred_id_or_name})
        if el and (el.get("name") or el.get("id")):
            return el.get("name") or el.get("id")

        # 3) heuristic
        if input_type:
            candidates = []
            for inp in form.find_all("input"):
                it = (inp.get("type") or "").lower()
                if it != input_type:
                    continue
                name = inp.get("name") or inp.get("id")
                if not name:
                    continue
                candidates.append(name)
            if candidates:
                return candidates[0]

        return None

    def _get_webforms_hidden(self, form) -> Dict[str, str]:
        payload: Dict[str, str] = {}
        for inp in form.find_all("input"):
            itype = (inp.get("type") or "").lower()
            if itype != "hidden":
                continue
            name = inp.get("name") or inp.get("id")
            if not name:
                continue
            payload[name] = inp.get("value") or ""
        return payload

    def _resolve_login_button(self, form) -> Tuple[Optional[str], Optional[str], Optional[str]]:
        """
        Returns (button_name, button_value, event_target)
        event_target is used for __doPostBack cases.
        """
        # 1) try find by id/name in config
        el = form.find(id=self.cfg.login_button_field)
        if not el:
            el = form.find(attrs={"name": self.cfg.login_button_field})

        if el:
            # submit input/button
            nm = el.get("name") or el.get("id")
            val = el.get("value") or self.cfg.login_button_value
            onclick = (el.get("onclick") or "")
            m = re.search(r"__doPostBack\('([^']+)'\s*,\s*'([^']*)'\)", onclick)
            if m:
                return None, None, m.group(1)
            if nm:
                return nm, val, None

        # 2) any input submit with value contains "đăng nhập"
        for inp in form.find_all("input"):
            it = (inp.get("type") or "").lower()
            if it not in {"submit", "button"}:
                continue
            val = (inp.get("value") or "").strip()
            nm = inp.get("name") or inp.get("id")
            onclick = (inp.get("onclick") or "")
            if "đăng nhập" in val.lower() or "login" in val.lower():
                m = re.search(r"__doPostBack\('([^']+)'\s*,\s*'([^']*)'\)", onclick)
                if m:
                    return None, None, m.group(1)
                if nm:
                    return nm, val, None

        # 3) __doPostBack link
        for a in form.find_all("a", href=True):
            href = a["href"]
            if "__doPostBack" in href:
                m = re.search(r"__doPostBack\('([^']+)'\s*,\s*'([^']*)'\)", href)
                if m and ("đăng nhập" in (a.get_text(" ", strip=True) or "").lower() or "login" in href.lower()):
                    return None, None, m.group(1)

        # 4) last resort: first submit
        for inp in form.find_all("input"):
            it = (inp.get("type") or "").lower()
            if it == "submit":
                nm = inp.get("name") or inp.get("id")
                val = (inp.get("value") or "").strip()
                if nm:
                    return nm, val, None

        return None, None, None

    def _find_login_form(self, soup) -> Optional[object]:
        """Return the form that most likely contains the login controls."""
        forms = soup.find_all("form")
        if not forms:
            return None

        def score(form) -> int:
            html = str(form).lower()
            text = form.get_text(" ", strip=True).lower()
            sc = 0
            if form.find("input", attrs={"type": "password"}):
                sc += 100
            if form.find("input", id=self.cfg.login_user_field) or form.find("input", attrs={"name": self.cfg.login_user_field}):
                sc += 50
            if form.find("input", id=self.cfg.login_pass_field) or form.find("input", attrs={"name": self.cfg.login_pass_field}):
                sc += 50
            for token in ("txtlogin", "txtuser", "username", "password", "matkhau", "mật khẩu", "đăng nhập", "dang nhap", "login"):
                if token in html or token in text:
                    sc += 10
            return sc

        ranked = sorted(forms, key=score, reverse=True)
        return ranked[0] if ranked and score(ranked[0]) > 0 else forms[0]

    def _resolve_login_fields(self, form) -> Tuple[Optional[str], Optional[str]]:
        """Resolve real POST field names for username/password from a login form."""
        user_name = self._pick_input_name(form, self.cfg.login_user_field, input_type="text")
        pass_name = self._pick_input_name(form, self.cfg.login_pass_field, input_type="password")

        if not user_name:
            # heuristic: first non-hidden input before the password input
            for inp in form.find_all("input"):
                it = (inp.get("type") or "").lower()
                if it in {"hidden", "password", "submit", "button", "checkbox", "radio"}:
                    continue
                nm = inp.get("name") or inp.get("id")
                if nm:
                    user_name = nm
                    break

        if not pass_name:
            for inp in form.find_all("input"):
                it = (inp.get("type") or "").lower()
                if it == "password":
                    pass_name = inp.get("name") or inp.get("id")
                    break

        # Some EMR login pages use plain ids and submit through JS. Prefer configured ids if visible.
        if not user_name:
            for inp in form.find_all("input"):
                iid = (inp.get("id") or "").lower()
                name = inp.get("name") or inp.get("id")
                if name and ("user" in iid or "login" in iid or "name" in iid or "account" in iid or "tai" in iid):
                    user_name = name
                    break
        if not pass_name:
            for inp in form.find_all("input"):
                iid = (inp.get("id") or "").lower()
                name = inp.get("name") or inp.get("id")
                if name and ("pass" in iid or "pwd" in iid or "mat" in iid):
                    pass_name = name
                    break

        return user_name, pass_name

    def _build_login_payload(self, form) -> Tuple[Dict[str, str], Optional[str]]:
        payload = self._get_webforms_hidden(form)
        user_name, pass_name = self._resolve_login_fields(form)

        # Last-resort: many ASP.NET/JS login pages accept the configured id as POST key
        # even when the HTML parser cannot find name=... on the controls.
        if not user_name and self.cfg.login_user_field:
            user_name = self.cfg.login_user_field
        if not pass_name and self.cfg.login_pass_field:
            pass_name = self.cfg.login_pass_field

        if not user_name or not pass_name:
            return payload, "Không xác định được field username/password trên trang login (HTTP)."

        payload[user_name] = self.cfg.username
        payload[pass_name] = self.cfg.password

        btn_name, btn_value, event_target = self._resolve_login_button(form)
        if event_target:
            payload["__EVENTTARGET"] = event_target
            payload.setdefault("__EVENTARGUMENT", "")
        elif btn_name:
            payload[btn_name] = btn_value or self.cfg.login_button_value

        return payload, None

    def _try_login_from_html(self, html: str, final_url: str) -> Tuple[bool, str]:
        soup = BeautifulSoup(html or "", "html.parser")
        form = self._find_login_form(soup)
        if not form:
            return False, "Không tìm thấy <form> trên trang login (HTTP)."

        payload, payload_error = self._build_login_payload(form)
        if payload_error:
            return False, payload_error

        action = (self.cfg.login_post_url or form.get("action") or "").strip()
        post_url = urljoin(final_url, action) if action else self.cfg.url_login

        try:
            self.post_html(post_url, payload, referer=final_url)
            html2, _final2 = self.get_html(self._effective_inpatient_url())
            if self._looks_like_login(html2):
                return False, "Đăng nhập HTTP thất bại: sau khi POST vẫn bị trả về trang login."
            try:
                self.save_cookies()
            except Exception:
                pass
            return True, ""
        except Exception as exc:
            return False, f"POST/verify login HTTP thất bại: {type(exc).__name__}"

    def login(self) -> None:
        """
        Robust login flow for read-only HTTP mode.

        It tries the protected inpatient URL first, then the configured login URL. If the
        protected URL returns a wrapper/form without username/password, we do not stop
        immediately; we retry with url_login so HTTP-only scan does not fail too early.
        """
        errors: List[str] = []

        # 0) Ưu tiên cookie đã lấy từ Chrome/Selenium trước đó.
        if self.load_cookies():
            try:
                if self.verify_logged_in():
                    return
                errors.append("cached_cookie: hết hạn hoặc vẫn bị trả về login")
            except Exception as exc:
                errors.append(f"cached_cookie: {type(exc).__name__}")

        # 1) Probe the target page. If already accessible, avoid any login POST.
        try:
            html0, final0 = self.get_html(self._effective_inpatient_url())
            if not self._looks_like_login(html0):
                try:
                    self.save_cookies()
                except Exception:
                    pass
                return
            ok, err = self._try_login_from_html(html0, final0)
            if ok:
                return
            errors.append(f"target_page: {err}")
        except Exception as exc:
            errors.append(f"target_page: {type(exc).__name__}")

        # 2) Dedicated login URL. This is required for EMR pages that return an
        # intermediate login shell or a 401/redirect when opened without browser state.
        try:
            html_login, final_login = self.get_html(self.cfg.url_login)
            ok, err = self._try_login_from_html(html_login, final_login)
            if ok:
                return
            errors.append(f"url_login: {err}")
        except Exception as exc:
            errors.append(f"url_login: {type(exc).__name__}")

        brief = "; ".join(errors[-4:]) if errors else "không rõ nguyên nhân"
        raise RuntimeError(
            "Đăng nhập HTTP thất bại. Không mở Chrome vì đang ở chế độ HTTP-only/no-Chrome. "
            f"Chi tiết an toàn: {brief}. "
            "Nếu Selenium đăng nhập được nhưng HTTP không được, hãy chạy: npm run auth:http để lấy cookie đăng nhập một lần. "
            "Sau đó bấm quét lại; lúc quét sẽ dùng HTTP-cookie và không mở Chrome."
        )

    # -------------------------
    # Read operations
    # -------------------------
    def scan_all_inpatients(self) -> Tuple[List[Dict], Dict[str, str]]:
        """
        Returns:
          - all_rows: list[dict] scanned from tblNoiTru
          - link_map: map ma_bn -> patient_view_url
        """
        all_rows: List[Dict] = []
        link_map: Dict[str, str] = {}

        url = self._effective_inpatient_url()
        visited = set()

        while url and url not in visited:
            visited.add(url)
            html, final_url = self.get_html(url)
            rows, links, next_url = parse_noitru_page(html, base_url=final_url)
            all_rows.extend(rows)
            link_map.update(links)
            url = next_url

        return all_rows, link_map

    def fetch_patient_page(self, patient_view_url: str, denngay: str) -> Tuple[str, str]:
        u = _replace_or_add_denngay(_abs(self.base_origin, patient_view_url), denngay)
        return self.get_html(u)

    def try_get_ylenh_html(self, patient_html: str, patient_url: str) -> Optional[Tuple[str, str]]:
        """
        Best-effort:
        - If timeline already in HTML -> return it.
        - Else follow any direct href that points to Y lệnh history tab/page.
        """
        if "vertical-timeline-block" in (patient_html or ""):
            return patient_html, patient_url

        soup = BeautifulSoup(patient_html or "", "html.parser")

        # 1) id=btnLSYLenh with href
        el = soup.find(id="btnLSYLenh")
        if el and el.name == "a" and el.get("href"):
            href = urljoin(patient_url, el["href"])
            html, final = self.get_html(href)
            return html, final

        # 2) any <a> with text contains "Y lệnh" and href
        for a in soup.find_all("a", href=True):
            txt = (a.get_text(" ", strip=True) or "").lower()
            if "y lệnh" in txt or "y lenh" in txt:
                href = urljoin(patient_url, a["href"])
                html, final = self.get_html(href)
                return html, final

        return None
