"""Đọc "Giấy chứng nhận nghỉ việc hưởng BHXH" (ngoại trú / phòng khám, mẫu 07)
từ file PDF mà EMR xuất ra khi bấm "Xem phiếu".

Khác với file Excel BHXH (thiếu Số KCB, Số seri, CCCD), bản PDF phiếu phòng khám
chứa đầy đủ các trường — kể cả Số KCB, Số seri, Số CCCD và ngày cấp CCCD — nên
dùng làm nguồn dữ liệu để điền lên cổng BHXH (mẫu 07) thì không còn thiếu gì.

Tách làm 2 lớp để test được mà không cần thư viện PDF:
- ``parse_phieu_text(text)``: nhận text đã trích, trả về {doc_type, fields, raw}.
- ``extract_pdf_text(path)`` / ``parse_phieu_pdf(path)``: trích text từ PDF rồi gọi lớp trên.
"""

from __future__ import annotations

import re
from pathlib import Path

from .mapping import DOC_BHXH


class PhieuPdfError(Exception):
    """Lỗi đọc phiếu PDF, kèm thông báo tiếng Việt cho người dùng."""


# Dấu hiệu nhận biết đúng loại phiếu (ngoại trú / phòng khám).
MARKER_NGOAI_TRU = "điều trị ngoại trú"
MARKER_GCN = "giấy chứng nhận"


def _first(pattern: str, text: str, flags: int = re.IGNORECASE) -> str:
    m = re.search(pattern, text, flags)
    if not m:
        return ""
    # Nếu regex có nhóm bắt thì lấy nhóm 1, không thì lấy cả match.
    return (m.group(1) if m.groups() else m.group(0)).strip()


def _collapse(value: str) -> str:
    """Gộp khoảng trắng và xuống dòng (đơn vị làm việc hay bị xuống dòng giữa chừng)."""
    return re.sub(r"\s+", " ", value).strip()


def parse_phieu_text(text: str) -> dict:
    """Tách các trường từ text của phiếu. Trả về {doc_type, mau_so, fields, raw}.

    Dùng match ĐẦU TIÊN cho mỗi trường nên bản in 2 liên (Liên số 1 / Liên số 2)
    cũng chỉ lấy một lần.
    """
    if not text or not text.strip():
        raise PhieuPdfError("Không đọc được nội dung phiếu (PDF trống hoặc là ảnh scan).")

    low = text.lower()
    if MARKER_GCN not in low:
        raise PhieuPdfError(
            "File không phải Giấy chứng nhận nghỉ việc hưởng BHXH (không thấy tiêu đề)."
        )
    if MARKER_NGOAI_TRU not in low:
        raise PhieuPdfError(
            "Phiếu này không phải loại ngoại trú/phòng khám (mẫu 07). "
            "Giấy ra viện (nội trú) đọc theo đường khác."
        )

    # Mã số BHXH / Số thẻ BHYT nằm chung một dòng, ngăn bởi dấu "/".
    ma_bhxh = ma_the = ""
    m = re.search(
        r"Mã số BHXH\s*/\s*Số thẻ\s*BH[A-Z]{2}:\s*([0-9A-Za-z]+)\s*/\s*([0-9A-Za-z]+)",
        text,
        re.IGNORECASE,
    )
    if m:
        ma_bhxh, ma_the = m.group(1).strip(), m.group(2).strip()

    # Đơn vị làm việc: lấy tới trước "Ngày khám bệnh", gộp các dòng bị ngắt.
    ten_dv = ""
    m = re.search(
        r"Đơn vị làm việc:\s*(.+?)\s*Ngày khám",
        text,
        re.IGNORECASE | re.DOTALL,
    )
    if m:
        ten_dv = _collapse(m.group(1))

    # Chẩn đoán: khối nằm giữa mục II và "Số ngày nghỉ".
    chan_doan = ""
    m = re.search(
        r"II\.\s*Chẩn đoán[^\n]*\n(.+?)\s*Số ngày nghỉ",
        text,
        re.IGNORECASE | re.DOTALL,
    )
    if m:
        chan_doan = _collapse(m.group(1)).strip(" ,")

    # Khoảng thời gian nghỉ.
    tu_ngay = den_ngay = ""
    m = re.search(
        r"Từ ngày\s*([0-9/]+)\s*đến hết ngày\s*([0-9/]+)",
        text,
        re.IGNORECASE,
    )
    if m:
        tu_ngay, den_ngay = m.group(1).strip(), m.group(2).strip()

    # Ngày cấp giấy: "Ngày 10 tháng 10 năm 2026" -> 10/10/2026.
    ngay_ct = ""
    m = re.search(r"Ngày\s*(\d{1,2})\s*tháng\s*(\d{1,2})\s*năm\s*(\d{4})", text, re.IGNORECASE)
    if m:
        d, mth, y = m.group(1), m.group(2), m.group(3)
        ngay_ct = f"{int(d):02d}/{int(mth):02d}/{y}"

    # Số: 260004779/KCB -> lấy phần số trước "/".
    so_cert = _first(r"Số:\s*([0-9A-Za-z/]+)", text)
    so_kcb = so_cert.split("/")[0].strip() if so_cert else ""

    fields = {
        "mau_so": "07",
        "so_kcb": so_kcb,
        "so_seri": _first(r"Số seri:\s*([0-9A-Za-z]+)", text),
        "ma_bhxh": ma_bhxh,
        "ma_the": ma_the,
        "ho_ten": _first(r"Họ và tên:[ \t]*(.+)", text),
        "ngay_sinh": _first(r"Ngày sinh:\s*([0-9/]+)", text),
        "gioi_tinh": _first(r"Giới tính:\s*(\S+)", text),
        "so_cccd": _first(r"Số CCCD[^:]*:\s*([0-9]+)", text),
        "ngaycap_cccd": _first(r"Ngày cấp:\s*([0-9/]+)", text),
        "ten_dv": ten_dv,
        "ngay_kcb": _first(r"Ngày khám bệnh[^:]*:\s*([0-9/]+)", text),
        "chan_doan": chan_doan,
        "so_ngay_nghi": _first(r"Số ngày nghỉ:\s*(\d+)", text),
        "tu_ngay": tu_ngay,
        "den_ngay": den_ngay,
        "ngay_ct": ngay_ct,
        "ho_ten_cha": _first(r"Họ và tên cha:[ \t]*(.*)", text),
        "ho_ten_me": _first(r"Họ và tên mẹ:[ \t]*(.*)", text),
    }
    # Bỏ các trường rỗng để không ghi đè giá trị đã có bằng chuỗi trống.
    fields = {k: v for k, v in fields.items() if v}

    return {"doc_type": DOC_BHXH, "mau_so": "07", "fields": fields, "raw": {"text": text}}


def extract_pdf_text(path: str | Path) -> str:
    """Trích text từ PDF. Cần thư viện pdfminer.six."""
    try:
        from pdfminer.high_level import extract_text
    except ImportError as exc:  # pragma: no cover - phụ thuộc môi trường
        raise PhieuPdfError(
            "Thiếu thư viện đọc PDF. Cài bằng: pip install pdfminer.six"
        ) from exc
    try:
        return extract_text(str(path)) or ""
    except Exception as exc:  # pragma: no cover - lỗi file
        raise PhieuPdfError(f"Không mở được file PDF: {exc}") from exc


def parse_phieu_pdf(path: str | Path) -> dict:
    """Đọc trực tiếp từ file PDF phiếu phòng khám."""
    return parse_phieu_text(extract_pdf_text(path))
