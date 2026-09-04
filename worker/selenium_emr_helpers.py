# -*- coding: utf-8 -*-
"""Helper Selenium dùng chung cho các luồng EMR.

Mục tiêu: gom các thao tác dễ flaky như build URL nội trú, quay lại danh sách,
chờ trang sẵn sàng, tìm BN. Các hàm này không chứa nghiệp vụ chăm sóc/dịch
truyền nên có thể tái sử dụng giữa input_care.py và input_infusions.py.
"""
from __future__ import annotations

import os
import re
import time
from datetime import datetime
from typing import Any, Callable, Optional
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

try:  # Selenium có thể chưa được cài trong một số môi trường test tĩnh.
    from selenium.webdriver.common.by import By
    from selenium.webdriver.common.keys import Keys
    from selenium.webdriver.support import expected_conditions as EC
    from selenium.webdriver.support.ui import WebDriverWait
except Exception:  # pragma: no cover - chỉ xảy ra khi thiếu selenium
    By = Keys = EC = WebDriverWait = None  # type: ignore

LogFn = Callable[[str], None]
LoginFn = Callable[[Any, Any, dict], Any]
DebugFn = Callable[[Any, str], None]


def _noop_log(message: str) -> None:
    print(message)


def build_inpatient_url(base_url: str, wpid: str) -> str:
    """Giữ nguyên query session hiện tại và thay/thêm tham số wpid."""
    p = urlparse(base_url or "")
    q = dict(parse_qsl(p.query, keep_blank_values=True))
    q["wpid"] = (wpid or "danhsachdieutrinoitrudraw").strip()
    return urlunparse((p.scheme, p.netloc, p.path, p.params, urlencode(q), p.fragment))


def wait_ready(driver: Any, timeout: int = 20) -> None:
    """Chờ document.readyState nhưng không fail cứng nếu browser không trả về."""
    if WebDriverWait is None:
        return
    try:
        WebDriverWait(driver, timeout).until(
            lambda d: d.execute_script("return document.readyState") in ("interactive", "complete")
        )
    except Exception:
        pass


def wait_after_action(driver: Any, seconds: float = 0.25, ready_timeout: int = 8) -> None:
    """Delay ngắn có kèm readyState, thay cho sleep rời rạc sau click/navigation."""
    if seconds and seconds > 0:
        time.sleep(seconds)
    wait_ready(driver, ready_timeout)


def debug_page(driver: Any, label: str = "debug", *, log_dir: Optional[str] = None, log_func: Optional[LogFn] = None) -> None:
    """Lưu HTML/screenshot khi Selenium không tìm được phần tử cần thiết."""
    log = log_func or _noop_log
    try:
        safe = re.sub(r"[^a-zA-Z0-9_.-]+", "_", str(label or "debug"))[:80]
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        folder = log_dir or os.path.join(os.getcwd(), "logs")
        os.makedirs(folder, exist_ok=True)
        html_path = os.path.join(folder, f"{safe}_{ts}.html")
        png_path = os.path.join(folder, f"{safe}_{ts}.png")
        with open(html_path, "w", encoding="utf-8", errors="ignore") as f:
            f.write(getattr(driver, "page_source", "") or "")
        try:
            driver.save_screenshot(png_path)
        except Exception:
            png_path = ""
        log(f"[DEBUG] Đã lưu trang lỗi: {html_path}" + (f" | {png_path}" if png_path else ""))
    except Exception as e:
        log(f"[DEBUG] Không lưu được trang lỗi {label}: {e}")


def safe_js_click(driver: Any, element: Any) -> None:
    """Click bằng JS sau khi scroll vào giữa màn hình."""
    driver.execute_script("arguments[0].scrollIntoView({block:'center'});", element)
    driver.execute_script("arguments[0].click();", element)




def _norm_status_text(raw: Any) -> str:
    """Chuẩn hoá text trạng thái để so khớp Đang thực hiện/Đi mổ."""
    import unicodedata
    text = str(raw or "").strip().lower()
    text = unicodedata.normalize("NFD", text)
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    text = text.replace("đ", "d")
    return re.sub(r"\s+", " ", text)


