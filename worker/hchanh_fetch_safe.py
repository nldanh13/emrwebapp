# -*- coding: utf-8 -*-
"""Entry point an toàn cho hchanh_fetch.py.

EMR mặc định ``#soLuongHienThi`` ở 25 dòng. Với Lịch sử y lệnh, phải đổi sang
``1000 = Tất cả`` và gọi ``loadListYLenh()`` rồi chờ DOM ổn định trước khi parse.
Module này bọc worker hiện có để sửa đúng hành vi đó mà không nhân đôi logic fetch.
"""

from __future__ import annotations

import os
import re
import sys
import time
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

import hchanh_fetch as core


_ORDER_HISTORY_ALL_VALUE = "1000"
_ORDER_HISTORY_ALL_STATUS = "99"
_LAST_ORDER_HISTORY_SHOW_ALL_OK: Optional[bool] = None
_LAST_ORDER_HISTORY_SHOW_ALL_STATE: Dict[str, Any] = {}


def _order_history_dom_state(driver: Any) -> Dict[str, Any]:
    """Đọc trạng thái thật của dropdown + bảng y lệnh trong DOM hiện tại."""
    try:
        state = driver.execute_script(
            r"""
            const size = document.querySelector('#soLuongHienThi');
            const status = document.querySelector('#trangthaiylenh');
            const bodies = Array.from(document.querySelectorAll('tbody#tbodyylenh'));
            const rowCount = bodies.reduce((n, b) => n + b.querySelectorAll('tr').length, 0);
            const htmlLen = bodies.reduce((n, b) => n + (b.innerHTML || '').length, 0);
            const textLen = bodies.reduce((n, b) => n + (b.textContent || '').length, 0);
            const jqBusy = (window.jQuery && typeof window.jQuery.active === 'number')
                ? Number(window.jQuery.active || 0) : 0;
            return {
              has_select: !!size,
              value: size ? String(size.value || '') : '',
              has_all_option: !!(size && Array.from(size.options || []).some(o => String(o.value) === '1000')),
              status_value: status ? String(status.value || '') : '',
              has_status_select: !!status,
              row_count: rowCount,
              html_len: htmlLen,
              text_len: textLen,
              ajax_busy: jqBusy,
            };
            """
        )
        return state if isinstance(state, dict) else {}
    except Exception:
        return {}


def _force_order_history_show_all(
    driver: Any,
    timeout: float = 18.0,
    poll_interval: float = 0.35,
    stable_required: int = 3,
) -> Tuple[bool, Dict[str, Any]]:
    """Chọn ``Tất cả`` thật trên UI, gọi loader và chờ kết quả render ổn định.

    Không coi việc gắn ``soLuongHienThi=1000`` vào URL là bằng chứng đã lấy đủ,
    vì HTML EMR thực tế dùng ``onchange=loadListYLenh()`` và mặc định là 25.
    """
    if driver is None:
        return False, {"reason": "no_driver"}

    deadline = time.time() + max(1.0, float(timeout or 18.0))
    first_state: Dict[str, Any] = {}
    while time.time() < deadline:
        first_state = _order_history_dom_state(driver)
        if first_state.get("has_select"):
            break
        time.sleep(min(max(0.05, poll_interval), 0.5))
    if not first_state.get("has_select"):
        return False, {**first_state, "reason": "missing_soLuongHienThi"}
    if not first_state.get("has_all_option"):
        return False, {**first_state, "reason": "missing_all_option_1000"}

    try:
        started = driver.execute_script(
            r"""
            const size = document.querySelector('#soLuongHienThi');
            if (!size) return {ok:false, reason:'missing_soLuongHienThi'};
            const allOpt = Array.from(size.options || []).find(o => String(o.value) === '1000');
            if (!allOpt) return {ok:false, reason:'missing_all_option_1000'};

            // 99 là lựa chọn rỗng/không lọc trạng thái trong HTML EMR thực tế.
            const status = document.querySelector('#trangthaiylenh');
            if (status && Array.from(status.options || []).some(o => String(o.value) === '99')) {
              status.value = '99';
            }
            size.value = '1000';

            // Gọi loader đúng một lần. Nếu function không hiện diện, phát change để
            // inline onchange="loadListYLenh();" của EMR tự xử lý.
            if (typeof loadListYLenh === 'function') {
              loadListYLenh();
              return {ok:true, method:'loadListYLenh'};
            }
            size.dispatchEvent(new Event('change', {bubbles:true}));
            return {ok:true, method:'change'};
            """
        )
    except Exception as exc:
        return False, {**first_state, "reason": "execute_failed", "detail": type(exc).__name__}

    if not isinstance(started, dict) or not started.get("ok"):
        state = _order_history_dom_state(driver)
        return False, {**state, "reason": (started or {}).get("reason", "load_not_started") if isinstance(started, dict) else "load_not_started"}

    # Cho AJAX có thời gian bắt đầu; sau đó yêu cầu DOM ổn định nhiều nhịp liên tiếp.
    time.sleep(min(0.8, max(0.1, poll_interval * 2)))
    stable = 0
    previous_sig = None
    last_state: Dict[str, Any] = {}
    while time.time() < deadline:
        last_state = _order_history_dom_state(driver)
        verified_filters = (
            last_state.get("has_select")
            and str(last_state.get("value") or "") == _ORDER_HISTORY_ALL_VALUE
            and (
                not last_state.get("has_status_select")
                or str(last_state.get("status_value") or "") == _ORDER_HISTORY_ALL_STATUS
            )
        )
        sig = (
            int(last_state.get("row_count") or 0),
            int(last_state.get("html_len") or 0),
            int(last_state.get("text_len") or 0),
        )
        if verified_filters and int(last_state.get("ajax_busy") or 0) == 0:
            stable = stable + 1 if sig == previous_sig else 1
        else:
            stable = 0
        previous_sig = sig
        if stable >= max(2, int(stable_required or 3)):
            return True, {
                **last_state,
                "reason": "verified",
                "method": started.get("method", ""),
                "stable_checks": stable,
            }
        time.sleep(max(0.05, float(poll_interval or 0.35)))

    return False, {**last_state, "reason": "show_all_not_stable_before_timeout", "method": started.get("method", "")}


