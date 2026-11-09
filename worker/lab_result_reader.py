"""Đọc kết quả xét nghiệm (XN) trong một ngày của người bệnh đang mở trên EMR.

CHỈ ĐỌC: mở Thăm khám → Xem kết quả → tab Lịch sử XN, đọc danh sách phiếu
trong đúng ngày cần xem, rồi mở từng phiếu Hoàn tất để đọc chỉ số. Không bấm
Lưu/Hoàn tất/Xóa ở bất kỳ đâu.

Cấu trúc HTML lấy theo bộ đọc đã chạy trên EMR thật ở
research/nghien_cuu_1/lay_lich_su_xn_cdha.py (bảng phiếu trong
#divLichSuXNContent, chi tiết trong #divLSCT > #divDsChiSoContent).

Khác bộ đọc nghiên cứu ở hai điểm để không gán nhầm kết quả:
- Trước khi mở mỗi phiếu, xóa nội dung chi tiết cũ đang hiện trên trang
  (chỉ trên trình duyệt), rồi mới chờ chi tiết mới. Nếu không, phiếu thứ hai có
  thể đọc lại chỉ số của phiếu thứ nhất vì khung chi tiết vẫn còn chữ cũ.
- Không đoán "không có XN" khi tab không tải được hoặc bảng khác mẫu:
  trả trạng thái lỗi kèm lý do, để màn hình báo "chưa lấy được" chứ không báo "không có".
"""

import re
import time
import unicodedata
from typing import Any, Dict, List, Optional, Tuple

from bs4 import BeautifulSoup

DONE_TEXT = "Hoàn tất"
DATE_RE = re.compile(r"(\d{1,2})/(\d{1,2})/(\d{4})")

# Trạng thái kết quả của một người bệnh trong một ngày.
STATUS_OK = "ok"            # đọc xong; có phiếu XN trong ngày
STATUS_NONE = "none"        # đọc xong; EMR không có phiếu XN nào trong ngày
STATUS_ERROR = "error"      # chưa đọc được (lỗi tải, lỗi mở phiếu, bảng khác mẫu)


class LabStructureError(RuntimeError):
    """Bảng trên EMR khác mẫu đang biết: không đọc tiếp để tránh gán nhầm."""


def _text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _fold(value: Any) -> str:
    s = unicodedata.normalize("NFD", _text(value).lower())
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    return s.replace("đ", "d")


def normalize_day(value: Any) -> str:
    m = DATE_RE.search(str(value or ""))
    if not m:
        return ""
    return "%02d/%02d/%s" % (int(m.group(1)), int(m.group(2)), m.group(3))


_EMPTY_TOKENS = ("khong co", "khong tim thay", "chua co", "no data", "empty")


def _looks_empty(text: str) -> bool:
    folded = _fold(text)
    return bool(folded) and any(tok in folded for tok in _EMPTY_TOKENS)


def parse_lab_listing(html: str, day: str) -> List[Dict[str, Any]]:
    """Danh sách phiếu XN trong tab Lịch sử XN, chỉ giữ phiếu có TG chỉ định đúng ``day``.

    Cột theo mẫu EMR: [0] chọn, [1] STT/xem, [2] TG chỉ định, [3] người chỉ định,
    [4] loại XN, [5] trạng thái. Dòng 1 ô có colspan là tên khoa/phòng.
    """
    target = normalize_day(day)
    if not target:
        raise ValueError("Ngày cần đọc không đúng dạng dd/mm/yyyy")
    soup = BeautifulSoup(html or "", "html.parser")
    table = soup.find("table", id="tbDichVu") or soup.find("table")
    if table is None:
        text = soup.get_text(" ", strip=True)
        if not text or _looks_empty(text):
            return []
        raise LabStructureError("Tab Lịch sử XN có nội dung nhưng không có bảng phiếu như mẫu")

    phong = ""
    data_rows = 0
    parsed_rows = 0
    items: List[Dict[str, Any]] = []
    for tr in table.find_all("tr"):
        tds = tr.find_all("td")
        if not tds:
            continue
        if len(tds) == 1 and tds[0].get("colspan"):
            phong = _text(tds[0].get_text(" ", strip=True))
            continue
        if len(tds) < 6:
            if not _looks_empty(tr.get_text(" ", strip=True)):
                data_rows += 1
            continue
        data_rows += 1
        tg = _text(tds[2].get_text(" ", strip=True))
        if not DATE_RE.search(tg):
            continue
        parsed_rows += 1
        if normalize_day(tg) != target:
            continue
        trang_thai = _text(tds[5].get_text(" ", strip=True))
        items.append({
            "ma_phieu": _text(tr.get("id", "")),
            "tg_chi_dinh": tg,
            "nguoi_chi_dinh": _text(tds[3].get_text(" ", strip=True)),
            "loai_xn": _text(tds[4].get_text(" ", strip=True)),
            "trang_thai": trang_thai,
            "hoan_tat": DONE_TEXT.casefold() in trang_thai.casefold(),
            "phong": phong,
            "ket_qua": [],
        })
    if data_rows and not parsed_rows:
        raise LabStructureError(
            "Tab Lịch sử XN có %d dòng nhưng không dòng nào có thời gian chỉ định như mẫu" % data_rows
        )
    return items


