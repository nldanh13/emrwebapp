# -*- coding: utf-8 -*-
"""Y lệnh thay băng chưa lên mã DVKT: không ghi "Thay băng vết mổ (CHƯA LÊN MÃ)"
vào phiếu chăm sóc khi nhập EMR, chỉ để cảnh báo bên ngoài.

Màn xem trước cùng quy tắc: scripts/uncoded_dressing_test.js.
"""
from pathlib import Path

from processing.procedure_parser import extract_procedures_detailed

ROOT = Path(__file__).resolve().parents[1]


def test_parser_warns_without_placeholder_action():
    ck, _ = extract_procedures_detailed("- Thay băng hằng ngày\n- Theo dõi", {}, "20/10/2026")
    assert ck["thay_bang_cat_chi"] == []
    assert any("chưa lên Mã DVKT" in w for w in ck["canh_bao"])
    assert not any("CHƯA LÊN MÃ" in str(x) for x in ck["thay_bang_cat_chi"])


def test_parser_keeps_coded_dressing():
    ck, _ = extract_procedures_detailed("+ Chỉ định DVKT:\n- Thay băng vết mổ chiều dài ≤ 15cm", {}, "20/10/2026")
    assert ck["thay_bang_cat_chi"] and "CHƯA LÊN MÃ" not in ck["thay_bang_cat_chi"][0]["ten"]
    assert not ck["canh_bao"]


def test_input_care_drops_old_placeholder():
    import input_care

    assert input_care._is_uncoded_dressing({"ten": "Thay băng vết mổ (CHƯA LÊN MÃ)"})
    assert input_care._is_uncoded_dressing("thay băng (chua len ma)")
    assert not input_care._is_uncoded_dressing({"ten": "Thay băng vết mổ chiều dài ≤ 15cm"})
    src = (ROOT / "worker" / "input_care.py").read_text(encoding="utf-8")
    block = src[src.index("def _drop_actions_before_work_start_same_date"):src.index("vltl = cleaned.get('vat_ly_tri_lieu')")]
    assert "_is_uncoded_dressing(item)" in block


def test_sanity_check_no_duplicate_dressing_warning():
    src = (ROOT / "worker" / "processing" / "validators" / "sanity_check.py").read_text(encoding="utf-8")
    assert "and not uncoded_dressing" in src
