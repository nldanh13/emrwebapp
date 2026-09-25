# -*- coding: utf-8 -*-
"""Loại nhận bệnh theo lịch sử khoa điều trị ("Khoa điều trị thứ N"):
- trước CTCH-TK là Gây Mê Hồi Sức → nhận hậu phẫu (mẫu sau mổ);
- lần đầu vào CTCH-TK → nhận bệnh bình thường;
- trước đó là khoa khác → nhận chuyển khoa."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "worker"
if str(WORKER) not in sys.path:
    sys.path.insert(0, str(WORKER))

from clinical_rules import (
    extract_admission_transfer_events,
    extract_care_special_events,
    reconcile_receive_events_with_ward_history,
)

CTCH = "Khoa Ngoại Chấn Thương Chỉnh Hình và Thần Kinh"
GMHS = "Khoa Gây Mê Hồi Sức"


def _h(*rows):
    return [{"thu_tu": i + 1, "ten_khoa_dieu_tri": k, "thoi_gian_vao_khoa": t} for i, (k, t) in enumerate(rows)]


def _events(patient, date, db=""):
    ev = extract_care_special_events(db, "", date) + extract_admission_transfer_events(patient, db, "", date)
    ev = reconcile_receive_events_with_ward_history(ev, patient, db, date)
    return [(e["type"], e["time_label"]) for e in ev]


def test_back_from_gmhs_is_postop_even_without_note():
    hist = _h((CTCH, "15:09 18/09/2026"), (GMHS, "17:01 24/09/2026"), (CTCH, "21:00 24/09/2026"))
    p = {"lich_su_khoa_dieu_tri": hist, "T/G vào": "21:00 24/09/2026", "Khoa chuyển đến": CTCH}
    assert _events(p, "24/09/2026") == [("postop_receive", "21:00")]


def test_first_admission_is_normal_receive():
    hist = _h((CTCH, "15:09 18/09/2026"), (GMHS, "17:01 24/09/2026"), (CTCH, "21:00 24/09/2026"))
    assert _events({"lich_su_khoa_dieu_tri": hist}, "18/09/2026") == [("ward_receive", "15:09")]


def test_from_other_department_is_interdepartment():
    hist = _h((CTCH, "08:00 10/09/2026"), ("Khoa Nội Tổng Hợp", "09:00 12/09/2026"), (CTCH, "10:30 15/09/2026"))
    assert _events({"lich_su_khoa_dieu_tri": hist}, "15/09/2026") == [("interdepartment_receive", "10:30")]


def test_first_time_in_ctch_after_gmhs_is_still_postop():
    hist = _h(("Khoa Cấp Cứu", "01:00 20/09/2026"), (GMHS, "02:00 20/09/2026"), (CTCH, "06:00 20/09/2026"))
    assert _events({"lich_su_khoa_dieu_tri": hist}, "20/09/2026") == [("postop_receive", "06:00")]


def test_keeps_doctor_note_time_when_same_kind_nearby():
    hist = _h((CTCH, "15:09 18/09/2026"), (GMHS, "17:01 24/09/2026"), (CTCH, "21:00 24/09/2026"))
    db = "20:40 | Bác sĩ: A\nChuyển mổ\n---\n21:10 | Bác sĩ: B\nCTCH nhận bệnh sau mổ"
    assert _events({"lich_su_khoa_dieu_tri": hist}, "24/09/2026", db) == [("postop_receive", "21:10")]


def test_no_history_keeps_old_behavior():
    p = {"T/G vào": "14:30 25/09/2026", "Khoa chuyển đến": "Gây mê hồi sức"}
    assert _events(p, "25/09/2026") == [("postop_receive", "14:30")]


def test_days_without_ctch_entry_unchanged():
    hist = _h((CTCH, "15:09 18/09/2026"))
    assert _events({"lich_su_khoa_dieu_tri": hist}, "19/09/2026") == []
