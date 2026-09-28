# -*- coding: utf-8 -*-
"""TH4 Phòng khám: Sổ biên bản hội chẩn (SBBHC) cho ca chuyển viện hoặc có chụp CT / MRI.

Soạn nội dung theo mẫu của khoa (hàm thuần, kiểm thử được) và thao tác trên EMR:
màn khám → Giấy tờ kèm theo → chọn mẫu SBBHC → Thêm → Sửa (mở tab mới) → điền →
Hoàn tất → lấy Phiếu in → đóng tab, quay lại màn khám. Không tự đồng ý hộp xác nhận.
"""
from __future__ import annotations

import base64
import re
import time
from datetime import datetime
from typing import Any, Dict, List, Optional

from clinic_outpatient import compact, norm, wait_page

try:
    from bs4 import BeautifulSoup
except ModuleNotFoundError:  # pragma: no cover
    BeautifulSoup = None  # type: ignore

IMAGING_RE = re.compile(r"\b(?:MS)?CT\b|\bMRI\b|c[aắ]t l[oớ]p|c[oộ]ng h[uư][oở]ng t[uừ]", re.I)
DT_RE = re.compile(r"(\d{1,2}):(\d{2})\s+(\d{1,2})/(\d{1,2})/(\d{4})")

HOP_TAI = "Khoa khám"
CHAM_SOC = "CSCIII"
TIEN_LUONG = "Trung bình"
TEXT_FIELDS = ["ThoiGianHoiChan", "HopTai", "YeuCau", "TomTat", "TinhTrang", "ChanDoanTuyenDuoi",
               "TomTatBenhAn", "NguyenNhan", "HuongDieuTri", "ChamSoc", "KetLuan"]


def _kind(match_text: str) -> str:
    return "MRI" if norm(match_text) in {"mri", "cong huong tu"} else "CT"


def _parse_dt(text: str) -> Optional[datetime]:
    m = DT_RE.search(text or "")
    if not m:
        return None
    hh, mi, dd, mo, yy = (int(x) for x in m.groups())
    try:
        return datetime(yy, mo, dd, hh, mi)
    except ValueError:
        return None


def imaging_orders(history_html: str) -> List[Dict[str, Any]]:
    """Các chỉ định chụp CT / MRI trong popup lịch sử dịch vụ: tên, loại, giờ chỉ định (nếu đọc được)."""
    if BeautifulSoup is None:
        raise RuntimeError("Thiếu beautifulsoup4")
    soup = BeautifulSoup(history_html or "", "html.parser")
    out: List[Dict[str, Any]] = []
    seen = set()
    # Mỗi dòng bảng là 1 chỉ định; không có <tr> thì coi mỗi ô / cả khối là 1 dòng.
    rows = [[compact(c.get_text(" ")) for c in tr.find_all("td")] or [compact(tr.get_text(" "))] for tr in soup.find_all("tr")]
    if not rows:
        rows = [[compact(td.get_text(" "))] for td in soup.find_all("td")] or [[compact(soup.get_text(" "))]]
    for texts in rows:
        for text in texts:
            m = IMAGING_RE.search(text)
            if not m or DT_RE.fullmatch(text.strip()):
                continue
            name = compact(DT_RE.sub("", text))
            row_text = " ".join(texts)
            when = _parse_dt(row_text)
            key = (norm(name), when)
            if key in seen:
                continue
            seen.add(key)
            out.append({"kind": _kind(m.group(0)), "name": name, "time": when})
            break
    return out


def imaging_kinds(history_html: str) -> List[str]:
    kinds: List[str] = []
    for order in imaging_orders(history_html):
        if order["kind"] not in kinds:
            kinds.append(order["kind"])
    return kinds


# ── Soạn nội dung theo mẫu ───────────────────────────────────────────────────

_ORDER_PREFIX_RE = re.compile(
    r"^.*?(?:\bMSCT\b|\bCT\b|\bMRI\b|c[aắ]t l[oớ]p vi t[ií]nh|c[aắ]t l[oớ]p|c[oộ]ng h[uư][oở]ng t[uừ])\s*(?:\d+\s*d[aã]y)?\s*", re.I)
_ORDER_SUFFIX_RE = re.compile(r"\s*(?:\(|\bc[oó] ti[eê]m\b|\bkh[oô]ng ti[eê]m\b|\bc[oó] thu[oố]c\b|\bkh[oô]ng thu[oố]c\b|-).*$", re.I)


