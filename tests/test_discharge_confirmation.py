# -*- coding: utf-8 -*-
"""Xác định ra viện từ timeline y lệnh EMR thật (04/11/2026, đã ẩn tên).

Lỗi cũ:
- Toa ra viện (CEFUROXIM x 10 viên, LIGABA x 5...) trong phiếu 07:30 "=> Xuất viện"
  bị xếp thành thuốc uống 8h/20h trong ngày.
- Mốc ra viện lấy theo giờ bác sĩ ghi diễn biến (07:30), làm mất cữ 08:00,
  trong khi y lệnh ghi "Hoàn thuốc tiêm truyền cử chiều tối".
- Không xét ngày sau còn kê thuốc hay không.
"""
import json
import os
import tempfile
from pathlib import Path

from emr_parsers import dates_with_drug_orders, extract_timeline_map_from_html, order_text_has_drugs
from input_infusions_utils import _resolve_estimated_discharge_dt
from xu_ly import process_all

FIXTURE = Path(__file__).parent / "fixtures" / "y_lenh_xuat_vien_20261104.html"


def _process(extra=None):
    out, _ = extract_timeline_map_from_html(FIXTURE.read_text(encoding="utf-8"))
    day = out["04/11/2026"]
    rec = {
        "Mã BN": "TEST_XV", "Họ tên": "BN TEST", "Bác sĩ": "", "Vi_Tri": "P01",
        "ngay_lam": "04/11/2026", "Diễn biến": day["Diễn biến"], "Y lệnh": day["Y lệnh"],
    }
    rec.update(extra or {})
    with tempfile.TemporaryDirectory() as tmp:
        in_path = os.path.join(tmp, "in.json")
        out_path = os.path.join(tmp, "out.json")
        with open(in_path, "w", encoding="utf-8") as f:
            json.dump([rec], f, ensure_ascii=False)
        process_all(in_path, output_file=out_path)
        with open(out_path, encoding="utf-8") as f:
            return json.load(f)[0]


def _codes(rec):
    return [w.get("code") for w in rec.get("processing_warnings") or []]


def test_discharge_prescription_is_not_scheduled():
    rec = _process()
    oral = [d["ten_thuoc"] for d in rec["thuoc"]["thuoc_uong"]]
    assert oral == ["ESOMEPRAZOL 40MG", "METHYLPREDNISOLON 16"]
    toa = [d["ten_thuoc"] for d in rec.get("toa_ra_vien") or []]
    for name in ("CEFUROXIM 500", "MEDOLEB 200MG", "LIGABA 75"):
        assert name in toa
    assert 20 not in rec["tong_hop_gio_dung"]
    assert "DISCHARGE_PRESCRIPTION_SPLIT" in _codes(rec)


def test_discharge_without_exit_time_keeps_0800():
    rec = _process()
    events = [e for e in rec["care_special_events"] if e["type"] == "discharge"]
    assert len(events) == 1
    assert events[0]["time_label"] == "08:30"
    assert events[0]["doctor_time"] == "07:30"
    assert events[0]["time_estimated"] is True
    assert rec["care_mode"] == "discharge_day"
    assert "DISCHARGE_TIME_ESTIMATED" in _codes(rec)
    # Dịch truyền 08:00 vẫn nhập, chai bắt đầu sau 08:30 thì không.
    cutoff = _resolve_estimated_discharge_dt(rec, "04/11/2026")
    assert cutoff.strftime("%H:%M %d/%m/%Y") == "08:30 04/11/2026"


def test_next_day_drug_orders_mean_not_discharged():
    rec = _process({"co_thuoc_ngay_sau": True})
    assert not [e for e in rec.get("care_special_events") or [] if e["type"] == "discharge"]
    assert rec.get("care_mode") != "discharge_day"
    assert "DISCHARGE_NOT_CONFIRMED_NEXT_DAY_DRUGS" in _codes(rec)


def test_dates_with_drug_orders():
    html = FIXTURE.read_text(encoding="utf-8")
    assert dates_with_drug_orders(html) == {"03/11/2026", "04/11/2026"}
    assert not order_text_has_drugs("+ Thuốc:\n+ Thuốc trả:\n-Paracetamol x 2 Túi")
    assert order_text_has_drugs("+ Thuốc:\nPARACETAMOL x 1 (Túi)")
