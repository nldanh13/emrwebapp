# -*- coding: utf-8 -*-
"""Tạo PDF danh sách xếp phòng, không chứa giá giường."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any, Dict, List
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import BaseDocTemplate, Frame, KeepTogether, PageTemplate, Paragraph, Spacer


def clean(value: Any) -> str:
    return " ".join(str(value or "").split()).strip()


def register_fonts() -> tuple[str, str]:
    candidates = [
        ("Arial", r"C:\Windows\Fonts\arial.ttf"),
        ("Arial-Bold", r"C:\Windows\Fonts\arialbd.ttf"),
        ("DejaVu", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
        ("DejaVu-Bold", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
    ]
    for name, file_path in candidates:
        if os.path.exists(file_path):
            try:
                pdfmetrics.registerFont(TTFont(name, file_path))
            except Exception:
                pass
    registered = set(pdfmetrics.getRegisteredFontNames())
    if "Arial" in registered:
        return "Arial", "Arial-Bold" if "Arial-Bold" in registered else "Arial"
    if "DejaVu" in registered:
        return "DejaVu", "DejaVu-Bold" if "DejaVu-Bold" in registered else "DejaVu"
    return "Helvetica", "Helvetica-Bold"


def room_number(room: str) -> int:
    import re
    match = re.search(r"(\d+)", room)
    return int(match.group(1)) if match else 10**9


def display_room(room: str) -> str:
    import re
    match = re.fullmatch(r"P0*(\d+)", room, flags=re.IGNORECASE)
    return f"P{int(match.group(1))}" if match else room


def grouped_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    groups: Dict[str, List[Dict[str, str]]] = {}
    for row in rows:
        room = clean(row.get("room") or row.get("Vi_Tri") or row.get("vi_tri"))
        if not room:
            continue
        groups.setdefault(room, []).append({
            "name": clean(row.get("name") or row.get("Họ tên") or row.get("ho_ten") or row.get("id")),
            "transfer_date": clean(row.get("transfer_date") or row.get("NgayChuyenPhong")),
            "occupancy": clean(row.get("occupancy") or row.get("DangKyPhong")),
        })
    result = []
    for room, patients in groups.items():
        patients.sort(key=lambda item: item["name"].lower())
        result.append({"room": room, "display_room": display_room(room), "patients": patients})
    result.sort(key=lambda item: (room_number(item["room"]), item["room"].lower()))
    return result


def make_pdf(input_path: str, output_path: str) -> None:
    with open(input_path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    rows = payload.get("rows", []) if isinstance(payload, dict) else []
    groups = grouped_rows([row for row in rows if isinstance(row, dict)])
    if not groups:
        raise ValueError("Không có người bệnh đã xếp phòng để tạo PDF.")

    normal, bold = register_fonts()
    styles = getSampleStyleSheet()
    room_style = ParagraphStyle(
        "Room", parent=styles["Heading3"], fontName=bold, fontSize=13,
        leading=15, textColor=colors.HexColor("#111827"),
        backColor=colors.HexColor("#F3F4F6"), borderPadding=(4, 5, 4, 5),
        spaceAfter=2 * mm,
    )
    patient_style = ParagraphStyle(
        "Patient", parent=styles["BodyText"], fontName=normal, fontSize=10.5,
        leading=13, leftIndent=2 * mm, spaceAfter=1.2 * mm,
    )
    note_style = ParagraphStyle(
        "Note", parent=patient_style, fontSize=7.8, leading=9.5,
        textColor=colors.HexColor("#4B5563"), leftIndent=5 * mm,
    )

    page_width, page_height = landscape(A4)
    left = right = 10 * mm
    top = 24 * mm
    bottom = 10 * mm
    gap = 7 * mm
    frame_width = (page_width - left - right - 2 * gap) / 3
    frames = [
        Frame(left + index * (frame_width + gap), bottom, frame_width, page_height - top - bottom,
              leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0, id=f"col{index}")
        for index in range(3)
    ]
    patient_count = sum(len(group["patients"]) for group in groups)
    generated = clean(payload.get("generated_label")) if isinstance(payload, dict) else ""

    def draw_header(canvas, _doc):
        canvas.saveState()
        canvas.setFont(bold, 16)
        canvas.drawString(left, page_height - 12 * mm, "DANH SÁCH XẾP PHÒNG")
        canvas.setFont(normal, 9)
        summary = f"{len(groups)} phòng · {patient_count} người bệnh"
        if generated:
            summary += f" · {generated}"
        canvas.drawRightString(page_width - right, page_height - 12 * mm, summary)
        canvas.setStrokeColor(colors.HexColor("#111827"))
        canvas.line(left, page_height - 15 * mm, page_width - right, page_height - 15 * mm)
        canvas.restoreState()

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    doc = BaseDocTemplate(
        str(output), pagesize=landscape(A4), leftMargin=left, rightMargin=right,
        topMargin=top, bottomMargin=bottom, title="Danh sách xếp phòng",
    )
    doc.addPageTemplates([PageTemplate(id="ward-list", frames=frames, onPage=draw_header)])

    story = []
    for group in groups:
        block = [Paragraph(escape(group["display_room"]), room_style)]
        for patient in group["patients"]:
            block.append(Paragraph(escape(clean(patient["name"]) or "Chưa có tên"), patient_style))
            notes = []
            if patient["transfer_date"]:
                notes.append(f"Chuyển phòng {escape(patient['transfer_date'])}")
            if patient["occupancy"]:
                notes.append(f"Đăng ký {escape(patient['occupancy'])} người")
            if notes:
                block.append(Paragraph(" · ".join(notes), note_style))
        block.append(Spacer(1, 3 * mm))
        story.append(KeepTogether(block))
    doc.build(story)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    make_pdf(args.input, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
