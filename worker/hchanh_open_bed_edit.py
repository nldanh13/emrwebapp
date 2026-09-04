# -*- coding: utf-8 -*-
"""Open EMR nursing bed edit modal for one inpatient.

This worker is intentionally interactive: it opens Chrome, navigates to
con mắt điều dưỡng → Chăm sóc → Buồng giường → Sửa thông tin, then keeps the
browser alive so the user can edit the bed manually in EMR.
"""
from __future__ import annotations

import argparse
import sys
import time
from typing import Any, Optional

from utils import load_config

# Reuse the hardened EMR navigation/click helpers already maintained for Hành chánh.
from hchanh_fetch import (  # type: ignore
    _init_session,
    _ensure_hchanh_click_context,
    _open_patient_entry_from_context,
    _click_hchanh_action,
    _selenium_click_js,
    _selenium_wait_after_action,
)


def _find_bed_edit_button(driver: Any) -> Optional[Any]:
    """Return the best 'Sửa thông tin' button on the bed timeline.

    Priority:
    1) the row/card containing badge text 'Đang thực hiện'
    2) the last visible onShowModalGiuong/Sửa thông tin button
    """
    try:
        return driver.execute_script(
            r"""
            function norm(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
            function visible(el) {
              if (!el) return false;
              const st = window.getComputedStyle(el);
              const r = el.getBoundingClientRect();
              return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0;
            }
            function isEdit(el) {
              const t = norm(el.textContent);
              const oc = el.getAttribute('onclick') || '';
              const id = el.getAttribute('id') || '';
              return visible(el) && (
                t.includes('Sửa thông tin') ||
                oc.includes('onShowModalGiuong') ||
                id === 'btnDetail'
              );
            }

            const timeline = document.querySelector('#vertical-timeline') || document.body;
            const cards = Array.from(timeline.querySelectorAll(':scope > .row, .row'));
            for (const row of cards) {
              const text = norm(row.textContent);
              if (!text.includes('Đang thực hiện')) continue;
              const btn = Array.from(row.querySelectorAll('a,button')).find(isEdit);
              if (btn) return btn;
            }

            const all = Array.from(document.querySelectorAll('a,button')).filter(isEdit);
            return all.length ? all[all.length - 1] : null;
            """
        )
    except Exception:
        return None


def _wait_for_bed_modal(driver: Any, timeout: float = 12.0) -> bool:
    deadline = time.time() + max(1.0, float(timeout or 12.0))
    while time.time() < deadline:
        try:
            html = driver.page_source or ""
            if "divModalGiuong" in html or "BUỒNG, GIƯỜNG" in html or "BUONG, GIUONG" in html:
                return True
        except Exception:
            pass
        time.sleep(0.35)
    return False


def open_bed_edit(ma_bn: str, date_to: str = "", keep_open_sec: int = 3600) -> int:
    ma_bn = str(ma_bn or '').strip()
    if not ma_bn:
        print("ERROR [bed-edit] Thiếu mã bệnh nhân.", file=sys.stderr)
        return 2

    config = load_config()
    sess = _init_session(config)

    ctx = _ensure_hchanh_click_context(sess, ma_bn, config, date_to=date_to, reason="sửa giường")
    if not ctx:
        print(f"ERROR [bed-edit] Không mở được Chrome hoặc không tìm thấy BN {ma_bn} ở trạng thái Đang thực hiện.", file=sys.stderr)
        return 3

    driver = ctx.get('driver')
    if driver is None:
        print("ERROR [bed-edit] Chrome context không có driver.", file=sys.stderr)
        return 4

    opened_url = _open_patient_entry_from_context(ctx, 'nursing', date_to=date_to)
    print(f"LOG [bed-edit] Đã mở con mắt điều dưỡng: {opened_url}")

    clicked = _click_hchanh_action(driver, 'bed_days')
    print(f"LOG [bed-edit] Bấm Chăm sóc → Buồng giường: {'ok' if clicked else 'missing'}")
    if not clicked:
        print("ERROR [bed-edit] Không bấm được menu Buồng giường.", file=sys.stderr)
        return 5

    try:
        _selenium_wait_after_action(driver, 0.8, ready_timeout=12)
    except Exception:
        time.sleep(1.0)

    btn = _find_bed_edit_button(driver)
    if not btn:
        print("ERROR [bed-edit] Không tìm thấy nút 'Sửa thông tin' trong Buồng giường.", file=sys.stderr)
        return 6

    _selenium_click_js(driver, btn)
    print("LOG [bed-edit] Đã bấm nút Sửa thông tin giường.")

    if _wait_for_bed_modal(driver, timeout=12):
        print("LOG [bed-edit] Đã mở popup BUỒNG, GIƯỜNG. Bạn sửa trực tiếp trên Chrome rồi bấm Đồng ý/Lưu trong EMR.")
    else:
        print("WARN [bed-edit] Đã bấm Sửa thông tin nhưng chưa xác nhận được popup; Chrome vẫn được giữ mở để bạn kiểm tra.", file=sys.stderr)

    # Keep the browser alive for manual edit. Exit early if user closes Chrome.
    end = time.time() + max(60, int(keep_open_sec or 3600))
    while time.time() < end:
        try:
            _ = driver.current_url
        except Exception:
            print("LOG [bed-edit] Chrome đã đóng; kết thúc worker.")
            return 0
        time.sleep(2.0)

    print("LOG [bed-edit] Hết thời gian giữ Chrome mở; đóng worker.")
    return 0


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument('--ma-bn', '--ma_bn', dest='ma_bn', required=True)
    p.add_argument('--date-to', '--to', dest='date_to', default='')
    p.add_argument('--keep-open-sec', type=int, default=3600)
    args = p.parse_args()
    return open_bed_edit(args.ma_bn, args.date_to, args.keep_open_sec)


if __name__ == '__main__':
    raise SystemExit(main())
