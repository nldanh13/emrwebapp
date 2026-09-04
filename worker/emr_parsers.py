# -*- coding: utf-8 -*-
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urljoin

try:
    from bs4 import BeautifulSoup
except ModuleNotFoundError:
    BeautifulSoup = None  # type: ignore

DATE_FULL_RE = re.compile(r"\b(\d{2}/\d{2}/\d{4})\b")
TIME_RE = re.compile(r"\b(\d{1,2}:\d{2})\b")
DOC_RE = re.compile(r"Bác sĩ:\s*([^\n\r]+)", re.IGNORECASE)

WARD_HEADER_RE = re.compile(
    r"Khoa\s+điều\s+trị\s+thứ\s+(\d+)\s*:\s*(.*?)\s*"
    r"\(\s*Ngày\s+vào\s*:\s*"
    r"(\d{1,2}:\d{2}\s+\d{1,2}[/-]\d{1,2}[/-]\d{2,4})"
    r"(?:\s*-\s*Chẩn\s+đoán\s*:\s*(.*))?\)\s*$",
    re.IGNORECASE | re.UNICODE,
)
WARD_ONCLICK_ID_RE = re.compile(r"showAllTrangThaiYLenh\s*\(\s*['\"]([^'\"]+)['\"]", re.IGNORECASE)

# Quy ước nghiệp vụ:
# - Dự trù/DHST có thể bắt đầu từ 05:00 của NGÀY làm việc.
# - Các dòng có mốc giờ < 05:00 (nếu có) thường thuộc ca đêm trước đó.
PLAN_START_HOUR = 5
# Ngày nối ca: chỉ giữ y lệnh/thực hiện trước 07:00 của ngày hôm sau.
BRIDGE_KEEP_BEFORE_HOUR = 7
# Ngày đầu của khoảng lấy dữ liệu: bỏ các mốc trước 07:00 vì thuộc tua trực ngày trước.
START_BOUNDARY_KEEP_FROM_HOUR = 7


def _compact_text(text: str) -> str:
    lines = [ln.rstrip() for ln in (text or "").splitlines()]
    cleaned: List[str] = []
    for ln in lines:
        if ln.strip() == "":
            if cleaned and cleaned[-1] != "":
                cleaned.append("")
        else:
            cleaned.append(ln.strip())
    while cleaned and cleaned[-1] == "":
        cleaned.pop()
    return "\n".join(cleaned).strip()




def _parse_time_to_minutes(raw: str) -> Optional[int]:
    s = str(raw or "").strip()
    if not s:
        return None
    m = re.search(r"\b(\d{1,2}):(\d{2})\b", s)
    if m:
        hh = int(m.group(1))
        mm = int(m.group(2))
        if 0 <= hh <= 23 and 0 <= mm <= 59:
            return hh * 60 + mm
    m = re.search(r"\b(\d{1,2})\s*h\s*(\d{2})?\b", s, re.IGNORECASE)
    if m:
        hh = int(m.group(1))
        mm = int(m.group(2) or 0)
        if 0 <= hh <= 23 and 0 <= mm <= 59:
            return hh * 60 + mm
    m = re.search(r"\b(\d{1,2})\s*gi(?:ờ|o)\s*(\d{2})?\b", s, re.IGNORECASE)
    if m:
        hh = int(m.group(1))
        mm = int(m.group(2) or 0)
        if 0 <= hh <= 23 and 0 <= mm <= 59:
            return hh * 60 + mm
    return None


def _extract_explicit_minutes(text: str) -> List[int]:
    out: List[int] = []
    src = str(text or "")

    for hh, mm in re.findall(r"\b(\d{1,2}):(\d{2})\b", src):
        h = int(hh)
        m = int(mm)
        if 0 <= h <= 23 and 0 <= m <= 59:
            out.append(h * 60 + m)

    for hh, mm in re.findall(r"\b(\d{1,2})\s*h\s*(\d{2})?\b", src, re.IGNORECASE):
        h = int(hh)
        m = int(mm or 0)
        if 0 <= h <= 23 and 0 <= m <= 59:
            out.append(h * 60 + m)

    for hh, mm in re.findall(r"\b(\d{1,2})\s*gi(?:ờ|o)\s*(\d{2})?\b", src, re.IGNORECASE):
        h = int(hh)
        m = int(mm or 0)
        if 0 <= h <= 23 and 0 <= m <= 59:
            out.append(h * 60 + m)

    return out


