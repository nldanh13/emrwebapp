# -*- coding: utf-8 -*-
"""Ra viện chỉ có ngày, chưa rõ giờ: worker không nhập chăm sóc/dịch truyền sau
mốc giờ cuối cùng có căn cứ trong ngày ra viện.

Ca mốc dùng chung với scripts/discharge_unknown_time_test.js (màn xem trước).
"""
import json
import os
import tempfile
from pathlib import Path

import pytest

from discharge_cutoff import inferred_discharge_cutoff

ROOT = Path(__file__).resolve().parents[1]
CASES = json.loads((ROOT / "tests" / "fixtures" / "discharge_unknown_time_cases.json").read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_inferred_cutoff_matches_preview_cases(case):
    info = inferred_discharge_cutoff(case["record"])
    got = info["last_evidence"].strftime("%H:%M %d/%m/%Y") if info else None
    assert got == case["last_evidence"]
    if info:
        assert (info["cutoff"] - info["last_evidence"]).total_seconds() == 60


def _infusion(name, start, end):
    return {
        "ten_thuoc": name, "ten_hien_thi": name, "the_tich": "500", "toc_do": "40",
        "duong_dung_goc": "Truyền tĩnh mạch", "tg_bat_dau": start, "tg_ket_thuc": end,
    }


def _prepare(entry):
    from input_infusions_utils import chuan_bi_du_lieu_json
    f = tempfile.NamedTemporaryFile("w", suffix=".json", encoding="utf-8", delete=False)
    json.dump([entry], f, ensure_ascii=False)
    f.close()
    try:
        return chuan_bi_du_lieu_json(f.name)
    finally:
        os.unlink(f.name)


def test_infusion_after_unknown_discharge_time_not_entered_and_not_deleted():
    entry = {
        "ma_bn": "X1", "ho_ten": "A", "ngay_lam": "20/10/2026",
        "ngay_ra_vien": "20/10/2026", "ngay_ra_vien_date": "20/10/2026", "xu_tri": "Ra viện",
        "thuoc": {"dich_truyen": [
            _infusion("Natri clorid 0,9% 500ml", "08:00 20/10/2026", "10:00 20/10/2026"),
            _infusion("Ringer lactat 500ml", "14:00 20/10/2026", "16:00 20/10/2026"),
        ]},
    }
    items = [x for x in _prepare(entry)["X1"] if not x.get("__managed_date")]
    # Chai bắt đầu 08:00 vẫn nhập dù kết thúc sau 08:00 (mốc suy luận không phải giờ rời khoa).
    assert [x.get("Time_Start_Str") for x in items if not x.get("__cleanup_only")] == ["08:00 20/10/2026"]
    # Không tự xoá bản 14:00 trên EMR chỉ dựa vào mốc suy luận.
    assert not [x for x in items if x.get("__cleanup_only")]


def test_infusion_keeps_bottles_started_before_latest_same_day_order():
    entry = {
        "ma_bn": "X1", "ho_ten": "A", "ngay_lam": "20/10/2026", "ngay_ra_vien": "20/10/2026", "xu_tri": "Ra viện",
        "raw_order_events": [{"ngay_lam": "20/10/2026", "gio_y_lenh": "14:30 20/10/2026", "text": "Cho xuất viện"}],
        "thuoc": {"dich_truyen": [
            _infusion("Natri clorid 0,9% 500ml", "08:00 20/10/2026", "10:00 20/10/2026"),
            _infusion("Ringer lactat 500ml", "14:00 20/10/2026", "16:00 20/10/2026"),
            _infusion("Glucose 5% 500ml", "20:00 20/10/2026", "22:00 20/10/2026"),
        ]},
    }
    items = [x for x in _prepare(entry)["X1"] if not x.get("__managed_date") and not x.get("__cleanup_only")]
    assert [x.get("Time_Start_Str") for x in items] == ["08:00 20/10/2026", "14:00 20/10/2026"]


def test_infusion_normal_day_unchanged():
    entry = {
        "ma_bn": "X1", "ho_ten": "A", "ngay_lam": "20/10/2026",
        "thuoc": {"dich_truyen": [_infusion("Ringer lactat 500ml", "14:00 20/10/2026", "16:00 20/10/2026")]},
    }
    items = [x for x in _prepare(entry)["X1"] if not x.get("__managed_date")]
    assert [x.get("Time_Start_Str") for x in items] == ["14:00 20/10/2026"]


def test_care_worker_uses_inferred_cutoff_without_fake_discharge_note():
    src = (ROOT / "worker" / "input_care.py").read_text(encoding="utf-8")
    assert "inferred_discharge_cutoff(entry_obj, ngay_lam_viec)" in src
    # Phiếu ra viện chỉ được tạo từ giờ ra viện thật, không từ mốc suy luận.
    block = src[src.index("discharge_inferred = inferred_discharge_cutoff"):src.index("receive_time_key = None")]
    guard_pos = block.index("if discharge_cutoff_dt is not None and _same_calendar_date")
    assert "_make_discharge_event_from_dt" not in block[:guard_pos]
    assert 'discharge_dt = discharge_inferred["cutoff"]' in src
