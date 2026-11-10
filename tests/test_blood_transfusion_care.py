# -*- coding: utf-8 -*-
"""Phiếu chăm sóc truyền máu: mốc giờ khớp bảng Truyền máu ở Phiếu bàn giao ca.

Mốc lấy từ config/blood_transfusion_care.json (dùng chung với giao diện). Kết quả mong đợi ở
tests/fixtures/blood_transfusion_times.json cũng được test JS (bloodTransfusion.test.js) kiểm.
"""
import json
from pathlib import Path

from input_care import _build_truyen_mau_events

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "blood_transfusion_times.json").read_text(encoding="utf-8"))


def test_moc_gio_khop_fixture_chung():
    for case in FIXTURE["cases"]:
        events = _build_truyen_mau_events(case["start"], case["date"])
        assert [e["time_full"] for e in events] == case["times"], case["start"]


def test_noi_dung_theo_mau_khoa():
    events = {e["slot_key"]: e for e in _build_truyen_mau_events("14:00", "10/11/2026")}
    assert events["pre"]["dien_bien"] == "Người bệnh tỉnh, Tiếp xúc tốt, Da niêm nhợt"
    assert events["pre"]["cham_soc"] == "Thử phản ứng thuận hợp tại giường + Lấy dấu hiệu sinh tồn + Trình Bs"
    assert events["start"]["cham_soc"] == "Bắt đầu truyền máu"
    assert events["start"]["needs_vitals"] is False
    assert events["m15"]["cham_soc"] == "Chưa xảy ra phản ứng lạ + Lấy dấu hiệu sinh tồn"
    assert events["end"]["cham_soc"] == "Kết thúc truyền máu + Lấy dấu hiệu sinh tồn"
    assert all(e["needs_vitals"] for k, e in events.items() if k != "start")


def test_sinh_hieu_tu_giao_dien_duoc_dung_neu_hop_le():
    vitals = {
        "pre": {"mach": "82", "huyet_ap": "110/70", "nhip_tho": "20", "nhiet_do": "37"},
        "m15": {"mach": "abc", "huyet_ap": "120/80", "nhip_tho": "200", "nhiet_do": "37,5"},
        "start": {"mach": "90"},
    }
    events = {e["slot_key"]: e for e in _build_truyen_mau_events("14:00", "10/11/2026", vitals)}
    assert events["pre"]["vitals"] == {"mach": "82", "huyet_ap": "110/70", "nhip_tho": "20", "nhiet_do": "37"}
    # Ô sai bị bỏ (worker điền mặc định cho ô đó), ô đúng giữ nguyên.
    assert events["m15"]["vitals"] == {"huyet_ap": "120/80", "nhiet_do": "37,5"}
    # Mốc không lấy sinh hiệu thì không gửi sinh hiệu.
    assert "vitals" not in events["start"]
    assert "vitals" not in events["h1"]


def test_gio_sai_khong_tao_phieu():
    assert _build_truyen_mau_events("25:00", "10/11/2026") == []
    assert _build_truyen_mau_events("", "10/11/2026") == []
