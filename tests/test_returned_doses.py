# -*- coding: utf-8 -*-
"""Y lệnh EMR thật 05:00 04/11/2026: "x N" là số còn lại sau "+ Thuốc trả".

Lỗi cũ: PARACETAMOL x 1 túi (trả 2) vẫn sinh 3 cữ truyền 8h, 16h, 22h;
MIDEPIME x 1 lọ (trả 1) sinh 2 cữ 0,5 lọ; NEFOPAM x 1 ống (trả 1) sinh 2 cữ.
Bước nhập dịch truyền sẽ nhập thừa các cữ sau lên EMR.
"""
import json
import os
import tempfile
from pathlib import Path

from emr_parsers import extract_timeline_map_from_html
from processing.returned_doses import trim_returned_doses
from xu_ly import process_all

FIXTURE = Path(__file__).parent / "fixtures" / "y_lenh_thuoc_tra_20261104.html"


def _process():
    out, _ = extract_timeline_map_from_html(FIXTURE.read_text(encoding="utf-8"))
    day = out["04/11/2026"]
    records = [{
        "Mã BN": "TEST_TRA", "Họ tên": "BN TEST", "Bác sĩ": "", "Vi_Tri": "P01",
        "ngay_lam": "04/11/2026", "Diễn biến": day["Diễn biến"], "Y lệnh": day["Y lệnh"],
    }]
    with tempfile.TemporaryDirectory() as tmp:
        in_path = os.path.join(tmp, "in.json")
        out_path = os.path.join(tmp, "out.json")
        with open(in_path, "w", encoding="utf-8") as f:
            json.dump(records, f, ensure_ascii=False)
        process_all(in_path, output_file=out_path)
        with open(out_path, encoding="utf-8") as f:
            return json.load(f)[0]


def _hours(rec, cat, name):
    return [d.get("gio_dung") for d in rec["thuoc"][cat] if name in str(d.get("ten_thuoc") or "").upper()]


def test_returned_drugs_keep_only_first_doses():
    rec = _process()
    assert _hours(rec, "dich_truyen", "PARACETAMOL") == ["8 giờ"]
    assert _hours(rec, "dich_truyen", "NEFOPAM") == ["8 giờ"]
    assert _hours(rec, "thuoc_tiem", "MIDEPIME") == ["8 giờ"]
    # Thuốc không trả giữ nguyên.
    assert _hours(rec, "thuoc_uong", "ESOMEPRAZOL") == ["8 giờ"]
    assert rec["tong_hop_gio_dung"] == [8]
    assert len(rec["thuoc"]["thuoc_tra"]) == 5
    msgs = [w["message"] for w in rec["processing_warnings"] if w.get("code") == "RETURNED_DOSES_DROPPED"]
    assert any("PARACETAMOL" in m and "bỏ cữ 16h, 22h" in m for m in msgs)
    assert len(msgs) == 3


def test_no_returned_line_keeps_all_doses():
    drug = {"ten_thuoc": "PARACETAMOL 10MG/ML", "so_luong": "1", "gio_dung": "8 giờ, 16 giờ, 22 giờ"}
    assert trim_returned_doses([[drug]], []) == []
    other = [{"ten_thuoc": "Midepime 2g", "so_luong": "1"}]
    assert trim_returned_doses([[drug]], other) == []
    assert drug["gio_dung"] == "8 giờ, 16 giờ, 22 giờ"


def test_partial_return_of_multi_unit_doses():
    # Kê 6 lọ cho 3 cữ (2 lọ/cữ), trả 2 lọ -> còn 4 lọ = 2 cữ đầu.
    drug = {"ten_thuoc": "MIZAPENEM 0,5G", "so_luong": "4", "gio_dung": "8 giờ, 16 giờ, 23 giờ",
            "so_luong_moi_gio": {"8": 2, "16": 2, "23": 2}}
    warns = trim_returned_doses([[drug]], [{"ten_thuoc": "Mizapenem 0,5g", "so_luong": "2"}])
    assert len(warns) == 1
    assert drug["gio_dung"] == "8 giờ, 16 giờ"
    assert set(drug["so_luong_moi_gio"]) == {"8", "16"}
