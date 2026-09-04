# -*- coding: utf-8 -*-
"""Tạo PDF bảng kiểm hồ sơ đã kiểm / danh sách bàn giao hồ sơ giấy cho KHTH.

Input JSON:
{
  "delivered_by": "Nguyễn Văn A",       # tùy chọn — người giao, in lặp mỗi dòng
  "rows": [
    {
      "ho_ten": "...", "so_luu_tru_in": "9370", "xq": 1, "mri": 0, "ct": 0, "storage_kind": "BT",
      "discharge_date": "21/05/2026", "handover_deadline": "2026-05-23T13:00:00+07:00",
      "ksd_status": "PENDING", "gpb_status": "NOT_ORDERED", "cover_note": "..."
    }
  ]
}

Các trường discharge_date/handover_deadline/ksd_status/gpb_status/cover_note là
tùy chọn — hồ sơ cũ hoặc PDF nội bộ "đã kiểm" không có vẫn in được, chỉ để
trống ô tương ứng, không suy đoán giá trị.
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


KSD_GPB_LABELS = {
    "NOT_ORDERED": "Không chỉ định",
    "PENDING": "Chưa có KQ",
    "COMPLETED": "Đã có KQ",
    "UNKNOWN": "Chưa rõ",
}


def ksd_gpb_label(value: Any) -> str:
    return KSD_GPB_LABELS.get(clean_text(value).upper(), "—")


def format_deadline(value: Any) -> str:
    """Định dạng hạn 48h (ISO có múi giờ) sang dd/mm/yyyy HH:MM. Không tự bịa
    giờ nếu input rỗng/không parse được — trả về rỗng để cột hiển thị trống."""
    raw = clean_text(value)
    if not raw:
        return ""
    try:
        from datetime import datetime
        # Chấp nhận "...+07:00" hoặc "...Z"
        text = raw.replace("Z", "+00:00")
        dt = datetime.fromisoformat(text)
        return dt.strftime("%d/%m/%Y %H:%M")
    except Exception:
        return raw


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
    delivered_by = clean_text(payload.get("delivered_by")) if isinstance(payload, dict) else ""
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
        fontSize=8,
        leading=10,
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
    headers = [
        "STT", "Họ và tên", "Số lưu trữ", "Ngày ra viện", "Hạn 48h",
        "XQ", "CT", "MRI", "KSĐ", "GPB", "Ghi chú nợ kết quả",
        "Người giao", "Người nhận ký xác nhận",
    ]
    data = [[Paragraph(h, center_style if h not in ("Họ và tên", "Ghi chú nợ kết quả") else cell_style) for h in headers]]

    for idx, row in enumerate(rows, start=1):
        data.append([
            Paragraph(str(idx), center_style),
            Paragraph(clean_text(row.get("ho_ten") or row.get("name")), cell_style),
            Paragraph(storage_print(row), center_style),
            Paragraph(clean_text(row.get("discharge_date") or row.get("ngay_ra_vien")), center_style),
            Paragraph(format_deadline(row.get("handover_deadline")), center_style),
            Paragraph(str(as_int(row.get("xq") or row.get("so_xq"))), center_style),
            Paragraph(str(as_int(row.get("ct") or row.get("so_ct"))), center_style),
            Paragraph(str(as_int(row.get("mri") or row.get("so_mri"))), center_style),
            Paragraph(ksd_gpb_label(row.get("ksd_status")), center_style),
            Paragraph(ksd_gpb_label(row.get("gpb_status")), center_style),
            Paragraph(clean_text(row.get("cover_note")), cell_style),
            Paragraph(clean_text(row.get("delivered_by")) or delivered_by, center_style),
            Paragraph("", center_style),
        ])

    col_widths = [8*mm, 42*mm, 18*mm, 20*mm, 26*mm, 9*mm, 9*mm, 9*mm, 18*mm, 18*mm, 32*mm, 18*mm, 22*mm]
    table = Table(data, colWidths=col_widths, repeatRows=1)
    table.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, 0), bold_font),
        ("FONTNAME", (0, 1), (-1, -1), normal_font),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F3F4F6")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#111827")),
        ("ALIGN", (2, 0), (-1, -1), "CENTER"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#111827")),
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
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
