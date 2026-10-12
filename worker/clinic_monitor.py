# -*- coding: utf-8 -*-
"""Theo dõi Danh sách Khám bệnh (tab Phòng khám); chỉ ghi EMR khi người dùng bấm Hoàn tất
(nhập thủ thuật chưa xong — TH2 — rồi hoàn tất khám Cho về — TH1), bấm "Hoàn thành thủ thuật
ngay", hoặc khi người dùng bật "Tự hoàn thành khi có chỉ định" (nhập thủ thuật mỗi chu kỳ).

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
import hashlib
import json
import math
import os
import re
import sys
import time
import unicodedata
from datetime import date, datetime, timedelta
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
import clinic_ngoaitru
import procedure_templates

try:
    from bs4 import BeautifulSoup
except ModuleNotFoundError:  # pragma: no cover
    BeautifulSoup = None  # type: ignore

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

PAGE_SIZE = 500
MAX_PAGES = 30
MAX_RELOGIN_ATTEMPTS = 2

BHYT_CODE_RE = re.compile(r"\b[A-Z]{2}\d{10,}\b")
CHO_DOC_KQ_RE = re.compile(r"\(\s*ch[oờ]\s*đ?[oọ]c\s*k\s*q\s*\)", re.I)
PAGE_INFO_RE = re.compile(r"Trang\s*(\d+)\s*/\s*(\d+)", re.I)
TOTAL_RE = re.compile(r"Tổng số:\s*(\d+)\s*/\s*(\d+)", re.I)
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
    parseInt(args.loai, 10), (args.tuNgay != null ? args.tuNgay : v('dtTuNgay')),
    (args.denNgay != null ? args.denNgay : v('dtDenNgay')), '', args.page,
    (typeof SortBy !== 'undefined' ? SortBy : ''), (typeof OrderBy !== 'undefined' ? OrderBy : ''), String(args.pageSize));
  var o = out && out.value;
  if (!o) return { ok: false, reason: 'no_response', message: out && out.error ? String(out.error.Message || out.error) : '' };
  if (o.Error) return { ok: false, reason: 'emr_error', message: String(o.InfoMessage || '') };
  return { ok: true, html: String(o.HtmlContent || '') };
} catch (e) {
  return { ok: false, reason: 'exception', message: String((e && e.message) || e) };
}
"""


# Lật trang đúng như người dùng bấm số trang dưới bảng: gọi NextPage(n) của trang (n tính từ 0) rồi đọc
# lại khung danh sách. Lệnh đọc thẳng (FETCH_JS) với page >= 2 không trả thêm người nên dùng cách này.
UI_PAGE_JS = r"""
var n = arguments[0];
try {
  if (typeof NextPage !== 'function' || !document.getElementById('divKhamBenhDanhSachContent')) return { ok: false, reason: 'no_pager' };
  NextPage(n);
  return { ok: true };
} catch (e) {
  return { ok: false, reason: 'exception', message: String((e && e.message) || e) };
}
"""
READ_LIST_BOX_JS = r"""
var box = document.getElementById('divKhamBenhDanhSachContent');
return box ? String(box.innerHTML || '') : '';
"""
UI_PAGE_WAIT_S = 15.0

# Đặt bộ lọc thời gian ngay trên trang Danh sách Khám bệnh (để EMR cũng hiện đúng ngày đang xem) rồi bấm
# Tìm kiếm: loại 7 = "Khoảng" với 2 ô ngày giờ HH:mm dd/mm/yyyy, loại 0 = "Trong ngày". Cách đặt giống bộ lọc
# D/s Thủ thuật đang dùng (input_procedures._apply_procedure_date_range_filter).
SET_DAY_JS = r"""
var f = arguments[0];
function fire(el, name) { try { el.dispatchEvent(new Event(name, { bubbles: true })); } catch (e) {} }
function setDate(id, value) {
  var el = document.getElementById(id);
  if (!el) return false;
  if (window.jQuery) {
    try { var p = window.jQuery(el).data('DateTimePicker'); if (p) { try { p.minDate(false); } catch (e) {} try { p.maxDate(false); } catch (e) {} } } catch (e) {}
  }
  el.value = value; fire(el, 'input'); fire(el, 'change'); fire(el, 'blur');
  if (window.jQuery) {
    try {
      var $el = window.jQuery(el), picker = $el.data('DateTimePicker');
      if (picker && typeof picker.date === 'function') { try { picker.date(value); } catch (e) {} }
      $el.val(value).trigger('dp.change').trigger('change');
    } catch (e) {}
  }
  return true;
}
try {
  var sel = document.getElementById('cbbLoai');
  if (!sel) return { ok: false, reason: 'no_filter' };
  sel.value = f.loai;
  try { Array.prototype.forEach.call(sel.options || [], function (o) { o.selected = (o.value === f.loai); }); } catch (e) {}
  if (typeof ThoiGianValueChange === 'function') { try { ThoiGianValueChange(sel); } catch (e) {} }
  fire(sel, 'change');
  if (window.jQuery) { try { window.jQuery(sel).val(f.loai).trigger('change'); } catch (e) {} }
  if (f.tuNgay) {
    var box = document.getElementById('data_5');
    if (box) box.style.display = 'block';
    if (!setDate('dtTuNgay', f.tuNgay) || !setDate('dtDenNgay', f.denNgay)) return { ok: false, reason: 'no_date_inputs' };
  }
  var btn = document.getElementById('btnTimKiem');
  if (btn && btn.offsetParent !== null) btn.click();
  else if (typeof FilterChange === 'function') FilterChange();
  return { ok: true };
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
        return "xong"  # Đã tất toán = đã hoàn tất khám và đóng tiền xong (người dùng xác nhận 12/10)
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
    "chuyen_kham_ck": "Hoàn tất cuối ngày",
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
    if xu_tri and stage in {"cho_kham", "khac"}:
        # Có xử trí thì chỉ "Hoàn tất" / "Đã tất toán" mới là xong; còn lại là chưa hoàn tất, cần hoàn tất.
        stage = "chua_hoan_tat"
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


def total_count(html_text: str) -> Optional[int]:
    """Tổng số lượt khám EMR ghi dưới bảng ("Tổng số: 18/ 32" → 32); không có thì None."""
    m = TOTAL_RE.search(html_text or "")
    return int(m.group(2)) if m else None


# ── Nhật ký quét (clinic_trace_YYYYMMDD.jsonl cạnh file trạng thái) ───────────
# Mỗi dòng 1 sự kiện: đọc danh sách (từng trang), mở màn khám (vì sao, kết quả, bao lâu), đọc lịch sử
# dịch vụ, thao tác đã làm, đầu/cuối chu kỳ. Không ghi họ tên / mã BN: người bệnh ghi bằng STT và mã
# rút gọn (8 ký tự băm từ mã lượt khám). Giữ TRACE_KEEP_DAYS ngày. Người dùng tải ở tab Phòng khám.

TRACE_KEEP_DAYS = 7
TRACE_FILE_RE = re.compile(r"^clinic_trace_(\d{8})\.jsonl$")
_trace_dir: Optional[str] = None
WHY_LABELS = {
    "run_tasks": "chuẩn bị thủ thuật",
    "run_completions": "chuẩn bị hoàn tất",
    "complete_on_exam_page": "hoàn tất khám",
    "run_bbhc_prepare": "soạn SBBHC",
    "run_bbhc_create": "lập SBBHC",
}


def trace_ref(key: Any) -> str:
    key = compact(key)
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:8] if key else ""


def set_trace_dir(path: Optional[str], today: Optional[date] = None) -> None:
    """Bật ghi nhật ký vào thư mục `path` (None = tắt) và xoá file cũ hơn TRACE_KEEP_DAYS ngày."""
    global _trace_dir
    _trace_dir = path
    if not path:
        return
    cutoff = ((today or _now().date()) - timedelta(days=TRACE_KEEP_DAYS - 1)).strftime("%Y%m%d")
    try:
        for name in os.listdir(path):
            m = TRACE_FILE_RE.match(name)
            if m and m.group(1) < cutoff:
                os.remove(os.path.join(path, name))
    except OSError:
        pass


def trace(event: str, **data: Any) -> None:
    if not _trace_dir:
        return
    now = _now()
    line = {"at": now.isoformat(timespec="seconds"), "su_kien": event, **data}
    try:
        with open(os.path.join(_trace_dir, f"clinic_trace_{now:%Y%m%d}.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(line, ensure_ascii=False, default=str) + "\n")
    except OSError:
        pass


def _ms(start: float) -> int:
    return int((time.time() - start) * 1000)


def _trace_actions(entries: List[Dict[str, Any]]) -> None:
    """Thao tác trên EMR trong chu kỳ (bản ghi action_log), bỏ họ tên / mã BN."""
    for e in entries:
        trace("thao_tac", loai=e.get("kind"), ref=trace_ref(e.get("khambenhid")), ket_qua=e.get("result"),
              thong_bao=compact(e.get("message"))[:200], buoc=e.get("steps") or [])


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


# Cho về (TH1) và Chuyển viện (TH4: hoàn tất như cho về, rồi bổ sung SBBHC), BHYT và viện phí.
COMPLETION_CASES = {"cho_ve", "chuyen_vien"}
# Hoàn tất cuối ngày: mọi lượt đã có xử trí kết thúc ở phòng khám, kể cả chưa có thuốc.
END_OF_DAY_CASES = COMPLETION_CASES | {"chuyen_kham_ck"}


def pending_procedures(row: Dict[str, Any]) -> int:
    """Số thủ thuật (TT) chưa hoàn tất của người bệnh."""
    tt = next((s for s in row.get("services") or [] if s.get("code") == "TT"), None)
    return max(int(tt["total"]) - int(tt["done"]), 0) if tt else 0


def eligible_for_completion(row: Dict[str, Any], end_of_day: bool = False) -> bool:
    """Người bệnh (BHYT hoặc viện phí) xử trí Cho về / Chuyển viện, đang khám / làm dịch vụ và mọi dịch vụ
    đã xong — trừ thủ thuật: TT chưa xong thì hệ thống tự nhập thủ thuật trước khi hoàn tất (TH2).
    Cuối ngày thêm Chuyển khám chuyên khoa."""
    blockers = [b for b in row.get("blockers") or [] if not (pending_procedures(row) and b.startswith("TT "))]
    return row.get("case") in (END_OF_DAY_CASES if end_of_day else COMPLETION_CASES) \
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
# Thủ thuật còn "Mới" trong bảng Chỉ định DVKT (chưa chuyển đi làm dịch vụ nên chưa có trên
# D/s Thủ thuật): dòng tr.dichvu thuộc nhóm có tiêu đề "Thủ thuật", EMR đánh dấu class chuyendichvu
# (dòng nút Thực hiện sẽ chuyển) hoặc cột Trạng thái là "Mới".
JS_NEW_PROCEDURES = r"""
function n(s) { return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/\s+/g, ' ').trim(); }
var t = document.getElementById('tblDichVu'); if (!t) return 0;
var inTT = false, count = 0;
[].slice.call(t.querySelectorAll('tbody tr')).forEach(function (tr) {
  if (!tr.classList.contains('dichvu')) {
    var h = n(tr.innerText);
    if (h) inTT = h.indexOf('thu thuat') >= 0;
    return;
  }
  var tds = tr.querySelectorAll('td');
  var status = tds.length > 6 ? n(tds[6].innerText) : '';
  if (inTT && !tr.classList.contains('hoantat') && (tr.classList.contains('chuyendichvu') || status === 'moi')) count++;
});
return count;
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

    def new_procedures(self) -> int:
        return int(self.js(JS_NEW_PROCEDURES) or 0)

    def send_to_services(self) -> List[str]:
        """Bấm Thực hiện (btnDILAMDV) để chuyển thủ thuật "Mới" sang D/s Thủ thuật."""
        if not self.wait_visible("btnDILAMDV", 6):
            raise ExamStepError("Không thấy nút Thực hiện để chuyển thủ thuật")
        self.js("document.getElementById('btnDILAMDV').click();")
        self.pause(2.5)
        wait_page(self.driver, 1.0)
        return self.check_dialogs("Thực hiện (chuyển thủ thuật)")

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


