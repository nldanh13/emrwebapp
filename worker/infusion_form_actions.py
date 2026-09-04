# -*- coding: utf-8 -*-
"""Form-filling helpers for infusion entry."""
import time
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

from utils import get_nurse_by_shift
from input_infusions_utils import LOG, _log
from infusion_cleanup import _int_from_text
from infusion_select2 import (
    chon_select2_bac_si_y_ta,
    nhap_thuoc_select2,
    nhap_thuoc_select2_va_lay_lo,
    xoa_sach_o_chon_thuoc,
    _drug_selection_committed,
    _clean_lot_value,
)

def _dismiss_any_alert_or_popup(driver, wait=None, timeout=1.2):
    """Đóng popup/alert nếu xuất hiện (JS alert hoặc SweetAlert). Trả về nội dung cảnh báo nếu đọc được."""
    msg = ""
    try:
        al = driver.switch_to.alert
        try:
            msg = (al.text or "").strip()
        except Exception:
            msg = ""
        al.accept()
        time.sleep(0.25)
        return True, msg
    except Exception:
        pass

    end_t = time.time() + max(0.2, timeout)
    while time.time() < end_t:
        try:
            swal = driver.find_element(By.CSS_SELECTOR, "div.sweet-alert")
            visible = (swal.value_of_css_property("display") != "none") and swal.is_displayed()
            if visible:
                try:
                    msg = (swal.find_element(By.CSS_SELECTOR, "p").text or "").strip()
                except Exception:
                    msg = ""
                try:
                    btn = swal.find_element(By.CSS_SELECTOR, "button.confirm")
                    driver.execute_script("arguments[0].click();", btn)
                except Exception:
                    try:
                        btn = driver.find_element(By.CSS_SELECTOR, "button.confirm")
                        btn.click()
                    except Exception:
                        pass
                time.sleep(0.35)
                return True, msg
        except Exception:
            pass
        time.sleep(0.1)
    return False, msg

def _set_input_value(driver, elem_or_id, value):
    """Set input robustly (JS + event) để tránh lỗi lần nhập đầu tiên không nhận giá trị."""
    elem = elem_or_id if hasattr(elem_or_id, 'tag_name') else driver.find_element(By.ID, elem_or_id)
    v = '' if value is None else str(value)
    try:
        driver.execute_script(
            "arguments[0].focus(); arguments[0].value=''; arguments[0].value=arguments[1];"
            "arguments[0].dispatchEvent(new Event('input', {bubbles:true}));"
            "arguments[0].dispatchEvent(new Event('change', {bubbles:true}));"
            "arguments[0].blur();",
            elem, v
        )
    except Exception:
        try:
            elem.send_keys(Keys.CONTROL + 'a')
            elem.send_keys(Keys.BACKSPACE)
        except Exception:
            pass
        elem.send_keys(v)
    return elem



def _unique_nonempty(values):
    out = []
    for v in values or []:
        v = str(v or '').strip()
        if v and v not in out:
            out.append(v)
    return out


def _diluent_lot_candidates(med):
    """Các tên có thể dùng để dò số lô dung môi khi thuốc pha với dịch."""
    dm = str(med.get('Dung_Moi') or med.get('dung_moi') or '').strip().upper()
    full_name = str(med.get('Full_Name') or '').strip().lower()
    cands = []
    if dm in {'SODIUM_0.9', 'NACL_0.9'} or 'sodium chloride' in full_name or 'natri clorid' in full_name:
        cands.extend([
            'Natri clorid 0,9%',
            'Natri clorid 0.9%',
            'Sodium chloride 0.9%',
            'SODIUM CHLORIDE 0.9%',
            'NaCl 0.9%',
        ])
    elif dm == 'NUOC_CAT' or 'nước cất' in full_name or 'nuoc cat' in full_name:
        cands.extend(['Nước cất pha tiêm', 'Nuoc cat pha tiem'])
    return _unique_nonempty(cands)