def set_inpatient_status_filter(driver: Any, wait: Any, status_text: str, *, log_func: Optional[LogFn] = None) -> bool:
    """Chọn filter trạng thái bệnh nhân trên danh sách nội trú.

    EMR dùng select2 cho #drpSelectTrangThai. Ưu tiên đổi trực tiếp native <select>,
    fallback qua UI select2 nếu cần.
    """
    if EC is None or By is None or Keys is None or WebDriverWait is None:
        return False
    log = log_func or _noop_log
    wanted = _norm_status_text(status_text)
    if not wanted:
        return False

    def _current_text() -> str:
        try:
            el = driver.find_element(By.ID, "select2-drpSelectTrangThai-container")
            return (el.get_attribute("title") or el.text or "").strip()
        except Exception:
            try:
                sel = driver.find_element(By.ID, "drpSelectTrangThai")
                return driver.execute_script("return arguments[0].options[arguments[0].selectedIndex]?.text || ''", sel) or ""
            except Exception:
                return ""

    if wanted in _norm_status_text(_current_text()):
        return True

    # 1) Native select hidden behind select2.
    try:
        sel = driver.find_element(By.ID, "drpSelectTrangThai")
        ok = driver.execute_script(
            """
            const sel = arguments[0];
            const wanted = arguments[1];
            function norm(s) {
              return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g,'d').replace(/Đ/g,'D').toLowerCase().replace(/\\s+/g,' ').trim();
            }
            const target = norm(wanted);
            let found = false;
            for (const opt of Array.from(sel.options || [])) {
              if (norm(opt.text).includes(target) || target.includes(norm(opt.text))) {
                sel.value = opt.value;
                found = true;
                break;
              }
            }
            if (found) {
              if (window.jQuery) {
                window.jQuery(sel).trigger('change');
              } else {
                sel.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }
            return found;
            """,
            sel,
            status_text,
        )
        if ok:
            wait_after_action(driver, 0.6, ready_timeout=8)
            return True
    except Exception:
        pass

    # 2) Fallback UI select2.
    try:
        container = WebDriverWait(driver, 6).until(
            EC.element_to_be_clickable((By.ID, "select2-drpSelectTrangThai-container"))
        )
        safe_js_click(driver, container)
        inp = WebDriverWait(driver, 6).until(
            EC.element_to_be_clickable((By.CSS_SELECTOR, "input.select2-search__field"))
        )
        inp.send_keys(Keys.CONTROL, "a")
        inp.send_keys(status_text)
        wait_after_action(driver, 0.3, ready_timeout=4)
        # Ưu tiên đúng option, rồi Enter.
        try:
            opts = driver.find_elements(By.CSS_SELECTOR, ".select2-results__option")
            for opt in opts:
                if wanted in _norm_status_text(opt.text):
                    safe_js_click(driver, opt)
                    wait_after_action(driver, 0.6, ready_timeout=8)
                    return True
        except Exception:
            pass
        inp.send_keys(Keys.ENTER)
        wait_after_action(driver, 0.6, ready_timeout=8)
        return wanted in _norm_status_text(_current_text())
    except Exception as e:
        log(f"[WARN] Không chọn được trạng thái '{status_text}': {e}")
        return False


def patient_row_exists(driver: Any, ma_bn: Any) -> bool:
    """True nếu bảng nội trú hiện tại có dòng chứa mã BN."""
    if By is None:
        return False
    code = str(ma_bn or "").strip()
    if not code:
        return False
    xpaths = [
        f"//table[@id='tblNoiTru']//tbody//tr[.//*[contains(normalize-space(), '{code}')]]",
        f"//table[contains(@id,'NoiTru')]//tr[.//*[contains(normalize-space(), '{code}')]]",
        f"//tr[.//*[contains(normalize-space(), '{code}')]]",
    ]
    for xp in xpaths:
        try:
            if driver.find_elements(By.XPATH, xp):
                return True
        except Exception:
            continue
    return False



def _norm_for_match(raw: Any) -> str:
    """Chuẩn hóa tiếng Việt để so khớp label select2."""
    import unicodedata
    text = str(raw or "").strip().lower()
    text = unicodedata.normalize("NFD", text)
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    text = text.replace("đ", "d")
    return re.sub(r"\s+", " ", text)