def drug_gate(row: Dict[str, Any], must_enter: bool, drugs: int, end_of_day: bool = False) -> Optional[Dict[str, Any]]:
    """Cho về chỉ hoàn tất khi bác sĩ đã kê thuốc; chờ đọc KQ chưa vào khám cũng vậy. None = qua.
    Cuối ngày thì hoàn tất cả người chưa có thuốc."""
    if drugs > 0 or end_of_day:
        return None
    if row.get("case") == "cho_ve":
        return {"status": "no_drug", "message": "Chưa có thuốc — chờ bác sĩ kê đơn rồi mới hoàn tất"}
    if must_enter and row.get("cho_doc_kq"):
        return {"status": "no_drug", "message": "Chờ đọc KQ, chưa có thuốc — để bác sĩ xử lý"}
    return None


def check_patient(page: ExamPage, row: Dict[str, Any], services_done: Optional[datetime], now: datetime,
                  end_of_day: bool = False) -> Dict[str, Any]:
    """Kiểm tra (chỉ đọc) người bệnh có hoàn tất được lúc này không. Không bấm gì trên EMR."""
    drugs = page.drug_count()
    gate = drug_gate(row, page.needs_enter(), drugs, end_of_day)
    if gate:
        return {**gate, "drugs": drugs}
    missing = page.missing_required()
    if missing:
        return {"status": "incomplete", "message": f"Bác sĩ chưa nhập: {', '.join(missing)}", "drugs": drugs}
    earliest = earliest_completion(page.exam_start(), services_done)
    base = {"earliest": earliest.isoformat(), "drugs": drugs}
    if now < earliest:
        return {**base, "status": "waiting", "message": f"Chờ tới {earliest:%H:%M} mới hoàn tất được"}
    if pending_procedures(row):
        return {**base, "status": "ready", "message": "Sẵn sàng — sẽ nhập thủ thuật trước rồi hoàn tất"}
    return {**base, "status": "ready", "message": "Sẵn sàng hoàn tất"}


def ready_for_procedures(page: ExamPage, row: Dict[str, Any], services_done: Optional[datetime], now: datetime,
                         end_of_day: bool = False) -> Dict[str, Any]:
    """Trước khi vào D/s Thủ thuật: kiểm tra màn khám (chỉ đọc); BHYT có thủ thuật còn "Mới" thì bấm Thực hiện
    (viện phí không bấm: thủ thuật tự hiện trên D/s Thủ thuật khi đã đóng tiền)."""
    res = check_patient(page, row, services_done, now, end_of_day)
    if res.get("status") != "ready":
        return res
    steps: List[str] = []
    if row.get("has_bhyt") and page.new_procedures():
        toasts = page.send_to_services()
        steps.append("Bấm Thực hiện (thủ thuật mới)" + (f" ({toasts[-1]})" if toasts else ""))
    return {**res, "steps": steps}


def is_weight_warning(message: str) -> bool:
    return "can nang" in norm(message)


def complete_patient(page: ExamPage, row: Dict[str, Any], services_done: Optional[datetime], now: datetime,
                     weight_kg: Optional[float], end_of_day: bool = False) -> Dict[str, Any]:
    """Hoàn tất khám 1 người bệnh — chỉ chạy khi người dùng bấm nút trên màn Phòng khám."""
    steps: List[str] = []
    # Kiểm tra hết điều kiện đọc được TRƯỚC khi bấm gì, để không thao tác dở dang trên EMR.
    must_enter = page.needs_enter()
    gate = drug_gate(row, must_enter, page.drug_count(), end_of_day)
    if gate:
        return {"result": gate["status"], "message": gate["message"], "steps": steps}
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


