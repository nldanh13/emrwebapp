"""Khối "Tổng hợp chi phí" (div#divTongHopChiPhi) trên trang bảng kê được đọc đủ 16 ô."""
from bs4 import BeautifulSoup

from hchanh_fetch import parse_billing_summary, BILLING_SUMMARY_FIELDS


def _cell(label, value, link=False):
    inner = f'<a onclick="x();">{label}</a>' if link else label
    return (f'<div class="col-md-3"><div><label>{inner}</label>'
            f'<input class="form-control inputdisable" disabled="" type="text" value="{value}"></div></div>')


# Mẫu dựng theo cấu trúc HTML thật của EMR (số liệu giả, không có mã người bệnh).
HTML = (
    '<div id="divTongHopChiPhi"><div class="row form-group"><div class="col-md-12">'
    '<div class="row"><div class="col-md-6"><div class="row">'
    + _cell('Tổng chi phí', '26,117,752') + _cell('Chi phí BHYT', '18,269,470')
    + _cell('BH trả', '18,269,470') + _cell('Cùng chi trả', '0')
    + '</div></div><div class="col-md-6"><div class="row">'
    + _cell('Tự trả', '2,384,349') + _cell('Nguồn khác', '0')
    + _cell('Chênh lệch', '4,577,600') + _cell('Thực thu', '6,961,949')
    + '</div></div></div><div class="row"><div class="col-md-6"><div class="row">'
    + _cell('Tiền tạm ứng', '27,000,000', True) + _cell('Miễn giảm', '0', True)
    + _cell('Tiền quỹ trả', '0', True) + _cell('Thất thu', '0', True)
    + '</div></div><div class="col-md-6"><div class="row">'
    + _cell('Tiền hoàn trả', '27,000,000', True) + _cell('Biên lai thu', '6,961,949', True)
    + _cell('Ghi nợ', '0', True) + _cell('NB nhận lại', '0')
    + '</div></div></div></div></div></div>'
)


def test_reads_all_sixteen_fields():
    out = parse_billing_summary(BeautifulSoup(HTML, "html.parser"))
    assert set(out) == {k for k, _ in BILLING_SUMMARY_FIELDS}
    assert out["tong_chi_phi"] == 26117752
    assert out["chi_phi_bhyt"] == 18269470
    assert out["bh_tra"] == 18269470
    assert out["cung_chi_tra"] == 0
    assert out["tu_tra"] == 2384349
    assert out["nguon_khac"] == 0
    assert out["chenh_lech"] == 4577600
    assert out["thuc_thu"] == 6961949
    assert out["tien_tam_ung"] == 27000000
    assert out["mien_giam"] == 0
    assert out["tien_quy_tra"] == 0
    assert out["that_thu"] == 0
    assert out["tien_hoan_tra"] == 27000000
    assert out["bien_lai_thu"] == 6961949
    assert out["ghi_no"] == 0
    assert out["nb_nhan_lai"] == 0


def test_missing_block_returns_empty_not_zero():
    assert parse_billing_summary(BeautifulSoup("<div id='dsDichVu'><table></table></div>", "html.parser")) == {}


def test_missing_or_blank_cell_is_none():
    html = '<div id="divTongHopChiPhi">' + _cell('Tổng chi phí', '') + '</div>'
    out = parse_billing_summary(BeautifulSoup(html, "html.parser"))
    assert out["tong_chi_phi"] is None
    assert out["bh_tra"] is None