def _date_to_dmy_for_filter(value: Any) -> str:
    """Nhận yyyy-mm-dd / dd/mm/yyyy / chuỗi có giờ → trả dd/mm/yyyy."""
    raw = str(value or "").strip()
    if not raw:
        return ""
    m = re.search(r"(\d{4})-(\d{1,2})-(\d{1,2})", raw)
    if m:
        y, mo, d = m.groups()
        return f"{int(d):02d}/{int(mo):02d}/{int(y):04d}"
    m = re.search(r"(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})", raw)
    if m:
        d, mo, y = m.groups()
        y = int(y)
        if y < 100:
            y += 2000
        return f"{int(d):02d}/{int(mo):02d}/{int(y):04d}"
    return raw


def set_time_range_filter(
    driver: Any,
    wait: Any = None,
    date_from: Any = "",
    date_to: Any = "",
    *,
    log_func: Optional[LogFn] = None,
) -> bool:
    """Ép bộ lọc thời gian của danh sách nội trú sang 'Khoảng' và đặt từ/ngày đến.

    EMR hay tự để #cbbLoai = '3 tháng'. Nếu chỉ nhập #dtTuNgay/#dtDenNgay mà
    chưa đổi #cbbLoai sang 'Khoảng' thì tìm kiếm vẫn bị giới hạn 3 tháng. Hàm này
    được dùng cho các luồng hành chánh/y lệnh tìm BN bằng Selenium.
    """
    log = log_func or _noop_log
    tu = _date_to_dmy_for_filter(date_from)
    den = _date_to_dmy_for_filter(date_to) or tu
    if not tu and not den:
        return False
    if not tu:
        tu = den

    try:
        ok = driver.execute_script(
            r"""
            const tu = arguments[0] || '';
            const den = arguments[1] || tu;
            function norm(s) {
              try { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g,'d').replace(/Đ/g,'D').toLowerCase().replace(/\s+/g,' ').trim(); }
              catch(e) { return String(s || '').toLowerCase(); }
            }
            function nativeSet(el, val) {
              if (!el) return false;
              try {
                const proto = Object.getPrototypeOf(el);
                const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
                if (desc && desc.set) desc.set.call(el, val); else el.value = val;
              } catch(e) { el.value = val; }
              el.setAttribute('value', val);
              try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch(e) {}
              try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch(e) {}
              try { if (window.jQuery) window.jQuery(el).val(val).trigger('input').trigger('change').trigger('dp.change'); } catch(e) {}
              return true;
            }
            function chooseRangeSelect() {
              const sel = document.getElementById('cbbLoai');
              if (!sel) return false;
              let target = null;
              const opts = Array.from(sel.options || []);
              for (const opt of opts) {
                const txt = norm(opt.textContent || opt.innerText || '');
                const val = String(opt.value || '').trim();
                if (txt.includes('khoang') || txt.includes('tu ngay') || txt.includes('den ngay') || val === '7') {
                  target = opt;
                  break;
                }
              }
              if (!target && opts.length) target = opts.find(o => String(o.value || '').trim() === '7') || null;
              if (!target) return false;
              sel.value = target.value;
              target.selected = true;
              try { sel.dispatchEvent(new Event('change', { bubbles: true })); } catch(e) {}
              try { if (window.jQuery) window.jQuery(sel).val(target.value).trigger('change').trigger('change.select2'); } catch(e) {}
              try { if (typeof FilterChange === 'function') FilterChange(); } catch(e) {}
              const c = document.getElementById('select2-cbbLoai-container');
              if (c) {
                const label = target.textContent || target.innerText || 'Khoảng';
                c.setAttribute('title', label);
                c.textContent = label;
              }
              return true;
            }
            const chose = chooseRangeSelect();
            const box = document.getElementById('data_5');
            if (box) {
              box.style.display = 'block';
              box.style.visibility = 'visible';
            }
            const f = document.getElementById('dtTuNgay');
            const t = document.getElementById('dtDenNgay');
            const okF = nativeSet(f, '00:00 ' + tu);
            const okT = nativeSet(t, '23:59 ' + den);
            return { chose, okF, okT, mode: (document.getElementById('select2-cbbLoai-container') || {}).textContent || '' };
            """,
            tu,
            den,
        ) or {}
        wait_after_action(driver, 0.35, ready_timeout=6)
        if ok.get('okF') or ok.get('okT') or ok.get('chose'):
            mode = str(ok.get('mode') or '').strip()
            log(f"[DATE_RANGE] Đã đặt Khoảng: {tu} → {den}" + (f" | mode={mode}" if mode else ""))
            return True
    except Exception as e:
        log(f"[WARN] Không đặt được bộ lọc Khoảng ngày: {e}")
    return False

