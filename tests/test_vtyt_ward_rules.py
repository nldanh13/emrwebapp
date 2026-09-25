# -*- coding: utf-8 -*-
"""VTYT bệnh phòng: chỉ VTYT theo thủ thuật, quy tắc thay băng theo vị trí,
VTYT lẻ chọn tay, đối chiếu danh mục dò trên EMR trước khi nhập."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "worker"
if str(WORKER) not in sys.path:
    sys.path.insert(0, str(WORKER))

import vtyt_rules
from vtyt_rules import build_required_supplies, build_vtyt_jobs, procedure_supplies_only


def _rec(text, **extra):
    return {"ma_bn": "BN1", "ngay_lam": "25/09/2026", "chi_dinh_khac": [text], **extra}


def _keys(items):
    return {x["key"] for x in items}


def test_thay_bang_hip_uses_urgotile_and_drops_old_dressing():
    items = build_required_supplies([_rec("Thay băng vết mổ", chan_doan="Sau phẫu thuật thay khớp háng")])
    keys = _keys(items)
    assert "URGOTILE" in keys
    assert not keys & {"BANG_DINH_DECOMED", "BANG_DINH_250X90", "BANG_THUN_3_MOC", "BANG_DINH_60X70"}


def test_thay_bang_clavicle_and_lumbar_use_urgotile():
    for dx in ("Gãy xương đòn sau mổ", "Phẫu thuật cột sống thắt lưng L4-L5"):
        assert "URGOTILE" in _keys(build_required_supplies([_rec("Thay băng", chan_doan=dx)]))


def test_thay_bang_other_site_uses_elastic_bandage():
    keys = _keys(build_required_supplies([_rec("Thay băng", chan_doan="Sau mổ gãy xương cẳng chân")]))
    assert "BANG_THUN_3_MOC" in keys
    assert "URGOTILE" not in keys and "BANG_DINH_DECOMED" not in keys


def test_urgotile_without_emr_code_is_not_input_blindly():
    item = next(x for x in build_required_supplies([_rec("Thay băng", chan_doan="thay khớp háng")]) if x["key"] == "URGOTILE")
    assert item["input_allowed"] is False and item["needs_review"] is True


def test_catalog_override_code_and_disabled_are_honored():
    d = vtyt_rules.load_vtyt_dictionary()
    d["catalog"]["URGOTILE"] = {**d["catalog"]["URGOTILE"], "override_code": "VTYT.000009999", "override_name": "URGOTILE 20cm"}
    acc = {}
    vtyt_rules.add_req(acc, "URGOTILE", 1, "x", category="dvkt", dictionary=d)
    assert acc["URGOTILE"]["code"] == "VTYT.000009999" and acc["URGOTILE"]["input_allowed"] is True
    d["catalog"]["BANG_THUN_3_MOC"] = {**d["catalog"]["BANG_THUN_3_MOC"], "disabled": True}
    acc = {}
    vtyt_rules.add_req(acc, "BANG_THUN_3_MOC", 1, "x", category="dvkt", dictionary=d)
    assert acc == {}


def test_ward_keeps_only_procedure_categories():
    items = [
        {"key": "GANG_TAY_KHAM", "category": "daily"},
        {"key": "BOM_TIEM_20ML", "category": "medication"},
        {"key": "BANG_THUN_3_MOC", "category": "dvkt"},
        {"key": "KIM_LUON_TM", "category": "interval"},
    ]
    assert _keys(procedure_supplies_only(items)) == {"BANG_THUN_3_MOC", "KIM_LUON_TM"}


def test_ward_jobs_include_manual_picks_even_without_rule_supplies():
    rows = [{"ma_bn": "BN1", "ngay_lam": "25/09/2026", "chan_doan": "Viêm phổi"}]
    targets = {
        "patientIds": ["BN1"], "patientDates": {"BN1": ["25/09/2026"]},
        "manualVtyt": {"BN1::25/09/2026": [{"key": "BANG_THUN_3_MOC", "qty": 2}]},
    }
    jobs = build_vtyt_jobs(rows, targets, procedure_only=True)
    job = next(j for j in jobs if j["ngay_lam"] == "25/09/2026")
    assert [(x["key"], x["required_quantity"], x["category"]) for x in job["supplies"]] == [("BANG_THUN_3_MOC", 2, "manual")]


def test_scan_parse_and_merge():
    from vtyt_emr_catalog_scan import merge_scan_rows, parse_option_text
    assert parse_option_text("VTYT.000004174 - Găng tay khám Latex")["code"] == "VTYT.000004174"
    rows = merge_scan_rows({
        "": ["VTYT.000003914 Băng thun 3 móc", "No results found"],
        "thun": ["VTYT.000003914 Băng thun 3 móc"],
        "urgo": ["VTYT.000009999 Urgotile băng dán 20cm x 10cm"],
    })
    assert [r["code"] for r in rows] == ["VTYT.000003914", "VTYT.000009999"]
    assert rows[0]["queries"] == ["", "thun"]


def test_pre_input_check_skips_items_not_on_emr():
    from input_vtyt import check_supplies_against_emr
    supplies = [{"key": "A", "code": "VTYT.1"}, {"key": "B", "code": "VTYT.2"}, {"key": "C", "code": ""}]
    ok, missing = check_supplies_against_emr(supplies, {"VTYT.1"})
    assert [x["key"] for x in ok] == ["A"] and [x["key"] for x in missing] == ["B", "C"]
    ok, missing = check_supplies_against_emr(supplies, None)
    assert len(ok) == 3 and missing == []


def test_incremental_filter_no_longer_crashes():
    from input_vtyt import _filter_incremental_jobs
    job = {"key": "BN1::25/09/2026", "supplies": [{"key": "BANG_THUN_3_MOC", "required_quantity": 2}]}
    prev = {"succeeded": ["BN1::25/09/2026"], "full_plan": [{"key": "BN1::25/09/2026", "supplies": [{"key": "BANG_THUN_3_MOC", "required_quantity": 1}]}]}
    jobs, noop = _filter_incremental_jobs([job], prev)
    assert jobs[0]["supplies"][0]["required_quantity"] == 1 and noop == {}
