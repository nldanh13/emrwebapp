# -*- coding: utf-8 -*-
import json
import os
import tempfile

from xu_ly import process_all
from processing.medication_catalog import lookup_medication_with_meta
from processing.medication_parser import parse_drug_name, update_drug_usage


def _run_order(order_text: str):
    records = [{
        "Mã BN": "TEST_SEMANTIC",
        "Họ tên": "BN TEST",
        "Bác sĩ": "BS TEST",
        "Vi_Tri": "P01",
        "ngay_lam": "03/05/2026",
        "Diễn biến": "",
        "Y lệnh": "08:00 | Bác sĩ: BS TEST\n+ Y lệnh khác:\n" + order_text,
    }]
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", encoding="utf-8", delete=False) as f:
        json.dump(records, f, ensure_ascii=False)
        in_path = f.name
    out_path = in_path.replace(".json", "_out.json")
    try:
        process_all(in_path, output_file=out_path)
        with open(out_path, encoding="utf-8") as f:
            return json.load(f)[0]
    finally:
        for path in (in_path, out_path):
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass


def test_lookup_typo_thermodon_matches_thermodol_catalog():
    med, meta = lookup_medication_with_meta("Thermodon 1g")
    assert med is not None
    assert med.get("canonical") == "THERMODOL"
    assert meta and meta.get("match_type") in ("exact", "semantic")


def test_tt_typo_thermodon_in_other_order_is_not_lost():
    r = _run_order("(TT) Thermodon 1g 01 chai x3 (TTM) 100g/p/8h")
    dt = r["thuoc"].get("dich_truyen", [])
    items = [d for d in dt if "THERMODON" in d.get("ten_thuoc", "").upper() or d.get("catalog_match") == "THERMODOL"]
    assert len(items) == 3
    assert [x.get("gio_dung") for x in items] == ["8 giờ", "16 giờ", "23 giờ"]
    assert all(x.get("tu_tuc") is True for x in items)
    assert all(str(x.get("toc_do")) == "100" for x in items)


def test_phonetic_paracetamol_1g_matches_catalog_schedule():
    r = _run_order("(TT) pa ra xê ta môn 1g 01 chai x3 (TTM) 100g/p/8h")
    dt = r["thuoc"].get("dich_truyen", [])
    items = [d for d in dt if d.get("catalog_match") == "THERMODOL"]
    assert len(items) == 3
    assert [x.get("gio_dung") for x in items] == ["8 giờ", "16 giờ", "23 giờ"]


def test_semantic_solvent_typo_nuoc_moi_is_treated_as_nacl():
    d = parse_drug_name("CEFOXITIN 1G x 1 (Lọ)")
    d = update_drug_usage(d, "Pha với nước mối 100ml, tiêm tĩnh mạch chậm 8 giờ", {})
    assert d.get("dung_moi") == "NACL_0.9"
    assert d.get("semantic_solvent_match") == "NACL"


def test_thermodol_ttm_ready_infusion_does_not_auto_add_nacl():
    r = _run_order("(TT) THERMODOL 01 chai x3 (TTM) 100g/p/8h")
    dt = r["thuoc"].get("dich_truyen", [])
    items = [d for d in dt if "THERMODOL" in (d.get("ten_thuoc") or "").upper()]
    assert len(items) == 3
    assert all(not x.get("dung_moi") for x in items)
    assert all("Natri clorid" not in (x.get("ten_hien_thi") or "") for x in items)


def test_thermodol_explicit_nacl_still_keeps_nacl():
    d = parse_drug_name("THERMODOL INJECTION x 1 (Ống)")
    d = update_drug_usage(d, "Pha với Natri clorid 0.9% 100ml, TTM 100g/p 8 giờ", {})
    assert d.get("dung_moi") == "NACL_0.9"
