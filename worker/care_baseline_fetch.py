# -*- coding: utf-8 -*-
"""care_baseline_fetch.py — lấy dữ liệu chăm sóc/lường cơ bản.

Luồng nghiệp vụ theo yêu cầu:
  - Dùng config riêng gồm nhiều tài khoản. Sau đăng nhập đọc tên khoa thật từ giao diện EMR.
  - Đăng nhập EMR → Điều trị nội trú → trạng thái Đang thực hiện hoặc Hoàn tất.
  - Chọn tối đa N người bệnh/khoa, ưu tiên ngày nhập viện trong khoảng cấu hình.
  - Vào con mắt điều dưỡng → Thông tin chăm sóc.
  - Lấy các cột: Thời gian, Người lập, Diễn biến, Chăm sóc.
  - Lưu CSV riêng dưới care_baseline_store/runs/<run_id>/care_baseline.csv.

File này chủ ý không tự chứa tài khoản thật. Tài khoản đặt ở config/care_baseline.json
(file này bị .gitignore và prepare_release loại khỏi ZIP sạch).
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, date, timedelta
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse, urljoin

from utils import load_config, login_emr, strip_accents
from shared.worker_session import WorkerSession
from shared.text_utils import strip_accents as _strip_accents_shared
try:
    from selenium.webdriver.common.by import By  # type: ignore
    from selenium.webdriver.support.ui import WebDriverWait  # type: ignore
except Exception:  # pragma: no cover
    By = None  # type: ignore
    WebDriverWait = None  # type: ignore

try:
    from selenium_emr_helpers import set_inpatient_status_filter, wait_after_action
except Exception:  # pragma: no cover
    set_inpatient_status_filter = None  # type: ignore
    wait_after_action = None  # type: ignore

try:
    from bs4 import BeautifulSoup
except Exception:  # pragma: no cover
    BeautifulSoup = None  # type: ignore

ROOT_DIR = Path(__file__).resolve().parents[1]
# VERSION TAG — xác nhận file đang chạy (xóa sau khi fix xong)
print("[CARE_BASELINE.FILE_VERSION] v_names_fillup_20260615", flush=True)
DEFAULT_CONFIG_PATH = ROOT_DIR / "config" / "care_baseline.json"
DEFAULT_OUT_ROOT = Path(os.environ.get("EMR_RUNTIME_ROOT") or (ROOT_DIR / ".runtime")) / "care_baseline"

CSV_COLUMNS = [
    "run_id",
    "account_id",
    "account_department",
    "Khoa",
    "Khoa điều trị",
    "Mã BN",
    "Họ tên người bệnh",
    "Ngày vào",
    "Thời gian",
    "Người lập",
    "Diễn biến",
    "Chăm sóc",
]

CARE_INFO_MARKERS = (
    "divDanhSachChamSocContent",
    "onDrawWebpartChamSoc",
    "fnOnSaoChepCSDD",
    "NextPageDDChamSoc",
    "Thông tin chăm sóc",
    "thông tin chăm sóc",
)


def _log(msg: str) -> None:
    print(msg, flush=True)


def _norm_text(value: Any) -> str:
    text = strip_accents(str(value or "")).lower()
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _clean_cell(value: Any) -> str:
    text = str(value or "").replace("\xa0", " ").replace("\u200b", " ")
    return re.sub(r"[ \t\r\f\v]+", " ", text).strip()


def _safe_part(value: Any, fallback: str = "item") -> str:
    text = strip_accents(str(value or "")).lower()
    text = re.sub(r"[^a-z0-9_.-]+", "_", text).strip("_.-")
    return (text or fallback)[:80]


def _today_run_id() -> str:
    return datetime.now().strftime("%Y%m%d_%H%M%S")



def _default_admission_window(days_back: int = 90) -> Tuple[str, str]:
    """Khoảng tìm người bệnh mặc định: khoảng 3 tháng gần nhất."""
    try:
        days = max(1, int(days_back or 90))
    except Exception:
        days = 90
    today = date.today()
    start = today - timedelta(days=days)
    return start.strftime("%Y-%m-%d"), today.strftime("%Y-%m-%d")

def _parse_date_any(value: Any) -> Optional[date]:
    text = str(value or "").strip()
    if not text:
        return None
    # ISO yyyy-mm-dd phải kiểm trước, nếu không regex dd/mm/yyyy sẽ hiểu nhầm 2026 là ngày.
    m_iso = re.search(r"\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b", text)
    if m_iso:
        yy, mm, dd = m_iso.groups()
        try:
            return date(int(yy), int(mm), int(dd))
        except Exception:
            return None
    m = re.search(r"(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})", text)
    if not m:
        return None
    dd, mm, yy = m.groups()
    yyyy = int(yy)
    if yyyy < 100:
        yyyy += 2000
    try:
        return date(yyyy, int(mm), int(dd))
    except Exception:
        return None


def _to_dmy(value: Any) -> str:
    d = _parse_date_any(value)
    return d.strftime("%d/%m/%Y") if d else ""


def _date_in_range(value: Any, start: Any, end: Any) -> bool:
    d = _parse_date_any(value)
    if not d:
        return False
    s = _parse_date_any(start)
    e = _parse_date_any(end)
    if s and d < s:
        return False
    if e and d > e:
        return False
    return True


def _in_care_window(time_text: Any, care_from: Any, care_to: Any) -> bool:
    # Nếu không parse được ngày thì giữ lại để tránh mất dữ liệu; backend/UI có thể lọc sau.
    d = _parse_date_any(time_text)
    if not d:
        return True
    s = _parse_date_any(care_from)
    e = _parse_date_any(care_to)
    return (not s or d >= s) and (not e or d <= e)


def _merge_dicts(*items: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for item in items:
        for key, value in (item or {}).items():
            if value is not None:
                out[key] = value
    return out


def _as_list(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, (list, tuple, set)):
        out: List[str] = []
        for x in value:
            if isinstance(x, dict):
                text = str(x.get("name") or x.get("ho_ten") or x.get("patient_name") or "").strip()
            else:
                text = str(x or "").strip()
            if text:
                out.append(text)
        return out
    text = str(value or "").strip()
    if not text:
        return []
    return [x.strip() for x in re.split(r"[,;|]", text) if x.strip()]



def resolve_status_candidates(value: Any) -> List[str]:
    """Trả về danh sách trạng thái cần thử khi tìm người bệnh.

    UI có thể gửi một trạng thái đơn lẻ hoặc lựa chọn "Đang thực hiện hoặc Hoàn tất".
    Khi chọn cả hai, worker sẽ thử lần lượt Đang thực hiện rồi Hoàn tất.
    """
    raw = str(value or "").strip()
    if not raw:
        return ["Hoàn tất"]
    norm = _norm_text(raw)
    if ("dang thuc hien" in norm and "hoan tat" in norm) or norm in {"both", "all", "tat ca", "tất cả"}:
        return ["Đang thực hiện", "Hoàn tất"]
    parts = [x.strip() for x in re.split(r"[,;|/]+", raw) if x.strip()] or [raw]
    out: List[str] = []
    for part in parts:
        n = _norm_text(part)
        if "dang thuc hien" in n:
            status = "Đang thực hiện"
        elif "hoan tat" in n:
            status = "Hoàn tất"
        else:
            status = part
        if status and status not in out:
            out.append(status)
    return out or ["Hoàn tất"]


def _search_attempt_count(cfg: Dict[str, Any]) -> int:
    try:
        return max(1, min(10, int(cfg.get("search_attempts") or cfg.get("patient_search_attempts") or 3)))
    except Exception:
        return 3

def _keyword_match_text(text: Any, keywords: Iterable[str]) -> bool:
    norm = _norm_text(text)
    for kw in keywords or []:
        if _norm_text(kw) and _norm_text(kw) in norm:
            return True
    return False


def _norm_patient_name(value: Any) -> str:
    text = _norm_text(value)
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _target_name_rank(name: Any, target_names: Iterable[str]) -> Optional[int]:
    norm_name = _norm_patient_name(name)
    if not norm_name:
        return None
    for idx, target in enumerate(_as_list(target_names)):
        norm_target = _norm_patient_name(target)
        if not norm_target:
            continue
        if norm_name == norm_target or norm_target in norm_name or norm_name in norm_target:
            return idx
    return None


def _extract_room_department_cell(cells: List[str]) -> str:
    for c in cells:
        n = _norm_text(c)
        if "phong benh" in n or "khoa " in n or n.startswith("phong "):
            return c
    return ""


def load_task_config(path: Optional[str]) -> Dict[str, Any]:
    cfg_path = Path(path or os.environ.get("CARE_BASELINE_CONFIG") or DEFAULT_CONFIG_PATH)
    if not cfg_path.exists():
        raise RuntimeError(
            f"Chưa có cấu hình lường cơ bản: {cfg_path}. "
            "Hãy copy config/care_baseline.example.json thành config/care_baseline.json rồi điền tài khoản."
        )
    with cfg_path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise RuntimeError("care_baseline.json phải là object JSON.")
    accounts = data.get("accounts") or []
    if not isinstance(accounts, list) or not accounts:
        raise RuntimeError("care_baseline.json chưa có accounts.")
    return data


def effective_account_config(base_config: Dict[str, Any], task_default: Dict[str, Any], account: Dict[str, Any]) -> Dict[str, Any]:
    merged = _merge_dicts(base_config, task_default, account)
    # Tên field login_emr cần là username/password/url_login.
    for k in ("username", "password", "url_login"):
        merged[k] = str(merged.get(k) or "").strip()
    merged["url_inpatient_list"] = str(merged.get("url_inpatient_list") or base_config.get("url_inpatient_list") or "").strip()
    # department chỉ là nhãn gợi ý trong config; khoa chính thức sẽ đọc lại từ EMR sau đăng nhập.
    merged["department_hint"] = str(account.get("department") or account.get("department_hint") or merged.get("department") or "").strip()
    merged["department"] = merged["department_hint"]
    # Lọc dòng người bệnh theo cột phòng/khoa trên danh sách nội trú.
    # Ví dụ khoa Tim mạch can thiệp thường hiện "Phòng bệnh khoa TMCT - ...".
    merged["patient_room_keywords"] = _as_list(
        account.get("patient_room_keywords")
        or account.get("room_keywords")
        or account.get("ward_keywords")
        or merged.get("patient_room_keywords")
    )
    # Nếu cấu hình danh sách tên BN đích, worker sẽ chỉ chọn đúng các tên này,
    # giữ thứ tự trong config và bỏ qua ưu tiên ngày nhập viện.
    merged["target_patient_names"] = _as_list(
        account.get("patient_names")
        or account.get("patients")
        or account.get("target_patient_names")
        or account.get("target_names")
        or merged.get("patient_names")
        or merged.get("target_patient_names")
    )
    # Nếu account/khoa chưa khai báo tên BN thì tự động chọn bệnh nhân từ danh sách nội trú.
    # Mặc định chọn 5 người, vẫn tôn trọng lọc phòng/khoa và khoảng 3 tháng/trạng thái cấu hình.
    explicit_mode = str(account.get("patient_selection_mode") or merged.get("patient_selection_mode") or "").strip().lower()
    if explicit_mode in {"named", "names", "patient_names"}:
        merged["patient_selection_mode"] = "named"
    elif explicit_mode in {"auto", "automatic", "first", "top"}:
        merged["patient_selection_mode"] = "auto"
        merged["target_patient_names"] = []
    else:
        merged["patient_selection_mode"] = "named" if merged["target_patient_names"] else "auto"
    merged["account_id"] = str(account.get("id") or account.get("username") or merged.get("department_hint") or "account").strip()
    # Tên khoa cần chọn từ dropdown drpSelectKhoaPhong trước khi lấy danh sách BN.
    merged["ward_select"] = str(
        account.get("ward_select") or account.get("khoa_chon") or
        merged.get("ward_select") or ""
    ).strip()
    return merged


def _upsert_query(url: str, **kwargs: Any) -> str:
    p = urlparse(url or "")
    q = dict(parse_qsl(p.query, keep_blank_values=True))
    for k, v in kwargs.items():
        if v is not None and str(v) != "":
            q[k] = str(v)
    return urlunparse((p.scheme, p.netloc, p.path, p.params, urlencode(q), p.fragment))


def _absolute_url(base_url: str, maybe_url: str) -> str:
    text = str(maybe_url or "").strip()
    if not text:
        return ""
    if re.match(r"^[a-z][a-z0-9+.-]*://", text, flags=re.I):
        return text
    return urljoin(base_url or "", text)


def _build_inpatient_url_after_login(current_url: str, cfg: Dict[str, Any]) -> str:
    configured = str(cfg.get("url_inpatient_list") or "").strip()
    source = current_url or configured
    p_src = urlparse(source)
    p_cfg = urlparse(configured) if configured else p_src
    q = dict(parse_qsl(p_src.query, keep_blank_values=True))
    q_cfg = dict(parse_qsl(p_cfg.query, keep_blank_values=True))
    for k in ("scope", "lang", "role"):
        if k in q_cfg and k not in q:
            q[k] = q_cfg[k]
    q["wpid"] = str(cfg.get("inpatient_wpid") or q_cfg.get("wpid") or "danhsachdieutrinoitrudraw")
    scheme = p_src.scheme or p_cfg.scheme
    netloc = p_src.netloc or p_cfg.netloc
    path = p_cfg.path or p_src.path or "/home.aspx"
    return urlunparse((scheme, netloc, path, "", urlencode(q), ""))


def _safe_get(driver: Any, url: str) -> None:
    try:
        driver.set_page_load_timeout(int(os.environ.get("SELENIUM_PAGE_LOAD_TIMEOUT", "25")))
    except Exception:
        pass
    try:
        driver.get(url)
    except Exception:
        try:
            driver.execute_script("window.stop();")
        except Exception:
            pass
    if wait_after_action:
        wait_after_action(driver, 0.5, ready_timeout=8)
    else:
        time.sleep(0.7)



def _select_inpatient_ward(driver: Any, ward_name: str, log_func: Any = None) -> bool:
    """Chọn đúng khoa/đơn vị từ dropdown drpSelectKhoaPhong trên trang danh sách nội trú.

    EMR có dropdown #drpSelectKhoaPhong với các option là tên khoa/đơn vị.
    Hàm này tìm option khớp tên (normalize, không phân biệt hoa thường) rồi chọn
    và trigger onchange để reload danh sách BN.
    """
    if not ward_name:
        return False
    try:
        result = driver.execute_script(r"""
            const target = arguments[0].toLowerCase().replace(/\s+/g,' ').trim();
            const sel = document.getElementById('drpSelectKhoaPhong');
            if (!sel) return {ok: false, reason: 'no_select'};
            const opts = Array.from(sel.options);
            // Tìm option khớp chính xác hoặc chứa chuỗi target
            let found = opts.find(o => o.text.toLowerCase().replace(/\s+/g,' ').trim() === target);
            if (!found) found = opts.find(o => o.text.toLowerCase().replace(/\s+/g,' ').trim().includes(target));
            if (!found) found = opts.find(o => target.includes(o.text.toLowerCase().replace(/\s+/g,' ').trim()) && o.text.length > 3);
            if (!found) return {ok: false, reason: 'not_found',
                available: opts.slice(0,10).map(o => o.text.trim())};
            sel.value = found.value;
            // Trigger onchange để EMR reload danh sách
            try { sel.dispatchEvent(new Event('change', {bubbles: true})); } catch(e) {}
            try {
                const fn = sel.getAttribute('onchange');
                if (fn && fn.includes('onKhoaPhongChange')) {
                    window.onKhoaPhongChange && window.onKhoaPhongChange(found.value);
                }
            } catch(e) {}
            // Trigger select2 change nếu dùng select2
            try {
                if (window.jQuery && window.jQuery(sel).data('select2')) {
                    window.jQuery(sel).val(found.value).trigger('change');
                }
            } catch(e) {}
            return {ok: true, value: found.value, text: found.text.trim()};
        """, ward_name) or {}
        ok = bool(result.get('ok') if isinstance(result, dict) else result)
        if log_func:
            if ok:
                log_func(f"[CARE_BASELINE.WARD_SELECT] ward={ward_name} matched={result.get('text')} value={result.get('value')}")
            else:
                log_func(f"[CARE_BASELINE.WARD_SELECT_FAIL] ward={ward_name} reason={result.get('reason')} available={result.get('available')}")
        return ok
    except Exception as exc:
        if log_func:
            log_func(f"[CARE_BASELINE.WARD_SELECT_ERR] ward={ward_name} err={exc}")
        return False


def _inpatient_search_url_variants(inpatient_url: str, term: Any) -> List[str]:
    """Các biến thể URL tìm BN; EMR mỗi màn hình có thể đọc keyword khác nhau."""
    text = str(term or "").strip()
    if not text:
        return [inpatient_url]
    keys = ["keyword", "txtTimKiem", "timkiem", "search", "q", "ma_bn", "hoten"]
    out: List[str] = []
    seen = set()
    for key in keys:
        url = _upsert_query(inpatient_url, **{key: text})
        if url not in seen:
            seen.add(url)
            out.append(url)
    return out or [inpatient_url]


def _submit_inpatient_search(driver: Any, wait: Any, term: Any, *, log_func: Any = None) -> bool:
    """Nhập từ khóa và bấm nút Tìm trên D/s Điều trị nội trú.

    Trước đây worker chỉ gắn keyword lên URL rồi đọc HTML, nhưng nhiều màn hình EMR
    không reload danh sách nếu không bấm nút Tìm hoặc gọi hàm JS tìm kiếm.
    """
    if By is None:
        return False
    text = str(term or "").strip()
    clicked = False
    input_touched = False
    try:
        input_touched = bool(driver.execute_script(
            r"""
            const value = arguments[0];
            const norm = s => String(s || '').toLowerCase();
            const selectors = [
              '#txtTimKiem', '#txtTimKiemBN', '#txtTuKhoa', '#txtSearch', '#keyword',
              'input[name="keyword"]', 'input[name="txtTimKiem"]', 'input[name="timkiem"]',
              'input[placeholder*="Tìm"]', 'input[placeholder*="tìm"]',
              'input[placeholder*="Tìm kiếm"]', 'input[placeholder*="tìm kiếm"]',
              'input[type="search"]'
            ];
            let el = null;
            for (const sel of selectors) {
              try { el = document.querySelector(sel); } catch(e) { el = null; }
              if (el) break;
            }
            if (!el) {
              const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
              el = inputs.find(x => {
                const id = norm(x.id), name = norm(x.name), ph = norm(x.placeholder);
                return id.includes('tim') || id.includes('search') || id.includes('keyword') ||
                       name.includes('tim') || name.includes('search') || name.includes('keyword') ||
                       ph.includes('tìm') || ph.includes('tim') || ph.includes('search');
              }) || inputs[0] || null;
            }
            if (!el) return false;
            try { el.focus(); } catch(e) {}
            el.value = value;
            try { el.dispatchEvent(new Event('input', {bubbles:true})); } catch(e) {}
            try { el.dispatchEvent(new Event('change', {bubbles:true})); } catch(e) {}
            try { el.dispatchEvent(new KeyboardEvent('keyup', {key:'Enter', keyCode:13, which:13, bubbles:true})); } catch(e) {}
            return true;
            """,
            text,
        ))
    except Exception:
        input_touched = False

    # Ưu tiên bấm nút có chữ Tìm/Tìm kiếm hoặc onclick liên quan load danh sách nội trú.
    try:
        clicked = bool(driver.execute_script(
            r"""
            const norm = s => String(s || '').replace(/\s+/g,' ').trim().toLowerCase();
            const isVisible = el => {
              const st = window.getComputedStyle(el);
              const r = el.getBoundingClientRect();
              return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0;
            };
            const nodes = Array.from(document.querySelectorAll('button,a,input[type="button"],input[type="submit"]'));
            const candidates = nodes.filter(el => {
              if (!isVisible(el)) return false;
              const text = norm(el.innerText || el.value || el.textContent || '');
              const oc = norm(el.getAttribute('onclick') || '');
              const id = norm(el.id || '');
              const cls = norm(el.className || '');
              if (text === 'tìm' || text === 'tim' || text.includes('tìm kiếm') || text.includes('tim kiem')) return true;
              if ((oc.includes('load') || oc.includes('search') || oc.includes('tim')) && (oc.includes('noitru') || oc.includes('dieutri') || oc.includes('list'))) return true;
              if (id.includes('tim') || id.includes('search') || cls.includes('search')) return true;
              return false;
            });
            const el = candidates.find(x => ['BUTTON','INPUT'].includes(x.tagName)) || candidates[0];
            if (!el) return false;
            try { el.scrollIntoView({block:'center', inline:'center'}); } catch(e) {}
            try { el.click(); return true; } catch(e) {}
            try { el.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, view:window})); return true; } catch(e) {}
            return false;
            """
        ))
    except Exception:
        clicked = False

    # Fallback: gọi các hàm JS thường gặp trong màn hình D/s Điều trị nội trú.
    if not clicked:
        try:
            clicked = bool(driver.execute_script(
                r"""
                const names = [
                  'loadListDieuTriNoiTru', 'LoadListDieuTriNoiTru',
                  'loadDanhSachDieuTriNoiTru', 'LoadDanhSachDieuTriNoiTru',
                  'loadListNoiTru', 'LoadListNoiTru', 'loadListBenhNhan',
                  'loadList', 'LoadList', 'search', 'Search'
                ];
                for (const name of names) {
                  try {
                    if (typeof window[name] === 'function') { window[name](); return true; }
                  } catch(e) {}
                }
                return false;
                """
            ))
        except Exception:
            clicked = False

    if clicked or input_touched:
        if wait_after_action:
            wait_after_action(driver, 1.0, ready_timeout=12)
        else:
            time.sleep(1.2)
    if log_func:
        log_func(f"[CARE_BASELINE.PATIENT_SEARCH_SUBMIT] term={text} input={1 if input_touched else 0} clicked={1 if clicked else 0}")
    return bool(clicked or input_touched)

def _clean_department_text(value: Any) -> str:
    text = _clean_cell(value)
    text = re.sub(r"\bcaret\b", "", text, flags=re.I)
    text = text.replace("▼", " ").replace("▾", " ").replace("▴", " ")
    text = re.sub(r"\s+", " ", text).strip(" -–—\t\r\n")
    return text


def extract_logged_in_department_from_html(html: str) -> str:
    """Đọc tên khoa đang đăng nhập từ header EMR."""
    if BeautifulSoup is None:
        return ""
    soup = BeautifulSoup(html or "", "html.parser")
    candidates = []
    for span in soup.select("span.text-muted.text-xs.block"):
        txt = _clean_department_text(span.get_text(" ", strip=True))
        if txt:
            candidates.append(txt)
    for txt in candidates:
        if "khoa" in _norm_text(txt):
            return txt
    for txt in candidates:
        if len(txt) >= 3:
            return txt
    return ""


def extract_logged_in_department(driver: Any) -> str:
    """Đọc khoa thật sau đăng nhập; fallback parse page_source nếu JS không chạy."""
    try:
        text = driver.execute_script(
            r"""
            const clean = s => String(s || '').replace(/\s+/g, ' ').replace(/\bcaret\b/ig, '').trim();
            const spans = Array.from(document.querySelectorAll('span.text-muted.text-xs.block'));
            const values = spans.map(s => clean(s.textContent)).filter(Boolean);
            return values.find(v => v.toLowerCase().includes('khoa')) || values[0] || '';
            """
        )
        text = _clean_department_text(text)
        if text:
            return text
    except Exception:
        pass
    return extract_logged_in_department_from_html(getattr(driver, "page_source", "") or "")


@dataclass
class PatientCandidate:
    row_index: int
    ma_bn: str
    ho_ten: str
    khoa: str
    ngay_vao: str
    priority: int
    href_nursing: str = ""


def _extract_admission_date(text: str) -> str:
    # Ưu tiên chuỗi cạnh "Ngày vào"; fallback ngày đầu tiên trong dòng.
    m = re.search(r"ngày\s*vào\s*[:：]?\s*(?:\d{1,2}:\d{2}\s*)?(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})", text, flags=re.I)
    if m:
        return _to_dmy(m.group(1))
    m = re.search(r"(?:\d{1,2}:\d{2}\s*)?(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})", text)
    return _to_dmy(m.group(1)) if m else ""


def _looks_like_patient_name(text: str) -> bool:
    n = _norm_text(text)
    if not n or len(n) < 5:
        return False
    if re.fullmatch(r"[\d:/\-\s]+", text.strip()):
        return False
    bad = {
        "nam", "nu", "nữ", "dang thuc hien", "di mo", "hoan tat", "bao hiem",
        "xem", "xem kq", "sua", "sửa", "sao", "xoa", "xóa"
    }
    return n not in bad and any(ch.isalpha() for ch in n)


def _extract_patient_name_from_name_cell(cell: Any) -> str:
    """Lấy đúng tên BN từ cột Họ tên trong bảng nội trú.

    HTML thực tế có nhiều link trước cột tên (STT, T/G vào, KQ). Nếu dò tất cả
    link theo thứ tự rất dễ nhầm "Xem KQ" thành tên BN. Vì vậy ưu tiên cột
    Họ tên, link id=btna..., rồi lấy dòng đầu trước ghi chú phòng/khoa.
    """
    if cell is None:
        return ""
    try:
        for a in cell.find_all("a"):
            aid = str(a.get("id") or "")
            txt = _clean_cell(a.get_text("\n", strip=True))
            if aid.startswith("btna") and txt:
                lines = [_clean_cell(x) for x in re.split(r"[\r\n]+", txt) if _clean_cell(x)]
                for line in lines:
                    if _looks_like_patient_name(line) and not _norm_text(line).startswith(("pm:", "pt:", "phong", "phòng")):
                        return line
        raw = cell.get_text("\n", strip=True)
    except Exception:
        raw = str(cell or "")
    lines = [_clean_cell(x) for x in re.split(r"[\r\n]+", raw) if _clean_cell(x)]
    for line in lines:
        n = _norm_text(line)
        if n.startswith(("pm:", "pt:", "phong", "phòng", "- pm", "- pt")):
            continue
        if _looks_like_patient_name(line):
            return line
    # Fallback: cắt ghi chú sau dấu gạch nếu có.
    txt = _clean_cell(raw)
    txt = re.split(r"\s+-\s+(?:PM|PT|P|T)\s*:", txt, maxsplit=1, flags=re.I)[0].strip()
    return txt if _looks_like_patient_name(txt) else ""


def _extract_nursing_href_from_row(tr: Any, cells_tags: Optional[List[Any]] = None) -> str:
    """Lấy href cột ĐD/mắt điều dưỡng, ưu tiên cột thứ 3 của tblNoiTru."""
    try:
        if cells_tags and len(cells_tags) >= 3:
            for a in cells_tags[2].find_all("a"):
                href = str(a.get("href") or "").strip()
                html = str(a).lower()
                if href and ("wpid=dieuduongdraw" in href.lower() or "fa-eye" in html):
                    return href
        for a in tr.find_all("a"):
            href = str(a.get("href") or "").strip()
            inner = str(a).lower()
            if href and ("wpid=dieuduongdraw" in href.lower() or "fa-eye" in inner):
                return href
    except Exception:
        return ""
    return ""


def collect_patient_candidates_from_html(
    html: str,
    admission_from: Any = "",
    admission_to: Any = "",
    limit: int = 5,
    patient_room_keywords: Optional[Iterable[str]] = None,
    target_patient_names: Optional[Iterable[str]] = None,
) -> List[Dict[str, Any]]:
    """Parse danh sách nội trú để chọn tối đa limit BN.

    Nếu có target_patient_names, chỉ chọn đúng các tên trong danh sách đó,
    ưu tiên theo thứ tự cấu hình và không xét ưu tiên ngày nhập viện.
    Hàm được test độc lập; Selenium runtime sẽ dùng thêm element thật để click.
    """
    if BeautifulSoup is None:
        return []
    soup = BeautifulSoup(html or "", "html.parser")
    rows = soup.select("table tbody tr") or soup.select("tr")
    out: List[PatientCandidate] = []
    target_names = _as_list(target_patient_names)
    for idx, tr in enumerate(rows):
        cells_tags = tr.find_all("td")
        cells = [_clean_cell(td.get_text(" ", strip=True)) for td in cells_tags]
        row_text = _clean_cell(" ".join(cells))
        if not row_text or len(cells) < 2:
            continue
        room_department = _extract_room_department_cell(cells)
        room_keywords = _as_list(patient_room_keywords)
        if room_keywords and not (_keyword_match_text(room_department, room_keywords) or _keyword_match_text(row_text, room_keywords)):
            continue
        href_nursing = _extract_nursing_href_from_row(tr, cells_tags)

        # tblNoiTru thực tế có cột cố định: STT, T/G vào, ĐD, KQ, B-G, Mã BN, Họ tên.
        # Ưu tiên đọc theo cột để không nhầm "Xem KQ" hoặc link ngày vào thành tên BN.
        ma_bn = ""
        ho_ten = ""
        ngay_vao = ""
        try:
            if len(cells_tags) >= 7:
                ngay_vao = _extract_admission_date(cells[1]) or _to_dmy(cells[1])
                m_code_col = re.search(r"\b(\d{6,10})\b", cells[5])
                ma_bn = m_code_col.group(1) if m_code_col else ""
                ho_ten = _extract_patient_name_from_name_cell(cells_tags[6])
        except Exception:
            pass

        if not ma_bn:
            m_code = re.search(r"\b(\d{6,10})\b", row_text)
            ma_bn = m_code.group(1) if m_code else ""
        if not ho_ten:
            # Tên BN: ưu tiên link id=btna..., sau đó fallback cell có chữ.
            for a in tr.find_all("a"):
                aid = str(a.get("id") or "")
                txt = _clean_cell(a.get_text(" ", strip=True))
                if aid.startswith("btna") and _looks_like_patient_name(txt):
                    ho_ten = txt
                    break
            if not ho_ten:
                for c in cells:
                    n = _norm_text(c)
                    if _looks_like_patient_name(c) and not re.search(r"khoa|phòng|buồng|giường|trạng thái|xem kq", n):
                        ho_ten = c
                        break
        if not ngay_vao:
            ngay_vao = _extract_admission_date(row_text)
        if target_names:
            rank = _target_name_rank(ho_ten, target_names)
            if rank is None:
                continue
            priority = rank
        else:
            priority = 0 if _date_in_range(ngay_vao, admission_from, admission_to) else 1
        if not (ma_bn or ho_ten or href_nursing):
            continue
        out.append(PatientCandidate(idx, ma_bn, ho_ten, room_department, ngay_vao, priority, href_nursing))
    out.sort(key=lambda p: (p.priority, p.row_index))
    return [p.__dict__ for p in out[: max(1, int(limit or 5))]]


def _candidate_key(c: Dict[str, Any]) -> str:
    return str(c.get("ma_bn") or c.get("ho_ten") or c.get("row_index") or "")


def collect_patient_candidates(driver: Any, cfg: Dict[str, Any]) -> List[Dict[str, Any]]:
    html = getattr(driver, "page_source", "") or ""
    limit = int(cfg.get("patient_limit_per_account") or 5)
    target_names = _as_list(cfg.get("target_patient_names") or [])
    scan_limit = max(limit * 3, limit, len(target_names) * 3 if target_names else 0)
    candidates = collect_patient_candidates_from_html(
        html,
        admission_from=cfg.get("admission_from") or "",
        admission_to=cfg.get("admission_to") or "",
        limit=scan_limit,
        patient_room_keywords=cfg.get("patient_room_keywords") or [],
        target_patient_names=target_names,
    )
    # Chặn trùng theo mã/tên, rồi lấy limit.
    seen = set()
    deduped = []
    base_url = getattr(driver, "current_url", "") or ""
    for c in candidates:
        k = _candidate_key(c)
        if not k or k in seen:
            continue
        if c.get("href_nursing"):
            c["href_nursing"] = _absolute_url(base_url, c.get("href_nursing") or "")
        seen.add(k)
        deduped.append(c)
        if len(deduped) >= limit:
            break
    return deduped


def find_named_patient_candidate_by_search(
    driver: Any,
    wait: Any,
    inpatient_url: str,
    cfg: Dict[str, Any],
    target: str,
    status: str,
    log_func: Any = None,
) -> Optional[Dict[str, Any]]:
    """Tìm đúng một tên BN và trả về ngay candidate đầu tiên tìm thấy.

    Mỗi trạng thái chỉ bấm Tìm đúng 1 lần. Khi thấy BN thì trả ngay để caller
    mở mắt điều dưỡng và lấy Thông tin chăm sóc, không tiếp tục tìm các tên khác.
    """
    target = str(target or "").strip()
    if not target:
        return None
    statuses = resolve_status_candidates(status)
    total_submits = 0
    for current_status in statuses:
        if log_func:
            log_func(f"[CARE_BASELINE.PATIENT_NAMED_SEARCH_ATTEMPT] name={target} status={current_status} attempt=1/1")
        try:
            _safe_get(driver, inpatient_url)
            if set_inpatient_status_filter:
                set_inpatient_status_filter(driver, wait, current_status, log_func=log_func or _log)
        except Exception:
            pass
        submitted = _submit_inpatient_search(driver, wait, target, log_func=log_func or _log)
        total_submits += 1
        if not submitted and log_func:
            log_func(f"[CARE_BASELINE.PATIENT_SEARCH_SUBMIT_FAIL] name={target} status={current_status} term={target}")
        if wait_after_action:
            wait_after_action(driver, 1.0, ready_timeout=12)
        else:
            time.sleep(1.2)
        base_url = getattr(driver, "current_url", "") or inpatient_url
        rows = collect_patient_candidates_from_html(
            getattr(driver, "page_source", "") or "",
            admission_from=cfg.get("admission_from") or "",
            admission_to=cfg.get("admission_to") or "",
            limit=5,
            patient_room_keywords=cfg.get("patient_room_keywords") or [],
            target_patient_names=[target],
        )
        if not rows:
            continue
        cand = rows[0]
        if cand.get("href_nursing"):
            cand["href_nursing"] = _absolute_url(base_url, cand.get("href_nursing") or "")
        cand["_inpatient_status"] = current_status
        cand["_search_attempt"] = 1
        cand["_search_submits"] = total_submits
        cand["_target_name"] = target
        if log_func:
            log_func(
                f"[CARE_BASELINE.PATIENT_NAMED_SEARCH_FOUND] name={target} "
                f"status={current_status} submits={total_submits} ma_bn={cand.get('ma_bn') or ''} "
                f"href_nursing={1 if cand.get('href_nursing') else 0} action=open_now"
            )
        return cand
    if log_func:
        log_func(f"[CARE_BASELINE.PATIENT_NAMED_SEARCH_MISS] name={target} statuses={','.join(statuses)} submits={total_submits} action=skip")
    return None


def collect_named_patient_candidates_by_search(
    driver: Any,
    wait: Any,
    inpatient_url: str,
    cfg: Dict[str, Any],
    status: str,
    log_func: Any = None,
) -> List[Dict[str, Any]]:
    """Tìm từng tên BN bằng ô tìm kiếm thật.

    Hàm này vẫn trả về danh sách để phục vụ test/luồng cũ. Luồng chạy chính
    hiện dùng find_named_patient_candidate_by_search() để tìm thấy ca nào thì
    mở mắt điều dưỡng và lấy dữ liệu ca đó ngay.
    """
    limit = int(cfg.get("patient_limit_per_account") or 5)
    target_names = _as_list(cfg.get("target_patient_names") or [])
    if not target_names:
        return collect_patient_candidates(driver, cfg)
    selected: List[Dict[str, Any]] = []
    seen = set()
    for target in target_names:
        if len(selected) >= limit:
            break
        cand = find_named_patient_candidate_by_search(driver, wait, inpatient_url, cfg, target, status, log_func=log_func)
        if not cand:
            continue
        k = _candidate_key(cand)
        if k and k not in seen:
            seen.add(k)
            selected.append(cand)
    try:
        _safe_get(driver, inpatient_url)
        statuses = resolve_status_candidates(status)
        if set_inpatient_status_filter:
            set_inpatient_status_filter(driver, wait, statuses[0], log_func=log_func or _log)
    except Exception:
        pass
    return selected

def collect_auto_patient_candidates_with_status_retry(
    driver: Any,
    wait: Any,
    inpatient_url: str,
    cfg: Dict[str, Any],
    status: str,
    log_func: Any = None,
) -> List[Dict[str, Any]]:
    """Tự chọn BN khi chưa cấu hình tên, thử Đang thực hiện/Hoàn tất và retry."""
    limit = int(cfg.get("patient_limit_per_account") or 5)
    statuses = resolve_status_candidates(status)
    attempts = _search_attempt_count(cfg)
    selected: List[Dict[str, Any]] = []
    seen = set()
    for attempt in range(1, attempts + 1):
        for current_status in statuses:
            if len(selected) >= limit:
                return selected[:limit]
            try:
                _safe_get(driver, inpatient_url)
                if set_inpatient_status_filter:
                    set_inpatient_status_filter(driver, wait, current_status, log_func=log_func or _log)
                _submit_inpatient_search(driver, wait, "", log_func=log_func or _log)
                if wait_after_action:
                    wait_after_action(driver, 0.5, ready_timeout=8)
            except Exception:
                pass
            cfg2 = {**cfg, "patient_limit_per_account": max(limit * 3, limit)}
            rows = collect_patient_candidates(driver, cfg2)
            for cand in rows:
                k = _candidate_key(cand)
                if not k or k in seen:
                    continue
                cand["_inpatient_status"] = current_status
                cand["_search_attempt"] = attempt
                seen.add(k)
                selected.append(cand)
                if len(selected) >= limit:
                    break
            if log_func:
                log_func(
                    f"[CARE_BASELINE.PATIENT_SELECT_AUTO_ATTEMPT] status={current_status} "
                    f"attempt={attempt}/{attempts} found={len(rows)} selected={len(selected)}"
                )
        if len(selected) >= limit:
            break
    if not selected and log_func:
        log_func(f"[CARE_BASELINE.PATIENT_SELECT_AUTO_EMPTY] attempts={attempts} statuses={','.join(statuses)} action=skip")
    return selected[:limit]

def _find_row_for_candidate(driver: Any, cand: Dict[str, Any]) -> Any:
    if By is None:
        raise RuntimeError("Selenium không khả dụng.")
    code = str(cand.get("ma_bn") or "").strip()
    name = str(cand.get("ho_ten") or "").strip()
    xps = []
    if code:
        xps.extend([
            f"//table[@id='tblNoiTru']//tbody//tr[.//*[contains(normalize-space(), '{code}')]]",
            f"//table[contains(@id,'NoiTru')]//tr[.//*[contains(normalize-space(), '{code}')]]",
            f"//tr[.//*[contains(normalize-space(), '{code}')]]",
        ])
    if name:
        # Dùng contains đơn giản; tên lấy từ DOM nên ít chứa dấu nháy. Nếu có nháy, bỏ qua XPath này.
        if "'" not in name:
            xps.append(f"//tr[.//*[contains(normalize-space(), '{name}')]]")
    for xp in xps:
        try:
            rows = driver.find_elements(By.XPATH, xp)
            if rows:
                return rows[0]
        except Exception:
            continue
    raise RuntimeError(f"Không tìm thấy lại dòng BN để mở mắt điều dưỡng: {code or name}")


def _open_nursing_eye(driver: Any, cand: Dict[str, Any], log_func: Any = None) -> bool:
    href = str(cand.get("href_nursing") or "").strip()
    patient = cand.get("ma_bn") or cand.get("ho_ten") or ""
    if href:
        url = _absolute_url(getattr(driver, "current_url", "") or "", href)
        if log_func:
            log_func(f"[CARE_BASELINE.NURSING_EYE_OPEN] patient={patient} method=href href=1")
        _safe_get(driver, url)
        if wait_after_action:
            wait_after_action(driver, 1.0, ready_timeout=12)
        else:
            time.sleep(1.2)
        return True
    row = _find_row_for_candidate(driver, cand)
    anchors = row.find_elements(By.XPATH, ".//a[@href]")
    for a in anchors:
        href = (a.get_attribute("href") or "").strip()
        html = (a.get_attribute("innerHTML") or "").lower()
        if "wpid=dieuduongdraw" in href.lower() or "fa-eye" in html:
            if log_func:
                log_func(f"[CARE_BASELINE.NURSING_EYE_OPEN] patient={patient} method=click href={1 if href else 0}")
            try:
                driver.execute_script("arguments[0].scrollIntoView({block:'center'}); arguments[0].click();", a)
            except Exception:
                a.click()
            if wait_after_action:
                wait_after_action(driver, 1.0, ready_timeout=12)
            else:
                time.sleep(1.2)
            return True
    raise RuntimeError("Không tìm thấy con mắt điều dưỡng trong dòng BN.")


def _has_care_info_content(driver: Any) -> bool:
    """Đã thật sự vào màn hình danh sách Thông tin chăm sóc, không chỉ thấy menu.

    Quan sát từ HTML thật của EMR:
    - Khi mới vào mắt điều dưỡng: menu "Thông tin chăm sóc" KHÔNG có màu nền.
    - Sau khi click vào "Thông tin chăm sóc": li cha đổi thành style="background-color: rgb(51, 122, 183)"
      VÀ nội dung bảng được load vào vùng content bên phải qua AJAX.
    - EMR có thể KHÔNG dùng divDanhSachChamSocContent — nội dung inject vào div khác.
    - loadListTTCS, "Thời gian", "Diễn biến", "Chăm sóc" đều có trong menu trái → KHÔNG dùng làm điều kiện.

    Hàm này dùng JS để kiểm tra DOM thật thay vì page_source để tránh race condition.
    Trả True khi:
      1. divDanhSachChamSocContent tồn tại VÀ không rỗng, hoặc
      2. Bảng footable có thead với cột Thời gian + hàng dữ liệu, hoặc
      3. Các marker AJAX-rendered: onDrawWebpartChamSoc, fnOnSaoChepCSDD, NextPageDDChamSoc
         (những chuỗi này KHÔNG có trong menu, chỉ có trong nội dung bảng đã render)
    """
    try:
        result = driver.execute_script("""
            // Kiểm tra 1: divDanhSachChamSocContent có nội dung không
            const div = document.getElementById('divDanhSachChamSocContent');
            if (div && div.innerHTML && div.innerHTML.trim().length > 50) return 'div_has_content';

            // Kiểm tra 2: bảng footable đã có dữ liệu (thead + tbody có tr)
            const tables = Array.from(document.querySelectorAll('table.footable, table[class*="table-striped"]'));
            for (const t of tables) {
                const ths = Array.from(t.querySelectorAll('th')).map(th => (th.innerText || '').trim().toLowerCase());
                const hasTimeCol = ths.some(h => h.includes('thời gian') || h.includes('thoi gian') || h === 'tg');
                const hasCareCol = ths.some(h => h.includes('chăm sóc') || h.includes('cham soc'));
                if (hasTimeCol && hasCareCol) {
                    const rows = t.querySelectorAll('tbody tr');
                    if (rows.length > 0) return 'table_has_rows';
                }
            }

            // Lưu ý: onDrawWebpartChamSoc/fnOnSaoChepCSDD/NextPageDDChamSoc có thể xuất hiện
            // trong script inline của trang mắt điều dưỡng → KHÔNG dùng làm điều kiện.
            return false;
        """)
        return bool(result)
    except Exception:
        # Fallback về page_source nếu JS lỗi
        html = getattr(driver, "page_source", "") or ""
        low = html.lower()
        if "divdanhsachchamsoccontent" in low:
            return True
        return bool(
            ("ondrawwebpartchamsoc" in low or "fnonsaochepcsdd" in low or "nextpageddchamsoc" in low)
            and ("thời gian" in low or "thoi gian" in _norm_text(low))
            and ("diễn biến" in low or "dien bien" in _norm_text(low))
        )


def _wait_for_care_info_content(driver: Any, timeout: float = 15.0) -> bool:
    deadline = time.time() + float(timeout or 0)
    while time.time() < deadline:
        if _has_care_info_content(driver):
            return True
        time.sleep(0.35)
    return _has_care_info_content(driver)


def _wait_processing_cham_soc_done(driver: Any, timeout: float = 8.0) -> None:
    deadline = time.time() + float(timeout or 0)
    while time.time() < deadline:
        try:
            display = driver.execute_script(
                """
                const el = document.getElementById('divProcessingChamSoc');
                if (!el) return 'missing';
                return getComputedStyle(el).display || el.style.display || '';
                """
            )
            if str(display or "").strip().lower() in {"none", "", "missing"}:
                return
        except Exception:
            return
        time.sleep(0.25)


def _open_cham_soc_group(driver: Any) -> None:
    """Mở nhóm menu Chăm sóc giống cách các worker nhập chăm sóc/VTYT đang làm."""
    try:
        driver.execute_script(
            r"""
            const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
            const anchors = Array.from(document.querySelectorAll('a'));
            let header = anchors.find(a => /^Chăm sóc$/i.test(norm(a.innerText || a.textContent)));
            if (!header) header = anchors.find(a => /chăm sóc/i.test(norm(a.innerText || a.textContent)) && (a.closest('li.has-subnav') || a.closest('li')));
            if (!header) return false;
            const li = header.closest('li.has-subnav') || header.closest('li');
            if (!li) return false;
            const ul = li.querySelector('ul,.submenu,.collapse');
            const wrap = li.querySelector('.accordion-btn-wrap,.nav-label') || header;
            li.classList.add('active','selected','open');
            if (ul) {
              ul.style.display = 'block';
              ul.classList.add('show','in');
              ul.removeAttribute('hidden');
            }
            try { if (wrap && ul && getComputedStyle(ul).display === 'none') wrap.click(); } catch(e) {}
            return true;
            """
        )
    except Exception:
        pass


def _click_btnTTCS_thong_tin_cham_soc_exact(driver: Any, log_func: Any = None, timeout: float = 12.0) -> bool:
    """Bấm đúng nút menu EMR sau khi vào con mắt điều dưỡng.

    Luồng chuẩn từ worker nhập chăm sóc cũ là:
      con mắt điều dưỡng → <a id="btnTTCS" onclick="onShowChamSoc(this)">Thông tin chăm sóc</a>

    EMR có nhiều thẻ trùng id="btnTTCS", nên phải lọc đúng onclick onShowChamSoc(this)
    và text đúng "Thông tin chăm sóc", không lấy cấp 1/cấp 2-3/lập kế hoạch/lịch sử.
    """
    deadline = time.time() + float(timeout or 0)
    last_reason = "not_started"
    while time.time() < deadline:
        try:
            result = driver.execute_script(
                r"""
                const norm = s => String(s || '')
                  .replace(/\u00a0/g, ' ')
                  .replace(/\s+/g, ' ')
                  .trim()
                  .toLowerCase();
                const anchors = Array.from(document.querySelectorAll('a#btnTTCS, a[onclick*="onShowChamSoc"]'));
                function isExact(a) {
                  const text = norm(a.innerText || a.textContent || '');
                  const oc = String(a.getAttribute('onclick') || '');
                  const ocl = oc.toLowerCase();
                  if (!/onShowChamSoc\s*\(\s*this\s*\)/i.test(oc)) return false;
                  if (ocl.includes('onshowchamsoccap')) return false;
                  if (text !== 'thông tin chăm sóc' && text !== 'thong tin cham soc') return false;
                  if (text.includes('cấp') || text.includes('cap') || text.includes('lịch sử') || text.includes('lich su') || text.includes('lập kế hoạch') || text.includes('lap ke hoach')) return false;
                  return true;
                }
                const exact = anchors.find(isExact);
                if (!exact) return {ok:false, reason:'btnTTCS_exact_not_found', count: anchors.length};
                try { exact.scrollIntoView({block:'center', inline:'nearest'}); } catch(e) {}
                try {
                  exact.click();
                  return {ok:true, method:'btnTTCS_click', text: norm(exact.innerText || exact.textContent || ''), onclick: exact.getAttribute('onclick') || ''};
                } catch(e1) {
                  try {
                    const ev = new MouseEvent('click', {view: window, bubbles: true, cancelable: true});
                    exact.dispatchEvent(ev);
                    return {ok:true, method:'btnTTCS_dispatch', text: norm(exact.innerText || exact.textContent || ''), onclick: exact.getAttribute('onclick') || ''};
                  } catch(e2) {
                    try {
                      if (typeof window.onShowChamSoc === 'function') {
                        window.onShowChamSoc(exact);
                        return {ok:true, method:'btnTTCS_onShowChamSoc', text: norm(exact.innerText || exact.textContent || ''), onclick: exact.getAttribute('onclick') || ''};
                      }
                    } catch(e3) {}
                  }
                }
                return {ok:false, reason:'btnTTCS_click_failed', count: anchors.length};
                """
            ) or {}
            ok = bool(result.get("ok") if isinstance(result, dict) else result)
            if ok:
                if log_func:
                    method = result.get("method", "btnTTCS_exact") if isinstance(result, dict) else "btnTTCS_exact"
                    log_func(f"[CARE_BASELINE.CARE_INFO_MENU_CLICK] method={method} target=btnTTCS:onShowChamSoc")
                return True
            if isinstance(result, dict):
                last_reason = str(result.get("reason") or "not_found")
        except Exception as exc:
            last_reason = str(exc)
        time.sleep(0.35)
    if log_func:
        log_func(f"[CARE_BASELINE.CARE_INFO_MENU_MISS] method=btnTTCS_exact reason={last_reason}")
    return False


def _click_care_info_menu(driver: Any, log_func: Any = None) -> bool:
    """Click đúng menu 'Thông tin chăm sóc' sau khi đã vào mắt điều dưỡng.

    EMR có nhiều mục gần giống nhau: 'Thông tin chăm sóc cấp 1',
    'Thông tin chăm sóc (Cấp 2-3)', 'Lập kế hoạch CS', 'Lịch sử chăm sóc'.
    Chức năng này chỉ chọn mục chính có onclick onShowChamSoc(this), như HTML người dùng cung cấp.
    """
    try:
        result = driver.execute_script(
            r"""
            const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
            const anchors = Array.from(document.querySelectorAll('a'));
            function isMainCare(a) {
              const text = norm(a.textContent || '');
              const oc = norm(a.getAttribute('onclick') || '');
              if (!text) return false;
              if (text.includes('cấp 1') || text.includes('cap 1') || text.includes('cấp 2') || text.includes('cap 2') || text.includes('cấp 3') || text.includes('cap 3')) return false;
              if (text.includes('lập kế hoạch') || text.includes('lap ke hoach') || text.includes('lịch sử') || text.includes('lich su')) return false;
              if (text === 'thông tin chăm sóc' || text === 'thong tin cham soc') return true;
              return oc.includes('onshowchamsoc(this)') || oc.includes('onshowchamsoc(this);');
            }
            const exact = anchors.find(a => isMainCare(a));
            if (!exact) return {ok:false, reason:'not_found'};
            try { exact.scrollIntoView({block:'center', inline:'center'}); } catch(e) {}
            const oc = String(exact.getAttribute('onclick') || '');
            try {
              if (typeof window.onShowChamSoc === 'function' && /onShowChamSoc/i.test(oc)) {
                window.onShowChamSoc(exact);
                return {ok:true, method:'onShowChamSoc'};
              }
            } catch(e) {}
            try { exact.click(); return {ok:true, method:'click'}; } catch(e) {}
            try {
              const ev = new MouseEvent('click', {view: window, bubbles: true, cancelable: true});
              exact.dispatchEvent(ev); return {ok:true, method:'dispatch'};
            } catch(e) {}
            return {ok:false, reason:'click_failed'};
            """
        ) or {}
        ok = bool(result.get("ok") if isinstance(result, dict) else result)
        if log_func:
            if ok:
                method = result.get("method", "menu") if isinstance(result, dict) else "menu"
                log_func(f"[CARE_BASELINE.CARE_INFO_MENU_CLICK] method={method}")
            else:
                reason = result.get("reason", "unknown") if isinstance(result, dict) else "unknown"
                log_func(f"[CARE_BASELINE.CARE_INFO_MENU_MISS] reason={reason}")
        return ok
    except Exception as exc:
        if log_func:
            log_func(f"[CARE_BASELINE.CARE_INFO_MENU_MISS] reason={exc}")
        return False


def _try_known_care_functions(driver: Any) -> bool:
    """Thử một số hàm JS thường gặp để mở danh sách chăm sóc nếu menu click không hoạt động."""
    try:
        return bool(driver.execute_script(
            r"""
            const mainCareAnchor = Array.from(document.querySelectorAll('a')).find(a => {
              const text = String(a.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
              const oc = String(a.getAttribute('onclick') || '').toLowerCase();
              return (text === 'thông tin chăm sóc' || text === 'thong tin cham soc' || oc.includes('onshowchamsoc(this)')) &&
                     !text.includes('cấp') && !text.includes('cap') && !text.includes('lịch sử') && !text.includes('lich su');
            });
            try {
              if (typeof window.onShowChamSoc === 'function' && mainCareAnchor) {
                window.onShowChamSoc(mainCareAnchor); return true;
              }
            } catch(e) {}
            const names = [
              'loadListTTCS', 'loadListChamSoc', 'LoadListChamSoc', 'loadDanhSachChamSoc', 'LoadDanhSachChamSoc',
              'fnLoadDanhSachChamSoc', 'loadThongTinChamSoc', 'LoadThongTinChamSoc',
              'onShowThongTinChamSoc', 'onLoadThongTinChamSoc', 'loadListCSDD'
            ];
            for (const name of names) {
              try {
                if (typeof window[name] === 'function') { window[name](); return true; }
              } catch(e) {}
            }
            return false;
            """
        ))
    except Exception:
        return False


def _try_care_info_direct_urls(driver: Any) -> bool:
    """Fallback URL: từ màn hình mắt điều dưỡng thêm nextlink các biến thể chăm sóc."""
    base = getattr(driver, "current_url", "") or ""
    if not base:
        return False
    variants = [
        {"nextlink": "thongtinchamsoc"},
        {"nextlink": "thongtinchamsocdd"},
        {"nextlink": "chamsoc"},
        {"nextlink": "danhsachchamsoc"},
        {"nextlink": "chamsocdieuduong"},
    ]
    for params in variants:
        try:
            _safe_get(driver, _upsert_query(base, **params))
            if _wait_for_care_info_content(driver, 4):
                return True
        except Exception:
            continue
    return False


def _click_care_info_menu_selenium(driver: Any, log_func: Any = None) -> bool:
    """Fallback Selenium: bấm đúng thẻ <a onclick=onShowChamSoc(this)> nếu JS bridge không chạy."""
    if By is None:
        return False
    xpaths = [
        "//a[contains(@onclick, 'onShowChamSoc') and not(contains(@onclick, 'Cap')) and not(contains(normalize-space(), 'cấp'))]",
        "//a[@id='btnTTCS' and normalize-space()='Thông tin chăm sóc']",
        "//li[contains(@class,'accordion-header-only')]/a[normalize-space()='Thông tin chăm sóc']",
    ]
    last_err = None
    for xp in xpaths:
        try:
            elems = driver.find_elements(By.XPATH, xp)
            if not elems:
                continue
            el = elems[0]
            try:
                driver.execute_script("arguments[0].scrollIntoView({block:'center', inline:'nearest'});", el)
            except Exception:
                pass
            time.sleep(0.15)
            try:
                el.click()
            except Exception:
                driver.execute_script("arguments[0].click();", el)
            if log_func:
                log_func("[CARE_BASELINE.CARE_INFO_MENU_CLICK] method=selenium")
            return True
        except Exception as exc:
            last_err = exc
    if log_func and last_err:
        log_func(f"[CARE_BASELINE.CARE_INFO_MENU_MISS] method=selenium reason={last_err}")
    return False


def _force_load_care_list(driver: Any, log_func: Any = None) -> bool:
    """Khi đã vào form Thông tin chăm sóc, ép load danh sách như link refresh loadListTTCS()."""
    try:
        ok = bool(driver.execute_script(
            r"""
            try {
              if (typeof window.loadListTTCS === 'function') { window.loadListTTCS(); return 'loadListTTCS'; }
            } catch(e) {}
            const refresh = Array.from(document.querySelectorAll('a')).find(a => String(a.getAttribute('onclick') || '').includes('loadListTTCS'));
            if (refresh) { try { refresh.click(); return 'refresh_click'; } catch(e) {} }
            return '';
            """
        ))
        if ok and log_func:
            log_func("[CARE_BASELINE.CARE_LIST_REFRESH] method=loadListTTCS")
        if ok:
            _wait_processing_cham_soc_done(driver, 10)
            if wait_after_action:
                wait_after_action(driver, 0.7, ready_timeout=10)
            else:
                time.sleep(0.8)
        return ok
    except Exception as exc:
        if log_func:
            log_func(f"[CARE_BASELINE.CARE_LIST_REFRESH_FAIL] reason={exc}")
        return False


def open_care_info(driver: Any, log_func: Any = None) -> bool:
    """Mở màn hình Thông tin chăm sóc từ trang con mắt điều dưỡng.

    Luồng này mô phỏng cách worker nhập chăm sóc đang dùng: vào mắt điều dưỡng → mở nhóm
    Chăm sóc → bấm đúng menu có onclick onShowChamSoc(this) → chờ divDanhSachChamSocContent.
    """
    _check_result = None
    try:
        _check_result = driver.execute_script("""
            const div = document.getElementById('divDanhSachChamSocContent');
            const body = document.body ? document.body.innerHTML : '';
            return {
                div_exists: !!div,
                div_len: div ? div.innerHTML.trim().length : 0,
                has_onDraw: body.includes('onDrawWebpartChamSoc'),
                has_fnOnSao: body.includes('fnOnSaoChepCSDD'),
                has_NextPage: body.includes('NextPageDDChamSoc'),
                table_count: document.querySelectorAll('table.footable').length,
            };
        """)
    except Exception as _ce:
        _check_result = str(_ce)
    if log_func:
        log_func(f"[CARE_BASELINE.HAS_CARE_CHECK] {_check_result}")

    if _has_care_info_content(driver):
        if log_func:
            log_func("[CARE_BASELINE.CARE_INFO_OPEN] method=already_open")
        _force_load_care_list(driver, log_func=log_func)
        return True

    _open_cham_soc_group(driver)

    # Luồng ưu tiên: dùng Selenium element_to_be_clickable giống input_care.py
    # input_care.py dùng: wait.until(EC.element_to_be_clickable((By.ID, "btnTTCS"))).click()
    # Đây là cách đáng tin nhất vì Selenium tự chờ element ready trước khi click.
    try:
        from selenium.webdriver.support.ui import WebDriverWait as _WDW
        from selenium.webdriver.support import expected_conditions as _EC
        from selenium.webdriver.common.by import By as _By
        _wait_se = _WDW(driver, 10)
        _btn = _wait_se.until(_EC.element_to_be_clickable((_By.XPATH,
            "//a[@id='btnTTCS' and contains(@onclick,'onShowChamSoc') and not(contains(@onclick,'Cap'))]"
        )))
        _btn.click()
        if log_func:
            log_func("[CARE_BASELINE.CARE_INFO_MENU_CLICK] method=selenium_EC_clickable")
        if wait_after_action:
            wait_after_action(driver, 2.0, ready_timeout=20)
        else:
            time.sleep(2.5)
        _force_load_care_list(driver, log_func=log_func)
        if _wait_for_care_info_content(driver, 20):
            if log_func:
                log_func("[CARE_BASELINE.CARE_INFO_OPEN] method=selenium_btnTTCS")
            return True
    except Exception as _se_err:
        if log_func:
            log_func(f"[CARE_BASELINE.CARE_INFO_SELENIUM_FAIL] reason={_se_err}")

    # Fallback: luồng cũ dùng execute_script
    if _click_btnTTCS_thong_tin_cham_soc_exact(driver, log_func=log_func, timeout=12):
        # EMR load nội dung qua AJAX sau khi click — chờ đủ để AJAX hoàn thành
        if wait_after_action:
            wait_after_action(driver, 2.0, ready_timeout=20)
        else:
            time.sleep(2.5)
        _force_load_care_list(driver, log_func=log_func)
        if _wait_for_care_info_content(driver, 20):
            if log_func:
                log_func("[CARE_BASELINE.CARE_INFO_OPEN] method=btnTTCS_onShowChamSoc")
            return True
        # Thử gọi trực tiếp onShowChamSoc qua JS nếu click không trigger AJAX
        try:
            btn = driver.execute_script(r"""
                const a = Array.from(document.querySelectorAll('#btnTTCS')).find(a =>
                    /onShowChamSoc\s*\(\s*this\s*\)/i.test(a.getAttribute('onclick') || '') &&
                    !/Cap/i.test(a.getAttribute('onclick') || '')
                );
                if (a && typeof window.onShowChamSoc === 'function') {
                    window.onShowChamSoc(a);
                    return true;
                }
                return false;
            """)
            if btn:
                if log_func:
                    log_func("[CARE_BASELINE.CARE_INFO_MENU_CLICK] method=onShowChamSoc_direct_js")
                if wait_after_action:
                    wait_after_action(driver, 2.0, ready_timeout=20)
                else:
                    time.sleep(2.5)
                _force_load_care_list(driver, log_func=log_func)
                if _wait_for_care_info_content(driver, 20):
                    if log_func:
                        log_func("[CARE_BASELINE.CARE_INFO_OPEN] method=btnTTCS_js_direct")
                    return True
        except Exception:
            pass

    attempts = [
        ("menu_js", lambda: _click_care_info_menu(driver, log_func=log_func)),
        ("menu_selenium", lambda: _click_care_info_menu_selenium(driver, log_func=log_func)),
        ("known_js", lambda: _try_known_care_functions(driver)),
        ("direct_url", lambda: _try_care_info_direct_urls(driver)),
    ]
    for name, fn in attempts:
        try:
            ok = bool(fn())
        except Exception:
            ok = False
        if wait_after_action:
            wait_after_action(driver, 1.0, ready_timeout=15)
        else:
            time.sleep(1.2)
        _force_load_care_list(driver, log_func=log_func)
        if _wait_for_care_info_content(driver, 12):
            if log_func:
                log_func(f"[CARE_BASELINE.CARE_INFO_OPEN] method={name}")
            return True
        if ok and _has_care_info_content(driver):
            if log_func:
                log_func(f"[CARE_BASELINE.CARE_INFO_OPEN] method={name}")
            return True

    if log_func:
        try:
            log_func(f"[CARE_BASELINE.CARE_INFO_OPEN_FAIL] url={getattr(driver, 'current_url', '')}")
        except Exception:
            pass
    return False



def _header_index(headers: List[str], names: Iterable[str]) -> int:
    norm_headers = [_norm_text(h) for h in headers]
    wanted = [_norm_text(n) for n in names]
    for i, h in enumerate(norm_headers):
        if any(w == h or w in h for w in wanted):
            return i
    return -1


def parse_care_info_rows_from_html(html: str, *, care_from: Any = "", care_to: Any = "", patient: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """Parse bảng Thông tin chăm sóc.

    Nhận đúng cấu trúc user cung cấp: các cột Thời gian, Người lập, Diễn biến, Chăm sóc.
    EMR có thể trả nhiều khoa điều trị trong cùng bảng; chỉ lấy nhóm khoa khớp với khoa đang đăng nhập.
    Cột "Khoa" là khoa tài khoản sau đăng nhập; "Khoa điều trị" lấy từ dòng colspan dạng "Khoa điều trị thứ ...".
    """
    if BeautifulSoup is None:
        return []
    soup = BeautifulSoup(html or "", "html.parser")
    patient = patient or {}
    logged_department = str(patient.get("khoa") or patient.get("account_department") or patient.get("department") or "")
    out: List[Dict[str, Any]] = []
    for table in soup.find_all("table"):
        headers = [_clean_cell(th.get_text(" ", strip=True)) for th in table.find_all("th")]
        if not headers:
            continue
        idx_time = _header_index(headers, ["Thời gian", "TG", "T.G"])
        idx_creator = _header_index(headers, ["Người lập", "Nguoi lap"])
        idx_dien_bien = _header_index(headers, ["Diễn biến", "Dien bien"])
        idx_cham_soc = _header_index(headers, ["Chăm sóc", "Cham soc"])
        if min(idx_time, idx_creator, idx_dien_bien, idx_cham_soc) < 0:
            continue
        current_khoa = ""
        current_khoa_matches_login = True
        for tr in table.find_all("tr"):
            cells = tr.find_all("td")
            if not cells:
                continue
            texts = [_clean_cell(td.get_text("\n", strip=True)) for td in cells]
            # Dòng group khoa có colspan và text "Khoa điều trị thứ".
            if len(cells) == 1 or any(td.get("colspan") for td in cells):
                group_text = texts[0] if texts else ""
                if "khoa điều trị" in group_text.lower():
                    current_khoa = group_text
                    current_khoa_matches_login = _department_matches(logged_department, current_khoa)
                continue
            if current_khoa and logged_department and not current_khoa_matches_login:
                continue
            if len(texts) <= max(idx_time, idx_creator, idx_dien_bien, idx_cham_soc):
                continue
            thoi_gian = texts[idx_time]
            if not thoi_gian or not _in_care_window(thoi_gian, care_from, care_to):
                continue
            out.append({
                "Khoa": logged_department,
                "Khoa điều trị": current_khoa,
                "Mã BN": str(patient.get("ma_bn") or ""),
                "Họ tên người bệnh": str(patient.get("ho_ten") or ""),
                "Ngày vào": str(patient.get("ngay_vao") or ""),
                "Thời gian": thoi_gian,
                "Người lập": texts[idx_creator],
                "Diễn biến": texts[idx_dien_bien],
                "Chăm sóc": texts[idx_cham_soc],
            })
    return out




def _care_page_indices_from_html(html: str) -> List[int]:
    """Lấy danh sách page index từ pagination chăm sóc: NextPageDDChamSoc(0), Trang 1/N."""
    found: List[int] = []
    # Có trang chỉ hiện 'Trang 1/2', tham khảo care_cache._cs_get_total_pages.
    m_total = re.search(r"Trang\s+\d+\s*/\s*(\d+)", html or "", flags=re.I)
    if m_total:
        try:
            total = max(1, min(30, int(m_total.group(1))))
            found.extend(range(total))
        except Exception:
            pass
    for m in re.finditer(r"NextPageDDChamSoc\((\d+)\)", html or "", flags=re.I):
        try:
            found.append(int(m.group(1)))
        except Exception:
            continue
    # Giữ thứ tự, bỏ trùng, giới hạn an toàn.
    out: List[int] = []
    for idx in found:
        if idx not in out and 0 <= idx <= 30:
            out.append(idx)
    return out


def _open_care_page(driver: Any, page_index: int) -> bool:
    """Mở page chăm sóc theo hàm phân trang của EMR."""
    try:
        return bool(driver.execute_script(
            """
            const idx = arguments[0];
            try {
              if (typeof window.NextPageDDChamSoc === 'function') {
                window.NextPageDDChamSoc(idx);
                return true;
              }
            } catch(e) {}
            const links = Array.from(document.querySelectorAll('a[href*="NextPageDDChamSoc"]'));
            const wanted = 'NextPageDDChamSoc(' + idx + ')';
            const link = links.find(a => String(a.getAttribute('href') || '').includes(wanted));
            if (link) { try { link.click(); return true; } catch(e) {} }
            return false;
            """,
            int(page_index),
        ))
    except Exception:
        return False


def collect_care_info_rows_from_driver(
    driver: Any,
    *,
    care_from: Any = "",
    care_to: Any = "",
    patient: Optional[Dict[str, Any]] = None,
    log_func: Any = None,
) -> List[Dict[str, Any]]:
    """Parse chăm sóc trên trang hiện tại và các trang phân trang nếu có.

    Bảng chăm sóc có thể hiển thị 'Trang 1/2'. Nếu chỉ đọc trang đầu, các ngày cần lấy
    có thể nằm ở trang sau. Hàm này đọc page hiện tại, phát hiện các page NextPageDDChamSoc,
    rồi mở thêm các page còn lại. Parse vẫn lọc đúng khoa đang đăng nhập trong
    parse_care_info_rows_from_html().
    """
    rows_all: List[Dict[str, Any]] = []
    seen_rows = set()
    visited_pages = set()

    def add_rows(html: str, label: str) -> None:
        rows = parse_care_info_rows_from_html(html, care_from=care_from, care_to=care_to, patient=patient)
        added = 0
        for r in rows:
            key = (
                r.get("Khoa điều trị", ""),
                r.get("Mã BN", ""),
                r.get("Thời gian", ""),
                r.get("Người lập", ""),
                r.get("Diễn biến", ""),
                r.get("Chăm sóc", ""),
            )
            if key in seen_rows:
                continue
            seen_rows.add(key)
            rows_all.append(r)
            added += 1
        if log_func:
            log_func(f"[CARE_BASELINE.CARE_PAGE_PARSE] page={label} rows={len(rows)} added={added}")

    html0 = getattr(driver, "page_source", "") or ""
    add_rows(html0, "current")
    indices = _care_page_indices_from_html(html0)
    if log_func and indices:
        log_func(f"[CARE_BASELINE.CARE_PAGES_FOUND] pages={','.join(map(str, indices))}")
    # EMR dùng index 0 cho trang 1; trang hiện tại thường đã là 0 nên bỏ qua nếu đã đọc.
    for idx in indices:
        if idx in visited_pages:
            continue
        visited_pages.add(idx)
        # Nếu trang current đang là trang 1/index 0 thì có thể bỏ qua index 0 để tránh reload thừa.
        if idx == 0:
            continue
        if not _open_care_page(driver, idx):
            if log_func:
                log_func(f"[CARE_BASELINE.CARE_PAGE_OPEN_FAIL] page={idx}")
            continue
        if wait_after_action:
            wait_after_action(driver, 1.0, ready_timeout=12)
        else:
            time.sleep(1.2)
        add_rows(getattr(driver, "page_source", "") or "", str(idx))
    return rows_all



def _extract_treatment_department_from_group(group_text: Any) -> str:
    """Lấy tên khoa thật từ dòng group: 'Khoa điều trị thứ ... : Khoa X (Ngày vào: ...)'"""
    text = _clean_cell(group_text)
    if not text:
        return ""
    # Cắt phần sau dấu ':' và trước ngoặc ngày vào/chẩn đoán nếu có.
    if ":" in text:
        text = text.split(":", 1)[1]
    text = re.split(r"\(\s*Ngày\s+vào|\(\s*Chẩn\s*đoán", text, flags=re.I)[0]
    text = re.sub(r"\s*-\s*Chẩn\s*đoán.*$", "", text, flags=re.I)
    return _clean_department_text(text)


def _department_matches(logged_department: Any, treatment_group_text: Any) -> bool:
    """So khớp khoa đăng nhập với khoa điều trị trong bảng chăm sóc.

    EMR có thể hiển thị nhiều khoa trong cùng màn hình chăm sóc.
    Chỉ lấy các dòng thuộc khoa đang đăng nhập. Nếu không xác định được một trong hai vế,
    trả True để tránh mất dữ liệu do HTML thiếu dòng group.
    """
    logged = _clean_department_text(logged_department)
    treatment = _extract_treatment_department_from_group(treatment_group_text) or _clean_department_text(treatment_group_text)
    n_logged = _norm_text(logged)
    n_treatment = _norm_text(treatment)
    if not n_logged or not n_treatment:
        return True
    # Bỏ tiền tố phổ biến để tăng khả năng match: 'Khoa Phụ Sản' ~ 'Phụ sản'.
    def compact(x: str) -> str:
        x = re.sub(r"\b(khoa|trung tam|tt|benh vien|bv)\b", " ", x)
        return re.sub(r"\s+", " ", x).strip()
    c_logged = compact(n_logged)
    c_treatment = compact(n_treatment)
    if c_logged and c_treatment and (c_logged in c_treatment or c_treatment in c_logged):
        return True
    return n_logged in n_treatment or n_treatment in n_logged


def write_csv(path: Path, rows: List[Dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_COLUMNS, extrasaction="ignore")
        writer.writeheader()
        for r in rows:
            writer.writerow({c: r.get(c, "") for c in CSV_COLUMNS})


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    tmp.replace(path)


def parse_bool(value: Any, default: bool = True) -> bool:
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in {"0", "false", "no", "off", "khong", "không", "tat", "tắt"}:
        return False
    if text in {"1", "true", "yes", "on", "co", "có", "bat", "bật"}:
        return True
    return default


def resolve_headless(args: argparse.Namespace, account_cfg: Dict[str, Any]) -> bool:
    cli_value = getattr(args, "headless", None)
    if cli_value is not None:
        return bool(cli_value)
    return parse_bool(account_cfg.get("headless"), True)


def run_account(account_cfg: Dict[str, Any], run_id: str, run_dir: Path, args: argparse.Namespace) -> Dict[str, Any]:
    account_id = str(account_cfg.get("account_id") or "account")
    department = str(account_cfg.get("department") or "")
    limit = int(args.limit or account_cfg.get("patient_limit_per_account") or 5)
    care_from = args.care_from or account_cfg.get("care_from") or ""
    care_to = args.care_to or account_cfg.get("care_to") or ""
    admission_from = args.admission_from or account_cfg.get("admission_from") or ""
    admission_to = args.admission_to or account_cfg.get("admission_to") or ""
    if not admission_from or not admission_to:
        days_back = int(account_cfg.get("admission_days_back") or 0)
        if not days_back:
            months_back = int(account_cfg.get("admission_months_back") or 3)
            days_back = max(1, months_back * 30)
        default_admission_from, default_admission_to = _default_admission_window(days_back)
        admission_from = admission_from or default_admission_from
        admission_to = admission_to or default_admission_to
    status = str(args.status or account_cfg.get("status") or "Đang thực hiện hoặc Hoàn tất")
    # Khoa auto mode (patient_names rỗng): ưu tiên "Hoàn tất" trước để lấy được
    # dữ liệu chăm sóc đầy đủ của bệnh nhân đã xuất viện. Nếu không tìm thấy
    # "Hoàn tất" thì fallback về "Đang thực hiện".
    # Khoa named mode: giữ nguyên thứ tự từ UI/config.
    _is_auto_mode = not _as_list(
        account_cfg.get("patient_names")
        or account_cfg.get("target_patient_names")
        or account_cfg.get("target_names")
    )
    if _is_auto_mode:
        _all_statuses = resolve_status_candidates(status)
        # Đảo thứ tự: Hoàn tất trước, Đang thực hiện sau
        _hoan_tat = [s for s in _all_statuses if "hoàn tất" in s.lower() or "hoan tat" in s.lower()]
        _dang_th  = [s for s in _all_statuses if s not in _hoan_tat]
        status_candidates = _hoan_tat + _dang_th or _all_statuses
    else:
        status_candidates = resolve_status_candidates(status)
    search_attempts = _search_attempt_count(account_cfg)
    headless = resolve_headless(args, account_cfg)

    if not account_cfg.get("username") or not account_cfg.get("password"):
        return {"account_id": account_id, "department": department, "status": "skipped", "reason": "missing_credentials", "patients": 0, "rows": 0}

    _log(f"[CARE_BASELINE.ACCOUNT_START] account={account_id} khoa={department} limit={limit} care={care_from}→{care_to} status={status} attempts={search_attempts} headless={1 if headless else 0}")
    rows_all: List[Dict[str, Any]] = []
    processed_patients = []
    _ws = WorkerSession(account_cfg, "/dev/null")  # result path không dùng ở đây
    driver, wait = None, None
    try:
        _ws.__enter__()
        driver, wait = _ws.driver, _ws.wait
        actual_department = extract_logged_in_department(driver)
        if actual_department:
            department = actual_department
            account_cfg["department"] = actual_department
            _log(f"[CARE_BASELINE.DEPARTMENT_DETECTED] account={account_id} khoa={actual_department}")
        else:
            _log(f"[CARE_BASELINE.DEPARTMENT_FALLBACK] account={account_id} khoa={department or '(trống)'}")
        inpatient_url = _build_inpatient_url_after_login(getattr(driver, "current_url", ""), account_cfg)
        _safe_get(driver, inpatient_url)
        # Nếu account cấu hình ward_select, chọn đúng khoa từ dropdown trước khi làm gì khác
        _ward_select = str(account_cfg.get("ward_select") or "").strip()
        if _ward_select:
            if wait_after_action:
                wait_after_action(driver, 0.5, ready_timeout=8)
            else:
                import time as _t; _t.sleep(0.6)
            _select_inpatient_ward(driver, _ward_select, log_func=_log)
            if wait_after_action:
                wait_after_action(driver, 1.0, ready_timeout=10)
            else:
                _t.sleep(1.0)
        if set_inpatient_status_filter:
            set_inpatient_status_filter(driver, wait, status_candidates[0], log_func=_log)
        if wait_after_action:
            wait_after_action(driver, 1.0, ready_timeout=10)
        # Một số màn hình chỉ reload danh sách sau khi bấm nút Tìm, kể cả khi đã set trạng thái.
        _submit_inpatient_search(driver, wait, "", log_func=_log)
        room_filter = ",".join(_as_list(account_cfg.get("patient_room_keywords") or []))
        target_names = _as_list(account_cfg.get("target_patient_names") or [])
        selection_mode = str(account_cfg.get("patient_selection_mode") or ("named" if target_names else "auto"))
        candidate_cfg = {
            **account_cfg,
            "patient_limit_per_account": limit,
            "admission_from": admission_from,
            "admission_to": admission_to,
        }
        # ── NAMES ONLY MODE ─────────────────────────────────────────────────────
        if getattr(args, "names_only", False):
            _log(f"[CARE_BASELINE.NAMES_ONLY] account={account_id} mode=names_only")
            _all_cands: List[Dict[str, Any]] = []
            if target_names:
                _seen_k: set = set()
                for _tn in target_names:
                    if len(_all_cands) >= limit:
                        break
                    _c = find_named_patient_candidate_by_search(
                        driver, wait, inpatient_url, candidate_cfg, _tn, status, log_func=_log
                    )
                    if not _c:
                        continue
                    _k = _candidate_key(_c)
                    if _k and _k in _seen_k:
                        continue
                    if _k:
                        _seen_k.add(_k)
                    _all_cands.append(_c)
            else:
                _all_cands = collect_auto_patient_candidates_with_status_retry(
                    driver, wait, inpatient_url, candidate_cfg, status, log_func=_log
                )[:limit]
            # Fillup: nếu chưa đủ limit, tự động lấy thêm từ danh sách
            if len(_all_cands) < limit:
                _need = limit - len(_all_cands)
                _seen_ma = {str(c.get("ma_bn") or "") for c in _all_cands if c.get("ma_bn")}
                _fillup = collect_auto_patient_candidates_with_status_retry(
                    driver, wait, inpatient_url,
                    {**candidate_cfg, "patient_limit_per_account": _need * 3},
                    status, log_func=_log
                )
                for _fc in _fillup:
                    if len(_all_cands) >= limit:
                        break
                    _fma = str(_fc.get("ma_bn") or "")
                    if _fma and _fma in _seen_ma:
                        continue
                    if _fma:
                        _seen_ma.add(_fma)
                    _all_cands.append(_fc)
                    _log(f"[CARE_BASELINE.NAMES_ONLY_FILLUP] account={account_id} name={_fc.get('ho_ten')} ma_bn={_fc.get('ma_bn')}")

            for _c in _all_cands:
                _row = {
                    "run_id": run_id,
                    "account_id": account_id,
                    "account_department": department,
                    "Khoa": department,
                    "Khoa điều trị": "",
                    "Mã BN": str(_c.get("ma_bn") or ""),
                    "Họ tên người bệnh": str(_c.get("ho_ten") or ""),
                    "Ngày vào": str(_c.get("ngay_vao") or ""),
                    "Thời gian": "",
                    "Người lập": "",
                    "Diễn biến": "",
                    "Chăm sóc": "",
                }
                rows_all.append(_row)
                processed_patients.append({
                    "patient": _c.get("ma_bn") or _c.get("ho_ten") or "",
                    "name": _c.get("ho_ten") or "",
                    "status": "names_only",
                    "rows": 0,
                })
                _log(f"[CARE_BASELINE.NAMES_ONLY_ADD] account={account_id} name={_c.get('ho_ten')} ma_bn={_c.get('ma_bn')}")
            _log(f"[CARE_BASELINE.NAMES_ONLY_DONE] account={account_id} patients={len(processed_patients)}")
            return {"account_id": account_id, "department": department, "status": "done",
                    "patients": len(processed_patients), "rows": len(rows_all),
                    "patient_results": processed_patients, "rows_data": rows_all}
        # ────────────────────────────────────────────────────────────────────────

        def _process_one_candidate(cand: Dict[str, Any], idx: int) -> None:
            patient_key = cand.get("ma_bn") or cand.get("ho_ten") or f"row{idx}"
            patient_status = {"patient": patient_key, "name": cand.get("ho_ten") or "", "inpatient_status": cand.get("_inpatient_status") or status_candidates[0], "status": "pending", "rows": 0}
            processed_patients.append(patient_status)
            try:
                current_status = str(cand.get("_inpatient_status") or status_candidates[0])
                # Nếu candidate đã có href_nursing từ cột ĐD thì mở ngay href đó.
                # Không quay lại danh sách/tìm tên nữa, để tránh thấy tên rồi lại đi tìm người khác.
                if not cand.get("href_nursing"):
                    _safe_get(driver, inpatient_url)
                    if set_inpatient_status_filter:
                        set_inpatient_status_filter(driver, wait, current_status, log_func=_log)
                    _submit_inpatient_search(driver, wait, cand.get("ho_ten") or cand.get("ma_bn") or "", log_func=_log)
                _open_nursing_eye(driver, cand, log_func=_log)
                if not open_care_info(driver, log_func=_log):
                    raise RuntimeError("Không mở được màn hình Thông tin chăm sóc.")
                patient_ctx = {**cand, "khoa": department, "account_department": department, "department": department}
                # Nếu không có khoảng ngày cố định, tự động lấy từ ngày vào BN → hôm nay
                _ngay_vao = str(cand.get("ngay_vao") or "")
                _ngay_vao_parsed = _parse_date_any(_ngay_vao)
                if _ngay_vao_parsed:
                    _ngay_vao_iso = _ngay_vao_parsed.strftime("%Y-%m-%d")
                else:
                    _ngay_vao_iso = ""
                _today_iso = date.today().strftime("%Y-%m-%d")
                effective_care_from = care_from or _ngay_vao_iso
                effective_care_to = care_to or _today_iso
                if effective_care_from != care_from or effective_care_to != care_to:
                    _log(
                        f"[CARE_BASELINE.CARE_DATE_AUTO] patient={patient_key} "
                        f"ngay_vao={_ngay_vao} care={effective_care_from}→{effective_care_to}"
                    )
                care_rows = collect_care_info_rows_from_driver(driver, care_from=effective_care_from, care_to=effective_care_to, patient=patient_ctx, log_func=_log)
                if not care_rows:
                    # Diagnostic: xem bảng thật có gì
                    try:
                        _diag = driver.execute_script("""
                            const tables = Array.from(document.querySelectorAll('table'));
                            return tables.map(t => ({
                                cls: t.className,
                                headers: Array.from(t.querySelectorAll('th')).map(th => th.innerText.trim()).slice(0,8),
                                body_rows: t.querySelectorAll('tbody tr').length,
                                sample_cells: Array.from(t.querySelectorAll('tbody tr:first-child td')).map(td => td.innerText.trim().slice(0,30)).slice(0,5),
                            })).filter(t => t.body_rows > 0 || t.headers.length > 0).slice(0,5);
                        """) or []
                        _log(f"[CARE_BASELINE.ROWS_ZERO_DIAG] patient={patient_key} care={effective_care_from}→{effective_care_to} tables={_diag}")
                    except Exception as _dd:
                        _log(f"[CARE_BASELINE.ROWS_ZERO_DIAG_ERR] {_dd}")
                for r in care_rows:
                    r.update({
                        "run_id": run_id,
                        "account_id": account_id,
                        "account_department": department,
                        "Khoa": r.get("Khoa") or department,
                    })
                if not care_rows:
                    # Dù không lấy được dữ liệu chăm sóc, vẫn ghi 1 dòng trống
                    # để biết đã xử lý BN này (tên, mã, khoa, ngày vào).
                    _empty_row = {
                        "run_id": run_id,
                        "account_id": account_id,
                        "account_department": department,
                        "Khoa": department,
                        "Khoa điều trị": "",
                        "Mã BN": str(patient_ctx.get("ma_bn") or ""),
                        "Họ tên người bệnh": str(patient_ctx.get("ho_ten") or ""),
                        "Ngày vào": str(patient_ctx.get("ngay_vao") or ""),
                        "Thời gian": "",
                        "Người lập": "",
                        "Diễn biến": "",
                        "Chăm sóc": "",
                    }
                    rows_all.append(_empty_row)
                    _log(f"[CARE_BASELINE.NO_CARE_ROWS] account={account_id} patient={patient_key} action=ghi_dong_trong")
                rows_all.extend(care_rows)
                patient_status.update({"status": "done", "rows": len(care_rows)})
                _log(f"[CARE_BASELINE.CARE_PARSE] account={account_id} patient={patient_key} rows={len(care_rows)}")
            except Exception as e:
                patient_status.update({"status": "error", "reason": str(e)})
                _log(f"[CARE_BASELINE.ERROR] account={account_id} patient={patient_key} error={e}")

        if target_names:
            found_ranks = set()
            missing = []
            seen = set()
            idx = 0
            for name_index, target_name in enumerate(target_names):
                if len(processed_patients) >= limit:
                    break
                cand = find_named_patient_candidate_by_search(driver, wait, inpatient_url, candidate_cfg, target_name, status, log_func=_log)
                if not cand:
                    missing.append(target_name)
                    continue
                k = _candidate_key(cand)
                if k and k in seen:
                    continue
                if k:
                    seen.add(k)
                rank = _target_name_rank(cand.get("ho_ten"), target_names)
                if rank is not None:
                    found_ranks.add(rank)
                idx += 1
                _log(
                    f"[CARE_BASELINE.PATIENT_PROCESS_IMMEDIATE] account={account_id} "
                    f"name={cand.get('ho_ten') or target_name} ma_bn={cand.get('ma_bn') or ''} "
                    f"href_nursing={1 if cand.get('href_nursing') else 0}"
                )
                _process_one_candidate(cand, idx)
            missing.extend([name for i, name in enumerate(target_names) if i not in found_ranks and name not in missing][:0])
            _log(
                f"[CARE_BASELINE.PATIENT_SELECT_NAMED] account={account_id} "
                f"targets={len(target_names)} found={len(found_ranks)} selected={len(processed_patients)} "
                f"missing={'; '.join(missing) if missing else 'không'}"
            )
            # Nếu tìm theo tên nhưng chưa đủ limit → chọn thêm bệnh nhân bất kỳ từ "Hoàn tất"
            if len(processed_patients) < limit:
                _remaining = limit - len(processed_patients)
                _log(
                    f"[CARE_BASELINE.PATIENT_FILLUP] account={account_id} "
                    f"need={_remaining} action=auto_fillup_hoan_tat"
                )
                _fillup_cfg = {**candidate_cfg, "patient_limit_per_account": _remaining * 3}
                _fillup_candidates = collect_auto_patient_candidates_with_status_retry(
                    driver, wait, inpatient_url, _fillup_cfg, "Hoàn tất", log_func=_log
                )
                _fillup_seen = {_candidate_key(p) for p in processed_patients if _candidate_key(p)}
                _added = 0
                for _fc in _fillup_candidates:
                    if len(processed_patients) >= limit:
                        break
                    _fk = _candidate_key(_fc)
                    if _fk and _fk in _fillup_seen:
                        continue
                    if _fk:
                        _fillup_seen.add(_fk)
                    idx += 1
                    _added += 1
                    _log(
                        f"[CARE_BASELINE.PATIENT_FILLUP_ADD] account={account_id} "
                        f"name={_fc.get('ho_ten') or ''} ma_bn={_fc.get('ma_bn') or ''}"
                    )
                    _process_one_candidate(_fc, idx)
                _log(
                    f"[CARE_BASELINE.PATIENT_FILLUP_DONE] account={account_id} "
                    f"added={_added} total={len(processed_patients)}"
                )
        else:
            candidates = collect_auto_patient_candidates_with_status_retry(driver, wait, inpatient_url, candidate_cfg, status, log_func=_log)
            if selection_mode == "auto":
                _log(
                    f"[CARE_BASELINE.PATIENT_SELECT_AUTO_NO_NAMES] account={account_id} "
                    f"selected={min(len(candidates), limit)} candidates={len(candidates)} "
                    f"reason=chưa cấu hình patient_names; lọc_phòng={room_filter or 'tất cả'} "
                    f"trạng_thái={status} khoảng_ngày_vào={admission_from}→{admission_to}"
                )
            else:
                _log(f"[CARE_BASELINE.PATIENT_SELECT] account={account_id} candidates={len(candidates)} lọc_phòng={room_filter or 'tất cả'} trạng_thái={status} khoảng_ngày_vào={admission_from}→{admission_to}")
            for idx, cand in enumerate(candidates[:limit], 1):
                _process_one_candidate(cand, idx)


        return {"account_id": account_id, "department": department, "status": "done", "patients": len(processed_patients), "rows": len(rows_all), "patient_results": processed_patients, "rows_data": rows_all}
    except Exception as e:
        return {"account_id": account_id, "department": department, "status": "error", "reason": str(e), "patients": len(processed_patients), "rows": len(rows_all), "patient_results": processed_patients, "rows_data": rows_all}
    finally:
        try:
            _ws.__exit__(None, None, None)
        except Exception:
            pass


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Lấy thông tin chăm sóc/lường cơ bản")
    parser.add_argument("--config", default="", help="Đường dẫn config/care_baseline.json")
    parser.add_argument("--out-root", default=str(DEFAULT_OUT_ROOT))
    parser.add_argument("--run-id", default="")
    parser.add_argument("--names-only", action="store_true", default=False,
                        help="Chỉ lấy tên BN + mã BN, không vào mắt điều dưỡng (nhanh hơn nhiều)")
    parser.add_argument("--skip-done", action="store_true", default=False,
                        help="Bỏ qua account đã có đủ dữ liệu từ lần chạy trước (dựa vào latest.json)")
    parser.add_argument("--min-rows-to-skip", type=int, default=3,
                        help="Số dòng chăm sóc tối thiểu/account để coi là 'đã đủ' (default: 3)")
    headless_group = parser.add_mutually_exclusive_group()
    headless_group.add_argument("--headless", dest="headless", action="store_true", default=None)
    headless_group.add_argument("--no-headless", dest="headless", action="store_false")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--status", default="")
    parser.add_argument("--search-attempts", type=int, default=0)
    parser.add_argument("--admission-from", default="")
    parser.add_argument("--admission-to", default="")
    parser.add_argument("--care-from", default="")
    parser.add_argument("--care-to", default="")
    args = parser.parse_args(argv)

    task_cfg = load_task_config(args.config)
    if task_cfg.get("enabled") is False:
        raise RuntimeError("care_baseline.json đang enabled=false.")

    base = load_config()
    default = task_cfg.get("default") or {}
    accounts = [a for a in (task_cfg.get("accounts") or []) if isinstance(a, dict) and a.get("enabled", True) is not False]
    if not accounts:
        raise RuntimeError("Không có account enabled trong care_baseline.json.")

    run_id = _safe_part(args.run_id or _today_run_id(), "run")
    out_root = Path(args.out_root or DEFAULT_OUT_ROOT)
    run_dir = out_root / "runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    all_rows: List[Dict[str, Any]] = []
    account_summaries: List[Dict[str, Any]] = []

    # Đọc kết quả lần chạy trước để biết account nào đã đủ dữ liệu
    _prev_rows_by_account: Dict[str, int] = {}
    _prev_patients_by_account: Dict[str, int] = {}
    if args.skip_done:
        _latest_path = out_root / "latest.json"
        try:
            _latest = json.loads(_latest_path.read_text(encoding="utf-8"))
            for _ar in (_latest.get("account_results") or []):
                _aid = str(_ar.get("account_id") or "")
                if _aid:
                    _prev_rows_by_account[_aid] = int(_ar.get("rows") or 0)
                    _prev_patients_by_account[_aid] = int(_ar.get("patients") or 0)
            _log(f"[CARE_BASELINE.SKIP_DONE] loaded latest.json run={_latest.get('run_id')} accounts_with_data={len(_prev_rows_by_account)}")
        except Exception as _le:
            _log(f"[CARE_BASELINE.SKIP_DONE] không đọc được latest.json: {_le}")

    for account in accounts:
        account_cfg = effective_account_config(base, default, account)
        _aid = str(account_cfg.get("account_id") or account_cfg.get("id") or "")
        _limit = int(args.limit or account_cfg.get("patient_limit_per_account") or 5)
        _min_rows = int(args.min_rows_to_skip or 3)

        # Skip nếu lần trước đã có đủ: ít nhất limit BN VÀ đủ min_rows dòng chăm sóc
        if args.skip_done and _aid and _aid in _prev_rows_by_account:
            _prev_rows = _prev_rows_by_account[_aid]
            _prev_patients = _prev_patients_by_account.get(_aid, 0)
            if _prev_patients >= _limit and _prev_rows >= _min_rows:
                _log(
                    f"[CARE_BASELINE.SKIP_DONE_ACCOUNT] account={_aid} "
                    f"prev_patients={_prev_patients} prev_rows={_prev_rows} action=skip"
                )
                account_summaries.append({
                    "account_id": _aid,
                    "department": account_cfg.get("department_hint") or "",
                    "status": "skipped_done",
                    "reason": f"đã đủ dữ liệu từ lần trước (patients={_prev_patients} rows={_prev_rows})",
                    "patients": 0,
                    "rows": 0,
                })
                continue
            else:
                _log(
                    f"[CARE_BASELINE.SKIP_DONE_CHECK] account={_aid} "
                    f"prev_patients={_prev_patients} prev_rows={_prev_rows} "
                    f"need_patients={_limit} need_rows={_min_rows} action=run"
                )

        result = run_account(account_cfg, run_id, run_dir, args)
        all_rows.extend(result.pop("rows_data", []) or [])
        account_summaries.append(result)

    csv_path = run_dir / "care_baseline.csv"
    write_csv(csv_path, all_rows)
    summary = {
        "status": "ok" if any(a.get("status") == "done" for a in account_summaries) else "error",
        "run_id": run_id,
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "accounts": len(account_summaries),
        "patients": sum(int(a.get("patients") or 0) for a in account_summaries),
        "rows": len(all_rows),
        "output_csv": str(csv_path),
        "account_results": account_summaries,
        "columns": CSV_COLUMNS,
    }
    write_json(run_dir / "summary.json", summary)
    write_json(out_root / "latest.json", summary)
    _log(f"[CARE_BASELINE.DONE] run_id={run_id} accounts={summary['accounts']} patients={summary['patients']} rows={summary['rows']} csv={csv_path}")
    return 0 if summary["status"] == "ok" else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"[CARE_BASELINE.FATAL] {exc}", file=sys.stderr, flush=True)
        raise SystemExit(1)
