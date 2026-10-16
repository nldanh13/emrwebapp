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