_original_fetch_html_by_click = core._fetch_hchanh_html_by_click
_original_fetch_order_history = core.fetch_order_history


def _fetch_hchanh_html_by_click_safe(
    sess: Any,
    ma_bn: str,
    config: Dict[str, Any],
    entry_kind: str,
    action: str = "",
    date_to: str = "",
    inpatient_status: str = "",
    date_from: str = "",
):
    """Sau khi mở Lịch sử y lệnh, bắt buộc chọn Tất cả trước khi lấy page_source."""
    global _LAST_ORDER_HISTORY_SHOW_ALL_OK, _LAST_ORDER_HISTORY_SHOW_ALL_STATE

    result = _original_fetch_html_by_click(
        sess, ma_bn, config, entry_kind, action,
        date_to=date_to,
        inpatient_status=inpatient_status,
        date_from=date_from,
    )
    if str(action or "").strip().lower() != "order_history" or not result:
        return result

    driver = core._HCHANH_CLICK_CACHE.get("driver")
    ok, state = _force_order_history_show_all(driver)
    _LAST_ORDER_HISTORY_SHOW_ALL_OK = bool(ok)
    _LAST_ORDER_HISTORY_SHOW_ALL_STATE = dict(state or {})

    try:
        core.trace_event(
            "ORDER_HISTORY.SELECT_SHOW_ALL" if ok else "WARN",
            "Đã chọn Tất cả và chờ y lệnh tải xong" if ok else "Không xác nhận được chế độ Tất cả của Lịch sử y lệnh",
            screen="Lịch sử y lệnh / select#soLuongHienThi",
            sees=(
                f"value={state.get('value', '')}; status={state.get('status_value', '')}; "
                f"rows_dom={state.get('row_count', 0)}; reason={state.get('reason', '')}"
            ),
            takes="1000=Tất cả; trạng thái=99 (không lọc)",
            writes="chỉ parse DOM khi đã xác nhận chế độ Tất cả",
            target="output.order_history",
        )
    except Exception:
        pass

    result = dict(result)
    result["order_history_show_all"] = bool(ok)
    result["order_history_show_all_value"] = str(state.get("value") or "")
    result["order_history_status_value"] = str(state.get("status_value") or "")
    result["order_history_dom_rows"] = int(state.get("row_count") or 0)
    result["order_history_show_all_reason"] = str(state.get("reason") or "")
    if ok and driver is not None:
        try:
            result["html"] = getattr(driver, "page_source", "") or result.get("html", "")
            result["url"] = getattr(driver, "current_url", "") or result.get("url", "")
        except Exception:
            pass
    return result


