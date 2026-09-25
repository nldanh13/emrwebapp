# -*- coding: utf-8 -*-
"""vtyt_emr_catalog_scan.py — Dò danh mục VTYT đang có trên EMR (CHỈ ĐỌC).

Mở popup "Nhập thuốc/VTYT sử dụng" của 1 người bệnh, gõ lần lượt các từ khóa
vào ô chọn vật tư (#txtHang) và ghi lại mọi dòng EMR trả về (mã, tên, dòng gốc).
Không bấm Thêm/Xác nhận — không ghi gì vào EMR.

Kết quả dùng để:
- biết EMR đang có những loại VTYT nào (vd tìm đúng dòng Urgotile) rồi điền mã
  ở màn hình Danh mục VTYT;
- worker input_vtyt.py kiểm tra trước khi nhập: vật tư không có trong lần dò
  gần nhất thì không nhập mù.

Chạy: python vtyt_emr_catalog_scan.py <ma_bn> <out.json> [từ khóa ...]
"""
from __future__ import annotations

import json
import re
import sys
import time
from datetime import datetime
from typing import Any, Dict, List

from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

from utils import load_config, login_emr
from shared.worker_session import open_session
from selenium_emr_helpers import debug_page, goto_inpatient_list, safe_js_click, search_patient_on_ward_or_raise, wait_after_action
from input_vtyt import (
    _close_modal_if_possible,
    _log,
    _open_nursing_view_from_list,
    _open_vtyt_menu,
    _open_vtyt_popup,
    _select_loai_ke_du_tru,
)

DEFAULT_QUERIES = [
    "", "băng", "urgo", "thun", "dán", "gạc", "kim", "bơm", "găng", "dây",
    "sonde", "túi", "khóa", "nút", "mặt nạ", "ống", "catheter", "chỉ", "tegaderm",
]

_CODE_RE = re.compile(r"VTYT\.\d+", re.IGNORECASE)
_SKIP_TEXTS = ("no results", "không tìm thấy", "searching", "đang tìm", "please enter", "vui lòng nhập")


def parse_option_text(text: str) -> Dict[str, str]:
    """Tách mã VTYT và tên từ 1 dòng Select2 (định dạng dòng EMR có thể thay đổi)."""
    raw = re.sub(r"\s+", " ", str(text or "")).strip()
    m = _CODE_RE.search(raw)
    code = m.group(0).upper() if m else ""
    name = raw
    if code:
        name = re.sub(r"\s*[-|:]?\s*" + re.escape(m.group(0)) + r"\s*[-|:]?\s*", " ", raw, flags=re.IGNORECASE).strip()
    return {"code": code, "name": name, "raw": raw}


def merge_scan_rows(rows_by_query: Dict[str, List[str]]) -> List[Dict[str, Any]]:
    """Gộp dòng trùng giữa các từ khóa; giữ danh sách từ khóa đã thấy dòng đó."""
    out: Dict[str, Dict[str, Any]] = {}
    for query, texts in rows_by_query.items():
        for text in texts:
            item = parse_option_text(text)
            if not item["raw"] or any(s in item["raw"].lower() for s in _SKIP_TEXTS):
                continue
            key = item["code"] or item["raw"].lower()
            row = out.setdefault(key, {**item, "queries": []})
            if query not in row["queries"]:
                row["queries"].append(query)
    return sorted(out.values(), key=lambda r: (r["name"].lower(), r["code"]))


def _read_options_for_query(driver: Any, query: str) -> List[str]:
    box = None
    for sel in ["#select2-txtHang-container", "#txtHang + .select2 .select2-selection"]:
        found = driver.find_elements(By.CSS_SELECTOR, sel)
        if found:
            box = found[0]
            break
    if box is None:
        raise RuntimeError("Không thấy ô chọn vật tư #txtHang.")
    safe_js_click(driver, box)
    search = WebDriverWait(driver, 8).until(
        EC.element_to_be_clickable((By.CSS_SELECTOR, ".select2-container--open .select2-search__field"))
    )
    search.send_keys(Keys.CONTROL, "a")
    search.send_keys(Keys.DELETE)
    if query:
        search.send_keys(query)
    wait_after_action(driver, 1.2, ready_timeout=6)
    texts = []
    for opt in driver.find_elements(By.CSS_SELECTOR, "#select2-txtHang-results .select2-results__option"):
        t = (opt.text or "").replace("\n", " ").strip()
        if t:
            texts.append(t)
    try:
        search.send_keys(Keys.ESCAPE)
    except Exception:
        pass
    time.sleep(0.2)
    return texts


def main(argv: List[str]) -> int:
    if len(argv) < 3:
        print("Usage: python vtyt_emr_catalog_scan.py <ma_bn> <out.json> [từ khóa ...]", file=sys.stderr)
        return 1
    ma_bn, out_path = argv[1].strip(), argv[2]
    queries = [q for q in argv[3:]] or DEFAULT_QUERIES
    report: Dict[str, Any] = {"status": "error", "ma_bn": ma_bn, "queries": queries, "items": []}
    config = load_config()
    try:
        with open_session(out_path + ".session.json", config=config) as ws:
            driver, wait = ws.driver, ws.wait
            goto_inpatient_list(driver, wait, dict(config), login_func=login_emr, log_func=_log)
            search_patient_on_ward_or_raise(driver, wait, dict(config), ma_bn, login_func=login_emr, log_func=_log, allow_completed=True)
            _open_nursing_view_from_list(driver, wait, ma_bn)
            _open_vtyt_menu(driver, wait)
            _open_vtyt_popup(driver, wait)
            _select_loai_ke_du_tru(driver)
            rows_by_query: Dict[str, List[str]] = {}
            for q in queries:
                try:
                    rows_by_query[q] = _read_options_for_query(driver, q)
                    _log(f"   [DÒ VTYT] '{q}': {len(rows_by_query[q])} dòng")
                except Exception as e:
                    _log(f"   [DÒ VTYT][WARN] '{q}': {e}")
                    rows_by_query[q] = []
            _close_modal_if_possible(driver)
            items = merge_scan_rows(rows_by_query)
            report.update({
                "status": "ok",
                "scanned_at": datetime.now().strftime("%H:%M %d/%m/%Y"),
                "items": items,
                "count": len(items),
                "codes": sorted({i["code"] for i in items if i["code"]}),
            })
            ws.mark_success(ma_bn)
    except Exception as e:
        report["message"] = f"Không dò được danh mục VTYT: {e}"
        _log(f"[FAIL] {report['message']}")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    return 0 if report["status"] == "ok" else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
