# -*- coding: utf-8 -*-
"""TH6 Phòng khám: người bệnh (BHYT) xử trí Điều trị ngoại trú từ Khoa Khám Bệnh.

Làm theo từng màn một lượt (đỡ tốn thời gian hơn đi từng người qua mọi màn):
  1. D/s tiếp nhận ngoại trú: nhập khoa người "Chờ nhập khoa" (giờ vào khoa giữ nếu hợp lệ,
     Người nhận = Bác sĩ nhận bệnh, chọn mã bệnh án khi chỉ có 1).
  2. D/s Phẫu thuật: ca mổ chưa hoàn tất → điền và Kết thúc mổ (Gây Tê Tại Chỗ, Nằm ngửa,
     chẩn đoán trước = sau, BS mổ chính = Gây mê chính = bác sĩ trong Lịch Phòng khám,
     bắt đầu = vào khoa + 1 phút, kết thúc = bắt đầu + 15 phút).
  3. Ds điều trị ngoại trú: Tổng kết ra khoa (Dấu hiệu LS, KQ XN-CLS, PP điều trị lấy từ hồ sơ)
     rồi Kết thúc điều trị (không có KQ XN-CLS thì ghi ".").
Không tự đồng ý hộp xác nhận; thiếu dữ liệu thì dừng ở người đó và báo lại.
"""
from __future__ import annotations

import re
import time
from datetime import datetime, timedelta
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse

from clinic_outpatient import compact, norm, wait_page

try:
    from bs4 import BeautifulSoup
except ModuleNotFoundError:  # pragma: no cover
    BeautifulSoup = None  # type: ignore

DT_RE = re.compile(r"(\d{1,2}):(\d{2})\s+(\d{1,2})/(\d{1,2})/(\d{4})")
WPID_TIEPNHAN = "danhsachtiepnhanngoaitrudraw"
WPID_NGOAITRU = "danhsachdieutringoaitrudraw"
WPID_PHAUTHUAT = "danhsachphauthuatdraw"
AFTER_EXAM_MINUTES = 3
PT_MINUTES = 15
ANESTHESIA = "Gây Tê Tại Chỗ"
POSITION = "Nằm ngửa"
NO_RESULT = "."  # người bệnh không có kết quả XN, CLS nào


def parse_dt(value: Any) -> Optional[datetime]:
    m = DT_RE.search(str(value or ""))
    if not m:
        return None
    hh, mi, dd, mo, yy = (int(x) for x in m.groups())
    try:
        return datetime(yy, mo, dd, hh, mi)
    except ValueError:
        return None


def fmt_dt(dt: datetime) -> str:
    return dt.strftime("%H:%M %d/%m/%Y")


# ── Đọc các danh sách ───────────────────────────────────────────────────────

_HEADER_KEYS = {
    "thoi gian": "thoi_gian", "thoi gian vao khoa": "vao_khoa", "ma bn": "ma_bn", "ho ten": "ho_ten",
    "doi tuong": "doi_tuong", "noi chuyen den": "noi_chuyen", "khoa tiep nhan": "khoa", "trang thai": "trang_thai",
    "chan doan": "chan_doan", "noi chuyen mo": "noi_chuyen", "noi dung phau thuat": "noi_dung",
}


def _table_rows(table: Any, id_param: str) -> List[Dict[str, Any]]:
    headers = [_HEADER_KEYS.get(norm(th.get_text(" ")), "") for th in table.find_all("th")]
    out = []
    body = table.find("tbody") or table
    for tr in body.find_all("tr"):
        tds = tr.find_all("td")
        if not tds:
            continue
        row: Dict[str, Any] = {}
        for key, td in zip(headers, tds):
            if key and key not in row:
                row[key] = compact(td.get_text(" "))
        href = ""
        for a in tr.find_all("a", href=True):
            if f"{id_param}=" in a["href"]:
                href = a["href"]
                break
        if not href:
            continue
        row["href"] = href
        row["id"] = dict(parse_qsl(urlparse(href).query)).get(id_param, "")
        row["ma_bn"] = re.sub(r"\D", "", row.get("ma_bn") or "")
        row["ho_ten"] = compact(re.sub(r"\(.*?\)", "", row.get("ho_ten") or ""))
        out.append(row)
    return out


def tiepnhan_rows(html: str) -> List[Dict[str, Any]]:
    """D/s tiếp nhận ngoại trú (#tblDS)."""
    table = BeautifulSoup(html or "", "html.parser").find(id="tblDS")
    return _table_rows(table, "ttvaorakhoaid") if table else []


