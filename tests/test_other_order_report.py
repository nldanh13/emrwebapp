# -*- coding: utf-8 -*-
"""Báo cáo in riêng "Y lệnh khác": giữ nguyên văn ô Y lệnh khác của từng phiếu
(txtYLenhKhacThamKham), kèm giờ phiếu và bác sĩ. Hiển thị/in ở
scripts/other_order_report_test.js và src/components/report/otherOrderReport.test.js.
"""
import json
import os
import tempfile

from processing.order_events import extract_other_order_block


def test_extract_block_stops_at_next_section_and_keeps_tt_lines():
    text = (
        "08:00 | Bác sĩ: BS A\n"
        "+ Y lệnh khác:\n"
        "Mời BS gây mê khám trước mổ\n"
        "+ (TT) Paracetamol 1g 01 túi TTM 8h\n"
        "+ Thuốc:\n"
        "Cefazolin 1g x 2 (Lọ)\n"
    )
    assert extract_other_order_block(text, doc_name="BS A", order_header_time="08:00") == [{
        "gio_y_lenh": "08:00", "bac_si": "BS A",
        "noi_dung": "Mời BS gây mê khám trước mổ\n+ (TT) Paracetamol 1g 01 túi TTM 8h",
    }]
    assert extract_other_order_block("08:00 | Bác sĩ: BS A\n+ Thuốc:\nCefazolin x 2") == []


def test_process_all_keeps_each_slip_other_orders():
    from xu_ly import process_all

    records = [{
        "Mã BN": "YLK1", "Họ tên": "BN TEST", "Bác sĩ": "BS A", "Vi_Tri": "P10", "ngay_lam": "07/11/2026",
        "Diễn biến": "",
        "Y lệnh": (
            "08:00 | Bác sĩ: BS A\n"
            "+ Y lệnh khác:\n"
            "Nhịn ăn chuẩn bị mổ\n"
            "+ Thuốc:\n"
            "Cefazolin 1g x 2 (Lọ)\n"
            "Tiêm tĩnh mạch 8h 20h\n"
            "---\n"
            "14:30 | Bác sĩ: BS B\n"
            "+ Y lệnh khác:\n"
            "Chụp X-quang kiểm tra sau mổ\n"
        ),
    }]
    with tempfile.NamedTemporaryFile("w", suffix=".json", encoding="utf-8", delete=False) as f:
        json.dump(records, f, ensure_ascii=False)
        in_path = f.name
    out_path = in_path.replace(".json", "_out.json")
    try:
        process_all(in_path, output_file=out_path)
        with open(out_path, encoding="utf-8") as f:
            rows = json.load(f)
    finally:
        for p in (in_path, out_path):
            try:
                os.unlink(p)
            except OSError:
                pass
    items = [it for r in rows if r.get("ma_bn") == "YLK1" for it in (r.get("y_lenh_khac_goc") or [])]
    assert [(i["gio_y_lenh"], i["bac_si"], i["noi_dung"]) for i in items] == [
        ("08:00", "BS A", "Nhịn ăn chuẩn bị mổ"),
        ("14:30", "BS B", "Chụp X-quang kiểm tra sau mổ"),
    ]