def _keep_bridge_block(header_time: str, yl: str, db: str, cutoff_hour: int = BRIDGE_KEEP_BEFORE_HOUR) -> bool:
    cutoff_min = int(cutoff_hour) * 60
    header_min = _parse_time_to_minutes(header_time)

    # Nếu header đã từ 07:00 trở đi thì không thuộc tua trực nối ca.
    if header_min is not None and header_min >= cutoff_min:
        return False

    explicit = _extract_explicit_minutes(yl)
    if explicit:
        return any(x < cutoff_min for x in explicit)

    explicit_db = _extract_explicit_minutes(db)
    if explicit_db:
        return any(x < cutoff_min for x in explicit_db)

    # Không có giờ thực hiện rõ ràng -> giữ theo giờ ra y lệnh/header.
    return True


def _filter_lines_by_hour_ge_plan_start(text: str, start_hour: int = PLAN_START_HOUR) -> str:
    """Lọc các dòng Y lệnh theo mốc giờ.

    - Mốc mặc định: >= 05:00 (phục vụ dự trù/DHST trong ngày làm việc).
    - Vẫn giữ các dòng không có giờ rõ ràng.
    """
    out: List[str] = []
    for line in (text or "").splitlines():
        s = line.strip()
        if not s:
            continue

        # Bắt giờ theo các dạng hay gặp: 5:00, 05:00, 5h00, 05h00, 5 giờ 00
        mm = re.search(r"\b(\d{1,2})\s*(?::|h|giờ)\s*(\d{2})\b", s, re.IGNORECASE)
        if mm:
            try:
                hh = int(mm.group(1))
                if hh >= int(start_hour):
                    out.append(s)
            except Exception:
                out.append(s)
            continue

        # Nếu chỉ có dạng '5h' / '5 giờ' (không có phút) thì vẫn lọc theo giờ
        mh = re.search(r"\b(\d{1,2})\s*(?:h|giờ)\b", s, re.IGNORECASE)
        if mh:
            try:
                hh = int(mh.group(1))
                if hh >= int(start_hour):
                    out.append(s)
            except Exception:
                out.append(s)
            continue

        # Không nhận diện được giờ -> giữ nguyên
        out.append(s)

    return "\n".join(out).strip()


def _filter_bridge_block_lines(text: str, cutoff_hour: int) -> str:
    """Lọc từng dòng trong Y lệnh của bridge block đã được giữ lại.
    Bỏ các dòng mà TẤT CẢ giờ trong dòng đó đều >= cutoff_hour.
    Giữ các dòng không có giờ rõ ràng hoặc có ít nhất 1 giờ < cutoff_hour."""
    cutoff_min = cutoff_hour * 60
    out: List[str] = []
    for line in (text or "").splitlines():
        s = line.strip()
        if not s:
            continue
        mins_in_line = _extract_explicit_minutes(s)
        if mins_in_line and all(x >= cutoff_min for x in mins_in_line):
            continue  # dòng chỉ có giờ >= 07:00 → bỏ
        out.append(s)
    return "\n".join(out).strip()




def _is_start_boundary_block(header_time: str, keep_from_hour: int = START_BOUNDARY_KEEP_FROM_HOUR) -> bool:
    """Giữ block ở ngày đầu chỉ khi mốc giờ >= 07:00.

    Khi người dùng chọn từ 29/04, tua trực thực tế bắt đầu 07:00 ngày 29/04.
    Các mốc 00:00-06:59 ngày 29/04 thuộc tua trực 28/04 nên không đưa vào
    ngày làm việc 29/04.
    """
    header_min = _parse_time_to_minutes(header_time)
    if header_min is None:
        return True
    return header_min >= int(keep_from_hour) * 60