def ngoaitru_rows(html: str) -> List[Dict[str, Any]]:
    """Ds điều trị ngoại trú (#tblNgoaiTru)."""
    table = BeautifulSoup(html or "", "html.parser").find(id="tblNgoaiTru")
    return _table_rows(table, "ngoaitruid") if table else []


def phauthuat_rows(html: str) -> List[Dict[str, Any]]:
    """D/s Phẫu thuật (bảng trong #divDanhSachPhauThuatContent)."""
    soup = BeautifulSoup(html or "", "html.parser")
    box = soup.find(id="divDanhSachPhauThuatContent") or soup
    table = box.find("table")
    return _table_rows(table, "phauthuatid") if table else []


def is_done(status: Any) -> bool:
    return norm(status) in {"hoan tat", "da hoan tat", "ket thuc", "da ket thuc"}


# ── Quy tắc thời gian ────────────────────────────────────────────────────────

def admission_time(current: Optional[datetime], exam_time: Optional[datetime], now: datetime) -> Dict[str, Any]:
    """Giờ vào khoa: giữ giờ EMR nếu sau giờ khám (+3 phút) và không ở tương lai; sai thì = giờ khám + 3 phút."""
    earliest = exam_time + timedelta(minutes=AFTER_EXAM_MINUTES) if exam_time else None
    if current and current <= now and (not earliest or current >= earliest):
        return {"result": "ok", "value": current, "changed": False}
    if not earliest:
        return {"result": "error", "message": "Không đọc được giờ vào khoa hợp lệ và không có giờ khám để tính lại"}
    if earliest > now:
        return {"result": "waiting", "message": f"Chờ tới {earliest:%H:%M} mới nhập khoa được"}
    return {"result": "ok", "value": earliest, "changed": True}


def surgery_window(admitted: datetime, now: datetime, minutes: int = PT_MINUTES) -> Dict[str, Any]:
    """Giờ mổ: bắt đầu = giờ vào khoa + 1 phút, kết thúc = bắt đầu + `minutes`, không ở tương lai."""
    start = admitted + timedelta(minutes=1)
    end = start + timedelta(minutes=minutes)
    if end > now:
        return {"result": "waiting", "message": f"Ca mổ chưa đủ {minutes} phút, chờ tới {end:%H:%M} mới kết thúc mổ được"}
    return {"result": "ok", "start": start, "end": end}


def discharge_time(current: Optional[datetime], lower: datetime, now: datetime) -> Dict[str, Any]:
    """Thời gian ra: giữ nếu sau mốc cuối (kết thúc mổ / vào khoa) + 1 phút và không ở tương lai; sai thì = giờ hiện tại."""
    earliest = lower + timedelta(minutes=1)
    if earliest > now:
        return {"result": "waiting", "message": f"Chờ tới {earliest:%H:%M} mới kết thúc điều trị được"}
    if current and earliest <= current <= now:
        return {"result": "ok", "value": current, "changed": False}
    return {"result": "ok", "value": now, "changed": True}


def same_diagnosis_text(icd_text: str) -> str:
    """'M65.3 - Ngón tay lò xo' → 'Ngón tay lò xo' (chẩn đoán trước / sau mổ ghi giống nhau)."""
    return compact(re.sub(r"^\(?[A-Z]\d{2}(?:\.\d{1,2})?\)?\s*-?\s*", "", compact(icd_text)))


# ── Thao tác EMR ─────────────────────────────────────────────────────────────

MENU_URL_JS = ("var want='wpid='+arguments[0]+'&', links=document.querySelectorAll('a[href]');"
               " for (var i=0;i<links.length;i++){ var h=(links[i].getAttribute('href')||'')+'&'; if (h.indexOf(want)>=0) return links[i].href; }"
               " return '';")
VALUE_JS = "var e=document.getElementById(arguments[0]); return e ? String(e.value||'') : null;"
SELECTED_TEXT_JS = ("var e=document.getElementById(arguments[0]); if(!e) return ''; return [].slice.call(e.options||[])"
                    ".filter(function(o){return o.selected && o.value;}).map(function(o){return o.text.trim();}).join(', ');")
SET_VALUE_JS = ("var e=document.getElementById(arguments[0]); if(!e) return false; e.value=arguments[1];"
                " ['input','change','blur'].forEach(function(t){e.dispatchEvent(new Event(t,{bubbles:true}));});"
                " if(window.jQuery){try{jQuery(e).trigger('change');}catch(x){}} return true;")
