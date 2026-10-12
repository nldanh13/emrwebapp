"""In tường trình thủ thuật / phẫu thuật của người bệnh BHYT trong ngày, gộp thành 1 file PDF.

Chỉ đọc EMR, không ghi gì: với mỗi người bệnh BHYT có thủ thuật (TT) / phẫu thuật (PT) đã xong,
  1. D/s Thủ thuật (lọc theo ngày) / D/s Phẫu thuật, tìm theo mã BN → các dòng đã Hoàn tất;
  2. mở từng dòng, bấm nút In (#divWebpartReport) → "Phiếu kết quả thủ thuật word" / "Phiếu phẫu thuật";
  3. lấy file PDF trong khung xem (#modalReportPdf #iframe_main) bằng phiên đang đăng nhập, đóng khung.
Phiếu đã tải (cùng id thủ thuật / phẫu thuật) thì dùng lại, không mở EMR lấy lại.
"""
from __future__ import annotations

import base64
import os
import re
from datetime import date
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import parse_qsl, urljoin, urlparse

from bs4 import BeautifulSoup

from clinic_outpatient import compact, norm, wait_page

KINDS: Dict[str, Dict[str, Any]] = {
    "tt": {"label": "thủ thuật", "code": "TT", "id_param": "thuthuatid",
           # Tên trên menu In; tên đầu là tên người dùng chọn, các tên sau để dự phòng.
           "links": ["Phiếu kết quả thủ thuật word", "Phiếu kết quả thủ thuật"]},
    "pt": {"label": "phẫu thuật", "code": "PT", "id_param": "phauthuatid",
           "links": ["Phiếu phẫu thuật", "Phiếu phẫu thuật word"]},
}
DONE_WORDS = ("hoan tat", "ket thuc")
PDF_WAIT_STEPS = 60  # × 0.5 giây

LINKS_JS = r"""
var box = document.getElementById('divWebpartReport'); if (!box) return null;
var b = box.querySelector('button'); if (b && arguments[0]) b.click();
return [].slice.call(box.querySelectorAll('a')).map(function(a){ return (a.textContent || '').replace(/\s+/g, ' ').trim(); });
"""
CLICK_LINK_JS = r"""
var box = document.getElementById('divWebpartReport'); if (!box) return false;
var a = box.querySelectorAll('a')[arguments[0]]; if (!a) return false;
a.click(); return true;
"""
IFRAME_SRC_JS = r"""
var f = document.querySelector('#modalReportPdf #iframe_main') || document.getElementById('iframe_main');
if (!f) return '';
var src = f.getAttribute('src') || '';
return src ? new URL(src, document.baseURI).href : '';
"""
CLEAR_IFRAME_JS = r"""
var f = document.querySelector('#modalReportPdf #iframe_main') || document.getElementById('iframe_main');
if (f) f.setAttribute('src', '');
"""
CLOSE_MODAL_JS = r"""
var m = document.getElementById('modalReportPdf'); if (!m) return false;
var b = m.querySelector('.modal-header button, button.close, button[data-dismiss="modal"]');
if (b) b.click();
if (window.jQuery) jQuery(m).modal('hide');
return true;
"""
FETCH_PDF_JS = r"""
var done = arguments[arguments.length - 1];
fetch(arguments[0], {credentials: 'include'}).then(function(r){ return r.arrayBuffer(); })
  .then(function(b){ var s = '', a = new Uint8Array(b);
    for (var i = 0; i < a.length; i += 8192) s += String.fromCharCode.apply(null, a.subarray(i, i + 8192));
    done(btoa(s)); })
  .catch(function(){ done(''); });
"""


# ── Hàm thuần ────────────────────────────────────────────────────────────────

def done_count(row: Dict[str, Any], code: str) -> int:
    sv = next((s for s in row.get("services") or [] if s.get("code") == code), None)
    return int(sv.get("done") or 0) if sv else 0


