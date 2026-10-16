"""Read completed EMR doctor-order forms. No write actions are used."""
import re
from bs4 import BeautifulSoup
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait


def _form_value(soup, element_id):
    node = soup.find(id=element_id)
    if node is None:
        return ""
    if node.name == "select":
        selected = node.select("option[selected]")
        return "; ".join(option.get_text(" ", strip=True) for option in selected)
    if node.name in ("input", "textarea"):
        return node.get("value", "") if node.name == "input" else node.get_text("", strip=True)
    return node.get_text(" ", strip=True)


def parse_order_popup(html):
    """Parse one full doctor order popup; medicines and supplies share tblThuoc."""
    soup = BeautifulSoup(html or "", "html.parser")
    badge = soup.select_one("#divStatusPopup")
    if not badge or badge.get_text(" ", strip=True).casefold() != "hoàn tất":
        raise ValueError("Phiếu không có trạng thái Hoàn tất")

    result = {
        "thoi_gian_chi_dinh": _form_value(soup, "txtThoigianThamKham"),
        "thoi_gian_y_lenh_goc": (
            soup.find(id="txtThoigianThamKham") or {}
        ).get("data-value", ""),
        "thoi_gian_thuc_hien": _form_value(soup, "txtThoigianThucHienThamKham"),
        "bac_si_chi_dinh": _form_value(soup, "cboBacSiThamKham"),
        "dien_bien_benh": _form_value(soup, "txtDienBienYLenhThamKham"),
        "y_lenh_theo_doi": _form_value(soup, "txtYLenhTheoDoiThamKham"),
        "y_lenh_khac": _form_value(soup, "txtYLenhKhacThamKham"),
        "chan_doan": _form_value(soup, "txtChanDoanSoBoThamKham"),
        "benh_chinh": _form_value(soup, "cboBenhChinhThamKham"),
        "mo_ta_benh_chinh": _form_value(soup, "txtMoTaBenhChinhThamKham"),
        "benh_kem_theo": _form_value(soup, "cboBenhKemTheoThamKham"),
        "cap_do_cham_soc": _form_value(soup, "cboCapDoChamSocThamKham"),
        "muc_do_phu_thuoc_cham_soc": _form_value(soup, "cboMucDoPhuThuocChamSoc"),
        "dinh_duong": _form_value(soup, "cbbCheDoDinhDuongTK"),
    }

    table = soup.select_one("#tblThuoc")
    if table is None:
        raise ValueError("Thiếu bảng thuốc/VTYT #tblThuoc; không thể xác nhận đã lấy đủ phiếu")

    medications, supplies = [], []
    group = ""
    for row in table.select("tbody > tr"):
        cells = row.find_all("td", recursive=False)
        if len(cells) == 1 and cells[0].get("colspan"):
            group = cells[0].get_text(" ", strip=True)
            continue
        if len(cells) < 13:
            continue
        classes = set(row.get("class", []))
        label = group.casefold()
        is_supply = any(term in label for term in ("vtyt", "vật tư", "vat tu"))
        is_drug = "thuốc" in label and not is_supply
        # Không đoán VTYT từ đơn vị (ống, cái...), tránh nhầm thuốc và vật tư.
        if not (is_supply or is_drug):
            if "groupthuocbs" in classes:
                is_drug = True
            else:
                raise ValueError("Không phân loại được nhóm thuốc/VTYT của dòng %s" % row.get("id", ""))

        name_cell = cells[4]
        notes = [i.get_text(" ", strip=True) for i in name_cell.find_all("i")]
        # Những dòng in nghiêng là lời chú thích, không phải thành phần tên dược.
        name_soup = BeautifulSoup(str(name_cell), "html.parser")
        for italic in name_soup.find_all("i"):
            italic.decompose()
        name = name_soup.get_text(" ", strip=True)
        strength = cells[5].get("title", "").strip() or cells[5].get_text(" ", strip=True)
        mix_note = next((n.split(":", 1)[1].strip() for n in notes
                         if n.casefold().startswith("thuốc pha:")), "")
        payer_note = any("người bệnh tự trả" in n.casefold() for n in notes)
        base = {
            "id": row.get("id", ""), "nhom": group,
            "stt": cells[2].get_text(" ", strip=True),
            "loai_ke": cells[3].get_text(" ", strip=True),
            "ham_luong": strength,
            "don_vi": cells[6].get_text(" ", strip=True),
            "duong_dung": cells[7].get_text(" ", strip=True),
            "so_luong": cells[8].get_text(" ", strip=True),
            "so_luong_thua": cells[9].get_text(" ", strip=True),
            "cach_dung": cells[10].get_text(" ", strip=True),
            "doi_tuong": cells[11].get_text(" ", strip=True),
            "trang_thai": cells[12].get_text(" ", strip=True),
            "nguoi_benh_tu_tra": payer_note,
        }
        if is_supply:
            base["ten_vat_tu"] = name
            base["trang_thai_vat_tu"] = base["trang_thai"]
            supplies.append(base)
        else:
            base["ten_duoc"] = name
            base["trang_thai_thuoc"] = base["trang_thai"]
            base["thuoc_pha"] = mix_note
            base["thanh_phan_pha"] = [p.strip() for p in mix_note.split(" + ") if p.strip()] if mix_note else []
            medications.append(base)

    result["thuoc"] = medications
    result["vat_tu_y_te"] = supplies
    result["so_thuoc"] = len(medications)
    result["so_vat_tu_y_te"] = len(supplies)
    result["so_dong_thuoc_vtyt"] = len(medications) + len(supplies)
    result["y_lenh_khac_muc"] = _meaningful_lines(result["y_lenh_khac"])
    result["y_lenh_theo_doi_muc"] = _meaningful_lines(result["y_lenh_theo_doi"])
    result["chi_dinh_khac"] = _read_other_order_sections(soup)
    return result


