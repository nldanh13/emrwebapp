# -*- coding: utf-8 -*-
"""Regression tests cho các cách gõ y lệnh dễ làm mất thuốc/lịch/dung môi."""
import json
import os
import tempfile

from xu_ly import process_all
from xu_ly_config import parse_hours_from_gio_dung


def _run_order(order_text: str):
    records = [{
        "Mã BN": "TEST_EDGE",
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


def _all_meds(record):
    thuoc = record.get("thuoc", {})
    return (
        thuoc.get("dich_truyen", [])
        + thuoc.get("thuoc_tiem", [])
        + thuoc.get("thuoc_uong", [])
        + thuoc.get("khac", [])
    )


def test_tt_drug_in_other_order_is_parsed_not_lost_or_duplicated():
    r = _run_order("(TT) Eperison 50mg 01 vx3 (u) 8h-16h-23h")
    uong = r["thuoc"].get("thuoc_uong", [])
    item = next((d for d in uong if "EPERISON" in d.get("ten_thuoc", "").upper()), None)
    assert item is not None
    assert item.get("tu_tuc") is True
    assert item.get("so_luong") == "3"
    assert item.get("gio_dung") == "8 giờ, 16 giờ, 23 giờ"
    assert not r.get("y_lenh_khac", {}).get("khac")


def test_natri_in_active_name_is_not_treated_as_solvent():
    r = _run_order("Diclofenac Natri x 1 (Ống)\nTiêm bắp 8 giờ")
    tiem = r["thuoc"].get("thuoc_tiem", [])
    item = next((d for d in tiem if "DICLOFENAC NATRI" in d.get("ten_thuoc", "").upper()), None)
    assert item is not None
    assert item.get("dung_moi") not in ("NACL_0.9", "SODIUM_0.9")
    assert not r["thuoc"].get("dich_truyen", [])


def test_water_for_injection_attaches_to_vial_and_not_standalone():
    r = _run_order(
        "CEFOXITIN 1G x 4 (Lọ)\n"
        "Tiêm tĩnh mạch chậm 8-16-20 giờ\n"
        "NƯỚC CẤT PHA TIÊM 5ML x 8 (Ống)"
    )
    tiem = r["thuoc"].get("thuoc_tiem", [])
    cefoxitin = next((d for d in tiem if "CEFOXITIN" in d.get("ten_thuoc", "").upper()), None)
    assert cefoxitin is not None
    assert cefoxitin.get("gio_dung") == "8 giờ, 16 giờ, 20 giờ"
    assert "PHA NƯỚC CẤT" in (cefoxitin.get("ten_hien_thi") or "").upper()
    assert not any("NƯỚC CẤT" in d.get("ten_thuoc", "").upper() for d in _all_meds(r))


def test_aminoleban_without_explicit_volume_keeps_schedule_from_order_time():
    r = _run_order("AMINOLEBAN x 1 (Chai)\nTruyền tĩnh mạch 40g/p")
    dt = r["thuoc"].get("dich_truyen", [])
    item = next((d for d in dt if "AMINOLEBAN" in d.get("ten_thuoc", "").upper()), None)
    assert item is not None
    assert float(item.get("the_tich") or 0) > 0
    assert item.get("gio_dung") == "08:00"
    assert item.get("tg_bat_dau")
    assert item.get("tg_ket_thuc")


def test_quantity_written_as_vietnamese_word_is_parsed():
    r = _run_order("TRAMADOL x Hai (Ống)\nTiêm bắp 8-16 giờ")
    tiem = r["thuoc"].get("thuoc_tiem", [])
    item = next((d for d in tiem if d.get("ten_thuoc", "").upper() == "TRAMADOL"), None)
    assert item is not None
    assert item.get("so_luong") == "2"
    assert item.get("so_lan_dung") == 2
    assert item.get("so_lo_moi_lan") == 1


def test_grouped_hours_8_16_20_are_all_detected():
    assert parse_hours_from_gio_dung("8-16-20 giờ") == [8, 16, 20]
    r = _run_order("CEFOXITIN 1G x 3 (Lọ)\nTiêm tĩnh mạch chậm 8-16-20 giờ")
    tiem = r["thuoc"].get("thuoc_tiem", [])
    item = next((d for d in tiem if "CEFOXITIN" in d.get("ten_thuoc", "").upper()), None)
    assert item is not None
    assert item.get("gio_dung") == "8 giờ, 16 giờ, 20 giờ"


def test_roman_rate_joined_with_unit_is_parsed():
    r = _run_order("PARACETAMOL 1G/100ML x 1 (Chai)\nTTM XXXg/p 8h")
    dt = r["thuoc"].get("dich_truyen", [])
    item = next((d for d in dt if "PARACETAMOL" in d.get("ten_thuoc", "").upper()), None)
    assert item is not None
    assert str(item.get("toc_do")) == "30"


def test_decimal_and_fraction_oral_dose_are_preserved_per_hour():
    r1 = _run_order("Eperison 50mg x 1 (Viên)\nUống sáng 0,5 viên (8 giờ)")
    d1 = r1["thuoc"]["thuoc_uong"][0]
    assert d1.get("so_luong_moi_gio", {}).get("8") == 0.5

    r2 = _run_order("Eperison 50mg x 1 (Viên)\nUống sáng 1/2 viên (8 giờ)")
    d2 = r2["thuoc"]["thuoc_uong"][0]
    assert d2.get("so_luong_moi_gio", {}).get("8") == 0.5
