# -*- coding: utf-8 -*-
"""Bảo vệ y lệnh tiêm chậm khi thuốc cũng có quy tắc pha truyền."""
import pytest
from processing.diluent_resolver import infer_and_reclassify_diluents


@pytest.mark.parametrize("name,route", [
    ("NEFOPAM MEDISOL 20MG/2ML", "Tiêm tĩnh mạch chậm"),
    ("NEFOPAM MEDISOL 20MG/2ML", "TMC 8 giờ"),
    ("VANCOMYCIN 500mg", "Tiêm tĩnh mạch chậm"),
])
def test_explicit_slow_iv_never_becomes_infusion(name, route):
    drug = {"ten_thuoc": name, "duong_dung_goc": route,
            "dang": "Ống" if "NEFOPAM" in name else "Lọ",
            "gio_dung": "8 giờ", "so_luong": "1"}
    infusions, injections = infer_and_reclassify_diluents([], [drug])
    assert not infusions
    assert len(injections) == 1
    assert injections[0]["duong_dung_goc"] == route


def test_mixed_slow_injection_and_infusion_requires_confirmation():
    drug = {"ten_thuoc": "NEFOPAM MEDISOL 20MG/2ML",
            "duong_dung_goc": "Tiêm tĩnh mạch chậm, truyền tĩnh mạch",
            "gio_dung": "8 giờ", "so_luong": "1", "dang": "Ống"}
    infusions, injections = infer_and_reclassify_diluents([], [drug])
    assert not infusions
    assert len(injections) == 1
    assert injections[0].get("can_xac_nhan_duong_dung") is True


def test_explicit_infusion_still_supported():
    drug = {"ten_thuoc": "NEFOPAM MEDISOL 20MG/2ML",
            "duong_dung_goc": "TTM pha Natri clorid 0.9% 100ml",
            "gio_dung": "8 giờ", "so_luong": "1", "dang": "Ống"}
    infusions, injections = infer_and_reclassify_diluents([], [drug])
    assert not injections
    assert len(infusions) == 1
