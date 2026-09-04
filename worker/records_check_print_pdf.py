# -*- coding: utf-8 -*-
"""Tạo PDF bảng kiểm hồ sơ đã kiểm.

Input JSON:
{
  "rows": [
    {"ho_ten": "...", "so_luu_tru_in": "9370", "xq": 1, "mri": 0, "ct": 0, "storage_kind": "BT"}
  ]
}
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any, Dict, List

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer


def _font_candidates() -> List[tuple[str, str]]:
    return [
        ("Arial", r"C:\Windows\Fonts\arial.ttf"),
        ("Arial-Bold", r"C:\Windows\Fonts\arialbd.ttf"),
        ("DejaVu", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
        ("DejaVu-Bold", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
        ("NotoSans", "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf"),
        ("NotoSans-Bold", "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf"),
    ]


def register_fonts() -> tuple[str, str]:
    normal = "Helvetica"
    bold = "Helvetica-Bold"
    for name, path in _font_candidates():
        if os.path.exists(path):
            try:
                pdfmetrics.registerFont(TTFont(name, path))
                if name.endswith("-Bold"):
                    bold = name
                else:
                    normal = name
            except Exception:
                pass
    # Nếu chỉ có DejaVu regular/bold hoặc Arial regular/bold thì dùng đúng cặp.
    if "Arial" in pdfmetrics.getRegisteredFontNames():
        normal = "Arial"
    if "Arial-Bold" in pdfmetrics.getRegisteredFontNames():
        bold = "Arial-Bold"
    if normal == "Helvetica" and "DejaVu" in pdfmetrics.getRegisteredFontNames():
        normal = "DejaVu"
    if bold == "Helvetica-Bold" and "DejaVu-Bold" in pdfmetrics.getRegisteredFontNames():
        bold = "DejaVu-Bold"
    return normal, bold


def clean_text(value: Any) -> str:
    return " ".join(str(value or "").split()).strip()


def as_int(value: Any) -> int:
    try:
        return int(float(str(value or "0").strip()))
    except Exception:
        return 0


def storage_print(row: Dict[str, Any]) -> str:
    val = clean_text(row.get("so_luu_tru_in") or row.get("storage_print"))
    if val:
        return val
    raw = clean_text(row.get("so_luu_tru") or row.get("storage"))
    parts = [p.strip() for p in raw.split("/") if p.strip()]
    if len(parts) >= 2 and parts[1].isdigit():
        return str(int(parts[1]))
    return raw


def storage_kind(row: Dict[str, Any]) -> str:
    kind = clean_text(row.get("storage_kind")).upper()
    if kind in {"BT", "TN"}:
        return kind
    raw = clean_text(row.get("so_luu_tru") or row.get("storage")).upper()
    if "/BT/" in raw or raw.endswith("/BT"):
        return "BT"
    if "/TN/" in raw or raw.endswith("/TN"):
        return "TN"
    return "KHAC"


def sort_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    rank = {"BT": 0, "TN": 1, "KHAC": 2}

    def key(row: Dict[str, Any]):
        sp = storage_print(row)
        try:
            sp_num = int(sp)
        except Exception:
            sp_num = 999999999
        return (rank.get(storage_kind(row), 9), sp_num, clean_text(row.get("ho_ten")).lower())

    return sorted(rows, key=key)


def make_pdf(input_path: str, out_path: str) -> None:
    normal_font, bold_font = register_fonts()
    with open(input_path, "r", encoding="utf-8") as f:
        payload = json.load(f)
    rows = payload.get("rows") if isinstance(payload, dict) else payload
    title = clean_text(payload.get("title")) if isinstance(payload, dict) else ""
    subtitle = clean_text(payload.get("subtitle")) if isinstance(payload, dict) else ""
    if not isinstance(rows, list):
        rows = []
    rows = [r for r in rows if isinstance(r, dict)]
    rows = sort_rows(rows)

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "TitleVN",
        parent=styles["Title"],
        fontName=bold_font,
        fontSize=15,
        leading=18,
        alignment=TA_CENTER,
        spaceAfter=3 * mm,
    )
    cell_style = ParagraphStyle(
        "CellVN",
        parent=styles["BodyText"],
        fontName=normal_font,
        fontSize=10,
        leading=12,
        alignment=TA_LEFT,
    )
    center_style = ParagraphStyle(
        "CenterVN",
        parent=cell_style,
        alignment=TA_CENTER,
    )

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    doc = SimpleDocTemplate(
        str(out),
        pagesize=landscape(A4),
        leftMargin=12 * mm,
        rightMargin=12 * mm,
        topMargin=10 * mm,
        bottomMargin=10 * mm,
        title="Kiểm hồ sơ",
    )

    story = [Paragraph(title or "DANH SÁCH KIỂM HỒ SƠ ĐÃ KIỂM", title_style)]
    if subtitle:
        subtitle_style = ParagraphStyle(
            "SubtitleVN",
            parent=styles["BodyText"],
            fontName=normal_font,
            fontSize=10,
            leading=12,
            alignment=TA_CENTER,
            spaceAfter=2 * mm,
        )
        story.append(Paragraph(subtitle, subtitle_style))
    story.append(Spacer(1, 2 * mm))
    data = [[
        Paragraph("Họ và tên", center_style),
        Paragraph("Số lưu trữ", center_style),
        Paragraph("XQ", center_style),
        Paragraph("MRI", center_style),
        Paragraph("CT", center_style),
    ]]

    for row in rows:
        data.append([
            Paragraph(clean_text(row.get("ho_ten") or row.get("name")), cell_style),
            Paragraph(storage_print(row), center_style),
            Paragraph(str(as_int(row.get("xq") or row.get("so_xq"))), center_style),
            Paragraph(str(as_int(row.get("mri") or row.get("so_mri"))), center_style),
            Paragraph(str(as_int(row.get("ct") or row.get("so_ct"))), center_style),
        ])

    table = Table(data, colWidths=[122 * mm, 45 * mm, 25 * mm, 25 * mm, 25 * mm], repeatRows=1)
    table.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, 0), bold_font),
        ("FONTNAME", (0, 1), (-1, -1), normal_font),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F3F4F6")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#111827")),
        ("ALIGN", (1, 0), (-1, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#111827")),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(table)
    doc.build(story)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    make_pdf(args.input, args.out)
    print(json.dumps({"status": "ok", "out": args.out}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
