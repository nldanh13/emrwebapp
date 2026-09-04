# -*- coding: utf-8 -*-
"""input_vtyt.py — Nhập/kê khai vật tư y tế sử dụng từ dashboard EMR.

Luồng an toàn:
- Đọc data/04_classified_patient_day_records.json + targets giống các worker nhập khác.
- Vẫn nhận DuLieu_PhanLoai.json khi chạy với dữ liệu cũ.
- Tính danh sách VTYT cần có bằng worker/vtyt_rules.py và config/vtyt_dictionary.json.
- Mặc định thao tác thật trên EMR khi được backend gọi /api/run-input-vtyt.
- Nếu BN/ngày đã nhập rồi, lần chạy sau chỉ nhập phần VTYT mới tăng thêm do y lệnh mới.
- Nếu đặt env VTYT_DRY_RUN=1 hoặc truyền --dry-run: chỉ ghi kế hoạch, không mở EMR.

Selector chính theo popup "Nhập thuốc/VTYT sử dụng":
#DD_KeNhapThuocSuDung, #dtTuNgayYL, #dtDenNgayYL, #btnTimKiem,
.chkYlenh, #txtLoaiKe, #ckboxNguoiBenhTT, #txtHang/#select2-txtHang-container,
#txtSoLuong, #btnThemVatTuThuong, OnXacNhan().
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import datetime, timedelta
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

from utils import handle_popups, load_config, login_emr
from shared.text_utils import norm_vi as _norm
from shared.worker_session import WorkerSession, open_session
from selenium_emr_helpers import (
    debug_page,
    goto_inpatient_list,
    safe_js_click,
    search_patient_on_ward_or_raise,
    wait_after_action,
)
from task_progress_writer import mark_task_status, progress_path_from_input
from shared.json_io import read_json_critical, read_json_optional
from result_schema import build_worker_result, write_worker_result
from vtyt_rules import build_vtyt_jobs

TASK_NAME = "input_vtyt"
DEFAULT_WPID = "danhsachdieutrinoitrudraw"


def _log(msg: str) -> None:
    print(msg, flush=True)


def _read_json(path: str, default: Any, *, critical: bool = False) -> Any:
    if not path:
        return default
    if critical:
        expected = dict if isinstance(default, dict) else list if isinstance(default, list) else None
        return read_json_critical(path, default, expected_type=expected)
    return read_json_optional(path, default)


def _write_result(
    result_path: str,
    patient_results: Dict[str, Dict[str, Any]],
    skipped_reason: str = "",
    plan: Optional[List[Dict[str, Any]]] = None,
    *,
    full_plan: Optional[List[Dict[str, Any]]] = None,
    mode: str = "patient_day_incremental",
) -> None:
    noop = {k: v for k, v in patient_results.items() if v.get("noop")}
    extra: Dict[str, Any] = {}
    if plan is not None:
        extra["plan"] = plan
    if full_plan is not None:
        extra["full_plan"] = full_plan
    if noop:
        extra["noop"] = noop
    result_obj = build_worker_result(patient_results, skipped_reason=skipped_reason, mode=mode, extra=extra)
    write_worker_result(result_path, result_obj)

    # Server sẽ xóa input_vtyt_result.json sau khi đọc, nên cần cache riêng để lần sau
    # chỉ nhập phần VTYT mới tăng thêm, không nhập trùng vật tư đã nhập trong EMR.
    if full_plan is not None and result_obj.get("succeeded"):
        try:
            cache_path = os.path.join(os.path.dirname(os.path.abspath(result_path)), "vtyt_input_plan_cache.json")
            cache_obj = {
                "version": 1,
                "updated_at": datetime.now().isoformat(),
                "succeeded": result_obj.get("succeeded") or [],
                "plan": full_plan,
                "full_plan": full_plan,
                "mode": mode,
            }
            with open(cache_path, "w", encoding="utf-8") as cf:
                json.dump(cache_obj, cf, ensure_ascii=False, indent=2)
        except Exception as e:
            _log(f"[WARN] Không ghi được cache kế hoạch VTYT: {e}")
    _log(
        f"[RESULT] Ghi kết quả VTYT: {len(result_obj.get('succeeded') or [])} OK, "
        f"{len(result_obj.get('failed') or {})} FAIL → {result_path}"
    )


# _norm → shared.text_utils.norm_vi (xem MIGRATION.md)




def _supply_fingerprint(item: Mapping[str, Any]) -> str:
    return _norm(item.get("key") or item.get("code") or item.get("name") or item.get("searchKeyword") or "")


def _qty_value(item: Mapping[str, Any]) -> float:
    try:
        return float(item.get("required_quantity") or item.get("qty") or item.get("quantity") or 0)
    except Exception:
        return 0.0


def _job_plan_map(plan: Any) -> Dict[str, Dict[str, float]]:
    out: Dict[str, Dict[str, float]] = {}
    if not isinstance(plan, list):
        return out
    for job in plan:
        if not isinstance(job, Mapping):
            continue
        key = str(job.get("key") or f"{job.get('ma_bn')}::{job.get('ngay_lam')}").strip()
        if not key:
            continue
        supplies_by_fp: Dict[str, float] = {}
        for item in (job.get("supplies") or []):
            if not isinstance(item, Mapping):
                continue
            fp = _supply_fingerprint(item)
            if not fp:
                continue
            supplies_by_fp[fp] = supplies_by_fp.get(fp, 0.0) + _qty_value(item)
        out[key] = supplies_by_fp
    return out


def _filter_incremental_jobs(jobs: List[Dict[str, Any]], previous_result: Mapping[str, Any], *, force_full: bool = False) -> Tuple[List[Dict[str, Any]], Dict[str, Dict[str, Any]]]:
    """Chỉ giữ phần VTYT mới cần nhập thêm nếu BN/ngày đã nhập thành công trước đó.

    Đây KHÔNG phải delta lĩnh kho/trả kho. Nó chỉ ngăn nhập trùng vào EMR khi dữ liệu
    được cập nhật và chỉ phát sinh thêm y lệnh mới.
    """
    if force_full:
        return jobs, {}
    succeeded = {str(x or "").strip() for x in (previous_result.get("succeeded") or []) if str(x or "").strip()}
    prev_plan = _job_plan_map(previous_result.get("full_plan") or previous_result.get("plan"))
    next_jobs: List[Dict[str, Any]] = []
    noop: Dict[str, Dict[str, Any]] = {}
    for job in jobs:
        key = str(job.get("key") or f"{job.get('ma_bn')}::{job.get('ngay_lam')}").strip()
        if key not in succeeded or key not in prev_plan:
            next_jobs.append(job)
            continue
        old_qty = prev_plan.get(key) or {}
        new_supplies = []
        unchanged = []
        for item in supplies:
            if not isinstance(item, Mapping):
                continue
            fp = _supply_fingerprint(item)
            required = _qty_value(item)
            added_qty = required - float(old_qty.get(fp, 0.0))
            if added_qty > 0.0001:
                copy = dict(item)
                copy["required_quantity"] = int(added_qty) if float(added_qty).is_integer() else added_qty
                reasons = list(copy.get("reasons") or [])
                note = "Phần VTYT mới tăng thêm sau lần nhập trước; không nhập lại số cũ"
                if note not in reasons:
                    reasons.append(note)
                copy["reasons"] = reasons
                new_supplies.append(copy)
            else:
                unchanged.append(dict(item))
        if new_supplies:
            copy = dict(job)
            copy["full_supplies"] = job.get("supplies") or []
            copy["supplies"] = new_supplies
            copy["incremental_from_previous"] = True
            copy["unchanged_supplies"] = unchanged
            next_jobs.append(copy)
        else:
            noop[key] = {
                "success": True,
                "noop": True,
                "message": "Không có VTYT mới cần nhập thêm so với lần nhập trước.",
                "checked_orders": 0,
                "added": [],
            }
    return next_jobs, noop

def _parse_dmy(value: Any) -> Optional[datetime]:
    m = re.search(r"(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})", str(value or ""))
    if not m:
        return None
    dd, mm, yy = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if yy < 100:
        yy += 2000
    try:
        return datetime(yy, mm, dd)
    except Exception:
        return None


def _date_only_dmy(value: Any, fallback: str = "") -> str:
    dt = _parse_dmy(value)
    if dt:
        return dt.strftime("%d/%m/%Y")
    return fallback


def _next_dmy(date: str) -> str:
    dt = _parse_dmy(date)
    if not dt:
        return ""
    return (dt + timedelta(days=1)).strftime("%d/%m/%Y")


def _same_dmy(a: Any, b: Any) -> bool:
    da = _parse_dmy(a)
    db = _parse_dmy(b)
    return bool(da and db and da.date() == db.date())


def _vtyt_range_for_job(job: Mapping[str, Any]) -> Tuple[str, str]:
    """Khoảng lọc y lệnh VTYT.

    - Nhập thật: chỉ mở đúng ngày cần nhập để tránh tick nhầm.
    - Xem trước hàng loạt Hành chánh: quét một lần từ đầu đến cuối đợt
      điều trị rồi tách kết quả thành từng ngày.
    """
    scan_from = _date_only_dmy(job.get("scan_range_from") or job.get("range_from"), "")
    scan_to = _date_only_dmy(job.get("scan_range_to") or job.get("range_to"), "")
    if scan_from and scan_to:
        return f"00:00 {scan_from}", f"23:59 {scan_to}"

    date = _date_only_dmy(job.get("ngay_lam"))
    if not date:
        date = _date_only_dmy(job.get("ngay_y_lenh") or job.get("date"), datetime.now().strftime("%d/%m/%Y"))
    start = f"00:00 {date}"
    end = f"23:59 {date}"
    exit_date = _date_only_dmy(job.get("ngay_ra_vien") or job.get("ngay_ra_vien_date"), "")
    end_time = str(job.get("gio_ra_vien") or "").strip()
    if exit_date and _same_dmy(exit_date, date) and re.match(r"^\d{1,2}:\d{2}$", end_time):
        end = f"{end_time} {date}"
    return start, end

def _vtyt_input_time_for_job(job: Mapping[str, Any]) -> str:
    date = _date_only_dmy(job.get("ngay_lam"), datetime.now().strftime("%d/%m/%Y"))
    default_time = os.getenv("VTYT_INPUT_TIME", "08:00").strip() or "08:00"
    if not re.match(r"^\d{1,2}:\d{2}$", default_time):
        default_time = "08:00"
    return f"{default_time} {date}"


def _wait_modal(driver: Any, wait: Any) -> None:
    wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "#divModalContentChung, #tbodydivDS, #tblDS")))


def _open_vtyt_popup(driver: Any, wait: Any) -> None:
    _log("   [VTYT] Mở popup Nhập thuốc/VTYT sử dụng")
    candidates = [
        (By.ID, "DD_KeNhapThuocSuDung"),
        (By.XPATH, "//*[contains(normalize-space(), 'Nhập thuốc/VTYT sử dụng') or contains(normalize-space(), 'Kê khai thuốc/vật tư y tế sử dụng')]"),
        (By.XPATH, "//*[contains(normalize-space(), 'Nhập thuốc') and contains(normalize-space(), 'VTYT')]")
    ]
    last_err = None
    for by, value in candidates:
        try:
            el = WebDriverWait(driver, 6).until(EC.element_to_be_clickable((by, value)))
            safe_js_click(driver, el)
            wait_after_action(driver, 0.8, ready_timeout=10)
            _wait_modal(driver, wait)
            return
        except Exception as e:
            last_err = e
    try:
        ok = driver.execute_script("if (typeof ServerSideDrawAddForm === 'function') { ServerSideDrawAddForm(); return true; } return false;")
        if ok:
            wait_after_action(driver, 0.8, ready_timeout=10)
            _wait_modal(driver, wait)
            return
    except Exception as e:
        last_err = e
    debug_page(driver, "vtyt_open_popup_failed", log_func=_log)
    raise RuntimeError(f"Không mở được popup Nhập thuốc/VTYT sử dụng: {last_err}")


def _patient_row(driver: Any, ma_bn: Any):
    code = str(ma_bn or "").strip()
    xpaths = [
        f"//table[@id='tblNoiTru']//tbody//tr[.//*[contains(normalize-space(), '{code}')]]",
        f"//table[contains(@id,'NoiTru')]//tr[.//*[contains(normalize-space(), '{code}')]]",
        f"//tr[.//*[contains(normalize-space(), '{code}')]]",
    ]
    for xp in xpaths:
        try:
            rows = driver.find_elements(By.XPATH, xp)
            if rows:
                return rows[0]
        except Exception:
            continue
    return None


def _open_nursing_view_from_list(driver: Any, wait: Any, ma_bn: Any) -> None:
    """Từ danh sách nội trú, mở đúng con mắt điều dưỡng của người bệnh."""
    row = _patient_row(driver, ma_bn)
    if row is None:
        raise RuntimeError(f"Không tìm thấy dòng BN {ma_bn} sau khi search.")
    candidates = [
        ".//a[contains(translate(@href,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'wpid=dieuduongdraw')]",
        ".//a[.//i[contains(@class,'fa-eye') or contains(@class,'far')]]",
        ".//a[contains(@class,'btn') and contains(@class,'primary')][.//i]",
    ]
    last_err = None
    for xp in candidates:
        try:
            link = row.find_element(By.XPATH, xp)
            href = link.get_attribute("href") or ""
            safe_js_click(driver, link)
            wait_after_action(driver, 1.0, ready_timeout=15)
            WebDriverWait(driver, 12).until(lambda d: "wpid=dieuduongdraw" in (d.current_url or "").lower() or d.find_elements(By.ID, "btnBG") or d.find_elements(By.XPATH, "//*[contains(normalize-space(), 'Chăm sóc')]") )
            _log(f"   [VTYT] Đã vào con mắt điều dưỡng: {href or driver.current_url}")
            return
        except Exception as e:
            last_err = e
    debug_page(driver, "vtyt_open_nursing_failed", log_func=_log)
    raise RuntimeError(f"Không bấm được con mắt điều dưỡng cho BN {ma_bn}: {last_err}")


def _open_vtyt_menu(driver: Any, wait: Any) -> None:
    """Trong trang điều dưỡng, bấm đúng Chăm sóc → Nhập thuốc, VTYT.

    EMR gắn chức năng này vào thẻ:
        <a onclick="onshowDanhSachKeKhaiVTYT(this);"> Nhập thuốc, VTYT</a>
    Vì vậy ưu tiên bấm/call trực tiếp đúng thẻ trong nhóm Chăm sóc thay vì tìm
    theo chữ chung chung, tránh nhầm sang nút popup "Nhập thuốc/VTYT sử dụng".
    """
    _log("   [VTYT] Mở menu Chăm sóc → Nhập thuốc, VTYT")

    def _menu_ready(d: Any) -> bool:
        src = d.page_source or ""
        return bool(d.find_elements(By.ID, "DD_KeNhapThuocSuDung") or "Danh sách thuốc theo y lệnh" in src or "Nhập thuốc/VTYT sử dụng" in src)

    last_err = None
    try:
        ok = driver.execute_script(
            r"""
            const norm = s => (s || '').replace(/\s+/g, ' ').trim();
            const careAnchors = Array.from(document.querySelectorAll('li.has-subnav > a, li.has-subnav a'))
              .filter(a => /^Chăm sóc$/i.test(norm(a.innerText)));
            const care = careAnchors[0] || Array.from(document.querySelectorAll('li.has-subnav > a'))
              .find(a => /chăm sóc/i.test(norm(a.innerText)));
            if (care) {
              const li = care.closest('li.has-subnav') || care.closest('li');
              const ul = li && li.querySelector('ul');
              const wrap = li && li.querySelector('.accordion-btn-wrap');
              if (ul && getComputedStyle(ul).display === 'none') {
                (wrap || care).click();
              }
            }
            return true;
            """
        )
        if ok:
            wait_after_action(driver, 0.4, ready_timeout=5)
    except Exception as e:
        last_err = e

    # 1) Cách chính xác nhất: gọi đúng hàm JS với chính thẻ <a> Nhập thuốc, VTYT.
    try:
        ok = driver.execute_script(
            r"""
            const norm = s => (s || '').replace(/\s+/g, ' ').trim();
            const anchors = Array.from(document.querySelectorAll('a'));
            let a = anchors.find(x => String(x.getAttribute('onclick') || '').includes('onshowDanhSachKeKhaiVTYT'));
            if (!a) a = anchors.find(x => /^Nhập thuốc,?\s*VTYT$/i.test(norm(x.innerText)));
            if (!a) a = anchors.find(x => /Nhập thuốc/i.test(norm(x.innerText)) && /VTYT/i.test(norm(x.innerText)));
            if (!a) return false;
            a.scrollIntoView({block: 'center', inline: 'nearest'});
            if (typeof onshowDanhSachKeKhaiVTYT === 'function') {
              onshowDanhSachKeKhaiVTYT(a);
            } else {
              a.click();
            }
            return true;
            """
        )
        if ok:
            wait_after_action(driver, 1.0, ready_timeout=15)
            WebDriverWait(driver, 15).until(_menu_ready)
            _log("   [VTYT] Đã bấm menu Nhập thuốc, VTYT")
            return
    except Exception as e:
        last_err = e

    # 2) Fallback Selenium click theo đúng onclick/text.
    candidates = [
        (By.XPATH, "//a[contains(@onclick, 'onshowDanhSachKeKhaiVTYT')]"),
        (By.XPATH, "//li[contains(@class,'accordion-header-only')]//a[contains(normalize-space(), 'Nhập thuốc') and contains(normalize-space(), 'VTYT')]"),
        (By.XPATH, "//a[contains(normalize-space(), 'Nhập thuốc') and contains(normalize-space(), 'VTYT')]"),
        (By.ID, "btnNhapVTYT"),
    ]
    for by, value in candidates:
        try:
            el = WebDriverWait(driver, 6).until(EC.presence_of_element_located((by, value)))
            driver.execute_script("arguments[0].scrollIntoView({block:'center', inline:'nearest'});", el)
            wait_after_action(driver, 0.2, ready_timeout=3)
            safe_js_click(driver, el)
            wait_after_action(driver, 1.0, ready_timeout=15)
            WebDriverWait(driver, 15).until(_menu_ready)
            _log("   [VTYT] Đã bấm menu Nhập thuốc, VTYT")
            return
        except Exception as e:
            last_err = e

    debug_page(driver, "vtyt_open_menu_failed", log_func=_log)
    raise RuntimeError(f"Không mở được menu Nhập thuốc, VTYT: {last_err}")


def _set_value(driver: Any, selector: str, value: str) -> bool:
    try:
        el = driver.find_element(By.CSS_SELECTOR, selector)
        driver.execute_script(
            """
            const el = arguments[0], val = arguments[1];
            el.removeAttribute('readonly');
            el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            """,
            el,
            value,
        )
        return True
    except Exception:
        return False


def _set_order_search_range(driver: Any, start: str, end: str) -> None:
    ok1 = _set_value(driver, "#dtTuNgayYL", start)
    ok2 = _set_value(driver, "#dtDenNgayYL", end)
    _log(f"   [VTYT] Khoảng y lệnh: {start} → {end}" + ("" if ok1 and ok2 else " [cảnh báo: chưa set đủ field]"))


def _set_vtyt_input_time(driver: Any, value: str) -> None:
    ok = _set_value(driver, "#txtThoiGianNhapVTYT", value)
    if not ok:
        raise RuntimeError("Không chỉnh được Thời gian nhập VTYT (#txtThoiGianNhapVTYT).")
    _log(f"   [VTYT] Thời gian nhập VTYT: {value}")


def _click_search_orders(driver: Any, wait: Any) -> None:
    try:
        btn = driver.find_element(By.ID, "btnTimKiem")
        safe_js_click(driver, btn)
    except Exception:
        driver.execute_script("if (typeof DrawDSYLenh === 'function') DrawDSYLenh();")
    wait_after_action(driver, 1.0, ready_timeout=12)
    try:
        wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "#tbodydivDS, #tblDS")))
    except Exception:
        pass


def _checkbox_rows(driver: Any) -> List[Dict[str, Any]]:
    try:
        return driver.execute_script(
            """
            const boxes = Array.from(document.querySelectorAll('#tbodydivDS .chkYlenh, .chkYlenh'));
            return boxes.map((box, index) => {
              const cell = box.closest('td') || box.parentElement;
              const row = box.closest('tr');
              return { index, text: ((cell && cell.innerText) || (row && row.innerText) || '').trim(), checked: !!box.checked };
            });
            """
        ) or []
    except Exception:
        return []


def _click_checkbox_index(driver: Any, index: int) -> bool:
    return bool(driver.execute_script(
        """
        const boxes = Array.from(document.querySelectorAll('#tbodydivDS .chkYlenh, .chkYlenh'));
        const box = boxes[arguments[0]];
        if (!box) return false;
        if (!box.checked) {
          const wrap = box.closest('.icheckbox_square-green') || box.closest('td') || box;
          wrap.click();
          if (!box.checked) box.click();
        }
        box.checked = true;
        box.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
        """,
        index,
    ))


def _select_order_checkboxes_for_job(driver: Any, job: Mapping[str, Any], *, allow_select_all: bool = False) -> int:
    rows = _checkbox_rows(driver)
    if not rows:
        debug_page(driver, "vtyt_no_ylenh_checkbox", log_func=_log)
        raise RuntimeError("Không tìm thấy y lệnh thuốc/VTYT để tick trong popup.")

    date = _date_only_dmy(job.get("ngay_lam"))
    date_dash = date.replace('/', '-') if date else ''
    range_mode = bool(job.get('batch_range_preview') or job.get('batchRangePreview'))
    matched = []
    if range_mode:
        matched = [int(row.get('index')) for row in rows]
    else:
        for row in rows:
            text = str(row.get('text') or '')
            if date and (date in text or date_dash in text):
                matched.append(int(row.get('index')))

    if not matched:
        if len(rows) == 1:
            matched = [int(rows[0].get('index'))]
            _log(f"   [VTYT] Không thấy ngày {date} trong tiêu đề y lệnh; popup chỉ có 1 y lệnh nên tick y lệnh duy nhất.")
        elif allow_select_all:
            matched = [int(r.get('index')) for r in rows]
            _log("   [VTYT] Không lọc được theo ngày; cho phép tick toàn bộ y lệnh trong popup.")
        else:
            debug_page(driver, "vtyt_no_ylenh_for_target_date", log_func=_log)
            available = "; ".join(str(r.get('text') or '').replace('\n', ' ')[:80] for r in rows[:8])
            raise RuntimeError(f"Không tìm thấy y lệnh ngày {date} trong popup VTYT. Các y lệnh đang thấy: {available}")

    checked = 0
    for idx in matched:
        try:
            if _click_checkbox_index(driver, idx):
                checked += 1
        except Exception:
            continue
    if checked <= 0:
        debug_page(driver, "vtyt_no_ylenh_checked", log_func=_log)
        raise RuntimeError("Không tick được y lệnh thuốc/VTYT trong popup.")
    labels = [str(r.get('text') or '').replace('\n', ' ')[:80] for r in rows if int(r.get('index')) in set(matched)]
    if range_mode:
        _log(f"   [VTYT] Đã tick {checked} y lệnh trong toàn khoảng: " + "; ".join(labels[:12]))
    else:
        _log(f"   [VTYT] Đã tick {checked} y lệnh ngày {date}: " + "; ".join(labels))
    return checked

def _parse_float(value: Any) -> float:
    raw = str(value or "").strip().replace(",", ".")
    m = re.search(r"-?\d+(?:\.\d+)?", raw)
    if not m:
        return 0.0
    try:
        return float(m.group(0))
    except Exception:
        return 0.0


def _format_qty(value: Any) -> Any:
    num = _parse_float(value)
    if abs(num - round(num)) < 0.0001:
        return int(round(num))
    return num


def _looks_like_vtyt_row(item: Mapping[str, Any]) -> bool:
    code = str(item.get('code') or '').strip().upper()
    name = _norm(item.get('name') or '')
    if code.startswith('VTYT'):
        return True
    keywords = [
        'kim', 'bom tiem', 'bơm tiêm', 'day truyen', 'dây truyền', 'bang dinh', 'băng dính',
        'gang tay', 'găng tay', 'kim luon', 'kim luồn', 'nut kim', 'nút kim', 'khoa 3 nga',
        'khóa 3 ngã', 'sonde', 'tui nuoc tieu', 'túi nước tiểu', 'ong thong', 'ống thông',
        'safetouch', 'plug iv', 'connector', 'uverda', 'decomed', 'wemso', 'introcan', 'foley',
    ]
    return any(_norm(k) in name for k in keywords)


def _is_diluent_or_water(item: Mapping[str, Any]) -> bool:
    text = _norm(f"{item.get('name') or ''} {item.get('content') or ''} {item.get('route') or ''}")
    return any(k in text for k in [
        'natri clorid', 'sodium chloride', 'nacl', 'nuoc cat', 'nước cất', 'nuoc muoi', 'nước muối', 'aqua', 'water for injection'
    ])


def _is_infusion_or_injection(item: Mapping[str, Any]) -> bool:
    text = _norm(f"{item.get('name') or ''} {item.get('route') or ''} {item.get('unit') or ''}")
    if any(k in text for k in ['tiem truyen', 'tiêm truyền', 'truyen tinh mach', 'truyền tĩnh mạch', 'tiem tinh mach', 'tiêm tĩnh mạch']):
        return True
    if any(k in text for k in ['tiem', 'tiêm']) and not any(k in text for k in ['vien', 'uống', 'uong']):
        return True
    return False


def _extract_order_time(text: Any) -> str:
    m = re.search(r"(\d{1,2}:\d{2})\s+(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})", str(text or ""))
    if not m:
        return ""
    return f"{m.group(1)} {m.group(2).replace('-', '/')}"


def _parse_popup_order_rows(driver: Any) -> List[Dict[str, Any]]:
    """Parse bảng Danh sách thuốc theo y lệnh sau khi đã tìm kiếm/tick."""
    rows = driver.execute_script(
        r"""
        const out = [];
        const body = document.querySelector('#tbodydivDS') || document;
        let current = null;
        for (const tr of Array.from(body.querySelectorAll('tr'))) {
          const box = tr.querySelector('.chkYlenh');
          if (box) {
            const text = (tr.innerText || '').replace(/\s+/g, ' ').trim();
            current = { text, checked: !!box.checked, id: box.value || '' };
            out.push({ type: 'order_header', order: current });
            continue;
          }
          const cells = Array.from(tr.querySelectorAll('td')).map(td => (td.innerText || '').replace(/\s+/g, ' ').trim());
          if (!current || cells.length < 5) continue;
          out.push({
            type: 'item', order_text: current.text, order_id: current.id, checked: !!current.checked,
            code: cells[0] || '', name: cells[1] || '', content: cells[2] || '',
            unit: cells[3] || '', quantity: cells[4] || '', route: cells[5] || '',
          });
        }
        return out;
        """
    ) or []
    return [dict(x) for x in rows if isinstance(x, Mapping)]


def _build_popup_preview(driver: Any, job: Mapping[str, Any]) -> Dict[str, Any]:
    rows = _parse_popup_order_rows(driver)
    order_map: Dict[str, Dict[str, Any]] = {}
    drugs: List[Dict[str, Any]] = []
    supply_group: Dict[str, Dict[str, Any]] = {}
    warnings: List[str] = []

    for row in rows:
        if row.get('type') == 'order_header':
            order = dict(row.get('order') or {})
            text = str(order.get('text') or '')
            key = str(order.get('id') or text).strip()
            if key and order.get('checked'):
                order_map.setdefault(key, {
                    'id': str(order.get('id') or ''), 'text': text, 'time': _extract_order_time(text),
                    'items': [], 'drugs': [], 'supplies': [], 'warnings': [],
                })
            continue
        if row.get('type') != 'item' or not row.get('checked'):
            continue
        order_key = str(row.get('order_id') or row.get('order_text') or '').strip()
        order = order_map.setdefault(order_key, {
            'id': str(row.get('order_id') or ''), 'text': str(row.get('order_text') or ''),
            'time': _extract_order_time(row.get('order_text')), 'items': [], 'drugs': [], 'supplies': [], 'warnings': [],
        })
        qty = _format_qty(row.get('quantity'))
        item = {
            'order_id': str(row.get('order_id') or ''), 'order_text': str(row.get('order_text') or ''),
            'order_time': order.get('time') or _extract_order_time(row.get('order_text')),
            'code': str(row.get('code') or '').strip(), 'name': str(row.get('name') or '').strip(),
            'content': str(row.get('content') or '').strip(), 'unit': str(row.get('unit') or '').strip(),
            'quantity': qty, 'route': str(row.get('route') or '').strip(),
        }
        order['items'].append(item)
        if _looks_like_vtyt_row(item):
            order['supplies'].append(item)
            code = item.get('code') or ''
            key = code or _norm(item.get('name') or '')
            if not key:
                continue
            agg = supply_group.setdefault(key, {
                'key': key, 'code': code, 'name': item.get('name') or '', 'searchKeyword': code or item.get('name') or '',
                'required_quantity': 0, 'unit': item.get('unit') or '', 'category': 'hchanh_order_vtyt',
                'reasons': ['Lấy trực tiếp từ bảng y lệnh trong popup Nhập thuốc/VTYT sử dụng'],
                'sources': [], 'input_allowed': True, 'needs_review': False,
            })
            agg['required_quantity'] = _format_qty(float(agg.get('required_quantity') or 0) + float(_parse_float(qty)))
            agg['sources'].append(item)
        else:
            order['drugs'].append(item)
            drugs.append(item)

    for order in order_map.values():
        if not order.get('items'):
            continue
        has_diluent = any(_is_diluent_or_water(x) for x in order.get('items') or [])
        for drug in order.get('drugs') or []:
            if _is_infusion_or_injection(drug) and not has_diluent:
                msg = f"{drug.get('order_time') or order.get('time') or ''}: {drug.get('name')} cần kiểm tra NaCl/nước cất pha/truyền."
                order['warnings'].append(msg)
                warnings.append(msg)

    supplies = sorted(supply_group.values(), key=lambda x: (_norm(x.get('name') or ''), x.get('code') or ''))
    orders = sorted(order_map.values(), key=lambda x: x.get('time') or x.get('text') or '')
    return {
        'ma_bn': job.get('ma_bn') or '', 'ngay_lam': job.get('ngay_lam') or '',
        'input_time': _vtyt_input_time_for_job(job),
        'range': {'from': _vtyt_range_for_job(job)[0], 'to': _vtyt_range_for_job(job)[1]},
        'checked_order_count': len([o for o in orders if o.get('items')]),
        'orders': orders, 'drugs': drugs, 'supplies': supplies, 'warnings': warnings,
        'summary': {'order_count': len([o for o in orders if o.get('items')]), 'drug_count': len(drugs), 'supply_count': len(supplies), 'warning_count': len(warnings)},
    }

def _aggregate_preview_supplies(orders: List[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    """Gộp các dòng VTYT có sẵn trong các y lệnh của một ngày."""
    grouped: Dict[str, Dict[str, Any]] = {}
    for order in orders or []:
        for raw in (order.get('supplies') or []):
            if not isinstance(raw, Mapping):
                continue
            code = str(raw.get('code') or '').strip()
            name = str(raw.get('name') or '').strip()
            key = code or _norm(name)
            if not key:
                continue
            item = grouped.setdefault(key, {
                'key': key,
                'code': code,
                'name': name,
                'searchKeyword': code or name,
                'required_quantity': 0,
                'unit': str(raw.get('unit') or '').strip(),
                'category': 'hchanh_order_vtyt',
                'reasons': ['Lấy trực tiếp từ bảng y lệnh trong popup Nhập thuốc/VTYT sử dụng'],
                'sources': [],
                'input_allowed': True,
                'needs_review': False,
            })
            item['required_quantity'] = _format_qty(
                float(item.get('required_quantity') or 0) + _parse_float(raw.get('quantity') or raw.get('required_quantity') or 0)
            )
            item['sources'].append(dict(raw))
    return sorted(grouped.values(), key=lambda x: (_norm(x.get('name') or ''), x.get('code') or ''))


def _date_range_dmy(start: str, end: str, limit: int = 366) -> List[str]:
    first = _parse_dmy(start)
    last = _parse_dmy(end)
    if not first or not last or first.date() > last.date():
        return []
    out: List[str] = []
    current = first
    while current.date() <= last.date() and len(out) < max(1, int(limit or 366)):
        out.append(current.strftime('%d/%m/%Y'))
        current += timedelta(days=1)
    return out


def _split_range_preview(job: Mapping[str, Any], preview: Mapping[str, Any]) -> List[Dict[str, Any]]:
    """Tách một lần quét cả đợt thành kế hoạch từng BN/ngày.

    Trả cả ngày không có y lệnh để bộ quy tắc hậu phẫu/nhiễm trùng vẫn có thể
    gợi ý vật tư trong toàn khoảng điều trị.
    """
    scan_from = _date_only_dmy(job.get('scan_range_from') or job.get('range_from'), '')
    scan_to = _date_only_dmy(job.get('scan_range_to') or job.get('range_to'), '')
    dates = _date_range_dmy(scan_from, scan_to)
    if not dates:
        fallback = _date_only_dmy(job.get('ngay_lam'), '')
        dates = [fallback] if fallback else []

    by_date: Dict[str, List[Dict[str, Any]]] = {date: [] for date in dates}
    undated: List[Dict[str, Any]] = []
    for raw in (preview.get('orders') or []):
        if not isinstance(raw, Mapping):
            continue
        order = dict(raw)
        order_date = _date_only_dmy(order.get('time') or order.get('text'), '')
        if order_date and order_date in by_date:
            by_date[order_date].append(order)
        else:
            undated.append(order)
    if undated and dates:
        # Không đoán rải đều. Gắn các y lệnh không đọc được ngày vào ngày cuối và
        # phát cảnh báo để người dùng kiểm tra trước khi nhập.
        by_date[dates[-1]].extend(undated)

    out: List[Dict[str, Any]] = []
    for date in dates:
        orders = by_date.get(date) or []
        drugs = [dict(drug) for order in orders for drug in (order.get('drugs') or []) if isinstance(drug, Mapping)]
        warnings = [str(w) for order in orders for w in (order.get('warnings') or []) if str(w).strip()]
        if undated and date == dates[-1]:
            warnings.append(f'Có {len(undated)} y lệnh không đọc được ngày; tạm hiển thị ở ngày cuối để kiểm tra.')
        supplies = _aggregate_preview_supplies(orders)
        daily = {k: v for k, v in dict(job).items() if k not in {
            'supplies', 'scan_range_from', 'scan_range_to', 'range_from', 'range_to', 'batch_range_preview', 'batchRangePreview'
        }}
        daily.update({
            'key': f"{job.get('ma_bn') or ''}::{date}",
            'ngay_lam': date,
            'supplies': supplies,
            'drugs': drugs,
            'orders': orders,
            'warnings': warnings,
            'summary': {
                'order_count': len(orders),
                'drug_count': len(drugs),
                'supply_count': len(supplies),
                'warning_count': len(warnings),
            },
            'input_time': _vtyt_input_time_for_job({'ngay_lam': date}),
            'range': {'from': f'00:00 {date}', 'to': f'23:59 {date}'},
            'no_orders': not bool(orders),
            'hchanh_direct_vtyt': True,
            'allow_select_all_orders': False,
        })
        out.append(daily)
    return out


def _parse_selected_vtyt_supplies_from_popup(driver: Any, job: Mapping[str, Any]) -> List[Dict[str, Any]]:
    """Lấy danh sách VTYT trực tiếp từ bảng y lệnh trong popup EMR."""
    preview = _build_popup_preview(driver, job)
    supplies = list(preview.get('supplies') or [])
    if supplies:
        _log(f"   [VTYT] Tự lập kế hoạch từ popup: {len(supplies)} vật tư y tế.")
        for item in supplies[:12]:
            _log(f"      - {item.get('code') or ''} {item.get('name')}: {item.get('required_quantity')} {item.get('unit') or ''}".rstrip())
    return supplies


def _direct_jobs_from_targets(targets: Mapping[str, Any], processed: List[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    preview_jobs = targets.get('vtytPreviewJobs') or targets.get('vtyt_preview_jobs')
    if isinstance(preview_jobs, list) and preview_jobs:
        out = []
        for raw in preview_jobs:
            if isinstance(raw, Mapping):
                job = dict(raw)
                job['hchanh_direct_vtyt'] = True
                job['allow_select_all_orders'] = False
                out.append(job)
        if out:
            return out

    batch_ranges = targets.get('vtytBatchRanges') or targets.get('vtyt_batch_ranges')
    if isinstance(batch_ranges, Mapping) and batch_ranges:
        out = []
        ids_for_ranges = [str(x or '').strip() for x in (targets.get('patientIds') or []) if str(x or '').strip()]
        for pid in ids_for_ranges:
            raw_range = batch_ranges.get(pid)
            if not isinstance(raw_range, Mapping):
                continue
            scan_from = _date_only_dmy(raw_range.get('from') or raw_range.get('start') or raw_range.get('scan_range_from'), '')
            scan_to = _date_only_dmy(raw_range.get('to') or raw_range.get('end') or raw_range.get('scan_range_to'), '')
            if not scan_from or not scan_to:
                continue
            out.append({
                'key': f'{pid}::range::{scan_from}::{scan_to}',
                'ma_bn': pid,
                'ngay_lam': scan_to,
                'scan_range_from': scan_from,
                'scan_range_to': scan_to,
                'batch_range_preview': True,
                'supplies': [],
                'hchanh_direct_vtyt': True,
                'allow_select_all_orders': True,
            })
        if out:
            return out

    ids = [str(x or '').strip() for x in (targets.get('patientIds') or []) if str(x or '').strip()]
    patient_dates = targets.get('patientDates') if isinstance(targets.get('patientDates'), Mapping) else {}
    selected_dates = [str(x or '').strip() for x in (targets.get('selectedDates') or []) if str(x or '').strip()]
    by_id_date = {(str(r.get('ma_bn') or r.get('id') or '').strip(), str(r.get('ngay_lam') or '').strip()): r for r in processed if isinstance(r, Mapping)}
    jobs: List[Dict[str, Any]] = []
    for pid in ids:
        dates = patient_dates.get(pid) if isinstance(patient_dates.get(pid), list) else selected_dates
        for date in [str(x or '').strip() for x in (dates or []) if str(x or '').strip()]:
            row = by_id_date.get((pid, date), {})
            jobs.append({
                'key': f'{pid}::{date}',
                'ma_bn': pid,
                'ngay_lam': date,
                'ho_ten': row.get('ho_ten') or targets.get('ho_ten') or targets.get('name') or '',
                'so_phong': row.get('so_phong') or targets.get('phong') or '',
                'supplies': [],
                'hchanh_direct_vtyt': True,
                'allow_select_all_orders': False,
            })
    return jobs

def _select_loai_ke_du_tru(driver: Any) -> None:
    ok = driver.execute_script(
        """
        const el = document.querySelector('#txtLoaiKe');
        if (!el) return false;
        el.value = '3';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        if (window.jQuery) window.jQuery(el).val('3').trigger('change').trigger('change.select2');
        if (typeof changeLoaiDD === 'function') changeLoaiDD('3');
        return true;
        """
    )
    if not ok:
        raise RuntimeError("Không chọn được Loại kê = Dự trù (#txtLoaiKe).")
    wait_after_action(driver, 0.55, ready_timeout=8)
    try:
        WebDriverWait(driver, 8).until(lambda d: d.execute_script("const el=document.querySelector('#txtHang'); return !!el && !el.disabled;"))
    except Exception:
        # Một số màn hình chỉ mở kho/vật tư sau vài nhịp AJAX; vẫn cho bước Select2 báo lỗi cụ thể nếu chưa sẵn sàng.
        pass


def _check_nguoi_benh_tu_tra(driver: Any) -> None:
    ok = driver.execute_script(
        """
        const el = document.querySelector('#ckboxNguoiBenhTT');
        if (!el) return false;
        if (window.jQuery && typeof window.jQuery(el).iCheck === 'function') {
          window.jQuery(el).iCheck('check');
          return true;
        }
        if (!el.checked) {
          const wrap = el.closest('.icheckbox_square-green') || el.parentElement || el;
          wrap.click();
        }
        el.checked = true;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
        """
    )
    if not ok:
        raise RuntimeError("Không tick được Tự trả (Ngoài BHYT) #ckboxNguoiBenhTT.")
    wait_after_action(driver, 0.25, ready_timeout=5)


def _option_score(text: str, keyword: str, code: str) -> int:
    n = _norm(text)
    kw = _norm(keyword)
    cd = _norm(code)
    score = 0
    if cd and cd in n:
        score += 100
    if kw and kw in n:
        score += 50
    for token in kw.split():
        if len(token) >= 3 and token in n:
            score += 2
    return score


def _select_vtyt_item(driver: Any, wait: Any, keyword: str, code: str = "") -> str:
    search_text = code or keyword
    _log(f"      [VTYT] Chọn vật tư: {search_text}")
    box_candidates = ["#select2-txtHang-container", "#txtHang + .select2 .select2-selection", ".select2-selection[aria-labelledby='select2-txtHang-container']"]
    opened = False
    for sel in box_candidates:
        try:
            el = driver.find_element(By.CSS_SELECTOR, sel)
            safe_js_click(driver, el)
            opened = True
            break
        except Exception:
            continue
    if not opened:
        raise RuntimeError("Không tìm thấy Select2 #txtHang để chọn vật tư.")
    search = WebDriverWait(driver, 8).until(EC.element_to_be_clickable((By.CSS_SELECTOR, ".select2-container--open .select2-search__field")))
    search.send_keys(Keys.CONTROL, "a")
    search.send_keys(search_text)
    wait_after_action(driver, 0.8, ready_timeout=5)

    options = driver.find_elements(By.CSS_SELECTOR, "#select2-txtHang-results .select2-results__option, .select2-results__option")
    best = None
    best_score = 0
    for opt in options:
        text = (opt.text or "").strip()
        score = _option_score(text, keyword, code)
        if score > best_score:
            best = opt; best_score = score
    if not best or best_score <= 0:
        raise RuntimeError(f"Không tìm thấy vật tư trong Select2: {keyword} / {code}")
    selected_text = (best.text or "").replace("\n", " ").strip()
    safe_js_click(driver, best)
    wait_after_action(driver, 0.4, ready_timeout=5)
    return selected_text


def _add_vtyt_quantity(driver: Any, quantity: Any) -> None:
    qty = str(int(float(quantity))) if str(quantity).replace('.', '', 1).isdigit() else str(quantity)
    if not _set_value(driver, "#txtSoLuong", qty):
        raise RuntimeError("Không nhập được số lượng #txtSoLuong.")
    try:
        btn = driver.find_element(By.ID, "btnThemVatTuThuong")
        if not btn.is_enabled():
            raise RuntimeError("Nút Thêm VTYT đang bị disable.")
        safe_js_click(driver, btn)
    except RuntimeError:
        raise
    except Exception as e:
        raise RuntimeError(f"Không bấm được nút Thêm VTYT: {e}")
    wait_after_action(driver, 0.7, ready_timeout=8)


def _confirm_vtyt(driver: Any) -> None:
    ok = driver.execute_script(
        """
        const buttons = Array.from(document.querySelectorAll('button, input[type=button], a'));
        const btn = buttons.find(x => /xác nhận/i.test(x.innerText || x.value || '') && String(x.getAttribute('onclick') || '').includes('OnXacNhan'))
              || buttons.find(x => /xác nhận/i.test(x.innerText || x.value || ''));
        if (btn) { btn.click(); return true; }
        if (typeof OnXacNhan === 'function') { OnXacNhan(); return true; }
        return false;
        """
    )
    if not ok:
        raise RuntimeError("Không tìm thấy nút/hàm Xác nhận VTYT.")
    wait_after_action(driver, 1.0, ready_timeout=10)


def _close_modal_if_possible(driver: Any) -> None:
    try:
        driver.execute_script("const b=document.querySelector('.modal .close, button.close, [data-dismiss=modal]'); if (b) b.click();")
    except Exception:
        pass



def _open_patient_vtyt_popup_for_job(driver: Any, wait: Any, config: Mapping[str, Any], job: Mapping[str, Any]) -> None:
    ma_bn = str(job.get("ma_bn") or "").strip()
    goto_inpatient_list(driver, wait, dict(config), login_func=login_emr, log_func=_log, debug_func=lambda d, l: debug_page(d, l, log_func=_log))
    search_patient_on_ward_or_raise(driver, wait, dict(config), ma_bn, login_func=login_emr, log_func=_log, debug_func=lambda d, l: debug_page(d, l, log_func=_log), allow_completed=True)
    _open_nursing_view_from_list(driver, wait, ma_bn)
    _open_vtyt_menu(driver, wait)
    _open_vtyt_popup(driver, wait)
    start, end = _vtyt_range_for_job(job)
    _set_order_search_range(driver, start, end)
    _click_search_orders(driver, wait)
    allow_select_all = bool(job.get("allow_select_all_orders")) or os.getenv("VTYT_ALLOW_SELECT_ALL_ORDERS", "").strip().lower() in ("1", "true", "yes", "y")
    _select_order_checkboxes_for_job(driver, job, allow_select_all=allow_select_all)


def _preview_one_job(driver: Any, wait: Any, config: Mapping[str, Any], job: Mapping[str, Any]) -> Any:
    ma_bn = str(job.get("ma_bn") or "").strip()
    _log(f"[BN] {ma_bn} {job.get('ngay_lam') or ''}: quét thuốc/VTYT để xem trước")
    try:
        _open_patient_vtyt_popup_for_job(driver, wait, config, job)
    except RuntimeError as exc:
        message = str(exc)
        no_order_markers = (
            "Không tìm thấy y lệnh ngày",
            "Không tìm thấy y lệnh thuốc/VTYT",
            "Không tick được y lệnh thuốc/VTYT",
        )
        if job.get('hchanh_direct_vtyt') and any(marker in message for marker in no_order_markers):
            if job.get('batch_range_preview') or job.get('batchRangePreview'):
                _log(
                    f"   [VTYT] Toàn khoảng {job.get('scan_range_from') or ''} - {job.get('scan_range_to') or ''} "
                    "không có y lệnh; vẫn tạo các ngày rỗng để áp dụng quy tắc hậu phẫu."
                )
                empty_preview = {'orders': [], 'drugs': [], 'supplies': [], 'warnings': []}
                return _split_range_preview(job, empty_preview)
            _log(f"   [VTYT] Ngày {job.get('ngay_lam') or ''} không có y lệnh; ghi nhận ngày rỗng, không xem là lỗi.")
            return {
                **{k: v for k, v in dict(job).items() if k != 'supplies'},
                'supplies': [], 'drugs': [], 'orders': [], 'warnings': [],
                'summary': {'order_count': 0, 'drug_count': 0, 'supply_count': 0, 'warning_count': 0},
                'input_time': _vtyt_input_time_for_job(job),
                'range': {'from': _vtyt_range_for_job(job)[0], 'to': _vtyt_range_for_job(job)[1]},
                'no_orders': True,
            }
        raise
    preview = _build_popup_preview(driver, job)
    if job.get('batch_range_preview') or job.get('batchRangePreview'):
        daily_jobs = _split_range_preview(job, preview)
        _log(
            f"   [VTYT] Preview cả đợt: {preview.get('summary', {}).get('order_count', 0)} y lệnh "
            f"→ {len(daily_jobs)} ngày từ {job.get('scan_range_from') or ''} đến {job.get('scan_range_to') or ''}."
        )
        _close_modal_if_possible(driver)
        return daily_jobs
    supplies = list(preview.get('supplies') or [])
    _log(
        f"   [VTYT] Preview: {preview.get('summary', {}).get('order_count', 0)} y lệnh | "
        f"{preview.get('summary', {}).get('drug_count', 0)} thuốc | {len(supplies)} VTYT | "
        f"{preview.get('summary', {}).get('warning_count', 0)} cảnh báo"
    )
    job_preview = {k: v for k, v in dict(job).items() if k != 'supplies'}
    job_preview['supplies'] = supplies
    job_preview['drugs'] = preview.get('drugs') or []
    job_preview['orders'] = preview.get('orders') or []
    job_preview['warnings'] = preview.get('warnings') or []
    job_preview['summary'] = preview.get('summary') or {}
    job_preview['input_time'] = preview.get('input_time') or _vtyt_input_time_for_job(job)
    job_preview['range'] = preview.get('range') or {}
    _close_modal_if_possible(driver)
    return job_preview

def _supply_match_key(item: Mapping[str, Any]) -> str:
    code = str(item.get("code") or item.get("key") or "").strip().upper()
    if code:
        return f"code::{code}"
    name = _norm(item.get("name") or item.get("searchKeyword") or "")
    return f"name::{name}" if name else ""


def _current_supply_quantity_map(preview: Mapping[str, Any]) -> Dict[str, float]:
    out: Dict[str, float] = {}
    for item in (preview.get("supplies") or []):
        if not isinstance(item, Mapping):
            continue
        key = _supply_match_key(item)
        if not key:
            continue
        out[key] = out.get(key, 0.0) + _parse_float(item.get("required_quantity") or item.get("quantity") or 0)
    return out


def _input_one_job(driver: Any, wait: Any, config: Mapping[str, Any], job: Mapping[str, Any]) -> Dict[str, Any]:
    ma_bn = str(job.get("ma_bn") or "").strip()
    label = f"{ma_bn} {job.get('ho_ten') or ''} {job.get('ngay_lam') or ''}".strip()
    _log(f"[BN] {label}: bắt đầu nhập VTYT ({len(job.get('supplies') or [])} vật tư)")
    mark_task_status(progress_path_from_input(sys.argv[1] if len(sys.argv) > 1 else ""), TASK_NAME, ma_bn, job.get("ngay_lam") or "", "running", "Đang nhập VTYT")

    _open_patient_vtyt_popup_for_job(driver, wait, config, job)
    checked = len([x for x in _checkbox_rows(driver) if x.get('checked')])
    preview = _build_popup_preview(driver, job)
    supplies = list(job.get('supplies') or [])
    # Khi người dùng đã chỉnh kế hoạch VTYT trong tab Hành chánh, giữ nguyên
    # danh sách/số lượng đã duyệt; không ghi đè bằng VTYT đọc lại từ popup.
    manual_plan = bool(job.get('manual_vtyt_plan') or job.get('manualVtytPlan'))
    if (job.get('hchanh_direct_vtyt') and not manual_plan) or not supplies:
        direct_supplies = list(preview.get('supplies') or [])
        if direct_supplies:
            supplies = direct_supplies
    if preview.get('warnings'):
        for w in preview.get('warnings')[:10]:
            _log(f"   [VTYT][CẢNH BÁO] {w}")
    _set_vtyt_input_time(driver, _vtyt_input_time_for_job(job))
    _check_nguoi_benh_tu_tra(driver)
    _select_loai_ke_du_tru(driver)

    added = []
    skipped_review = []
    already_enough = []
    current_supply_map = _current_supply_quantity_map(preview)
    allow_review_items = os.getenv("VTYT_ALLOW_REVIEW_ITEMS", "").strip().lower() in ("1", "true", "yes", "y")
    for item in supplies:
        qty = _parse_float(item.get("required_quantity") or 0)
        if manual_plan:
            key = _supply_match_key(item)
            current_existing = current_supply_map.get(key, 0.0) if key else 0.0
            desired_total = _parse_float(item.get("desired_total_quantity"))
            if desired_total <= 0:
                desired_total = _parse_float(item.get("preview_existing_quantity")) + qty
            excess = current_existing - desired_total
            if excess > 2:
                skipped_review.append({
                    "key": item.get("key"),
                    "code": item.get("code"),
                    "name": item.get("name"),
                    "quantity": 0,
                    "current_existing": current_existing,
                    "desired_total": desired_total,
                    "excess": excess,
                    "reasons": [f"Số lượng hiện tại đang dư {excess:g} so với kế hoạch; cần kiểm tra thủ công."],
                })
                continue
            qty = max(0.0, desired_total - current_existing)
            if qty <= 0:
                already_enough.append({
                    "key": item.get("key"),
                    "code": item.get("code"),
                    "name": item.get("name"),
                    "current_existing": current_existing,
                    "desired_total": desired_total,
                })
                continue
        if qty <= 0:
            continue
        if (item.get("input_allowed") is False or item.get("needs_review")) and not allow_review_items:
            skipped_review.append({
                "key": item.get("key"),
                "code": item.get("code"),
                "name": item.get("name"),
                "quantity": qty,
                "reasons": item.get("reasons") or [],
            })
            continue
        selected = _select_vtyt_item(driver, wait, item.get("searchKeyword") or item.get("name") or item.get("code") or "", item.get("code") or "")
        _add_vtyt_quantity(driver, qty)
        added.append({"key": item.get("key"), "code": item.get("code"), "name": item.get("name"), "quantity": qty, "selected": selected, "category": item.get("category") or ""})

    if not added:
        _close_modal_if_possible(driver)
        if skipped_review:
            return {
                "success": True,
                "skipped": True,
                "needs_review": True,
                "message": "Không nhập vì số lượng hiện tại dư nhiều hoặc vật tư cần kiểm tra.",
                "skipped_review_items": skipped_review,
                "already_enough_items": already_enough,
            }
        if already_enough:
            return {
                "success": True,
                "skipped": True,
                "message": "Số lượng VTYT hiện tại đã đủ theo kế hoạch.",
                "already_enough_items": already_enough,
            }
        raise RuntimeError("Kế hoạch VTYT không có vật tư hợp lệ để thêm.")
    _confirm_vtyt(driver)
    _close_modal_if_possible(driver)
    mark_task_status(progress_path_from_input(sys.argv[1] if len(sys.argv) > 1 else ""), TASK_NAME, ma_bn, job.get("ngay_lam") or "", "done", f"Đã nhập {len(added)} vật tư")
    result = {"success": True, "checked_orders": checked, "added": added}
    if job.get('hchanh_direct_vtyt'):
        result['hchanh_direct_vtyt'] = True
    if skipped_review:
        result["skipped_review_items"] = skipped_review
    if already_enough:
        result["already_enough_items"] = already_enough
    if job.get("incremental_from_previous"):
        result["incremental_from_previous"] = True
    return result


def main(argv: List[str]) -> int:
    if len(argv) < 3:
        print("Usage: python input_vtyt.py <classified_patient_day_records.json> <targets.json> [--dry-run]", file=sys.stderr)
        return 1
    processed_path = argv[1]
    targets_path = argv[2]
    dry_run = ("--dry-run" in argv) or (os.getenv("VTYT_DRY_RUN", "").strip().lower() in ("1", "true", "yes", "y"))
    plan_only = ("--plan-only" in argv) or (os.getenv("VTYT_PLAN_ONLY", "").strip().lower() in ("1", "true", "yes", "y"))
    result_path = os.path.join(os.path.dirname(os.path.abspath(processed_path)), "input_vtyt_result.json")

    processed = _read_json(processed_path, [], critical=True)
    targets = _read_json(targets_path, {}, critical=True)
    if not isinstance(processed, list):
        _write_result(result_path, {}, "File phân loại không phải danh sách.")
        return 1

    direct_hchanh = bool(
        isinstance(targets, Mapping)
        and (targets.get('hchanhDirectVtyt') or targets.get('hchanh_direct_vtyt') or targets.get('source') == 'hchanh')
    )
    if direct_hchanh:
        # Hành chánh phải đọc trực tiếp popup EMR để lấy đủ cả đợt và giữ đúng
        # kế hoạch người dùng đã sửa; không dùng dữ liệu phân loại cũ nếu có.
        full_jobs = _direct_jobs_from_targets(targets, processed if isinstance(processed, list) else [])
        if full_jobs:
            mode_label = 'BN/khoảng' if any(job.get('batch_range_preview') for job in full_jobs) else 'BN/ngày'
            _log(f"[VTYT] Chế độ Hành chánh trực tiếp: {len(full_jobs)} {mode_label}. Sẽ lấy dữ liệu từ popup EMR.")
        else:
            full_jobs = build_vtyt_jobs(processed, targets if isinstance(targets, Mapping) else {})
    else:
        full_jobs = build_vtyt_jobs(processed, targets if isinstance(targets, Mapping) else {})
    plan_cache_path = os.path.join(os.path.dirname(os.path.abspath(processed_path)), "vtyt_input_plan_cache.json")
    previous_result = _read_json(plan_cache_path, {})
    force_full = bool(isinstance(targets, Mapping) and targets.get("forceFullVtyt")) or os.getenv("VTYT_FORCE_FULL_REINPUT", "").strip().lower() in ("1", "true", "yes", "y")
    if plan_only:
        jobs, noop_results = full_jobs, {}
    else:
        jobs, noop_results = _filter_incremental_jobs(full_jobs, previous_result if isinstance(previous_result, Mapping) else {}, force_full=force_full)
    full_plan_preview = [{k: v for k, v in job.items() if k != "supplies"} | {"supplies": job.get("supplies", [])} for job in full_jobs]
    plan_preview = [{k: v for k, v in job.items() if k != "supplies"} | {"supplies": job.get("supplies", [])} for job in jobs]
    if not full_jobs:
        _write_result(result_path, {}, "Không có kế hoạch VTYT phù hợp với BN/ngày đã chọn.", plan=[], full_plan=[])
        return 0
    if not jobs and noop_results:
        _write_result(result_path, noop_results, plan=[], full_plan=full_plan_preview)
        return 0
    if not jobs:
        _write_result(result_path, {}, "Không có VTYT mới cần nhập thêm.", plan=[], full_plan=full_plan_preview)
        return 0

    if plan_only:
        _log(f"[PLAN] Có {len(jobs)} BN/ngày cần quét thuốc/VTYT. Sẽ mở EMR để xem trước, chưa nhập.")
        config = load_config()
        results: Dict[str, Dict[str, Any]] = {}
        plan_jobs: List[Dict[str, Any]] = []
        exit_code = 0
        with open_session(result_path, config=config) as ws:
            for job in jobs:
                key = str(job.get("key") or f"{job.get('ma_bn')}::{job.get('ngay_lam')}")
                try:
                    planned = _preview_one_job(ws.driver, ws.wait, ws.config, job)
                    planned_rows = planned if isinstance(planned, list) else [planned]
                    planned_rows = [row for row in planned_rows if isinstance(row, Mapping)]
                    plan_jobs.extend(planned_rows)
                    results[key] = {
                        "success": True,
                        "preview": True,
                        "day_count": len(planned_rows),
                        "drug_count": sum(len(row.get('drugs') or []) for row in planned_rows),
                        "supply_count": sum(len(row.get('supplies') or []) for row in planned_rows),
                        "warning_count": sum(len(row.get('warnings') or []) for row in planned_rows),
                    }
                    ws.mark_success(key, preview=True, day_count=len(planned_rows))
                except Exception as e:
                    msg = str(e)
                    _log(f"[FAIL] {key}: {msg}")
                    ws.mark_failed(key, msg)
                    results[key] = {"success": False, "error": msg}
                    try:
                        debug_page(ws.driver, f"vtyt_preview_fail_{re.sub(r'[^0-9A-Za-z]+','_', key)}", log_func=_log)
                    except Exception:
                        pass
                    exit_code = 2
        # Ghi lại result đầy đủ với plan (override kết quả WorkerSession đã ghi)
        _write_result(result_path, results, plan=plan_jobs, full_plan=plan_jobs, mode="hchanh_vtyt_preview")
        return exit_code

    if dry_run:
        _log(f"[DRY-RUN] Có {len(jobs)} BN/ngày cần VTYT. Không mở EMR.")
        with open(result_path, "w", encoding="utf-8") as f:
            json.dump({"succeeded": [], "failed": {}, "mode": "patient_day_incremental", "skipped": {"reason": "Dry-run VTYT: chỉ tạo kế hoạch, chưa nhập EMR.", "patient_count": len(jobs)}, "plan": plan_preview, "full_plan": full_plan_preview}, f, ensure_ascii=False, indent=2)
        return 0

    config = load_config()
    results: Dict[str, Dict[str, Any]] = {}
    exit_code = 0
    with open_session(result_path, config=config) as ws:
        for job in jobs:
            key = str(job.get("key") or f"{job.get('ma_bn')}::{job.get('ngay_lam')}")
            try:
                results[key] = _input_one_job(ws.driver, ws.wait, ws.config, job)
                ws.results[key] = results[key]
            except Exception as e:
                msg = str(e)
                _log(f"[FAIL] {key}: {msg}")
                ws.mark_failed(key, msg)
                results[key] = {"success": False, "error": msg}
                try:
                    debug_page(ws.driver, f"vtyt_fail_{re.sub(r'[^0-9A-Za-z]+','_', key)}", log_func=_log)
                except Exception:
                    pass
                exit_code = 2
    if noop_results:
        results.update(noop_results)
    # Ghi lại result đầy đủ với plan
    _write_result(result_path, results, plan=plan_preview, full_plan=full_plan_preview)
    return exit_code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
