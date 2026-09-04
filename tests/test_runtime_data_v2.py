# -*- coding: utf-8 -*-
import json
from pathlib import Path

from runtime_data_v2 import encounter_day_key, merge_order_records, generate_runtime_v2_files
from processing.validators.sanity_check import run_sanity_checks


def test_merge_order_records_keeps_one_patient_day_and_turns_bridge_into_segment():
    rows = [
        {"Mã BN": "BN001", "Họ tên": "A", "ngay_lam": "11/05/2026", "Y lệnh": "08:00 thuốc A", "Diễn biến": "Tỉnh"},
        {"Mã BN": "BN001", "Họ tên": "A", "ngay_lam": "11/05/2026", "source_date": "12/05/2026", "bridge_source_date": "12/05/2026", "bridge_work_date": "11/05/2026", "Y lệnh": "", "Diễn biến": ""},
    ]

    merged = merge_order_records(rows)

    assert len(merged) == 1
    assert merged[0]["ngay_lam"] == "11/05/2026"
    assert merged[0]["Y lệnh"] == "08:00 thuốc A"
    assert len(merged[0]["source_segments"]) == 2
    assert {x["source_type"] for x in merged[0]["source_segments"]} == {"main_day", "bridge_00_07"}


def test_merge_order_records_merges_non_empty_duplicate_text_without_repeating_lines():
    rows = [
        {"Mã BN": "BN001", "ngay_lam": "11/05/2026", "Y lệnh": "08:00 thuốc A\n09:00 thuốc B", "Diễn biến": "Tỉnh"},
        {"Mã BN": "BN001", "ngay_lam": "11/05/2026", "Y lệnh": "09:00 thuốc B\n10:00 thuốc C", "Diễn biến": "Tỉnh\nĐau ít"},
    ]

    merged = merge_order_records(rows)

    assert len(merged) == 1
    assert merged[0]["Y lệnh"].splitlines() == ["08:00 thuốc A", "09:00 thuốc B", "10:00 thuốc C"]
    assert merged[0]["Diễn biến"].splitlines() == ["Tỉnh", "Đau ít"]


def test_generate_runtime_v2_files_creates_normalized_maps(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    raw = [{"Mã BN": "BN001", "Họ tên": "Người bệnh A", "T/G vào": "08:00 10/05/2026"}]
    selected = [{"Mã BN": "BN001", "Họ tên": "Người bệnh A", "Vi_Tri": "P03"}]
    orders = [
        {"Mã BN": "BN001", "Họ tên": "Người bệnh A", "ngay_lam": "11/05/2026", "Y lệnh": "08:00 thuốc A", "Diễn biến": "Tỉnh"},
        {"Mã BN": "BN001", "Họ tên": "Người bệnh A", "ngay_lam": "11/05/2026", "source_date": "12/05/2026", "Y lệnh": "", "Diễn biến": ""},
    ]
    classified = [{"ma_bn": "BN001", "ho_ten": "Người bệnh A", "ngay_lam": "11/05/2026", "nhap_cham_soc": {"dien_bien": "Tỉnh"}, "thuoc": {"thuoc_uong": []}, "raw_order_events": [{"time": "08:00", "text": "x"}]}]
    (data / "01_raw_patient_rows.json").write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
    (data / "02_selected_patient_rows.json").write_text(json.dumps(selected, ensure_ascii=False), encoding="utf-8")
    (data / "03_order_text_by_patient_day.json").write_text(json.dumps(orders, ensure_ascii=False), encoding="utf-8")
    (data / "04_classified_patient_day_records.json").write_text(json.dumps(classified, ensure_ascii=False), encoding="utf-8")

    indexes = generate_runtime_v2_files(tmp_path)

    assert indexes["patients_count"] == 1
    assert indexes["order_days_count"] == 1
    patients = json.loads((data / "patients.json").read_text(encoding="utf-8"))
    board = json.loads((data / "board_state.json").read_text(encoding="utf-8"))
    order_days = json.loads((data / "order_days.json").read_text(encoding="utf-8"))
    classified_days = json.loads((data / "classified_days.json").read_text(encoding="utf-8"))
    assert patients["patients"]["BN001"]["name"] == "Người bệnh A"
    assert board["room_assignments"]["BN001"] == "P03"
    assert list(order_days["patient_days"].keys()) == ["BN001::2026-05-11"]
    assert list(classified_days["patient_days"].keys()) == ["BN001::2026-05-11"]
    assert "raw_order_events" not in classified_days["patient_days"]["BN001::2026-05-11"]


def test_sanity_check_ignores_negative_no_medication_context():
    records = [{
        "ma_bn": "BN001",
        "ngay_lam": "11/05/2026",
        "nhap_cham_soc": {"dien_bien": "", "y_lenh": "Không thuốc chờ mổ"},
        "thuoc": {"dich_truyen": [], "thuoc_tiem": [], "thuoc_uong": [], "thuoc_tra": [], "khac": []},
        "chi_dinh_khac": {},
    }]

    warnings = run_sanity_checks(records)

    assert not [w for w in warnings if w.get("code") == "MEDICATION_TEXT_BUT_NO_MED"]


def test_encounter_day_key_separates_readmissions_on_same_date():
    first = {"ma_bn": "BN001", "ma_luot_dieu_tri": "ENC-A", "ngay_lam": "11/05/2026"}
    second = {"ma_bn": "BN001", "ma_luot_dieu_tri": "ENC-B", "ngay_lam": "11/05/2026"}
    assert encounter_day_key(first) == "ENC-A::2026-05-11"
    assert encounter_day_key(second) == "ENC-B::2026-05-11"
    assert encounter_day_key(first) != encounter_day_key(second)


def test_runtime_v2_keeps_legacy_and_encounter_day_indexes(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    rows = [{"ma_bn": "BN001", "ma_luot_dieu_tri": "ENC-A", "ngay_lam": "11/05/2026", "Y lệnh": "08:00 thuốc A"}]
    for name, value in [
        ("01_raw_patient_rows.json", rows),
        ("02_selected_patient_rows.json", rows),
        ("03_order_text_by_patient_day.json", rows),
        ("04_classified_patient_day_records.json", [{**rows[0], "nhap_cham_soc": {}}]),
    ]:
        (data / name).write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    generate_runtime_v2_files(tmp_path)
    order_days = json.loads((data / "order_days.json").read_text(encoding="utf-8"))
    assert "BN001::2026-05-11" in order_days["patient_days"]
    assert "ENC-A::2026-05-11" in order_days["encounter_days"]
