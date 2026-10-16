# -*- coding: utf-8 -*-
"""Regression fixtures mirror EMR's shared medicine/supply table, without patient data."""
import pytest
from completed_order_reader import parse_order_popup, _compose_order_text


def _fixture():
    def line(group, name, strength, unit, count, status="Hoàn tất", comment=""):
        return (
            '<tr class="' + group + '" id="tdtest"><td></td><td></td>'
            '<td>1</td><td>Dự trù</td><td>' + name + comment + '</td>'
            '<td title="' + strength + '">' + strength + '</td>'
            '<td title="text-align:center;">' + unit + '</td>'
            '<td title=";">Tiêm</td><td>' + str(count) + '</td><td style="display:none;">0</td>'
            '<td>TTM 8 giờ</td><td>Bảo hiểm</td><td><span class="badge">' + status +
            '</span></td></tr>'
        )
    return (
        '<div id="divWebpartPopup"><span id="divStatusPopup"><i>Hoàn tất</i></span>'
        '<input id="txtThoigianThamKham" value="08:00 16/10/2026" data-value="05:00 17/10/2026">'
        '<select id="cboBacSiThamKham"><option selected>BS thử nghiệm</option></select>'
        '<textarea id="txtYLenhKhacThamKham">Theo dõi dấu hiệu sinh tồn</textarea>'
        '<table id="tblThuoc"><tbody>'
        '<tr><td colspan="14">Thuốc bác sĩ kê</td></tr>'
        + line("groupthuocbs", "Kháng sinh", "500 mg/2ml", "Ống", 2,
               "Chưa hoàn tất", '<i>Thuốc pha: Natri clorid 0,9%</i>')
        + line("groupthuocbs", "Natri clorid 0,9%", "0,9%, 100ml", "Túi", 1)
        + '<tr><td colspan="14">VTYT điều dưỡng kê</td></tr>'
        + line("groupthuocdd", "Bơm tiêm 10ml", "", "Cái", 2, "Hoàn tất",
               "<i>(Người bệnh tự trả)</i>")
        + line("groupthuocdd", "Dây truyền", "", "Bộ", 1)
        + '</tbody></table></div>'
    )


def test_mixed_table_keeps_drugs_and_nursing_supplies_separate():
    result = parse_order_popup(_fixture())
    assert result["so_thuoc"] == 2
    assert result["so_vat_tu_y_te"] == 2
    assert result["so_dong_thuoc_vtyt"] == 4
    drug = result["thuoc"][0]
    assert drug["ten_duoc"] == "Kháng sinh"
    assert drug["ham_luong"] == "500 mg/2ml"
    assert drug["don_vi"] == "Ống"  # ignore CSS in the title attribute
    assert drug["thuoc_pha"] == "Natri clorid 0,9%"
    assert drug["thanh_phan_pha"] == ["Natri clorid 0,9%"]
    assert drug["trang_thai_thuoc"] == "Chưa hoàn tất"
    assert result["thuoc"][1]["ten_duoc"] == "Natri clorid 0,9%"
    assert result["vat_tu_y_te"][0]["ten_vat_tu"] == "Bơm tiêm 10ml"
    assert result["vat_tu_y_te"][0]["nguoi_benh_tu_tra"] is True
    assert result["vat_tu_y_te"][1]["don_vi"] == "Bộ"
    assert "Dây truyền" in _compose_order_text(result)


def test_missing_medicine_table_fails_explicitly():
    with pytest.raises(ValueError, match="tblThuoc"):
        parse_order_popup('<span id="divStatusPopup">Hoàn tất</span>')


def test_non_completed_order_is_not_parsed():
    with pytest.raises(ValueError, match="Hoàn tất"):
        parse_order_popup(_fixture().replace(
            '<span id="divStatusPopup"><i>Hoàn tất</i></span>',
            '<span id="divStatusPopup"><i>Đang thực hiện</i></span>',
        ))


def test_group_header_prevents_misclassifying_medical_supplies_as_drugs():
    result = parse_order_popup(_fixture())
    assert all("ten_vat_tu" in item for item in result["vat_tu_y_te"])
    assert all("ten_duoc" in item for item in result["thuoc"])



