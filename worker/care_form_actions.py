# -*- coding: utf-8 -*-
"""care_form_actions.py — điền form chăm sóc và chọn Select2 trong EMR."""

import logging
import random
import re
import time
import unicodedata

try:
    from selenium.webdriver.common.by import By
    from selenium.webdriver.common.keys import Keys
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
except ModuleNotFoundError:  # Cho phép import module khi chạy unit test không có Selenium.
    By = Keys = WebDriverWait = EC = None  # type: ignore

from input_care_utils import _canon_hhmm, _canon_time_key, _time_field_matches
from infusion_select2 import chon_select2_bac_si_y_ta
from utils import get_nurse_by_shift

LOG = logging.getLogger("cham_soc")
_LOG_CONTEXT = {"bn": "", "name": "", "date": ""}


def set_log_context(bn="", name="", date=""):
    """Cập nhật ngữ cảnh log cho các thao tác form chăm sóc."""
    _LOG_CONTEXT.update({
        "bn": str(bn or "").strip(),
        "name": str(name or "").strip(),
        "date": str(date or "").strip(),
    })


def _ctx_prefix():
    parts = []
    if _LOG_CONTEXT.get("bn"):
        parts.append(f"BN={_LOG_CONTEXT['bn']}")
    if _LOG_CONTEXT.get("name"):
        parts.append(f"NAME={_LOG_CONTEXT['name']}")
    if _LOG_CONTEXT.get("date"):
        parts.append(f"DATE={_LOG_CONTEXT['date']}")
    return "[" + " ".join(parts) + "] " if parts else ""


def set_thoi_gian_lap(driver, time_str, max_retry=2):
    """Điền txtThoiGianLap và xác nhận giá trị đã giữ đúng sau khi blur/change."""
    target = _canon_hhmm(time_str)
    if not target:
        return False

    for _ in range(max_retry):
        try:
            txt = WebDriverWait(driver, 10).until(
                EC.visibility_of_element_located((By.ID, "txtThoiGianLap"))
            )

            try:
                driver.execute_script("arguments[0].scrollIntoView({block:'center'});", txt)
            except Exception as _e:  # was: bare except
                LOG.debug(f"[except] {_e}")
                pass

            full_time = _canon_time_key(time_str)

            # Cách 1: set trực tiếp + trigger event
            try:
                driver.execute_script("arguments[0].value = arguments[1];", txt, full_time)
                driver.execute_script(
                    "$(arguments[0]).trigger('input').trigger('change').trigger('blur');", txt
                )
            except Exception as _e:  # was: bare except
                LOG.debug(f"[except] {_e}")
                pass

            time.sleep(0.3)
            try:
                current = (txt.get_attribute('value') or '').strip()
            except Exception as _e:  # was: bare except
                LOG.debug(f"[except] {_e}")
                current = ''
            if _time_field_matches(current, time_str):
                return True

            # Cách 2: clear + send_keys
            try:
                txt.click()
            except Exception as _e:  # was: bare except
                LOG.debug(f"[except] {_e}")
                pass
            try:
                txt.send_keys(Keys.CONTROL, 'a')
                txt.send_keys(Keys.DELETE)
            except Exception as _e:  # was: bare except
                LOG.debug(f"[except] {_e}")
                try:
                    txt.clear()
                except Exception as _e:  # was: bare except
                    LOG.debug(f"[except] {_e}")
                    pass
            txt.send_keys(full_time)
            txt.send_keys(Keys.TAB)
            time.sleep(0.5)

            try:
                current = (txt.get_attribute('value') or '').strip()
            except Exception as _e:  # was: bare except
                LOG.debug(f"[except] {_e}")
                current = ''
            if _time_field_matches(current, time_str):
                return True
        except Exception as e:
            LOG.debug(_ctx_prefix() + f"[set_thoi_gian_lap] retry_error={e}")
            time.sleep(0.3)

    try:
        txt = driver.find_element(By.ID, "txtThoiGianLap")
        final_val = (txt.get_attribute('value') or '').strip()
    except Exception as _e:  # was: bare except
        LOG.debug(f"[except] {_e}")
        final_val = ''
    LOG.warning(_ctx_prefix() + f"[set_thoi_gian_lap] failed target='{time_str}' final='{final_val}'")
    return False


def _chuan_hoa_ten(s: str) -> str:
    """Chuẩn hóa tên để so sánh: bỏ dấu, lower, strip khoảng trắng thừa."""
    import unicodedata
    s = str(s or "").strip().lower()
    s = re.sub(r"\s+", " ", s)
    # Bỏ dấu tiếng Việt
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return s