def search_patient_on_ward_or_raise(
    driver: Any,
    wait: Any,
    config: dict,
    ma_bn: Any,
    *,
    login_func: Optional[LoginFn] = None,
    log_func: Optional[LogFn] = None,
    debug_func: Optional[DebugFn] = None,
    allow_completed: bool = False,
) -> str:
    """Tìm BN trên danh sách nội trú theo trạng thái phù hợp.

    Mặc định chỉ chấp nhận BN còn ở khoa (Đang thực hiện). Khi allow_completed=True
    sẽ tìm thêm trạng thái Hoàn tất để xử lý các phiếu/cữ thuốc trước mốc ra viện.
    Nếu BN nằm ở trạng thái Đi mổ hoặc không tìm thấy ở các trạng thái hợp lệ, raise
    RuntimeError để luồng nhập tại khoa bỏ qua hoặc báo lỗi rõ ràng.
    """
    log = log_func or _noop_log
    code = str(ma_bn or "").strip()
    if not code:
        raise RuntimeError("Thiếu mã bệnh nhân")

    statuses = ["Đang thực hiện"]
    if allow_completed:
        statuses.append("Hoàn tất")
    statuses.append("Đi mổ")

    checked = []
    for status_name in statuses:
        checked.append(status_name)
        set_inpatient_status_filter(driver, wait, status_name, log_func=log)
        search_patient(driver, wait, config, code, login_func=login_func, log_func=log, debug_func=debug_func)
        if patient_row_exists(driver, code):
            if status_name == "Đi mổ":
                raise RuntimeError("Người bệnh đang ở trạng thái Đi mổ; không thực hiện chăm sóc/truyền dịch tại khoa.")
            if status_name == "Hoàn tất":
                log(f"[WARD_STATUS] Thấy BN {code} ở 'Hoàn tất' → cho phép xử lý ngày ra viện.")
            return status_name
        if status_name == "Đang thực hiện":
            next_text = "Hoàn tất/Đi mổ" if allow_completed else "Đi mổ"
            log(f"[WARD_STATUS] Không thấy BN {code} ở 'Đang thực hiện' → kiểm tra '{next_text}'.")

    # Trả lại filter chính để lần sau không bị kẹt ở Hoàn tất/Đi mổ.
    set_inpatient_status_filter(driver, wait, "Đang thực hiện", log_func=log)
    checked_text = "/".join(checked)
    raise RuntimeError(f"Không thấy người bệnh ở {checked_text}; có thể đã chuyển khoa/không còn ở khoa hiện tại.")


def _is_login_url(driver: Any) -> bool:
    return "login.aspx" in ((getattr(driver, "current_url", "") or "").lower())


