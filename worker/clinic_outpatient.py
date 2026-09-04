# -*- coding: utf-8 -*-
"""Worker cho tab Phòng khám.

Giai đoạn 1: đăng nhập EMR, mở Danh sách Khám bệnh, tìm mã người bệnh
trong khoảng 3 tháng hoặc đọc danh sách hiện tại, rồi trả về bảng/trạng thái.
Không bấm nút hoàn tất khám ở giai đoạn này.
"""
from __future__ import annotations

import argparse
import base64
import html
import json
import os
import re
import sys
import time
import unicodedata
import zipfile
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
from xml.etree import ElementTree as ET

from utils import load_config, login_emr
from shared.worker_session import WorkerSession, open_session
from shared.text_utils import strip_accents, norm_vi as norm

try:
    from bs4 import BeautifulSoup
except ModuleNotFoundError:  # pragma: no cover
    BeautifulSoup = None  # type: ignore

try:
    from selenium.webdriver.common.by import By
    from selenium.webdriver.common.keys import Keys
    from selenium.webdriver.support.ui import Select, WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
except Exception:  # pragma: no cover
    By = Keys = Select = WebDriverWait = EC = None  # type: ignore

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

DEFAULT_CLINIC_LIST_URL = os.environ.get("EMR_CLINIC_LIST_URL", "").strip()
TRAUMA_ROOM_RE = re.compile(r"ph[oò]ng\s+kh[aá]m\s+ch[aấ]n\s+th[uư][oơ]ng\s+ch[iỉ]nh\s+h[iì]nh", re.I)
SKIP_STATUS_NORMS = {"hoan tat", "da tat toan", "treo"}
SERVICE_RESULT_RE = re.compile(r"\b([A-ZĐA-Z]{1,8})\s*:\s*(\d+)\s*/\s*(\d+)\b", re.I)
DEFAULT_DOCTOR_KEYWORDS = "tiêm khớp, chọc hút, nắn chỉnh, bó bột, rạch, khâu, tiểu phẫu"
DEFAULT_NURSE_KEYWORDS = "thay băng, cắt chỉ, băng, nẹp"
ORDER_DONE_STATUS_NORMS = {"hoan tat", "da tat toan", "treo", "da thuc hien", "da hoan thanh", "hoan thanh"}



# strip_accents, norm → shared.text_utils