def body_part_from_order(order_name: str) -> str:
    """'Chụp MRI khớp gối trái (không tiêm thuốc)' → 'khớp gối trái'."""
    rest = _ORDER_PREFIX_RE.sub("", compact(order_name), count=1)
    return compact(_ORDER_SUFFIX_RE.sub("", rest)).strip(" ,;:")


def pain_location(texts: List[str], order_name: str = "", diagnosis: str = "") -> str:
    """Vị trí đau: câu có chữ 'đau' trong lý do / dấu hiệu; không có thì vùng giải phẫu trong
    chẩn đoán, rồi vùng chụp. Không nhận ra thì để trống cho người dùng điền."""
    from clinic_input_care import _extract_pain_location

    for text in [*texts, f"đau {diagnosis}" if diagnosis else ""]:
        loc = compact(_extract_pain_location(text))
        if loc:
            return loc
    return body_part_from_order(order_name) if order_name else ""


def region_lines(kind: str, text: str) -> List[str]:
    """Dòng thêm theo vùng: MRI gối → đi lỏng gối; MRI / chuyển viện cột sống thắt lưng → tê lan hai chân,
    cột sống cổ → tê lan hai tay. `kind` là 'MRI', 'CT' hoặc 'transfer'."""
    t = norm(text)
    lines: List[str] = []
    if kind == "MRI" and re.search(r"\bgoi\b", t):
        lines.append("Đi lỏng gối")
    if kind in {"MRI", "transfer"}:
        if "that lung" in t:
            lines.append("Tê lan hai chân")
        if re.search(r"\bcot song co\b|\bcs co\b|\bdot song co\b", t):
            lines.append("Tê lan hai tay")
    return lines


def diagnosis_text(main: str, extras: List[str]) -> str:
    """'Bệnh chính + Bệnh kèm theo (TS: số bệnh kèm theo)' như mẫu của khoa."""
    parts = [compact(main)] + [compact(e) for e in extras if compact(e)]
    return " + ".join(p for p in parts if p) + f"(TS: {len([e for e in extras if compact(e)])})"


def build_bbhc(reason: Dict[str, Any], info: Dict[str, Any]) -> Dict[str, str]:
    """Nội dung 1 SBBHC. reason: {'type': 'imaging', 'kind', 'name', 'time'} hoặc
    {'type': 'transfer', 'hospital', 'direction', 'time'}; info: lý do / dấu hiệu / chẩn đoán đọc từ màn khám."""
    imaging = reason.get("type") == "imaging"
    order_name = compact(reason.get("name")) if imaging else ""
    kind = reason.get("kind") if imaging else "transfer"
    diag = diagnosis_text(info.get("cd_chinh") or "", info.get("cd_kem_theo") or [])
    sources = [info.get("ly_do") or "", info.get("dau_hieu") or "", info.get("so_bo") or "", info.get("cd_chinh") or ""]
    loc = pain_location(sources[:3], order_name, info.get("cd_chinh") or "")
    extra = region_lines(kind, " ".join([order_name, *sources, reason.get("direction") or ""]))
    pain = f"đau {loc}" if loc else "đau"
    tom_tat = "\n".join([f"Người bệnh tỉnh, {pain}", *extra, "Vận động hạn chế"])
    tinh_trang = "\n".join(["Người bệnh tỉnh", "Tiếp xúc tốt", "Da niêm hồng", "Mạch rõ, chi ấm",
                            pain[:1].upper() + pain[1:], *extra, "Vận động hạn chế"])
    if imaging:
        yeu_cau = order_name
        huong = order_name
    else:
        yeu_cau = compact(f"Chuyển viện {compact(reason.get('hospital'))}")
        huong = compact(reason.get("direction"))
    when = reason.get("time")
    return {
        "ThoiGianHoiChan": when.strftime("%H:%M %d/%m/%Y") if isinstance(when, datetime) else compact(when),
        "HopTai": HOP_TAI,
        "YeuCau": yeu_cau,
        "TomTat": tom_tat,
        "TinhTrang": tinh_trang,
        "ChanDoanTuyenDuoi": diag,
        "TomTatBenhAn": tom_tat,
        "NguyenNhan": diag,
        "HuongDieuTri": huong,
        "ChamSoc": CHAM_SOC,
        "KetLuan": f"Chẩn đoán: {diag}\nHướng xử lý: {huong}\nTiên lượng: {TIEN_LUONG}",
    }


