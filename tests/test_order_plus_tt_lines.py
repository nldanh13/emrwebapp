# -*- coding: utf-8 -*-
"""Y lệnh EMR thật (10/2026): thuốc tự túc ghi "+ (TT) ..." trong "+ Y lệnh khác:"
và hai thuốc liền nhau cùng một dòng cách dùng.

Lỗi cũ:
- "+ (TT) Amiparen ..." bị coi là tiêu đề nhóm nên mất cả 4 thuốc tự túc.
- Ô y lệnh của phiếu chăm sóc bỏ mọi dòng trùng chữ: BETALOC mất dòng
  "Uống mỗi ngày, sáng 1 viên(6 giờ)." vì COVERAM đã có dòng y hệt.
"""
import json
import os
import tempfile
from pathlib import Path

from emr_parsers import extract_timeline_map_from_html
from processing.order_events import build_raw_order_events, classify_raw_order_line
from xu_ly import process_all
from xu_ly_merge import _merge_multiline

FIXTURE = Path(__file__).parent / "fixtures" / "y_lenh_tt_plus_lines.html"


def _order_text():
    right_col = FIXTURE.read_text(encoding="utf-8")
    html = (
        '<div class="vertical-timeline-block"><label>15/10/2026 08:00</label>'
        '<b>Bác sĩ: BS TEST</b><div id="hide1">'
        '<div class="col-sm-6"><textarea></textarea></div>'
        f"{right_col}</div></div>"
    )
    out, _ = extract_timeline_map_from_html(html)
    return out["15/10/2026"]["Y lệnh"]


def _process():
    records = [{
        "Mã BN": "TEST_TT", "Họ tên": "BN TEST", "Bác sĩ": "BS TEST", "Vi_Tri": "P01",
        "ngay_lam": "15/10/2026", "Diễn biến": "", "Y lệnh": _order_text(),
    }]
    with tempfile.TemporaryDirectory() as tmp:
        in_path = os.path.join(tmp, "in.json")
        out_path = os.path.join(tmp, "out.json")
        with open(in_path, "w", encoding="utf-8") as f:
            json.dump(records, f, ensure_ascii=False)
        process_all(in_path, output_file=out_path)
        with open(out_path, encoding="utf-8") as f:
            return json.load(f)[0]


def _names(rec, cat):
    return [str(d.get("ten_thuoc") or "").upper() for d in rec["thuoc"].get(cat, [])]


def test_plus_tt_lines_are_parsed_as_self_paid_drugs():
    rec = _process()
    infusions = _names(rec, "dich_truyen")
    oral = _names(rec, "thuoc_uong")
    assert any("AMIPAREN" in n for n in infusions)
    for name in ("BIOACIMIN", "OMEGA 3", "GLUCERNA"):
        assert any(name in n for n in oral), name
    tt = [d for d in rec["thuoc"]["thuoc_uong"] if "GLUCERNA" in str(d.get("ten_thuoc")).upper()][0]
    assert tt.get("tu_tuc") is True
    assert tt.get("gio_dung") == "8 giờ, 16 giờ"
    assert not any("AMIPAREN" in str(w.get("message", "")).upper() for w in rec["processing_warnings"])


def test_care_order_text_keeps_repeated_usage_line_of_next_drug():
    text = _process()["nhap_cham_soc"]["y_lenh"].splitlines()
    i = next(k for k, ln in enumerate(text) if ln.startswith("BETALOC ZOK"))
    assert text[i + 1] == "Uống mỗi ngày, sáng 1 viên(6 giờ)."
    assert sum(1 for ln in text if ln == "Pha Mizapenem.") == 2


def test_merge_multiline_drops_only_identical_blocks_and_adjacent_repeats():
    a = "THUOC A x 1\nUống sáng\nTHUOC B x 1\nUống sáng"
    assert _merge_multiline([a, a]) == a
    assert _merge_multiline(["X\nX\nY"]) == "X\nY"
    assert _merge_multiline(["A\nUống sáng", "B\nUống sáng"]) == "A\nUống sáng\nB\nUống sáng"


def test_raw_event_kind_for_plus_tt_line():
    assert classify_raw_order_line("+ Y lệnh khác:") == "section"
    assert classify_raw_order_line("+ (TT) Amiparen 10% 200 ml 1 chai TTM XX g/ph x 2 lần") == "infusion_usage"
    assert classify_raw_order_line("+ (TT) Glucerna 1 chai uống xen kẽ ăn x 2 lần 8-16h") == "oral_usage"
    kinds = [e["kind"] for e in build_raw_order_events(_order_text())]
    assert kinds.count("section") == 4  # Y lệnh khác, Thuốc x2, Chỉ định DVKT