def _lot_search_candidates(med):
    """Tên ưu tiên để dò số lô: thuốc chính trước, dung môi sau."""
    primary = _unique_nonempty([
        med.get('Search_Name'),
        med.get('Ten_Thuoc_Goc'),
        med.get('ten_thuoc'),
        med.get('Full_Name'),
        med.get('Hoat_Chat'),
        med.get('hoat_chat'),
    ])
    # Với thuốc pha: Full_Name có dấu +, chỉ dùng phần trước dấu + làm tên thuốc chính.
    split_primary = []
    for x in primary:
        head = str(x).split('+')[0].strip()
        if head:
            split_primary.append(head)
    return _unique_nonempty(split_primary + primary), _diluent_lot_candidates(med)


def _resolve_and_fill_so_lo(driver, med, selected_info=None):
    """Lấy số lô từ Select2 và điền #txtSoLo nếu form có ô này.

    - Dịch truyền/thuốc không pha: dùng số lô của chính dòng đã chọn.
    - Thuốc pha với dung môi: nếu thuốc chính không có số lô, thử dò số lô dung môi.
    - Nếu không có số lô ở cả hai phía: để trống.
    """
    so_lo = ''
    opt = {}
    if isinstance(selected_info, dict):
        so_lo = _clean_lot_value(selected_info.get('so_lo'))
        opt = selected_info.get('option') or {}

    primary, diluents = _lot_search_candidates(med)
    main_query = (med.get('Search_Name') or (primary[0] if primary else '') or '').strip()

    # Nếu lần chọn thuốc đầu chưa đọc được số lô, chỉ ĐỌC lại option thuốc chính.
    # Không click/chọn lại để tránh làm thay đổi thuốc đang giữ trên form.
    if not so_lo and main_query:
        info = nhap_thuoc_select2_va_lay_lo(driver, main_query, extra_targets=primary, click_choice=False)
        if info.get('ok'):
            so_lo = _clean_lot_value(info.get('so_lo'))
            opt = info.get('option') or opt

    # Nếu có pha dung môi và thuốc chính không có số lô, dò thêm dung môi.
    # Chỉ đọc option dung môi, KHÔNG click dung môi vào cbbThuoc.
    if not so_lo and diluents:
        for q in diluents:
            info = nhap_thuoc_select2_va_lay_lo(driver, q, extra_targets=[q], click_choice=False)
            if info.get('ok') and _clean_lot_value(info.get('so_lo')):
                so_lo = _clean_lot_value(info.get('so_lo'))
                opt = info.get('option') or opt
                break
    try:
        driver.find_element(By.TAG_NAME, 'body').send_keys(Keys.ESCAPE)
    except Exception:
        pass

    try:
        _set_input_value(driver, 'txtSoLo', so_lo)
        if so_lo:
            ten = (opt.get('ten') or main_query or med.get('Full_Name') or '').strip()
            _log(f"      [+] Điền số lô dịch truyền: {so_lo} ({ten})")
        else:
            _log("      [i] Dịch truyền không có số lô trên Select2, để trống ô Số lô.")
    except Exception:
        # Một số form cũ có thể chưa có txtSoLo; không chặn luồng nhập.
        pass
    med['So_Lo'] = so_lo
    return so_lo

def _force_drug_required_fields(driver, full_name: str, search_name: str = ""):
    """Đồng bộ txtThuoc và xác nhận Select2 đã commit lựa chọn thật.

    Không tạo option giả. Với HIS AJAX, native ``cbbThuoc.value`` có thể rỗng
    dù Select2 data/container đã giữ đúng thuốc, nên dùng cùng validator với
    bước chọn dropdown.
    """
    name = (full_name or search_name or "").strip()
    if not name:
        return False
    try:
        _set_input_value(driver, 'txtThuoc', name)
    except Exception:
        pass
    try:
        try:
            driver.execute_script("if (typeof onblurNhapText === 'function') onblurNhapText();")
        except Exception:
            pass
        time.sleep(0.2)
        return _drug_selection_committed(driver, 'cbbThuoc', [search_name, full_name])
    except Exception as e:
        LOG.info(f"      [!] Không xác nhận được cbbThuoc/txtThuoc: {e}")
        return False

