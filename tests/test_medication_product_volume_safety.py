# -*- coding: utf-8 -*-
"""Safety regression for ampoules (2 ml) and powdered-vial (0.5 g) drugs.

Only fake medication rows are used. No hospital EMR calls.
"""
from processing.diluent_resolver import infer_and_reclassify_diluents
from processing.medication_catalog import _has_explicit_non_infusion_route


def test_rapid_iv_injection_kept_even_if_nefopam_has_builtin_nacl_rule():
    row = {
        "ten_thuoc": "NEFOPAM MEDISOL 20MG/2ML",
        "dang": "Ống",
        "so_luong": "1",
        "gio_dung": "8 giờ",
        "duong_dung_goc": "Tiêm tĩnh mạch chậm (8 giờ)",
        "the_tich": 2,  # ampoule: must NEVER become an infusion bag
    }
    infusions, injections = infer_and_reclassify_diluents([], [row])
    assert not infusions
    assert len(injections) == 1
    assert injections[0]["the_tich"] == 2
    assert injections[0]["duong_dung_goc"] == row["duong_dung_goc"]


def test_nacl_reconstitution_does_not_convert_explicit_tmc_to_ttm():
    row = {
        "ten_thuoc": "NEFOPAM MEDISOL 20MG/2ML",
        "dang": "Ống",
        "gio_dung": "8 giờ",
        "duong_dung_goc": "TMC pha NaCl 0,9%",
    }
    infusions, injections = infer_and_reclassify_diluents([], [row])
    assert not infusions
    assert len(injections) == 1
    assert _has_explicit_non_infusion_route(row["duong_dung_goc"])


def test_powder_500mg_with_explicit_tmc_is_not_inferred_as_infusion():
    row = {
        "ten_thuoc": "MEROVIA 500MG",
        "dang": "Lọ bột",
        "ham_luong": "0,5 g",
        "so_luong": "1",
        "gio_dung": "8 giờ",
        "duong_dung_goc": "Tiêm tĩnh mạch chậm",
    }
    infusions, injections = infer_and_reclassify_diluents([], [row])
    assert not infusions
    assert len(injections) == 1
    assert not injections[0].get("tui_dich_truyen_ml")


def test_explicit_iv_infusion_is_still_recognized():
    row = {
        "ten_thuoc": "NEFOPAM MEDISOL 20MG/2ML",
        "dang": "Ống",
        "so_luong": "1",
        "gio_dung": "8 giờ",
        "duong_dung_goc": "Truyền tĩnh mạch pha Natri clorid 0,9%",
    }
    infusions, injections = infer_and_reclassify_diluents([], [row])
    assert not injections
    assert len(infusions) == 1
    assert infusions[0]["duong_dung"] == "TTM"


def test_incomplete_or_ambiguous_injection_route_keeps_manual_review():
    # Both TMC and TTM in one order are contradictory. Do not auto-convert.
    row = {
        "ten_thuoc": "NEFOPAM MEDISOL 20MG/2ML",
        "dang": "Ống",
        "duong_dung_goc": "TMC/TTM? cần xác nhận",
    }
    infusions, injections = infer_and_reclassify_diluents([], [row])
    assert not infusions
    assert len(injections) == 1