VISIBLE_JS = ("var e=document.getElementById(arguments[0]); if(!e) return false; var s=getComputedStyle(e);"
              " return s.display!=='none' && s.visibility!=='hidden' && e.offsetParent!==null;")
ONLY_OPTION_JS = ("var s=document.getElementById(arguments[0]); if(!s) return 'missing'; if(s.value) return 'set';"
                  " var o=[].slice.call(s.options||[]).filter(function(x){return x.value;}); if(o.length!==1) return 'count:'+o.length;"
                  " s.value=o[0].value; s.dispatchEvent(new Event('change',{bubbles:true})); return 'chosen';")
# Timeline hồ sơ ngoại trú: "Diễn biến bệnh" và "Chỉ định DVKT" của lần khám.
TIMELINE_JS = r"""
var out = { dien_bien: '', dvkt: [] };
[].slice.call(document.querySelectorAll('.vertical-timeline-content b')).forEach(function (b) {
  var t = (b.innerText || '').trim();
  if (!out.dien_bien && /^Diễn biến bệnh/.test(t)) {
    var box = b.parentElement.querySelector('.ibox-content');
    // textContent giữ xuống dòng của diễn biến (innerText gộp thành 1 dòng vì không có <br>).
    if (box) out.dien_bien = box.textContent.split('\n').map(function (l) { return l.trim(); }).filter(Boolean).join('\n');
  }
  if (/Chỉ định DVKT/.test(t)) {
    var node = b.nextSibling, text = '';
    while (node && !(node.tagName === 'B')) { text += (node.innerText || node.textContent || ''); node = node.nextSibling; }
    text.split(/\n|<br>/).forEach(function (l) { l = l.replace(/^\s*-\s*/, '').trim(); if (l) out.dvkt.push(l); });
  }
});
return out;
"""
# Popup "Kết quả" của ô Kết quả XN, CLS: chọn mọi kết quả (EMR cho tối đa 10) rồi để EMR tự điền.
PICK_RESULTS_JS = r"""
var boxes = [].slice.call(document.querySelectorAll('#modalYeuCauThucHiens .ckbYeuCauTH, .ckbYeuCauTH')).slice(0, 10);
boxes.forEach(function (c) { c.checked = true; });
if (typeof OnGetValueYeucau === 'function') OnGetValueYeucau('KQXNCLS');
return boxes.length;
"""
OPEN_MODALS_JS = ("return [].slice.call(document.querySelectorAll('.modal')).filter(function(m){var s=getComputedStyle(m);"
                  " return s.display!=='none' && m.offsetParent!==null && !/modalYeuCauThucHiens/.test(m.id);})"
                  ".map(function(m){return (m.querySelector('.modal-title')||m).innerText.trim().slice(0,120);});")