def missing_fields(fields: Dict[str, str]) -> List[str]:
    """Ô bắt buộc còn trống (không tự bịa — người dùng phải điền ở bước xem trước)."""
    labels = {"ThoiGianHoiChan": "Ngày giờ hội chẩn", "YeuCau": "Nội dung yêu cầu hội chẩn",
              "ChanDoanTuyenDuoi": "Chẩn đoán", "HuongDieuTri": "Phương pháp điều trị", "ThuKy": "Thư ký"}
    out = [label for key, label in labels.items() if not compact(fields.get(key))]
    if fields.get("ThoiGianHoiChan") and not _parse_dt(fields["ThoiGianHoiChan"]):
        out.append("Ngày giờ hội chẩn sai định dạng (HH:mm dd/mm/yyyy)")
    if re.search(r"^Chuyển viện\s*$", compact(fields.get("YeuCau"))):
        out.append("Tên bệnh viện chuyển đến")
    return out


# ── Đọc trên EMR ─────────────────────────────────────────────────────────────

EXAM_INFO_JS = r"""
function val(id) { var e = document.getElementById(id); return e ? (e.value || '').trim() : ''; }
function opts(id) {
  var e = document.getElementById(id); if (!e) return [];
  return [].slice.call(e.options || []).filter(function (o) { return o.selected; })
    .map(function (o) { return (o.text || '').trim(); }).filter(Boolean);
}
return { ly_do: val('txtLyDoVaoVien'), dau_hieu: val('txtMoTaDauHieuLamSang'), so_bo: val('txtChanDoanSoBo'),
         cd_chinh: (opts('cbbCDBChinh')[0] || ''), cd_kem_theo: opts('cbbCDBKemTheo'), ket_luan: val('txtKetLuan') };
"""

# Popup Chi tiết xử trí (đã mở bằng showXuTri): các cặp nhãn → giá trị đang hiển thị.
XUTRI_FIELDS_JS = r"""
var anchor = document.getElementById('txtThoigianRa');
var box = anchor; while (box && !(box.classList && box.classList.contains('modal'))) box = box.parentElement;
box = box || document.body;
function shown(e) { return e && e.offsetParent !== null; }
var out = [];
box.querySelectorAll('label').forEach(function (l) {
  if (!shown(l)) return;
  var scope = l.parentElement, field = null;
  while (scope && scope !== box && !field) { field = scope.querySelector('input:not([type=hidden]):not([type=checkbox]),select,textarea'); if (!field) scope = scope.parentElement; }
  if (!field || !shown(field)) return;
  var v = field.tagName === 'SELECT' ? [].slice.call(field.options).filter(function (o) { return o.selected && o.value !== ''; }).map(function (o) { return o.text.trim(); }).join(', ') : (field.value || '').trim();
  out.push({ label: l.innerText.trim(), id: field.id || '', value: v });
});
// Popup Chi tiết xử trí chuyển viện: đọc thẳng các ô đã biết (select2 ẩn thẻ select gốc).
['txtThoigianRa', 'cboBenhvien', 'txtHuongdieutri'].forEach(function (id) {
  var e = document.getElementById(id); if (!e) return;
  var v = e.tagName === 'SELECT' ? [].slice.call(e.options).filter(function (o) { return o.selected && o.value !== ''; }).map(function (o) { return o.text.trim(); }).join(', ') : (e.value || '').trim();
  out.unshift({ label: id, id: id, value: v });
});
return out;
"""


def transfer_from_xutri(fields: List[Dict[str, str]]) -> Dict[str, Any]:
    """Nơi chuyển đến, hướng điều trị, giờ chuyển từ popup xử trí (đoán theo nhãn; trống thì người dùng điền)."""
    by_id = {f.get("id"): compact(f.get("value")) for f in fields if f.get("id")}
    hospital, direction, when = by_id.get("cboBenhvien", ""), by_id.get("txtHuongdieutri", ""), by_id.get("txtThoigianRa", "")
    for f in fields:
        label, value = norm(f.get("label")), compact(f.get("value"))
        if not value:
            continue
        if not hospital and any(k in label for k in ("noi chuyen", "chuyen den", "benh vien", "co so kcb", "noi den")):
            hospital = value
        elif not direction and any(k in label for k in ("huong dieu tri", "phuong phap dieu tri", "huong xu tri")):
            direction = value
        elif not when and (f.get("id") == "txtThoigianRa" or "thoi gian ra" in label or "thoi gian chuyen" in label):
            when = value
    return {"type": "transfer", "hospital": hospital, "direction": direction, "time": _parse_dt(when) or when}


HSKT_ROWS_JS = r"""
var box = document.getElementById('divContentHSKT'); if (!box) return null;
return [].slice.call(box.querySelectorAll('tr')).map(function (tr) {
  var a = tr.querySelector('a[title="Sửa"]'); var m = a ? /GetUrlBienBan\('([^']+)'\)/.exec(a.getAttribute('href') || '') : null;
  var tds = tr.querySelectorAll('td');
  return { id: m ? m[1] : '', name: tds.length > 1 ? tds[1].innerText.trim() : '', created: tds.length > 2 ? tds[2].innerText.trim() : '' };
}).filter(function (r) { return r.id; });
"""