def _prepare_med_form_values(med):
    full_name = (med.get('Full_Name') or '').strip() or (med.get('Search_Name') or '').strip()
    vol = med.get('The_Tich', 0)
    try:
        vol_int = int(float(str(vol).replace(',', '.')))
    except Exception:
        vol_int = 0
    toc_do_raw = str(med.get('Toc_Do', '') or '').strip()
    # Chỉ dùng mặc định 30 khi thuốc là TTM và không có tốc độ rõ ràng
    # (tránh điền sai 30 cho thuốc tiêm chậm TMC không cần tốc độ giọt/phút)
    toc_do_num = _int_from_text(toc_do_raw, 0)
    if toc_do_num == 0 and toc_do_raw == '':
        toc_do_num = 0   # để trống — form sẽ báo cảnh báo nếu bắt buộc
    return {
        'full_name': full_name,
        'the_tich': vol_int,
        'toc_do': str(toc_do_num) if toc_do_num else '',
        'time_start': (med.get('Time_Start_Str') or '').strip(),
        'time_end': (med.get('Time_End_Str') or '').strip(),
    }

def _fill_form_dich_truyen_once(driver, med):
    vals = _prepare_med_form_values(med)

    # Modal thực tế có cả #cbbThuoc và #txtThuoc. Nếu chỉ điền txtThuoc,
    # HIS có thể báo "Chưa chọn thuốc", nên luôn ép cả hai trường.
    xoa_sach_o_chon_thuoc(driver)
    primary_targets, _diluent_targets = _lot_search_candidates(med)
    _drug_info = nhap_thuoc_select2_va_lay_lo(
        driver,
        med.get('Search_Name', ''),
        extra_targets=primary_targets,
        click_choice=True,
    )
    _drug_ok = bool(_drug_info.get('ok'))
    if not _drug_ok:
        # Fallback giữ hành vi cũ nếu helper đọc số lô không chọn được.
        _drug_ok = nhap_thuoc_select2(driver, med.get('Search_Name', ''))
    if not _drug_ok:
        LOG.info(f"      [!] Không chọn được thuốc/dịch truyền qua Select2: {med.get('Search_Name', '')}")
        raise RuntimeError(
            f"Không có lựa chọn thuốc thật trên Select2 cho: "
            f"{med.get('Search_Name') or med.get('Full_Name') or '?'}"
        )

    _resolve_and_fill_so_lo(driver, med, selected_info=_drug_info if isinstance(_drug_info, dict) else None)
    if not _force_drug_required_fields(driver, vals['full_name'], med.get('Search_Name', '')):
        raise RuntimeError("cbbThuoc mất value thật sau khi chọn thuốc")
    _set_input_value(driver, 'txtThuoc', vals['full_name'])
    try:
        _set_input_value(driver, 'txtSoLo', med.get('So_Lo', ''))
    except Exception:
        pass
    _set_input_value(driver, 'txtTheTich', vals['the_tich'] if vals['the_tich'] > 0 else '')
    _set_input_value(driver, 'txtTocDo', vals['toc_do'])
    if vals['time_start']:
        _set_input_value(driver, 'txtThoiGian', vals['time_start'])
    if vals['time_end']:
        _set_input_value(driver, 'txtThoiGianKetThucTD', vals['time_end'])

    try:
        driver.execute_script("if (typeof onblurNhapText === 'function') onblurNhapText();")
    except Exception:
        pass
    try:
        driver.execute_script("if (typeof onblurTinhTGKT === 'function') onblurTinhTGKT();")
    except Exception:
        pass

    return vals

