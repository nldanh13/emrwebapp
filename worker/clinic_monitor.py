# -*- coding: utf-8 -*-
"""Theo dõi Danh sách Khám bệnh (tab Phòng khám); chỉ ghi EMR khi người dùng bấm Hoàn tất
(nhập thủ thuật chưa xong — TH2 — rồi hoàn tất khám Cho về — TH1).

Giữ một Chrome đã đăng nhập, cứ mỗi chu kỳ gọi thẳng hàm AjaxPro mà trang dùng
khi bấm Tìm kiếm (ServerSideDrawSearchResult) với cỡ trang lớn, nên đọc được
toàn bộ danh sách trong một lần thay vì lật từng trang. Hết phiên EMR thì tự mở
lại trang / đăng nhập lại. Mỗi lần đọc xong ghi trạng thái ra state file để máy
chủ Node trả cho giao diện; điều khiển (dừng / làm mới ngay) qua control file.

    python clinic_monitor.py monitor <request.json> <state.json> <control.json>
    python clinic_monitor.py parse-html <danh_sach.html>
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import urljoin

from clinic_outpatient import (
    DEFAULT_CLINIC_LIST_URL,
    _build_clinic_url,
    compact,
    load_request,
    merge_config_for_clinic,
    norm,
    parse_clinic_table,
    wait_page,
    write_json,
)
from utils import init_driver, load_config, login_emr
import clinic_bbhc

try:
    from bs4 import BeautifulSoup
except ModuleNotFoundError:  # pragma: no cover
    BeautifulSoup = None  # type: ignore

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

PAGE_SIZE = 500
MAX_PAGES = 10
MAX_RELOGIN_ATTEMPTS = 2

BHYT_CODE_RE = re.compile(r"\b[A-Z]{2}\d{10,}\b")
CHO_DOC_KQ_RE = re.compile(r"\(\s*ch[oờ]\s*đ?[oọ]c\s*k\s*q\s*\)", re.I)
PAGE_INFO_RE = re.compile(r"Trang\s*(\d+)\s*/\s*(\d+)", re.I)
SERVICE_LABELS = {"CDHA": "CĐHA", "XN": "XN", "TT": "TT", "TDCN": "TDCN", "PT": "PT", "KB": "KB"}

# Gọi đúng hàm trang Danh sách Khám bệnh dùng trong FilterChange(), chỉ thay cỡ trang/số trang.
FETCH_JS = r"""
var args = arguments[0];
function v(id) { var e = document.getElementById(id); return e ? e.value : ''; }
try {
  if (typeof ONEMES3 === 'undefined' || typeof CreateRenderInfo !== 'function') return { ok: false, reason: 'no_page' };
  var out = ONEMES3.KB.BVDK.WebParts.KhamBenhDanhSachDraw.ServerSideDrawSearchResult(
    CreateRenderInfo(), parseInt(v('drpSelectQuocGia'), 10), v('drpSelectUuTien'), v('drpSelectQuocTich'),
    v('drpSelectDoiTuong'), v('drpSelectHangDoi'), parseInt(args.trangThai, 10),
    parseInt(v('drpSelectTrangThaiHK'), 10), parseInt(v('drpSelectTrangThaiHenTraKQ'), 10), parseInt(args.xuTri, 10),
    parseInt(args.loai, 10), v('dtTuNgay'), v('dtDenNgay'), '', args.page,
    (typeof SortBy !== 'undefined' ? SortBy : ''), (typeof OrderBy !== 'undefined' ? OrderBy : ''), String(args.pageSize));
  var o = out && out.value;
  if (!o) return { ok: false, reason: 'no_response', message: out && out.error ? String(out.error.Message || out.error) : '' };
  if (o.Error) return { ok: false, reason: 'emr_error', message: String(o.InfoMessage || '') };
  return { ok: true, html: String(o.HtmlContent || '') };
} catch (e) {
  return { ok: false, reason: 'exception', message: String((e && e.message) || e) };
}
"""


class ListUnavailable(RuntimeError):
    """Không đọc được danh sách (hết phiên, trang lỗi…) — cần mở lại trang / đăng nhập lại."""


# ── Phân loại từng người bệnh ────────────────────────────────────────────────

def _stage(trang_thai: str) -> str:
    t = norm(trang_thai)
    if t in {"hoan tat", "da tat toan"}:
        return "xong"
    if t == "cho thuc hien":
        return "cho_kham"
    if t == "dang thuc hien":
        return "dang_kham"
    if t == "dang lam dich vu":
        return "dang_lam_dv"
    if t == "chua hoan tat":
        return "chua_hoan_tat"
    if t == "dieu tri ngoai tru":
        return "ngoai_tru"
    return "khac"


def _case(xu_tri: str, trang_thai: str) -> str:
    x = norm(xu_tri)
    if not x:
        return "ngoai_tru" if norm(trang_thai) == "dieu tri ngoai tru" else "chua_xu_tri"
    if x == "cho ve":
        return "cho_ve"
    if x == "nhap vien":
        return "nhap_vien"
    if x == "chuyen vien":
        return "chuyen_vien"
    if x == "chuyen kham chuyen khoa":
        return "chuyen_kham_ck"
    if x == "dieu tri ngoai tru":
        return "ngoai_tru"
    return "khac"


NEXT_ACTION = {
    "cho_ve": "Hoàn tất khám",
    "nhap_vien": "Nhập chăm sóc",
    "chuyen_vien": "Hoàn tất khám, lập SBBHC",
    "chuyen_kham_ck": "Không cần làm",
    "ngoai_tru": "Làm ở D/s điều trị ngoại trú",
    "chua_xu_tri": "Chờ bác sĩ xử trí",
    "khac": "Xem trên EMR",
}


def classify_row(row: Dict[str, Any]) -> Dict[str, Any]:
    """Rút gọn 1 dòng Danh sách Khám bệnh và xếp vào trường hợp cần làm."""
    raw_name = compact(row.get("ho_ten"))
    cho_doc_kq = bool(CHO_DOC_KQ_RE.search(raw_name))
    ho_ten = compact(CHO_DOC_KQ_RE.sub("", raw_name))

    doi_tuong = compact(row.get("doi_tuong"))
    has_bhyt = bool(BHYT_CODE_RE.search(doi_tuong))
    uu_tien = ", ".join(m.strip() for m in re.findall(r"\(([^()]*[^\d()][^()]*)\)", doi_tuong) if not m.strip().isdigit())
    if has_bhyt:
        doi_tuong_label = "BHYT"
    else:
        doi_tuong_label = compact(re.split(r"\(", doi_tuong, maxsplit=1)[0]) or "Không rõ"

    services = []
    for item in row.get("service_results") or []:
        code = compact(item.get("code")).upper()
        if not code:
            continue
        done, total = int(item.get("done") or 0), int(item.get("total") or 0)
        services.append({"code": code, "label": SERVICE_LABELS.get(code, code), "done": done, "total": total})

    trang_thai = compact(row.get("trang_thai"))
    xu_tri = compact(row.get("xu_tri"))
    stage = _stage(trang_thai)
    case = _case(xu_tri, trang_thai)
    tt = next((s for s in services if s["code"] == "TT"), None)
    has_tt = bool(tt and tt["total"] > 0)

    blockers: List[str] = []
    if stage not in {"xong", "cho_kham"}:
        for s in services:
            if s["code"] == "KB":
                continue
            if s["done"] < s["total"]:
                blockers.append(f"{s['label']} chưa xong ({s['done']}/{s['total']})")
        if case == "chua_xu_tri":
            blockers.append("Chưa có xử trí")

    next_action = NEXT_ACTION[case]
    if case in {"cho_ve", "chuyen_vien"} and has_tt:
        next_action = "Hoàn tất thủ thuật rồi hoàn tất khám"
    if stage == "xong":
        next_action = "Đã xong"
    elif stage == "cho_kham":
        next_action = "Chờ khám"

    actionable = case in {"cho_ve", "nhap_vien", "chuyen_vien"}
    return {
        "khambenhid": compact(row.get("access_id")),
        "href": compact(row.get("href")),
        "stt": compact(row.get("stt")),
        "ma_bn": compact(row.get("ma_bn")),
        "ho_ten": ho_ten,
        "nam_sinh": compact(row.get("nam_sinh")),
        "has_bhyt": has_bhyt,
        "doi_tuong": doi_tuong_label,
        "uu_tien": uu_tien,
        "thoi_gian": compact(row.get("thoi_gian")),
        "ly_do": compact(row.get("ly_do")),
        "trang_thai": trang_thai,
        "xu_tri": xu_tri,
        "noi_thuc_hien": compact(row.get("noi_thuc_hien")),
        "services": services,
        "cho_doc_kq": cho_doc_kq,
        "has_tt": has_tt,
        "stage": stage,
        "case": case,
        "blockers": blockers,
        "next_action": next_action,
        "ready": stage not in {"xong", "cho_kham"} and actionable and not blockers,
    }


def summarize(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    by_case: Dict[str, int] = {}
    by_stage: Dict[str, int] = {}
    for r in rows:
        if r["stage"] != "xong":
            by_case[r["case"]] = by_case.get(r["case"], 0) + 1
        by_stage[r["stage"]] = by_stage.get(r["stage"], 0) + 1
    return {
        "total": len(rows),
        "bhyt": sum(1 for r in rows if r["has_bhyt"]),
        "ready": sum(1 for r in rows if r["ready"]),
        "cho_doc_kq": sum(1 for r in rows if r["cho_doc_kq"] and r["stage"] != "xong"),
        "by_case": by_case,
        "by_stage": by_stage,
    }


def rows_from_html(html_text: str) -> List[Dict[str, Any]]:
    return [classify_row(r) for r in parse_clinic_table(html_text or "")]


def page_count(html_text: str) -> int:
    m = PAGE_INFO_RE.search(html_text or "")
    return int(m.group(2)) if m else 1


# ── Điều kiện hoàn tất khám (tính thuần, không đụng EMR) ─────────────────────

MIN_EXAM_MINUTES = 3
AFTER_SERVICES_MINUTES = 1
EMR_DT_RE = re.compile(r"(\d{1,2}):(\d{2})\s+(\d{1,2})/(\d{1,2})/(\d{4})")
ACTIVE_STAGES = {"dang_kham", "dang_lam_dv", "chua_hoan_tat"}


def parse_emr_dt(value: Any) -> Optional[datetime]:
    m = EMR_DT_RE.search(str(value or ""))
    if not m:
        return None
    hh, mm, dd, mo, yy = (int(x) for x in m.groups())
    try:
        return datetime(yy, mo, dd, hh, mm)
    except ValueError:
        return None


def fmt_emr_dt(dt: datetime) -> str:
    return dt.strftime("%H:%M %d/%m/%Y")


# Cho về (TH1) và Chuyển viện (TH4: hoàn tất như cho về, rồi bổ sung SBBHC).
COMPLETION_CASES = {"cho_ve", "chuyen_vien"}


def pending_procedures(row: Dict[str, Any]) -> int:
    """Số thủ thuật (TT) chưa hoàn tất của người bệnh."""
    tt = next((s for s in row.get("services") or [] if s.get("code") == "TT"), None)
    return max(int(tt["total"]) - int(tt["done"]), 0) if tt else 0


def eligible_for_completion(row: Dict[str, Any]) -> bool:
    """Người bệnh có BHYT, xử trí Cho về, đang khám / làm dịch vụ và mọi dịch vụ đã xong —
    trừ thủ thuật: TT chưa xong thì hệ thống tự nhập thủ thuật trước khi hoàn tất (TH2)."""
    blockers = [b for b in row.get("blockers") or [] if not (pending_procedures(row) and b.startswith("TT "))]
    return bool(row.get("has_bhyt")) and row.get("case") in COMPLETION_CASES \
        and row.get("stage") in ACTIVE_STAGES and not blockers


def latest_service_time(history_html: str, now: datetime) -> Optional[datetime]:
    """Mốc thời gian muộn nhất (không ở tương lai) trong popup lịch sử dịch vụ, dùng làm giờ
    xong chỉ định muộn nhất. Lấy mốc muộn nhất nên chỉ có thể chờ lâu hơn, không hoàn tất sớm."""
    times = [dt for dt in (parse_emr_dt(m.group(0)) for m in EMR_DT_RE.finditer(history_html or "")) if dt and dt <= now]
    return max(times) if times else None


def earliest_completion(exam_start: datetime, services_done: Optional[datetime]) -> datetime:
    earliest = exam_start + timedelta(minutes=MIN_EXAM_MINUTES)
    if services_done:
        earliest = max(earliest, services_done + timedelta(minutes=AFTER_SERVICES_MINUTES))
    return earliest


PROCEDURE_MINUTES = 10


def procedure_window(order_time: datetime, not_before: Optional[datetime], now: datetime,
                     minutes: int = PROCEDURE_MINUTES) -> Dict[str, Any]:
    """Giờ thực hiện thủ thuật: bắt đầu = giờ chỉ định, kết thúc = bắt đầu + `minutes` phút.
    Kết thúc phải không ở tương lai (chưa tới thì chờ); giờ chỉ định sớm hơn giờ vào khám
    là bất thường nên không tự nhập."""
    if not_before and order_time < not_before:
        return {"result": "error", "message": f"Giờ chỉ định thủ thuật {fmt_emr_dt(order_time)} sớm hơn giờ khám {fmt_emr_dt(not_before)} — không tự nhập"}
    end = order_time + timedelta(minutes=max(int(minutes or PROCEDURE_MINUTES), 1))
    if end > now:
        return {"result": "waiting", "earliest": end, "message": f"Thủ thuật chưa đủ {minutes} phút, chờ tới {end:%H:%M} mới nhập được"}
    return {"result": "ok", "start": order_time, "end": end}


# TH4: ca cần Sổ biên bản hội chẩn (SBBHC) = chuyển viện, hoặc có chụp CT / MRI.
imaging_kinds = clinic_bbhc.imaging_kinds


def has_imaging_order(row: Dict[str, Any]) -> bool:
    return any(s.get("code") == "CDHA" and int(s.get("total") or 0) > 0 for s in row.get("services") or [])


def bbhc_reasons(row: Dict[str, Any], imaging: Optional[List[str]]) -> List[str]:
    """Lý do người bệnh (có BHYT, đã vào khám — kể cả đã hoàn tất) cần lập SBBHC; rỗng nếu không cần."""
    if not row.get("has_bhyt") or row.get("stage") == "cho_kham":
        return []
    reasons = ["Chuyển viện"] if row.get("case") == "chuyen_vien" else []
    reasons += [f"Chụp {k}" for k in imaging or []]
    return reasons


def exit_time_is_valid(exit_time: Optional[datetime], earliest: datetime, now: datetime) -> bool:
    """Thời gian ra giữ nguyên nếu không sớm hơn mốc được phép và không ở tương lai."""
    return bool(exit_time) and earliest <= exit_time <= now


def count_prescribed_drugs(exam_html: str) -> int:
    """Số dòng thuốc trong đơn (bảng tblThuoc: mỗi thuốc là 1 dòng nhóm groupthuocN)."""
    if BeautifulSoup is None:
        raise RuntimeError("Thiếu beautifulsoup4")
    table = BeautifulSoup(exam_html or "", "html.parser").find(id="tblThuoc")
    if not table:
        return 0
    return sum(1 for tr in table.find_all("tr") if any(c.startswith("groupthuoc") for c in (tr.get("class") or [])))


def parse_weight(value: Any) -> float:
    try:
        return float(str(value or "").replace(",", ".").strip() or 0)
    except ValueError:
        return 0.0


# ── Màn khám của 1 người bệnh ────────────────────────────────────────────────

# Popup lịch sử dịch vụ trên trang Danh sách Khám bệnh (nút "CDHA: 1/1"…).
HISTORY_JS = r"""
try {
  var out = ONEMES3.KB.BVDK.WebParts.KhamBenhDanhSachDraw.ServerSideDrawLichSuChung(CreateRenderInfo(), arguments[0]);
  var o = out && out.value;
  if (!o || o.Error) return { ok: false, message: o ? String(o.InfoMessage || '') : 'no_response' };
  return { ok: true, html: String(o.HtmlContent || '') };
} catch (e) { return { ok: false, message: String((e && e.message) || e) }; }
"""

# SweetAlert v1 (EMR dùng swal), toastr và khung lỗi của popup xử trí.
READ_DIALOGS_JS = r"""
function shown(e) { if (!e) return false; var s = getComputedStyle(e); return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0'; }
var out = { dialogs: [], toasts: [], xutriError: '' };
document.querySelectorAll('.sweet-alert').forEach(function (d) {
  if (!shown(d)) return;
  var t = d.querySelector('h2'), p = d.querySelector('p'), c = d.querySelector('button.cancel');
  out.dialogs.push({ title: t ? t.innerText.trim() : '', text: p ? p.innerText.trim() : '', confirm: !!(c && shown(c)) });
});
document.querySelectorAll('#toast-container .toast-message').forEach(function (t) { out.toasts.push(t.innerText.trim()); });
var xe = document.getElementById('divErrorXutri'), xc = document.getElementById('contentErrorXutri');
if (shown(xe) && xc) out.xutriError = xc.innerText.trim();
return out;
"""

# Đóng hộp thoại: hộp xác nhận thì bấm KHÔNG (không tự đồng ý thay bác sĩ), hộp báo thì bấm OK.
CLOSE_DIALOGS_JS = r"""
document.querySelectorAll('.sweet-alert').forEach(function (d) {
  if (getComputedStyle(d).display === 'none') return;
  var c = d.querySelector('button.cancel'), ok = d.querySelector('button.confirm');
  if (c && getComputedStyle(c).display !== 'none') c.click(); else if (ok) ok.click();
});
"""

JS_VISIBLE = ("var e=document.getElementById(arguments[0]); if(!e) return false; var s=getComputedStyle(e);"
              " return s.display!=='none' && s.visibility!=='hidden' && e.offsetParent!==null;")
JS_VALUE = "var e=document.getElementById(arguments[0]); return e ? e.value : null;"
JS_SET_VALUE = ("var e=document.getElementById(arguments[0]); e.value=arguments[1];"
                " e.dispatchEvent(new Event('change', {bubbles:true}));")
# Các ô EMR bắt buộc trước khi Hoàn tất khám (OnExecutingHOANTAT): chẩn đoán sơ bộ, bệnh chính,
# xử trí, dấu hiệu LS / triệu chứng. Thiếu thì để bác sĩ nhập, hệ thống không tự điền.
JS_MISSING_REQUIRED = r"""
function v(id) { var e = document.getElementById(id); return e ? String(e.value || '').trim() : null; }
var out = [];
if (v('txtChanDoanSoBo') === '') out.push('chẩn đoán sơ bộ');
if (v('cbbCDBChinh') === '') out.push('bệnh chính');
if (v('cbbXuTri') === '') out.push('xử trí');
if (v('txtMoTaDauHieuLamSang') === '') out.push('dấu hiệu LS / triệu chứng');
return out;
"""
JS_DRUG_COUNT = "return document.querySelectorAll('#tblThuoc tr[class*=groupthuoc]').length;"


class ExamStepError(RuntimeError):
    pass


class ExamPage:
    """Đọc / thao tác trên màn khám bệnh (giaodienkhambenhdraw) của 1 người bệnh."""

    def __init__(self, driver: Any, pause: Callable[[float], None] = time.sleep) -> None:
        self.driver = driver
        self.pause = pause

    def js(self, script: str, *args: Any) -> Any:
        return self.driver.execute_script(script, *args)

    def visible(self, element_id: str) -> bool:
        try:
            return bool(self.js(JS_VISIBLE, element_id))
        except Exception:
            return False

    def wait_visible(self, element_id: str, seconds: float = 8.0) -> bool:
        end = time.time() + seconds
        while time.time() < end:
            if self.visible(element_id):
                return True
            self.pause(0.3)
        return self.visible(element_id)

    def check_dialogs(self, what: str) -> List[str]:
        """Có hộp báo lỗi / hộp xác nhận → đóng (không đồng ý) và báo lỗi nguyên văn."""
        info = self.js(READ_DIALOGS_JS) or {}
        dialogs = info.get("dialogs") or []
        if dialogs:
            self.js(CLOSE_DIALOGS_JS)
            texts = " | ".join(compact(f"{d.get('title', '')}: {d.get('text', '')}").strip(": ") for d in dialogs)
            if any(d.get("confirm") for d in dialogs):
                raise ExamStepError(f"{what}: EMR hỏi xác nhận, chưa tự đồng ý — {texts}")
            raise ExamStepError(f"{what}: {texts}")
        if info.get("xutriError"):
            raise ExamStepError(f"{what}: {info['xutriError']}")
        return info.get("toasts") or []

    def open(self, url: str) -> None:
        self.driver.get(url)
        wait_page(self.driver, 1.5)

    def needs_enter(self) -> bool:
        return self.visible("btnVAOKHAM")

    def missing_required(self) -> List[str]:
        return list(self.js(JS_MISSING_REQUIRED) or [])

    def drug_count(self) -> int:
        return int(self.js(JS_DRUG_COUNT) or 0)

    def exam_start(self) -> datetime:
        started = parse_emr_dt(self.js(JS_VALUE, "txtNgayKham"))
        if not started:
            raise ExamStepError("Không đọc được Ngày khám trên màn khám")
        return started

    def _open_vitals(self) -> None:
        self.js("OnShowSinhHieu(document.getElementById('showChamSoc'));")
        if not self.wait_visible("txtCanNangDHST"):
            self.check_dialogs("Mở dấu hiệu sinh tồn")
            raise ExamStepError("Không mở được Dấu hiệu sinh tồn")

    def _close_vitals(self) -> None:
        self.js("if (window.jQuery) jQuery('#modalSinhHieu').modal('hide');")
        self.pause(0.5)

    def save_weight(self, kg: float) -> None:
        self._open_vitals()
        self.js(JS_SET_VALUE, "txtCanNangDHST", f"{kg:g}")
        self.js("var f=document.getElementById('frmCTChiSo'); var b=[].slice.call(f.querySelectorAll('button[type=submit]'))"
                ".filter(function(x){return x.innerText.indexOf('Đóng')>=0;})[0] || f.querySelector('button[type=submit]'); b.click();")
        self.pause(1.5)
        self.check_dialogs("Lưu cân nặng")
        self._close_vitals()

    def _open_xutri(self) -> None:
        self.js("showXuTri();")
        if not self.wait_visible("txtThoigianRa"):
            self.check_dialogs("Mở chi tiết xử trí")
            raise ExamStepError("Không mở được Chi tiết xử trí")

    def _close_xutri(self) -> None:
        self.js("if (typeof closePopupXuTri === 'function') closePopupXuTri();")
        self.pause(0.5)

    def read_exit_time(self) -> Optional[datetime]:
        self._open_xutri()
        value = parse_emr_dt(self.js(JS_VALUE, "txtThoigianRa"))
        self._close_xutri()
        return value

    def save_exit_time(self, value: datetime) -> None:
        self._open_xutri()
        self.js(JS_SET_VALUE, "txtThoigianRa", fmt_emr_dt(value))
        self.js("document.getElementById('btnSaveXuTri').click();")
        self.pause(1.5)
        self.check_dialogs("Lưu thời gian ra")
        self._close_xutri()

    def enter_exam(self) -> None:
        self.js("document.getElementById('btnVAOKHAM').click();")
        self.pause(2.0)
        wait_page(self.driver, 1.0)
        self.check_dialogs("Vào khám")

    def finish(self) -> List[str]:
        if not self.wait_visible("btnHOANTAT", 6):
            raise ExamStepError("Không thấy nút Hoàn tất khám")
        self.js("document.getElementById('btnHOANTAT').click();")
        self.pause(2.5)
        return self.check_dialogs("Hoàn tất khám")


def check_patient(page: ExamPage, row: Dict[str, Any], services_done: Optional[datetime], now: datetime) -> Dict[str, Any]:
    """Kiểm tra (chỉ đọc) người bệnh có hoàn tất được lúc này không. Không bấm gì trên EMR."""
    if page.needs_enter() and row.get("cho_doc_kq") and page.drug_count() == 0:
        return {"status": "no_drug", "message": "Chờ đọc KQ, chưa có thuốc — để bác sĩ xử lý"}
    missing = page.missing_required()
    if missing:
        return {"status": "incomplete", "message": f"Bác sĩ chưa nhập: {', '.join(missing)}"}
    earliest = earliest_completion(page.exam_start(), services_done)
    base = {"earliest": earliest.isoformat()}
    if now < earliest:
        return {**base, "status": "waiting", "message": f"Chờ tới {earliest:%H:%M} mới hoàn tất được"}
    if pending_procedures(row):
        return {**base, "status": "ready", "message": "Sẵn sàng — sẽ nhập thủ thuật trước rồi hoàn tất"}
    return {**base, "status": "ready", "message": "Sẵn sàng hoàn tất"}


def is_weight_warning(message: str) -> bool:
    return "can nang" in norm(message)


def complete_patient(page: ExamPage, row: Dict[str, Any], services_done: Optional[datetime], now: datetime,
                     weight_kg: Optional[float]) -> Dict[str, Any]:
    """Hoàn tất khám 1 người bệnh — chỉ chạy khi người dùng bấm nút trên màn Phòng khám."""
    steps: List[str] = []
    # Kiểm tra hết điều kiện đọc được TRƯỚC khi bấm gì, để không thao tác dở dang trên EMR.
    must_enter = page.needs_enter()
    if must_enter and row.get("cho_doc_kq") and page.drug_count() == 0:
        return {"result": "no_drug", "message": "Chờ đọc KQ, chưa có thuốc — để bác sĩ xử lý", "steps": steps}
    missing = page.missing_required()
    if missing:
        return {"result": "incomplete", "message": f"Bác sĩ chưa nhập: {', '.join(missing)}", "steps": steps}
    earliest = earliest_completion(page.exam_start(), services_done)
    if now < earliest:
        return {"result": "waiting", "message": f"Chờ tới {earliest:%H:%M} mới hoàn tất được", "steps": steps}
    if must_enter:
        page.enter_exam()
        steps.append("Vào khám")
        earliest = earliest_completion(page.exam_start(), services_done)  # Vào khám có thể đổi Ngày khám
        if now < earliest:
            return {"result": "waiting", "message": f"Chờ tới {earliest:%H:%M} mới hoàn tất được", "steps": steps}
    exit_time = page.read_exit_time()
    if not exit_time_is_valid(exit_time, earliest, now):
        page.save_exit_time(now)
        steps.append(f"Thời gian ra → {fmt_emr_dt(now)}")
    # Cân nặng thường đã có từ đầu: cứ hoàn tất, EMR cảnh báo thiếu cân nặng mới nhập.
    try:
        toasts = page.finish()
    except ExamStepError as e:
        if not is_weight_warning(str(e)):
            raise
        if not weight_kg:
            return {"result": "need_weight", "message": f"EMR báo thiếu cân nặng — nhập cân nặng thật để hoàn tất ({e})", "steps": steps}
        page.save_weight(weight_kg)
        steps.append(f"Nhập cân nặng {weight_kg:g} kg")
        toasts = page.finish()
    steps.append("Hoàn tất khám" + (f" ({toasts[-1]})" if toasts else ""))
    return {"result": "done", "message": "Đã hoàn tất khám", "steps": steps}


# ── Thủ thuật (TH2): D/s Thủ thuật ───────────────────────────────────────────

DEFAULT_PROCEDURE_TEMPLATE = "CTCH-thay băng"
DEFAULT_ANESTHESIA = "Không"
PROCEDURE_SAVE_IDS = ["btnSave", "btnLuu", "btnGhi", "btnGhiNhan", "btnSaveTT", "btnLuuTT",
                      "btnSaveTuongTrinh", "btnLuuTuongTrinh", "btnSaveThuThuat", "btnUpdate"]
PROCEDURE_FINISH_IDS = ["btnHoanTat", "btnHOANTAT", "btnPopupHOANTAT", "btnKetThuc", "btnFinish", "btnHT"]


def procedure_staff(config: Dict[str, Any], start: datetime) -> str:
    """Điều dưỡng phòng khám (thủ thuật viên, thư ký SBBHC): Lịch Phòng khám (Lịch điều dưỡng)
    theo ngày/thứ, không có thì lịch ca chung."""
    from clinic_input_care import _clinic_nurses_for_date
    from utils import get_nurse_by_shift

    names = _clinic_nurses_for_date(config.get("clinic_nurse_schedule") or {}, start.strftime("%d/%m/%Y"))
    if names:
        return names[0]
    return compact(get_nurse_by_shift(fmt_emr_dt(start), config.get("ten_dieu_duong") or {}))


class ProcedurePage:
    """Nhập 1 thủ thuật trên D/s Thủ thuật. Dùng lại cách tìm dòng / điền form của
    input_procedures.py nhưng tự bấm Lưu / Hoàn tất để không tự đồng ý hộp xác nhận."""

    def __init__(self, driver: Any, wait: Any, config: Dict[str, Any], pause: Callable[[float], None] = time.sleep) -> None:
        import input_procedures as ip

        self.ip = ip
        self.driver, self.wait, self.config = driver, wait, config
        self.dialogs = ExamPage(driver, pause)
        self.pause = pause

    def open_pending(self, ma_bn: str, day: str) -> Optional[datetime]:
        """Mở dòng thủ thuật chưa hoàn tất; trả giờ chỉ định, None nếu đã hoàn tất hết."""
        ip = self.ip
        # Bộ lọc D/s Thủ thuật của input_procedures tự đóng popup bằng handle_popups (bấm đồng ý);
        # ở đây thay bằng cách đóng không đồng ý như màn khám.
        original = ip.handle_popups
        ip.handle_popups = lambda _driver: bool(self.dialogs.js(CLOSE_DIALOGS_JS))
        try:
            ip._goto_procedure_list(self.driver, self.wait, self.config)
            ip._apply_procedure_date_range_filter(self.driver, self.wait, day, self.config)
            ip._try_search_on_list(self.driver, self.wait, ma_bn)
            order_time, _completed, _status = ip._open_procedure_row(
                self.driver, self.wait, ma_bn, day, "", clinic_mode=True,
                allow_completed_update=False, return_meta=True)
        except ip.ProcedureAlreadyCompleted:
            return None
        finally:
            ip.handle_popups = original
        return order_time

    def enter(self) -> None:
        self.ip._enter_execution_form_for_check(self.driver, self.wait)
        self.dialogs.check_dialogs("Vào thực hiện thủ thuật")

    def fill(self, start: datetime, end: datetime, staff: str, template: str) -> None:
        ip = self.ip
        ip._set_input_value(self.driver, "txtTgBatDau", fmt_emr_dt(start))
        ip._set_input_value(self.driver, "txtTgKetThuc", fmt_emr_dt(end))
        if not ip._pick_select2_text(self.driver, self.wait, "cbbPhuongPhapVoCam", DEFAULT_ANESTHESIA, allow_first=False):
            raise ExamStepError(f"Không chọn được phương pháp vô cảm: {DEFAULT_ANESTHESIA}")
        ok = bool(ip.chon_select2_bac_si_y_ta and ip.chon_select2_bac_si_y_ta(self.driver, "cbbTTChinh", staff, timeout=15))
        if not ok and not ip._pick_select2_text(self.driver, self.wait, "cbbTTChinh", staff, allow_first=False):
            raise ExamStepError(f"Không chọn được thủ thuật viên: {staff}")
        if not ip._pick_select2_text(self.driver, self.wait, "cbbMauTuongTrinh", template, allow_first=True):
            raise ExamStepError(f"Không chọn được mẫu tường trình: {template}")
        errors = ip._compare_procedure_form(self.driver, {
            "start_dt": start, "end_dt": end, "start_text": fmt_emr_dt(start), "end_text": fmt_emr_dt(end),
            "anesthesia": DEFAULT_ANESTHESIA, "staff_name": staff, "template_name": template,
        })
        if errors:
            raise ExamStepError("Điền phiếu thủ thuật chưa đúng: " + "; ".join(errors))

    def _click_first(self, ids: List[str]) -> bool:
        return bool(self.dialogs.js(
            "for (var i=0;i<arguments[0].length;i++){var e=document.getElementById(arguments[0][i]);"
            " if(e && e.offsetParent!==null && !e.disabled){e.click(); return true;}} return false;", ids))

    def save_and_finish(self) -> List[str]:
        if not self._click_first(PROCEDURE_SAVE_IDS):
            raise ExamStepError("Không thấy nút Lưu phiếu thủ thuật")
        self.pause(1.5)
        toasts = self.dialogs.check_dialogs("Lưu thủ thuật")
        if self._click_first(PROCEDURE_FINISH_IDS):
            self.pause(2.0)
            toasts += self.dialogs.check_dialogs("Hoàn tất thủ thuật")
        return toasts


def enter_procedure(page: ProcedurePage, row: Dict[str, Any], config: Dict[str, Any], now: datetime) -> Dict[str, Any]:
    """Nhập 1 thủ thuật chưa hoàn tất của người bệnh (chỉ chạy khi người dùng bấm nút)."""
    order_time = page.open_pending(compact(row.get("ma_bn")), now.strftime("%d/%m/%Y"))
    if order_time is None:
        return {"result": "already", "message": "Thủ thuật đã hoàn tất trên D/s Thủ thuật"}
    window = procedure_window(order_time, parse_emr_dt(row.get("thoi_gian")), now,
                              int(config.get("procedure_duration_minutes") or PROCEDURE_MINUTES))
    if window["result"] != "ok":
        return window
    start, end = window["start"], window["end"]
    staff = procedure_staff(config, start)
    if not staff:
        return {"result": "error", "message": "Chưa có lịch Phòng khám / lịch ca để chọn thủ thuật viên"}
    page.enter()
    page.fill(start, end, staff, compact(config.get("procedure_template_name")) or DEFAULT_PROCEDURE_TEMPLATE)
    page.save_and_finish()
    return {"result": "done", "end": end,
            "message": f"Đã nhập thủ thuật {start:%H:%M}–{end:%H:%M}, thủ thuật viên {staff}"}


# ── Đọc danh sách trên EMR ───────────────────────────────────────────────────

def _fetch_page(driver: Any, page: int) -> str:
    res = driver.execute_script(FETCH_JS, {"trangThai": "", "xuTri": "", "loai": "0", "page": page, "pageSize": PAGE_SIZE}) or {}
    if not res.get("ok"):
        raise ListUnavailable(f"{res.get('reason') or 'unknown'}: {compact(res.get('message'))}".strip(": "))
    return str(res.get("html") or "")


def fetch_today_rows(driver: Any) -> List[Dict[str, Any]]:
    first = _fetch_page(driver, 0)
    rows = rows_from_html(first)
    for page in range(1, min(page_count(first), MAX_PAGES)):
        rows.extend(rows_from_html(_fetch_page(driver, page)))
    seen, out = set(), []
    for r in rows:
        key = r["khambenhid"] or (r["ma_bn"], r["thoi_gian"])
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


class Monitor:
    def __init__(self, config: Dict[str, Any], list_url: str, headless: bool) -> None:
        self.config = config
        self.list_url = list_url
        self.headless = headless
        self.driver: Any = None
        self.wait: Any = None
        self.login_count = 0

    def _open_list(self) -> None:
        self.driver.get(_build_clinic_url(self.driver.current_url, self.list_url))
        wait_page(self.driver, 1.0)

    def _login(self) -> None:
        if self.driver is None:
            print(f">>> Mở Chrome theo dõi phòng khám: headless={self.headless}")
            self.driver, self.wait = init_driver(headless=self.headless)
        login_emr(self.driver, self.wait, self.config)
        self.login_count += 1
        self._open_list()

    def close(self) -> None:
        if self.driver is not None:
            try:
                self.driver.quit()
            except Exception:
                pass
        self.driver = None

    def read(self) -> List[Dict[str, Any]]:
        if self.driver is None:
            self._login()
        last: Optional[Exception] = None
        for attempt in range(MAX_RELOGIN_ATTEMPTS + 1):
            try:
                return fetch_today_rows(self.driver)
            except ListUnavailable as e:
                last = e
                print(f"[CLINIC-MONITOR] Không đọc được danh sách ({e}); mở lại trang / đăng nhập lại (lần {attempt + 1}).")
            try:
                self._open_list()
                if "login.aspx" in (self.driver.current_url or "").lower():
                    self._login()
            except Exception as e:  # driver hỏng (Chrome bị đóng…) → mở Chrome mới
                last = e
                self.close()
                self._login()
        raise RuntimeError(f"Không đọc được Danh sách Khám bệnh sau khi đăng nhập lại: {last}")

    def services_done(self, row: Dict[str, Any], now: datetime) -> Optional[datetime]:
        """Giờ xong chỉ định muộn nhất, đọc từ popup lịch sử dịch vụ (đang ở trang danh sách)."""
        if not any(sv["code"] != "KB" and sv["total"] > 0 for sv in row.get("services") or []):
            return None
        res = self.driver.execute_script(HISTORY_JS, row.get("khambenhid")) or {}
        if not res.get("ok"):
            raise ExamStepError(f"Không đọc được giờ xong chỉ định: {compact(res.get('message'))}")
        return latest_service_time(res.get("html") or "", now)

    def run_procedures(self, row: Dict[str, Any]) -> Dict[str, Any]:
        """Nhập các thủ thuật chưa hoàn tất rồi quay về danh sách. Trả giờ kết thúc muộn nhất."""
        steps: List[str] = []
        last_end: Optional[datetime] = None
        result: Dict[str, Any] = {"result": "done"}
        try:
            for _ in range(min(pending_procedures(row), 3)):
                res = enter_procedure(ProcedurePage(self.driver, self.wait, self.config), row, self.config, _now())
                if res["result"] == "already":
                    break
                if res["result"] != "done":
                    result = res
                    break
                steps.append(res["message"])
                last_end = max(last_end, res["end"]) if last_end else res["end"]
        except ExamStepError as e:
            result = {"result": "error", "message": str(e)}
        except Exception as e:
            result = {"result": "error", "message": f"Lỗi khi nhập thủ thuật: {compact(str(e))[:300]}"}
        if "login.aspx" in (self.driver.current_url or "").lower():
            self.close()
            return {"result": "session", "message": "EMR hết phiên giữa chừng, sẽ thử lại sau khi đăng nhập lại", "steps": steps}
        try:
            self._open_list()
        except Exception:
            self.close()
            if result["result"] == "done":
                result = {"result": "session", "message": "Không mở lại được Danh sách Khám bệnh sau khi nhập thủ thuật"}
        return {**result, "steps": steps, "procedure_end": last_end}

    def imaging(self, row: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Đọc popup lịch sử dịch vụ (đang ở trang danh sách): các chỉ định chụp CT / MRI."""
        res = self.driver.execute_script(HISTORY_JS, row.get("khambenhid")) or {}
        if not res.get("ok"):
            raise ExamStepError(f"Không đọc được lịch sử dịch vụ: {compact(res.get('message'))}")
        return clinic_bbhc.imaging_orders(res.get("html") or "")

    def on_exam_page(self, row: Dict[str, Any], action: Callable[[ExamPage, Optional[datetime], datetime], Dict[str, Any]]) -> Dict[str, Any]:
        """Mở màn khám của người bệnh, chạy `action`, rồi quay về danh sách."""
        now = _now()
        try:
            done_at = self.services_done(row, now)
            base_url = self.driver.current_url
            page = ExamPage(self.driver)
            page.open(urljoin(base_url, row["href"]))
            result = action(page, done_at, now)
        except ExamStepError as e:
            result = {"status": "error", "result": "error", "message": str(e)}
        except Exception as e:  # lỗi Selenium/JS bất ngờ
            result = {"status": "error", "result": "error", "message": f"Lỗi khi thao tác màn khám: {compact(str(e))[:300]}"}
        if "login.aspx" in (self.driver.current_url or "").lower():
            result = {"status": "session", "result": "session", "message": "EMR hết phiên giữa chừng, sẽ thử lại sau khi đăng nhập lại"}
            self.close()
            return result
        try:
            self._open_list()
        except Exception:
            self.close()
        return result


# ── Vòng lặp theo dõi ────────────────────────────────────────────────────────

def _read_control(path: str) -> Dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _now() -> datetime:
    return datetime.now().replace(microsecond=0)


CHECK_EVERY = timedelta(minutes=5)
MAX_CHECKS_PER_CYCLE = 8


def _need_check(check: Optional[Dict[str, Any]], now: datetime) -> bool:
    if not check:
        return True
    if check.get("status") in {"need_weight", "done"}:
        return False  # chờ người dùng nhập cân nặng / đã xong — không kiểm tra lại
    if check.get("status") == "waiting" and check.get("earliest"):
        return now >= datetime.fromisoformat(check["earliest"])
    return now - datetime.fromisoformat(check["at"]) >= CHECK_EVERY


def run_checks(monitor: "Monitor", rows: List[Dict[str, Any]], checks: Dict[str, Dict[str, Any]]) -> None:
    """Kiểm tra (chỉ đọc) các người bệnh có thể hoàn tất, giới hạn số người mỗi chu kỳ."""
    done = 0
    for row in rows:
        key = row.get("khambenhid") or ""
        if done >= MAX_CHECKS_PER_CYCLE or not key or not row.get("href") or not eligible_for_completion(row):
            continue
        if not _need_check(checks.get(key), _now()):
            continue
        res = monitor.on_exam_page(row, lambda page, done_at, now: check_patient(page, row, done_at, now))
        checks[key] = {k: v for k, v in res.items() if k != "result"}
        checks[key]["at"] = _now().isoformat()
        done += 1
        if res.get("status") == "session":
            break


def scan_imaging(monitor: "Monitor", rows: List[Dict[str, Any]], cache: Dict[str, Dict[str, Any]]) -> None:
    """Người bệnh có BHYT có chỉ định CĐHA: đọc (1 lần cho mỗi số chỉ định) xem có CT / MRI không."""
    for row in rows:
        key = row.get("khambenhid") or ""
        if not key or not row.get("has_bhyt") or row.get("stage") == "cho_kham" or not has_imaging_order(row):
            continue
        total = sum(int(s.get("total") or 0) for s in row.get("services") or [] if s.get("code") == "CDHA")
        if cache.get(key, {}).get("total") == total:
            continue
        try:
            orders = monitor.imaging(row)
            kinds: List[str] = []
            for o in orders:
                if o["kind"] not in kinds:
                    kinds.append(o["kind"])
            cache[key] = {"total": total, "kinds": kinds, "orders": [
                {**o, "time": fmt_emr_dt(o["time"]) if isinstance(o.get("time"), datetime) else ""} for o in orders]}
        except ExamStepError as e:
            print(f"[CLINIC-MONITOR] [WARN] STT {row.get('stt')}: {e}")


# ── TH4: soạn và lập SBBHC ───────────────────────────────────────────────────

def bbhc_reason_list(row: Dict[str, Any], imaging: Dict[str, Any], transfer: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Mỗi chỉ định chụp CT / MRI và việc chuyển viện là 1 SBBHC."""
    reasons: List[Dict[str, Any]] = []
    for o in (imaging or {}).get("orders") or []:
        reasons.append({"type": "imaging", "kind": o["kind"], "name": o["name"], "time": parse_emr_dt(o.get("time")) or o.get("time") or "",
                        "label": f"Chụp {o['kind']}: {o['name']}"})
    if row.get("case") == "chuyen_vien" and transfer is not None:
        reasons.append({**transfer, "label": "Chuyển viện" + (f" {transfer['hospital']}" if transfer.get("hospital") else "")})
    return reasons


def prepare_bbhc(page: ExamPage, row: Dict[str, Any], imaging: Dict[str, Any], config: Dict[str, Any], now: datetime) -> Dict[str, Any]:
    """Đọc (không ghi) màn khám và soạn nháp SBBHC cho 1 người bệnh."""
    bb = clinic_bbhc.BbhcPage(page)
    info = bb.exam_info()
    exam_orders = bb.imaging_services()
    if exam_orders is not None:
        # Bảng Chỉ định DVKT của màn khám chính xác hơn popup lịch sử (đúng tên, giờ chỉ định).
        imaging = {"orders": [{**o, "time": fmt_emr_dt(o["time"]) if isinstance(o.get("time"), datetime) else ""} for o in exam_orders]}
    transfer = bb.transfer_info() if row.get("case") == "chuyen_vien" else None
    existing = bb.existing()
    reasons = bbhc_reason_list(row, imaging, transfer)
    nurse = procedure_staff(config, now)
    drafts = []
    for i, reason in enumerate(reasons):
        fields = {**clinic_bbhc.build_bbhc(reason, info), "ThuKy": nurse}
        drafts.append({"key": f"{i}", "label": reason["label"], "fields": fields, "missing": clinic_bbhc.missing_fields(fields)})
    status = "exists" if reasons and len(existing) >= len(reasons) else "draft"
    message = (f"Đã có {len(existing)} SBBHC trên EMR — không lập thêm" if status == "exists"
               else f"{len(drafts)} SBBHC cần lập" + (f" (đã có {len(existing)})" if existing else ""))
    return {"status": status, "message": message, "existing": len(existing), "drafts": drafts if status == "draft" else []}


def create_bbhc(page: ExamPage, row: Dict[str, Any], drafts: List[Dict[str, Any]], pdf_dir: str) -> Dict[str, Any]:
    """Lập các SBBHC đã được người dùng duyệt cho 1 người bệnh."""
    bb = clinic_bbhc.BbhcPage(page)
    existing = bb.existing()
    if existing and len(existing) >= len(drafts):
        return {"result": "exists", "message": f"Đã có {len(existing)} SBBHC trên EMR — không lập thêm", "pdfs": []}
    todo = drafts[len(existing):]
    pdfs, steps = [], []
    bb.open_attachments()
    try:
        for d in todo:
            missing = clinic_bbhc.missing_fields(d["fields"])
            if missing:
                raise ExamStepError(f"{d['label']}: còn thiếu {', '.join(missing)}")
            hoso_id = bb.add_form()
            out = os.path.join(pdf_dir, f"clinic_bbhc_{re.sub(r'[^A-Za-z0-9-]', '', hoso_id)[:40]}.pdf")
            res = bb.fill_and_finish(hoso_id, d["fields"], out)
            if res.get("pdf"):
                pdfs.append(res["pdf"])
            steps.append(f"Lập SBBHC {d['label']}" + ("" if res.get("pdf") else " (chưa lấy được phiếu in)"))
    finally:
        bb.close_attachments()
    return {"result": "done", "message": f"Đã lập {len(steps)} SBBHC", "steps": steps, "pdfs": pdfs}


def run_bbhc_prepare(monitor: "Monitor", rows: List[Dict[str, Any]], imaging: Dict[str, Dict[str, Any]],
                     bbhc: Dict[str, Dict[str, Any]]) -> None:
    for row in rows:
        key = row.get("khambenhid") or ""
        if not key or not row.get("href") or not bbhc_reasons(row, (imaging.get(key) or {}).get("kinds")):
            continue
        res = monitor.on_exam_page(row, lambda page, done_at, now: prepare_bbhc(page, row, imaging.get(key) or {}, monitor.config, now))
        bbhc[key] = {k: v for k, v in res.items() if k != "result"}
        if res.get("status") == "session":
            break


def run_bbhc_create(monitor: "Monitor", rows: List[Dict[str, Any]], approved: Dict[str, Any], bbhc: Dict[str, Dict[str, Any]],
                    pdf_dir: str, log: List[Dict[str, Any]]) -> List[str]:
    pdfs: List[str] = []
    by_key = {r.get("khambenhid"): r for r in rows}
    for key, drafts in approved.items():
        row = by_key.get(key)
        if not row or not row.get("href") or not isinstance(drafts, list) or not drafts:
            continue
        res = monitor.on_exam_page(row, lambda page, done_at, now: create_bbhc(page, row, drafts, pdf_dir))
        result = res.get("result") or res.get("status")
        pdfs += res.get("pdfs") or []
        bbhc[key] = {"status": "done" if result in {"done", "exists"} else result, "message": res.get("message"), "drafts": []}
        log.append({"at": _now().isoformat(), "ma_bn": row.get("ma_bn"), "ho_ten": row.get("ho_ten"),
                    "result": result, "message": res.get("message"), "steps": res.get("steps") or []})
        if result == "session":
            break
    return pdfs


def run_completions(monitor: "Monitor", rows: List[Dict[str, Any]], checks: Dict[str, Dict[str, Any]],
                    weights: Dict[str, Any], log: List[Dict[str, Any]]) -> int:
    """Hoàn tất khám mọi người bệnh đủ điều kiện — chỉ gọi khi người dùng bấm nút."""
    acted = 0
    for row in rows:
        key = row.get("khambenhid") or ""
        if not key or not row.get("href") or not eligible_for_completion(row):
            continue
        kg = parse_weight(weights.get(key))
        tt: Dict[str, Any] = {"result": "done", "steps": [], "procedure_end": None}
        if pending_procedures(row):
            # Kiểm tra (chỉ đọc) màn khám trước: chờ đọc KQ chưa có thuốc / chưa đủ giờ thì chưa nhập thủ thuật.
            pre = monitor.on_exam_page(row, lambda page, done_at, now: check_patient(page, row, done_at, now))
            tt = monitor.run_procedures(row) if pre.get("status") == "ready" else {**pre, "result": pre.get("status")}
        if tt["result"] == "done":
            tt_end = tt.get("procedure_end")

            def complete(page: ExamPage, done_at: Optional[datetime], now: datetime) -> Dict[str, Any]:
                # Hoàn tất khám phải sau khi thủ thuật kết thúc (+1 phút), thời gian ra sửa theo đó.
                latest = max(d for d in (done_at, tt_end) if d) if (done_at or tt_end) else None
                return complete_patient(page, row, latest, now, kg or None)

            res = monitor.on_exam_page(row, complete)
        else:
            res = tt
        res = {**res, "steps": (tt.get("steps") or []) + ([] if res is tt else (res.get("steps") or []))}
        result = res.get("result") or res.get("status")
        checks[key] = {"status": "done" if result == "done" else result, "message": res.get("message"), "at": _now().isoformat()}
        log.append({"at": _now().isoformat(), "ma_bn": row.get("ma_bn"), "ho_ten": row.get("ho_ten"),
                    "result": result, "message": res.get("message"), "steps": res.get("steps") or []})
        acted += 1
        print(f"[CLINIC-MONITOR] Hoàn tất khám STT {row.get('stt')}: {result}")
        if result == "session":
            break
    return acted


def public_rows(rows: List[Dict[str, Any]], checks: Dict[str, Dict[str, Any]], weights: Dict[str, Any],
                imaging: Optional[Dict[str, Dict[str, Any]]] = None,
                bbhc_state: Optional[Dict[str, Dict[str, Any]]] = None) -> List[Dict[str, Any]]:
    out = []
    for r in rows:
        item = {k: v for k, v in r.items() if k != "href"}  # href mang mã phiên EMR
        key = r.get("khambenhid") or ""
        item["bbhc"] = bbhc_reasons(r, ((imaging or {}).get(key) or {}).get("kinds"))
        item["bbhc_state"] = (bbhc_state or {}).get(key) if item["bbhc"] else None
        item["eligible"] = eligible_for_completion(r)
        item["check"] = checks.get(key) if item["eligible"] else None
        item["weight_entered"] = parse_weight(weights.get(key)) or None
        out.append(item)
    return out


def run_monitor(req_path: str, state_path: str, control_path: str) -> None:
    req = load_request(req_path)
    try:
        os.remove(req_path)  # có mật khẩu — không để lại trên đĩa
    except OSError:
        pass
    config = merge_config_for_clinic(load_config(), req)
    if not compact(config.get("url_login")):
        raise RuntimeError("Thiếu URL đăng nhập EMR")
    if not compact(config.get("username")) or not str(config.get("password") or ""):
        raise RuntimeError("Thiếu tài khoản hoặc mật khẩu EMR")
    interval_min = min(max(int(req.get("intervalMinutes") or 3), 1), 60)
    list_url = compact(req.get("listUrl") or config.get("clinic_list_url") or DEFAULT_CLINIC_LIST_URL)
    monitor = Monitor(config, list_url, bool(req.get("headless", True)))

    state: Dict[str, Any] = {
        "status": "starting",
        "started_at": _now().isoformat(),
        "interval_minutes": interval_min,
        "account": compact(config.get("username")),
        "rows": [],
        "summary": summarize([]),
        "consecutive_failures": 0,
    }
    write_json(state_path, state)
    initial = _read_control(control_path)
    handled_refresh = initial.get("refresh")
    handled_complete = initial.get("completeNow")
    checks: Dict[str, Dict[str, Any]] = {}
    imaging: Dict[str, Dict[str, Any]] = {}
    bbhc: Dict[str, Dict[str, Any]] = {}
    bbhc_pdfs: List[str] = []
    handled_prepare = initial.get("bbhcPrepare")
    handled_bbhc = initial.get("bbhcRun")
    state_dir = os.path.dirname(os.path.abspath(state_path))
    action_log: List[Dict[str, Any]] = []
    try:
        while True:
            state["last_attempt_at"] = _now().isoformat()
            ctrl = _read_control(control_path)
            weights = ctrl.get("weights") if isinstance(ctrl.get("weights"), dict) else {}
            try:
                rows = monitor.read()
                if ctrl.get("completeNow") and ctrl.get("completeNow") != handled_complete:
                    handled_complete = ctrl.get("completeNow")
                    state["action_running"] = True
                    write_json(state_path, state)
                    if run_completions(monitor, rows, checks, weights, action_log):
                        rows = monitor.read()
                    state["action_running"] = False
                    state["last_action_at"] = _now().isoformat()
                run_checks(monitor, rows, checks)
                scan_imaging(monitor, rows, imaging)
                if ctrl.get("bbhcPrepare") and ctrl.get("bbhcPrepare") != handled_prepare:
                    handled_prepare = ctrl.get("bbhcPrepare")
                    state["action_running"] = True
                    write_json(state_path, state)
                    run_bbhc_prepare(monitor, rows, imaging, bbhc)
                    state["action_running"] = False
                if ctrl.get("bbhcRun") and ctrl.get("bbhcRun") != handled_bbhc:
                    handled_bbhc = ctrl.get("bbhcRun")
                    state["action_running"] = True
                    write_json(state_path, state)
                    approved = ctrl.get("bbhcDrafts") if isinstance(ctrl.get("bbhcDrafts"), dict) else {}
                    new_pdfs = run_bbhc_create(monitor, rows, approved, bbhc, state_dir, action_log)
                    if new_pdfs:
                        bbhc_pdfs += new_pdfs
                        merged = os.path.join(state_dir, f"clinic_bbhc_{_now():%Y%m%d}.pdf")
                        clinic_bbhc.merge_pdfs([p for p in bbhc_pdfs if os.path.exists(p)], merged)
                        state["bbhc_pdf"] = {"file": os.path.basename(merged), "count": len(bbhc_pdfs), "at": _now().isoformat()}
                    state["action_running"] = False
                    state["last_action_at"] = _now().isoformat()
                    rows = monitor.read()
                state.update({
                    "status": "running",
                    "rows": public_rows(rows, checks, weights, imaging, bbhc),
                    "action_log": action_log[-50:],
                    "summary": summarize(rows),
                    "updated_at": _now().isoformat(),
                    "last_error": "",
                    "consecutive_failures": 0,
                })
                print(f"[CLINIC-MONITOR] Đã đọc {len(rows)} người bệnh.")
            except Exception as e:
                state["consecutive_failures"] = int(state.get("consecutive_failures") or 0) + 1
                state["last_error"] = compact(str(e))[:500]
                state["status"] = "error" if state["consecutive_failures"] >= 3 else "running"
                print(f"[CLINIC-MONITOR] [WARN] Lỗi lần đọc: {e}")
                state["action_running"] = False
                monitor.close()
            state["login_count"] = monitor.login_count
            next_at = _now() + timedelta(minutes=interval_min)
            state["next_refresh_at"] = next_at.isoformat()
            write_json(state_path, state)

            while _now() < next_at:
                ctrl = _read_control(control_path)
                if ctrl.get("stop"):
                    return
                if ctrl.get("refresh") and ctrl.get("refresh") != handled_refresh:
                    handled_refresh = ctrl.get("refresh")
                    break
                if ctrl.get("completeNow") and ctrl.get("completeNow") != handled_complete:
                    break
                if (ctrl.get("bbhcPrepare") and ctrl.get("bbhcPrepare") != handled_prepare) or \
                        (ctrl.get("bbhcRun") and ctrl.get("bbhcRun") != handled_bbhc):
                    break
                time.sleep(2)
    finally:
        monitor.close()
        state["status"] = "stopped"
        state["stopped_at"] = _now().isoformat()
        state.pop("next_refresh_at", None)
        write_json(state_path, state)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("cmd", choices=["monitor", "parse-html"])
    parser.add_argument("input")
    parser.add_argument("state", nargs="?")
    parser.add_argument("control", nargs="?")
    args = parser.parse_args(argv)
    if args.cmd == "monitor":
        if not args.state or not args.control:
            raise SystemExit("Thiếu đường dẫn state/control")
        run_monitor(args.input, args.state, args.control)
        return 0
    with open(args.input, "r", encoding="utf-8") as f:
        rows = rows_from_html(f.read())
    print(json.dumps({"rows": rows, "summary": summarize(rows)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
