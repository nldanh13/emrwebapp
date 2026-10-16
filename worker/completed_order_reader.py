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
            driver.execute_script("OnLoadChiTietLSYLenh(arguments[0]);", order_id)
            detail_id = "trchitiet" + order_id
            WebDriverWait(driver, 12).until(lambda d: bool(d.find_elements(By.ID, detail_id)))
            html = driver.find_element(By.ID, detail_id).get_attribute("outerHTML")
            detail = BeautifulSoup(html or "", "html.parser")
            order["chi_tiet_goc"] = detail.get_text("\n", strip=True)
            drug_table = detail.find("table", id="tblThuoc")
            if drug_table:
                order["thuoc_raw_rows"] = [
                    [td.get_text(" ", strip=True) for td in row.find_all("td")]
                    for row in drug_table.find_all("tr") if row.find_all("td")
                ]
            driver.execute_script("document.getElementById(arguments[0])?.remove();", detail_id)
        except Exception as err:
            print("LOG: Unable to read EMR order %s: %s" % (order_id, err))
            continue
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