class NgoaiTruFlow:
    """Các bước TH6 trên EMR, dùng chung Chrome đã đăng nhập của màn theo dõi. `dialogs` là ExamPage."""

    def __init__(self, driver: Any, config: Dict[str, Any], dialogs: Any, pause: Callable[[float], None] = time.sleep) -> None:
        self.driver = driver
        self.config = config
        self.dialogs = dialogs
        self.pause = pause
        self._wait: Any = None

    @property
    def wait(self) -> Any:
        if self._wait is None:
            from selenium.webdriver.support.ui import WebDriverWait

            self._wait = WebDriverWait(self.driver, 10)
        return self._wait

    def js(self, script: str, *args: Any) -> Any:
        return self.driver.execute_script(script, *args)

    def visible(self, element_id: str) -> bool:
        try:
            return bool(self.js(VISIBLE_JS, element_id))
        except Exception:
            return False

    def wait_for(self, element_id: str, seconds: float = 12.0) -> bool:
        end = time.time() + seconds
        while time.time() < end:
            if self.js(VALUE_JS, element_id) is not None:
                return True
            self.pause(0.3)
        return False

    def open(self, href: str) -> None:
        self.driver.get(urljoin(self.driver.current_url, href))
        wait_page(self.driver, 1.2)

    def open_list(self, wpid: str) -> str:
        """Mở danh sách theo link trên menu (giữ đúng role / phiên); không có thì tự dựng URL."""
        url = self.js(MENU_URL_JS, wpid) or ""
        if not url:
            parts = urlparse(self.driver.current_url)
            q = dict(parse_qsl(parts.query))
            q = {k: v for k, v in q.items() if k in {"scope", "lang", "usid", "role"}}
            q["wpid"] = wpid
            url = parts._replace(query=urlencode(q)).geturl()
        self.driver.get(url)
        wait_page(self.driver, 1.5)
        return self.driver.page_source or ""

    def set_value(self, element_id: str, value: str) -> None:
        if not self.js(SET_VALUE_JS, element_id, value):
            raise RuntimeError(f"Không thấy ô {element_id}")

    def pick(self, field_id: str, text: str) -> bool:
        from clinic_bbhc import PICK_OPTION_JS, SELECTED_VALUE_JS
        import input_procedures as ip
        from infusion_select2 import chon_select2_bac_si_y_ta

        if not compact(text):
            return False
        if not self.js(PICK_OPTION_JS, field_id, text):
            if not chon_select2_bac_si_y_ta(self.driver, field_id, text, timeout=10):
                ip._pick_select2_text(self.driver, self.wait, field_id, text, allow_first=False)
        return bool(self.js(SELECTED_VALUE_JS, field_id))

    def click(self, element_id: str, what: str, pause: float = 2.0) -> List[str]:
        if not self.visible(element_id):
            raise RuntimeError(f"Không thấy nút {what}")
        self.js("document.getElementById(arguments[0]).click();", element_id)
        self.pause(pause)
        wait_page(self.driver, 1.0)
        toasts = self.dialogs.check_dialogs(what)
        modals = self.js(OPEN_MODALS_JS) or []
        if modals:
            raise RuntimeError(f"{what}: EMR mở thêm hộp '{modals[0]}' — chưa tự xử lý, cần làm tay")
        return toasts

    # 1. Nhập khoa
    def admit(self, row: Dict[str, Any], exam_time: Optional[datetime], now: datetime) -> Dict[str, Any]:
        self.open(row["href"])
        if not self.wait_for("txtThoiGianVaoKhoa"):
            raise RuntimeError("Không mở được màn tiếp nhận ngoại trú")
        if not self.visible("btnNHAPKHOA"):
            return {"result": "already", "message": "Đã nhập khoa"}
        steps: List[str] = []
        rule = admission_time(parse_dt(self.js(VALUE_JS, "txtThoiGianVaoKhoa")), exam_time, now)
        if rule["result"] != "ok":
            return rule
        if rule["changed"]:
            self.set_value("txtThoiGianVaoKhoa", fmt_dt(rule["value"]))
            steps.append(f"Giờ vào khoa → {fmt_dt(rule['value'])}")
        ma = self.js(ONLY_OPTION_JS, "selectMaBenhAn")
        if isinstance(ma, str) and ma.startswith("count:"):
            raise RuntimeError(f"Có {ma[6:]} mã bệnh án để chọn — cần chọn tay")
        doctor = self.js(SELECTED_TEXT_JS, "cboBacSi") or ""
        if not doctor:
            raise RuntimeError("Chưa có Bác sĩ nhận bệnh")
        if not (self.js(SELECTED_TEXT_JS, "cboNguoiNhan") or ""):
            if not self.pick("cboNguoiNhan", doctor):
                raise RuntimeError(f"Không chọn được Người nhận: {doctor}")
            steps.append(f"Người nhận → {doctor}")
        if self.visible("btnSave"):
            self.click("btnSave", "Lưu tiếp nhận ngoại trú", 1.5)
        self.click("btnNHAPKHOA", "Nhập khoa")
        steps.append("Nhập khoa")
        return {"result": "done", "value": rule["value"], "steps": steps}

    # 2. Kết thúc mổ
    def finish_surgery(self, row: Dict[str, Any], admitted: datetime, doctor: str, now: datetime) -> Dict[str, Any]:
        self.open(row["href"])
        if not self.wait_for("txtBatDauPT"):
            raise RuntimeError("Không mở được màn phẫu thuật")
        if not self.visible("btnHOANTAT"):
            end = parse_dt(self.js(VALUE_JS, "txtKetThucPT"))
            return {"result": "already", "message": "Ca mổ đã hoàn tất", "end": end}
        if not doctor:
            raise RuntimeError("Chưa có bác sĩ phòng khám trong Lịch Phòng khám (Lịch điều dưỡng) để làm BS mổ chính")
        rule = surgery_window(admitted, now)
        if rule["result"] != "ok":
            return rule
        start, end = rule["start"], rule["end"]
        self.set_value("txtBatDauPT", fmt_dt(start))
        self.set_value("txtKetThucPT", fmt_dt(end))
        if not self.pick("cbbPPGayMePT", ANESTHESIA):
            raise RuntimeError(f"Không chọn được phương pháp vô cảm: {ANESTHESIA}")
        self.set_value("txtTuTheMoPT", POSITION)
        for field, label in (("cbbPhuongPhapPT", "phương pháp phẫu thuật"), ("cbbICD9", "ICD 9"), ("cbbIcdChanDoanTruocPT", "chẩn đoán trước PT (ICD)")):
            if not self.js(SELECTED_TEXT_JS, field):
                raise RuntimeError(f"Chưa có {label} — cần chọn tay")
        before = self.js(SELECTED_TEXT_JS, "cbbIcdChanDoanTruocPT")
        if not self.js(SELECTED_TEXT_JS, "cbbChuanDoanSauPT") and not self.pick("cbbChuanDoanSauPT", before):
            raise RuntimeError("Không chọn được chẩn đoán sau PT giống chẩn đoán trước")
        diag = same_diagnosis_text(before)
        self.set_value("txtChuanDoanTruocMoPT", diag)
        self.set_value("txtChuanDoanSauMoPT", diag)
        for field, label in (("cbbBacSiPT", "BS mổ chính"), ("cbbBacSiGayMeChinh", "Gây mê chính")):
            if not self.pick(field, doctor):
                raise RuntimeError(f"Không chọn được {label}: {doctor}")
        self.click("btnHOANTAT", "Kết thúc mổ", 2.5)
        return {"result": "done", "end": end,
                "steps": [f"Kết thúc mổ {start:%H:%M}–{end:%H:%M}, BS mổ chính / gây mê chính {doctor}"]}

    # 3. Tổng kết ra khoa + Kết thúc điều trị
    def discharge(self, row: Dict[str, Any], lower: datetime, now: datetime, texts: Dict[str, str]) -> Dict[str, Any]:
        self.open(row["href"])
        if not self.visible("btnHOANTAT"):
            return {"result": "already", "message": "Đã kết thúc điều trị"}
        timeline = self.js(TIMELINE_JS) or {}
        self.js("var a=[].slice.call(document.querySelectorAll('a')).filter(function(x){return /onShowXuTri_VDUH/.test(x.getAttribute('onclick')||'');})[0];"
                " if (a) onShowXuTri_VDUH(a);")
        if not self.wait_for("txtDauHieuLamSang"):
            self.dialogs.check_dialogs("Mở Tổng kết ra khoa")
            raise RuntimeError("Không mở được Tổng kết ra khoa")
        steps: List[str] = []
        if (self.js(VALUE_JS, "cbbXuTri") or "") != "0":
            self.set_value("cbbXuTri", "0")
        rule = discharge_time(parse_dt(self.js(VALUE_JS, "txtThoiGianRa")), lower, now)
        if rule["result"] != "ok":
            return rule
        if rule["changed"]:
            self.set_value("txtThoiGianRa", fmt_dt(rule["value"]))
            steps.append(f"Thời gian ra → {fmt_dt(rule['value'])}")
        self.js("if (typeof changeSoNgayDieuTri === 'function') changeSoNgayDieuTri();")
        fill = {
            "txtDauHieuLamSang": compact(texts.get("dau_hieu")) or (self.js(VALUE_JS, "txtDauHieuLamSang") or "").strip() or timeline.get("dien_bien", ""),
            "txtPPDieuTri": compact(texts.get("pp_dieu_tri")) or (self.js(VALUE_JS, "txtPPDieuTri") or "").strip() or "; ".join(timeline.get("dvkt") or []),
        }
        for field, value in fill.items():
            if value:
                self.set_value(field, value)
        cls = compact(texts.get("can_lam_sang")) or (self.js(VALUE_JS, "txtCanLamSang") or "").strip()
        if cls:
            self.set_value("txtCanLamSang", cls)
        else:
            self.js("OnShowYeuCauThucHien('KQXNCLS');")
            self.pause(1.5)
            picked = self.js(PICK_RESULTS_JS) or 0
            self.pause(1.0)
            self.js("if (window.jQuery) jQuery('#modalYeuCauThucHiens').modal('hide');")
            if picked:
                steps.append(f"KQ XN, CLS lấy từ {picked} kết quả")
            if not (self.js(VALUE_JS, "txtCanLamSang") or "").strip():
                self.set_value("txtCanLamSang", NO_RESULT)
                steps.append("Không có kết quả XN, CLS → ghi \".\"")
        missing = [label for field, label in (("txtDauHieuLamSang", "Dấu hiệu lâm sàng"), ("txtCanLamSang", "Kết quả XN, CLS"),
                                              ("txtPPDieuTri", "Phương pháp điều trị"))
                   if not (self.js(VALUE_JS, field) or "").strip()]
        if missing:
            return {"result": "incomplete", "message": f"Hồ sơ chưa có: {', '.join(missing)} — nhập tay rồi bấm lại", "steps": steps}
        self.click("btnSaveXuTri", "Lưu Tổng kết ra khoa", 2.0)
        steps.append("Lưu Tổng kết ra khoa")
        self.click("btnHOANTAT", "Kết thúc điều trị", 2.5)
        steps.append("Kết thúc điều trị")
        return {"result": "done", "message": "Đã kết thúc điều trị ngoại trú", "steps": steps}