def _nhap_moi_1_dich_truyen(driver, wait, med, config_names):
    str_start = (med.get('Time_Start_Str') or '').strip()
    ten_y_ta_chuan = get_nurse_by_shift(str_start, config_names)

    for attempt in range(1, 3):
        try:
            # Điền thuốc/dịch truyền trước để kích hoạt form.
            vals = _fill_form_dich_truyen_once(driver, med)
            time.sleep(0.3)

            # Chờ Select2 cbbBacSi sẵn sàng
            try:
                WebDriverWait(driver, 8).until(
                    EC.presence_of_element_located((By.ID, "select2-cbbBacSi-container"))
                )
                time.sleep(0.3)  # chờ Select2 init xong hoàn toàn
            except Exception:
                pass

            if med.get('Bac_Si'):
                bs_ok = chon_select2_bac_si_y_ta(driver, "cbbBacSi", med['Bac_Si'])
                if not bs_ok:
                    raise Exception(f"Không chọn được bác sĩ đúng tên: {med.get('Bac_Si')}")

            # Chờ cbbYTa sẵn sàng
            try:
                WebDriverWait(driver, 8).until(
                    EC.presence_of_element_located((By.ID, "select2-cbbYTa-container"))
                )
                time.sleep(0.2)
            except Exception:
                pass

            yta_ok = chon_select2_bac_si_y_ta(driver, "cbbYTa", ten_y_ta_chuan)
            if not yta_ok:
                raise Exception(f"Không chọn được điều dưỡng đúng tên: {ten_y_ta_chuan}")

            # Sau khi chọn nhân sự, ép lại thuốc + các ô bắt buộc phòng trường hợp UI tự refresh.
            if not _force_drug_required_fields(driver, vals['full_name'], med.get('Search_Name', '')):
                raise Exception("cbbThuoc không còn value thật trước khi lưu")
            _set_input_value(driver, 'txtThuoc', vals['full_name'])
            try:
                _set_input_value(driver, 'txtSoLo', med.get('So_Lo', ''))
            except Exception:
                pass
            _set_input_value(driver, 'txtTheTich', vals['the_tich'] if vals['the_tich'] > 0 else '')
            _set_input_value(driver, 'txtTocDo', vals['toc_do'])
            if vals['time_start']:
                _set_input_value(driver, 'txtThoiGian', vals['time_start'])
            if vals['time_end']:
                _set_input_value(driver, 'txtThoiGianKetThucTD', vals['time_end'])

            btn_them = wait.until(EC.presence_of_element_located((By.ID, 'btnThem')))
            try:
                btn_them.click()
            except Exception:
                driver.execute_script("arguments[0].click();", btn_them)
            time.sleep(0.9)

            had_popup, popup_msg = _dismiss_any_alert_or_popup(driver, wait, timeout=1.4)
            if had_popup:
                msg_l = (popup_msg or '').lower()
                if attempt == 1 and any(k in msg_l for k in ['chưa nhập', 'cảnh báo', 'thể tích', 'tốc độ', 'thời gian', 'tên dịch']):
                    vals = _fill_form_dich_truyen_once(driver, med)
                    if not vals.get('the_tich'):
                        _log(f"      [!] BỎ QUA: '{med.get('Full_Name','')}' thiếu thể tích/dữ liệu bắt buộc (popup: {popup_msg or 'Cảnh báo'}). [BS: {med.get('Bac_Si','?')} | DD: {ten_y_ta_chuan or '?'}]")
                        return False
                    try:
                        btn_them = driver.find_element(By.ID, 'btnThem')
                        try:
                            btn_them.click()
                        except Exception:
                            driver.execute_script("arguments[0].click();", btn_them)
                    except Exception:
                        pass
                    time.sleep(0.9)
                    had_popup2, popup_msg2 = _dismiss_any_alert_or_popup(driver, wait, timeout=1.2)
                    if had_popup2:
                        _log(f"      [!] BỎ QUA: '{med.get('Full_Name','')}' vẫn báo popup sau khi nhập lại: {popup_msg2 or popup_msg or 'Cảnh báo'}")
                        return False
                    return True

                if popup_msg:
                    _log(f"      [!] Popup khi nhập dịch truyền (đã bấm OK): {popup_msg}")
                return False

            return True
        except Exception as e:
            if attempt >= 2:
                _log(f"      [!] Lỗi nhập dịch truyền: {e}")
                return False
            time.sleep(0.5)
            _dismiss_any_alert_or_popup(driver, wait, timeout=0.8)

    return False
