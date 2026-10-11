"""Đọc "Giấy ra viện" (nội trú, cổng BHXH mẫu 03) từ file PDF mà EMR in ra.

Cùng cách làm với pdf_phieu.py (phiếu phòng khám, mẫu 07): trích text của PDF rồi
tách từng trường theo nhãn in trên giấy, ánh xạ sang tên field nội bộ mà
bhyt/portal.py (_fill_grv) dùng để điền lên cổng BHXH.

Mẫu giấy ra viện theo Thông tư 18/2022/TT-BYT. Mỗi bệnh viện in hơi khác nhau
(nhãn có/không có "và", nhiều nhãn chung một dòng, ngày viết "ngày .. tháng .. năm"
hoặc "dd/mm/yyyy"), nên mỗi trường được tách theo nhãn và dừng ở nhãn kế tiếp,
không dựa vào vị trí dòng.

Tách làm 2 lớp để test được mà không cần thư viện PDF:
- ``parse_grv_text(text)``: nhận text đã trích, trả về {doc_type, mau_so, fields, raw}.
- ``parse_grv_pdf(path)``: trích text từ PDF rồi gọi lớp trên.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Iterable

from .mapping import DEFAULT_DOCTORS, DOC_GRV, normalize_text
from .pdf_phieu import PhieuPdfError, extract_pdf_text


MARKER_GRV = "giay ra vien"

# Nhãn in trên giấy ra viện. Mỗi trường lấy từ sau nhãn tới nhãn kế tiếp (hoặc hết dòng).
_LABELS = {
    "ma_khoa": r"Khoa",
    "so_seri": r"Mã y tế",
    "ma_ct": r"Số lưu trữ",
    "ho_ten": r"Họ (?:và )?tên người bệnh",
    "ngay_sinh": r"(?:Ngày/tháng/năm sinh|Ngày,? tháng,? năm sinh|Ngày sinh|Năm sinh)",
    "gioi_tinh": r"(?:Nam/Nữ|Giới tính|Giới)",
    "dan_toc": r"Dân tộc",
    "nghe_nghiep": r"Nghề nghiệp",
    "the": r"Mã số BHXH\s*/\s*(?:Số\s*)?thẻ BHYT(?: số)?",
    "dia_chi": r"Địa chỉ",
    "vao_vien": r"Vào viện(?: lúc)?",
    "ra_vien": r"Ra viện(?: lúc)?",
    "chan_doan": r"Chẩn đoán",
    "pp_dieutri": r"Phương pháp điều trị",
    "ghi_chu": r"Ghi chú",
    "ho_ten_cha": r"Họ (?:và )?tên cha",
    "ho_ten_me": r"Họ (?:và )?tên mẹ(?:\s*/\s*người nuôi dưỡng)?",
    "tuoi_thai": r"Tuổi thai",
    "dc_thainghen": r"Đình chỉ thai nghén",
    "ngoai_tru": r"(?:Nghỉ|Điều trị) ngoại trú",
}

# Những dòng/nhãn chắc chắn kết thúc một khối nhiều dòng (chẩn đoán, địa chỉ…).
_BLOCK_END = (
    r"Thủ trưởng|Trưởng khoa|Người hành nghề"
    r"|^[^\n,:]*,?\s*ngày\s+\d{1,2}\s+tháng\s+\d{1,2}\s+năm"
)

# Nhãn ở đầu dòng: "- Họ tên người bệnh:" hoặc giữa dòng "... Dân tộc: Kinh".
_ANY_LABEL = "|".join(f"(?:{p})" for p in _LABELS.values())
_NEXT = rf"(?=(?:^|\s|-)(?:{_ANY_LABEL})\s*:|{_BLOCK_END})"


def _collapse(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip(" ,.;-\t\n")


def _field(text: str, key: str, multiline: bool = False) -> str:
    """Giá trị sau nhãn ``key`` tới nhãn kế tiếp. multiline=False thì dừng ở hết dòng."""
    label = _LABELS[key]
    tail = rf"(.*?){_NEXT}" if multiline else r"([^\n]*)"
    flags = re.IGNORECASE | re.MULTILINE | (re.DOTALL if multiline else 0)
    m = re.search(rf"(?:^|\s|-){label}\s*:\s*{tail}", text, flags)
    if not m:
        return ""
    value = m.group(1)
    if not multiline:
        # Nhiều nhãn chung một dòng: cắt ở nhãn kế tiếp.
        cut = re.search(rf"\s(?:{_ANY_LABEL})\s*:", value, re.IGNORECASE)
        if cut:
            value = value[: cut.start()]
    return _collapse(value)


def _to_date(value: str) -> str:
    """'8 giờ 30 phút, ngày 01 tháng 10 năm 2026' → '01/10/2026 08:30';
    '01/10/2026' → '01/10/2026'. Giữ đúng dạng file Excel BHXH (cell_text)."""
    value = value or ""
    date = ""
    m = re.search(r"ngày\s*(\d{1,2})\s*tháng\s*(\d{1,2})\s*năm\s*(\d{4})", value, re.IGNORECASE)
    if m:
        date = f"{int(m.group(1)):02d}/{int(m.group(2)):02d}/{m.group(3)}"
    else:
        m = re.search(r"(\d{1,2})[/-](\d{1,2})[/-](\d{4})", value)
        if m:
            date = f"{int(m.group(1)):02d}/{int(m.group(2)):02d}/{m.group(3)}"
    if not date:
        return ""
    t = re.search(r"(\d{1,2})\s*(?:giờ|h|:)\s*(\d{1,2})", value, re.IGNORECASE)
    if t and not re.match(r"\d{1,2}[/-]", value[t.start():]):
        return f"{date} {int(t.group(1)):02d}:{int(t.group(2)):02d}"
    return date


def _split_card(value: str) -> tuple[str, str]:
    """'HS4797935123456' → (mã BHXH 10 số cuối, mã thẻ 15 ký tự).
    '7935123456 / HS4797935123456' → tách hai phần. Chỉ mã BHXH 10 số → ('…', '')."""
    parts = [re.sub(r"\s+", "", p) for p in re.split(r"[/;,]", value or "") if p.strip()]
    ma_bhxh = ma_the = ""
    for part in parts:
        token = re.sub(r"[^0-9A-Za-z]", "", part).upper()
        if re.fullmatch(r"[A-Z]{2}\d{13}", token):
            ma_the = ma_the or token
        elif re.fullmatch(r"\d{10}", token):
            ma_bhxh = ma_bhxh or token
    if ma_the and not ma_bhxh:
        ma_bhxh = ma_the[-10:]
    return ma_bhxh, ma_the


def _signature_date(text: str) -> str:
    """Ngày ký giấy: dòng bắt đầu bằng 'Ngày .. tháng .. năm ..' (không phải
    'ngày' trong 'Vào viện lúc ... ngày ...'). Lấy dòng cuối cùng (chỗ ký)."""
    found = ""
    for line in text.splitlines():
        if re.search(r"vào viện|ra viện|ngoại trú|từ ngày", line, re.IGNORECASE):
            continue
        m = re.search(
            r"^\s*(?:[^\n,]*,\s*)?ngày\s*(\d{1,2})\s*tháng\s*(\d{1,2})\s*năm\s*(\d{4})",
            line, re.IGNORECASE,
        )
        if m:
            found = f"{int(m.group(1)):02d}/{int(m.group(2)):02d}/{m.group(3)}"
    return found


def _find_doctor(text: str, doctors: Iterable[str]) -> str:
    """Tên trưởng khoa ký giấy: bác sĩ trong danh sách xuất hiện sau chữ 'Trưởng khoa'."""
    idx = text.lower().rfind("trưởng khoa")
    if idx < 0:
        return ""
    tail = normalize_text(text[idx:])
    for name in doctors:
        if normalize_text(name) and normalize_text(name) in tail:
            return name
    return ""


def parse_grv_text(text: str, doctors: Iterable[str] | None = None) -> dict:
    """Tách các trường từ text của giấy ra viện. Trả về {doc_type, mau_so, fields, raw}."""
    if not text or not text.strip():
        raise PhieuPdfError("Không đọc được nội dung giấy ra viện (PDF trống hoặc là ảnh scan).")
    if MARKER_GRV not in normalize_text(text):
        raise PhieuPdfError("File không phải Giấy ra viện (không thấy tiêu đề GIẤY RA VIỆN).")

    ma_bhxh, ma_the = _split_card(_field(text, "the"))

    # "Điều trị ngoại trú từ ngày 06/10/2026 đến hết ngày 12/10/2026" (có hoặc không có ":").
    nt_tu = nt_den = ""
    m = re.search(
        r"ngoại trú[^\n]{0,40}?từ ngày\s*([0-9/\-]+)\s*đến (?:hết )?ngày\s*([0-9/\-]+)",
        text, re.IGNORECASE,
    )
    if m:
        nt_tu, nt_den = _to_date(m.group(1)), _to_date(m.group(2))

    gioi = _field(text, "gioi_tinh")
    gioi = "Nữ" if re.match(r"^n[uữ]", normalize_text(gioi)) else ("Nam" if gioi else "")

    ngay_sinh = _field(text, "ngay_sinh")
    m = re.search(r"\d{1,2}/\d{1,2}/\d{4}|\b(?:19|20)\d{2}\b", ngay_sinh)
    ngay_sinh = m.group(0) if m else ""

    tuoi_thai = re.sub(r"\D", "", _field(text, "tuoi_thai"))
    dc = normalize_text(_field(text, "dc_thainghen"))

    fields = {
        "mau_so": "03",
        "ma_ct": _field(text, "ma_ct"),
        "so_seri": _field(text, "so_seri"),
        "ma_bhxh": ma_bhxh,
        "ma_the": ma_the,
        "ho_ten": _field(text, "ho_ten"),
        "ngay_sinh": ngay_sinh,
        "gioi_tinh": gioi,
        "dan_toc": _field(text, "dan_toc"),
        "nghe_nghiep": _field(text, "nghe_nghiep"),
        "ma_khoa": _field(text, "ma_khoa"),
        "dia_chi": _field(text, "dia_chi", multiline=True),
        "tu_ngay": _to_date(_field(text, "vao_vien")),
        "den_ngay": _to_date(_field(text, "ra_vien")),
        "chan_doan": _field(text, "chan_doan", multiline=True),
        "pp_dieutri": _field(text, "pp_dieutri", multiline=True),
        "ghi_chu": _field(text, "ghi_chu", multiline=True),
        "ho_ten_cha": _field(text, "ho_ten_cha"),
        "ho_ten_me": _field(text, "ho_ten_me"),
        "tuoi_thai": tuoi_thai,
        "dc_thainghen": "True" if dc.startswith("co") else "",
        "ngoaitru_tungay": nt_tu,
        "ngoaitru_denngay": nt_den,
        "ngay_ct": _signature_date(text),
        "doctor_text": _find_doctor(text, doctors or DEFAULT_DOCTORS),
        "loai_giay_to": "Không có giấy tờ",
    }
    fields = {k: v for k, v in fields.items() if v}
    return {"doc_type": DOC_GRV, "mau_so": "03", "fields": fields, "raw": {"text": text}}


def parse_grv_pdf(path: str | Path, doctors: Iterable[str] | None = None) -> dict:
    return parse_grv_text(extract_pdf_text(path), doctors)


def is_grv_text(text: str) -> bool:
    return MARKER_GRV in normalize_text(text or "")


def parse_sick_leave_pdf(path: str | Path, doctors: Iterable[str] | None = None) -> dict:
    """Đọc PDF bất kỳ trong hai loại: giấy ra viện (mẫu 03) hoặc phiếu phòng khám
    (mẫu 07). Tự nhận loại theo tiêu đề in trên giấy."""
    from .pdf_phieu import parse_phieu_text

    text = extract_pdf_text(path)
    if is_grv_text(text):
        return parse_grv_text(text, doctors)
    return parse_phieu_text(text)