def _abnormal(td: Any) -> str:
    style = str(td.get("style", "")).lower()
    css = " ".join(td.get("class") or []).lower()
    combined = style + " " + css
    if "red" in combined or "danger" in combined:
        return "bat_thuong"
    if "blue" in combined:
        return "thap"
    return ""


_HEADER_NAMES = {
    "chi so", "xet nghiem", "ten xet nghiem", "ket qua", "don vi", "tham chieu",
    "khoang tham chieu", "chi so binh thuong",
}


def _is_unit(value: str) -> bool:
    v = _text(value).lower().replace("μ", "µ")
    if not v:
        return False
    if v in {"%", "fl", "pl", "pg", "g", "mg", "s", "sec", "u/l", "iu/l"}:
        return True
    return "/" in v and not re.fullmatch(r"[-+]?\d+(?:[.,]\d+)?\s*/\s*[-+]?\d+(?:[.,]\d+)?", v)


def parse_lab_detail(html: str) -> List[Dict[str, str]]:
    """Chỉ số của một phiếu XN (khung #divDsChiSoContent).

    Dòng có 2–5+ ô; có thể có ô STT ở đầu. Giữ nguyên chữ của ô kết quả.
    """
    soup = BeautifulSoup(html or "", "html.parser")
    box = soup.find(id="divDsChiSoContent") or soup
    rows: List[Dict[str, str]] = []
    for tr in box.find_all("tr"):
        tds = tr.find_all("td")
        cells = [_text(td.get_text(" ", strip=True)) for td in tds]
        if len(cells) < 2:
            continue
        has_index = bool(re.fullmatch(r"\d+[.)]?", cells[0])) or (not cells[0] and len(cells) >= 3)
        if has_index:
            if len(cells) < 3:
                continue
            name, result, rest, result_td = cells[1], cells[2], cells[3:], tds[2]
        else:
            name, result, rest, result_td = cells[0], cells[1], cells[2:], tds[1]
        if not name or not result:
            continue
        if _fold(name) in _HEADER_NAMES or _fold(result) in _HEADER_NAMES:
            continue
        ref, unit = "", ""
        if len(rest) >= 2:
            ref, unit = rest[0], rest[1]
        elif len(rest) == 1:
            if _is_unit(rest[0]):
                unit = rest[0]
            else:
                ref = rest[0]
        rows.append({
            "chi_so": name,
            "ket_qua": result,
            "tham_chieu": ref,
            "don_vi": unit,
            "bat_thuong": _abnormal(result_td),
        })
    return rows


def summarize(phieu: List[Dict[str, Any]]) -> Dict[str, int]:
    done = [p for p in phieu if p.get("hoan_tat")]
    return {
        "so_phieu": len(phieu),
        "so_phieu_hoan_tat": len(done),
        "so_phieu_cho": len(phieu) - len(done),
        "so_chi_so": sum(len(p.get("ket_qua") or []) for p in done),
        "so_bat_thuong": sum(1 for p in done for r in (p.get("ket_qua") or []) if r.get("bat_thuong")),
    }


# ── Selenium (chỉ đọc) ───────────────────────────────────────────────────────

_CLICK_XN_TAB_JS = r"""
const byId = document.getElementById('litabLichSuXN');
const fire = el => { try { el.scrollIntoView({block:'center'}); } catch (e) {} el.click(); return true; };
if (byId) { const a = byId.querySelector('a') || byId; return fire(a) && 'id'; }
const a = document.querySelector('a[href*="LichSuXN"], [onclick*="LichSuXN"]');
if (a) return fire(a) && 'href';
return '';
"""

_LISTING_STATE_JS = r"""
const el = document.getElementById('divLichSuXNContent');
if (!el) return {exists:false};
const txt = (el.innerText || el.textContent || '').trim();
const low = txt.toLowerCase();
return {
  exists: true,
  rows: el.querySelectorAll('tr').length,
  text: txt.length,
  loading: low.indexOf('đang tải') >= 0 || low.indexOf('loading') >= 0 || low.indexOf('vui lòng đợi') >= 0,
  empty: /không có|không tìm thấy|chưa có/i.test(txt),
};
"""

_CLEAR_DETAIL_JS = r"""
const box = document.getElementById('divLSCT');
if (box) box.innerHTML = '';
return !!box;
"""

_OPEN_DETAIL_JS = r"""
const tr = document.getElementById(arguments[0]);
if (!tr) return 'no-row';
const el = tr.querySelector('span.ylenh-a, a.ylenh-a, .ylenh-a');
if (!el) return 'no-link';
el.click();
return 'ok';
"""