def _clean_ward_diag(value: Any) -> str:
    text = _compact_text(str(value or ""))
    # HTML header có thể còn ngoặc đóng cuối vì chẩn đoán chứa ngoặc lồng nhau.
    while text.endswith(")") and text.count("(") < text.count(")"):
        text = text[:-1].rstrip()
    return text.strip(" -")


def extract_ward_admissions_from_html(html: str) -> List[Dict[str, Any]]:
    """Đọc các header "Khoa điều trị thứ N ... (Ngày vào: ...)" trong tab Y lệnh.

    Trang Lịch sử/Y lệnh có thể chia timeline theo nhiều khoa điều trị. Hàm này
    trả về danh sách mốc vào khoa theo thứ tự tăng dần (thứ 1, thứ 2, ...), để
    pipeline lấy y lệnh vẫn biết đầy đủ người bệnh đã vào khoa nào lúc nào.
    """
    if BeautifulSoup is None:
        raise RuntimeError("Thiếu bs4. Hãy cài: pip install beautifulsoup4")

    soup = BeautifulSoup(html or "", "html.parser")
    out: List[Dict[str, Any]] = []
    seen = set()

    for h in soup.find_all(["h1", "h2", "h3", "h4", "h5", "h6"]):
        text = _compact_text(h.get_text(" ", strip=True) or "")
        if "Khoa điều trị thứ" not in text:
            continue
        m = WARD_HEADER_RE.search(text)
        if not m:
            continue

        thu_tu_raw, khoa, thoi_gian, chan_doan = m.groups()
        try:
            thu_tu = int(thu_tu_raw)
        except Exception:
            thu_tu = None
        ward_id = ""
        onclick = h.get("onclick") or ""
        mid = WARD_ONCLICK_ID_RE.search(str(onclick))
        if mid:
            ward_id = mid.group(1).strip()

        item: Dict[str, Any] = {
            "thu_tu": thu_tu,
            "thoi_gian_vao_khoa": _compact_text(thoi_gian),
            "khoa_dieu_tri": _compact_text(khoa),
            "ten_khoa_dieu_tri": _compact_text(khoa),
        }
        diag = _clean_ward_diag(chan_doan)
        if diag:
            item["chan_doan"] = diag
        if ward_id:
            item["khoa_id"] = ward_id

        sig = (item.get("thu_tu"), item.get("thoi_gian_vao_khoa"), item.get("ten_khoa_dieu_tri"))
        if sig in seen:
            continue
        seen.add(sig)
        out.append(item)

    def sort_key(x: Dict[str, Any]) -> Tuple[int, str]:
        n = x.get("thu_tu")
        return (int(n) if isinstance(n, int) else 9999, str(x.get("thoi_gian_vao_khoa") or ""))

    return sorted(out, key=sort_key)


