# -*- coding: utf-8 -*-
"""Form dịch truyền mới: chọn đúng Y lệnh trước (EMR tự điền Bác sĩ), rồi Y tá,
rồi Chọn thuốc (thuốc + dịch pha)."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "worker"
if str(WORKER) not in sys.path:
    sys.path.insert(0, str(WORKER))

from infusion_select2 import chon_y_lenh_phu_hop

ROWS = [
    ("05:00 28/09/2026", "Trần Nguyễn Anh Duy"),
    ("07:00 25/09/2026", "Trần Nguyễn Anh Duy"),
    ("06:30 25/09/2026", "Trần Quang Sơn"),
    ("05:00 25/09/2026", "Trần Nguyễn Anh Duy"),
    ("05:00 24/09/2026", "Trần Nguyễn Anh Duy"),
]


def test_exact_time_and_date():
    assert chon_y_lenh_phu_hop(ROWS, "05:00", "25/09/2026", "Trần Nguyễn Anh Duy") == 3
    assert chon_y_lenh_phu_hop(ROWS, "06:30", "25/09/2026", "Trần Quang Sơn") == 2


def test_same_time_off_by_one_day_when_exact_date_missing():
    assert chon_y_lenh_phu_hop(ROWS, "05:00", "26/09/2026", "Trần Nguyễn Anh Duy") == 3


def test_no_match_returns_none_instead_of_guessing():
    assert chon_y_lenh_phu_hop(ROWS, "09:00", "25/09/2026", "") is None
    assert chon_y_lenh_phu_hop([], "05:00", "25/09/2026", "") is None


def test_without_order_time_uses_latest_order_before_start_same_day():
    assert chon_y_lenh_phu_hop(ROWS, "", "25/09/2026", "", "08:00 25/09/2026") == 1
    assert chon_y_lenh_phu_hop(ROWS, "", "25/09/2026", "", "06:45 25/09/2026") == 2


def test_form_order_y_lenh_then_nurse_then_drugs_and_no_doctor_pick():
    src = (WORKER / "infusion_form_actions.py").read_text(encoding="utf-8")
    body = src[src.index("def _nhap_moi_1_dich_truyen("):]
    i_yl = body.index("chon_y_lenh(")
    i_yt = body.index('chon_select2_bac_si_y_ta(driver, "cbbYTa"')
    i_drug = body.index("_fill_form_dich_truyen_once(driver, med)")
    assert i_yl < i_yt < i_drug
    assert '"cbbBacSi"' not in body
    assert "txtSoLo" not in src[src.index("def _chon_thuoc_va_dung_moi("):]


def test_diluent_only_added_for_mixed_drugs():
    from infusion_form_actions import _la_thuoc_pha
    assert _la_thuoc_pha({"Full_Name": "TRASOLU + Natri clorid 0.9%", "Search_Name": "TRASOLU", "Dung_Moi": "NACL_0.9"})
    assert not _la_thuoc_pha({"Full_Name": "NATRI CLORID 0,9%", "Search_Name": "NATRI CLORID 0,9%"})
    assert not _la_thuoc_pha({"Full_Name": "LACTATED RINGER'S", "Search_Name": "LACTATED RINGER'S"})