def _find_surgeries(flow: "NgoaiTruFlow", codes: List[str]) -> List[Dict[str, Any]]:
    """D/s Phẫu thuật: đọc trang mặc định; người chưa thấy thì tìm theo mã BN như D/s Thủ thuật."""
    rows = phauthuat_rows(flow.open_list(WPID_PHAUTHUAT))
    seen = {r["ma_bn"] for r in rows}
    missing = [c for c in codes if c not in seen]
    if missing:
        import input_procedures as ip

        for code in missing:
            ip._try_search_on_list(flow.driver, flow.wait, code)
            rows += [r for r in phauthuat_rows(flow.driver.page_source or "") if r["ma_bn"] == code]
    return rows


def run_all(flow: "NgoaiTruFlow", patients: List[Dict[str, Any]], doctor: str,
            now_fn: Callable[[], datetime]) -> Dict[str, Dict[str, Any]]:
    """Làm TH6 cho nhiều người bệnh, theo từng màn một lượt. Trả kết quả theo mã BN."""
    results: Dict[str, Dict[str, Any]] = {p["ma_bn"]: {"result": "waiting", "message": "", "steps": []} for p in patients}
    by_code = {p["ma_bn"]: p for p in patients}
    admitted: Dict[str, datetime] = {}

    def fail(code: str, exc: Exception) -> None:
        results[code].update({"result": "error", "message": compact(str(exc))[:300]})

    # 1. Nhập khoa
    for row in tiepnhan_rows(flow.open_list(WPID_TIEPNHAN)):
        code = row["ma_bn"]
        if code not in by_code or "cho nhap khoa" not in norm(row.get("trang_thai")):
            continue
        try:
            res = flow.admit(row, by_code[code].get("exam_time"), now_fn())
        except Exception as exc:  # từng người một, người sau vẫn làm
            fail(code, exc)
            continue
        results[code]["steps"] += res.get("steps") or []
        if res["result"] not in {"done", "already"}:
            results[code].update({"result": res["result"], "message": res.get("message", "")})
        elif res.get("value"):
            admitted[code] = res["value"]

    # 2 + 3. Kết thúc mổ, Tổng kết ra khoa, Kết thúc điều trị
    todo = [c for c in by_code if not results[c]["message"]]  # bước 1 không lỗi / không phải chờ
    in_treatment = {r["ma_bn"]: r for r in ngoaitru_rows(flow.open_list(WPID_NGOAITRU)) if r["ma_bn"] in todo}
    surgeries = _find_surgeries(flow, list(in_treatment)) if in_treatment else []
    for code in todo:
        nt = in_treatment.get(code)
        if not nt:
            if not results[code]["message"]:
                results[code]["message"] = "Chưa thấy trong Ds điều trị ngoại trú (chưa nhập khoa?)"
            continue
        start = admitted.get(code) or parse_dt(nt.get("vao_khoa"))
        if not start:
            results[code].update({"result": "error", "message": "Không đọc được thời gian vào khoa"})
            continue
        lower = start
        try:
            stop = None
            for pt in [r for r in surgeries if r["ma_bn"] == code and not is_done(r.get("trang_thai"))]:
                res = flow.finish_surgery(pt, start, doctor, now_fn())
                results[code]["steps"] += res.get("steps") or []
                if res["result"] not in {"done", "already"}:
                    stop = res
                    break
                if res.get("end"):
                    lower = max(lower, res["end"])
            if stop:
                results[code].update({"result": stop["result"], "message": stop.get("message", "")})
                continue
            res = flow.discharge(nt, lower, now_fn(), by_code[code].get("texts") or {})
        except Exception as exc:
            fail(code, exc)
            continue
        results[code]["steps"] += res.get("steps") or []
        results[code].update({"result": res["result"], "message": res.get("message", "")})
    return results
