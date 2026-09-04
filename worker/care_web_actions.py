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


def click_thu_hoi_va_xoa(driver):
    try:
        btn = WebDriverWait(driver, 1).until(EC.element_to_be_clickable((By.XPATH, "//button[contains(text(),'Thu hồi') or contains(@title,'Thu hồi')]")))
        driver.execute_script("arguments[0].click();", btn)
        time.sleep(1.5); handle_popups(driver)
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
    except Exception as _e:
        LOG.debug(f"[except] {_e}")  # was: except: pass


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
            time.sleep(0.5)
            handle_popups(driver)
            return True
        except Exception as e:
            last_err = e
            continue
    LOG.debug(f"[click_thu_hoi_cham_soc] không thấy nút Thu hồi: {last_err}")
    return False
