# -*- coding: utf-8 -*-
"""Save inpatient billing statement PDF for one patient from EMR.

Flow:
  bấm tên người bệnh → nút in → Bảng kê chi phí nội trú_Dọc(CV6556)
Then read the generated PDF iframe/temp URL and save it to a session folder.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import urljoin

try:
    import requests  # type: ignore
except Exception:  # pragma: no cover
    requests = None  # type: ignore

from utils import load_config
from hchanh_fetch import (  # type: ignore
    _init_session,
    _ensure_hchanh_click_context,
    _open_patient_entry_from_context,
    _selenium_wait_after_action,
)

BILLING_REPORT_ID = "6FF06809-B9CF-40BF-ACC9-3829FCDCEEE4"


def _safe_name_part(value: Any, fallback: str = "BN") -> str:
    text = str(value or "").strip() or fallback
    text = re.sub(r"[\\/:*?\"<>|\r\n\t]+", "_", text)
    text = re.sub(r"\s+", " ", text).strip(" ._")
    return text[:110] or fallback


def _json_out(path: str, payload: Dict[str, Any]) -> None:
    if not path:
        return
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + f".tmp-{os.getpid()}")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)


def _visible_pdf_iframe_src(driver: Any) -> str:
    try:
        return str(driver.execute_script(
            r"""
            const iframes = Array.from(document.querySelectorAll('iframe'));
            const best = iframes.find(f => {
              const src = f.getAttribute('src') || '';
              return src && /\.pdf(\?|$)/i.test(src);
            });
            return best ? best.getAttribute('src') : '';
            """
        ) or "").strip()
    except Exception:
        return ""


def _find_pdf_url(driver: Any, main_handle: str = "", timeout: float = 25.0) -> str:
    """Wait for a temp/report PDF URL in iframe/current/new tab.

    EMR may open Chrome print preview. This helper avoids automating the print
    dialog by directly downloading the underlying generated PDF when an iframe
    src or PDF tab is available.
    """
    deadline = time.time() + max(3.0, float(timeout or 25.0))
    seen_handles = set()
    while time.time() < deadline:
        try:
            handles = list(driver.window_handles)
        except Exception:
            handles = []
        for handle in handles or [None]:
            try:
                if handle:
                    seen_handles.add(handle)
                    driver.switch_to.window(handle)
                cur = str(getattr(driver, "current_url", "") or "")
                if cur.lower().split("?", 1)[0].endswith(".pdf"):
                    return cur
                src = _visible_pdf_iframe_src(driver)
                if src:
                    return urljoin(cur or "", src)
            except Exception:
                continue
        # Print preview can steal focus; return to main tab if possible.
        if main_handle:
            try:
                driver.switch_to.window(main_handle)
            except Exception:
                pass
        time.sleep(0.4)
    return ""


def _click_billing_report(driver: Any) -> bool:
    """Click/call the exact report item for inpatient billing statement."""
    js = f"""
    const rid = '{BILLING_REPORT_ID}';
    function visible(el) {{
      if (!el) return false;
      const st = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return st.display !== 'none' && st.visibility !== 'hidden' && r.width >= 0 && r.height >= 0;
    }}
    const dropdownButton = document.querySelector('#divWebpartReport button, #divWebpartReport .dropdown-toggle');
    if (dropdownButton) {{ try {{ dropdownButton.click(); }} catch(e) {{}} }}
    const link = Array.from(document.querySelectorAll('a')).find(a =>
      (a.getAttribute('href') || '').includes(rid) ||
      (a.getAttribute('onclick') || '').includes(rid) ||
      ((a.textContent || '').includes('Bảng kê chi phí nội trú'))
    );
    if (link) {{
      try {{ link.scrollIntoView({{block:'center', inline:'center'}}); }} catch(e) {{}}
      try {{ link.click(); return true; }} catch(e) {{}}
    }}
    if (typeof OnReportPdf === 'function') {{ OnReportPdf(rid); return true; }}
    return false;
    """
    try:
        return bool(driver.execute_script(js))
    except Exception:
        return False


def _download_pdf_with_driver_cookies(driver: Any, pdf_url: str, out_file: Path) -> None:
    if requests is None:
        raise RuntimeError("Thiếu thư viện requests để tải PDF.")
    sess = requests.Session()
    try:
        for c in driver.get_cookies():
            name = c.get("name")
            value = c.get("value")
            if not name:
                continue
            sess.cookies.set(name, value, domain=c.get("domain"), path=c.get("path") or "/")
    except Exception:
        pass
    resp = sess.get(pdf_url, timeout=45)
    data = resp.content or b""
    ctype = str(resp.headers.get("content-type") or "").lower()
    if resp.status_code >= 400:
        raise RuntimeError(f"Tải PDF lỗi HTTP {resp.status_code}.")
    if not (data.startswith(b"%PDF") or "pdf" in ctype):
        raise RuntimeError("URL báo cáo không trả về PDF hợp lệ.")
    out_file.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_file.with_suffix(out_file.suffix + f".tmp-{os.getpid()}")
    tmp.write_bytes(data)
    tmp.replace(out_file)


def save_billing_pdf(ma_bn: str, ho_ten: str = "", date_to: str = "", out_dir: str = "", out_json: str = "") -> int:
    ma_bn = str(ma_bn or "").strip()
    if not ma_bn:
        payload = {"status": "error", "message": "Thiếu mã bệnh nhân."}
        _json_out(out_json, payload)
        print("ERROR [print-billing] Thiếu mã bệnh nhân.", file=sys.stderr)
        return 2

    runtime_dir = os.environ.get("WORKER_RUNTIME_DIR", "").strip() or os.getcwd()
    save_dir = Path(out_dir or Path(runtime_dir) / "hchanh" / "printed_billing")
    file_name = f"{_safe_name_part(ma_bn)}_{_safe_name_part(ho_ten or ma_bn)}_bảng kê.pdf"
    out_file = save_dir / file_name

    config = load_config()
    sess = _init_session(config)
    ctx = _ensure_hchanh_click_context(sess, ma_bn, config, date_to=date_to, reason="in bảng kê")
    if not ctx:
        payload = {"status": "error", "message": f"Không mở được hồ sơ BN {ma_bn} để in bảng kê."}
        _json_out(out_json, payload)
        print(f"ERROR [print-billing] Không mở được hồ sơ BN {ma_bn}.", file=sys.stderr)
        return 3

    driver = ctx.get("driver")
    if driver is None:
        payload = {"status": "error", "message": "Chrome context không có driver."}
        _json_out(out_json, payload)
        return 4

    opened_url = _open_patient_entry_from_context(ctx, "doctor", date_to=date_to)
    print(f"LOG [print-billing] Đã mở tên người bệnh: {opened_url}")
    try:
        main_handle = driver.current_window_handle
    except Exception:
        main_handle = ""

    clicked = _click_billing_report(driver)
    print(f"LOG [print-billing] Chọn Bảng kê chi phí nội trú_Dọc(CV6556): {'ok' if clicked else 'missing'}")
    if not clicked:
        payload = {"status": "error", "message": "Không tìm thấy nút in Bảng kê chi phí nội trú_Dọc(CV6556)."}
        _json_out(out_json, payload)
        return 5

    try:
        _selenium_wait_after_action(driver, 1.0, ready_timeout=10)
    except Exception:
        time.sleep(1.0)

    pdf_url = _find_pdf_url(driver, main_handle=main_handle, timeout=30)
    if not pdf_url:
        payload = {"status": "error", "message": "Đã bấm in bảng kê nhưng chưa tìm thấy iframe/temp PDF để lưu."}
        _json_out(out_json, payload)
        print("ERROR [print-billing] Không tìm thấy PDF URL.", file=sys.stderr)
        return 6

    print(f"LOG [print-billing] PDF URL = {pdf_url}")
    try:
        _download_pdf_with_driver_cookies(driver, pdf_url, out_file)
    except Exception as e:
        payload = {"status": "error", "message": f"Không tải được PDF bảng kê: {type(e).__name__}: {e}", "pdf_url": pdf_url}
        _json_out(out_json, payload)
        print(f"ERROR [print-billing] Không tải được PDF: {type(e).__name__}: {e}", file=sys.stderr)
        return 7

    payload = {
        "status": "ok",
        "message": f"Đã lưu bảng kê: {file_name}",
        "ma_bn": ma_bn,
        "ho_ten": ho_ten,
        "file_name": file_name,
        "pdf_path": str(out_file),
        "pdf_url": pdf_url,
        "size_bytes": out_file.stat().st_size if out_file.exists() else 0,
    }
    _json_out(out_json, payload)
    print(f"LOG [print-billing] Đã lưu: {out_file}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--ma-bn", "--ma_bn", dest="ma_bn", required=True)
    p.add_argument("--ho-ten", "--ho_ten", dest="ho_ten", default="")
    p.add_argument("--date-to", "--to", dest="date_to", default="")
    p.add_argument("--out-dir", dest="out_dir", default="")
    p.add_argument("--out", dest="out_json", default="")
    args = p.parse_args()
    return save_billing_pdf(args.ma_bn, args.ho_ten, args.date_to, args.out_dir, args.out_json)


if __name__ == "__main__":
    raise SystemExit(main())
