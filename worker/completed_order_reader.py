"""Read completed EMR doctor-order forms. No write actions are used."""
import re
from bs4 import BeautifulSoup
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait


def read_completed_forms(driver, allowed_dates):
    driver.execute_script("""
        const count = document.getElementById('soLuongHienThi');
        const status = document.getElementById('trangthaiylenh');
        if (!count || !status || typeof loadListYLenh !== 'function') throw Error('Missing order filters');
        count.value = '1000';
        status.value = '1'; // EMR: Hoàn tất (order status, NOT drug status)
        loadListYLenh();
    """)
    WebDriverWait(driver, 20).until(lambda d: d.execute_script(
        "return document.getElementById('trangthaiylenh')?.value==='1' && document.getElementById('tbodyylenh') !== null;"
    ))
    tbody = BeautifulSoup(driver.page_source, "html.parser").find("tbody", id="tbodyylenh")
    if tbody is None:
        raise RuntimeError("No EMR completed-order list found")
    days = {}
    date = ""
    for tr in tbody.find_all("tr", recursive=False):
        key = tr.get("id", "")
        if not key.startswith("tr"):
            m = re.search(r"\d{2}/\d{2}/\d{4}", tr.get_text(" ", strip=True))
            if m:
                date = m.group()
            continue
        if date not in allowed_dates:
            continue
        cells = tr.find_all("td", recursive=False)
        order_id = key[2:]
        if len(cells) < 11 or not re.fullmatch(r"[0-9a-fA-F-]{36}", order_id):
            continue

        def text(index):
            return cells[index].get_text(" ", strip=True)

        def tooltip(index):
            a = cells[index].find(attrs={"data-content": True})
            return a.get("data-content", "") if a else text(index)

        order = {
            "id": order_id, "so_phieu": text(3), "gio_y_lenh": text(4),
            "bac_si": text(5), "dien_bien_benh": tooltip(6),
            "ket_qua_dich_vu": text(7), "y_lenh_khac": tooltip(8),
            "chi_dinh_cham_soc": text(9), "chi_dinh_dinh_duong": tooltip(10),
            "trang_thai_y_lenh": "Hoàn tất",
        }
        try:
            # Khác nút con mắt: bấm vào SỐ PHIẾU để mở trang y lệnh bác sĩ.
            # onDrawWebpartYLenh() hiển thị toàn bộ đơn thuốc và các chỉ định.
            driver.execute_script("onDrawWebpartYLenh(arguments[0]);", order_id)
            WebDriverWait(driver, 20).until(lambda d: d.execute_script(
                "const p=document.getElementById('divWebpartPopup');"
                "return !!(p && p.querySelector('#divBodyWebpartPopup #formYLenh'));"
            ))
            popup_html = driver.find_element(By.ID, "divWebpartPopup").get_attribute("outerHTML")
            detail = BeautifulSoup(popup_html or "", "html.parser")
            status = detail.select_one("#divStatusPopup")
            if not status or status.get_text(" ", strip=True).casefold() != "hoàn tất":
                raise RuntimeError("Trạng thái phiếu khác Hoàn tất")
            order["chi_tiet_goc"] = detail.get_text("\n", strip=True)
            def field(cid):
                el = detail.find(id=cid)
                if el is None:
                    return ""
                if el.name == "textarea":
                    return el.get_text(" ", strip=True)
                if el.name == "select":
                    selected = el.select("option[selected]")
                    return "; ".join(o.get_text(" ", strip=True) for o in selected)
                return el.get("value", "") if el.name == "input" else el.get_text(" ", strip=True)
            order["dien_bien_benh"] = field("txtDienBienYLenhThamKham") or order["dien_bien_benh"]
            order["y_lenh_theo_doi"] = field("txtYLenhTheoDoiThamKham")
            order["y_lenh_khac"] = field("txtYLenhKhacThamKham") or order["y_lenh_khac"]
            order["chan_doan"] = field("txtChanDoanSoBoThamKham")
            order["benh_chinh"] = field("cboBenhChinhThamKham")
            order["benh_kem_theo"] = field("cboBenhKemTheoThamKham")
            order["cap_do_cham_soc"] = field("cboCapDoChamSocThamKham")
            order["thoi_gian_thuc_hien"] = field("txtThoigianThucHienThamKham")

            def table_rows(table):
                result = []
                for tr_med in table.select("tbody tr"):
                    tds = tr_med.find_all("td", recursive=False)
                    if len(tds) < 5:
                        continue
                    values = [td.get("title", "").strip() or td.get_text(" ", strip=True) for td in tds]
                    result.append({"id": tr_med.get("id", ""), "cells": values})
                return result

            # BẢNG THUỐC BẮT BUỘC: đọc theo cột cụ thể, không phải toàn bộ text.
            drug_table = detail.find("table", id="tblThuoc")
            if drug_table is None:
                raise RuntimeError("Không thấy bảng thuốc #tblThuoc trong phiếu")
            medications = []
            for med in table_rows(drug_table):
                cells_med = med["cells"]
                if len(cells_med) < 13:
                    continue
                medications.append({
                    "id": med["id"], "stt": cells_med[2],
                    "loai_ke": cells_med[3], "ten_duoc": cells_med[4],
                    "ham_luong": cells_med[5], "don_vi": cells_med[6],
                    "duong_dung": cells_med[7], "so_luong": cells_med[8],
                    "cach_dung": cells_med[10], "doi_tuong": cells_med[11],
                    "trang_thai_thuoc": cells_med[12],
                })
            order["thuoc"] = medications
            order["so_thuoc"] = len(medications)

            # VTYT có thể được render ở table riêng hoặc trong panel riêng.
            # Giữ từng dòng cấu trúc, không lẫn thuốc vào vật tư.
            supplies = []
            for table in detail.find_all("table"):
                tid = str(table.get("id", "")).lower()
                panel = table.find_parent(id=True)
                parent_id = str(panel.get("id", "")).lower() if panel else ""
                if table is drug_table:
                    continue
                headings = " ".join(th.get_text(" ", strip=True) for th in table.select("th")).casefold()
                if any(key in (tid + " " + parent_id + " " + headings) for key in ("vtyt", "vật tư", "vat tu")):
                    supplies.extend(table_rows(table))
            order["vat_tu_y_te"] = supplies
            order["so_vat_tu_y_te"] = len(supplies)
            order["dinh_duong"] = field("cbbCheDoDinhDuongTK")
            print("LOG: Phiếu %s: %s thuốc; %s VTYT" % (order["so_phieu"], len(medications), len(supplies)))
        except Exception as err:
            print("LOG: Không đọc đủ phiếu %s (%s): %s" % (order["so_phieu"], order_id, err))
            continue
        finally:
            # Trở về lịch sử y lệnh trước khi mở phiếu tiếp theo.
            try:
                driver.execute_script("if(typeof fnCustomBack==='function') fnCustomBack();")
                WebDriverWait(driver, 12).until(lambda d: bool(d.find_elements(By.ID, "tbodyylenh")))
            except Exception:
                print("LOG: Không quay được lịch sử sau phiếu %s" % order_id)
                raise
        day = days.setdefault(date, {
            "Y lệnh": "", "Diễn biến": "", "Bác sĩ": "", "order_history": []
        })
        day["order_history"].append(order)
        day["Bác sĩ"] = day["Bác sĩ"] or order["bac_si"]
        content = order["y_lenh_khac"] or order.get("chi_tiet_goc", "")
        if content:
            day["Y lệnh"] += ("\n" if day["Y lệnh"] else "") + content
        if order["dien_bien_benh"]:
            day["Diễn biến"] += ("\n" if day["Diễn biến"] else "") + order["dien_bien_benh"]
    print("LOG: Đọc được %s phiếu hoàn tất" % sum(len(d["order_history"]) for d in days.values()))
    return days