def goto_inpatient_list(
    driver: Any,
    wait: Any,
    config: dict,
    *,
    login_func: Optional[LoginFn] = None,
    log_func: Optional[LogFn] = None,
    debug_func: Optional[DebugFn] = None,
    ready_timeout: int = 20,
    search_timeout: int = 12,
) -> str:
    """Đi thẳng về danh sách nội trú, giữ session URL sau đăng nhập.

    Tránh dùng driver.back() vì history stack trong EMR dễ lệch khi có modal,
    popup hoặc redirect ngầm.
    """
    if EC is None or By is None:
        raise RuntimeError("Selenium chưa được cài hoặc không import được")

    log = log_func or _noop_log
    wpid = (config.get("inpatient_wpid") or "danhsachdieutrinoitrudraw").strip()
    current = (getattr(driver, "current_url", "") or "").strip()
    current_l = current.lower()

    if "home.aspx" in current_l and "usid=" in current_l:
        nav_url = build_inpatient_url(current, wpid)
    else:
        nav_url = (config.get("url_inpatient_list") or "").strip()
        if not nav_url:
            nav_url = build_inpatient_url(current, wpid)

    log(f"[NAV] Vào danh sách nội trú: {nav_url}")
    driver.get(nav_url)
    wait_ready(driver, ready_timeout)

    if _is_login_url(driver):
        if not login_func:
            raise RuntimeError("EMR trả về login.aspx nhưng không có login_func để đăng nhập lại")
        log("[NAV] EMR trả về login.aspx khi mở danh sách. Đăng nhập lại và giữ session mới...")
        login_func(driver, wait, config)
        current = (getattr(driver, "current_url", "") or "").strip()
        if "home.aspx" in current.lower() and "usid=" in current.lower():
            nav_url = build_inpatient_url(current, wpid)
            log(f"[NAV] Vào lại danh sách nội trú bằng session mới: {nav_url}")
            driver.get(nav_url)
            wait_ready(driver, ready_timeout)

    try:
        wait.until(EC.presence_of_element_located((By.ID, "txtTimKiem")))
    except Exception as first_error:
        wait_after_action(driver, 1.0, ready_timeout=ready_timeout)
        try:
            WebDriverWait(driver, search_timeout).until(EC.presence_of_element_located((By.ID, "txtTimKiem")))
        except Exception:
            if debug_func:
                debug_func(driver, "khong_thay_txtTimKiem")
            else:
                debug_page(driver, "khong_thay_txtTimKiem", log_func=log)
            raise first_error

    return nav_url


def ensure_inpatient_list(
    driver: Any,
    wait: Any,
    config: dict,
    *,
    login_func: Optional[LoginFn] = None,
    log_func: Optional[LogFn] = None,
    debug_func: Optional[DebugFn] = None,
) -> None:
    """Đảm bảo đang ở trang danh sách nội trú."""
    if EC is None or By is None or WebDriverWait is None:
        raise RuntimeError("Selenium chưa được cài hoặc không import được")
    try:
        driver.find_element(By.ID, "txtTimKiem")
        return
    except Exception:
        pass

    cur = (getattr(driver, "current_url", "") or "").lower()
    wpid = (config.get("inpatient_wpid") or "danhsachdieutrinoitrudraw").strip().lower()
    if wpid in cur:
        try:
            WebDriverWait(driver, 4).until(EC.presence_of_element_located((By.ID, "txtTimKiem")))
            return
        except Exception:
            pass

    goto_inpatient_list(
        driver, wait, config,
        login_func=login_func,
        log_func=log_func,
        debug_func=debug_func,
    )


def search_patient(
    driver: Any,
    wait: Any,
    config: dict,
    ma_bn: Any,
    *,
    login_func: Optional[LoginFn] = None,
    log_func: Optional[LogFn] = None,
    debug_func: Optional[DebugFn] = None,
    attempts: int = 2,
    after_enter_seconds: float = 1.2,
) -> None:
    """Tìm bệnh nhân trong danh sách nội trú bằng ô txtTimKiem."""
    if EC is None or By is None or Keys is None:
        raise RuntimeError("Selenium chưa được cài hoặc không import được")
    ensure_inpatient_list(
        driver, wait, config,
        login_func=login_func,
        log_func=log_func,
        debug_func=debug_func,
    )
    last_err: Optional[Exception] = None
    for _ in range(max(1, attempts)):
        try:
            search = wait.until(EC.element_to_be_clickable((By.ID, "txtTimKiem")))
            try:
                search.clear()
            except Exception:
                driver.execute_script("arguments[0].value='';", search)
            search.send_keys(str(ma_bn or ""))
            wait_after_action(driver, 0.25, ready_timeout=4)
            search.send_keys(Keys.ENTER)
            wait_after_action(driver, after_enter_seconds, ready_timeout=8)
            return
        except Exception as e:
            last_err = e
            goto_inpatient_list(
                driver, wait, config,
                login_func=login_func,
                log_func=log_func,
                debug_func=debug_func,
            )
    raise last_err or RuntimeError("Không tìm thấy ô txtTimKiem")
