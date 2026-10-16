# -*- coding: utf-8 -*-
"""Regression: medicine dose units do not create extra saline bags."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "worker"))
from processing.infusion_scheduler import calculate_infusion_times


def _item(**updates):
    base = dict(
        ten_thuoc="VINPHACINE", dang="Ống", so_luong=2,
        gio_dung="8 giờ", the_tich=100, toc_do="30",
        tui_dich_truyen_ml=100,
        duong_dung_goc="2A pha trong 1 chai Natri Clorid 0,9% 100ml truyền tĩnh mạch",
    )
    base.update(updates)
    return base


def test_two_ampoules_one_bag_not_two_infusions():
    result = calculate_infusion_times([_item()], "16/10/2026")
    assert len(result) == 1
    assert result[0]["the_tich"] == 100
    assert result[0]["so_lo_moi_lan"] == 2
    assert not result[0].get("tach_chai_truyen")


def test_diluent_bag_word_does_not_split_vials_without_presentation():
    result = calculate_infusion_times([_item(dang="", raw_text="VINPHACINE 2A pha 1 túi NaCl 100ml")], "16/10/2026")
    assert len(result) == 1
    assert result[0]["the_tich"] == 100


def test_two_explicit_times_are_two_administrations_not_four_bags():
    result = calculate_infusion_times([_item(gio_dung="8 giờ, 20 giờ", so_luong=4, so_luong_moi_gio={8: 2, 20: 2})], "16/10/2026")
    assert len(result) == 2
    assert all(d["the_tich"] == 100 for d in result)
    assert all(d["so_lo_moi_lan"] == 2 for d in result)


def test_independent_two_bags_still_split():
    result = calculate_infusion_times([_item(ten_thuoc="NATRI CLORID 0,9%", dang="Chai", so_luong=2, tui_dich_truyen_ml=0, duong_dung_goc="Truyền tĩnh mạch")], "16/10/2026")
    assert len(result) == 2
    assert all(d["the_tich"] == 100 for d in result)
