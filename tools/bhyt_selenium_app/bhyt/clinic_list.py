"""Đọc bảng "Danh sách Khám bệnh" của EMR theo TÊN CỘT (không theo chỉ số cứng).

Cách này đã dùng ở worker/clinic_outpatient.py (parse_clinic_table): tự dò bảng
có các cột ma bn / họ tên / trạng thái, map cột theo tiêu đề nên EMR đổi thứ tự
cột vẫn đọc đúng. Ở đây port gọn cho công cụ nhập cổng, chỉ lấy các field cần để
lọc tuổi lao động và tra tên người bệnh.
"""

from __future__ import annotations

from typing import Any

from .working_age import _norm  # chuẩn hoá tiếng Việt, bỏ dấu


# Tiêu đề cột → tên field. Giống _header_key ở worker/clinic_outpatient.py, thêm
# giới tính/tuổi phòng khi bảng có.
_HEADER_ALIASES = {
    "ma bn": "ma_bn",
    "ma benh nhan": "ma_bn",
    "ho ten": "ho_ten",
    "ten bn": "ho_ten",
    "nam sinh": "nam_sinh",
    "ngay sinh": "nam_sinh",
    "gioi tinh": "gioi_tinh",
    "gt": "gioi_tinh",
    "tuoi": "tuoi",
    "trang thai": "trang_thai",
    "noi thuc hien": "noi_thuc_hien",
    "xu tri": "xu_tri",
}


def _header_key(text: str) -> str:
    n = _norm(text)
    return _HEADER_ALIASES.get(n, n.replace(" ", "_"))


def _year_from(value: str) -> str:
    """Lấy năm sinh từ 'Năm sinh' (1990) hoặc 'Ngày sinh' (18/11/1990)."""
    import re
    m = re.search(r"\b(19\d{2}|20\d{2})\b", str(value or ""))
    return m.group(1) if m else ""


def parse_clinic_patients(html_text: str) -> list[dict[str, Any]]:
    """Trả về list {ho_ten, nam_sinh, gioi_tinh, tuoi, ma_bn, raw}. Rỗng nếu không
    tìm được bảng danh sách khám."""
    try:
        from bs4 import BeautifulSoup
    except ImportError as exc:  # pragma: no cover - phụ thuộc môi trường
        raise RuntimeError("Thiếu beautifulsoup4 (cài: pip install beautifulsoup4)") from exc

    soup = BeautifulSoup(html_text or "", "html.parser")
    # Chọn bảng có nhiều cột khớp nhất với bảng danh sách khám bệnh.
    best = None
    best_score = 0
    for table in soup.find_all("table"):
        headers = [th.get_text(" ", strip=True) for th in table.find_all("th")]
        header_norm = " | ".join(_norm(h) for h in headers)
        score = sum(1 for token in ("ma bn", "ho ten", "trang thai", "noi thuc hien")
                    if token in header_norm)
        if score > best_score:
            best, best_score = (table, headers), score
    if not best:
        return []

    table, headers = best
    keys = [_header_key(h) for h in headers]
    out: list[dict[str, Any]] = []
    for tr in table.find_all("tr"):
        tds = tr.find_all("td")
        if not tds:
            continue
        row: dict[str, Any] = {}
        texts = []
        for idx, td in enumerate(tds):
            text = td.get_text(" ", strip=True)
            texts.append(text)
            if idx < len(keys):
                row[keys[idx]] = text
        name = (row.get("ho_ten") or "").strip()
        if not name:
            continue
        nam_sinh = (row.get("nam_sinh") or "").strip()
        out.append({
            "ho_ten": name,
            "nam_sinh": _year_from(nam_sinh) or nam_sinh,
            "gioi_tinh": (row.get("gioi_tinh") or "").strip(),
            "tuoi": (row.get("tuoi") or "").strip(),
            "ma_bn": (row.get("ma_bn") or "").strip(),
            "raw": texts,
        })
    return out