def report_patients(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Người bệnh BHYT có thủ thuật / phẫu thuật đã xong, theo STT. Mỗi người: ma_bn, ho_ten, kinds."""
    out = []
    for r in sorted(rows, key=lambda r: int(r.get("stt") or 0) if str(r.get("stt") or "").isdigit() else 0):
        ma_bn = re.sub(r"\D", "", str(r.get("ma_bn") or ""))
        if not r.get("has_bhyt") or not ma_bn:
            continue
        kinds = [k for k in ("tt", "pt") if done_count(r, KINDS[k]["code"]) > 0]
        if kinds:
            out.append({"ma_bn": ma_bn, "ho_ten": r.get("ho_ten") or "", "khambenhid": r.get("khambenhid") or "",
                        "kinds": kinds})
    return out


def pick_report_link(texts: List[str], wanted: List[str]) -> int:
    """Vị trí link In cần bấm: trùng tên theo thứ tự ưu tiên, không có thì link chứa tên đầu. -1 nếu không có."""
    names = [norm(t) for t in texts]
    for w in wanted:
        if norm(w) in names:
            return names.index(norm(w))
    base = norm(wanted[0])
    return next((i for i, n in enumerate(names) if base in n), -1)


def done_rows(html: str, id_param: str, ma_bn: str, day_text: str) -> List[Dict[str, str]]:
    """Các dòng đã Hoàn tất / Kết thúc của người bệnh trong ngày trên D/s Thủ thuật / D/s Phẫu thuật."""
    out: List[Dict[str, str]] = []
    seen = set()
    for tr in BeautifulSoup(html or "", "html.parser").find_all("tr"):
        if tr.find("tr"):
            continue  # bảng lồng: chỉ xét dòng trong cùng
        href = next((a["href"] for a in tr.find_all("a", href=True) if f"{id_param}=" in a["href"]), "")
        if not href:
            continue
        text = compact(tr.get_text(" "))
        rid = dict(parse_qsl(urlparse(href).query)).get(id_param, "")
        if not rid or rid in seen or ma_bn not in re.sub(r"[^\d ]", " ", text).split() or day_text not in text:
            continue
        if not any(w in norm(text) for w in DONE_WORDS):
            continue
        seen.add(rid)
        out.append({"id": rid, "href": href})
    return out


def safe_id(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9-]", "", value or "")[:60]


# ── Thao tác trên EMR ───────────────────────────────────────────────────────

class ReportPrinter:
    """Dùng chung Chrome đã đăng nhập của màn theo dõi; chỉ đọc."""

    def __init__(self, driver: Any, wait: Any, config: Dict[str, Any], pdf_dir: str,
                 close_dialogs: Callable[[], Any], pause: Callable[[float], None]) -> None:
        self.driver, self.wait, self.config = driver, wait, config
        self.pdf_dir = pdf_dir
        self.close_dialogs = close_dialogs
        self.pause = pause

    def js(self, script: str, *args: Any) -> Any:
        return self.driver.execute_script(script, *args)

    def find(self, kind: str, patients: List[Dict[str, Any]], day: date) -> Dict[str, List[Dict[str, str]]]:
        """Mở danh sách 1 lần, tìm từng mã BN; trả các dòng đã xong theo mã BN."""
        import input_procedures as ip
        import clinic_ngoaitru

        day_text = day.strftime("%d/%m/%Y")
        original = ip.handle_popups
        ip.handle_popups = lambda _driver: bool(self.close_dialogs())  # đóng popup, không bấm đồng ý
        try:
            if kind == "tt":
                ip._goto_procedure_list(self.driver, self.wait, self.config)
                ip._apply_procedure_date_range_filter(self.driver, self.wait, day_text, self.config)
            else:
                flow = clinic_ngoaitru.NgoaiTruFlow(self.driver, self.config, None, self.pause)
                flow.open_list(clinic_ngoaitru.WPID_PHAUTHUAT)
            found: Dict[str, List[Dict[str, str]]] = {}
            for p in patients:
                ip._try_search_on_list(self.driver, self.wait, p["ma_bn"])
                found[p["ma_bn"]] = done_rows(self.driver.page_source or "", KINDS[kind]["id_param"], p["ma_bn"], day_text)
            return found
        finally:
            ip.handle_popups = original

    def print_one(self, kind: str, href: str, out_path: str) -> None:
        """Mở dòng thủ thuật / phẫu thuật, bấm In → phiếu, tải PDF về out_path."""
        self.driver.get(urljoin(self.driver.current_url, href))
        wait_page(self.driver, 1.2)
        self.js(CLEAR_IFRAME_JS)
        texts: Optional[List[str]] = None
        for _ in range(20):
            texts = self.js(LINKS_JS, True)
            if texts:
                break
            self.pause(0.5)
        if not texts:
            raise RuntimeError("Không thấy nút In trên phiếu")
        idx = pick_report_link(texts, KINDS[kind]["links"])
        if idx < 0:
            raise RuntimeError(f"Menu In không có \"{KINDS[kind]['links'][0]}\" (có: {', '.join(texts[:8])})")
        self.pause(0.5)
        if not self.js(CLICK_LINK_JS, idx):
            raise RuntimeError(f"Không bấm được \"{texts[idx]}\"")
        src = ""
        for _ in range(PDF_WAIT_STEPS):
            self.pause(0.5)
            src = self.js(IFRAME_SRC_JS) or ""
            if src.lower().split("?", 1)[0].endswith(".pdf"):
                break
            src = ""
        if not src:
            raise RuntimeError("EMR chưa tạo xong file PDF của phiếu")
        raw = base64.b64decode(self.driver.execute_async_script(FETCH_PDF_JS, src) or "")
        self.js(CLOSE_MODAL_JS)
        if not raw.startswith(b"%PDF"):
            raise RuntimeError("Tải file PDF của phiếu không được")
        tmp = out_path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(raw)
        os.replace(tmp, out_path)


def collect_reports(printer: Any, patients: List[Dict[str, Any]], day: date,
                    on_error: Callable[[], bool] = lambda: False) -> Tuple[List[str], List[Dict[str, Any]]]:
    """In phiếu của mọi người bệnh. Trả (file PDF theo thứ tự người bệnh, kết quả từng người).
    on_error() trả True khi EMR hết phiên: dừng, không làm tiếp."""
    files: Dict[Tuple[str, str], List[str]] = {}
    results: Dict[str, Dict[str, Any]] = {p["ma_bn"]: {"files": 0, "errors": [], "found": 0} for p in patients}
    for kind in ("tt", "pt"):
        group = [p for p in patients if kind in p["kinds"]]
        if not group:
            continue
        try:
            found = printer.find(kind, group, day)
        except Exception as e:
            for p in group:
                results[p["ma_bn"]]["errors"].append(f"Không đọc được D/s {KINDS[kind]['label']}: {compact(str(e))[:200]}")
            if on_error():
                break
            continue
        for p in group:
            rows = found.get(p["ma_bn"]) or []
            results[p["ma_bn"]]["found"] += len(rows)
            if not rows:
                results[p["ma_bn"]]["errors"].append(f"Chưa thấy {KINDS[kind]['label']} đã hoàn tất trên D/s")
            for r in rows:
                out = os.path.join(printer.pdf_dir, f"clinic_{kind}_{safe_id(r['id'])}.pdf")
                if not os.path.exists(out):
                    try:
                        printer.print_one(kind, r["href"], out)
                    except Exception as e:
                        results[p["ma_bn"]]["errors"].append(f"Phiếu {KINDS[kind]['label']}: {compact(str(e))[:200]}")
                        if on_error():
                            return _ordered(files, patients), [{**p, **results[p["ma_bn"]]} for p in patients]
                        continue
                files.setdefault((p["ma_bn"], kind), []).append(out)
                results[p["ma_bn"]]["files"] += 1
    return _ordered(files, patients), [{**p, **results[p["ma_bn"]]} for p in patients]


def _ordered(files: Dict[Tuple[str, str], List[str]], patients: List[Dict[str, Any]]) -> List[str]:
    return [f for p in patients for kind in ("tt", "pt") for f in files.get((p["ma_bn"], kind), [])]