# Chọn trong <select> sẵn option (bỏ option trống); không có thì trả false để dùng ô tìm của Select2.
PICK_OPTION_JS = r"""
function n(s) { return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/\s+/g, ' ').trim(); }
var sel = document.getElementById(arguments[0]), want = n(arguments[1]);
if (!sel || !want) return false;
var hit = [].slice.call(sel.options || []).filter(function (o) { return o.value && n(o.text).indexOf(want) >= 0; })[0];
if (!hit) return false;
sel.value = hit.value; hit.selected = true;
sel.dispatchEvent(new Event('change', { bubbles: true }));
if (window.jQuery && jQuery.fn && jQuery.fn.select2) { try { jQuery(sel).trigger('change'); } catch (e) {} }
return true;
"""
SELECTED_VALUE_JS = "var s=document.getElementById(arguments[0]); return s ? (s.value || '') : '';"


def bbhc_rows(rows: Optional[List[Dict[str, str]]]) -> List[Dict[str, str]]:
    return [r for r in rows or [] if "bien ban hoi chan" in norm(r.get("name"))]


class BbhcPage:
    """Thao tác SBBHC trên màn khám. `exam` là ExamPage (dùng chung đọc/đóng hộp thoại)."""

    def __init__(self, exam: Any, pause=time.sleep) -> None:
        self.exam = exam
        self.driver = exam.driver
        self.pause = pause
        self._wait: Any = None

    @property
    def wait(self) -> Any:
        if self._wait is None:
            from selenium.webdriver.support.ui import WebDriverWait

            self._wait = WebDriverWait(self.driver, 10)
        return self._wait

    def exam_info(self) -> Dict[str, Any]:
        return self.exam.js(EXAM_INFO_JS) or {}

    def transfer_info(self) -> Dict[str, Any]:
        self.exam._open_xutri()
        try:
            return transfer_from_xutri(self.exam.js(XUTRI_FIELDS_JS) or [])
        finally:
            self.exam._close_xutri()

    def open_attachments(self) -> List[Dict[str, str]]:
        self.exam.js("onShowGiayToKemTheo(document.getElementById('showGiayToKemTheo'));")
        for _ in range(20):
            rows = self.exam.js(HSKT_ROWS_JS)
            if rows is not None and self.exam.visible("drpBienBan"):
                return rows
            self.pause(0.4)
        self.exam.check_dialogs("Mở Giấy tờ kèm theo")
        raise RuntimeError("Không mở được Giấy tờ kèm theo")

    def close_attachments(self) -> None:
        self.exam.js("var b=document.getElementById('drpBienBan'); var m=b; while(m && !(m.classList && m.classList.contains('modal'))) m=m.parentElement;"
                     " if (m && window.jQuery) jQuery(m).modal('hide');")
        self.pause(0.5)

    def existing(self) -> List[Dict[str, str]]:
        rows = bbhc_rows(self.open_attachments())
        self.close_attachments()
        return rows

    def pick(self, field_id: str, text: str) -> bool:
        """Chọn giá trị trong ô chọn (option sẵn có hoặc Select2 tìm theo chữ); kiểm tra đã có giá trị."""
        import input_procedures as ip
        from infusion_select2 import chon_select2_bac_si_y_ta

        if not compact(text):
            return False
        if not self.exam.js(PICK_OPTION_JS, field_id, text):
            ok = chon_select2_bac_si_y_ta(self.driver, field_id, text, timeout=10) if field_id == "ThuKy" else False
            if not ok:
                ip._pick_select2_text(self.driver, self.wait, field_id, text, allow_first=False)
        return bool(self.exam.js(SELECTED_VALUE_JS, field_id))

    def add_form(self) -> str:
        """Thêm 1 SBBHC mới (modal Giấy tờ kèm theo đang mở); trả id hồ sơ mới."""
        import input_procedures as ip

        before = {r["id"] for r in self.exam.js(HSKT_ROWS_JS) or []}
        if not self.pick("drpBienBan", "SBBHC") and not self.pick("drpBienBan", "Sổ biên bản hội chẩn"):
            raise RuntimeError("Không chọn được mẫu SBBHC trong Giấy tờ kèm theo")
        self.exam.js("SaveBienBanHoiChan();")
        self.pause(1.5)
        self.exam.check_dialogs("Thêm SBBHC")
        for _ in range(10):
            new = [r for r in bbhc_rows(self.exam.js(HSKT_ROWS_JS)) if r["id"] not in before]
            if new:
                return new[-1]["id"]
            self.pause(0.5)
        raise RuntimeError("Đã bấm Thêm nhưng không thấy SBBHC mới trong danh sách")

    def fill_and_finish(self, hoso_id: str, fields: Dict[str, str], out_pdf: str) -> Dict[str, Any]:
        """Mở form (tab mới), điền, Hoàn tất, lấy Phiếu in, đóng tab và quay lại màn khám."""
        driver = self.driver
        home = driver.current_window_handle
        handles = set(driver.window_handles)
        self.exam.js("GetUrlBienBan(arguments[0]);", hoso_id)
        new_tab = None
        for _ in range(20):
            extra = [h for h in driver.window_handles if h not in handles]
            if extra:
                new_tab = extra[0]
                break
            self.pause(0.5)
        if new_tab:
            driver.switch_to.window(new_tab)
        try:
            wait_page(driver, 1.5)
            if not self.exam.wait_visible("YeuCau", 15):
                raise RuntimeError("Không mở được form SBBHC")
            for key in TEXT_FIELDS:
                self.exam.js("var e=document.getElementById(arguments[0]); if(e){ e.value=arguments[1];"
                             " e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); }",
                             key, fields.get(key) or "")
            nurse = compact(fields.get("ThuKy"))
            if not self.pick("ThuKy", nurse):
                raise RuntimeError(f"Không chọn được Thư ký: {nurse}")
            self.exam.js("document.getElementById('btnHoanTat').click();")
            self.pause(2.5)
            toasts = self.exam.check_dialogs("Hoàn tất SBBHC")
            if not self.exam.visible("btnThuHoi"):
                raise RuntimeError("Đã bấm Hoàn tất nhưng SBBHC chưa ở trạng thái hoàn tất" + (f" ({toasts[-1]})" if toasts else ""))
            pdf = self._save_print(out_pdf)
            return {"id": hoso_id, "pdf": pdf, "message": toasts[-1] if toasts else "Hoàn tất thành công"}
        finally:
            if new_tab:
                try:
                    driver.close()
                finally:
                    driver.switch_to.window(home)

    def _save_print(self, out_pdf: str) -> str:
        """Bấm Phiếu in rồi tải file PDF (cùng phiên đăng nhập). Trả đường dẫn, rỗng nếu không lấy được."""
        driver = self.driver
        handles = set(driver.window_handles)
        self.exam.js("var a=[].slice.call(document.querySelectorAll('#divWebpartReport a')).filter(function(x){return /OnReportPdf/.test(x.getAttribute('href')||'');})[0];"
                     " if (a) { eval((a.getAttribute('href')||'').replace(/^javascript:/,'')); }")
        src = ""
        for _ in range(20):
            self.pause(0.5)
            src = self.exam.js("var e=document.querySelector('#divReportPdf iframe,#divReportPdf embed,#divReportPdf object,iframe[src*=\".pdf\"],embed[src*=\".pdf\"]');"
                               " return e ? (e.getAttribute('src') || e.getAttribute('data') || '') : '';") or ""
            if src:
                break
            extra = [h for h in driver.window_handles if h not in handles]
            if extra:
                current = driver.current_window_handle
                driver.switch_to.window(extra[0])
                src = driver.current_url
                driver.close()
                driver.switch_to.window(current)
                break
        if not src:
            return ""
        data = driver.execute_async_script(
            "var done=arguments[arguments.length-1]; fetch(arguments[0],{credentials:'include'}).then(function(r){return r.arrayBuffer();})"
            ".then(function(b){var s='',a=new Uint8Array(b);for(var i=0;i<a.length;i+=8192)s+=String.fromCharCode.apply(null,a.subarray(i,i+8192));done(btoa(s));})"
            ".catch(function(){done('');});", src)
        raw = base64.b64decode(data or "")
        if not raw.startswith(b"%PDF"):
            return ""
        with open(out_pdf, "wb") as f:
            f.write(raw)
        return out_pdf


def merge_pdfs(paths: List[str], out_path: str) -> str:
    """Gộp các phiếu in SBBHC thành 1 file."""
    import fitz  # PyMuPDF, như sign_discharge_bundle.py

    merged = fitz.open()
    try:
        for p in paths:
            with fitz.open(p) as doc:
                merged.insert_pdf(doc)
        merged.save(out_path, garbage=3, deflate=True)
    finally:
        merged.close()
    return out_path
