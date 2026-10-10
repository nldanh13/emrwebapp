"""Lọc "còn tuổi lao động" để bớt trẻ em/người đã nghỉ hưu khi quét danh sách
phòng khám. Port đúng logic từ src/components/SickLeaveTab.jsx để hai nơi cho
cùng kết quả.

Tuổi nghỉ hưu theo Bộ luật Lao động 2019 (NĐ 135/2020): tăng dần — Nam 60y3m
(2021) +3 tháng/năm → 62 (từ 2028); Nữ 55y4m (2021) +4 tháng/năm → 60 (từ 2035).
Chỉ dùng để lọc sơ bộ, không phải căn cứ pháp lý tuyệt đối.
"""

from __future__ import annotations

import re
import unicodedata


def _norm(text: str) -> str:
    t = unicodedata.normalize("NFD", str(text or ""))
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    return t.replace("Đ", "D").replace("đ", "d").lower().strip()


def _is_female(gioi_tinh: str) -> bool:
    # "Nữ" / "nu…" → nữ. Khớp với regex /^n[uữ]/ ở bản JS.
    return bool(re.match(r"^n[uữ]", _norm(gioi_tinh)))


def labor_retirement_age_years(year, is_female: bool) -> float:
    try:
        y = int(year)
    except (TypeError, ValueError):
        y = 2021
    y = max(2021, min(y, 2035 if is_female else 2028))
    if is_female:
        months = 55 * 12 + 4 + (y - 2021) * 4
    else:
        months = 60 * 12 + 3 + (y - 2021) * 3
    return months / 12


def is_likely_working_age(nam_sinh, gioi_tinh, ref_year: int) -> bool:
    """Lọc theo NĂM SINH (danh sách quét EMR chỉ có năm, không có ngày/tháng) nên
    nới biên 1 tuổi hai đầu. Thiếu năm sinh thì KHÔNG loại (để người dùng tự xem)."""
    raw = str(nam_sinh or "").strip()
    try:
        birth_year = int(raw)
    except ValueError:
        return True
    if not birth_year or birth_year < 1900 or birth_year > ref_year:
        return True
    age = ref_year - birth_year
    retire = labor_retirement_age_years(ref_year, _is_female(gioi_tinh))
    return 14 <= age <= retire + 1


def is_likely_working_age_by_age(tuoi, gioi_tinh, ref_year: int) -> bool:
    """Lọc theo cột TUỔI trực tiếp (chính xác hơn, không nới biên). Thiếu tuổi thì
    không loại."""
    raw = str(tuoi or "").strip()
    try:
        age = float(raw)
    except ValueError:
        return True
    if age <= 0:
        return True
    retire = labor_retirement_age_years(ref_year, _is_female(gioi_tinh))
    return 14 <= age <= retire
