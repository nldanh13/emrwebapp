# -*- coding: utf-8 -*-
"""care_web_actions.py — thao tác popup/trạng thái phiếu chăm sóc trên EMR."""

import logging
import time

from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

from utils import handle_popups

LOG = logging.getLogger("cham_soc")

def check_trang_thai_badge(driver):
    try:
        xpath = "//span[@id='divStatusPopup']//i[contains(@class, 'badge')]"
        element = driver.find_element(By.XPATH, xpath)
        return element.text.strip()
    except Exception as _e:  # was: bare except
        LOG.debug(f"[except] {_e}")
        return ""


def _hien(driver, element_id):
    try:
        return bool(driver.find_element(By.ID, element_id).is_displayed())
    except Exception:
        return False


def bam_xac_nhan_cham_soc(driver):
    """Bấm nút xác nhận (id=submit_handle_ChamSoc) hiện ra sau Thu hồi/Hoàn tất, nếu có."""
    clicked = False
    try:
        btn = driver.find_element(By.ID, "submit_handle_ChamSoc")
        if btn.is_displayed():
            driver.execute_script("arguments[0].click();", btn)
            clicked = True
            time.sleep(1.0)
    except Exception as _e:
        LOG.debug(f"[except] {_e}")
    handle_popups(driver)
    return clicked


def mo_khoa_phieu_dang_mo(driver):
    """Phiếu chăm sóc đang mở: đã Hoàn tất thì Thu hồi. Trả True nếu tài khoản
    đang dùng sửa được phiếu (đã hết trạng thái Hoàn tất và có nút Lưu/Hoàn tất);
    False nếu EMR không cho (vd phiếu của tài khoản khác)."""
    if "Hoàn tất" in check_trang_thai_badge(driver):
        click_thu_hoi_cham_soc(driver)
        if "Hoàn tất" in check_trang_thai_badge(driver):
            return False
    return _hien(driver, "btnSaveChamSocPopupDraw") or _hien(driver, "btnPopupHOANTAT")


def click_thu_hoi_va_xoa(driver):
    """Thu hồi (nếu cần) rồi Xóa phiếu đang mở. Trả True nếu đã bấm được Xóa."""
    try:
        btn = WebDriverWait(driver, 1).until(EC.element_to_be_clickable((By.XPATH, "//button[contains(text(),'Thu hồi') or contains(@title,'Thu hồi')]")))
        driver.execute_script("arguments[0].click();", btn)
        time.sleep(1.5); handle_popups(driver)
        bam_xac_nhan_cham_soc(driver)
    except Exception as _e:
        LOG.debug(f"[except] {_e}")  # was: except: pass
    try:
        btn_xoa = driver.find_element(By.XPATH, "//button[contains(@id, 'Delete') or contains(text(), 'Xóa')]")
        if btn_xoa.is_displayed():
            driver.execute_script("arguments[0].click();", btn_xoa)
            time.sleep(1); handle_popups(driver)
            try: driver.find_element(By.CSS_SELECTOR, ".sweet-alert .confirm").click()
            except Exception as _e:
                LOG.debug(f"[except] {_e}")  # was: except: pass
            return True
    except Exception as _e:
        LOG.debug(f"[except] {_e}")  # was: except: pass
    return False


def click_thu_hoi_cham_soc(driver, timeout=5):
    """Chỉ bấm Thu hồi phiếu chăm sóc đã Hoàn tất để mở khóa form sửa.

    Không bấm Xóa. Dùng khi cần sửa tên điều dưỡng/người lập hoặc nội dung
    trên phiếu cũ rồi Hoàn tất lại, tránh tạo thêm dòng trùng giờ.
    """
    xpaths = [
        "//button[@id='btnPopupTHUHOI']",
        "//button[contains(normalize-space(.),'Thu hồi') or contains(@title,'Thu hồi')]",
        "//input[(contains(@value,'Thu hồi') or contains(@title,'Thu hồi')) and (@type='button' or @type='submit')]",
    ]
    last_err = None
    for xp in xpaths:
        try:
            btn = WebDriverWait(driver, timeout).until(EC.element_to_be_clickable((By.XPATH, xp)))
            try:
                driver.execute_script("arguments[0].scrollIntoView({block:'center'});", btn)
            except Exception:
                pass
            driver.execute_script("arguments[0].click();", btn)
            time.sleep(1.0)
            handle_popups(driver)
            bam_xac_nhan_cham_soc(driver)
            time.sleep(0.5)
            handle_popups(driver)
            return True
        except Exception as e:
            last_err = e
            continue
    LOG.debug(f"[click_thu_hoi_cham_soc] không thấy nút Thu hồi: {last_err}")
    return False
