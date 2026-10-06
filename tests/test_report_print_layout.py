# -*- coding: utf-8 -*-
"""Phiếu in (Phiếu thực hiện thuốc): ảnh 06/10/2026 — mỗi cữ một dòng (bậc thang), mỗi người bệnh một
bộ cột giờ khác nhau, tên thuốc bị cắt, "tự túc" đè lên đường dùng."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker"))

from generate_report import build_cards_from_rows, render_pdf  # noqa: E402

DATE = "06/10/2026"


def row(**kw):
    base = {"room": "P05", "patientName": "TRAN NGUYEN NHUT MINH", "patientId": "26097508", "date": DATE,
            "route": "Uống", "unit": "viên", "quantity": 1}
    base.update(kw)
    return base


def test_one_row_per_drug_with_a_box_per_dose():
    cards = build_cards_from_rows([
        row(drugName="PARATRAMOL", time="08:00"),
        row(drugName="PARATRAMOL", time="16:00"),
        row(drugName="PARATRAMOL", time="22:00"),
        row(drugName="TV-ZIDIM 1G (1 lọ)", route="TMC", unit="lọ", time="08:00"),
        row(drugName="TV-ZIDIM 1G (1 lọ)", route="TMC", unit="lọ", time="20:00"),
    ], report_date=DATE)
    names = [r["name"] for r in cards[0]["rows"]]
    assert names.count("PARATRAMOL") == 1
    para = next(r for r in cards[0]["rows"] if r["name"] == "PARATRAMOL")
    assert para["hours"] == {"08:00", "16:00", "22:00"}
    assert para["so_lo_map"] == {"08:00": 1, "16:00": 1, "22:00": 1}


def test_two_orders_same_slot_stay_separate():
    cards = build_cards_from_rows([
        row(drugName="VANCOMYCIN 500mg", route="TTM", time="20:00", possibleDuplicate=True),
        row(drugName="VANCOMYCIN 500mg", route="TTM", time="20:00", possibleDuplicate=True),
    ], report_date=DATE)
    assert len(cards[0]["rows"]) == 2
    assert all("kiểm tra trùng y lệnh" in r["flags"] for r in cards[0]["rows"])


def test_self_paid_and_untimed_are_notes_not_route():
    cards = build_cards_from_rows([
        row(drugName="Concor 2.5mg", time="06:00", tuTuc=True),
        row(drugName="AMIPAREN 10%", route="TTM", unit="túi", time="—", noTime=True, duplicateOf="20:00"),
    ], report_date=DATE)
    concor, amiparen = cards[0]["rows"]
    assert concor["abbr"] == "Uống" and "tự túc" in concor["flags"]
    assert amiparen["abbr"] == "TTM"
    assert any("chưa rõ giờ" in f for f in amiparen["flags"])
    assert any("có thể trùng" in f for f in amiparen["flags"])


def test_pdf_renders_long_names_and_shared_columns(tmp_path):
    rows = [
        row(drugName="VANCOMYCIN + Sodium chloride 0.9% pha truyền trong 60 phút", route="TTM", unit="lọ", time="20:00", patientName="NGUYEN VAN LUC", patientId="1"),
        row(drugName="Thay băng, cắt chỉ vết mổ [chi tiết dài]", route="Khác", unit="", time="10:13", patientName="NGUYEN VAN LUC", patientId="1"),
        row(drugName="PARATRAMOL", time="08:00"),
        row(drugName="PARATRAMOL", time="16:00"),
        row(drugName="AMIPAREN 10%", route="TTM", unit="túi", time="—", noTime=True),
    ]
    cards = build_cards_from_rows(rows, report_date=DATE)
    out = tmp_path / "phieu.pdf"
    render_pdf(cards, str(out), 0, 23, f"{DATE} 17:13", DATE)
    data = out.read_bytes()
    assert data.startswith(b"%PDF")