# Các ô chữ đang hiện trên phiếu thủ thuật (textarea, CKEditor): khoá → nội dung.
REPORT_BOXES_JS = r"""
var out = {};
var areas = document.querySelectorAll('textarea');
for (var i = 0; i < areas.length; i++) {
  var a = areas[i], st = getComputedStyle(a);
  var ck = window.CKEDITOR && a.id && CKEDITOR.instances[a.id];
  if (!ck && (st.display === 'none' || st.visibility === 'hidden' || a.offsetParent === null || a.disabled || a.readOnly)) continue;
  out[(ck ? 'ck:' : 'ta:') + (a.id || a.name || ('#' + i))] = ck ? String(ck.getData() || '') : String(a.value || '');
}
return out;
"""
SET_REPORT_JS = r"""
var key = arguments[0], text = arguments[1], name = key.slice(3);
if (key.indexOf('ck:') === 0) {
  var ck = window.CKEDITOR && CKEDITOR.instances[name];
  if (!ck) return false;
  ck.setData(text.split('\n').map(function (l) { return '<p>' + l.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</p>'; }).join(''));
  ck.updateElement();
  return true;
}
var e = document.getElementById(name) || document.getElementsByName(name)[0];
if (!e && name.charAt(0) === '#') e = document.querySelectorAll('textarea')[parseInt(name.slice(1), 10)];
if (!e) return false;
e.value = text;
['input', 'change', 'blur'].forEach(function (t) { e.dispatchEvent(new Event(t, { bubbles: true })); });
if (window.jQuery) { try { jQuery(e).trigger('change'); } catch (x) {} }
return e.value === text;
"""


def report_box(before: Dict[str, str], after: Dict[str, str]) -> str:
    """Ô nội dung tường trình: ô đổi nội dung sau khi chọn mẫu tường trình (nhiều ô đổi thì lấy ô dài nhất);
    không ô nào đổi mà chỉ có một ô thì lấy ô đó; còn lại rỗng (không đoán)."""
    changed = [k for k, v in after.items() if v != before.get(k, "")]
    if changed:
        return max(changed, key=lambda k: len(after[k]))
    return next(iter(after)) if len(after) == 1 else ""


SELECT_OPTIONS_JS = r"""
var sel = document.getElementById(arguments[0]);
if (!sel || !sel.options) return [];
var out = [];
for (var i = 0; i < sel.options.length; i++) {
  var t = String(sel.options[i].text || '').trim();
  if (t && sel.options[i].value !== '' && sel.options[i].value !== '0' && sel.options[i].value !== '-1') out.push(t);
}
return out;
"""


def _loose(text: Any) -> str:
    """So tên mẫu bỏ dấu, bỏ hoa/thường, bỏ khoảng trắng và gạch nối ("CTCH - Thay băng" = "CTCH-thay băng")."""
    raw = unicodedata.normalize("NFD", str(text or "")).replace("đ", "d").replace("Đ", "D")
    return re.sub(r"[^a-z0-9]", "", "".join(c for c in raw if unicodedata.category(c) != "Mn").lower())


def match_emr_option(wanted: str, options: List[str]) -> Optional[str]:
    """Chữ đúng của ô chọn EMR khớp tên mẫu: trùng hẳn trước, rồi mới chứa nhau. Không khớp thì None."""
    key = _loose(wanted)
    if not key:
        return None
    for opt in options:
        if _loose(opt) == key:
            return opt
    for opt in options:
        if key in _loose(opt) or (_loose(opt) and _loose(opt) in key):
            return opt
    return None


class ProcedurePage:
    """Nhập 1 thủ thuật trên D/s Thủ thuật. Dùng lại cách tìm dòng / điền form của
    input_procedures.py nhưng tự bấm Lưu / Hoàn tất để không tự đồng ý hộp xác nhận."""

    def __init__(self, driver: Any, wait: Any, config: Dict[str, Any], pause: Callable[[float], None] = time.sleep) -> None:
        import input_procedures as ip

        self.ip = ip
        self.driver, self.wait, self.config = driver, wait, config
        self.dialogs = ExamPage(driver, pause)
        self.pause = pause

    def open_pending(self, ma_bn: str, day: str,
                     choose: Optional[Callable[[str, List[str]], Any]] = None) -> Optional[datetime]:
        """Mở dòng thủ thuật chưa hoàn tất; trả giờ chỉ định, None nếu đã hoàn tất hết.
        `choose(chữ trên dòng, các ô)` chạy trước khi mở từng dòng chưa hoàn tất: trả False = bỏ qua dòng
        đó (vd. chưa có mẫu cho DVKT); bỏ qua hết thì báo NoProcedureTemplate."""
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
                allow_completed_update=False, return_meta=True, before_open=choose)
        except ip.ProcedureAlreadyCompleted:
            return None
        except ip.NoProcedureRowChosen as e:
            raise NoProcedureTemplate(str(e)) from e
        except RuntimeError as e:
            if "Không tìm thấy dòng thủ thuật" in str(e):
                raise ProcedureNotListed(str(e)) from e
            raise
        finally:
            ip.handle_popups = original
        return order_time

    def enter(self) -> None:
        self.ip._enter_execution_form_for_check(self.driver, self.wait)
        self.dialogs.check_dialogs("Vào thực hiện thủ thuật")

    def fill(self, start: datetime, end: datetime, staff: str, template: str,
             anesthesia: str = DEFAULT_ANESTHESIA, report: str = "") -> None:
        ip = self.ip
        ip._set_input_value(self.driver, "txtTgBatDau", fmt_emr_dt(start))
        ip._set_input_value(self.driver, "txtTgKetThuc", fmt_emr_dt(end))
        if not ip._pick_select2_text(self.driver, self.wait, "cbbPhuongPhapVoCam", anesthesia, allow_first=False):
            raise ExamStepError(f"Không chọn được phương pháp vô cảm: {anesthesia}")
        ok = bool(ip.chon_select2_bac_si_y_ta and ip.chon_select2_bac_si_y_ta(self.driver, "cbbTTChinh", staff, timeout=15))
        if not ok and not ip._pick_select2_text(self.driver, self.wait, "cbbTTChinh", staff, allow_first=False):
            raise ExamStepError(f"Không chọn được thủ thuật viên: {staff}")
        before = self.dialogs.js(REPORT_BOXES_JS) or {}
        template = self.emr_template_name(template)
        if not ip._pick_select2_text(self.driver, self.wait, "cbbMauTuongTrinh", template, allow_first=False):
            raise ExamStepError(f"Không chọn được mẫu tường trình: {template}")
        if report:
            self.pause(1.0)
            self.write_report(before, report)
        errors = ip._compare_procedure_form(self.driver, {
            "start_dt": start, "end_dt": end, "start_text": fmt_emr_dt(start), "end_text": fmt_emr_dt(end),
            "anesthesia": anesthesia, "staff_name": staff, "template_name": template,
        })
        if errors:
            raise ExamStepError("Điền phiếu thủ thuật chưa đúng: " + "; ".join(errors))

    def emr_template_name(self, wanted: str) -> str:
        """Tên mẫu tường trình đúng như trên EMR. Danh sách mẫu có thể nạp chậm sau khi bấm Vào thực hiện
        nên chờ tối đa vài giây. EMR không có mẫu đó thì báo kèm các mẫu EMR đang có để sửa mẫu thủ thuật,
        không chọn bừa mẫu đầu tiên."""
        options: List[str] = []
        for _ in range(10):
            options = [compact(o) for o in (self.dialogs.js(SELECT_OPTIONS_JS, "cbbMauTuongTrinh") or [])]
            found = match_emr_option(wanted, options)
            if found:
                return found
            self.pause(0.5)
        if not options:
            return wanted  # không đọc được danh sách: để ô chọn tự tìm như trước
        shown = ", ".join(options[:15]) + ("…" if len(options) > 15 else "")
        raise ExamStepError(f"Trên EMR không có mẫu tường trình \"{wanted}\" cho tài khoản này. "
                            f"Các mẫu EMR có: {shown}. Sửa ô \"Mẫu tường trình EMR\" trong Mẫu thủ thuật – PT cho đúng tên.")

    def write_report(self, before: Dict[str, str], report: str) -> None:
        """Ghi nội dung tường trình của mẫu vào ô EMR vừa tự điền khi chọn mẫu tường trình (ô đổi nội dung
        sau khi chọn). Không ô nào đổi mà phiếu chỉ có một ô chữ thì dùng ô đó; còn lại thì báo, không đoán."""
        key = report_box(before, self.dialogs.js(REPORT_BOXES_JS) or {})
        if not key:
            raise ExamStepError("Không xác định được ô nội dung tường trình trên phiếu thủ thuật; "
                                "để trống Nội dung tường trình trong mẫu thì EMR tự điền theo mẫu tường trình")
        if not self.dialogs.js(SET_REPORT_JS, key, report):
            raise ExamStepError("Không ghi được nội dung tường trình vào phiếu thủ thuật")

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