def extract_timeline_map_from_html(
    html: str,
    bridge_end_date: Optional[str] = None,
    bridge_keep_before_hour: int = BRIDGE_KEEP_BEFORE_HOUR,
    start_boundary_date: Optional[str] = None,
    start_keep_from_hour: int = START_BOUNDARY_KEEP_FROM_HOUR,
) -> Tuple[Dict[str, Dict[str, Any]], Optional[str]]:
    """
    Parse HTML of LSYLenh page (or patient page if it already contains timeline)
    and return:
      - out: { 'dd/mm/yyyy': {'Y lệnh': '...', 'Diễn biến': '...', 'Bác sĩ': '...', 'bac_si_theo_gio': {...}} }
      - first_doctor: first found doctor (compat)

    Nếu start_boundary_date được truyền vào, các block trước 07:00 của ngày này
    bị bỏ vì thuộc tua trực ngày trước, không thuộc ngày bắt đầu người dùng chọn.
    """
    if BeautifulSoup is None:
        raise RuntimeError("Thiếu bs4. Hãy cài: pip install beautifulsoup4")

    soup = BeautifulSoup(html or "", "html.parser")
    blocks = soup.find_all("div", class_="vertical-timeline-block")

    entries: Dict[str, List[Tuple[str, str, str, str]]] = {}
    first_doctor: Optional[str] = None

    for block in blocks:
        label = block.find("label")
        label_text = label.get_text(" ", strip=True) if label else block.get_text(" ", strip=True)

        mdate = DATE_FULL_RE.search(label_text)
        if not mdate:
            continue
        date_full = mdate.group(1)

        mtime = TIME_RE.search(label_text)
        if mtime:
            tval = mtime.group(1)
        else:
            mhr = re.search(r"\b(\d{1,2})\s*(?:h|giờ)\b", label_text, re.IGNORECASE)
            tval = f"{int(mhr.group(1)):02d}:00" if mhr else "00:00"

        doctor = ""
        try:
            bdoc = block.find(lambda tag: tag.name in {"b", "strong"} and (tag.get_text(" ", strip=True) or "").strip().lower().startswith("bác sĩ"))
            cand = bdoc.get_text(" ", strip=True) if bdoc else ""
            if cand:
                mdoc = DOC_RE.search(cand)
                if mdoc:
                    doctor = (mdoc.group(1) or "").strip()
            if not doctor:
                mdoc2 = DOC_RE.search(block.get_text("\n", strip=True) or "")
                if mdoc2:
                    doctor = (mdoc2.group(1) or "").strip()
        except Exception:
            doctor = ""

        if doctor and first_doctor is None:
            first_doctor = doctor

        hide = block.find("div", id=re.compile(r"^hide"))
        if not hide:
            continue

        cols = hide.find_all("div", class_="col-sm-6", recursive=False)
        if len(cols) < 2:
            continue
        left, right = cols[0], cols[1]

        db = ""
        ta = left.find("textarea")
        if ta:
            db = ta.get_text("\n", strip=True) or ""

        right_ibox = right.find("div", class_="ibox-content") or right
        yl_text = right_ibox.get_text("\n", strip=True) or ""

        lines = [ln.strip() for ln in yl_text.splitlines() if ln.strip()]
        filtered: List[str] = []
        for ln in lines:
            low = ln.strip().lower()
            if low in {"y lệnh", "y lenh"}:
                continue
            if low.startswith("bác sĩ:"):
                continue
            filtered.append(ln)
        yl = "\n".join(filtered).strip()

        yl = _filter_lines_by_hour_ge_plan_start(_compact_text(yl))
        db = _compact_text(db)

        entries.setdefault(date_full, []).append((tval, doctor, yl, db))

    out: Dict[str, Dict[str, Any]] = {}
    for d, items in entries.items():
        def key_fn(x: Tuple[str, str, str, str]) -> int:
            try:
                hh, mm = x[0].split(":")
                return int(hh) * 60 + int(mm)
            except Exception:
                return 0

        items_sorted = sorted(items, key=key_fn)

        # Ngày đầu người dùng chọn bắt đầu từ 07:00.
        # Ví dụ chọn 29/04 → 03/05: mốc 05:00 ngày 29/04 thuộc ca 28/04,
        # không được hiện/nhập trong chăm sóc ngày 29/04.
        if start_boundary_date and d == start_boundary_date:
            items_sorted = [
                item for item in items_sorted
                if _is_start_boundary_block(item[0], keep_from_hour=start_keep_from_hour)
            ]

        if bridge_end_date and d == bridge_end_date:
            kept = []
            for item in items_sorted:
                if _keep_bridge_block(item[0], item[2], item[3], cutoff_hour=bridge_keep_before_hour):
                    # Lọc thêm từng dòng bên trong block được giữ lại
                    filtered_yl = _filter_bridge_block_lines(item[2], bridge_keep_before_hour)
                    kept.append((item[0], item[1], filtered_yl, item[3]))
            items_sorted = kept
        bac_si_theo_gio: Dict[str, str] = {}
        yl_parts: List[str] = []
        db_parts: List[str] = []

        for t, doc, yl, db in items_sorted:
            if doc:
                bac_si_theo_gio[t] = doc
            prefix = f"{t} | Bác sĩ: {doc}".strip() if (t or doc) else ""
            if yl:
                yl_parts.append((prefix + "\n" + yl).strip() if prefix else yl.strip())
            if db:
                db_parts.append((prefix + "\n" + db).strip() if prefix else db.strip())

        seen = set()
        doc_summary_parts: List[str] = []
        for t, doc in bac_si_theo_gio.items():
            key = (t, doc)
            if key in seen:
                continue
            seen.add(key)
            if doc:
                doc_summary_parts.append(f"{t} {doc}".strip())

        out[d] = {
            "Y lệnh": "\n---\n".join(yl_parts).strip(),
            "Diễn biến": "\n---\n".join(db_parts).strip(),
            "Bác sĩ": "; ".join(doc_summary_parts).strip(),
            "bac_si_theo_gio": bac_si_theo_gio,
        }

    return out, first_doctor


