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


def test_catalog_product_metadata_never_overwrites_explicit_slow_iv(monkeypatch, tmp_path):
    import json
    from processing import medication_catalog as catalog
    catalog_file = tmp_path / "catalog.json"
    catalog_file.write_text(json.dumps({"medications": [{
        "canonical": "FAKE DUAL ROUTE DRUG",
        "category": "thuoc_tiem",
        "routes": ["TMC", "TTM"],
        "strength_text": "20mg/ống",
        "package_volume_ml": 2,
        "default_route": "TTM",
        "default_volume_ml": 100,  # Synthetic legacy infusion default.
        "reconstitution": {"volume_ml": 3},  # Different informational field.
    }]}), encoding="utf-8")
    monkeypatch.setattr(catalog, "MEDICATION_CATALOG_FILE", str(catalog_file))
    catalog.load_medication_catalog.cache_clear()
    try:
        source = {
            "ten_thuoc": "FAKE DUAL ROUTE DRUG",
            "duong_dung_goc": "TMC pha NaCl 0,9%",
            "the_tich": 2,
        }
        result, med = catalog.complete_medication_from_catalog(source)
        assert result == source and med is None
        assert "tui_dich_truyen_ml" not in result
        infusion, matched = catalog.complete_medication_from_catalog({
            "ten_thuoc": "FAKE DUAL ROUTE DRUG", "duong_dung_goc": "TTM",
        })
        assert matched is not None
        assert infusion["the_tich"] == 100
        assert infusion["the_tich"] != matched["package_volume_ml"]
        assert infusion["the_tich"] != matched["reconstitution"]["volume_ml"]
    finally:
        catalog.load_medication_catalog.cache_clear()