class NoProcedureTemplate(RuntimeError):
    """Dòng thủ thuật chưa có mẫu khớp tên DVKT (hoặc mẫu đặt nhập tay): không mở, không nhập."""


def performer_name(template: Dict[str, Any], config: Dict[str, Any], start: datetime) -> str:
    """Người thực hiện theo vai trò của mẫu, tên lấy theo Lịch Phòng khám lúc nhập."""
    if template.get("performer") == "bac_si":
        return clinic_doctor(config, start)
    return procedure_staff(config, start)


STATUS_WORDS = {"hoan tat", "cho thuc hien", "dang thuc hien", "chua thuc hien", "moi"}
DMY_RE = re.compile(r"\d{1,2}/\d{1,2}/\d{4}")


def dvkt_name(cells: List[str], row: Dict[str, Any], row_text: str = "") -> str:
    """Tên DVKT trên 1 dòng D/s Thủ thuật: ô chữ dài nhất không phải mã BN, họ tên, ngày giờ, trạng thái."""
    ma_bn, ho_ten = compact(row.get("ma_bn")), norm(row.get("ho_ten"))
    names = []
    for cell in cells or []:
        text = compact(cell)
        n = norm(text)
        if len(text) < 4 or (ma_bn and ma_bn in text) or DMY_RE.search(text) or n in STATUS_WORDS \
                or (ho_ten and (n == ho_ten or ho_ten in n)) or not re.search(r"[A-Za-zÀ-ỹ]", text):
            continue
        names.append(text)
    return max(names, key=len) if names else compact(row_text)[:120]