def _parse_order_history_datetime(value: Any) -> Optional[datetime]:
    raw = str(value or "").strip()
    if not raw:
        return None
    patterns = [
        (r"(\d{1,2}:\d{2})\s+(\d{1,2}/\d{1,2}/\d{4})", "%H:%M %d/%m/%Y", (1, 2)),
        (r"(\d{1,2}/\d{1,2}/\d{4})\s+(\d{1,2}:\d{2})", "%d/%m/%Y %H:%M", (1, 2)),
        (r"\b(\d{1,2}/\d{1,2}/\d{4})\b", "%d/%m/%Y", (1,)),
        (r"\b(\d{4}-\d{1,2}-\d{1,2})\b", "%Y-%m-%d", (1,)),
    ]
    for pattern, fmt, groups in patterns:
        m = re.search(pattern, raw)
        if not m:
            continue
        try:
            text = " ".join(m.group(i) for i in groups)
            return datetime.strptime(text, fmt)
        except (TypeError, ValueError):
            continue
    return None


def _parse_order_history_bound(value: Any) -> Optional[datetime]:
    raw = str(value or "").strip()
    for fmt in ("%d/%m/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(raw, fmt)
        except (TypeError, ValueError):
            continue
    parsed = _parse_order_history_datetime(raw)
    return parsed.replace(hour=0, minute=0, second=0, microsecond=0) if parsed else None


def _filter_research_order_rows_by_stay(
    rows: List[Dict[str, Any]],
    date_from: str,
    date_to: str,
    *,
    lookback_days: int = 3,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Giữ y lệnh thuộc đợt + cửa sổ tiền nhập viện mà normalize đang cho phép.

    EMR ở chế độ Selenium có thể render lịch sử của nhiều đợt dù URL/input đã mang
    khoảng ngày. Nếu đưa toàn bộ vào kho, các y lệnh cũ trở thành hàng nghìn dòng
    encounter_match_outside_time. Dòng không parse được thời gian vẫn được giữ để QA
    xử lý, không xóa dữ liệu chỉ vì parser ngày giờ chưa nhận dạng.
    """
    src = list(rows or [])
    start = _parse_order_history_bound(date_from)
    end = _parse_order_history_bound(date_to)
    if not start or not end or end < start:
        return src, {
            "applied": False,
            "input_rows": len(src),
            "kept_rows": len(src),
            "dropped_before": 0,
            "dropped_after": 0,
            "unparsed_kept": 0,
            "lookback_days": int(lookback_days),
        }

    lower = start - timedelta(days=max(0, int(lookback_days)))
    upper = end + timedelta(days=1) - timedelta(microseconds=1)
    kept: List[Dict[str, Any]] = []
    dropped_before = 0
    dropped_after = 0
    unparsed_kept = 0

    for row in src:
        event_at = _parse_order_history_datetime(
            (row or {}).get("tg_ylenh") or (row or {}).get("ngay")
        )
        if not event_at:
            kept.append(row)
            unparsed_kept += 1
        elif event_at < lower:
            dropped_before += 1
        elif event_at > upper:
            dropped_after += 1
        else:
            kept.append(row)

    return kept, {
        "applied": True,
        "input_rows": len(src),
        "kept_rows": len(kept),
        "dropped_before": dropped_before,
        "dropped_after": dropped_after,
        "unparsed_kept": unparsed_kept,
        "lookback_days": int(lookback_days),
        "from": date_from,
        "to": date_to,
    }


def _fetch_order_history_verified(
    sess: Any,
    ma_bn: str,
    date_from: str,
    date_to: str,
    link_map: Dict[str, str],
    config: Dict[str, Any],
) -> Dict[str, Any]:
    """Không cho nghiên cứu đánh dấu OK nếu chưa xác nhận dropdown đang ở Tất cả."""
    global _LAST_ORDER_HISTORY_SHOW_ALL_OK, _LAST_ORDER_HISTORY_SHOW_ALL_STATE
    _LAST_ORDER_HISTORY_SHOW_ALL_OK = None
    _LAST_ORDER_HISTORY_SHOW_ALL_STATE = {}

    result = _original_fetch_order_history(sess, ma_bn, date_from, date_to, link_map, config)
    if not isinstance(result, dict):
        return result

    # Kho nghiên cứu chủ động bật selenium-first. Trong mode này, HTTP query 1000
    # chỉ là fallback kỹ thuật, không đủ để chứng minh UI đã chạy loadListYLenh().
    requires_verified_all = bool(config.get("hchanh_order_history_selenium_first", False))
    if requires_verified_all and _LAST_ORDER_HISTORY_SHOW_ALL_OK is not True:
        unverified_rows = len(result.get("rows") or []) if isinstance(result.get("rows"), list) else 0
        result = dict(result)
        result["_fetch_status"] = "partial"
        result["_reason"] = "order_history_show_all_not_confirmed"
        result["_error"] = "Không xác nhận được Số lượng hiển thị = Tất cả (1000); không dùng dữ liệu y lệnh này như bản đầy đủ."
        result["_unverified_row_count"] = unverified_rows
        # Không để dữ liệu có thể chỉ là 25 dòng lọt vào kho nghiên cứu.
        result["rows"] = []
        result["total"] = 0
        result["completed"] = 0
        result["incomplete"] = 0
        result["no_service"] = 0
        result["after_discharge"] = 0
        result["incomplete_rows"] = []
        result["after_discharge_rows"] = []
        result["show_all_check"] = dict(_LAST_ORDER_HISTORY_SHOW_ALL_STATE or {})
    else:
        result["show_all_verified"] = _LAST_ORDER_HISTORY_SHOW_ALL_OK is True
        if _LAST_ORDER_HISTORY_SHOW_ALL_STATE:
            result["show_all_check"] = dict(_LAST_ORDER_HISTORY_SHOW_ALL_STATE)

        if requires_verified_all and isinstance(result.get("rows"), list):
            filtered_rows, window_filter = _filter_research_order_rows_by_stay(
                result.get("rows") or [], date_from, date_to, lookback_days=3,
            )
            result["rows"] = filtered_rows
            result["total"] = len(filtered_rows)
            result["completed"] = sum(1 for row in filtered_rows if row.get("status") == "completed")
            result["incomplete_rows"] = [row for row in filtered_rows if row.get("status") == "incomplete"]
            result["incomplete"] = len(result["incomplete_rows"])
            result["no_service"] = sum(1 for row in filtered_rows if row.get("status") == "no_service")
            result["after_discharge_rows"] = [row for row in filtered_rows if row.get("after_discharge")]
            result["after_discharge"] = len(result["after_discharge_rows"])
            result["window_filter"] = window_filter
            try:
                core.trace_event(
                    "ORDER_HISTORY.WINDOW_FILTER",
                    "Lọc lịch sử y lệnh theo đợt điều trị trước khi ghi kho nghiên cứu",
                    screen="Lịch sử y lệnh / rows đã parse",
                    sees=(
                        f"input={window_filter.get('input_rows', 0)}; kept={window_filter.get('kept_rows', 0)}; "
                        f"drop_before={window_filter.get('dropped_before', 0)}; "
                        f"drop_after={window_filter.get('dropped_after', 0)}; "
                        f"unparsed={window_filter.get('unparsed_kept', 0)}"
                    ),
                    takes=f"{date_from or '—'} → {date_to or '—'}; lookback=3 ngày",
                    writes="output.order_history.rows đã giới hạn theo cửa sổ nghiên cứu",
                    target="hchanh_order_history.csv",
                )
            except Exception:
                pass
    return result


# Monkeypatch đúng hai điểm mà các hàm trong module gốc tra cứu ở runtime.
core._fetch_hchanh_html_by_click = _fetch_hchanh_html_by_click_safe
core.fetch_order_history = _fetch_order_history_verified


def main() -> int:
    args = core.build_arg_parser().parse_args()
    files = [f.strip() for f in (args.files or "").split(",") if f.strip()]
    if core._input_is_batch(args.input):
        return core.run_hchanh_fetch_batch(
            input_path=args.input,
            out_path=args.out,
            scope=args.scope,
            files=files,
            date_from=args.date_from,
            date_to=args.date_to,
            inpatient_status=args.inpatient_status,
            headless=args.headless,
            batch_size=args.batch_size,
            progress_path=args.progress_path,
        )
    return core.run_hchanh_fetch(
        input_path=args.input,
        out_path=args.out,
        scope=args.scope,
        files=files,
        date_from=args.date_from,
        date_to=args.date_to,
        inpatient_status=args.inpatient_status,
        headless=args.headless,
    )


if __name__ == "__main__":
    sys.exit(main())