def _get_text(el) -> str:
    try:
        # Dùng separator để các ô có <br> không bị dính chữ, ví dụ: "Ra việnĐỡ giảm" -> "Ra viện Đỡ giảm".
        return el.get_text(" ", strip=True)
    except Exception:
        return ""


def parse_noitru_page(html: str, base_url: str) -> Tuple[List[Dict[str, Any]], Dict[str, str], Optional[str]]:
    """
    Parse one inpatient list page:
      - rows: list of dict (header->cell text)
      - view_link_by_ma_bn: map(ma_bn -> absolute_url_to_patient_view)
      - next_page_url: absolute url or None
    """
    if BeautifulSoup is None:
        raise RuntimeError("Thiếu bs4. Hãy cài: pip install beautifulsoup4")

    soup = BeautifulSoup(html or "", "html.parser")
    table = soup.find("table", id="tblNoiTru")
    rows_out: List[Dict[str, Any]] = []
    link_map: Dict[str, str] = {}

    headers: List[str] = []
    if table:
        headers = [_get_text(th) for th in table.find_all("th")]
        body = table.find("tbody")
        rows = body.find_all("tr") if body else table.find_all("tr")[1:]
        for row in rows:
            cols = row.find_all("td")
            if len(cols) <= 1:
                continue
            r_data: Dict[str, Any] = {}
            for i, col in enumerate(cols):
                if i < len(headers):
                    val = _get_text(col)
                    if ("Tên" in headers[i] or "Họ" in headers[i]) and col.find("a"):
                        val = _get_text(col.find("a"))
                    r_data[headers[i]] = val
            rows_out.append(r_data)

            # capture patient nursing/detail view href from same row.
            # Ưu tiên nút con mắt điều dưỡng (wpid=dieuduongdraw), vì trang này có lblNgayRaVien.
            a_view = row.find("a", href=True, attrs={"href": re.compile(r"wpid=dieuduongdraw", re.IGNORECASE)})
            if not a_view:
                a_view = row.find("a", href=True, class_=re.compile(r"btn-outline|btn|fa-eye", re.IGNORECASE))
            if not a_view:
                # fallback: first link with href in row
                a_view = row.find("a", href=True)

            href = a_view.get("href") if a_view else None
            if href:
                ma_bn = ""
                # common keys
                for k in ("Mã BN", "Mã YT", "Ma BN", "Ma YT"):
                    if r_data.get(k):
                        ma_bn = str(r_data.get(k)).strip()
                        break
                if ma_bn:
                    link_map[ma_bn] = urljoin(base_url, href)

    # next page
    next_url: Optional[str] = None
    pag = soup.find("ul", class_=re.compile(r"\bpagination\b", re.IGNORECASE))
    if pag:
        # prioritize the '›' used in your Selenium selector
        candidates = pag.find_all("a", href=True)
        for a in candidates:
            txt = _get_text(a)
            if "›" in txt or txt in {">", "»", "Next", "Trang sau"}:
                li = a.find_parent("li")
                if li and ("disabled" in (li.get("class") or [])):
                    continue
                next_url = urljoin(base_url, a["href"])
                break

    return rows_out, link_map, next_url