def enter_procedure(page: ProcedurePage, row: Dict[str, Any], config: Dict[str, Any], now: datetime,
                    templates: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """Nhập 1 thủ thuật chưa hoàn tất của người bệnh theo mẫu khớp tên DVKT (tab Mẫu thủ thuật – PT).
    Dòng chưa có mẫu (hoặc mẫu đặt nhập tay) thì bỏ qua, ghi lại tên DVKT để người dùng tạo mẫu."""
    templates = procedure_templates.load_templates() if templates is None else templates
    chosen: Dict[str, Any] = {}
    skipped: List[Dict[str, str]] = []

    def choose(row_text: str, cells: Optional[List[str]] = None) -> bool:
        tpl = procedure_templates.match_template(templates, "thu_thuat", row_text, bool(row.get("has_bhyt")))
        if tpl is None or tpl.get("auto") is False:
            name = dvkt_name(cells or [], row, row_text)
            skipped.append({"kind": "thu_thuat", "name": name, "manual": tpl is not None,
                            "message": procedure_templates.manual_message(tpl) if tpl else
                            procedure_templates.missing_message("thu_thuat", name)})
            return False
        chosen.update(tpl)
        return True

    try:
        order_time = page.open_pending(compact(row.get("ma_bn")), now.strftime("%d/%m/%Y"), choose)
    except NoProcedureTemplate:
        message = "; ".join(x["message"] for x in skipped) or "Không có thủ thuật nào nhập theo mẫu được"
        return {"result": "incomplete", "message": message,
                "missing_templates": [x for x in skipped if not x["manual"]]}
    except ProcedureNotListed:
        if row.get("has_bhyt"):
            raise
        # Viện phí: thủ thuật chỉ hiện trên D/s Thủ thuật sau khi người bệnh đóng tiền → chờ, thử lại sau.
        return {"result": "waiting", "earliest": now + PAYMENT_RETRY,
                "message": "Chưa có trên D/s Thủ thuật: chờ người bệnh viện phí đóng tiền"}
    if order_time is None:
        return {"result": "already", "message": "Thủ thuật đã hoàn tất trên D/s Thủ thuật"}
    missing = [x for x in skipped if not x["manual"]]
    minutes = procedure_templates.minutes_of(chosen, int(config.get("procedure_duration_minutes") or PROCEDURE_MINUTES))
    window = procedure_window(order_time, parse_emr_dt(row.get("thoi_gian")), now, minutes)
    if window["result"] != "ok":
        return {**window, "missing_templates": missing}
    start, end = window["start"], window["end"]
    staff = performer_name(chosen, config, start)
    role = procedure_templates.PERFORMER_LABEL.get(chosen.get("performer") or "dieu_duong", "điều dưỡng")
    if not staff:
        return {"result": "error", "message": f"Chưa có {role} trong Lịch Phòng khám để làm thủ thuật viên",
                "missing_templates": missing}
    emr_template = procedure_templates.text_of(chosen, "emr_template") \
        or compact(config.get("procedure_template_name")) or DEFAULT_PROCEDURE_TEMPLATE
    page.enter()
    page.fill(start, end, staff, emr_template, procedure_templates.text_of(chosen, "anesthesia", DEFAULT_ANESTHESIA),
              procedure_templates.block_of(chosen, "report"))
    page.save_and_finish()
    return {"result": "done", "end": end, "missing_templates": missing,
            "message": f"Đã nhập thủ thuật theo mẫu \"{chosen.get('name') or ''}\" {start:%H:%M}–{end:%H:%M}, thủ thuật viên {staff}"}


# ── Đọc danh sách trên EMR ───────────────────────────────────────────────────

def past_list_date(value: Any, today: date) -> str:
    """Ngày người dùng chọn (yyyy-mm-dd) nếu là ngày đã qua; rỗng = theo dõi danh sách hôm nay."""
    try:
        day = date.fromisoformat(compact(value))
    except ValueError:
        return ""
    return day.isoformat() if day < today else ""


def list_filter(value: Any, today: date) -> Dict[str, str]:
    """Bộ lọc thời gian của Danh sách Khám bệnh: hôm nay → loại 0 ("Trong ngày", như EMR mặc định);
    ngày đã qua → loại 7 ("Khoảng") từ 00:00 đến 23:59 ngày đó (ô ngày giờ EMR dạng HH:mm dd/mm/yyyy)."""
    day = past_list_date(value, today)
    if not day:
        return {"loai": "0"}
    dmy = date.fromisoformat(day).strftime("%d/%m/%Y")
    return {"loai": "7", "tuNgay": f"00:00 {dmy}", "denNgay": f"23:59 {dmy}"}


def _fetch_page(driver: Any, page: int, day_filter: Optional[Dict[str, str]] = None) -> str:
    args = {"trangThai": "", "xuTri": "", "loai": "0", **(day_filter or {}), "page": page, "pageSize": PAGE_SIZE}
    res = driver.execute_script(FETCH_JS, args) or {}
    if not res.get("ok"):
        raise ListUnavailable(f"{res.get('reason') or 'unknown'}: {compact(res.get('message'))}".strip(": "))
    return str(res.get("html") or "")


def _ui_page(driver: Any, page_idx: int) -> Optional[str]:
    """Bấm sang trang page_idx (từ 0) trên trang EMR, chờ khung danh sách ghi "Trang page_idx+1/…".
    Không lật được (không có NextPage, quá thời gian chờ) thì None để đọc cách khác."""
    try:
        res = driver.execute_script(UI_PAGE_JS, page_idx) or {}
    except Exception:
        return None
    if not res.get("ok"):
        return None
    deadline = time.time() + UI_PAGE_WAIT_S
    while True:
        try:
            html_text = str(driver.execute_script(READ_LIST_BOX_JS, None) or "")
        except Exception:
            html_text = ""
        m = PAGE_INFO_RE.search(html_text)
        if m and int(m.group(1)) == page_idx + 1:
            return html_text
        if time.time() > deadline:
            return None
        time.sleep(0.3)


def fetch_today_rows(driver: Any, day_filter: Optional[Dict[str, str]] = None,
                     ui_pager: bool = False) -> List[Dict[str, Any]]:
    """Đọc mọi trang. EMR bỏ qua cỡ trang lớn (18 dòng/trang), ô "Trang x/y" có thể ghi sai số trang và
    lệnh đọc thẳng với page >= 2 không trả thêm người. Nên khi trang EMR đang hiện đúng ngày (ui_pager)
    thì lật từng trang bằng NextPage như người dùng bấm; thiếu thì đọc thẳng theo "Tổng số" tới đủ."""
    started = time.time()
    seen: set = set()
    out: List[Dict[str, Any]] = []
    fetched: List[Dict[str, int]] = []

    def add(page_no: int, html_text: Optional[str] = None) -> str:
        via = "ajax" if html_text is None else "trang_emr"
        if html_text is None:
            html_text = _fetch_page(driver, page_no, day_filter)
        rows, before = rows_from_html(html_text), len(out)
        for r in rows:
            key = r["khambenhid"] or (r["ma_bn"], r["thoi_gian"])
            if key not in seen:
                seen.add(key)
                out.append(r)
        fetched.append({"page": page_no, "so_dong": len(rows), "moi": len(out) - before, "cach": via})
        return html_text

    first = add(0)
    pages, total = page_count(first), total_count(first)
    want = pages if total is None else max(pages, math.ceil(total / max(fetched[0]["so_dong"], 1)))
    ui_all = False
    if ui_pager and (total is None or len(out) < total):
        ui_all = True
        for idx in range(1, min(want, MAX_PAGES)):
            html_text = _ui_page(driver, idx)
            if html_text is None:
                ui_all = False
                break
            add(idx, html_text)
            if total is not None and len(out) >= total:
                break
        if any(f.get("cach") == "trang_emr" for f in fetched):
            _ui_page(driver, 0)  # đọc xong đưa trang EMR về trang 1 như lúc mở, không để nằm ở trang cuối
    if total is None:
        for page in range(1, min(pages, MAX_PAGES) if not ui_all else 1):
            add(page)
    else:
        # Ô "Trang x/y" có lúc tính theo cỡ trang đã gửi (500) nên ghi 1 trang dù EMR chia 18 dòng/trang:
        # đọc theo "Tổng số" tới đủ. Số trang có thể tính từ 0 hoặc 1 nên cho phép một trang trùng;
        # hai trang liền không thêm ai thì dừng, không gọi EMR mãi.
        last = min(max(pages, math.ceil(total / max(fetched[0]["so_dong"], 1))), MAX_PAGES)
        page, empty = 1, 0
        while len(out) < total and page <= last:
            add(page)
            empty = empty + 1 if fetched[-1]["moi"] == 0 else 0
            if empty >= 2:
                break
            page += 1
        if len(out) < total:
            print(f"[CLINIC-MONITOR] [WARN] Danh sách EMR ghi tổng số {total} lượt, mới đọc được {len(out)}.")
    trace("doc_danh_sach", loc=(day_filter or {}).get("loai", "0"), so_trang_emr=pages, tong_so_emr=total,
          trang=fetched, doc_duoc=len(out), ms=_ms(started))
    return out


class Monitor:
    def __init__(self, config: Dict[str, Any], list_url: str, headless: bool) -> None:
        self.config = config
        self.list_url = list_url
        self.headless = headless
        self.driver: Any = None
        self.wait: Any = None
        self.login_count = 0
        self.list_date = ""  # rỗng = hôm nay; yyyy-mm-dd = ngày đã qua người dùng chọn để xem lại
        self.shown_filter: Dict[str, str] = {"loai": "0"}  # bộ lọc đang hiện trên trang EMR (mở trang = "Trong ngày")
        # URL Danh sách Khám bệnh dựng 1 lần sau đăng nhập. Không dựng lại từ trang đang mở: trang D/s Thủ thuật
        # có tham số riêng (tg=7, tungay, keyword…) bị mang theo làm danh sách đọc ra 0 người.
        self.list_page_url = ""
        self.last_count = 0

    def _open_list(self) -> None:
        if not self.list_page_url:
            self.list_page_url = _build_clinic_url(self.driver.current_url, self.list_url)
        self.driver.get(self.list_page_url)
        wait_page(self.driver, 1.0)
        self.shown_filter = {"loai": "0"}

    def _show_day(self, day_filter: Dict[str, str]) -> None:
        """Đặt ngày đang xem lên bộ lọc của trang EMR (chỉ khi đổi ngày). Lỗi thì vẫn đọc được vì lệnh đọc
        tự mang theo khoảng ngày; chỉ là trang EMR không hiện đúng ngày."""
        if day_filter == self.shown_filter:
            return
        try:
            res = self.driver.execute_script(SET_DAY_JS, day_filter) or {}
        except Exception as e:  # trang đang tải lại… → lần đọc sau đặt lại
            res = {"ok": False, "reason": compact(str(e))[:120]}
        if res.get("ok"):
            wait_page(self.driver, 1.0)
            self.shown_filter = dict(day_filter)
        else:
            print(f"[CLINIC-MONITOR] [WARN] Không đặt được ngày trên trang EMR ({res.get('reason') or 'unknown'}); vẫn đọc theo ngày đã chọn.")

    def _login(self) -> None:
        if self.driver is None:
            print(f">>> Mở Chrome theo dõi phòng khám: headless={self.headless}")
            self.driver, self.wait = init_driver(headless=self.headless)
        login_emr(self.driver, self.wait, self.config)
        self.list_page_url = ""  # phiên mới: dựng lại URL danh sách theo usid/st mới
        self.login_count += 1
        trace("dang_nhap", lan=self.login_count)
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
                day_filter = list_filter(self.list_date, _now().date())
                self._show_day(day_filter)
                rows = fetch_today_rows(self.driver, day_filter, ui_pager=self.shown_filter == day_filter)
                if not rows and self.last_count:
                    # Vừa có người mà nay ra 0: thường do trang EMR đang ở trạng thái lạ (vừa nhập thủ thuật…).
                    # Mở lại danh sách và đọc lại 1 lần trước khi tin.
                    trace("doc_lai_danh_sach", ly_do="đọc ra 0 người", truoc_do=self.last_count)
                    self._open_list()
                    self._show_day(day_filter)
                    rows = fetch_today_rows(self.driver, day_filter, ui_pager=self.shown_filter == day_filter)
                self.last_count = len(rows)
                return rows
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
        missing: List[Dict[str, Any]] = []
        try:
            for _ in range(min(pending_procedures(row), 3)):
                started = time.time()
                res = enter_procedure(ProcedurePage(self.driver, self.wait, self.config), row, self.config, _now())
                trace("nhap_thu_thuat", stt=row.get("stt"), ref=trace_ref(row.get("khambenhid")), ket_qua=res.get("result"),
                      thong_bao=compact(res.get("message"))[:200], ms=_ms(started))
                missing += [m for m in res.get("missing_templates") or [] if m not in missing]
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
        return {**result, "steps": steps, "procedure_end": last_end, "missing_templates": missing}

    def imaging(self, row: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Đọc popup lịch sử dịch vụ (đang ở trang danh sách): các chỉ định chụp CT / MRI."""
        started = time.time()
        res = self.driver.execute_script(HISTORY_JS, row.get("khambenhid")) or {}
        trace("doc_lich_su_dv", stt=row.get("stt"), ref=trace_ref(row.get("khambenhid")), ly_do="chỉ định CĐHA",
              ok=bool(res.get("ok")), ms=_ms(started))
        if not res.get("ok"):
            raise ExamStepError(f"Không đọc được lịch sử dịch vụ: {compact(res.get('message'))}")
        return clinic_bbhc.imaging_orders(res.get("html") or "")

    def on_exam_page(self, row: Dict[str, Any], action: Callable[[ExamPage, Optional[datetime], datetime], Dict[str, Any]],
                     need_services: bool = True) -> Dict[str, Any]:
        """Mở màn khám của người bệnh, chạy `action`, rồi quay về danh sách."""
        now = _now()
        caller = sys._getframe(1).f_code.co_name
        started = time.time()
        result = self._on_exam_page(row, action, need_services, now)
        trace("mo_man_kham", stt=row.get("stt"), ref=trace_ref(row.get("khambenhid")), ly_do=WHY_LABELS.get(caller, caller),
              trang_thai=row.get("trang_thai"), xu_tri=row.get("xu_tri"),
              ket_qua=result.get("status") or result.get("result"), thong_bao=compact(result.get("message"))[:200],
              ms=_ms(started))
        return result

    def _on_exam_page(self, row: Dict[str, Any], action: Callable[[ExamPage, Optional[datetime], datetime], Dict[str, Any]],
                      need_services: bool, now: datetime) -> Dict[str, Any]:
        try:
            done_at = self.services_done(row, now) if need_services else None
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


# ── Chi tiết lượt khám (chỉ đọc) ─────────────────────────────────────────────
# Trạng thái từng người đã có ở Danh sách Khám bệnh, nên vòng theo dõi không mở màn khám từng người
# chỉ để xem (người đã Hoàn tất càng không). Các hàm dưới đây đọc chẩn đoán, chi tiết xử trí, ngày hẹn
# tái khám khi đã ở sẵn màn khám của một việc cần làm. Không bấm nút nào trên EMR.

HEN_RE = re.compile(r"\bhen\b|tai kham")


def hen_tai_kham_from_xutri(fields: List[Dict[str, Any]]) -> str:
    """Ngày hẹn tái khám trong popup Chi tiết xử trí (tìm theo nhãn có chữ "hẹn" / "tái khám")."""
    for f in fields or []:
        value = compact(f.get("value"))
        if value and HEN_RE.search(norm(f.get("label"))):
            dt = parse_emr_dt(value)
            if dt:
                return fmt_emr_dt(dt)
            m = re.search(r"\d{1,2}/\d{1,2}/\d{4}", value)
            if m:
                return m.group(0)
    return ""


def read_visit_details(page: "ExamPage", row: Dict[str, Any]) -> Dict[str, Any]:
    info = page.js(clinic_bbhc.EXAM_INFO_JS) or {}
    fields: List[Dict[str, Any]] = []
    try:
        page._open_xutri()
        fields = page.js(clinic_bbhc.XUTRI_FIELDS_JS) or []
    except ExamStepError:
        fields = []  # lượt chưa có / không mở được popup xử trí: vẫn giữ phần chẩn đoán
    finally:
        page._close_xutri()
    by_id = {f.get("id"): compact(f.get("value")) for f in fields if f.get("id")}
    return {
        "status": "ok",
        "stage": row.get("stage"),
        "trang_thai": row.get("trang_thai"),
        "xu_tri": row.get("xu_tri"),
        "ly_do": compact(info.get("ly_do")),
        "dau_hieu": compact(info.get("dau_hieu")),
        "so_bo": compact(info.get("so_bo")),
        "cd_chinh": compact(info.get("cd_chinh")),
        "cd_kem_theo": [compact(x) for x in info.get("cd_kem_theo") or [] if compact(x)],
        "ket_luan": compact(info.get("ket_luan")),
        "thoi_gian_ra": by_id.get("txtThoigianRa", ""),
        "hen_tai_kham": hen_tai_kham_from_xutri(fields),
        "xu_tri_fields": [{"label": compact(f.get("label")), "value": compact(f.get("value"))}
                          for f in fields if compact(f.get("value")) and f.get("label") != f.get("id")],
    }


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
        log.append({"at": _now().isoformat(), "kind": "sbbhc", "khambenhid": key, "ma_bn": row.get("ma_bn"), "ho_ten": row.get("ho_ten"),
                    "result": result, "message": res.get("message"), "steps": res.get("steps") or []})
        if result == "session":
            break
    return pdfs


# ── Việc cần làm: thủ thuật làm ngay khi có chỉ định ─────────────────────────
# Không chờ tới lúc hoàn tất khám: có chỉ định thủ thuật (TT) là nhập luôn (giờ chỉ định → +10 phút,
# thủ thuật viên theo Lịch Phòng khám). Chạy khi người dùng bấm "Hoàn thành thủ thuật ngay", hoặc
# mỗi chu kỳ khi người dùng bật "Tự hoàn thành khi có chỉ định".

TASK_CASES_EXCLUDED = {"nhap_vien", "ngoai_tru"}  # nhập viện / ngoại trú làm ở luồng riêng
MAX_TASKS_PER_CYCLE = 4
PAYMENT_RETRY = timedelta(minutes=5)  # viện phí chưa đóng tiền: xem lại D/s Thủ thuật sau mỗi 5 phút


class ProcedureNotListed(RuntimeError):
    """Người bệnh chưa có dòng trên D/s Thủ thuật (viện phí chưa đóng tiền)."""


def pending_surgeries(row: Dict[str, Any]) -> int:
    pt = next((s for s in row.get("services") or [] if s.get("code") == "PT"), None)
    return max(int(pt["total"]) - int(pt["done"]), 0) if pt else 0


def procedure_task_candidate(row: Dict[str, Any]) -> bool:
    """Người bệnh đang khám, có thủ thuật chưa xong, không thuộc luồng nhập viện / ngoại trú.
    BHYT làm được ngay; viện phí chỉ làm được sau khi đóng tiền (run_tasks xếp BHYT trước)."""
    return row.get("stage") in ACTIVE_STAGES \
        and row.get("case") not in TASK_CASES_EXCLUDED and pending_procedures(row) > 0


def _auto_should_run(prev: Optional[Dict[str, Any]], pending: int, now: datetime) -> bool:
    """Chế độ tự động: lỗi / thiếu dữ liệu thì không tự thử lại khi chỉ định chưa đổi; đang chờ đủ giờ
    thì chỉ thử khi tới giờ. Bấm tay luôn thử lại."""
    if not prev or int(prev.get("pending") or 0) != pending:
        return True
    status = prev.get("status")
    if status == "waiting":
        earliest = prev.get("earliest")
        return not earliest or now >= datetime.fromisoformat(earliest)
    return status not in {"error", "incomplete", "no_drug", "done"}


def _prepare_procedures(page: ExamPage) -> Dict[str, Any]:
    """Màn khám: thủ thuật còn "Mới" thì bấm Thực hiện để chuyển sang D/s Thủ thuật."""
    steps: List[str] = []
    if page.new_procedures():
        toasts = page.send_to_services()
        steps.append("Bấm Thực hiện (thủ thuật mới)" + (f" ({toasts[-1]})" if toasts else ""))
    return {"status": "ready", "steps": steps}


def run_tasks(monitor: "Monitor", rows: List[Dict[str, Any]], state: Dict[str, Dict[str, Any]],
              log: List[Dict[str, Any]], auto: bool, now: Optional[datetime] = None,
              checks: Optional[Dict[str, Dict[str, Any]]] = None, weights: Optional[Dict[str, Any]] = None,
              missing: Optional[Dict[str, Dict[str, Any]]] = None) -> int:
    """Nhập thủ thuật cho người bệnh có chỉ định. Nhập xong mà người bệnh đủ điều kiện hoàn tất khám
    (Cho về / Chuyển viện, dịch vụ khác đã xong) thì mở màn khám xem trước: có thuốc thì Vào khám và
    Hoàn tất luôn, chưa có thuốc thì quay lại. Trả số người đã thao tác."""
    checks = checks if checks is not None else {}
    now = now or _now()
    acted = 0
    # BHYT trước (làm được ngay), viện phí sau; trong mỗi nhóm giữ thứ tự danh sách (đã đọc hết các trang).
    for row in sorted(rows, key=lambda r: not r.get("has_bhyt")):
        key = row.get("khambenhid") or ""
        if acted >= MAX_TASKS_PER_CYCLE or not key or not row.get("href") or not procedure_task_candidate(row):
            continue
        pending = pending_procedures(row)
        if auto and not _auto_should_run(state.get(key), pending, now):
            continue
        # Viện phí không bấm Thực hiện trên màn khám: thủ thuật tự hiện trên D/s Thủ thuật khi đã đóng tiền.
        pre = monitor.on_exam_page(row, lambda page, _done, _now_: _prepare_procedures(page), need_services=False) \
            if row.get("has_bhyt") else {"status": "ready", "steps": []}
        if pre.get("status") == "ready":
            res = monitor.run_procedures(row)
            res = {**res, "steps": (pre.get("steps") or []) + (res.get("steps") or [])}
            note_missing_templates(missing, row, res)
        else:
            res = {**pre, "result": pre.get("status")}
        result = res.get("result") or res.get("status")
        entry = {"status": result, "message": res.get("message") or ("Đã nhập thủ thuật" if result == "done" else ""),
                 "pending": pending, "at": _now().isoformat()}
        if isinstance(res.get("earliest"), datetime):
            entry["earliest"] = res["earliest"].isoformat()
        state[key] = entry
        log.append({"at": _now().isoformat(), "kind": "thu_thuat", "khambenhid": key, "ma_bn": row.get("ma_bn"),
                    "ho_ten": row.get("ho_ten"), "result": result, "message": entry["message"], "steps": res.get("steps") or []})
        acted += 1
        print(f"[CLINIC-MONITOR] Thủ thuật STT {row.get('stt')}: {result}")
        if result == "session":
            break
        if result == "done" and eligible_for_completion(row):
            kg = parse_weight((weights or {}).get(key)) or None
            done = complete_on_exam_page(monitor, row, res.get("procedure_end"), kg)
            if record_completion(row, done, checks, log) == "session":
                break
    return acted


# ── TH6: điều trị ngoại trú ──────────────────────────────────────────────────

def ngoaitru_candidate(row: Dict[str, Any]) -> bool:
    """Người bệnh (BHYT hoặc viện phí) xử trí / trạng thái Điều trị ngoại trú."""
    return row.get("case") == "ngoai_tru" or row.get("stage") == "ngoai_tru"


def clinic_doctor(config: Dict[str, Any], now: datetime) -> str:
    from clinic_input_care import clinic_doctors_for_date

    names = clinic_doctors_for_date(config.get("clinic_nurse_schedule") or {}, now.strftime("%d/%m/%Y"))
    return names[0] if names else ""


def run_ngoaitru(monitor: "Monitor", rows: List[Dict[str, Any]], state: Dict[str, Dict[str, Any]],
                 log: List[Dict[str, Any]], missing: Optional[Dict[str, Dict[str, Any]]] = None) -> int:
    """TH6 cho mọi người bệnh đủ điều kiện — chỉ gọi khi người dùng bấm nút."""
    patients = [{"ma_bn": compact(r.get("ma_bn")), "ho_ten": r.get("ho_ten"), "exam_time": parse_emr_dt(r.get("thoi_gian")),
                 "khambenhid": r.get("khambenhid") or "", "has_bhyt": bool(r.get("has_bhyt")),
                 "pending_pt": pending_surgeries(r)}
                for r in rows if ngoaitru_candidate(r) and compact(r.get("ma_bn"))]
    if not patients:
        return 0
    flow = clinic_ngoaitru.NgoaiTruFlow(monitor.driver, monitor.config, ExamPage(monitor.driver))
    try:
        results = clinic_ngoaitru.run_all(flow, patients, clinic_doctor(monitor.config, _now()), _now,
                                         procedure_staff(monitor.config, _now()))
    except Exception as e:  # lỗi đọc danh sách: báo chung cho mọi người
        results = {p["ma_bn"]: {"result": "error", "message": f"Lỗi đọc danh sách ngoại trú: {compact(str(e))[:300]}", "steps": []}
                   for p in patients}
    if "login.aspx" in (monitor.driver.current_url or "").lower():
        monitor.close()
    else:
        try:
            monitor._open_list()
        except Exception:
            monitor.close()
    for p in patients:
        res = results.get(p["ma_bn"]) or {}
        note_missing_templates(missing, p, res)
        state[p["ma_bn"]] = {"status": res.get("result"), "message": res.get("message") or "", "at": _now().isoformat()}
        log.append({"at": _now().isoformat(), "kind": "dieu_tri_ngoai_tru", "khambenhid": p["khambenhid"], "ma_bn": p["ma_bn"],
                    "ho_ten": p["ho_ten"], "result": res.get("result"),
                    "message": res.get("message") or ("Đã kết thúc điều trị ngoại trú" if res.get("result") == "done" else ""),
                    "steps": res.get("steps") or []})
    return len(patients)


def complete_on_exam_page(monitor: "Monitor", row: Dict[str, Any], procedure_end: Optional[datetime],
                          weight_kg: Optional[float], end_of_day: bool = False) -> Dict[str, Any]:
    """Mở màn khám, xem đơn thuốc trước; đủ điều kiện thì Vào khám và Hoàn tất, không thì quay lại danh sách
    mà không bấm gì (complete_patient kiểm tra hết trước khi bấm)."""

    def complete(page: ExamPage, done_at: Optional[datetime], now: datetime) -> Dict[str, Any]:
        # Hoàn tất khám phải sau khi thủ thuật kết thúc (+1 phút), thời gian ra sửa theo đó.
        latest = max(d for d in (done_at, procedure_end) if d) if (done_at or procedure_end) else None
        return complete_patient(page, row, latest, now, weight_kg, end_of_day)

    return monitor.on_exam_page(row, complete)


def record_completion(row: Dict[str, Any], res: Dict[str, Any], checks: Dict[str, Dict[str, Any]],
                      log: List[Dict[str, Any]]) -> str:
    key = row.get("khambenhid") or ""
    result = res.get("result") or res.get("status")
    checks[key] = {"status": "done" if result == "done" else result, "message": res.get("message"), "at": _now().isoformat()}
    log.append({"at": _now().isoformat(), "kind": "hoan_tat_kham", "khambenhid": key, "ma_bn": row.get("ma_bn"), "ho_ten": row.get("ho_ten"),
                "result": result, "message": res.get("message"), "steps": res.get("steps") or []})
    print(f"[CLINIC-MONITOR] Hoàn tất khám STT {row.get('stt')}: {result}")
    return result


def run_completions(monitor: "Monitor", rows: List[Dict[str, Any]], checks: Dict[str, Dict[str, Any]],
                    weights: Dict[str, Any], log: List[Dict[str, Any]], end_of_day: bool = False,
                    missing: Optional[Dict[str, Dict[str, Any]]] = None) -> int:
    """Hoàn tất khám mọi người bệnh đủ điều kiện — chỉ gọi khi người dùng bấm nút. Cuối ngày: hoàn tất cả
    người chưa có thuốc và người chuyển khám chuyên khoa, rồi ghi lại những ai còn treo và vì sao."""
    acted = 0
    for row in rows:
        key = row.get("khambenhid") or ""
        if not key or not row.get("href") or not eligible_for_completion(row, end_of_day):
            continue
        kg = parse_weight(weights.get(key))
        tt: Dict[str, Any] = {"result": "done", "steps": [], "procedure_end": None}
        if pending_procedures(row):
            # Kiểm tra (chỉ đọc) màn khám trước: chờ đọc KQ chưa có thuốc / chưa đủ giờ thì chưa nhập thủ thuật.
            pre = monitor.on_exam_page(row, lambda page, done_at, now: ready_for_procedures(page, row, done_at, now, end_of_day))
            if pre.get("status") == "ready":
                tt = monitor.run_procedures(row)
                tt["steps"] = (pre.get("steps") or []) + (tt.get("steps") or [])
                note_missing_templates(missing, row, tt)
            else:
                tt = {**pre, "result": pre.get("status")}
        if tt["result"] == "done":
            res = complete_on_exam_page(monitor, row, tt.get("procedure_end"), kg or None, end_of_day)
        else:
            res = tt
        res = {**res, "steps": (tt.get("steps") or []) + ([] if res is tt else (res.get("steps") or []))}
        result = record_completion(row, res, checks, log)
        acted += 1
        if result == "session":
            break
    if end_of_day:
        left = still_open(rows, checks)
        log.append({"at": _now().isoformat(), "kind": "cuoi_ngay", "result": "done" if not left else "incomplete",
                    "message": f"Cuối ngày còn {len(left)} lượt chưa hoàn tất" if left else "Cuối ngày: đã hoàn tất hết",
                    "steps": [f"{r.get('ho_ten')} ({r.get('ma_bn')}): {reason}" for r, reason in left]})
    return acted


def still_open(rows: List[Dict[str, Any]], checks: Dict[str, Dict[str, Any]]) -> List[Any]:
    """Lượt còn đang khám sau khi hoàn tất cuối ngày, kèm lý do."""
    out = []
    for r in rows:
        if r.get("stage") not in ACTIVE_STAGES or (checks.get(r.get("khambenhid") or "") or {}).get("status") == "done":
            continue
        check = checks.get(r.get("khambenhid") or "") or {}
        if r.get("case") in {"nhap_vien", "ngoai_tru"}:
            reason = NEXT_ACTION[r["case"]]
        elif r.get("case") == "chua_xu_tri":
            reason = "Chưa có xử trí"
        elif r.get("blockers"):
            reason = "; ".join(r["blockers"])
        else:
            reason = check.get("message") or "Chưa hoàn tất được"
        out.append((r, reason))
    return out


def note_missing_templates(missing: Optional[Dict[str, Dict[str, Any]]], row: Dict[str, Any], res: Dict[str, Any]) -> None:
    """Ghi lại DVKT chưa có mẫu (tab Mẫu thủ thuật – PT hiện danh sách này để tạo mẫu)."""
    if missing is None:
        return
    for m in res.get("missing_templates") or []:
        key = f"{m.get('kind')}:{norm(m.get('name'))}"
        entry = missing.setdefault(key, {"kind": m.get("kind"), "name": m.get("name"), "count": 0})
        entry.update({"ma_bn": row.get("ma_bn"), "ho_ten": row.get("ho_ten"), "at": _now().isoformat()})
        entry["count"] += 1


def public_rows(rows: List[Dict[str, Any]], checks: Dict[str, Dict[str, Any]], weights: Dict[str, Any],
                imaging: Optional[Dict[str, Dict[str, Any]]] = None,
                bbhc_state: Optional[Dict[str, Dict[str, Any]]] = None,
                ngoaitru_state: Optional[Dict[str, Dict[str, Any]]] = None,
                details: Optional[Dict[str, Dict[str, Any]]] = None,
                task_state: Optional[Dict[str, Dict[str, Any]]] = None) -> List[Dict[str, Any]]:
    out = []
    for r in rows:
        item = {k: v for k, v in r.items() if k != "href"}  # href mang mã phiên EMR
        key = r.get("khambenhid") or ""
        item["bbhc"] = bbhc_reasons(r, ((imaging or {}).get(key) or {}).get("kinds"))
        item["bbhc_state"] = (bbhc_state or {}).get(key) if item["bbhc"] else None
        item["ngoaitru"] = ngoaitru_candidate(r)
        item["ngoaitru_state"] = (ngoaitru_state or {}).get(compact(r.get("ma_bn"))) if item["ngoaitru"] else None
        item["eligible"] = eligible_for_completion(r)
        item["check"] = checks.get(key) if item["eligible"] else None
        item["weight_entered"] = parse_weight(weights.get(key)) or None
        item["imaging_orders"] = ((imaging or {}).get(key) or {}).get("orders") or []
        item["details"] = (details or {}).get(key)
        item["pending_tt"] = pending_procedures(r)
        item["pending_pt"] = pending_surgeries(r)
        item["procedure_task"] = procedure_task_candidate(r)
        task = (task_state or {}).get(key)
        item["tt_task"] = {k: v for k, v in task.items() if k in {"status", "message", "at", "earliest"}} if task else None
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
    handled_ngoaitru = initial.get("ngoaitruNow")
    handled_tasks = initial.get("tasksNow")
    task_state: Dict[str, Dict[str, Any]] = {}
    ngoaitru_state: Dict[str, Dict[str, Any]] = {}
    visit_details: Dict[str, Dict[str, Any]] = {}
    state_dir = os.path.dirname(os.path.abspath(state_path))
    set_trace_dir(state_dir)
    action_log: List[Dict[str, Any]] = []
    missing_templates: Dict[str, Dict[str, Any]] = {}

    def _list_date(ctrl: Dict[str, Any]) -> str:
        return past_list_date(ctrl["listDate"] if "listDate" in ctrl else req.get("listDate"), _now().date())

    try:
        while True:
            state["last_attempt_at"] = _now().isoformat()
            ctrl = _read_control(control_path)
            weights = ctrl.get("weights") if isinstance(ctrl.get("weights"), dict) else {}
            cycle_started, logged = time.time(), len(action_log)
            trace("bat_dau_chu_ky", ngay=_list_date(ctrl) or "hôm nay")
            try:
                monitor.list_date = list_date = _list_date(ctrl)
                rows = monitor.read()
                if list_date:
                    # Xem lại ngày đã qua: chỉ đọc danh sách (và chẩn đoán cho nghỉ ốm), không mở màn khám
                    # kiểm tra, không nhập/hoàn tất gì trên EMR. Lệnh bấm lúc đang xem ngày cũ bị bỏ qua.
                    handled_complete, handled_tasks = ctrl.get("completeNow"), ctrl.get("tasksNow")
                    handled_prepare, handled_ngoaitru, handled_bbhc = ctrl.get("bbhcPrepare"), ctrl.get("ngoaitruNow"), ctrl.get("bbhcRun")
                    state["auto_tasks"] = bool(ctrl["autoTasks"]) if "autoTasks" in ctrl else bool(req.get("autoTasks"))
                else:
                    if ctrl.get("completeNow") and ctrl.get("completeNow") != handled_complete:
                        handled_complete = ctrl.get("completeNow")
                        state["action_running"] = True
                        write_json(state_path, state)
                        if run_completions(monitor, rows, checks, weights, action_log,
                                           end_of_day=bool(ctrl.get("endOfDay")), missing=missing_templates):
                            rows = monitor.read()
                        state["action_running"] = False
                        state["last_action_at"] = _now().isoformat()
                    auto_tasks = bool(ctrl["autoTasks"]) if "autoTasks" in ctrl else bool(req.get("autoTasks"))
                    state["auto_tasks"] = auto_tasks
                    tasks_now = ctrl.get("tasksNow") and ctrl.get("tasksNow") != handled_tasks
                    if tasks_now or auto_tasks:
                        if tasks_now:
                            handled_tasks = ctrl.get("tasksNow")
                        state["action_running"] = True
                        write_json(state_path, state)
                        if run_tasks(monitor, rows, task_state, action_log, auto=not tasks_now, checks=checks, weights=weights,
                                     missing=missing_templates):
                            rows = monitor.read()
                        state["action_running"] = False
                        state["last_action_at"] = _now().isoformat()
                    scan_imaging(monitor, rows, imaging)
                    if auto_tasks:
                        # Soạn sẵn nháp SBBHC (chỉ đọc màn khám) ngay khi có chỉ định; lập trên EMR vẫn chờ người dùng duyệt.
                        run_bbhc_prepare(monitor, [r for r in rows if (r.get("khambenhid") or "") not in bbhc], imaging, bbhc)
                    if ctrl.get("bbhcPrepare") and ctrl.get("bbhcPrepare") != handled_prepare:
                        handled_prepare = ctrl.get("bbhcPrepare")
                        state["action_running"] = True
                        write_json(state_path, state)
                        run_bbhc_prepare(monitor, rows, imaging, bbhc)
                        state["action_running"] = False
                    if ctrl.get("ngoaitruNow") and ctrl.get("ngoaitruNow") != handled_ngoaitru:
                        handled_ngoaitru = ctrl.get("ngoaitruNow")
                        state["action_running"] = True
                        write_json(state_path, state)
                        if run_ngoaitru(monitor, rows, ngoaitru_state, action_log, missing_templates):
                            rows = monitor.read()
                        state["action_running"] = False
                        state["last_action_at"] = _now().isoformat()
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
                    "rows": public_rows(rows, checks, weights, imaging, bbhc, ngoaitru_state, visit_details, task_state),
                    "action_log": action_log[-50:],
                    "missing_templates": sorted(missing_templates.values(), key=lambda m: m["at"], reverse=True),
                    "summary": summarize(rows),
                    "updated_at": _now().isoformat(),
                    "list_date": list_date,
                    "read_only": bool(list_date),
                    "last_error": "",
                    "consecutive_failures": 0,
                })
                print(f"[CLINIC-MONITOR] Đã đọc {len(rows)} người bệnh.")
                _trace_actions(action_log[logged:])
                trace("ket_thuc_chu_ky", so_nguoi=len(rows), theo_trang_thai=summarize(rows)["by_stage"], ms=_ms(cycle_started))
            except Exception as e:
                state["consecutive_failures"] = int(state.get("consecutive_failures") or 0) + 1
                state["last_error"] = compact(str(e))[:500]
                _trace_actions(action_log[logged:])
                trace("loi_chu_ky", thong_bao=state["last_error"][:300], ms=_ms(cycle_started))
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
                if _list_date(ctrl) != monitor.list_date:
                    break
                if ctrl.get("completeNow") and ctrl.get("completeNow") != handled_complete:
                    break
                if ctrl.get("ngoaitruNow") and ctrl.get("ngoaitruNow") != handled_ngoaitru:
                    break
                if ctrl.get("tasksNow") and ctrl.get("tasksNow") != handled_tasks:
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