def _meaningful_lines(value):
    """Preserve source wording while exposing individual lines for classification."""
    return [line.strip() for line in (value or "").splitlines() if line.strip()]


def _parse_order_section(soup, element_id):
    """Read a non-medication order section, retaining table rows and plain text.

    The EMR fills these containers dynamically. Headings alone are not orders.
    """
    panel = soup.find(id=element_id)
    if panel is None:
        return None
    tables = []
    for table in panel.find_all("table"):
        # Nested tables are unusual but should not duplicate the inner rows.
        if table.find_parent("table") is not None:
            continue
        headers = [th.get_text(" ", strip=True) for th in table.select("thead th")]
        rows = []
        for tr in table.select("tbody > tr"):
            cells = tr.find_all("td", recursive=False)
            if not cells:
                continue
            values = [td.get_text("\n", strip=True) for td in cells]
            if not any(values):
                continue
            rows.append({"id": tr.get("id", ""), "gia_tri": values})
        if rows:
            tables.append({"cot": headers, "dong": rows})
    # Also retain instructions rendered as paragraphs, links or list items outside tables.
    text_soup = BeautifulSoup(str(panel), "html.parser")
    for el in text_soup.select("table, script, style, button, select, input, textarea"):
        el.decompose()
    free_text = text_soup.get_text("\n", strip=True)
    if not tables and not free_text:
        return None
    return {"bang": tables, "noi_dung": free_text}


def _read_other_order_sections(soup):
    """Known EMR non-medication sections. Absent/empty sections are omitted."""
    result = {}
    for key, panel_id in (
        ("dieu_tri_phoi_hop", "divYLenhKhoaPhongDtPhoiHops"),
        ("dich_vu_ky_thuat", "divDichVu"),
        ("xet_nghiem", "divDichVuXetNghiem"),
        ("truyen_mau", "divTruyenMau"),
        ("xet_nghiem_truyen_mau", "divXNTruyenMau"),
        ("dinh_duong_chi_tiet", "divDinhDuong_V2"),
    ):
        value = _parse_order_section(soup, panel_id)
        # dinh_duong_V2 contains static totals and column headers without orders.
        if key == "dinh_duong_chi_tiet" and value and not value["bang"]:
            continue
        if value:
            result[key] = value
    return result


