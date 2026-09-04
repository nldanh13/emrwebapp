# -*- coding: utf-8 -*-
"""Tải và ghép bộ phiếu in ra viện bệnh phòng cho một người bệnh.

Cách làm chính:
  - Mở đúng hồ sơ Điều dưỡng của người bệnh.
  - Gọi trực tiếp JavaScript OnReportPdf(report_id), không bấm dropdown in.
  - Bắt URL PDF do HIS sinh ra và tải về thư mục /in cùng cấp chương trình.
  - Ghép các PDF thành một file để người dùng in 2 mặt.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, unquote, urljoin, urlparse

try:
    import requests  # type: ignore
except Exception:  # pragma: no cover
    requests = None  # type: ignore

try:
    from pypdf import PdfReader, PdfWriter  # type: ignore
except Exception:  # pragma: no cover
    PdfReader = None  # type: ignore
    PdfWriter = None  # type: ignore

from utils import load_config
from hchanh_fetch import (  # type: ignore
    _init_session,
    _ensure_hchanh_click_context,
    _open_patient_entry_from_context,
    _selenium_wait_after_action,
)

REPORTS: List[Dict[str, str]] = [
    {
        "key": "phieu_cham_soc",
        "name": "Phiếu chăm sóc",
        "report_id": "2EAB76CB-4620-4C04-8AF7-EF14C8833862",
    },
    {
        "key": "phieu_theo_doi_truyen_dich",
        "name": "Phiếu theo dõi truyền dịch",
        "report_id": "1BB460B8-1DF2-451C-A4C8-2E868D6CAA77",
    },
    {
        "key": "phieu_chuc_nang_song_ve",
        "name": "Phiếu chức năng sống vẽ",
        "report_id": "9789788C-83EF-4F50-B158-664ED9574866",
    },
]


def _safe_name_part(value: Any, fallback: str = "BN") -> str:
    text = str(value or "").strip() or fallback
    text = re.sub(r"[\\/:*?\"<>|\r\n\t]+", "_", text)
    text = re.sub(r"\s+", " ", text).strip(" ._")
    return text[:110] or fallback


def _safe_ascii_part(value: Any, fallback: str = "file") -> str:
    text = _safe_name_part(value, fallback=fallback)
    # Giữ tên dễ đọc trên Windows, nhưng thay khoảng trắng bằng gạch dưới.
    text = re.sub(r"\s+", "_", text)
    return text or fallback


def _json_out(path: str, payload: Dict[str, Any]) -> None:
    if not path:
        return
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + f".tmp-{os.getpid()}")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(p)


def _app_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _default_print_root() -> Path:
    return _app_root() / "in"


def _normalize_pdf_url(src: str, base_url: str = "") -> str:
    """Trả URL PDF thật từ iframe/embed hoặc Chrome PDF Viewer URL.

    Chrome PDF Viewer thường có dạng:
      chrome-extension://.../index.html?src=<encoded-pdf-url>
    """
    raw = str(src or "").strip()
    if not raw:
        return ""
    parsed = urlparse(raw)
    qs = parse_qs(parsed.query)
    if qs.get("src"):
        candidate = unquote(qs["src"][0] or "").strip()
        if candidate:
            raw = candidate
    if raw.startswith("//"):
        base = urlparse(base_url)
        return f"{base.scheme or 'http'}:{raw}"
    if raw.startswith("http://") or raw.startswith("https://"):
        return raw
    if raw.lower().startswith("blob:"):
        return raw
    return urljoin(base_url or "", raw)


def _pdf_url_key(value: str) -> str:
    """Khóa so sánh URL PDF để tránh lấy lại PDF cũ của mẫu trước."""
    raw = str(value or "").strip()
    if not raw:
        return ""
    # Fragment của Chrome PDF viewer không quan trọng khi so sánh.
    return raw.split("#", 1)[0].strip().lower()


def _visible_pdf_srcs(driver: Any) -> List[str]:
    try:
        values = driver.execute_script(
            r"""
            const out = [];
            const nodes = [
              ...Array.from(document.querySelectorAll('iframe')),
              ...Array.from(document.querySelectorAll('embed')),
              ...Array.from(document.querySelectorAll('object'))
            ];
            for (const el of nodes) {
              const src = el.getAttribute('src') || el.getAttribute('data') || '';
              if (!src) continue;
              const s = String(src);
              if (/\.pdf(\?|#|$)/i.test(s) || /pdfviewer|chrome-extension/i.test(s) || /Report|report|Temp|temp/i.test(s)) out.push(s);
            }
            const links = Array.from(document.querySelectorAll('a[href]'));
            for (const a of links) {
              const href = a.getAttribute('href') || '';
              if (/\.pdf(\?|#|$)/i.test(href)) out.push(href);
            }
            return out;
            """
        )
        if isinstance(values, list):
            return [str(x or "").strip() for x in values if str(x or "").strip()]
    except Exception:
        pass
    return []


def _visible_pdf_src(driver: Any) -> str:
    srcs = _visible_pdf_srcs(driver)
    return srcs[0] if srcs else ""


def _collect_pdf_urls(driver: Any) -> List[str]:
    """Thu thập các PDF đang có trước khi gọi mẫu mới.

    Nếu không loại trừ danh sách này, worker có thể bắt lại iframe PDF cũ
    quá sớm. Log thực tế: Phiếu truyền dịch bị lưu lại đúng URL của
    Phiếu chăm sóc vì iframe cũ chưa kịp thay src.
    """
    urls: List[str] = []
    try:
        handles = list(driver.window_handles)
    except Exception:
        handles = []
    current_handle = ""
    try:
        current_handle = driver.current_window_handle
    except Exception:
        pass

    for handle in handles or [None]:
        try:
            if handle:
                driver.switch_to.window(handle)
            cur = str(getattr(driver, "current_url", "") or "")
            normalized_cur = _normalize_pdf_url(cur, cur)
            if normalized_cur and normalized_cur.lower().startswith(("http://", "https://")):
                if normalized_cur.lower().split("?", 1)[0].endswith(".pdf"):
                    urls.append(normalized_cur)
            for src in _visible_pdf_srcs(driver):
                normalized_src = _normalize_pdf_url(src, cur)
                if normalized_src and normalized_src.lower().startswith(("http://", "https://")):
                    urls.append(normalized_src)
        except Exception:
            continue

    if current_handle:
        try:
            driver.switch_to.window(current_handle)
        except Exception:
            pass
    out: List[str] = []
    seen = set()
    for u in urls:
        k = _pdf_url_key(u)
        if k and k not in seen:
            seen.add(k)
            out.append(u)
    return out


def _find_pdf_url(
    driver: Any,
    main_handle: str = "",
    before_handles: Optional[List[str]] = None,
    exclude_urls: Optional[List[str]] = None,
    timeout: float = 30.0,
) -> str:
    deadline = time.time() + max(3.0, float(timeout or 30.0))
    before = set(before_handles or [])
    excluded = {_pdf_url_key(u) for u in (exclude_urls or []) if _pdf_url_key(u)}
    last_candidate = ""

    while time.time() < deadline:
        try:
            handles = list(driver.window_handles)
        except Exception:
            handles = []

        # Ưu tiên tab mới nếu HIS mở báo cáo sang tab riêng.
        ordered = [h for h in handles if h not in before] + [h for h in handles if h in before]
        for handle in ordered or [None]:
            try:
                if handle:
                    driver.switch_to.window(handle)
                cur = str(getattr(driver, "current_url", "") or "")
                normalized_cur = _normalize_pdf_url(cur, cur)
                if normalized_cur and normalized_cur.lower().split("?", 1)[0].endswith(".pdf"):
                    last_candidate = normalized_cur
                    if _pdf_url_key(normalized_cur) not in excluded:
                        return normalized_cur
                for src in _visible_pdf_srcs(driver):
                    normalized_src = _normalize_pdf_url(src, cur)
                    if normalized_src and normalized_src.lower().startswith(("http://", "https://")):
                        last_candidate = normalized_src
                        if _pdf_url_key(normalized_src) not in excluded:
                            return normalized_src
            except Exception:
                continue

        if main_handle:
            try:
                driver.switch_to.window(main_handle)
            except Exception:
                pass
        time.sleep(0.35)

    # Không trả lại URL cũ khi có danh sách loại trừ; báo lỗi để tránh lưu nhầm phiếu.
    if excluded and last_candidate and _pdf_url_key(last_candidate) in excluded:
        return ""
    return last_candidate or ""


def _close_extra_tabs(driver: Any, keep_handle: str) -> None:
    if not keep_handle:
        return
    try:
        handles = list(driver.window_handles)
    except Exception:
        return
    for handle in handles:
        if handle == keep_handle:
            continue
        try:
            driver.switch_to.window(handle)
            driver.close()
        except Exception:
            pass
    try:
        driver.switch_to.window(keep_handle)
    except Exception:
        pass




def _suppress_browser_print_in_current_context(driver: Any) -> bool:
    """Chặn window.print để không bật Chrome Print Preview/Save as.

    Một số mẫu của HIS sau khi sinh PDF sẽ tự gọi print(). Khi Chrome đang chọn
    đích "Save to PDF", giao diện này có thể bật hộp thoại Save as của Windows.
    Worker chỉ cần URL PDF để tải trực tiếp, nên chặn print() trước khi gọi mẫu.
    """
    js = r"""
    try {
      window.__WARD_PRINT_SUPPRESS__ = true;
      window.print = function(){ return false; };
      if (!window.__WARD_PRINT_SUPPRESS_INTERVAL__) {
        window.__WARD_PRINT_SUPPRESS_INTERVAL__ = window.setInterval(function(){
          try { window.print = function(){ return false; }; } catch(e) {}
        }, 250);
      }
      return true;
    } catch(e) { return false; }
    """
    try:
        return bool(driver.execute_script(js))
    except Exception:
        return False


def _suppress_browser_print(driver: Any) -> None:
    """Áp dụng chặn print ở main document và iframe cùng origin nếu có."""
    try:
        driver.switch_to.default_content()
    except Exception:
        pass
    _suppress_browser_print_in_current_context(driver)
    frames = []
    try:
        frames = driver.find_elements("css selector", "iframe")
    except Exception:
        frames = []
    for frame in frames:
        try:
            driver.switch_to.default_content()
            driver.switch_to.frame(frame)
            _suppress_browser_print_in_current_context(driver)
        except Exception:
            continue
    try:
        driver.switch_to.default_content()
    except Exception:
        pass


def _click_cancel_in_current_context(driver: Any) -> bool:
    """Bấm nút Huỷ/Cancel trong DOM hiện tại, kể cả shadow DOM.

    Bản này chỉ bấm ứng viên thật sự là cancel-button hoặc có chữ Huỷ/Cancel.
    Không gửi phím ESC và không bấm nút chung chung để tránh vô tình kích hoạt
    nút Lưu trong Chrome print preview.
    """
    js = r"""
    function isVisible(el) {
      try {
        const cs = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return cs.display !== 'none' && cs.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      } catch(e) { return false; }
    }
    function textOf(el) {
      try {
        const slotText = Array.from(el.childNodes || []).map(n => n.textContent || '').join(' ');
        const srText = el.shadowRoot ? Array.from(el.shadowRoot.querySelectorAll('slot')).map(s => {
          try { return s.assignedNodes().map(n => n.textContent || '').join(' '); } catch(e) { return ''; }
        }).join(' ') : '';
        return String(el.innerText || el.textContent || slotText || srText || '').replace(/\s+/g, ' ').trim();
      } catch(e) { return ''; }
    }
    function collectDeep(root, out, depth) {
      if (!root || depth > 12) return;
      let nodes = [];
      try { nodes = Array.from(root.querySelectorAll('*')); } catch(e) { return; }
      for (const el of nodes) {
        out.push(el);
        try {
          if (el.shadowRoot) collectDeep(el.shadowRoot, out, depth + 1);
        } catch(e) {}
      }
    }
    const all = [];
    collectDeep(document, all, 0);
    const candidates = [];
    for (const el of all) {
      try {
        if (el.matches && (
          el.matches('cr-button.cancel-button') ||
          el.matches('cr-button[class*="cancel"]') ||
          el.matches('button.cancel') ||
          el.matches('button[class*="cancel"]') ||
          el.matches('[aria-label*="Cancel"], [aria-label*="cancel"], [aria-label*="Hủy"], [aria-label*="Huỷ"]')
        )) candidates.push(el);
      } catch(e) {}
    }
    // Dự phòng theo text, nhưng vẫn chỉ xét button/cr-button rõ ràng.
    for (const el of all) {
      try {
        if (!(el.matches && (el.matches('button') || el.matches('cr-button') || el.getAttribute('role') === 'button'))) continue;
        const txt = textOf(el).toLowerCase();
        if (txt === 'huỷ' || txt === 'hủy' || txt === 'cancel') candidates.push(el);
      } catch(e) {}
    }
    const seen = new Set();
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const key = String(el.tagName || '') + '|' + String(el.className || '') + '|' + textOf(el);
      if (seen.has(key)) continue;
      seen.add(key);
      const txt = textOf(el).toLowerCase();
      const cls = String(el.className || '').toLowerCase();
      const aria = String(el.getAttribute && (el.getAttribute('aria-label') || '') || '').toLowerCase();
      const isCancel = cls.includes('cancel') || aria.includes('cancel') || aria.includes('hủy') || aria.includes('huỷ') ||
        txt === 'huỷ' || txt === 'hủy' || txt === 'cancel';
      if (!isCancel) continue;
      try { el.click(); return true; } catch(e) {}
      try {
        el.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true, view:window}));
        return true;
      } catch(e) {}
    }
    return false;
    """
    try:
        return bool(driver.execute_script(js))
    except Exception:
        return False


def _click_cancel_buttons(driver: Any) -> bool:
    """Bấm Huỷ nếu có print preview/PDF overlay, không gửi ESC để tránh bật Save as."""
    clicked = False
    try:
        driver.switch_to.default_content()
    except Exception:
        pass
    if _click_cancel_in_current_context(driver):
        time.sleep(0.3)
        return True
    frames = []
    try:
        frames = driver.find_elements("css selector", "iframe")
    except Exception:
        frames = []
    for frame in frames:
        try:
            driver.switch_to.default_content()
            driver.switch_to.frame(frame)
            if _click_cancel_in_current_context(driver):
                time.sleep(0.3)
                clicked = True
                break
        except Exception:
            continue
    try:
        driver.switch_to.default_content()
    except Exception:
        pass
    return clicked



def _send_escape_to_browser(driver: Any, repeats: int = 1) -> bool:
    """Gửi phím ESC vào Chrome để hủy print preview/PDF overlay.

    Dùng khi nút Huỷ của Chrome nằm trong chrome://print hoặc shadow DOM mà
    Selenium không click trực tiếp được. ESC chỉ là lệnh hủy, không phải Enter,
    nên không kích hoạt nút Lưu/Save.
    """
    ok = False
    for _ in range(max(1, int(repeats or 1))):
        try:
            from selenium.webdriver.common.keys import Keys  # type: ignore
            from selenium.webdriver.common.action_chains import ActionChains  # type: ignore
            ActionChains(driver).send_keys(Keys.ESCAPE).perform()
            ok = True
            time.sleep(0.25)
            continue
        except Exception:
            pass
        try:
            from selenium.webdriver.common.keys import Keys  # type: ignore
            body = driver.find_element("tag name", "body")
            body.send_keys(Keys.ESCAPE)
            ok = True
            time.sleep(0.25)
        except Exception:
            pass
    return ok


def _send_global_escape_windows(repeats: int = 1) -> bool:
    """Đóng hộp thoại Save As/Print native nếu Chrome đã mở ngoài DOM.

    Selenium không điều khiển được hộp thoại hệ thống của Windows. Khi HIS/Chrome
    lỡ bật cửa sổ Save As, cách an toàn nhất là gửi ESC tới cửa sổ đang active.
    Chỉ dùng trong worker in ra viện sau khi đã tải xong PDF, để dọn màn hình.
    """
    if os.name != "nt":
        return False
    try:
        import ctypes
        user32 = ctypes.windll.user32
        VK_ESCAPE = 0x1B
        KEYEVENTF_KEYUP = 0x0002
        for _ in range(max(1, int(repeats or 1))):
            user32.keybd_event(VK_ESCAPE, 0, 0, 0)
            time.sleep(0.05)
            user32.keybd_event(VK_ESCAPE, 0, KEYEVENTF_KEYUP, 0)
            time.sleep(0.25)
        return True
    except Exception:
        return False


def _close_report_modal_in_current_context(driver: Any) -> bool:
    """Đóng modal báo cáo/PDF của HIS nếu đang mở trong DOM hiện tại."""
    js = r"""
    function isVisible(el) {
      try {
        const cs = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return cs.display !== 'none' && cs.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      } catch(e) { return false; }
    }
    const selectors = [
      '.modal.show button.close[data-dismiss="modal"]',
      '.modal.in button.close[data-dismiss="modal"]',
      '.modal[style*="display: block"] button.close[data-dismiss="modal"]',
      'button.close[data-dismiss="modal"]',
      '.modal-header button.close',
      '[data-dismiss="modal"]'
    ];
    for (const sel of selectors) {
      const nodes = Array.from(document.querySelectorAll(sel));
      for (const el of nodes) {
        if (!isVisible(el)) continue;
        try { el.click(); return true; } catch(e) {}
      }
    }
    // Dự phòng nếu bootstrap/jQuery đang có modal backdrop nhưng nút đóng không bắt được.
    try {
      if (window.jQuery) {
        const opened = window.jQuery('.modal:visible');
        if (opened && opened.length) { opened.modal('hide'); return true; }
      }
    } catch(e) {}
    return false;
    """
    try:
        return bool(driver.execute_script(js))
    except Exception:
        return False


def _close_report_modals(driver: Any, max_rounds: int = 3) -> None:
    """Đóng các modal PDF để trở lại giao diện Điều dưỡng trước khi gọi phiếu tiếp theo."""
    for _ in range(max(1, int(max_rounds or 3))):
        closed = False
        try:
            driver.switch_to.default_content()
        except Exception:
            pass
        if _close_report_modal_in_current_context(driver):
            closed = True
        frames = []
        try:
            frames = driver.find_elements("css selector", "iframe")
        except Exception:
            frames = []
        for frame in frames:
            try:
                driver.switch_to.default_content()
                driver.switch_to.frame(frame)
                if _close_report_modal_in_current_context(driver):
                    closed = True
                    break
            except Exception:
                continue
        try:
            driver.switch_to.default_content()
        except Exception:
            pass
        if closed:
            time.sleep(0.45)
        else:
            break


def _cleanup_after_report(driver: Any, main_handle: str = "") -> None:
    """Dọn giao diện sau mỗi mẫu in và không để kẹt hộp thoại Save As.

    Thứ tự xử lý:
      1. Thử click đúng nút Huỷ/Cancel trong PDF/print preview.
      2. Nếu không click được thì gửi ESC vào Chrome để hủy print preview.
      3. Nếu Chrome đã bật hộp thoại Windows Save As thì gửi ESC ở mức hệ điều hành.
      4. Đóng modal của HIS và các tab phụ, quay lại hồ sơ Điều dưỡng.
    """
    handles: List[Any] = []
    try:
        handles = list(driver.window_handles)
    except Exception:
        handles = []

    ordered = [h for h in handles if h != main_handle] + ([main_handle] if main_handle else [])
    did_cancel = False
    saw_print_like = False

    for handle in ordered:
        try:
            driver.switch_to.window(handle)
        except Exception:
            continue
        try:
            cur = str(getattr(driver, "current_url", "") or "").lower()
            if cur.startswith(("chrome://print", "chrome-untrusted://print")):
                saw_print_like = True
                # Với tab print preview phụ, đóng tab là cách hủy ổn định nhất.
                if handle != main_handle:
                    try:
                        _send_escape_to_browser(driver, repeats=1)
                    except Exception:
                        pass
                    try:
                        driver.close()
                        did_cancel = True
                        continue
                    except Exception:
                        pass
            if _click_cancel_buttons(driver):
                did_cancel = True
                print("LOG [ward-print] Đã bấm Huỷ trên giao diện PDF/print preview.")
                time.sleep(0.35)
            else:
                if _send_escape_to_browser(driver, repeats=1):
                    did_cancel = True
                    print("LOG [ward-print] Đã gửi ESC để huỷ giao diện PDF/print preview.")
        except Exception:
            pass

    # Nếu hộp thoại Save As của Windows đã bật thì Selenium không thấy được.
    # Gửi ESC toàn cục để đóng nó, tránh kẹt màn hình trước phiếu kế tiếp.
    if _send_global_escape_windows(repeats=1):
        if saw_print_like or did_cancel:
            print("LOG [ward-print] Đã gửi ESC hệ thống để đóng Save As nếu có.")

    try:
        if main_handle:
            driver.switch_to.window(main_handle)
    except Exception:
        pass
    _close_report_modals(driver)
    if main_handle:
        _close_extra_tabs(driver, main_handle)
        try:
            driver.switch_to.window(main_handle)
        except Exception:
            pass

def _sweet_alert_text_in_current_context(driver: Any) -> str:
    js = r"""
    const nodes = Array.from(document.querySelectorAll('.sweet-alert'));
    const visible = nodes.find(el => {
      try {
        const cs = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return cs.display !== 'none' && cs.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 &&
          (el.classList.contains('visible') || el.classList.contains('showSweetAlert') || el.style.display === 'block');
      } catch(e) { return false; }
    });
    if (!visible) return '';
    const h2 = visible.querySelector('h2')?.innerText || '';
    const p = visible.querySelector('p')?.innerText || '';
    return `${h2}\n${p}`.trim();
    """
    try:
        return str(driver.execute_script(js) or "").strip()
    except Exception:
        return ""


def _visible_sweet_alert_text(driver: Any) -> str:
    """Đọc nội dung SweetAlert đang hiện, kể cả khi webpart nằm trong iframe."""
    try:
        driver.switch_to.default_content()
    except Exception:
        pass
    text = _sweet_alert_text_in_current_context(driver)
    if text:
        return text

    frames = []
    try:
        frames = driver.find_elements("css selector", "iframe")
    except Exception:
        frames = []
    for frame in frames:
        try:
            driver.switch_to.default_content()
            driver.switch_to.frame(frame)
            text = _sweet_alert_text_in_current_context(driver)
            if text:
                return text
        except Exception:
            continue
    try:
        driver.switch_to.default_content()
    except Exception:
        pass
    return ""


def _click_sweet_alert_ok_in_current_context(driver: Any) -> bool:
    js = r"""
    const nodes = Array.from(document.querySelectorAll('.sweet-alert'));
    const visible = nodes.find(el => {
      try {
        const cs = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return cs.display !== 'none' && cs.visibility !== 'hidden' && rect.width > 0 && rect.height > 0 &&
          (el.classList.contains('visible') || el.classList.contains('showSweetAlert') || el.style.display === 'block');
      } catch(e) { return false; }
    });
    if (!visible) return false;
    const btn = visible.querySelector('button.confirm, .sa-button-container .confirm');
    if (btn) { btn.click(); return true; }
    return false;
    """
    try:
        return bool(driver.execute_script(js))
    except Exception:
        return False


def _click_sweet_alert_ok(driver: Any) -> None:
    try:
        driver.switch_to.default_content()
    except Exception:
        pass
    if _click_sweet_alert_ok_in_current_context(driver):
        return
    frames = []
    try:
        frames = driver.find_elements("css selector", "iframe")
    except Exception:
        frames = []
    for frame in frames:
        try:
            driver.switch_to.default_content()
            driver.switch_to.frame(frame)
            if _click_sweet_alert_ok_in_current_context(driver):
                break
        except Exception:
            continue
    try:
        driver.switch_to.default_content()
    except Exception:
        pass


def _wait_report_no_data_alert(driver: Any, timeout: float = 3.5) -> str:
    """Nếu HIS báo mẫu không có dữ liệu, trả nội dung cảnh báo để bỏ qua phiếu.

    Ví dụ thực tế khi người bệnh không có truyền dịch:
      Cảnh báo / Không tìm thấy thông tin truyền dịch của bệnh nhân
    """
    deadline = time.time() + max(0.5, float(timeout or 3.5))
    while time.time() < deadline:
        text = _visible_sweet_alert_text(driver)
        low = text.lower()
        if text and ("không tìm thấy" in low or "khong tim thay" in low or "không có" in low or "khong co" in low):
            return text
        time.sleep(0.25)
    return ""


def _try_call_report_in_current_context(driver: Any, report_id: str) -> str:
    """Chỉ gọi trực tiếp hàm OnReportPdf(report_id), không bấm link/nút phiếu.

    Lý do: khi bấm trực tiếp các nút/link phiếu trên giao diện HIS, Chrome có thể
    mở PDF Viewer và hiện giao diện Lưu file. Worker in ra viện phải tránh hoàn
    toàn thao tác click các mục phiếu, chỉ kích hoạt hàm JS của HIS rồi tự bắt URL
    PDF để tải bằng cookie.
    """
    js = r"""
    const rid = arguments[0];
    function tryCall(win) {
      try {
        if (win && typeof win.OnReportPdf === 'function') {
          win.OnReportPdf(rid);
          return 'called:OnReportPdf';
        }
      } catch(e) {
        try { return 'error:' + String(e && e.message || e); } catch(_) {}
      }
      return '';
    }
    return tryCall(window) || tryCall(window.parent) || tryCall(window.top) || '';
    """
    try:
        return str(driver.execute_script(js, report_id) or "").strip()
    except Exception:
        return ""


def _call_report_pdf(driver: Any, report_id: str) -> str:
    """Gọi trực tiếp OnReportPdf(report_id), có thử trong iframe nếu cần."""
    try:
        driver.switch_to.default_content()
    except Exception:
        pass
    result = _try_call_report_in_current_context(driver, report_id)
    if result:
        return result

    # Một số màn hình nhúng webpart trong iframe.
    frames = []
    try:
        frames = driver.find_elements("css selector", "iframe")
    except Exception:
        frames = []
    for idx, frame in enumerate(frames):
        try:
            driver.switch_to.default_content()
            driver.switch_to.frame(frame)
            result = _try_call_report_in_current_context(driver, report_id)
            if result:
                try:
                    driver.switch_to.default_content()
                except Exception:
                    pass
                return f"frame[{idx}]:{result}"
        except Exception:
            continue
    try:
        driver.switch_to.default_content()
    except Exception:
        pass
    return ""



REPORT_MERGE_ORDER = {
    "phieu_chuc_nang_song_ve": 10,
    "phieu_theo_doi_truyen_dich": 20,
    "phieu_cham_soc": 30,
}


def _report_merge_order(key: Any) -> int:
    return REPORT_MERGE_ORDER.get(str(key or ""), 99)


def _status_sort_order(status: Any) -> int:
    text = str(status or "").strip().lower()
    try:
        from shared.text_utils import norm_vi as _norm_vi  # type: ignore
        text_norm = _norm_vi(text)
    except Exception:
        text_norm = text
    if "hoan tat" in text_norm or "hoàn tất" in text:
        return 0
    if "dang thuc hien" in text_norm or "đang thực hiện" in text:
        return 1
    return 9


def _parse_vi_datetime(value: Any) -> Optional[datetime]:
    """Đọc mốc T/G vào từ text bảng nội trú để sắp các lần Hoàn tất.

    HIS thường hiển thị T/G vào dạng dd/mm/yyyy HH:MM hoặc HH:MM dd/mm/yyyy.
    Nếu không đọc được thì trả None, khi đó giữ thứ tự dòng hiện tại.
    """
    text = re.sub(r"\s+", " ", str(value or "").strip())
    if not text:
        return None
    patterns = [
        r"(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\s+(\d{1,2}):(\d{2})",
        r"(\d{1,2}):(\d{2})\s+(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})",
        r"(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})",
    ]
    for idx, pat in enumerate(patterns):
        m = re.search(pat, text)
        if not m:
            continue
        try:
            if idx == 0:
                day, mon, year, hour, minute = m.groups()
            elif idx == 1:
                hour, minute, day, mon, year = m.groups()
            else:
                day, mon, year = m.groups()
                hour, minute = "0", "0"
            y = int(year)
            if y < 100:
                y += 2000
            return datetime(y, int(mon), int(day), int(hour), int(minute))
        except Exception:
            continue
    return None


def _extract_admission_time_from_row_text(row_text: Any) -> str:
    text = re.sub(r"\s+", " ", str(row_text or "").strip())
    if not text:
        return ""
    # Ưu tiên phần ngay sau nhãn T/G vào nếu có.
    m = re.search(
        r"(?:T/G|TG|Thời\s*gian|Ngay|Ngày|Giờ)\s*vào(?:\s*khoa|\s*viện)?\s*[:：-]?\s*([^|;,]{3,60})",
        text,
        flags=re.IGNORECASE,
    )
    if m:
        return m.group(1).strip()
    # Dự phòng: lấy ngày giờ đầu tiên trong dòng.
    m = re.search(r"\d{1,2}[/-]\d{1,2}[/-]\d{2,4}(?:\s+\d{1,2}:\d{2})?|\d{1,2}:\d{2}\s+\d{1,2}[/-]\d{1,2}[/-]\d{2,4}", text)
    return m.group(0).strip() if m else ""


def _context_sort_key(record: Dict[str, Any]) -> Tuple[int, int, str, int]:
    status = record.get("status_context") or record.get("status") or ""
    idx = int(record.get("index") or record.get("occurrence_index") or 0)
    admission_raw = str(record.get("admission_time") or "").strip()
    row_text = str(record.get("row_text") or "").strip()
    dt = _parse_vi_datetime(admission_raw) or _parse_vi_datetime(row_text)
    if dt is not None:
        return (_status_sort_order(status), 0, dt.strftime("%Y%m%d%H%M"), idx)
    return (_status_sort_order(status), 1, admission_raw or row_text[:120], idx)


def _sort_context_entries(entries: List[Dict[str, Any]], status: str) -> List[Dict[str, Any]]:
    """Sắp các dòng hồ sơ trong cùng trạng thái.

    Với Hoàn tất, trường hợp mổ nhiều lần cần lấy lần cũ trước, lần mới sau dựa
    theo cột T/G vào. Đang thực hiện thường chỉ có một dòng, nhưng vẫn giữ hàm
    chung để ổn định thứ tự khi HIS trả trùng.
    """
    normalized: List[Dict[str, Any]] = []
    for i, entry in enumerate(entries, start=1):
        e = dict(entry or {})
        e.setdefault("index", i)
        e.setdefault("status_context", status)
        if not e.get("admission_time"):
            e["admission_time"] = _extract_admission_time_from_row_text(e.get("row_text") or "")
        normalized.append(e)
    return sorted(normalized, key=_context_sort_key)


def _add_blank_page_like(writer: Any, width: float = 595.0, height: float = 842.0) -> None:
    try:
        writer.add_blank_page(width=float(width or 595.0), height=float(height or 842.0))
    except Exception:
        writer.add_blank_page(width=595.0, height=842.0)


def _append_pdf_pages(writer: Any, pdf_path: Path) -> Tuple[int, float, float]:
    if PdfReader is None:
        raise RuntimeError("Thiếu thư viện pypdf để đọc/ghép PDF. Cài: pip install pypdf")
    reader = PdfReader(str(pdf_path))
    page_count = len(reader.pages)
    last_w, last_h = 595.0, 842.0
    for page in reader.pages:
        try:
            last_w = float(page.mediabox.width)
            last_h = float(page.mediabox.height)
        except Exception:
            pass
        writer.add_page(page)
    return page_count, last_w, last_h


def _merge_discharge_bundle_records(records: List[Dict[str, Any]], out_file: Path) -> List[Dict[str, Any]]:
    """Ghép theo thứ tự in 2 mặt.

    Quy tắc:
      1. Phiếu chức năng sống vẽ đi chung toàn bộ trạng thái, không chèn trang trắng.
      2. Phiếu theo dõi truyền dịch đi chung toàn bộ trạng thái; nếu tổng số trang lẻ,
         chèn 1 trang trắng sau nhóm này.
      3. Phiếu chăm sóc đi riêng theo từng trạng thái/lần hoàn tất; nếu từng phiếu có
         số trang lẻ, chèn 1 trang trắng sau phiếu đó.

    Thứ tự trạng thái trong mỗi nhóm: Hoàn tất cũ → Hoàn tất tiếp theo theo T/G vào
    → Đang thực hiện.
    """
    valid = []
    for rec in records:
        path = Path(str(rec.get("pdf_path") or ""))
        if path.exists() and path.stat().st_size > 0:
            rec = dict(rec)
            rec["pdf_path"] = str(path)
            valid.append(rec)
    if not valid:
        raise RuntimeError("Không có PDF nào để ghép.")
    if PdfWriter is None or PdfReader is None:
        raise RuntimeError("Thiếu thư viện pypdf để ghép PDF. Cài: pip install pypdf")

    out_file.parent.mkdir(parents=True, exist_ok=True)
    writer = PdfWriter()
    merge_order: List[Dict[str, Any]] = []

    def sorted_records(key: str) -> List[Dict[str, Any]]:
        return sorted([r for r in valid if r.get("key") == key], key=_context_sort_key)

    # 1. Chức năng sống: gom chung, không thêm trang trắng vì mỗi trạng thái mặc định 2 trang.
    for rec in sorted_records("phieu_chuc_nang_song_ve"):
        pages, w, h = _append_pdf_pages(writer, Path(str(rec["pdf_path"])))
        rec["page_count"] = pages
        rec["blank_after"] = False
        merge_order.append({
            "file_name": rec.get("file_name"),
            "name": rec.get("name"),
            "status_context": rec.get("status_context"),
            "index": rec.get("index"),
            "page_count": pages,
            "blank_after": False,
        })

    # 2. Truyền dịch: gom chung, tổng lẻ thì thêm 1 trang trắng.
    infusion_records = sorted_records("phieu_theo_doi_truyen_dich")
    infusion_pages = 0
    last_size = (595.0, 842.0)
    for rec in infusion_records:
        pages, w, h = _append_pdf_pages(writer, Path(str(rec["pdf_path"])))
        infusion_pages += pages
        last_size = (w, h)
        rec["page_count"] = pages
        rec["blank_after"] = False
        merge_order.append({
            "file_name": rec.get("file_name"),
            "name": rec.get("name"),
            "status_context": rec.get("status_context"),
            "index": rec.get("index"),
            "page_count": pages,
            "blank_after": False,
        })
    if infusion_records and infusion_pages % 2 == 1:
        _add_blank_page_like(writer, *last_size)
        infusion_records[-1]["blank_after"] = True
        if merge_order:
            merge_order[-1]["blank_after"] = True
        merge_order.append({
            "file_name": "TRANG_TRANG_SAU_NHOM_TRUYEN_DICH",
            "name": "Trang trắng sau nhóm truyền dịch",
            "status_context": "",
            "index": "",
            "page_count": 1,
            "blank_after": False,
        })

    # 3. Chăm sóc: tách từng trạng thái/lần hoàn tất; phiếu nào lẻ thì thêm 1 trang trắng.
    for rec in sorted_records("phieu_cham_soc"):
        pages, w, h = _append_pdf_pages(writer, Path(str(rec["pdf_path"])))
        rec["page_count"] = pages
        add_blank = bool(pages % 2 == 1)
        if add_blank:
            _add_blank_page_like(writer, w, h)
        rec["blank_after"] = add_blank
        merge_order.append({
            "file_name": rec.get("file_name"),
            "name": rec.get("name"),
            "status_context": rec.get("status_context"),
            "index": rec.get("index"),
            "page_count": pages,
            "blank_after": add_blank,
        })
        if add_blank:
            merge_order.append({
                "file_name": f"TRANG_TRANG_SAU_{rec.get('file_name') or rec.get('name') or 'PHIEU_CHAM_SOC'}",
                "name": "Trang trắng sau phiếu chăm sóc lẻ trang",
                "status_context": rec.get("status_context"),
                "index": rec.get("index"),
                "page_count": 1,
                "blank_after": False,
            })

    tmp = out_file.with_suffix(out_file.suffix + f".tmp-{os.getpid()}")
    with tmp.open("wb") as fh:
        writer.write(fh)
    tmp.replace(out_file)
    return merge_order

def _download_pdf_with_driver_cookies(driver: Any, pdf_url: str, out_file: Path) -> None:
    if requests is None:
        raise RuntimeError("Thiếu thư viện requests để tải PDF.")
    if str(pdf_url or "").lower().startswith("blob:"):
        raise RuntimeError("HIS trả về blob: PDF; cần bắt URL HTTP trước khi tải trực tiếp.")

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

    headers = {"User-Agent": "Mozilla/5.0", "Accept": "application/pdf,*/*"}
    resp = sess.get(pdf_url, headers=headers, timeout=60)
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


def _merge_pdfs(files: List[Path], out_file: Path) -> None:
    files = [Path(f) for f in files if Path(f).exists() and Path(f).stat().st_size > 0]
    if not files:
        raise RuntimeError("Không có PDF nào để ghép.")
    out_file.parent.mkdir(parents=True, exist_ok=True)
    if len(files) == 1:
        shutil.copyfile(files[0], out_file)
        return
    if PdfWriter is None:
        raise RuntimeError("Thiếu thư viện pypdf để ghép PDF. Cài: pip install pypdf")
    writer = PdfWriter()
    for f in files:
        writer.append(str(f))
    tmp = out_file.with_suffix(out_file.suffix + f".tmp-{os.getpid()}")
    with tmp.open("wb") as fh:
        writer.write(fh)
    tmp.replace(out_file)


def _same_text_vi(a: Any, b: Any) -> bool:
    try:
        from shared.text_utils import norm_vi as _norm_vi  # type: ignore
        aa = _norm_vi(a)
        bb = _norm_vi(b)
    except Exception:
        aa = re.sub(r"\s+", " ", str(a or "").strip().lower())
        bb = re.sub(r"\s+", " ", str(b or "").strip().lower())
    return bool(aa and bb and (aa == bb or aa in bb or bb in aa))


def _unique_statuses(values: List[Any]) -> List[str]:
    out: List[str] = []
    for value in values:
        text = str(value or "").strip()
        if not text:
            continue
        if not any(_same_text_vi(text, old) for old in out):
            out.append(text)
    return out



def _status_file_key(status: str) -> str:
    text = str(status or "").strip().lower()
    repl = {
        "đ": "d", "Đ": "D",
        "à": "a", "á": "a", "ả": "a", "ã": "a", "ạ": "a",
        "ă": "a", "ằ": "a", "ắ": "a", "ẳ": "a", "ẵ": "a", "ặ": "a",
        "â": "a", "ầ": "a", "ấ": "a", "ẩ": "a", "ẫ": "a", "ậ": "a",
        "è": "e", "é": "e", "ẻ": "e", "ẽ": "e", "ẹ": "e",
        "ê": "e", "ề": "e", "ế": "e", "ể": "e", "ễ": "e", "ệ": "e",
        "ì": "i", "í": "i", "ỉ": "i", "ĩ": "i", "ị": "i",
        "ò": "o", "ó": "o", "ỏ": "o", "õ": "o", "ọ": "o",
        "ô": "o", "ồ": "o", "ố": "o", "ổ": "o", "ỗ": "o", "ộ": "o",
        "ơ": "o", "ờ": "o", "ớ": "o", "ở": "o", "ỡ": "o", "ợ": "o",
        "ù": "u", "ú": "u", "ủ": "u", "ũ": "u", "ụ": "u",
        "ư": "u", "ừ": "u", "ứ": "u", "ử": "u", "ữ": "u", "ự": "u",
        "ỳ": "y", "ý": "y", "ỷ": "y", "ỹ": "y", "ỵ": "y",
    }
    for a, b in repl.items():
        text = text.replace(a, b)
    text = re.sub(r"[^a-z0-9]+", "_", text).strip("_")
    return text or "trang_thai"


def _ward_print_status_candidates(config: Dict[str, Any]) -> List[str]:
    """Chỉ xử lý 2 trạng thái hợp lệ cho bộ in ra viện.

    - Hoàn tất: các đợt đã chốt sau phẫu thuật, có thể có nhiều dòng.
    - Đang thực hiện: đợt hiện tại nếu người bệnh chưa bấm ra viện.

    Không chọn bộ lọc Khoảng ngày, không thử Đi mổ/Tất cả.
    """
    return ["Hoàn tất", "Đang thực hiện"]


def _extract_patient_nursing_entries_from_current_page(driver: Any, ma_bn: str) -> List[Dict[str, Any]]:
    """Lấy tất cả dòng cùng mã BN trên danh sách hiện tại.

    Trường hợp mổ nhiều lần có thể có nhiều dòng Hoàn tất. Helper cũ chỉ lấy
    dòng đầu tiên, nên worker này tự lấy toàn bộ link con mắt điều dưỡng đang
    hiện sau khi search mã BN.
    """
    code = str(ma_bn or "").strip()
    if not code:
        return []
    js = r"""
    const code = String(arguments[0] || '').trim();
    function clean(s){ return String(s || '').replace(/\s+/g, ' ').trim(); }
    function nursingUrlFromDoctor(href) {
      try {
        const u = new URL(href, window.location.href);
        u.searchParams.set('wpid', 'dieuduongdraw');
        u.searchParams.delete('nextlink');
        return u.href;
      } catch(e) { return ''; }
    }
    const rows = Array.from(document.querySelectorAll('table tbody tr, table tr, tr'))
      .filter(r => clean(r.innerText || r.textContent || '').includes(code));
    const out = [];
    for (const row of rows) {
      const anchors = Array.from(row.querySelectorAll('a[href]'));
      let nursing = '';
      let doctor = '';
      for (const a of anchors) {
        const href = a.href || a.getAttribute('href') || '';
        if (!href || /^javascript:/i.test(href)) continue;
        const html = String(a.innerHTML || '').toLowerCase();
        const lower = String(href || '').toLowerCase();
        const id = String(a.id || '').toLowerCase();
        const txt = clean(a.innerText || a.textContent || '');
        if (!nursing && (lower.includes('wpid=dieuduongdraw') || html.includes('fa-eye'))) nursing = href;
        if (!doctor && (lower.includes('wpid=bacsidraw') || id.startsWith('btna'))) doctor = href;
        if (!doctor && txt && txt.length > 4 && !/^\d/.test(txt) && lower.includes('home.aspx')) doctor = href;
      }
      if (!nursing && doctor) nursing = nursingUrlFromDoctor(doctor);
      if (!doctor && nursing) doctor = nursing.replace(/wpid=dieuduongdraw/i, 'wpid=bacsidraw');
      if (nursing || doctor) {
        const cells = Array.from(row.querySelectorAll('td, th')).map(td => clean(td.innerText || td.textContent || ''));
        // Bảng nội trú thường có cột: STT, T/G vào, ĐD, KQ, B-G, Mã BN, Họ tên.
        const tgVao = cells.length > 1 ? cells[1] : '';
        out.push({
          links: {nursing, doctor},
          row_text: clean(row.innerText || row.textContent || ''),
          cells,
          admission_time: tgVao,
        });
      }
    }
    return out;
    """
    try:
        values = driver.execute_script(js, code)
        if not isinstance(values, list):
            return []
        out: List[Dict[str, Any]] = []
        seen = set()
        for item in values:
            if not isinstance(item, dict):
                continue
            links = item.get("links") if isinstance(item.get("links"), dict) else {}
            nursing = str(links.get("nursing") or "").strip()
            doctor = str(links.get("doctor") or "").strip()
            key = nursing or doctor
            if not key or key in seen:
                continue
            seen.add(key)
            row_text = str(item.get("row_text") or "").strip()
            admission_time = str(item.get("admission_time") or "").strip()
            if not admission_time:
                admission_time = _extract_admission_time_from_row_text(row_text)
            out.append({
                "links": {"nursing": nursing, "doctor": doctor},
                "row_text": row_text,
                "admission_time": admission_time,
                "cells": item.get("cells") if isinstance(item.get("cells"), list) else [],
            })
        return out
    except Exception:
        return []


def _open_ward_print_context(sess: Optional["EmrHttpSession"], ma_bn: str, config: Dict[str, Any], status: str) -> Optional[Dict[str, Any]]:
    """Mở danh sách nội trú ở một trạng thái, không lọc Khoảng ngày."""
    print(f"LOG [ward-print] Tìm BN {ma_bn}: trạng thái={status}; không lọc ngày.")
    ctx = _ensure_hchanh_click_context(
        sess,
        ma_bn,
        config,
        date_to="",
        reason="in bộ phiếu ra viện",
        inpatient_status=status,
    )
    if not ctx:
        print(f"WARN [ward-print] Không thấy BN {ma_bn} ở trạng thái {status}.", file=sys.stderr)
        return None
    ctx["ward_print_found_status"] = status
    ctx["ward_print_found_date_to"] = ""
    print(f"LOG [ward-print] Đã tìm thấy BN {ma_bn}: trạng thái={status}; không lọc ngày.")
    return ctx


def save_discharge_bundle(ma_bn: str, ho_ten: str = "", date_to: str = "", out_dir: str = "", out_json: str = "") -> int:
    ma_bn = str(ma_bn or "").strip()
    if not ma_bn:
        payload = {"status": "error", "message": "Thiếu mã bệnh nhân."}
        _json_out(out_json, payload)
        print("ERROR [ward-print] Thiếu mã bệnh nhân.", file=sys.stderr)
        return 2

    print_root = Path(out_dir or _default_print_root())
    patient_folder_name = f"{_safe_ascii_part(ma_bn)}_{_safe_ascii_part(ho_ten or ma_bn)}"
    patient_dir = print_root / patient_folder_name
    patient_dir.mkdir(parents=True, exist_ok=True)

    # Xóa các file rời cũ của lần chạy trước để không lẫn phiếu sai.
    try:
        for old_pdf in patient_dir.glob("*.pdf"):
            old_pdf.unlink()
    except Exception:
        pass

    final_name = f"IN_RA_VIEN_{_safe_ascii_part(ma_bn)}_{_safe_ascii_part(ho_ten or ma_bn)}.pdf"
    final_file = print_root / final_name

    config = load_config()
    sess = _init_session(config)

    downloaded: List[Dict[str, Any]] = []
    skipped: List[Dict[str, Any]] = []
    failures: List[Dict[str, Any]] = []
    pdf_files: List[Path] = []
    found_contexts: List[Dict[str, Any]] = []
    file_seq = 0

    statuses = _ward_print_status_candidates(config)

    for status in statuses:
        ctx = _open_ward_print_context(sess, ma_bn, config, status)
        if not ctx:
            continue
        driver = ctx.get("driver")
        if driver is None:
            failures.append({"status_context": status, "message": "Chrome context không có driver."})
            continue

        entries = _extract_patient_nursing_entries_from_current_page(driver, ma_bn)
        if not entries:
            entries = [{"links": dict(ctx.get("links") or {}), "row_text": "", "admission_time": ""}]
        entries = _sort_context_entries(entries, status)
        # Với Đang thực hiện thường chỉ cần 1 dòng hiện tại. Nếu HIS trả trùng dòng,
        # danh sách đã được khử trùng theo link. Hoàn tất được sắp theo T/G vào.
        print(f"LOG [ward-print] Trạng thái {status}: tìm được {len(entries)} dòng hồ sơ để tổng hợp.")

        for occ_idx, entry in enumerate(entries, start=1):
            ctx_entry = dict(ctx)
            ctx_entry["links"] = dict(entry.get("links") or {})
            ctx_entry["ward_print_occurrence_index"] = occ_idx
            ctx_entry["ward_print_row_text"] = str(entry.get("row_text") or "")[:500]
            admission_time = str(entry.get("admission_time") or "").strip()
            status_key = _status_file_key(status)
            context_label = f"{status} #{occ_idx}" if len(entries) > 1 or status == "Hoàn tất" else status
            found_contexts.append({
                "status": status,
                "index": occ_idx,
                "label": context_label,
                "admission_time": admission_time,
                "row_text": ctx_entry.get("ward_print_row_text") or "",
            })

            try:
                opened_url = _open_patient_entry_from_context(ctx_entry, "nursing", date_to="")
                print(f"LOG [ward-print] Đã mở hồ sơ Điều dưỡng ({context_label}): {opened_url}")
                _suppress_browser_print(driver)
                try:
                    main_handle = driver.current_window_handle
                except Exception:
                    main_handle = ""
            except Exception as e:
                msg = f"{type(e).__name__}: {e}"
                failures.append({"status_context": status, "index": occ_idx, "message": msg})
                print(f"ERROR [ward-print] Không mở được hồ sơ Điều dưỡng ({context_label}): {msg}", file=sys.stderr)
                continue

            for report in REPORTS:
                rid = report["report_id"]
                name = report["name"]
                key = report["key"]
                file_seq += 1
                try:
                    _close_extra_tabs(driver, main_handle)
                    try:
                        driver.switch_to.window(main_handle)
                    except Exception:
                        pass
                    _suppress_browser_print(driver)
                    before_handles = list(driver.window_handles)
                    before_pdf_urls = _collect_pdf_urls(driver)
                    out_file = patient_dir / f"{file_seq:02d}_{status_key}_{occ_idx:02d}_{key}.pdf"
                    try:
                        if out_file.exists():
                            out_file.unlink()
                    except Exception:
                        pass
                    call_result = _call_report_pdf(driver, rid)
                    print(f"LOG [ward-print] Gọi OnReportPdf({rid}) - {name} ({context_label}): {call_result or 'missing'}")
                    if not call_result:
                        raise RuntimeError(f"Không gọi được OnReportPdf cho mẫu: {name}")

                    alert_text = _wait_report_no_data_alert(driver, timeout=3.5)
                    if alert_text:
                        _click_sweet_alert_ok(driver)
                        skipped.append({
                            "key": key,
                            "name": name,
                            "report_id": rid,
                            "status_context": status,
                            "index": occ_idx,
                            "reason": alert_text,
                        })
                        print(f"WARN [ward-print] Bỏ qua {name} ({context_label}): {alert_text}", file=sys.stderr)
                        _cleanup_after_report(driver, main_handle)
                        continue

                    try:
                        _selenium_wait_after_action(driver, 1.0, ready_timeout=10)
                    except Exception:
                        time.sleep(1.0)
                    pdf_url = _find_pdf_url(
                        driver,
                        main_handle=main_handle,
                        before_handles=before_handles,
                        exclude_urls=before_pdf_urls,
                        timeout=45,
                    )
                    if not pdf_url:
                        alert_text = _visible_sweet_alert_text(driver)
                        if alert_text and ("không tìm thấy" in alert_text.lower() or "khong tim thay" in alert_text.lower() or "không có" in alert_text.lower() or "khong co" in alert_text.lower()):
                            _click_sweet_alert_ok(driver)
                            skipped.append({
                                "key": key,
                                "name": name,
                                "report_id": rid,
                                "status_context": status,
                                "index": occ_idx,
                                "reason": alert_text,
                            })
                            print(f"WARN [ward-print] Bỏ qua {name} ({context_label}): {alert_text}", file=sys.stderr)
                            _cleanup_after_report(driver, main_handle)
                            continue
                        raise RuntimeError(
                            f"Đã gọi mẫu {name} nhưng chưa tìm thấy URL PDF mới. "
                            "Có thể HIS chưa sinh xong PDF, mẫu không có dữ liệu, hoặc đang giữ lại PDF cũ của mẫu trước."
                        )
                    print(f"LOG [ward-print] PDF {name} ({context_label}): {pdf_url}")
                    _download_pdf_with_driver_cookies(driver, pdf_url, out_file)
                    size = out_file.stat().st_size if out_file.exists() else 0
                    pdf_files.append(out_file)
                    downloaded.append({
                        "key": key,
                        "name": name,
                        "report_id": rid,
                        "status_context": status,
                        "index": occ_idx,
                        "context_label": context_label,
                        "admission_time": admission_time,
                        "row_text": ctx_entry.get("ward_print_row_text") or "",
                        "status_order": _status_sort_order(status),
                        "report_order": _report_merge_order(key),
                        "file_name": out_file.name,
                        "pdf_path": str(out_file),
                        "size_bytes": size,
                    })
                    print(f"LOG [ward-print] Đã lưu {name} ({context_label}): {out_file}")
                    _cleanup_after_report(driver, main_handle)
                except Exception as e:
                    msg = f"{type(e).__name__}: {e}"
                    failures.append({
                        "key": key,
                        "name": name,
                        "report_id": rid,
                        "status_context": status,
                        "index": occ_idx,
                        "message": msg,
                    })
                    print(f"ERROR [ward-print] {name} ({context_label}): {msg}", file=sys.stderr)
                    try:
                        _cleanup_after_report(driver, main_handle)
                    except Exception:
                        pass

    if not pdf_files:
        payload = {
            "status": "error",
            "message": (
                f"Không tải được PDF nào cho BN {ma_bn}. Worker chỉ thử trạng thái Hoàn tất và Đang thực hiện, không lọc Khoảng ngày."
            ),
            "ma_bn": ma_bn,
            "ho_ten": ho_ten,
            "downloaded": downloaded,
            "skipped": skipped,
            "failures": failures,
            "found_contexts": found_contexts,
            "print_dir": str(print_root),
        }
        _json_out(out_json, payload)
        return 6

    merge_order: List[Dict[str, Any]] = []
    try:
        merge_order = _merge_discharge_bundle_records(downloaded, final_file)
    except Exception as e:
        payload = {
            "status": "error",
            "message": f"Đã tải PDF rời nhưng ghép file thất bại: {type(e).__name__}: {e}",
            "ma_bn": ma_bn,
            "ho_ten": ho_ten,
            "downloaded": downloaded,
            "skipped": skipped,
            "failures": failures,
            "found_contexts": found_contexts,
            "print_dir": str(print_root),
        }
        _json_out(out_json, payload)
        return 7

    skipped_count = len(skipped)
    failure_count = len(failures)
    contexts_text = ", ".join([str(x.get("label") or x.get("status") or "") for x in found_contexts if x])
    if failure_count:
        status_out = "partial"
        message = f"Đã tạo file tổng hợp nhưng có {failure_count} phiếu chưa tải được."
    elif skipped_count:
        status_out = "ok"
        message = f"Đã tạo file tổng hợp: {final_name}. Đã bỏ qua {skipped_count} phiếu không có dữ liệu."
    else:
        status_out = "ok"
        message = f"Đã tạo file tổng hợp in ra viện: {final_name}"

    payload = {
        "status": status_out,
        "message": message,
        "ma_bn": ma_bn,
        "ho_ten": ho_ten,
        "found_status": contexts_text,
        "found_statuses": found_contexts,
        "found_date_to": "",
        "file_name": final_name,
        "bundle_path": str(final_file),
        "print_dir": str(print_root),
        "patient_dir": str(patient_dir),
        "size_bytes": final_file.stat().st_size if final_file.exists() else 0,
        "downloaded": downloaded,
        "merge_order": merge_order,
        "skipped": skipped,
        "failures": failures,
    }
    _json_out(out_json, payload)
    print(f"LOG [ward-print] Đã ghép file: {final_file}")
    return 0 if not failures else 8

def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--ma-bn", "--ma_bn", dest="ma_bn", required=True)
    p.add_argument("--ho-ten", "--ho_ten", dest="ho_ten", default="")
    p.add_argument("--date-to", "--to", dest="date_to", default="")
    p.add_argument("--out-dir", dest="out_dir", default="")
    p.add_argument("--out", dest="out_json", default="")
    args = p.parse_args()
    return save_discharge_bundle(args.ma_bn, args.ho_ten, args.date_to, args.out_dir, args.out_json)


if __name__ == "__main__":
    raise SystemExit(main())
