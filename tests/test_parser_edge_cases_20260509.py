# -*- coding: utf-8 -*-
"""Regression tests cho các ca thuốc (TT), TDD, hít/xịt và dạng 01X2."""
import json
import os
import tempfile

from xu_ly import process_all


def _run_order(order_text: str):
    records = [{
        "Mã BN": "TEST_EDGE_20260509",
        "Họ tên": "BN TEST",
        "Bác sĩ": "BS TEST",
        "Vi_Tri": "P01",
        "ngay_lam": "09/05/2026",
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


def test_double_open_tt_marker_vincynon_keeps_following_injection_usage():
    r = _run_order("((TT) Vincynon 02 ống\nTiêm mạch chậm 8h")
    item = next((d for d in r["thuoc"].get("thuoc_tiem", []) if "VINCYNON" in d.get("ten_thuoc", "").upper()), None)
    assert item is not None
    assert item.get("tu_tuc") is True
    assert item.get("duong_dung") == "TMC"
    assert item.get("gio_dung") == "8 giờ"
    assert not r.get("y_lenh_khac", {}).get("khac")


def test_self_paid_inhaler_split_two_lines_does_not_become_injection():
    r = _run_order("(TT) Seretide 25/250 ug\n02 nhát x2 (hít) sáng tối")
    hit_xit = r["thuoc"].get("thuoc_hit_xit", [])
    item = next((d for d in hit_xit if "SERETIDE" in d.get("ten_thuoc", "").upper()), None)
    assert item is not None
    assert item.get("tu_tuc") is True
    assert item.get("gio_dung") == "8 giờ, 20 giờ"
    assert not any("SERETIDE" in d.get("ten_thuoc", "").upper() for d in r["thuoc"].get("thuoc_tiem", []))
    assert not r.get("y_lenh_khac", {}).get("khac")


def test_self_paid_vancomycin_vial_waits_for_ttm_usage_and_uses_nacl_100ml():
    r = _run_order("(TT) Vancomycin 1 g 01 lọ\nTTM 8h")
    item = next((d for d in r["thuoc"].get("dich_truyen", []) if "VANCOMYCIN" in d.get("ten_thuoc", "").upper()), None)
    assert item is not None
    assert item.get("tu_tuc") is True
    assert item.get("duong_dung") == "TTM"
    assert item.get("gio_dung") == "8 giờ"
    assert float(item.get("the_tich") or 0) == 100.0
    assert item.get("dung_moi") in ("NACL_0.9", "SODIUM_0.9")
    assert not r.get("y_lenh_khac", {}).get("khac")


def test_self_paid_vancomycin_vial_without_usage_is_still_infusion_not_injection():
    r = _run_order("(TT) Vancomycin 1 g 01 lọ")
    item = next((d for d in r["thuoc"].get("dich_truyen", []) if "VANCOMYCIN" in d.get("ten_thuoc", "").upper()), None)
    assert item is not None
    assert item.get("duong_dung") == "TTM"
    assert float(item.get("the_tich") or 0) == 100.0
    assert not any("VANCOMYCIN" in d.get("ten_thuoc", "").upper() for d in r["thuoc"].get("thuoc_tiem", []))


def test_tdd_inline_route_is_subcutaneous_injection():
    r = _run_order("Gemapaxane 40mg/0.4ml 01 ống (TDD) 8h")
    item = next((d for d in r["thuoc"].get("thuoc_tiem", []) if "GEMAPAXANE" in d.get("ten_thuoc", "").upper()), None)
    assert item is not None
    assert item.get("duong_dung") == "TDD"
    assert item.get("gio_dung") == "8 giờ"


def test_oral_quantity_written_01x2_vien_is_parsed_as_name_and_quantity():
    r = _run_order("methylcobalamin 500mg 01X2 viên uống 8h 16h")
    item = next((d for d in r["thuoc"].get("thuoc_uong", []) if "METHYLCOBALAMIN" in d.get("ten_thuoc", "").upper()), None)
    assert item is not None
    assert item.get("ten_thuoc") == "methylcobalamin 500mg"
    assert item.get("so_luong") == "2"
    assert item.get("gio_dung") == "8 giờ, 16 giờ"


def test_self_paid_vancomycin_two_line_order_keeps_explicit_nacl_100ml():
    r = _run_order("(TT) Vancomycin 1g\n01 lọ x2 pha Natri clorid 0,9% 100ml (TTM) XXX g/p 8h - 20h\n+ Thuốc:\n+ Thuốc:\n(4) NATRI CLORID 0,9% (Natri clorid 0,9%) 0,9% 100ml x 2 (Túi)\nPha vancomycin.")
    items = [d for d in r["thuoc"].get("dich_truyen", []) if "VANCOMYCIN" in d.get("ten_thuoc", "").upper()]
    assert len(items) == 2
    assert {d.get("gio_dung") for d in items} == {"8 giờ", "20 giờ"}
    assert all(float(d.get("the_tich") or 0) == 100.0 for d in items)
    assert all(float(d.get("tui_dich_truyen_ml") or 0) == 100.0 for d in items)
    assert all(d.get("dung_moi") == "NACL_0.9" for d in items)


def test_vancomycin_following_pha_natriclorid_line_is_usage_not_fake_infusion_name():
    r = _run_order(
        "VANCOMYCIN (Vancomycin hydroclorid) 500mg x 4 (Lọ)\n"
        "Pha natriclorid 0.9% 100ml x2 TTM XXX g/ph(8 giờ, 20 giờ).\n"
        "NATRI CLORID 0,9% (Natri clorid) 0,9%, 100ml x 2 (Túi)\n"
        "Pha Vancomycin(8 giờ, 20 giờ)."
    )
    items = [d for d in r["thuoc"].get("dich_truyen", []) if "VANCOMYCIN" in d.get("ten_thuoc", "").upper()]
    assert len(items) == 2
    assert {d.get("gio_dung") for d in items} == {"8 giờ", "20 giờ"}
    assert all(float(d.get("the_tich") or 0) == 100.0 for d in items)
    assert all(d.get("dung_moi") in ("NACL_0.9", "SODIUM_0.9") for d in items)
    assert not any(str(d.get("ten_thuoc", "")).lower().startswith("pha natriclorid") for d in r["thuoc"].get("dich_truyen", []))
    assert not any("VANCOMYCIN" in str(d.get("ten_thuoc", "")).upper() for d in r.get("unparsed_orders", []))


def test_trasolu_brand_ttm_with_separate_nacl_line_uses_100ml_diluent():
    r = _run_order(
        "TRASOLU 100mg/2ml x Hai (Ống)\n"
        "TTM XXX g/ph mỗi ngày, sáng 1 ống, tối 1 ống(8 giờ, 20 giờ).\n"
        "NATRI CLORID 0,9% (Natri clorid) 0,9%, 100ml x 2 (Túi)\n"
        "pha tramadol."
    )
    items = [d for d in r["thuoc"].get("dich_truyen", []) if "TRASOLU" in d.get("ten_thuoc", "").upper()]
    assert len(items) == 2
    assert {d.get("gio_dung") for d in items} == {"8 giờ", "20 giờ"}
    assert all(float(d.get("the_tich") or 0) == 100.0 for d in items)
    assert all(float(d.get("tui_dich_truyen_ml") or 0) == 100.0 for d in items)
    assert all(d.get("dung_moi") == "NACL_0.9" for d in items)
    assert all("Natri clorid 0.9%" in d.get("ten_hien_thi", "") for d in items)


def test_trasolu_explicit_10h_20h_beats_following_nacl_8h_20h():
    r = _run_order(
        "TRASOLU 100mg/2ml x Hai (Ống)\n"
        "pha Nacl 0.9% 100ml x TTM XXXg/ph(10 giờ, 20 giờ).\n"
        "NATRI CLORID 0,9% (Natri clorid) 0,9%, 100ml x 2 (Túi)\n"
        "Pha Trasolu(8 giờ, 20 giờ)."
    )
    items = [d for d in r["thuoc"].get("dich_truyen", []) if "TRASOLU" in d.get("ten_thuoc", "").upper()]
    assert len(items) == 2
    assert {d.get("gio_dung") for d in items} == {"10 giờ", "20 giờ"}
    assert all(float(d.get("the_tich") or 0) == 100.0 for d in items)
