# -*- coding: utf-8 -*-
"""Pre-open inpatient admission validation, with fictional EMR rows."""
from main_worker import (
    _check_inpatient_before_open,
    _extract_list_row_for_patient_from_html,
)


def live_row(date, status="Hoàn tất"):
    return {
        "Mã BN": "TEST009",
        "T/G vào": "14:54 " + date,
        "Trạng thái": status,
        "Xử trí": "Ra viện Đỡ giảm" if status == "Hoàn tất" else "Đang thực hiện",
    }


def test_old_completed_episode_is_skipped_before_clicking_name():
    ok, why = _check_inpatient_before_open(
        live_row("30/09/2026"), {"ma_bn": "TEST009", "tg_vao": "14:54 30/09/2026"},
        "Hoàn tất", "16/10/2026", "18/10/2026",
    )
    assert not ok
    assert "Hồ sơ Hoàn tất đã cũ" in why


def test_completed_just_before_requested_start_is_allowed():
    ok, why = _check_inpatient_before_open(
        live_row("15/10/2026"), {"tg_vao": "14:54 15/10/2026"},
        "Hoàn tất", "16/10/2026", "18/10/2026",
    )
    assert ok


def test_completed_entered_on_first_work_day_is_allowed():
    ok, _ = _check_inpatient_before_open(
        live_row("16/10/2026"), {}, "Hoàn tất",
        "16/10/2026", "18/10/2026",
    )
    assert ok


def test_active_long_stay_is_not_rejected_on_admission_age_alone():
    ok, _ = _check_inpatient_before_open(
        live_row("30/09/2026", status="Đang thực hiện"),
        {"tg_vao": "14:54 30/09/2026"},
        "Đang thực hiện", "16/10/2026", "18/10/2026",
    )
    assert ok


def test_new_admission_does_not_match_old_saved_encounter():
    ok, why = _check_inpatient_before_open(
        live_row("16/10/2026", status="Đang thực hiện"),
        {"tg_vao": "14:54 30/09/2026"},
        "Đang thực hiện", "16/10/2026", "18/10/2026",
    )
    assert not ok
    assert "Không khớp đợt điều trị" in why


def test_missing_live_admission_is_not_assumed_current():
    ok, why = _check_inpatient_before_open(
        {"Mã BN": "TEST009", "Trạng thái": "Hoàn tất"},
        {"tg_vao": "14:54 16/10/2026"}, "Hoàn tất",
        "16/10/2026", "18/10/2026",
    )
    assert not ok
    assert "T/G vào" in why


def test_live_admission_one_day_after_selected_end_can_be_in_shift_bridge():
    ok, _ = _check_inpatient_before_open(
        live_row("19/10/2026", status="Đang thực hiện"),
        {}, "Đang thực hiện", "16/10/2026", "18/10/2026",
    )
    assert ok
    ok, _ = _check_inpatient_before_open(
        live_row("20/10/2026", status="Đang thực hiện"),
        {}, "Đang thực hiện", "16/10/2026", "18/10/2026",
    )
    assert not ok


def test_extract_correct_live_list_row_before_validation():
    html = """<table id="tblNoiTru"><thead><tr>
        <th>Mã BN</th><th>Họ tên</th><th>T/G vào</th><th>Trạng thái</th>
        <th>Xử trí</th></tr></thead><tbody>
        <tr><td>TEST009</td><td>NGƯỜI BỆNH M</td>
        <td>14:54 30/09/2026</td><td>Hoàn tất</td>
        <td>Ra viện Đỡ giảm</td></tr></tbody></table>"""
    row = _extract_list_row_for_patient_from_html(html, "TEST009")
    assert row["tg_vao"] == "14:54 30/09/2026"
    assert row["trang_thai"] == "Hoàn tất"
    ok, _ = _check_inpatient_before_open(
        row, {"tg_vao": "14:54 30/09/2026"}, "Hoàn tất",
        "16/10/2026", "18/10/2026",
    )
    assert not ok