def compact(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def patient_code(value: Any) -> str:
    return re.sub(r"\D+", "", str(value or "")).strip()


# ── XLSX parser không cần thư viện ngoài ─────────────────────────────────────

def _xlsx_col_index(cell_ref: str) -> int:
    m = re.match(r"([A-Z]+)", cell_ref.upper())
    if not m:
        return 0
    n = 0
    for ch in m.group(1):
        n = n * 26 + (ord(ch) - ord("A") + 1)
    return n - 1


def _read_shared_strings(zf: zipfile.ZipFile) -> List[str]:
    try:
        raw = zf.read("xl/sharedStrings.xml")
    except KeyError:
        return []
    root = ET.fromstring(raw)
    ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    out: List[str] = []
    for si in root.findall(f"{ns}si"):
        parts = []
        for t in si.iter(f"{ns}t"):
            parts.append(t.text or "")
        out.append("".join(parts))
    return out


def _cell_value(cell: ET.Element, shared: List[str]) -> str:
    ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    cell_type = cell.attrib.get("t", "")
    if cell_type == "inlineStr":
        parts = [t.text or "" for t in cell.iter(f"{ns}t")]
        return "".join(parts)
    v = cell.find(f"{ns}v")
    raw = v.text if v is not None else ""
    if cell_type == "s":
        try:
            return shared[int(raw)]
        except Exception:
            return ""
    return raw or ""


def _read_sheet_matrix(zf: zipfile.ZipFile, sheet_path: str, shared: List[str]) -> List[List[str]]:
    ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    root = ET.fromstring(zf.read(sheet_path))
    rows: List[List[str]] = []
    for row in root.iter(f"{ns}row"):
        values: Dict[int, str] = {}
        max_col = -1
        for c in row.findall(f"{ns}c"):
            idx = _xlsx_col_index(c.attrib.get("r", ""))
            max_col = max(max_col, idx)
            values[idx] = compact(_cell_value(c, shared))
        if max_col >= 0:
            rows.append([values.get(i, "") for i in range(max_col + 1)])
    return rows


def parse_xlsx_patient_rows(xlsx_path: str) -> List[Dict[str, str]]:
    """Đọc các dòng có cột Mã BN từ workbook xlsx."""
    targets: List[Dict[str, str]] = []
    seen = set()
    with zipfile.ZipFile(xlsx_path, "r") as zf:
        shared = _read_shared_strings(zf)
        sheet_paths = sorted(p for p in zf.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml$", p))
        for sheet_path in sheet_paths:
            matrix = _read_sheet_matrix(zf, sheet_path, shared)
            if not matrix:
                continue
            header_idx = -1
            header_map: Dict[str, int] = {}
            for i, row in enumerate(matrix[:20]):
                normalized = [norm(x) for x in row]
                if any(h in {"ma bn", "ma benh nhan", "ma nguoi benh"} for h in normalized):
                    header_idx = i
                    for idx, title in enumerate(normalized):
                        if title and title not in header_map:
                            header_map[title] = idx
                    break
            if header_idx < 0:
                continue

            def get(row: List[str], *names: str) -> str:
                for name in names:
                    idx = header_map.get(norm(name))
                    if idx is not None and idx < len(row):
                        return compact(row[idx])
                return ""

            for row in matrix[header_idx + 1:]:
                code = patient_code(get(row, "Mã BN", "Mã bệnh nhân", "Mã người bệnh"))
                if not code or code in seen:
                    continue
                seen.add(code)
                targets.append({
                    "ma_bn": code,
                    "ho_ten": get(row, "Tên BN", "Họ tên", "Tên người bệnh"),
                    "phong_kham": get(row, "Tên phòng khám", "Phòng khám"),
                    "trang_thai_excel": get(row, "Trạng thái KB", "Trạng thái"),
                    "gioi_tinh": get(row, "Giới tính"),
                    "nam_sinh": get(row, "Năm sinh"),
                    "doi_tuong": get(row, "Đối tượng"),
                    "ma_pk": get(row, "Mã PK"),
                    "ten_dv": get(row, "Tên DV"),
                    "source": os.path.basename(xlsx_path),
                })
    return targets


def parse_manual_codes(text: Any) -> List[Dict[str, str]]:
    rows: List[Dict[str, str]] = []
    seen = set()
    for part in re.split(r"[\s,;]+", str(text or "")):
        code = patient_code(part)
        if code and code not in seen:
            seen.add(code)
            rows.append({"ma_bn": code, "source": "manual"})
    return rows


def dedupe_targets(rows: Iterable[Dict[str, str]]) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []
    seen = set()
    for row in rows:
        code = patient_code(row.get("ma_bn"))
        if not code or code in seen:
            continue
        seen.add(code)
        out.append({**row, "ma_bn": code})
    return out


# ── Parse HTML bảng danh sách khám bệnh ──────────────────────────────────────

def _text(el: Any) -> str:
    if el is None:
        return ""
    try:
        return compact(el.get_text(" ", strip=True))
    except Exception:
        return compact(el)


def _header_key(value: Any) -> str:
    n = norm(value)
    aliases = {
        "stt": "stt",
        "sdk": "sdk",
        "so dang ky": "sdk",
        "ma bn": "ma_bn",
        "ma benh nhan": "ma_bn",
        "ho ten": "ho_ten",
        "ten bn": "ho_ten",
        "nam sinh": "nam_sinh",
        "doi tuong": "doi_tuong",
        "thoi gian": "thoi_gian",
        "ly do den kham": "ly_do",
        "trang thai": "trang_thai",
        "ket qua dich vu": "ket_qua_dich_vu",
        "xu tri": "xu_tri",
        "noi thuc hien": "noi_thuc_hien",
        "ghi chu": "ghi_chu",
    }
    return aliases.get(n, n.replace(" ", "_"))


def parse_service_results(cell: Any) -> List[Dict[str, Any]]:
    """Đọc các token kết quả dịch vụ như CDHA: 1/1, TT: 0/1 từ ô bảng."""
    text = _text(cell)
    results: List[Dict[str, Any]] = []
    seen = set()
    if cell is not None:
        try:
            anchors = list(cell.find_all("a"))
        except Exception:
            anchors = []
    else:
        anchors = []

    chunks: List[Tuple[str, str]] = []
    for a in anchors:
        chunks.append((_text(a), compact(a.get("onclick") or "")))
    chunks.append((text, ""))

    for chunk, onclick in chunks:
        for m in SERVICE_RESULT_RE.finditer(chunk or ""):
            code = strip_accents(m.group(1)).upper()
            try:
                done = int(m.group(2))
                total = int(m.group(3))
            except Exception:
                continue
            key = (code, done, total)
            if key in seen:
                continue
            seen.add(key)
            results.append({
                "code": code,
                "done": done,
                "total": total,
                "complete": total > 0 and done >= total,
                "pending": max(total - done, 0),
                "text": f"{code}: {done}/{total}",
                "onclick": onclick,
            })
    return results


def service_summary(results: List[Dict[str, Any]], code: str) -> Dict[str, Any]:
    code_norm = strip_accents(code or "").upper()
    items = [r for r in (results or []) if strip_accents(r.get("code") or "").upper() == code_norm]
    done = sum(int(r.get("done") or 0) for r in items)
    total = sum(int(r.get("total") or 0) for r in items)
    pending = sum(max(int(r.get("total") or 0) - int(r.get("done") or 0), 0) for r in items)
    return {
        "code": code_norm,
        "items": items,
        "done": done,
        "total": total,
        "pending": pending,
        "exists": bool(items),
        "complete": bool(items) and total > 0 and pending == 0,
        "text": "; ".join(r.get("text") or "" for r in items if r.get("text")),
    }


def is_skipped_status(status: Any) -> bool:
    return norm(status) in SKIP_STATUS_NORMS


def parse_keyword_list(value: Any, fallback: str = "") -> List[str]:
    text = str(value if value is not None else fallback)
    out = []
    for part in re.split(r"[,;\n]+", text):
        item = compact(part)
        if item:
            out.append(item)
    return out


def _parse_hour_minute(value: Any) -> Optional[Tuple[int, int]]:
    m = re.search(r"(\d{1,2}):(\d{2})", str(value or ""))
    if not m:
        return None
    try:
        hh, mm = int(m.group(1)), int(m.group(2))
        if 0 <= hh <= 23 and 0 <= mm <= 59:
            return hh, mm
    except Exception:
        return None
    return None


def _afternoon_start_hour(schedule: Dict[str, Any]) -> int:
    try:
        hour = int(str(schedule.get("afternoonStartHour") or schedule.get("afternoon_start_hour") or "12").strip())
        return hour if 0 <= hour <= 23 else 12
    except Exception:
        return 12


def _doctor_name_for_time(schedule: Dict[str, Any], time_text: Any) -> str:
    legacy = compact(schedule.get("doctorName") or schedule.get("doctor_name") or "")
    morning = compact(schedule.get("doctorMorningName") or schedule.get("doctor_morning_name") or legacy)
    afternoon = compact(schedule.get("doctorAfternoonName") or schedule.get("doctor_afternoon_name") or legacy or morning)
    hm = _parse_hour_minute(time_text)
    if hm and hm[0] >= _afternoon_start_hour(schedule):
        return afternoon or morning
    return morning or afternoon


def _staff_name_for_role(schedule: Dict[str, Any], role: str, time_text: Any = "") -> str:
    if role == "doctor":
        return _doctor_name_for_time(schedule, time_text)
    return compact(schedule.get("nurseName") or schedule.get("nurse_name") or "")


def classify_procedure_performer(row: Dict[str, Any], schedule: Optional[Dict[str, Any]] = None) -> Dict[str, str]:
    """Chọn bác sĩ sáng/chiều hoặc điều dưỡng theo Tên chỉ định TT thật."""
    schedule = schedule or {}
    doctor_keywords = parse_keyword_list(schedule.get("doctorKeywords"), DEFAULT_DOCTOR_KEYWORDS)
    nurse_keywords = parse_keyword_list(schedule.get("nurseKeywords"), DEFAULT_NURSE_KEYWORDS)
    blob = " ".join(compact(row.get(k)) for k in (
        "procedure_service_name", "procedure_order_parent_name", "ket_qua_dich_vu",
        "ly_do", "ghi_chu", "chan_doan_hover", "xu_tri"
    ))
    blob_norm = norm(blob)

    role = compact(schedule.get("defaultRole") or "nurse").lower()
    if role not in {"doctor", "nurse"}:
        role = "nurse"
    matched = ""
    for kw in doctor_keywords:
        if norm(kw) and norm(kw) in blob_norm:
            role = "doctor"
            matched = kw
            break
    if not matched:
        for kw in nurse_keywords:
            if norm(kw) and norm(kw) in blob_norm:
                role = "nurse"
                matched = kw
                break
    time_text = row.get("procedure_order_time") or row.get("thoi_gian") or ""
    name = _staff_name_for_role(schedule, role, time_text)
    if role == "doctor":
        hm = _parse_hour_minute(time_text)
        shift = "chiều" if hm and hm[0] >= _afternoon_start_hour(schedule) else "sáng"
        label = f"Bác sĩ phòng khám {shift}"
    else:
        label = "Điều dưỡng phòng khám"
    return {
        "procedure_performer_role": role,
        "procedure_performer_role_label": label,
        "procedure_performer_name": name,
        "procedure_performer_keyword": matched,
    }


def _is_order_done_status(status: Any) -> bool:
    n = norm(status)
    if not n:
        return False
    if n in ORDER_DONE_STATUS_NORMS:
        return True
    return any(token in n for token in ("hoan tat", "tat toan", "treo", "da thuc hien", "hoan thanh"))


def _pending_tt_orders(orders: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out = []
    for order in orders or []:
        if not _is_order_done_status(order.get("trang_thai")):
            out.append(order)
    return out


def enrich_clinic_row(row: Dict[str, Any], schedule: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    out = dict(row or {})
    skipped = is_skipped_status(out.get("trang_thai"))
    tt = service_summary(out.get("service_results") or [], "TT")
    pending_tt = int(tt.get("pending") or 0)
    total_tt = int(tt.get("total") or 0)
    first_tt_item = (tt.get("items") or [{}])[0] if tt.get("items") else {}
    out["skip_status"] = skipped
    out["skip_reason"] = f"Bỏ qua trạng thái: {out.get('trang_thai')}" if skipped else ""
    out["tt_done"] = int(tt.get("done") or 0)
    out["tt_total"] = total_tt
    out["tt_pending"] = pending_tt
    out["tt_text"] = tt.get("text") or ""
    out["tt_onclick"] = compact(first_tt_item.get("onclick") or out.get("tt_onclick") or "")
    out["procedure_orders"] = out.get("procedure_orders") or []
    out["needs_procedure"] = (not skipped) and total_tt > 0 and pending_tt > 0
    out["procedure_status"] = "cần mở popup TT để kiểm tra tên chỉ định" if out["needs_procedure"] else (out["skip_reason"] or "không có TT chưa hoàn tất")
    out["procedure_service_name"] = compact(out.get("procedure_service_name") or "Chưa đọc popup TT")
    out.update(classify_procedure_performer(out, schedule))
    return out


def parse_clinic_table(html_text: str, schedule: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    if BeautifulSoup is None:
        raise RuntimeError("Thiếu beautifulsoup4")
    soup = BeautifulSoup(html_text or "", "html.parser")
    candidate_tables = []
    for table in soup.find_all("table"):
        headers = [_text(th) for th in table.find_all("th")]
        header_norm = " | ".join(norm(h) for h in headers)
        score = 0
        for token in ["ma bn", "ho ten", "trang thai", "noi thuc hien"]:
            if token in header_norm:
                score += 1
        if score:
            candidate_tables.append((score, table, headers))
    if not candidate_tables:
        return []
    candidate_tables.sort(key=lambda x: x[0], reverse=True)
    _, table, headers = candidate_tables[0]
    keys = [_header_key(h) for h in headers]
    rows: List[Dict[str, Any]] = []
    for tr in table.find_all("tr"):
        tds = tr.find_all("td")
        if not tds:
            continue
        row: Dict[str, Any] = {}
        for idx, td in enumerate(tds[:len(keys)]):
            key = keys[idx] if idx < len(keys) else f"cot_{idx+1}"
            row[key] = _text(td)
            if key == "ket_qua_dich_vu":
                row["service_results"] = parse_service_results(td)
        row["ma_bn"] = patient_code(row.get("ma_bn")) or compact(row.get("ma_bn"))
        row["access_id"] = compact(tr.get("access_id") or "")
        first_href = ""
        vao_kham_href = ""
        for a in tr.find_all("a", href=True):
            href = html.unescape(a.get("href") or "")
            if not first_href:
                first_href = href
            title = compact(a.get("title") or a.get_text(" ", strip=True))
            if "vao kham" in norm(title) or "tuiconvaokham=true" in href.lower():
                vao_kham_href = href
                break
        row["href"] = first_href
        row["vao_kham_href"] = vao_kham_href or first_href
        diag = ""
        for a2 in tr.find_all("a"):
            diag = compact(a2.get("data-content") or "")
            if diag:
                break
        row["chan_doan_hover"] = diag
        if "service_results" not in row:
            row["service_results"] = parse_service_results(row.get("ket_qua_dich_vu"))
        if row.get("ma_bn") or row.get("ho_ten") or row.get("trang_thai"):
            rows.append(enrich_clinic_row(row, schedule))
    return rows


def is_trauma_room(row: Dict[str, Any]) -> bool:
    return bool(TRAUMA_ROOM_RE.search(compact(row.get("noi_thuc_hien") or row.get("phong_kham") or "")))


def parse_tt_history_modal(html_text: str) -> List[Dict[str, Any]]:
    """Đọc popup Lịch sử TT sau khi click TT: 0/1 trên danh sách khám bệnh."""
    if BeautifulSoup is None:
        raise RuntimeError("Thiếu beautifulsoup4")
    soup = BeautifulSoup(html_text or "", "html.parser")
    tables = []
    for table in soup.find_all("table"):
        headers = [_text(th) for th in table.find_all("th")]
        header_norm = " | ".join(norm(h) for h in headers)
        if "ten chi dinh" in header_norm and "trang thai" in header_norm:
            tables.append((table, headers))
    if not tables:
        return []
    table, headers = tables[0]
    keys = []
    for h in headers:
        n = norm(h)
        if n == "stt": keys.append("stt")
        elif "tg chi dinh" in n or "thoi gian" in n: keys.append("tg_chi_dinh")
        elif "nguoi chi dinh" in n: keys.append("nguoi_chi_dinh")
        elif n == "ten chi dinh": keys.append("ten_chi_dinh")
        elif "ten chi dinh cha" in n: keys.append("ten_chi_dinh_cha")
        elif "trang thai" in n: keys.append("trang_thai")
        elif "chi tiet" in n: keys.append("chi_tiet")
        else: keys.append(n.replace(" ", "_"))
    orders: List[Dict[str, Any]] = []
    current_group = ""
    for tr in table.find_all("tr"):
        tds = tr.find_all("td")
        if not tds:
            continue
        if len(tds) == 1 or (tds[0].get("colspan") and len(tds) < len(keys)):
            current_group = _text(tds[0])
            continue
        row: Dict[str, Any] = {"nhom": current_group}
        for idx, td in enumerate(tds[:len(keys)]):
            key = keys[idx] if idx < len(keys) else f"cot_{idx+1}"
            row[key] = _text(td)
        if not compact(row.get("ten_chi_dinh")):
            continue
        row["is_done"] = _is_order_done_status(row.get("trang_thai"))
        row["is_pending"] = not row["is_done"]
        orders.append(row)
    return orders


def _apply_tt_order(row: Dict[str, Any], order: Dict[str, Any], schedule: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    out = dict(row or {})
    service_name = compact(order.get("ten_chi_dinh") or out.get("procedure_service_name") or "Thủ thuật phòng khám")
    out["procedure_orders"] = [order]
    out["procedure_service_name"] = service_name
    out["procedure_order_time"] = compact(order.get("tg_chi_dinh") or out.get("thoi_gian") or "")
    out["procedure_order_doctor"] = compact(order.get("nguoi_chi_dinh") or "")
    out["procedure_order_parent_name"] = compact(order.get("ten_chi_dinh_cha") or "")
    out["procedure_order_status"] = compact(order.get("trang_thai") or "")
    out["procedure_status"] = f"Cần nhập TT: {service_name}"
    out["needs_procedure"] = (not out.get("skip_status")) and not _is_order_done_status(order.get("trang_thai"))
    out.update(classify_procedure_performer(out, schedule))
    return out


def _mark_tt_orders_resolved_without_pending(row: Dict[str, Any], orders: List[Dict[str, Any]]) -> Dict[str, Any]:
    out = dict(row or {})
    out["procedure_orders"] = orders
    out["needs_procedure"] = False
    out["procedure_status"] = "Popup TT không còn chỉ định chờ thực hiện"
    if orders:
        out["procedure_service_name"] = compact(orders[0].get("ten_chi_dinh") or out.get("procedure_service_name") or "")
        out["procedure_order_status"] = compact(orders[0].get("trang_thai") or "")
    return out


# ── Selenium interaction ─────────────────────────────────────────────────────

def _build_clinic_url(after_login_url: str, configured_url: str) -> str:
    configured_url = (configured_url or DEFAULT_CLINIC_LIST_URL).strip()
    p_cfg = urlparse(configured_url)
    p_cur = urlparse(after_login_url or configured_url)
    q_cur = dict(parse_qsl(p_cur.query, keep_blank_values=True))
    q_cfg = dict(parse_qsl(p_cfg.query, keep_blank_values=True))
    # Giữ usid/st mới sau login nếu có; override các tham số chức năng từ URL cấu hình.
    for key, val in q_cfg.items():
        if key.lower() in {"usid", "st"} and q_cur.get(key):
            continue
        q_cur[key] = val
    q_cur.setdefault("scope", "sys")
    q_cur.setdefault("lang", "vi")
    q_cur["wpid"] = "khambenhdanhsachdraw"
    return urlunparse((p_cfg.scheme or p_cur.scheme, p_cfg.netloc or p_cur.netloc, p_cfg.path or p_cur.path or "/home.aspx", "", urlencode(q_cur), ""))


def wait_page(driver: Any, seconds: float = 0.4) -> None:
    try:
        WebDriverWait(driver, 12).until(lambda d: d.execute_script("return document.readyState") in ("interactive", "complete"))
    except Exception:
        pass
    time.sleep(seconds)


def _visible_elements(driver: Any, selectors: List[Tuple[Any, str]]) -> List[Any]:
    out = []
    for by, value in selectors:
        try:
            for el in driver.find_elements(by, value):
                try:
                    if el.is_displayed() and el.is_enabled():
                        out.append(el)
                except Exception:
                    continue
        except Exception:
            continue
    return out


def find_patient_code_input(driver: Any) -> Any:
    selectors = [
        (By.CSS_SELECTOR, "input[id*='MaBN' i]"),
        (By.CSS_SELECTOR, "input[name*='MaBN' i]"),
        (By.CSS_SELECTOR, "input[id*='mabn' i]"),
        (By.CSS_SELECTOR, "input[name*='mabn' i]"),
        (By.CSS_SELECTOR, "input[id*='MaBenhNhan' i]"),
        (By.CSS_SELECTOR, "input[name*='MaBenhNhan' i]"),
        (By.XPATH, "//label[contains(normalize-space(), 'Mã BN') or contains(normalize-space(), 'Mã người bệnh')]/following::input[1]"),
        (By.XPATH, "//*[contains(normalize-space(), 'Mã BN') or contains(normalize-space(), 'Mã người bệnh')]/following::input[1]"),
    ]
    els = _visible_elements(driver, selectors)
    if els:
        return els[0]
    # Fallback: input text đầu tiên phía trên bảng.
    els = _visible_elements(driver, [(By.XPATH, "//input[not(@type) or @type='text' or @type='search']")])
    if not els:
        raise RuntimeError("Không tìm thấy ô nhập Mã BN trên Danh sách Khám bệnh")
    return els[0]


def set_text(el: Any, value: str) -> None:
    try:
        el.click()
        el.send_keys(Keys.CONTROL, "a")
        el.send_keys(Keys.BACKSPACE)
        el.send_keys(value)
    except Exception:
        el.parent.execute_script("arguments[0].value = arguments[1]; arguments[0].dispatchEvent(new Event('change'));", el, value)


def set_three_months_filter(driver: Any) -> bool:
    # Ưu tiên select có option "3 tháng".
    for sel in _visible_elements(driver, [(By.TAG_NAME, "select")]):
        try:
            select = Select(sel)
            for opt in select.options:
                txt = norm(opt.text)
                val = norm(opt.get_attribute("value"))
                if "3 thang" in txt or val in {"3", "90", "3m", "three_months"}:
                    select.select_by_visible_text(opt.text)
                    wait_page(driver, 0.1)
                    return True
        except Exception:
            continue
    # Fallback: click nút/link text 3 tháng.
    candidates = _visible_elements(driver, [
        (By.XPATH, "//*[contains(normalize-space(), '3 tháng') or contains(normalize-space(), '3 thang')]"),
    ])
    for el in candidates:
        try:
            driver.execute_script("arguments[0].click();", el)
            wait_page(driver, 0.1)
            return True
        except Exception:
            continue
    return False


def click_search(driver: Any) -> None:
    candidates = _visible_elements(driver, [
        (By.CSS_SELECTOR, "button[id*='Search' i],input[id*='Search' i],button[id*='Tim' i],input[id*='Tim' i]"),
        (By.XPATH, "//button[contains(normalize-space(), 'Tìm') or contains(normalize-space(), 'Tìm kiếm') or contains(normalize-space(), 'Search')]"),
        (By.XPATH, "//input[(@type='button' or @type='submit') and (contains(@value,'Tìm') or contains(@value,'Search'))]"),
        (By.XPATH, "//a[contains(normalize-space(), 'Tìm') or contains(normalize-space(), 'Tìm kiếm')]"),
    ])
    if candidates:
        driver.execute_script("arguments[0].click();", candidates[0])
    else:
        find_patient_code_input(driver).send_keys(Keys.ENTER)
    wait_page(driver, 0.8)


def search_one_patient(driver: Any, code: str, *, three_months: bool = True, schedule: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    if three_months:
        set_three_months_filter(driver)
    input_el = find_patient_code_input(driver)
    set_text(input_el, code)
    click_search(driver)
    rows = parse_clinic_table(driver.page_source or "", schedule=schedule)
    matched = [r for r in rows if patient_code(r.get("ma_bn")) == code]
    return {
        "ma_bn": code,
        "found": bool(matched),
        "rows": matched or rows,
        "row_count": len(matched or rows),
    }


def read_current_clinic_list(driver: Any, schedule: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    wait_page(driver, 0.8)
    rows = parse_clinic_table(driver.page_source or "", schedule=schedule)
    return [r for r in rows if is_trauma_room(r)]


def close_modal_if_any(driver: Any) -> None:
    try:
        for el in driver.find_elements(By.CSS_SELECTOR, ".modal.in .close, .modal.show .close, button.close, [data-dismiss='modal']"):
            try:
                if el.is_displayed():
                    driver.execute_script("arguments[0].click();", el)
                    wait_page(driver, 0.2)
                    return
            except Exception:
                continue
    except Exception:
        pass
    try:
        driver.execute_script("if (window.$) { $('.modal').modal('hide'); }")
    except Exception:
        pass


def _open_tt_popup_for_row(driver: Any, row: Dict[str, Any]) -> bool:
    onclick = compact(row.get("tt_onclick") or "")
    access_id = compact(row.get("access_id") or "")
    if onclick:
        try:
            script = onclick if onclick.rstrip().endswith(";") else onclick + ";"
            driver.execute_script(script)
            wait_page(driver, 0.6)
            return True
        except Exception as e:
            print(f"[CLINIC] Không execute được onclick TT: {e}")
    if access_id:
        selectors = [
            f"a[onclick*='{access_id}'][onclick*='TT']",
            f"a[onclick*=\"{access_id}\"][onclick*='TT']",
        ]
        for sel in selectors:
            try:
                link = driver.find_element(By.CSS_SELECTOR, sel)
                driver.execute_script("arguments[0].click();", link)
                wait_page(driver, 0.6)
                return True
            except Exception:
                continue
    return False


def _wait_tt_modal_orders(driver: Any) -> List[Dict[str, Any]]:
    end = time.time() + 10
    last_orders: List[Dict[str, Any]] = []
    while time.time() < end:
        html_now = driver.page_source or ""
        orders = parse_tt_history_modal(html_now)
        if orders:
            return orders
        last_orders = orders
        time.sleep(0.25)
    return last_orders


def resolve_tt_details_for_rows(driver: Any, rows: List[Dict[str, Any]], schedule: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """Với các dòng TT chưa đủ, mở popup TT để lấy Tên chỉ định rồi tách thành task thật."""
    resolved: List[Dict[str, Any]] = []
    for row in rows or []:
        if not row.get("needs_procedure"):
            resolved.append(row)
            continue
        if not row.get("tt_onclick") and not row.get("access_id"):
            row["procedure_detail_error"] = "Không có link popup TT để đọc Tên chỉ định"
            resolved.append(row)
            continue
        try:
            opened = _open_tt_popup_for_row(driver, row)
            if not opened:
                row["procedure_detail_error"] = "Không mở được popup TT"
                resolved.append(row)
                continue
            orders = _wait_tt_modal_orders(driver)
            pending_orders = _pending_tt_orders(orders)
            if not orders:
                row["procedure_detail_error"] = "Popup TT mở nhưng không đọc được bảng Lịch sử TT"
                resolved.append(row)
            elif not pending_orders:
                resolved.append(_mark_tt_orders_resolved_without_pending(row, orders))
            else:
                for order in pending_orders:
                    resolved.append(_apply_tt_order(row, order, schedule))
        except Exception as e:
            row["procedure_detail_error"] = f"Lỗi đọc popup TT: {e}"
            resolved.append(row)
        finally:
            close_modal_if_any(driver)
    return resolved


def load_request(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path: str, value: Any) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def merge_config_for_clinic(base: Dict[str, Any], req: Dict[str, Any]) -> Dict[str, Any]:
    cfg = dict(base or {})
    login_url = compact(req.get("loginUrl") or req.get("url_login") or cfg.get("clinic_login_url") or cfg.get("url_login"))
    username = compact(req.get("username") or cfg.get("clinic_username") or cfg.get("username"))
    password = str(req.get("password") or cfg.get("clinic_password") or cfg.get("password") or "")
    if login_url:
        cfg["url_login"] = login_url
    if username:
        cfg["username"] = username
    if password:
        cfg["password"] = password
    return cfg


def targets_from_request(req: Dict[str, Any], work_dir: str) -> List[Dict[str, str]]:
    rows: List[Dict[str, str]] = []
    for item in req.get("targets") or []:
        if isinstance(item, dict):
            rows.append({k: compact(v) for k, v in item.items()})
    rows.extend(parse_manual_codes(req.get("manualCodes") or ""))

    upload = req.get("excel") or {}
    b64 = upload.get("base64") if isinstance(upload, dict) else ""
    if b64:
        # Cho phép data URL hoặc base64 thuần.
        if "," in b64[:80]:
            b64 = b64.split(",", 1)[1]
        xlsx_path = os.path.join(work_dir, "clinic_targets.xlsx")
        with open(xlsx_path, "wb") as f:
            f.write(base64.b64decode(b64))
        rows.extend(parse_xlsx_patient_rows(xlsx_path))
    return dedupe_targets(rows)



def clean_clinic_schedule(raw: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    default_role = compact(raw.get("defaultRole") or raw.get("default_role") or "nurse").lower()
    if default_role not in {"doctor", "nurse"}:
        default_role = "nurse"
    legacy_doctor = compact(raw.get("doctorName") or raw.get("doctor_name") or "")
    afternoon_hour = compact(raw.get("afternoonStartHour") or raw.get("afternoon_start_hour") or "12")
    return {
        "doctorName": legacy_doctor,
        "doctorMorningName": compact(raw.get("doctorMorningName") or raw.get("doctor_morning_name") or legacy_doctor),
        "doctorAfternoonName": compact(raw.get("doctorAfternoonName") or raw.get("doctor_afternoon_name") or legacy_doctor),
        "nurseName": compact(raw.get("nurseName") or raw.get("nurse_name") or ""),
        "defaultRole": default_role,
        "afternoonStartHour": afternoon_hour,
        "doctorKeywords": compact(raw.get("doctorKeywords") or raw.get("doctor_keywords") or DEFAULT_DOCTOR_KEYWORDS),
        "nurseKeywords": compact(raw.get("nurseKeywords") or raw.get("nurse_keywords") or DEFAULT_NURSE_KEYWORDS),
        "procedureTemplateName": compact(raw.get("procedureTemplateName") or raw.get("procedure_template_name") or ""),
        "procedureDurationMinutes": compact(raw.get("procedureDurationMinutes") or raw.get("procedure_duration_minutes") or ""),
    }


def summarize_procedure_rows(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    actionable = [r for r in rows or [] if r.get("needs_procedure")]
    skipped = [r for r in rows or [] if r.get("skip_status")]
    pending_tt = sum(int(r.get("tt_pending") or 0) for r in rows or [])
    total_tt = sum(int(r.get("tt_total") or 0) for r in rows or [])
    by_role: Dict[str, int] = {}
    for r in actionable:
        role = compact(r.get("procedure_performer_role_label") or r.get("procedure_performer_role") or "Không rõ") or "Không rõ"
        by_role[role] = by_role.get(role, 0) + 1
    return {
        "actionable_count": len(actionable),
        "skipped_status_count": len(skipped),
        "tt_pending": pending_tt,
        "tt_total": total_tt,
        "by_performer_role": by_role,
    }

def run_preview(req_path: str, out_path: str) -> None:
    req = load_request(req_path)
    work_dir = os.path.dirname(req_path) or os.getcwd()
    config = merge_config_for_clinic(load_config(), req)
    mode = compact(req.get("mode") or "missed")
    clinic_schedule = clean_clinic_schedule(req.get("clinicSchedule") or req.get("clinic_schedule") or {})
    headless = bool(req.get("headless", config.get("clinic_headless", config.get("data_read_headless", True))))
    list_url = compact(req.get("listUrl") or config.get("clinic_list_url") or DEFAULT_CLINIC_LIST_URL)

    if not compact(config.get("url_login")):
        raise RuntimeError("Thiếu URL đăng nhập phòng khám")
    if not compact(config.get("username")) or not str(config.get("password") or ""):
        raise RuntimeError("Thiếu tài khoản hoặc mật khẩu phòng khám")

    targets = targets_from_request(req, work_dir)
    started = datetime.now().isoformat(timespec="seconds")
    _result_holder: list = []
    config_for_ws = {**config, "headless": headless}
    with open_session(out_path, config=config_for_ws) as ws:
        clinic_url = _build_clinic_url(ws.driver.current_url, list_url)
        ws.driver.get(clinic_url)
        wait_page(ws.driver, 1.0)

        if mode == "today":
            rows = read_current_clinic_list(ws.driver, schedule=clinic_schedule)
            rows = resolve_tt_details_for_rows(ws.driver, rows, schedule=clinic_schedule)
            result = {
                "status": "ok",
                "mode": mode,
                "started_at": started,
                "finished_at": datetime.now().isoformat(timespec="seconds"),
                "clinic_url": clinic_url,
                "targets": [],
                "rows": rows,
                "summary": summarize_rows(rows),
                "procedure_summary": summarize_procedure_rows(rows),
                "message": f"Đã đọc {len(rows)} dòng phòng khám chấn thương trong danh sách hiện tại.",
            }
        else:
            if not targets:
                raise RuntimeError("Chưa có mã BN để tìm. Hãy nhập mã BN hoặc chọn file Excel.")
            results = []
            all_rows: List[Dict[str, str]] = []
            for idx, target in enumerate(targets, start=1):
                code = patient_code(target.get("ma_bn"))
                print(f"[CLINIC] Tìm mã BN {idx}/{len(targets)}: {code}")
                item = search_one_patient(ws.driver, code, three_months=True, schedule=clinic_schedule)
                item["target"] = target
                for r in item.get("rows") or []:
                    if not r.get("ma_bn"):
                        r["ma_bn"] = code
                    r["excel_trang_thai"] = target.get("trang_thai_excel", "")
                    r["excel_ho_ten"] = target.get("ho_ten", "")
                    r["excel_phong_kham"] = target.get("phong_kham", "")
                    r["excel_ten_dv"] = target.get("ten_dv", "")
                    if target.get("ten_dv") and r.get("needs_procedure"):
                        r["procedure_service_name"] = target.get("ten_dv", "")
                        r.update(classify_procedure_performer(r, clinic_schedule))
                item["rows"] = resolve_tt_details_for_rows(ws.driver, item.get("rows") or [], schedule=clinic_schedule)
                all_rows.extend(item.get("rows") or [])
                results.append(item)
            result = {
                "status": "ok",
                "mode": mode,
                "started_at": started,
                "finished_at": datetime.now().isoformat(timespec="seconds"),
                "clinic_url": clinic_url,
                "target_count": len(targets),
                "targets": targets,
                "results": results,
                "rows": all_rows,
                "summary": summarize_rows(all_rows),
                "procedure_summary": summarize_procedure_rows(all_rows),
                "message": f"Đã tìm {len(targets)} mã BN trong khoảng 3 tháng.",
            }
        write_json(out_path, result)
        _result_holder.append(result)
    # driver.quit() tự động trong WorkerSession.__exit__


def summarize_rows(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    by_status: Dict[str, int] = {}
    by_room: Dict[str, int] = {}
    for row in rows or []:
        st = compact(row.get("trang_thai") or "Không rõ") or "Không rõ"
        room = compact(row.get("noi_thuc_hien") or row.get("excel_phong_kham") or "Không rõ") or "Không rõ"
        by_status[st] = by_status.get(st, 0) + 1
        by_room[room] = by_room.get(room, 0) + 1
    return {"total": len(rows or []), "by_status": by_status, "by_room": by_room}


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("cmd", choices=["preview", "parse-xlsx", "parse-html"])
    parser.add_argument("input")
    parser.add_argument("output", nargs="?")
    args = parser.parse_args(argv)

    if args.cmd == "preview":
        if not args.output:
            raise SystemExit("Thiếu output path")
        run_preview(args.input, args.output)
        return 0
    if args.cmd == "parse-xlsx":
        data = parse_xlsx_patient_rows(args.input)
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "parse-html":
        with open(args.input, "r", encoding="utf-8") as f:
            rows = parse_clinic_table(f.read())
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return 0
    return 2


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
