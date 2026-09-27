# -*- coding: utf-8 -*-
"""Theo dõi Danh sách Khám bệnh (tab Phòng khám) — chỉ đọc, không ghi EMR.

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
from typing import Any, Dict, List, Optional

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
    "chuyen_vien": "Nhập BBHC",
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
        if cho_doc_kq:
            blockers.append("Chờ đọc kết quả")
        if case == "chua_xu_tri":
            blockers.append("Chưa có xử trí")

    next_action = NEXT_ACTION[case]
    if case == "cho_ve" and has_tt:
        next_action = "Hoàn tất thủ thuật rồi hoàn tất khám"
    if stage == "xong":
        next_action = "Đã xong"
    elif stage == "cho_kham":
        next_action = "Chờ khám"

    actionable = case in {"cho_ve", "nhap_vien", "chuyen_vien"}
    return {
        "khambenhid": compact(row.get("access_id")),
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
    handled_refresh = _read_control(control_path).get("refresh")
    try:
        while True:
            state["last_attempt_at"] = _now().isoformat()
            try:
                rows = monitor.read()
                state.update({
                    "status": "running",
                    "rows": rows,
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