def _chon_nguoi_lap_select2(driver, target_text: str, timeout: int = 12) -> bool:
    """Chọn Người lập bằng cùng selector đã ổn định ở luồng dịch truyền.

    Mỗi lần retry gọi lại toàn bộ Select2 từ DOM mới. Điều này tránh giữ
    ``WebElement`` cũ sau khi HIS refresh modal, nguyên nhân chính của
    ``stale element reference`` trong log chăm sóc.
    """
    target_text = str(target_text or "").strip()
    if not target_text:
        return False

    for attempt in range(1, 4):
        try:
            # Sau khi đổi txtThoiGianLap, HIS có thể dựng lại một phần modal.
            # Chờ Select2 thật sự init rồi mới mở dropdown.
            WebDriverWait(driver, min(timeout, 8)).until(
                lambda d: bool(d.execute_script(
                    "var el=document.getElementById('cbbNguoiLap');"
                    "return !!(el && window.jQuery && $(el).data('select2'));"
                ))
            )
            time.sleep(0.15)

            if chon_select2_bac_si_y_ta(driver, "cbbNguoiLap", target_text, timeout=timeout):
                return True
        except Exception as exc:
            LOG.debug(_ctx_prefix() + f"[NguoiLap] retry={attempt} selector_error={exc}")

        # Đóng dropdown còn dở và lần sau tìm lại element từ đầu.
        try:
            driver.find_element(By.TAG_NAME, "body").send_keys(Keys.ESCAPE)
        except Exception:
            pass
        if attempt < 3:
            LOG.info(_ctx_prefix() + f"[NguoiLap] thử lại {attempt + 1}/3 cho '{target_text}'")
            time.sleep(0.35 * attempt)

    LOG.warning(_ctx_prefix() + f"[NguoiLap] Không chọn/verify được '{target_text}' sau 3 lần")
    return False

def dien_thong_tin(driver, gio, time_str, content, list_ten_dieu_duong, dien_bien_text="", needs_vitals=False, config_ten_goc=None):
    """Điền form chăm sóc; trả False nếu trường bắt buộc Người lập không hợp lệ.

    ``txtThoiGianLap`` đã được ``set_thoi_gian_lap`` xử lý và verify ngay trước
    hàm này. Không set/change lần hai vì HIS có thể refresh modal và làm stale
    các Select2 vừa sau đó.
    """
    # Luôn chọn người lập theo lịch đã cấu hình:
    # - giờ hành chính -> ca làm
    # - 11h-13h và 17h-07h -> ca trực
    # - 00h-06h59 tính theo lịch trực của ngày trước đó
    name_to_fill = ""
    try:
        name_to_fill = get_nurse_by_shift(time_str, config_ten_goc or {})
    except Exception as e:
        # fallback an toàn nếu utils trả list thiếu phần tử
        try:
            name_to_fill = (list_ten_dieu_duong or ["Lê Ngọc Diệu"])[0]
        except Exception:
            name_to_fill = "Lê Ngọc Diệu"
        print(f" [WARN get_nurse_by_shift: {e} -> fallback {name_to_fill}]", end="")

    # Người lập là trường bắt buộc. Không được tiếp tục lưu nếu không xác định
    # hoặc không chọn/verify được đúng điều dưỡng theo lịch.
    if not name_to_fill:
        LOG.error(_ctx_prefix() + "[NguoiLap] Không xác định được người lập theo lịch")
        return False

    _nurse_filled = _chon_nguoi_lap_select2(driver, name_to_fill)
    if not _nurse_filled:
        LOG.error(_ctx_prefix() + f"[NguoiLap] FAILED to set '{name_to_fill}'")
        return False

    if needs_vitals or gio in [5, 16]:
        try:
            nhip_tho = "20"; nhiet_do = "37"; mach = str(random.randint(75, 85))
            huyet_ap = random.choice(["120/80", "110/70", "130/80"])
            cac_truong = [("txtNhipTho", nhip_tho), ("txtNhietDo", nhiet_do), 
                          ("txtMachTrenlan", mach), ("txtHuyetAp", huyet_ap), ("txtHuyetApk", huyet_ap)]
            for id_o, gia_tri in cac_truong:
                try:
                    element = driver.find_element(By.ID, id_o)
                    if element.is_displayed():
                        driver.execute_script("arguments[0].click();", element)
                        element.clear(); element.send_keys(gia_tri); time.sleep(0.2); element.send_keys(Keys.TAB)
                        driver.execute_script("$(arguments[0]).trigger('input').trigger('change').trigger('blur');", element)
                except Exception as _e:
                    LOG.debug(f"[except] {_e}")  # was: except: pass
        except Exception as _e:
            LOG.debug(f"[except] {_e}")  # was: except: pass

    try:
        txt = driver.find_element(By.ID, "txtDienBien")
        txt.clear()
        # Fallback an toàn: không đẩy template thô (vd: __PAIN_LINE__) ra EMR.
        txt.send_keys(dien_bien_text or "Người bệnh tỉnh")
    except Exception as _e:
        LOG.debug(f"[except] {_e}")  # was: except: pass

    try:
        txt = driver.find_element(By.ID, "txtChamSoc"); txt.clear(); txt.send_keys(content)
    except Exception as _e:
        LOG.debug(f"[except] {_e}")  # was: except: pass

    try:
        driver.find_element(By.ID, "select2-cbbXuTri-container").click(); time.sleep(0.5)
        driver.switch_to.active_element.send_keys(Keys.ARROW_DOWN); time.sleep(0.1)
        driver.switch_to.active_element.send_keys(Keys.ENTER); time.sleep(1)
    except Exception as _e:
        LOG.debug(f"[except] {_e}")  # was: except: pass

    return True
