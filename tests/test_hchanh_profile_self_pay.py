# -*- coding: utf-8 -*-
"""Đối tượng thanh toán trên trang con mắt điều dưỡng: "Bảo hiểm" không được bị coi là tự túc.

Lỗi cũ: so "bảo hiểm" (có dấu) với chuỗi đã bỏ dấu nên mọi người bệnh đều tu_tuc=True,
tiền giám định BHYT bỏ qua kiểm mã thẻ/hạn thẻ."""

import hchanh_fetch as hf


class _FakeSession:
    base_origin = "http://emr"

    def __init__(self, html):
        self._html = html

    def get_html(self, url):
        return self._html, url


def _profile_html(doi_tuong):
    return (
        "<html><body>"
        f"<span id='lblHoTen'>NGUYEN VAN A</span><span id='lblDoiTuong'>{doi_tuong}</span>"
        "<span id='lblSoThe'>HS4797912345678</span><span id='lblTuNgay'>01/01/2026</span>"
        "<span id='lblDenNgay'>31/12/2026</span><span id='lblNgayVaoVien'>03/09/2026</span>"
        "</body></html>"
    )


def _fetch(doi_tuong):
    sess = _FakeSession(_profile_html(doi_tuong))
    link_map = {"123": "http://emr/dieuduongdraw.aspx?id=1"}
    return hf.fetch_profile(sess, "123", {}, link_map, {})


def test_doi_tuong_bao_hiem_khong_phai_tu_tuc():
    assert _fetch("Bảo hiểm")["tu_tuc"] is False
    assert _fetch("Bảo hiểm y tế")["tu_tuc"] is False
    assert _fetch("BHYT")["tu_tuc"] is False


def test_doi_tuong_vien_phi_la_tu_tuc():
    assert _fetch("Viện phí")["tu_tuc"] is True


def test_chua_doc_duoc_doi_tuong_khong_coi_la_tu_tuc():
    assert hf._is_self_pay("") is False
    assert hf._is_self_pay(None) is False