_DETAIL_STATE_JS = r"""
const box = document.getElementById('divLSCT');
if (!box) return {exists:false, rows:0, html:0};
return {exists:true, rows: box.querySelectorAll('#divDsChiSoContent tr').length, html: box.innerHTML.length};
"""


def _wait(predicate, timeout: float, step: float = 0.25):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = predicate()
            if last:
                return last
        except Exception:
            last = None
        time.sleep(step)
    return last


def _open_results_popup(driver: Any) -> bool:
    # Dùng chung cách mở "Xem kết quả" với bộ đọc CĐHA của Kiểm hồ sơ (đã chạy trên EMR thật).
    from hchanh_fetch import _open_results_popup_action  # nạp lúc cần, module lớn

    return bool(_open_results_popup_action(driver))


def _read_listing_html(driver: Any, timeout: float = 15.0) -> Tuple[str, str]:
    """Bấm tab Lịch sử XN, chờ bảng tải xong. Trả (html, lỗi)."""
    if not driver.execute_script(_CLICK_XN_TAB_JS):
        return "", "Không thấy tab Lịch sử XN trong cửa sổ Xem kết quả"

    def ready():
        st = driver.execute_script(_LISTING_STATE_JS) or {}
        if not st.get("exists") or st.get("loading"):
            return None
        return st if (st.get("rows") or st.get("empty")) else None

    if not _wait(ready, timeout):
        return "", "Tab Lịch sử XN không tải xong sau %d giây" % int(timeout)
    time.sleep(0.3)  # bảng có thể còn thêm dòng ngay sau dòng đầu
    return driver.execute_script(
        "return (document.getElementById('divLichSuXNContent')||{}).innerHTML || '';"
    ) or "", ""


def _read_one_detail(driver: Any, ma_phieu: str, timeout: float = 10.0) -> List[Dict[str, str]]:
    if not driver.execute_script(_CLEAR_DETAIL_JS):
        raise LabStructureError("Không thấy khung chi tiết phiếu XN (#divLSCT)")
    opened = driver.execute_script(_OPEN_DETAIL_JS, ma_phieu)
    if opened != "ok":
        raise LabStructureError("Không mở được phiếu XN %s (%s)" % (ma_phieu, opened))

    last = {"html": -1}

    def stable():
        st = driver.execute_script(_DETAIL_STATE_JS) or {}
        if not st.get("rows"):
            return None
        same = st.get("html") == last["html"]
        last["html"] = st.get("html")
        return st if same else None

    if not _wait(stable, timeout, step=0.3):
        raise RuntimeError("Phiếu XN %s không hiện chỉ số sau %d giây" % (ma_phieu, int(timeout)))
    html = driver.execute_script("return (document.getElementById('divLSCT')||{}).innerHTML || '';") or ""
    rows = parse_lab_detail(html)
    if not rows:
        raise RuntimeError("Phiếu XN %s đã mở nhưng không đọc được chỉ số nào" % ma_phieu)
    return rows


def read_lab_results_for_day(driver: Any, day: str) -> Dict[str, Any]:
    """Đọc XN trong ``day`` của người bệnh đang mở (trang hồ sơ mở bằng tên).

    Trả {status, phieu, tom_tat, error}. ``status`` là ok/none/error.
    """
    out: Dict[str, Any] = {"status": STATUS_ERROR, "phieu": [], "tom_tat": summarize([]), "error": ""}
    try:
        if not _open_results_popup(driver):
            out["error"] = "Không mở được cửa sổ Xem kết quả"
            return out
        html, err = _read_listing_html(driver)
        if err:
            out["error"] = err
            return out
        phieu = parse_lab_listing(html, day)
        failed = []
        for item in phieu:
            if not item["hoan_tat"]:
                continue
            if not item["ma_phieu"]:
                raise LabStructureError("Phiếu XN Hoàn tất không có mã để mở chi tiết")
            try:
                item["ket_qua"] = _read_one_detail(driver, item["ma_phieu"])
            except LabStructureError:
                raise
            except Exception as exc:
                item["loi"] = str(exc)
                failed.append(item["ma_phieu"])
        out["phieu"] = phieu
        out["tom_tat"] = summarize(phieu)
        if failed:
            out["error"] = "Chưa đọc được %d/%d phiếu Hoàn tất" % (
                len(failed), out["tom_tat"]["so_phieu_hoan_tat"])
            return out
        out["status"] = STATUS_OK if phieu else STATUS_NONE
        return out
    except LabStructureError as exc:
        out["error"] = str(exc)
        return out
    except Exception as exc:  # lỗi Selenium bất kỳ: báo chưa đọc được, không coi là "không có"
        out["error"] = "%s: %s" % (type(exc).__name__, exc)
        return out