def _compose_order_text(order):
    """Keep a legible order text for the downstream legacy parser."""
    lines = []
    for label, value in (
        ("Y lệnh theo dõi", order.get("y_lenh_theo_doi")),
        ("Y lệnh khác", order.get("y_lenh_khac")),
    ):
        if value:
            lines.append(label + ": " + value)
    for key, label in (
        ("dieu_tri_phoi_hop", "Điều trị phối hợp"),
        ("dich_vu_ky_thuat", "Chỉ định DVKT"),
        ("xet_nghiem", "Chỉ định xét nghiệm"),
        ("truyen_mau", "Chỉ định truyền máu"),
        ("xet_nghiem_truyen_mau", "Xét nghiệm truyền máu"),
        ("dinh_duong_chi_tiet", "Chỉ định dinh dưỡng"),
    ):
        section = (order.get("chi_dinh_khac") or {}).get(key)
        if not section:
            continue
        records = []
        if section.get("noi_dung"):
            records.append(section["noi_dung"])
        for table in section.get("bang", []):
            for row in table.get("dong", []):
                records.append(" | ".join(str(x) for x in row.get("gia_tri", []) if str(x).strip()))
        if records:
            lines.append(label + ":")
            lines.extend(records)
    for section, rows, name_key in (
        ("+ Thuốc:", order.get("thuoc", []), "ten_duoc"),
        ("+ Vật tư y tế:", order.get("vat_tu_y_te", []), "ten_vat_tu"),
    ):
        if rows:
            lines.append(section)
        for item in rows:
            text = "{name} x {qty} ({unit})".format(
                name=item.get(name_key, ""),
                qty=item.get("so_luong", ""),
                unit=item.get("don_vi", ""),
            )
            if item.get("ham_luong"):
                text += " - " + item["ham_luong"]
            if item.get("thuoc_pha"):
                text += " | Thuốc pha: " + item["thuoc_pha"]
            if item.get("cach_dung"):
                text += " | " + item["cach_dung"]
            lines.append(text)
    return "\n".join(lines)


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
                "return !!(p && p.querySelector('#divBodyWebpartPopup #formYLenh') "
                "&& p.querySelector('#tblThuoc') && p.querySelector('#divStatusPopup'));"
            ))
            popup_html = driver.find_element(By.ID, "divWebpartPopup").get_attribute("outerHTML")
            detail = BeautifulSoup(popup_html or "", "html.parser")
            status = detail.select_one("#divStatusPopup")
            if not status or status.get_text(" ", strip=True).casefold() != "hoàn tất":
                raise RuntimeError("Trạng thái phiếu khác Hoàn tất")
            # Giữ đúng mã phiếu khi AJAX chậm; không dùng dữ liệu popup cũ.
            popup_soup = BeautifulSoup(popup_html or "", "html.parser")
            time_box = popup_soup.find(id="txtThoigianThamKham")
            onblur = (time_box.get("onblur", "") if time_box else "")
            if onblur and "CheckSuaThoiGianYLenh(" in onblur and order_id.lower() not in onblur.lower():
                raise RuntimeError("Popup không khớp mã phiếu " + order_id)
            parsed = parse_order_popup(popup_html)
            # Một số trường được EMR điền bằng jQuery .val() sau khi render.
            # outerHTML có thể còn rỗng; lấy giá trị DOM sống để không mất dữ liệu.
            live_values = driver.execute_script("""
                const pairs = {
                    thoi_gian_chi_dinh: 'txtThoigianThamKham',
                    thoi_gian_thuc_hien: 'txtThoigianThucHienThamKham',
                    dien_bien_benh: 'txtDienBienYLenhThamKham',
                    y_lenh_theo_doi: 'txtYLenhTheoDoiThamKham',
                    y_lenh_khac: 'txtYLenhKhacThamKham',
                    chan_doan: 'txtChanDoanSoBoThamKham',
                    mo_ta_benh_chinh: 'txtMoTaBenhChinhThamKham',
                    cap_do_cham_soc: 'cboCapDoChamSocThamKham',
                    muc_do_phu_thuoc_cham_soc: 'cboMucDoPhuThuocChamSoc',
                    dinh_duong: 'cbbCheDoDinhDuongTK'
                };
                const result = {};
                for (const [key, id] of Object.entries(pairs)) {
                    const el = document.getElementById(id);
                    if (el) {
                        if (el.tagName === 'SELECT') {
                            result[key] = Array.from(el.selectedOptions || [])
                                .map(opt => opt.textContent.trim()).filter(Boolean).join('; ');
                        } else {
                            result[key] = el.value || '';
                        }
                    }
                }
                return result;
            """)
            for key, value in (live_values or {}).items():
                if value:
                    parsed[key] = value
            order.update({k: v for k, v in parsed.items() if v not in ("", None)})
            # Recompute after live-DOM override, or from the historical list
            # when a popup textarea is empty. Preserve each original newline.
            order["y_lenh_khac_muc"] = _meaningful_lines(order.get("y_lenh_khac"))
            order["y_lenh_theo_doi_muc"] = _meaningful_lines(order.get("y_lenh_theo_doi"))
            print("LOG: Phiếu %s: %s thuốc; %s VTYT; %s mục Y lệnh khác; %s nhóm chỉ định khác" % (
                order["so_phieu"], order["so_thuoc"], order["so_vat_tu_y_te"],
                len(order["y_lenh_khac_muc"]), len(order.get("chi_dinh_khac") or {})
            ))
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
        content = _compose_order_text(order)
        if content:
            day["Y lệnh"] += ("\n" if day["Y lệnh"] else "") + content
        if order["dien_bien_benh"]:
            day["Diễn biến"] += ("\n" if day["Diễn biến"] else "") + order["dien_bien_benh"]
    print("LOG: Đọc được %s phiếu hoàn tất" % sum(len(d["order_history"]) for d in days.values()))
    return days