def test_other_orders_keep_multiline_text_and_structured_service_orders():
    page = _fixture().replace(
        "<textarea id=\"txtYLenhKhacThamKham\">Theo dõi dấu hiệu sinh tồn</textarea>",
        '<textarea id="txtYLenhKhacThamKham">Mời chuyên khoa khám\n'
        'Thực hiện chỉ định đã cho</textarea>'
        '<textarea id="txtYLenhTheoDoiThamKham">Theo dõi mạch\n'
        'Theo dõi nhiệt độ</textarea>'
        '<div id="divYLenhKhoaPhongDtPhoiHops"><p>Khám phối hợp Nội tim mạch</p></div>'
        '<div id="divDichVu"><table><thead><tr><th>Tên dịch vụ</th><th>Trạng thái</th></tr></thead>'
        '<tbody><tr id="svc1"><td>Siêu âm</td><td>Đã chỉ định</td></tr></tbody></table></div>'
        '<div id="divDichVuXetNghiem"><p>Công thức máu</p></div>'
        '<div id="divTruyenMau"><p>Truyền khối hồng cầu</p></div>'
        '<div id="divXNTruyenMau"><p>Định nhóm máu</p></div>'
        '<div id="divDinhDuong_V2"><table><thead><tr><th>Bữa</th></tr></thead>'
        '<tbody><tr><td>Ăn sáng</td></tr></tbody></table></div>'
    )
    result = parse_order_popup(page)
    assert result["y_lenh_khac_muc"] == ["Mời chuyên khoa khám", "Thực hiện chỉ định đã cho"]
    assert result["y_lenh_theo_doi_muc"] == ["Theo dõi mạch", "Theo dõi nhiệt độ"]
    sections = result["chi_dinh_khac"]
    assert "Khám phối hợp Nội tim mạch" in sections["dieu_tri_phoi_hop"]["noi_dung"]
    assert sections["dich_vu_ky_thuat"]["bang"][0]["dong"][0]["gia_tri"] == ["Siêu âm", "Đã chỉ định"]
    assert "Công thức máu" in sections["xet_nghiem"]["noi_dung"]
    assert "Truyền khối hồng cầu" in sections["truyen_mau"]["noi_dung"]
    assert "Định nhóm máu" in sections["xet_nghiem_truyen_mau"]["noi_dung"]
    assert sections["dinh_duong_chi_tiet"]["bang"][0]["dong"][0]["gia_tri"] == ["Ăn sáng"]
    summary = _compose_order_text(result)
    assert "Mời chuyên khoa khám" in summary
    assert "Chỉ định DVKT:\nSiêu âm | Đã chỉ định" in summary
    assert "Chỉ định xét nghiệm:\nCông thức máu" in summary
    assert "Truyền khối hồng cầu" in summary
    assert result["so_thuoc"] == 2
    assert result["so_vat_tu_y_te"] == 2


def test_empty_order_sections_are_not_fabricated():
    page = _fixture().replace(
        '<table id="tblThuoc">',
        '<div id="divDichVu"></div><div id="divTruyenMau"></div>'
        '<div id="divDinhDuong_V2"><table><thead><tr><th>Giờ</th></tr></thead>'
        '<tbody></tbody></table><span>Năng lượng cung cấp: 0</span></div>'
        '<table id="tblThuoc">'
    )
    result = parse_order_popup(page)
    assert result["chi_dinh_khac"] == {}
    assert result["y_lenh_khac_muc"] == ["Theo dõi dấu hiệu sinh tồn"]
    assert "Chỉ định DVKT:" not in _compose_order_text(result)



def test_next_day_bridge_accepts_only_orders_before_0700():
    from completed_order_reader import _bridge_order_allowed

    assert _bridge_order_allowed("19/10/2026", "19/10/2026", "00:00")
    assert _bridge_order_allowed("19/10/2026", "19/10/2026", "06:59 19/10/2026")
    assert not _bridge_order_allowed("19/10/2026", "19/10/2026", "07:00")
    assert not _bridge_order_allowed("19/10/2026", "19/10/2026", "08:15")
    assert not _bridge_order_allowed("19/10/2026", "19/10/2026", "")
    assert not _bridge_order_allowed("19/10/2026", "19/10/2026", "không xác định")
    assert _bridge_order_allowed("18/10/2026", "19/10/2026", "23:30")
    assert _bridge_order_allowed("19/10/2026", None, "23:30")


def test_next_day_bridge_uses_fallback_hour_when_list_is_blank():
    from completed_order_reader import _bridge_order_allowed

    assert _bridge_order_allowed("19/10/2026", "19/10/2026", "", "05:00 19/10/2026")
    assert not _bridge_order_allowed("19/10/2026", "19/10/2026", "", "07:05 19/10/2026")
    # List-level time wins over popup fallback to prevent incorrect interpretation
    # of a scheduled-time field.
    assert not _bridge_order_allowed("19/10/2026", "19/10/2026", "12:00", "05:00")
